const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const { createRemoteJWKSet, jwtVerify, importPKCS8, SignJWT } = require('jose');
const db = require('../db');
const logger = require('../logger');

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

// Sign in with Apple - see docs/apple-sign-in.md. The identity token is a
// JWT signed by Apple with RS256; the public keys are Apple's own rotating
// JWKS. `aud` is the app's bundle id for a native iOS sign-in (a Services
// id would be used for web). Unlike Google's, Apple's token never carries
// a name - the client sends that separately, and only on the very first
// authorization. jose caches and refreshes the JWKS on its own.
const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_CLIENT_ID = process.env.APPLE_CLIENT_ID || 'com.newskhabri.app';
const appleJwks = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

async function verifyAppleIdentityToken(identityToken) {
  const { payload } = await jwtVerify(identityToken, appleJwks, {
    issuer: APPLE_ISSUER,
    audience: APPLE_CLIENT_ID,
  });
  return {
    appleId: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : null,
  };
}

// Apple requires revoking a user's Sign in with Apple tokens when they
// delete their account (Guideline 5.1.1(v)) - see "Token revocation" in
// docs/apple-sign-in.md. Both the code exchange and the revoke call need a
// client secret signed with a Sign in with Apple key (.p8).
const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID;
const APPLE_KEY_ID = process.env.APPLE_KEY_ID;
// Env vars can't hold raw newlines on every host, so accept `\n`-escaped.
const APPLE_PRIVATE_KEY = process.env.APPLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const appleRevocationConfigured = Boolean(APPLE_TEAM_ID && APPLE_KEY_ID && APPLE_PRIVATE_KEY);
if (!appleRevocationConfigured && process.env.NODE_ENV === 'production') {
  logger.warn('APPLE_TEAM_ID/APPLE_KEY_ID/APPLE_PRIVATE_KEY unset - Apple tokens will not be revoked on account deletion');
}

async function appleClientSecret() {
  const key = await importPKCS8(APPLE_PRIVATE_KEY, 'ES256');
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: APPLE_KEY_ID })
    .setIssuer(APPLE_TEAM_ID)
    .setIssuedAt()
    .setExpirationTime('5m')
    .setAudience(APPLE_ISSUER)
    .setSubject(APPLE_CLIENT_ID)
    .sign(key);
}

async function appleAuthRequest(endpoint, params) {
  const res = await fetch(`${APPLE_ISSUER}/auth/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: APPLE_CLIENT_ID,
      client_secret: await appleClientSecret(),
      ...params,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Apple /auth/${endpoint} returned ${res.status}`);
  return res;
}

// Trades the one-time authorization code from the app's sign-in for a
// long-lived refresh token - the thing /auth/revoke later needs. Returns
// null when no key is configured.
async function exchangeAppleAuthorizationCode(code) {
  if (!appleRevocationConfigured) return null;
  const res = await appleAuthRequest('token', { code, grant_type: 'authorization_code' });
  return (await res.json()).refresh_token ?? null;
}

async function revokeAppleToken(refreshToken) {
  if (!appleRevocationConfigured) return;
  await appleAuthRequest('revoke', { token: refreshToken, token_type_hint: 'refresh_token' });
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
  verifyAppleIdentityToken,
  exchangeAppleAuthorizationCode,
  revokeAppleToken,
  signSessionToken,
  verifySessionToken,
  revokeSessions,
};
