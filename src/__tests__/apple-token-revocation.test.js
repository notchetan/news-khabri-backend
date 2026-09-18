process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret';
process.env.APPLE_TEAM_ID = 'TEAM123';
process.env.APPLE_KEY_ID = 'KEY123';
process.env.APPLE_PRIVATE_KEY = 'fake-p8';

// Identity-token verification and client-secret signing are both jose -
// stubbed so nothing touches Apple or real key material.
const mockAppleJwtVerify = jest.fn();
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => ({})),
  jwtVerify: (...args) => mockAppleJwtVerify(...args),
  importPKCS8: jest.fn(async () => ({})),
  SignJWT: jest.fn().mockImplementation(() => {
    const builder = {
      setProtectedHeader: () => builder,
      setIssuer: () => builder,
      setIssuedAt: () => builder,
      setExpirationTime: () => builder,
      setAudience: () => builder,
      setSubject: () => builder,
      sign: async () => 'client-secret-jwt',
    };
    return builder;
  }),
}));

const request = require('supertest');
const db = require('../db');
const app = require('../index');

const fetchMock = jest.fn();
global.fetch = fetchMock;

function appleResponse(ok, body = {}) {
  return { ok, status: ok ? 200 : 400, json: async () => body };
}

beforeEach(() => {
  db.exec('DELETE FROM users');
  jest.clearAllMocks();
  mockAppleJwtVerify.mockResolvedValue({
    payload: { sub: 'apple-user-1', email: 'chetan@privaterelay.appleid.com' },
  });
});

async function signInWithApple() {
  fetchMock.mockResolvedValueOnce(appleResponse(true, { refresh_token: 'refresh-1' }));
  const res = await request(app)
    .post('/auth/apple')
    .send({ identityToken: 'id-token', authorizationCode: 'auth-code' });
  return res.body.token;
}

test('sign-in exchanges the authorization code and stores the refresh token', async () => {
  await signInWithApple();

  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe('https://appleid.apple.com/auth/token');
  const params = new URLSearchParams(init.body);
  expect(params.get('code')).toBe('auth-code');
  expect(params.get('client_secret')).toBe('client-secret-jwt');
  expect(db.prepare('SELECT apple_refresh_token FROM users').get().apple_refresh_token).toBe('refresh-1');
});

test('a failed exchange still signs the user in', async () => {
  fetchMock.mockResolvedValueOnce(appleResponse(false));
  const res = await request(app)
    .post('/auth/apple')
    .send({ identityToken: 'id-token', authorizationCode: 'bad-code' });

  expect(res.status).toBe(200);
  expect(db.prepare('SELECT apple_refresh_token FROM users').get().apple_refresh_token).toBeNull();
});

test('DELETE /me revokes the stored refresh token before deleting', async () => {
  const token = await signInWithApple();
  fetchMock.mockResolvedValueOnce(appleResponse(true));

  const res = await request(app).delete('/me').set('Authorization', `Bearer ${token}`);

  expect(res.status).toBe(204);
  const [url, init] = fetchMock.mock.calls[1];
  expect(url).toBe('https://appleid.apple.com/auth/revoke');
  expect(new URLSearchParams(init.body).get('token')).toBe('refresh-1');
  expect(db.prepare('SELECT COUNT(*) AS n FROM users').get().n).toBe(0);
});

test('DELETE /me still deletes the account when Apple revocation fails', async () => {
  const token = await signInWithApple();
  fetchMock.mockRejectedValueOnce(new Error('network down'));

  const res = await request(app).delete('/me').set('Authorization', `Bearer ${token}`);

  expect(res.status).toBe(204);
  expect(db.prepare('SELECT COUNT(*) AS n FROM users').get().n).toBe(0);
});
