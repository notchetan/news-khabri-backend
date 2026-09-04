const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const db = require('../db');

// See docs/google-sign-in.md for where this comes from (Google Cloud
// Console's Web application OAuth client) and why the *web* client id is
// the one used here even though most sign-ins come from the Android app -
// it's the one @react-native-google-signin/google-signin is configured
// with as `webClientId`, which is what ends up as the token's own
// `aud` claim regardless of which platform requested it.
const GOOGLE_WEB_CLIENT_ID = process.env.GOOGLE_WEB_CLIENT_ID;
const googleClient = new OAuth2Client(GOOGLE_WEB_CLIENT_ID);

// Jest sets NODE_ENV=test on its own, so the whole test suite gets a
// stable secret without every test file needing to set one itself (unlike
// DB_PATH, which really does need to differ per test file to get an
// isolated in-memory DB) - a real deployment (any other NODE_ENV) must set
// its own, and fails loudly at startup rather than silently signing
// tokens with a guessable default.
if (!process.env.JWT_SECRET && process.env.NODE_ENV !== 'test') {
  throw new Error('JWT_SECRET must be set (see .env.example)');
}
const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const SESSION_TOKEN_TTL = '30d';

// Verifies a Google ID token's signature and audience, returning the
// account's stable identity - throws if the token is malformed, expired,
// or wasn't issued for this app's own client id.
async function verifyGoogleIdToken(idToken) {
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: GOOGLE_WEB_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  return {
    googleId: payload.sub,
    email: payload.email,
    name: payload.name || null,
    avatarUrl: payload.picture || null,
  };
}

function signSessionToken(userId, tokenVersion = 0) {
  return jwt.sign({ userId, tv: tokenVersion }, JWT_SECRET, {
    expiresIn: SESSION_TOKEN_TTL,
  });
}

// Bumps the account's token_version so every session token issued before
// now stops verifying. Called on each fresh sign-in (routes/auth.js);
// returns the new version so the caller can sign the new token with it.
const bumpTokenVersion = db.prepare(
  'UPDATE users SET token_version = token_version + 1 WHERE id = ?'
);
const getTokenVersion = db.prepare('SELECT token_version FROM users WHERE id = ?');
function revokeSessions(userId) {
  bumpTokenVersion.run(userId);
  return getTokenVersion.get(userId).token_version;
}

// Returns the userId, or null for a missing/invalid/expired token, a
// deleted user, or a token whose `tv` claim no longer matches the
// account's current token_version - never throws, so callers (requireAuth)
// can treat any failure uniformly as "not signed in".
function verifySessionToken(token) {
  if (!token) return null;
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
  if (payload.userId == null) return null;
  const row = getTokenVersion.get(payload.userId);
  if (!row || (payload.tv ?? 0) !== row.token_version) return null;
  return payload.userId;
}

module.exports = {
  verifyGoogleIdToken,
  signSessionToken,
  verifySessionToken,
  revokeSessions,
};
