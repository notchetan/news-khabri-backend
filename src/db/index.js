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
  // Stage 3 semantic similarity - see services/embeddings.js. A 384-float
  // vector stored as a compact BLOB (1536 bytes), not JSON text - this
  // column is written for every newly-clustered article and read back on
  // every clustering comparison.
  db.exec('ALTER TABLE articles ADD COLUMN embedding BLOB');
}

// Every hot-path read (GET /articles, /articles/top's candidate pool,
// /stories/top's candidate pool) filters on language (+category) and sorts
// by fetched_at - without this, each of those was a full table scan.
db.exec('CREATE INDEX IF NOT EXISTS idx_articles_lang_cat_fetched ON articles(language, category, fetched_at)');

// Stage 2 story clustering - see services/clustering.js for the assignment
// algorithm and ingestion/clusterer.js for how these rows get written.
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
  // The running centroid across all of the story's members (see
  // services/embeddings.js's updateCentroid) - maintained the same way
  // entities_json already accumulates as a union as members join.
  db.exec('ALTER TABLE stories ADD COLUMN embedding BLOB');
}

// Persists every clustering decision (merge or create), including every
// candidate story considered and its full signal breakdown - not just the
// winner - so false merges and missed merges can be inspected after running
// against real RSS data. Purely a debug/operational artifact: never read by
// any API route. See clustering-config.js's LOG_CLUSTER_DECISIONS to
// disable.
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

// Per-source refresh cadence, recomputed from real ingestion history - see
// services/tier-config.js/source-tiers.js for the decision logic and
// ingestion/tier-tracker.js for how these rows get written and read. One
// row per source name (not per feed URL - a publisher's overall cadence is
// what determines how often it's worth polling, see tier-config.js's own
// comment on why this is keyed by source rather than language). Each daily
// recompute run replaces a source's previous row entirely rather than
// accumulating history, since only the current tier is ever needed.
db.exec(`
  CREATE TABLE IF NOT EXISTS source_tiers (
    source TEXT PRIMARY KEY,
    tier TEXT NOT NULL,
    articles_per_hour REAL,
    sample_count INTEGER,
    computed_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

module.exports = db;