// Separate test file (rather than a describe block within clusterer.test.js)
// so LOG_CLUSTER_DECISIONS can be mocked false for every require in this
// file's own isolated module registry - Jest gives each test file its own
// registry by default, which is simpler and safer here than juggling
// jest.resetModules()/isolateModules around an already-initialized
// in-memory DB connection.
process.env.DB_PATH = ':memory:';

jest.mock('../services/clustering-config', () => ({
  ...jest.requireActual('../services/clustering-config'),
  LOG_CLUSTER_DECISIONS: false,
}));

jest.mock('../services/embeddings', () => ({
  ...jest.requireActual('../services/embeddings'),
  getEmbedding: jest.fn().mockResolvedValue(null),
}));

const db = require('../db');
const { clusterNewArticles } = require('../ingestion/clusterer');

function insertArticle(overrides = {}) {
  const article = {
    id: overrides.id,
    title: 'Some local story',
    link: `https://example.com/${overrides.id}`,
    source: 'Times of India',
    category: 'world',
    published_at: '2026-08-26T09:00:00Z',
    image_url: null,
    fetched_at: '2026-08-26 09:00:00',
    content: null,
    image_caption: null,
    read_time_minutes: null,
    language: 'en',
    description: null,
    story_id: null,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO articles (id, title, link, source, category, published_at, image_url, fetched_at, content, image_caption, read_time_minutes, language, description, story_id)
     VALUES (@id, @title, @link, @source, @category, @published_at, @image_url, @fetched_at, @content, @image_caption, @read_time_minutes, @language, @description, @story_id)`
  ).run(article);
}

beforeEach(() => {
  db.exec('DELETE FROM articles');
  db.exec('DELETE FROM stories');
  db.exec('DELETE FROM cluster_decisions');
});

test('no cluster_decisions rows are written when LOG_CLUSTER_DECISIONS is false', async () => {
  insertArticle({ id: 1 });

  await clusterNewArticles();

  const rows = db.prepare('SELECT COUNT(*) AS n FROM cluster_decisions').get();
  expect(rows.n).toBe(0);

  // Clustering itself still happens normally - only the debug log is skipped.
  const article = db.prepare('SELECT story_id FROM articles WHERE id = 1').get();
  expect(article.story_id).not.toBeNull();
});
