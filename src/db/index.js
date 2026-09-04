const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || 'articles.db');

// WAL lets the cron's writes and an incoming request's reads proceed
// concurrently instead of blocking each other, and survives a crash
// mid-write far better than the default rollback journal. No-op for the
// `:memory:` DB the tests use. NORMAL sync is the standard, safe pairing
// with WAL (durable across app crashes; a full OS crash could lose the
// last transaction, which for an RSS cache is fine).
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

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

// Full-text search over title/description/content - see docs/search.md.
// Deliberately a plain FTS5 table, not an "external content" one
// (content='articles', content_rowid='id') - that variant looked more
// storage-efficient on paper, but its DELETE has to look up the row's
// *current* content in `articles` to figure out what to un-index. The very
// first sync for a newly-inserted article deletes a rowid that was never
// actually indexed yet - FTS5's external-content DELETE trips
// SQLITE_CORRUPT_VTAB on that (verified empirically, not a hypothetical).
// A plain FTS5 table keeps its own copy of the text and has no such
// requirement - DELETE of a nonexistent rowid is just a safe no-op, matching
// ordinary SQL semantics. The duplicated storage is a small, worthwhile
// trade for that. Kept in sync explicitly at every insert/update site via
// db/fts.js's syncArticleFts (this codebase has no DB triggers anywhere -
// see docs/search.md for why triggers were considered and set aside too).
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(title, description, content)
`);

// One-time backfill for a database that already had articles before this
// table existed - a fresh install has nothing to backfill (loop body never
// runs), an existing install gets every row indexed once, and every article
// from then on stays in sync via syncArticleFts at its own insert/update site.
const ftsIsEmpty = db.prepare('SELECT COUNT(*) AS count FROM articles_fts').get().count === 0;
const articlesExist = db.prepare('SELECT COUNT(*) AS count FROM articles').get().count > 0;
if (ftsIsEmpty && articlesExist) {
  const insertFtsRow = db.prepare(
    'INSERT INTO articles_fts(rowid, title, description, content) VALUES (?, ?, ?, ?)'
  );
  // .all() (not .iterate()) - better-sqlite3 doesn't allow running another
  // statement on this connection while a .iterate() cursor from it is still
  // open, and a transaction enforces that strictly. The full row set is
  // small enough (thousands, not millions) to materialize in memory first.
  const allArticles = db.prepare('SELECT id, title, description, content FROM articles').all();
  const backfillAll = db.transaction(() => {
    for (const row of allArticles) {
      insertFtsRow.run(row.id, row.title || '', row.description || '', row.content || '');
    }
  });
  backfillAll();
}

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
// /stories/top and the push cron pool candidates by (status, language,
// updated_at DESC) - see routes/stories.js.
db.exec('CREATE INDEX IF NOT EXISTS idx_stories_status_lang_updated ON stories(status, language, updated_at)');
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

// Nullable link to the account a device was signed into when it last
// registered (guests stay NULL) - lets DELETE /me clean up a user's
// subscriptions, and re-registering after sign-out nulls it back out.
const pushSubColumns = db.prepare('PRAGMA table_info(push_subscriptions)').all();
if (!pushSubColumns.some((c) => c.name === 'user_id')) {
  db.exec('ALTER TABLE push_subscriptions ADD COLUMN user_id INTEGER REFERENCES users(id)');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id)');

// One row per account that has ever signed in - see docs/google-sign-in.md
// and docs/apple-sign-in.md. google_id / apple_id are the provider token's
// own `sub` claim, the stable per-account identifier the provider
// guarantees never changes (email can, in principle, be edited). A row has
// exactly one of the two set. Fresh installs get this shape directly; an
// existing google-only DB is migrated below.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    google_id TEXT,
    apple_id TEXT,
    email TEXT NOT NULL,
    name TEXT,
    avatar_url TEXT,
    token_version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

// token_version: bumped on every fresh sign-in; embedded in the session
// JWT as `tv` and checked on every request - so an older token (a leaked
// one, a stale device) stops verifying the moment the real user signs in
// again. See services/auth.js.
const userColumns = db.prepare('PRAGMA table_info(users)').all();
if (!userColumns.some((c) => c.name === 'token_version')) {
  db.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0');
}
if (!userColumns.some((c) => c.name === 'apple_id')) {
  db.exec('ALTER TABLE users ADD COLUMN apple_id TEXT');
}

// The original schema had `google_id TEXT UNIQUE NOT NULL` (Google was the
// only provider). An Apple-only account has no google_id, so that
// constraint has to go - and SQLite can't ALTER a NOT NULL away, so the
// table is rebuilt once. Guarded on the constraint still being present, so
// it's a no-op on every boot after (and never runs on a fresh install,
// which already gets the new CREATE TABLE above). Standard SQLite
// table-rebuild: foreign_keys OFF, swap inside a transaction, back ON.
const googleIdColumn = db.prepare('PRAGMA table_info(users)').all().find((c) => c.name === 'google_id');
if (googleIdColumn && googleIdColumn.notnull === 1) {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        google_id TEXT,
        apple_id TEXT,
        email TEXT NOT NULL,
        name TEXT,
        avatar_url TEXT,
        token_version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`
      INSERT INTO users_new (id, google_id, apple_id, email, name, avatar_url, token_version, created_at)
      SELECT id, google_id, apple_id, email, name, avatar_url, token_version, created_at FROM users
    `);
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_new RENAME TO users');
  })();
  db.pragma('foreign_keys = ON');
}

// One unique index per provider id. A plain (non-partial) unique index is
// fine on a nullable column - SQLite treats every NULL as distinct, so all
// the Apple-only rows sharing google_id = NULL don't collide, and
// routes/auth.js's `ON CONFLICT(google_id)` / `ON CONFLICT(apple_id)`
// upserts still resolve against it.
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_apple_id ON users(apple_id)');

// One row per signed-in user - the account-linked counterpart to the
// several preferences that otherwise live only in the app's own
// AsyncStorage (theme/font size/debug mode/language/sources/notification
// interval). sources_json mirrors the frontend's own per-language shape
// (`{ en: [...], hi: [...] }`) rather than a normalized table, so it can
// be synced losslessly as one blob - see docs/google-sign-in.md.
db.exec(`
  CREATE TABLE IF NOT EXISTS user_preferences (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    theme TEXT,
    font_size TEXT,
    language TEXT,
    debug_enabled INTEGER,
    sources_json TEXT,
    notification_interval INTEGER,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

// One row per article a signed-in user opens - see docs/personalization.md.
// category/source/entities_json are captured from the article's own story
// at read time (denormalized, same reasoning stories.entities_json already
// accumulates) so services/personalization.js never has to re-join back to
// articles/stories every time it scores a story against a user's history.
db.exec(`
  CREATE TABLE IF NOT EXISTS read_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    article_id INTEGER NOT NULL REFERENCES articles(id),
    story_id INTEGER,
    category TEXT,
    source TEXT,
    entities_json TEXT,
    read_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_read_events_user ON read_events(user_id, read_at)');

// One row per article a signed-in user has saved - see docs/bookmarks.md.
// The composite primary key makes POST /me/bookmarks idempotent (a repeat
// save is an ON CONFLICT DO NOTHING no-op), which is what lets the app
// replay its whole on-device guest list at sign-in without deduping first.
db.exec(`
  CREATE TABLE IF NOT EXISTS bookmarks (
    user_id INTEGER NOT NULL REFERENCES users(id),
    article_id INTEGER NOT NULL REFERENCES articles(id),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, article_id)
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id, created_at)');

module.exports = db;