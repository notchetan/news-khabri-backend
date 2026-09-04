const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

// A real on-disk DB with the pre-Apple `users` schema, so the guarded
// rebuild in db/index.js actually runs (the :memory: DBs every other test
// uses always get the new CREATE TABLE and skip it).
const dbPath = path.join(os.tmpdir(), `nk-apple-migration-${process.pid}.db`);

beforeAll(() => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  const seed = new Database(dbPath);
  seed.pragma('journal_mode = WAL');
  seed.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      google_id TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      name TEXT,
      avatar_url TEXT,
      token_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE user_preferences (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      theme TEXT
    );
  `);
  seed
    .prepare('INSERT INTO users (id, google_id, email, name, token_version) VALUES (7, ?, ?, ?, 3)')
    .run('google-legacy-1', 'legacy@example.com', 'Legacy User');
  seed.prepare('INSERT INTO user_preferences (user_id, theme) VALUES (7, ?)').run('night');
  seed.close();

  process.env.DB_PATH = dbPath;
});

afterAll(() => {
  jest.resetModules();
  delete process.env.DB_PATH;
  for (const ext of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(dbPath + ext);
    } catch {
      /* ignore */
    }
  }
});

test('rebuilds a google-only users table to make google_id nullable and add apple_id, preserving rows', () => {
  const db = require('../db');

  const cols = db.prepare('PRAGMA table_info(users)').all();
  const googleId = cols.find((c) => c.name === 'google_id');
  const appleId = cols.find((c) => c.name === 'apple_id');

  expect(appleId).toBeTruthy();
  expect(googleId.notnull).toBe(0); // NOT NULL relaxed

  // The existing row survived intact, id and token_version included.
  const user = db.prepare('SELECT * FROM users WHERE id = 7').get();
  expect(user).toMatchObject({
    google_id: 'google-legacy-1',
    apple_id: null,
    email: 'legacy@example.com',
    name: 'Legacy User',
    token_version: 3,
  });

  // The child row still references it (FKs came back on).
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  expect(db.prepare('SELECT theme FROM user_preferences WHERE user_id = 7').get().theme).toBe('night');

  // Both provider ids are uniquely indexed; multiple NULLs don't collide.
  db.prepare('INSERT INTO users (apple_id, email) VALUES (?, ?)').run('apple-x', 'a@example.com');
  db.prepare('INSERT INTO users (apple_id, email) VALUES (?, ?)').run('apple-y', 'b@example.com');
  expect(() =>
    db.prepare('INSERT INTO users (apple_id, email) VALUES (?, ?)').run('apple-x', 'c@example.com')
  ).toThrow(/UNIQUE/);
});
