process.env.DB_PATH = ':memory:';

const db = require('../db');
const { pruneRetention } = require('../services/retention');
const {
  READ_EVENTS_RETENTION_DAYS,
  CLUSTER_DECISIONS_RETENTION_DAYS,
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

beforeEach(() => {
  db.exec('DELETE FROM read_events');
  db.exec('DELETE FROM cluster_decisions');
  db.exec('DELETE FROM bookmarks');
  db.exec('DELETE FROM articles');
  db.exec('DELETE FROM users');
  db.prepare('INSERT INTO users (id, google_id, email) VALUES (1, ?, ?)').run('g-1', 'a@example.com');
  db.prepare('INSERT INTO articles (id, title, link, source) VALUES (1, ?, ?, ?)').run(
    'Headline',
    'https://example.com/1',
    'NDTV'
  );
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

  test('is a no-op (0, 0) when everything is within the windows', () => {
    insertReadEvent.run({ user_id: 1, article_id: 1, read_at: daysAgo(1) });
    insertClusterDecision.run({ article_id: 1, created_at: daysAgo(1) });

    expect(pruneRetention()).toEqual({ readEvents: 0, clusterDecisions: 0 });
  });
});
