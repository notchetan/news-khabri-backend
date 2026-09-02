// The one-time articles_fts backfill in db/index.js only runs its loop body
// when articles already exist before the FTS table is first created -
// every other test file's :memory: database starts empty, so that branch
// has never actually been exercised anywhere else. This needs a real file
// (not :memory:) specifically so a `articles` table with real rows can be
// created and populated *before* db/index.js is first required - a fresh
// :memory: database can't be "pre-populated then reopened" the same way,
// each `new Database(':memory:')` call is its own isolated database.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

describe('articles_fts one-time backfill', () => {
  let dbPath;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `fts-backfill-test-${Date.now()}-${Math.random()}.db`);
  });

  afterEach(() => {
    jest.resetModules();
    // Windows holds a file lock for as long as the better-sqlite3 Database
    // object stays open - each test below closes its own connection(s)
    // explicitly before this runs, but guard the delete anyway rather than
    // letting a leaked handle fail every subsequent test run.
    try {
      fs.rmSync(dbPath, { force: true });
    } catch {
      // Best-effort cleanup - a leftover temp file doesn't affect
      // correctness of the next run, which uses its own fresh path.
    }
  });

  test('indexes every pre-existing article once, without re-running on a later boot', () => {
    // Pre-populate a real articles table, entirely independent of
    // db/index.js's own schema setup - the FTS table does not exist yet.
    const seedDb = new Database(dbPath);
    seedDb.exec(`
      CREATE TABLE articles (
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
    seedDb
      .prepare('INSERT INTO articles (title, link, source) VALUES (?, ?, ?)')
      .run('Earthquake strikes region', 'https://example.com/1', 'Test Source');
    seedDb.close();

    process.env.DB_PATH = dbPath;
    jest.resetModules();
    const db = require('../db');

    const ftsRows = db.prepare('SELECT rowid FROM articles_fts').all();
    expect(ftsRows).toHaveLength(1);
    const matches = db.prepare("SELECT rowid FROM articles_fts WHERE articles_fts MATCH '\"earthquake\"*'").all();
    expect(matches).toHaveLength(1);
    db.close();

    // Reopening the same database file (simulating a second boot) must not
    // re-run the backfill loop - if it did, this would either double-insert
    // (duplicate FTS rows) or, worse, hit the delete-a-never-indexed-rowid
    // corruption db/index.js's own comment describes for the rejected
    // external-content design, since the table is no longer empty this time.
    jest.resetModules();
    const dbReopened = require('../db');
    const ftsRowsAfterReopen = dbReopened.prepare('SELECT rowid FROM articles_fts').all();
    expect(ftsRowsAfterReopen).toHaveLength(1);
    dbReopened.close();
  });

  test('does nothing on a fresh database with no articles yet (no error, no rows)', () => {
    process.env.DB_PATH = dbPath;
    jest.resetModules();
    const db = require('../db');

    const ftsRows = db.prepare('SELECT rowid FROM articles_fts').all();
    expect(ftsRows).toHaveLength(0);
    db.close();
  });
});
