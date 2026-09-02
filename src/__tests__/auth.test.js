process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret';
process.env.GOOGLE_WEB_CLIENT_ID = 'test-client-id';

// One shared mock for the real network call this whole file avoids -
// verifyIdToken is set per-test via mockVerifyIdToken.mockResolvedValue/
// mockRejectedValue rather than actually hitting Google.
const mockVerifyIdToken = jest.fn();
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({
    verifyIdToken: mockVerifyIdToken,
  })),
}));

const request = require('supertest');
const db = require('../db');
const app = require('../index');

function mockGoogleIdentity(overrides = {}) {
  const payload = {
    sub: 'google-user-1',
    email: 'chetan@example.com',
    name: 'Chetan Shetty',
    picture: 'https://example.com/avatar.jpg',
    ...overrides,
  };
  mockVerifyIdToken.mockResolvedValue({ getPayload: () => payload });
  return payload;
}

beforeEach(() => {
  // user_preferences.user_id references users(id) - delete the referencing
  // table first or a leftover preferences row blocks deleting its user.
  db.exec('DELETE FROM user_preferences');
  db.exec('DELETE FROM users');
  jest.clearAllMocks();
});

describe('POST /auth/google', () => {
  test('creates a new user and returns a session token', async () => {
    mockGoogleIdentity();

    const res = await request(app).post('/auth/google').send({ idToken: 'valid-token' });

    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user).toEqual({
      id: expect.any(Number),
      email: 'chetan@example.com',
      name: 'Chetan Shetty',
      avatarUrl: 'https://example.com/avatar.jpg',
    });
    expect(res.body.preferences).toBeNull();

    const row = db.prepare('SELECT * FROM users WHERE google_id = ?').get('google-user-1');
    expect(row).toMatchObject({ email: 'chetan@example.com', name: 'Chetan Shetty' });
  });

  test('signing in again with the same google account updates, not duplicates, the user row', async () => {
    mockGoogleIdentity();
    await request(app).post('/auth/google').send({ idToken: 'valid-token' });

    mockGoogleIdentity({ name: 'Chetan S.' });
    const res = await request(app).post('/auth/google').send({ idToken: 'valid-token-2' });

    const rows = db.prepare('SELECT * FROM users WHERE google_id = ?').all('google-user-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Chetan S.');
    expect(res.body.user.name).toBe('Chetan S.');
  });

  test('rejects a missing idToken', async () => {
    const res = await request(app).post('/auth/google').send({});
    expect(res.status).toBe(400);
  });

  test('rejects a Google ID token that fails verification', async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('Token used too late'));

    const res = await request(app).post('/auth/google').send({ idToken: 'bad-token' });

    expect(res.status).toBe(401);
  });
});

describe('GET /me', () => {
  async function signIn() {
    mockGoogleIdentity();
    const res = await request(app).post('/auth/google').send({ idToken: 'valid-token' });
    return res.body.token;
  }

  test('returns the signed-in user with a valid session token', async () => {
    const token = await signIn();

    const res = await request(app).get('/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('chetan@example.com');
  });

  test('rejects a request with no token', async () => {
    const res = await request(app).get('/me');
    expect(res.status).toBe(401);
  });

  test('rejects a malformed/invalid token', async () => {
    const res = await request(app).get('/me').set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });
});

describe('PUT /me/preferences', () => {
  async function signIn() {
    mockGoogleIdentity();
    const res = await request(app).post('/auth/google').send({ idToken: 'valid-token' });
    return res.body.token;
  }

  test('stores preferences and returns them on a later GET /me', async () => {
    const token = await signIn();
    const preferences = {
      theme: 'night',
      fontSize: 'large',
      language: 'hi',
      debugEnabled: true,
      sources: { en: ['NDTV'], hi: [] },
      notificationInterval: 15,
    };

    const putRes = await request(app)
      .put('/me/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send(preferences);
    expect(putRes.status).toBe(200);
    expect(putRes.body.preferences).toEqual(preferences);

    const getRes = await request(app).get('/me').set('Authorization', `Bearer ${token}`);
    expect(getRes.body.preferences).toEqual(preferences);
  });

  test('a second PUT replaces the whole preference set rather than merging', async () => {
    const token = await signIn();
    await request(app)
      .put('/me/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ theme: 'night', fontSize: 'large', language: 'hi', debugEnabled: true, sources: {}, notificationInterval: 15 });

    await request(app)
      .put('/me/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ theme: 'day', fontSize: 'medium', language: 'en', debugEnabled: false, sources: {}, notificationInterval: 0 });

    const res = await request(app).get('/me').set('Authorization', `Bearer ${token}`);
    expect(res.body.preferences).toMatchObject({ theme: 'day', fontSize: 'medium', language: 'en', debugEnabled: false });
  });

  test('rejects an unauthenticated request', async () => {
    const res = await request(app).put('/me/preferences').send({ theme: 'night' });
    expect(res.status).toBe(401);
  });
});
