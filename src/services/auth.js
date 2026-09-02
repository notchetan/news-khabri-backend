const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');

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

function signSessionToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: SESSION_TOKEN_TTL });
}

// Returns the userId, or null for a missing/invalid/expired token - never
// throws, so callers (the requireAuth middleware) can treat any failure
// uniformly as "not signed in" rather than needing their own try/catch.
function verifySessionToken(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET).userId;
  } catch {
    return null;
  }
}

module.exports = { verifyGoogleIdToken, signSessionToken, verifySessionToken };
