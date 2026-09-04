const express = require('express');
const { z } = require('zod');
const db = require('../db');
const {
  verifyGoogleIdToken,
  verifyAppleIdentityToken,
  signSessionToken,
  revokeSessions,
} = require('../services/auth');
const requireAuth = require('../middleware/require-auth');
const validate = require('../middleware/validate');
const logger = require('../logger');

const router = express.Router();

const googleAuthBody = z.object({ idToken: z.string().min(1) });
// Apple only sends the user's name on the very first authorization, and
// only client-side (never in the token) - so it's an optional body field
// the app forwards through on that first sign-in.
const appleAuthBody = z.object({
  identityToken: z.string().min(1),
  fullName: z
    .object({
      givenName: z.string().nullish(),
      familyName: z.string().nullish(),
    })
    .nullish(),
});
const preferencesBody = z.object({
  theme: z.string().optional(),
  fontSize: z.string().optional(),
  language: z.string().optional(),
  debugEnabled: z.boolean().optional(),
  sources: z.record(z.string(), z.array(z.string())).optional(),
  notificationInterval: z.number().optional(),
});

const upsertUser = db.prepare(`
  INSERT INTO users (google_id, email, name, avatar_url)
  VALUES (@googleId, @email, @name, @avatarUrl)
  ON CONFLICT(google_id) DO UPDATE SET
    email = excluded.email,
    name = excluded.name,
    avatar_url = excluded.avatar_url
`);
const getUserByGoogleId = db.prepare('SELECT * FROM users WHERE google_id = ?');

// Apple has no avatar and only gives a name on first sign-in, so this
// upsert never overwrites name/email with nulls on a return visit - it
// only fills a field that's currently empty (COALESCE keeps the stored
// value when the incoming one is null).
const upsertAppleUser = db.prepare(`
  INSERT INTO users (apple_id, email, name)
  VALUES (@appleId, @email, @name)
  ON CONFLICT(apple_id) DO UPDATE SET
    email = COALESCE(excluded.email, users.email),
    name = COALESCE(users.name, excluded.name)
`);
const getUserByAppleId = db.prepare('SELECT * FROM users WHERE apple_id = ?');
const getUserById = db.prepare('SELECT * FROM users WHERE id = ?');
const getPreferences = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?');

function toUserResponse(user) {
  return { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatar_url };
}

function toPreferencesResponse(row) {
  if (!row) return null;
  return {
    theme: row.theme,
    fontSize: row.font_size,
    language: row.language,
    debugEnabled: !!row.debug_enabled,
    sources: row.sources_json ? JSON.parse(row.sources_json) : {},
    notificationInterval: row.notification_interval,
  };
}

// Verifies the Google ID token the app obtained via
// @react-native-google-signin/google-signin, creates or updates the
// matching account, and issues this app's own session token - the app
// never sends the Google token again after this, only the returned one.
router.post('/auth/google', validate({ body: googleAuthBody }), async (req, res) => {
  const { idToken } = req.body;

  let identity;
  try {
    identity = await verifyGoogleIdToken(idToken);
  } catch (err) {
    // Log the real reason server-side; don't hand Google-library internals
    // back to the caller.
    logger.warn({ err: err.message }, 'google id token verification failed');
    res.status(401).json({ error: 'Invalid Google ID token' });
    return;
  }

  upsertUser.run({
    googleId: identity.googleId,
    email: identity.email,
    name: identity.name,
    avatarUrl: identity.avatarUrl,
  });
  const user = getUserByGoogleId.get(identity.googleId);
  // Invalidate any session token issued to this account before now, then
  // sign the new one with the bumped version.
  const tokenVersion = revokeSessions(user.id);
  const token = signSessionToken(user.id, tokenVersion);

  res.json({ token, user: toUserResponse(user), preferences: toPreferencesResponse(getPreferences.get(user.id)) });
});

