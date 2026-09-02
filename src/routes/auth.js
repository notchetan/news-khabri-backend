const express = require('express');
const db = require('../db');
const { verifyGoogleIdToken, signSessionToken } = require('../services/auth');
const requireAuth = require('../middleware/require-auth');

const router = express.Router();

const upsertUser = db.prepare(`
  INSERT INTO users (google_id, email, name, avatar_url)
  VALUES (@googleId, @email, @name, @avatarUrl)
  ON CONFLICT(google_id) DO UPDATE SET
    email = excluded.email,
    name = excluded.name,
    avatar_url = excluded.avatar_url
`);
const getUserByGoogleId = db.prepare('SELECT * FROM users WHERE google_id = ?');
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
    appIcon: row.app_icon,
  };
}

// Verifies the Google ID token the app obtained via
// @react-native-google-signin/google-signin, creates or updates the
// matching account, and issues this app's own session token - the app
// never sends the Google token again after this, only the returned one.
router.post('/auth/google', async (req, res) => {
  const { idToken } = req.body;
  if (typeof idToken !== 'string' || !idToken) {
    res.status(400).json({ error: 'idToken is required' });
    return;
  }

  let identity;
  try {
    identity = await verifyGoogleIdToken(idToken);
  } catch (err) {
    res.status(401).json({ error: 'Invalid Google ID token', message: err.message });
    return;
  }

  upsertUser.run({
    googleId: identity.googleId,
    email: identity.email,
    name: identity.name,
    avatarUrl: identity.avatarUrl,
  });
  const user = getUserByGoogleId.get(identity.googleId);
  const token = signSessionToken(user.id);

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
  INSERT INTO user_preferences (user_id, theme, font_size, language, debug_enabled, sources_json, notification_interval, app_icon, updated_at)
  VALUES (@userId, @theme, @fontSize, @language, @debugEnabled, @sourcesJson, @notificationInterval, @appIcon, CURRENT_TIMESTAMP)
  ON CONFLICT(user_id) DO UPDATE SET
    theme = excluded.theme,
    font_size = excluded.font_size,
    language = excluded.language,
    debug_enabled = excluded.debug_enabled,
    sources_json = excluded.sources_json,
    notification_interval = excluded.notification_interval,
    app_icon = excluded.app_icon,
    updated_at = CURRENT_TIMESTAMP
`);

// Whole-object replace, not a partial patch - the app always sends its
// full current preference set (see docs/google-sign-in.md), so there's no
// need for per-field optionality/merging here.
router.put('/me/preferences', requireAuth, (req, res) => {
  const { theme, fontSize, language, debugEnabled, sources, notificationInterval, appIcon } =
    req.body;

  upsertPreferences.run({
    userId: req.userId,
    theme: theme ?? null,
    fontSize: fontSize ?? null,
    language: language ?? null,
    debugEnabled: debugEnabled ? 1 : 0,
    sourcesJson: JSON.stringify(sources ?? {}),
    notificationInterval: notificationInterval ?? 0,
    appIcon: appIcon ?? null,
  });

  res.json({ preferences: toPreferencesResponse(getPreferences.get(req.userId)) });
});

module.exports = router;
