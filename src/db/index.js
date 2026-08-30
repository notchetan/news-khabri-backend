const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || 'articles.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    link TEXT UNIQUE NOT NULL,
    source TEXT NOT NULL,
    category TEXT,
    published_at TEXT,
    image_url TEXT,
    fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

const columns = db.prepare('PRAGMA table_info(articles)').all();
if (!columns.some((c) => c.name === 'content')) {
  db.exec('ALTER TABLE articles ADD COLUMN content TEXT');
}
if (!columns.some((c) => c.name === 'image_caption')) {
  db.exec('ALTER TABLE articles ADD COLUMN image_caption TEXT');
}
if (!columns.some((c) => c.name === 'language')) {
  db.exec("ALTER TABLE articles ADD COLUMN language TEXT DEFAULT 'en'");
}
if (!columns.some((c) => c.name === 'read_time_minutes')) {
  db.exec('ALTER TABLE articles ADD COLUMN read_time_minutes INTEGER');
}
if (!columns.some((c) => c.name === 'description')) {
  db.exec('ALTER TABLE articles ADD COLUMN description TEXT');
}
if (!columns.some((c) => c.name === 'story_id')) {
  db.exec('ALTER TABLE articles ADD COLUMN story_id INTEGER');
}
if (!columns.some((c) => c.name === 'embedding')) {
  // Stage 3 semantic similarity - see docs/embeddings.md.
  db.exec('ALTER TABLE articles ADD COLUMN embedding BLOB');
}

// Every hot-path read (GET /articles, /articles/top's candidate pool,
// /stories/top's candidate pool) filters on language (+category) and sorts
// by fetched_at - without this, each of those was a full table scan.
db.exec('CREATE INDEX IF NOT EXISTS idx_articles_lang_cat_fetched ON articles(language, category, fetched_at)');

// Stage 2 story clustering - see docs/clustering-pipeline.md and
// docs/clusterer-orchestration.md.
db.exec(`
  CREATE TABLE IF NOT EXISTS stories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    summary TEXT,
    category TEXT,
    language TEXT DEFAULT 'en',
    entities_json TEXT,
    latest_title TEXT,
    latest_description TEXT,
    representative_article_id INTEGER,
    representative_quality REAL,
    article_count INTEGER NOT NULL DEFAULT 1,
    source_count INTEGER NOT NULL DEFAULT 1,
    first_published_at TEXT,
    latest_published_at TEXT,
    story_score REAL,
    status TEXT NOT NULL DEFAULT 'active',
    merged_into_story_id INTEGER REFERENCES stories(id),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_stories_lang_cat_latest ON stories(language, category, latest_published_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_articles_story_id ON articles(story_id)');

const storyColumns = db.prepare('PRAGMA table_info(stories)').all();
if (!storyColumns.some((c) => c.name === 'embedding')) {
  // The running centroid across all of the story's members - see
  // docs/embeddings.md's updateCentroid.
  db.exec('ALTER TABLE stories ADD COLUMN embedding BLOB');
}

// Debug/explainability trail for clustering decisions - see
// docs/clustering-tuning.md's LOG_CLUSTER_DECISIONS.
db.exec(`
  CREATE TABLE IF NOT EXISTS cluster_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    story_id INTEGER,
    confidence REAL,
    signals_json TEXT,
    candidates_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_cluster_decisions_article ON cluster_decisions(article_id)');

// Per-source refresh cadence - see docs/tier-system.md. One row per source
// name (not per feed URL), replaced entirely on each daily recompute.
db.exec(`
  CREATE TABLE IF NOT EXISTS source_tiers (
    source TEXT PRIMARY KEY,
    tier TEXT NOT NULL,
    articles_per_hour REAL,
    sample_count INTEGER,
    computed_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

// One row per device - see docs/push-notifications.md. interval_minutes is
// the device's own chosen cadence (0 = off, never notified); last_notified_at
// is what the cron in services/push-notifications.js compares against that
// interval to decide whether a device is due again.
db.exec(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    push_token TEXT UNIQUE NOT NULL,
    interval_minutes INTEGER NOT NULL DEFAULT 0,
    language TEXT NOT NULL DEFAULT 'en',
    last_notified_at TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

module.exports = db;