// Same shape as /auth/google, for Sign in with Apple (Apple Guideline 4.8
// requires offering it alongside Google). See docs/apple-sign-in.md. The
// identity token is verified against Apple's JWKS; `fullName` is whatever
// the client captured on the first authorization (Apple never repeats it).
router.post('/auth/apple', validate({ body: appleAuthBody }), async (req, res) => {
  const { identityToken, fullName } = req.body;

  let identity;
  try {
    identity = await verifyAppleIdentityToken(identityToken);
  } catch (err) {
    logger.warn({ err: err.message }, 'apple identity token verification failed');
    res.status(401).json({ error: 'Invalid Apple identity token' });
    return;
  }

  const name =
    [fullName?.givenName, fullName?.familyName].filter(Boolean).join(' ').trim() || null;

  const existing = getUserByAppleId.get(identity.appleId);
  if (!existing && !identity.email) {
    // Can't create an account with no email; a return visit is fine since
    // the stored one is kept.
    logger.warn({ appleId: identity.appleId }, 'apple sign-in with no email for a new account');
    res.status(400).json({ error: 'Apple did not provide an email for this account' });
    return;
  }

  upsertAppleUser.run({ appleId: identity.appleId, email: identity.email ?? null, name });
  const user = getUserByAppleId.get(identity.appleId);
  const tokenVersion = revokeSessions(user.id);
  const token = signSessionToken(user.id, tokenVersion);

  res.json({ token, user: toUserResponse(user), preferences: toPreferencesResponse(getPreferences.get(user.id)) });
});

router.get('/me', requireAuth, (req, res) => {
  const user = getUserById.get(req.userId);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json({ user: toUserResponse(user), preferences: toPreferencesResponse(getPreferences.get(user.id)) });
});

const upsertPreferences = db.prepare(`
  INSERT INTO user_preferences (user_id, theme, font_size, language, debug_enabled, sources_json, notification_interval, updated_at)
  VALUES (@userId, @theme, @fontSize, @language, @debugEnabled, @sourcesJson, @notificationInterval, CURRENT_TIMESTAMP)
  ON CONFLICT(user_id) DO UPDATE SET
    theme = excluded.theme,
    font_size = excluded.font_size,
    language = excluded.language,
    debug_enabled = excluded.debug_enabled,
    sources_json = excluded.sources_json,
    notification_interval = excluded.notification_interval,
    updated_at = CURRENT_TIMESTAMP
`);

// Partial patch: only the fields actually present in the body are
// written; anything absent keeps its stored value. The app sends just the
// field(s) a device changed, so two devices editing *different*
// preferences no longer clobber each other (see docs/google-sign-in.md).
// A client that still sends the whole bundle behaves exactly as before.
const PREF_FIELDS = ['theme', 'fontSize', 'language', 'debugEnabled', 'sources', 'notificationInterval'];

router.put('/me/preferences', requireAuth, validate({ body: preferencesBody }), (req, res) => {
  const body = req.body || {};
  const current = toPreferencesResponse(getPreferences.get(req.userId)) || {
    theme: null,
    fontSize: null,
    language: null,
    debugEnabled: false,
    sources: {},
    notificationInterval: 0,
  };

  const merged = {};
  for (const field of PREF_FIELDS) {
    merged[field] = field in body ? body[field] : current[field];
  }

  upsertPreferences.run({
    userId: req.userId,
    theme: merged.theme ?? null,
    fontSize: merged.fontSize ?? null,
    language: merged.language ?? null,
    debugEnabled: merged.debugEnabled ? 1 : 0,
    sourcesJson: JSON.stringify(merged.sources ?? {}),
    notificationInterval: merged.notificationInterval ?? 0,
  });

  res.json({ preferences: toPreferencesResponse(getPreferences.get(req.userId)) });
});

// Full account deletion - required by the app stores for any app with
// account creation (Apple guideline 5.1.1(v)). Foreign keys are enforced
// (better-sqlite3 default) with no ON DELETE CASCADE, so every table that
// references the user is cleared explicitly, child rows before the users
// row, in one transaction. push_subscriptions.user_id is nullable (guests
// stay NULL), so this only removes rows for *this* account's devices.
const deleteAccount = db.transaction((userId) => {
  db.prepare('DELETE FROM read_events WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM bookmarks WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM user_preferences WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
});

router.delete('/me', requireAuth, (req, res) => {
  deleteAccount(req.userId);
  // The session token stays cryptographically valid until it expires, but
  // every authed route 404s once the user row is gone, and the app clears
  // its own stored token on a successful delete.
  res.status(204).end();
});

module.exports = router;
