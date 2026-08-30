process.env.DB_PATH = ':memory:';

const request = require('supertest');
const db = require('../db');
const app = require('../index');

beforeEach(() => {
  db.exec('DELETE FROM push_subscriptions');
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
});
