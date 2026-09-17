process.env.DB_PATH = ':memory:';

const db = require('../db');
const { syncArticleFts } = require('../db/fts');
const { pruneRetention } = require('../services/retention');
const {
  READ_EVENTS_RETENTION_DAYS,
  CLUSTER_DECISIONS_RETENTION_DAYS,
  ARTICLES_RETENTION_DAYS,
} = require('../services/retention-config');

const insertReadEvent = db.prepare(
  `INSERT INTO read_events (user_id, article_id, story_id, category, source, entities_json, read_at)
   VALUES (@user_id, @article_id, NULL, 'national', 'NDTV', NULL, @read_at)`
);
const insertClusterDecision = db.prepare(
  `INSERT INTO cluster_decisions (article_id, action, story_id, confidence, signals_json, candidates_json, created_at)
   VALUES (@article_id, 'create', NULL, 0.9, NULL, NULL, @created_at)`
);

function daysAgo(n) {
  return db.prepare("SELECT datetime('now', ?) AS t").get(`-${n} days`).t;
}

const STALE = daysAgo(ARTICLES_RETENTION_DAYS + 10);

function insertArticle(id, { storyId = null, fetchedAt = STALE, lastSeenAt = null } = {}) {
  db.prepare(
    'INSERT INTO articles (id, title, link, source, story_id, fetched_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, `Headline ${id}`, `https://example.com/${id}`, 'NDTV', storyId, fetchedAt, lastSeenAt);
  syncArticleFts(id);
}

function insertStory(id, { updatedAt = STALE, mergedInto = null } = {}) {
  db.prepare(
    "INSERT INTO stories (id, title, status, merged_into_story_id, updated_at) VALUES (?, 'Story', ?, ?, ?)"
  ).run(id, mergedInto ? 'merged' : 'active', mergedInto, updatedAt);
}

const ids = (sql) => db.prepare(sql).all().map((r) => r.id);
const articleIds = () => ids('SELECT id FROM articles ORDER BY id');
const ftsIds = () => ids('SELECT rowid AS id FROM articles_fts ORDER BY rowid');
const storyIds = () => ids('SELECT id FROM stories ORDER BY id');

beforeEach(() => {
  db.exec('DELETE FROM read_events');
  db.exec('DELETE FROM cluster_decisions');
  db.exec('DELETE FROM bookmarks');
  db.exec('DELETE FROM articles');
  db.exec('DELETE FROM articles_fts');
  db.exec('DELETE FROM stories');
  db.exec('DELETE FROM users');
  db.prepare('INSERT INTO users (id, google_id, email) VALUES (1, ?, ?)').run('g-1', 'a@example.com');
  insertArticle(1, { fetchedAt: daysAgo(1) });
});

describe('pruneRetention', () => {
  test('removes read_events older than the window, keeps recent ones', () => {
    insertReadEvent.run({ user_id: 1, article_id: 1, read_at: daysAgo(READ_EVENTS_RETENTION_DAYS + 5) });
    insertReadEvent.run({ user_id: 1, article_id: 1, read_at: daysAgo(READ_EVENTS_RETENTION_DAYS - 5) });
    insertReadEvent.run({ user_id: 1, article_id: 1, read_at: daysAgo(1) });

    const { readEvents } = pruneRetention();

    expect(readEvents).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM read_events').get().n).toBe(2);
  });

  test('removes cluster_decisions older than the window, keeps recent ones', () => {
    insertClusterDecision.run({ article_id: 1, created_at: daysAgo(CLUSTER_DECISIONS_RETENTION_DAYS + 3) });
    insertClusterDecision.run({ article_id: 1, created_at: daysAgo(2) });

    const { clusterDecisions } = pruneRetention();

    expect(clusterDecisions).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM cluster_decisions').get().n).toBe(1);
  });

  test('is a no-op when everything is within the windows', () => {
    insertReadEvent.run({ user_id: 1, article_id: 1, read_at: daysAgo(1) });
    insertClusterDecision.run({ article_id: 1, created_at: daysAgo(1) });

    expect(pruneRetention()).toEqual({ readEvents: 0, clusterDecisions: 0, articles: 0, stories: 0 });
  });

  test('drops a stale story with all its articles and their search rows', () => {
    insertStory(10);
    insertArticle(2, { storyId: 10 });
    insertArticle(3, { storyId: 10 });

    expect(pruneRetention()).toMatchObject({ articles: 2, stories: 1 });
    expect(articleIds()).toEqual([1]);
    expect(ftsIds()).toEqual([1]);
    expect(storyIds()).toEqual([]);
  });

  test('keeps a whole story while any member is still in a feed, bookmarked, or read', () => {
    // Fetched long ago, but a feed still lists it.
    insertStory(10);
    insertArticle(2, { storyId: 10 });
    insertArticle(3, { storyId: 10, lastSeenAt: daysAgo(1) });
    insertStory(11);
    insertArticle(4, { storyId: 11 });
    insertArticle(5, { storyId: 11 });
    db.prepare('INSERT INTO bookmarks (user_id, article_id) VALUES (1, 5)').run();
    insertStory(12);
    insertArticle(6, { storyId: 12 });
    insertArticle(7, { storyId: 12 });
    insertReadEvent.run({ user_id: 1, article_id: 7, read_at: daysAgo(1) });
    // Unclustered, bookmarked.
    insertArticle(8);
    db.prepare('INSERT INTO bookmarks (user_id, article_id) VALUES (1, 8)').run();

    expect(pruneRetention()).toMatchObject({ articles: 0, stories: 0 });
    expect(articleIds()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(storyIds()).toEqual([10, 11, 12]);
  });

  test('only drops member-less stories past the window that nothing was merged into', () => {
    insertStory(20);
    insertStory(21, { mergedInto: 20 });
    insertStory(22, { updatedAt: daysAgo(1) });

    expect(pruneRetention().stories).toBe(1);
    expect(storyIds()).toEqual([20, 22]);
    // The merge target goes on the next run, once nothing points at it.
    expect(pruneRetention().stories).toBe(1);
    expect(storyIds()).toEqual([22]);
  });
});
