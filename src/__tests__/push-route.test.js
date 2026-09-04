process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret';

const request = require('supertest');
const db = require('../db');
const { signSessionToken } = require('../services/auth');
const app = require('../index');

beforeEach(() => {
  db.exec('DELETE FROM push_subscriptions');
  db.exec('DELETE FROM users');
});

describe('POST /push-subscriptions', () => {
  test('registers a new device', async () => {
    const res = await request(app)
      .post('/push-subscriptions')
      .send({ pushToken: 'ExponentPushToken[abc]', intervalMinutes: 15, language: 'en' });

    expect(res.status).toBe(204);
    const row = db.prepare('SELECT * FROM push_subscriptions WHERE push_token = ?').get('ExponentPushToken[abc]');
    expect(row).toMatchObject({ push_token: 'ExponentPushToken[abc]', interval_minutes: 15, language: 'en' });
  });

  test('defaults language to en when omitted', async () => {
    await request(app)
      .post('/push-subscriptions')
      .send({ pushToken: 'ExponentPushToken[abc]', intervalMinutes: 0 });

    const row = db.prepare('SELECT * FROM push_subscriptions WHERE push_token = ?').get('ExponentPushToken[abc]');
    expect(row.language).toBe('en');
  });

  test('updates (not duplicates) an existing token when registered again', async () => {
    await request(app)
      .post('/push-subscriptions')
      .send({ pushToken: 'ExponentPushToken[abc]', intervalMinutes: 15, language: 'en' });
    await request(app)
      .post('/push-subscriptions')
      .send({ pushToken: 'ExponentPushToken[abc]', intervalMinutes: 60, language: 'hi' });

    const rows = db.prepare('SELECT * FROM push_subscriptions WHERE push_token = ?').all('ExponentPushToken[abc]');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ interval_minutes: 60, language: 'hi' });
  });

  test('rejects a missing pushToken', async () => {
    const res = await request(app).post('/push-subscriptions').send({ intervalMinutes: 15 });
    expect(res.status).toBe(400);
  });

  test('rejects an interval that is not one of the allowed values', async () => {
    const res = await request(app)
      .post('/push-subscriptions')
      .send({ pushToken: 'ExponentPushToken[abc]', intervalMinutes: 7 });
    expect(res.status).toBe(400);
  });

  test('accepts 0 (off) as a valid interval', async () => {
    const res = await request(app)
      .post('/push-subscriptions')
      .send({ pushToken: 'ExponentPushToken[abc]', intervalMinutes: 0 });
    expect(res.status).toBe(204);
  });

  test('rejects a token that is not a real Expo push token', async () => {
    const res = await request(app)
      .post('/push-subscriptions')
      .send({ pushToken: 'not-a-real-token', intervalMinutes: 15 });
    expect(res.status).toBe(400);
  });

  test('links the subscription to the account when a valid Bearer token is sent', async () => {
    db.prepare('INSERT INTO users (id, google_id, email) VALUES (7, ?, ?)').run('g-7', 'u@example.com');
    const token = signSessionToken(7);

    await request(app)
      .post('/push-subscriptions')
      .set('Authorization', `Bearer ${token}`)
      .send({ pushToken: 'ExponentPushToken[abc]', intervalMinutes: 15 });

    const row = db.prepare('SELECT user_id FROM push_subscriptions WHERE push_token = ?').get('ExponentPushToken[abc]');
    expect(row.user_id).toBe(7);
  });

  test('stays anonymous (user_id NULL) without a token, and a re-register after sign-out clears the link', async () => {
    db.prepare('INSERT INTO users (id, google_id, email) VALUES (7, ?, ?)').run('g-7', 'u@example.com');
    const token = signSessionToken(7);

    // signed in
    await request(app)
      .post('/push-subscriptions')
      .set('Authorization', `Bearer ${token}`)
      .send({ pushToken: 'ExponentPushToken[abc]', intervalMinutes: 15 });
    // signed out - same device re-registers with no token
    await request(app)
      .post('/push-subscriptions')
      .send({ pushToken: 'ExponentPushToken[abc]', intervalMinutes: 15 });

    const row = db.prepare('SELECT user_id FROM push_subscriptions WHERE push_token = ?').get('ExponentPushToken[abc]');
    expect(row.user_id).toBeNull();
  });
});

describe('DELETE /push-subscriptions', () => {
  test('removes the row for the given token, 204 even if nothing matched', async () => {
    await request(app)
      .post('/push-subscriptions')
      .send({ pushToken: 'ExponentPushToken[abc]', intervalMinutes: 15 });

    const res = await request(app)
      .delete('/push-subscriptions')
      .send({ pushToken: 'ExponentPushToken[abc]' });
    expect(res.status).toBe(204);
    expect(db.prepare('SELECT 1 FROM push_subscriptions WHERE push_token = ?').get('ExponentPushToken[abc]')).toBeUndefined();

    const again = await request(app)
      .delete('/push-subscriptions')
      .send({ pushToken: 'ExponentPushToken[abc]' });
    expect(again.status).toBe(204);
  });

  test('rejects a missing pushToken', async () => {
    const res = await request(app).delete('/push-subscriptions').send({});
    expect(res.status).toBe(400);
  });
});
