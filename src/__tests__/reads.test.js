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
    story_id: null,
    ...overrides,
  };
  db.prepare(
    'INSERT INTO articles (id, title, link, source, category, story_id) VALUES (@id, @title, @link, @source, @category, @story_id)'
  ).run(article);
  return article;
}

function insertStory(overrides = {}) {
  const story = { id: 1, title: 'Story', entities_json: JSON.stringify(['rbi']), ...overrides };
  db.prepare('INSERT INTO stories (id, title, entities_json) VALUES (@id, @title, @entities_json)').run(story);
  return story;
}

beforeEach(() => {
  db.exec('DELETE FROM read_events');
  db.exec('DELETE FROM articles');
  db.exec('DELETE FROM stories');
  db.exec('DELETE FROM user_preferences');
  db.exec('DELETE FROM users');
  insertUser(1);
});

describe('POST /me/reads', () => {
  test('requires authentication', async () => {
    insertArticle();
    const res = await request(app).post('/me/reads').send({ articleId: 1 });
    expect(res.status).toBe(401);
  });

  test('rejects a missing/non-numeric articleId', async () => {
    const token = signSessionToken(1);
    const res = await request(app)
      .post('/me/reads')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  test('returns 404 for an article that does not exist', async () => {
    const token = signSessionToken(1);
    const res = await request(app)
      .post('/me/reads')
      .set('Authorization', `Bearer ${token}`)
      .send({ articleId: 999 });
    expect(res.status).toBe(404);
  });

  test('records the read event with the article’s own category/source, not client-supplied values', async () => {
    insertArticle({ category: 'sports', source: 'NDTV' });
    const token = signSessionToken(1);

    const res = await request(app)
      .post('/me/reads')
      .set('Authorization', `Bearer ${token}`)
      // A malicious/buggy client sends different values here - the route
      // must ignore these and use what it looks up itself.
      .send({ articleId: 1, category: 'business', source: 'Fabricated Source' });

    expect(res.status).toBe(204);
    const row = db.prepare('SELECT * FROM read_events WHERE user_id = 1').get();
    expect(row.article_id).toBe(1);
    expect(row.category).toBe('sports');
    expect(row.source).toBe('NDTV');
  });

  test('denormalizes the article’s own story entities onto the read event', async () => {
    insertStory({ id: 5, entities_json: JSON.stringify(['narendra modi', 'delhi']) });
    insertArticle({ id: 2, link: 'https://example.com/2', story_id: 5 });
    const token = signSessionToken(1);

    await request(app).post('/me/reads').set('Authorization', `Bearer ${token}`).send({ articleId: 2 });

    const row = db.prepare('SELECT * FROM read_events WHERE user_id = 1').get();
    expect(row.story_id).toBe(5);
    expect(JSON.parse(row.entities_json)).toEqual(['narendra modi', 'delhi']);
  });

  test('leaves entities null for an article that has not been clustered into a story yet', async () => {
    insertArticle({ story_id: null });
    const token = signSessionToken(1);

    await request(app).post('/me/reads').set('Authorization', `Bearer ${token}`).send({ articleId: 1 });

    const row = db.prepare('SELECT * FROM read_events WHERE user_id = 1').get();
    expect(row.story_id).toBeNull();
    expect(row.entities_json).toBeNull();
  });

  test('rejects an invalid/expired session token the same as no token', async () => {
    insertArticle();
    const res = await request(app)
      .post('/me/reads')
      .set('Authorization', 'Bearer not-a-real-token')
      .send({ articleId: 1 });
    expect(res.status).toBe(401);
  });
});
