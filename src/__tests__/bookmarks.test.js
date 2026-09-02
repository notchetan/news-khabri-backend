process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret';

const request = require('supertest');
const db = require('../db');
const { signSessionToken } = require('../services/auth');
const app = require('../index');

function insertUser(id) {
  db.prepare('INSERT INTO users (id, google_id, email) VALUES (?, ?, ?)').run(
    id,
    `google-${id}`,
    `user${id}@example.com`
  );
}

function insertArticle(overrides = {}) {
  const article = {
    id: 1,
    title: 'Title',
    link: 'https://example.com/1',
    source: 'The Hindu',
    category: 'business',
    image_url: null,
    ...overrides,
  };
  db.prepare(
    'INSERT INTO articles (id, title, link, source, category, image_url) VALUES (@id, @title, @link, @source, @category, @image_url)'
  ).run(article);
  return article;
}

beforeEach(() => {
  db.exec('DELETE FROM bookmarks');
  db.exec('DELETE FROM articles');
  db.exec('DELETE FROM users');
  insertUser(1);
});

describe('POST /me/bookmarks', () => {
  test('requires authentication', async () => {
    insertArticle();
    const res = await request(app).post('/me/bookmarks').send({ articleId: 1 });
    expect(res.status).toBe(401);
  });

  test('rejects a missing/non-numeric articleId', async () => {
    const token = signSessionToken(1);
    const res = await request(app)
      .post('/me/bookmarks')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  test('returns 404 for an article that does not exist', async () => {
    const token = signSessionToken(1);
    const res = await request(app)
      .post('/me/bookmarks')
      .set('Authorization', `Bearer ${token}`)
      .send({ articleId: 999 });
    expect(res.status).toBe(404);
  });

  test('saves the article and is idempotent on a repeat save', async () => {
    insertArticle();
    const token = signSessionToken(1);

    const first = await request(app)
      .post('/me/bookmarks')
      .set('Authorization', `Bearer ${token}`)
      .send({ articleId: 1 });
    expect(first.status).toBe(204);

    const second = await request(app)
      .post('/me/bookmarks')
      .set('Authorization', `Bearer ${token}`)
      .send({ articleId: 1 });
    expect(second.status).toBe(204);

    const count = db
      .prepare('SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = 1 AND article_id = 1')
      .get().n;
    expect(count).toBe(1);
  });

  test('rejects an invalid/expired session token the same as no token', async () => {
    insertArticle();
    const res = await request(app)
      .post('/me/bookmarks')
      .set('Authorization', 'Bearer not-a-real-token')
      .send({ articleId: 1 });
    expect(res.status).toBe(401);
  });
});

describe('GET /me/bookmarks', () => {
  test('requires authentication', async () => {
    const res = await request(app).get('/me/bookmarks');
    expect(res.status).toBe(401);
  });

  test('returns the saved articles, newest save first, with a card-shaped payload', async () => {
    insertArticle({ id: 1, link: 'https://example.com/1', title: 'First' });
    insertArticle({ id: 2, link: 'https://example.com/2', title: 'Second', image_url: 'https://img/2.jpg' });
    const token = signSessionToken(1);

    await request(app).post('/me/bookmarks').set('Authorization', `Bearer ${token}`).send({ articleId: 1 });
    await request(app).post('/me/bookmarks').set('Authorization', `Bearer ${token}`).send({ articleId: 2 });

    const res = await request(app).get('/me/bookmarks').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.map((b) => b.id)).toEqual([2, 1]);
    expect(res.body[0]).toMatchObject({
      id: 2,
      title: 'Second',
      link: 'https://example.com/2',
      source: 'The Hindu',
      image_url: 'https://img/2.jpg',
    });
    expect(typeof res.body[0].bookmarked_at).toBe('string');
  });

  test("does not expose another user's bookmarks", async () => {
    insertUser(2);
    insertArticle();
    await request(app)
      .post('/me/bookmarks')
      .set('Authorization', `Bearer ${signSessionToken(1)}`)
      .send({ articleId: 1 });

    const res = await request(app)
      .get('/me/bookmarks')
      .set('Authorization', `Bearer ${signSessionToken(2)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('DELETE /me/bookmarks/:articleId', () => {
  test('requires authentication', async () => {
    const res = await request(app).delete('/me/bookmarks/1');
    expect(res.status).toBe(401);
  });

  test('removes a saved article', async () => {
    insertArticle();
    const token = signSessionToken(1);
    await request(app).post('/me/bookmarks').set('Authorization', `Bearer ${token}`).send({ articleId: 1 });

    const res = await request(app)
      .delete('/me/bookmarks/1')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(204);

    const count = db.prepare('SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = 1').get().n;
    expect(count).toBe(0);
  });

  test('is a no-op 204 when the bookmark is not there', async () => {
    const res = await request(app)
      .delete('/me/bookmarks/1')
      .set('Authorization', `Bearer ${signSessionToken(1)}`);
    expect(res.status).toBe(204);
  });
});
