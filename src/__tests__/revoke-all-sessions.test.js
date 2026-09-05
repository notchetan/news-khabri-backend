// Point db.js at an in-memory database before anything requires it, so tests
// never touch the real articles.db file and each test file gets a fresh DB.
process.env.DB_PATH = ':memory:';

const db = require('../db');
const { signSessionToken, verifySessionToken } = require('../services/auth');
const { revokeAllSessions } = require('../scripts/revoke-all-sessions');

function insertUser(overrides = {}) {
  const info = db
    .prepare(
      'INSERT INTO users (google_id, email, name, token_version) VALUES (@googleId, @email, @name, @tokenVersion)'
    )
    .run({
      googleId: `google-${overrides.email || 'a@example.com'}`,
      email: 'a@example.com',
      name: 'A',
      tokenVersion: 0,
      ...overrides,
    });
  return info.lastInsertRowid;
}

const getTokenVersion = (id) =>
  db.prepare('SELECT token_version FROM users WHERE id = ?').get(id).token_version;

describe('revokeAllSessions', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM users').run();
  });

  it('bumps every account, whatever version each was on', () => {
    const fresh = insertUser({ email: 'fresh@example.com', tokenVersion: 0 });
    const returning = insertUser({ email: 'returning@example.com', tokenVersion: 7 });

    expect(revokeAllSessions()).toBe(2);
    expect(getTokenVersion(fresh)).toBe(1);
    expect(getTokenVersion(returning)).toBe(8);
  });

  // The point of the script, not just the column write: a token that was
  // valid a moment ago must stop verifying.
  it('makes an already-issued token stop verifying', () => {
    const userId = insertUser({ email: 'leaked@example.com', tokenVersion: 3 });
    const leakedToken = signSessionToken(userId, 3);
    expect(verifySessionToken(leakedToken)).toBe(userId);

    revokeAllSessions();

    expect(verifySessionToken(leakedToken)).toBeNull();
  });

  it('leaves a token signed after the bump working', () => {
    const userId = insertUser({ email: 'after@example.com', tokenVersion: 3 });
    revokeAllSessions();

    const newToken = signSessionToken(userId, getTokenVersion(userId));

    expect(verifySessionToken(newToken)).toBe(userId);
  });

  it('touches nothing but token_version', () => {
    const userId = insertUser({ email: 'kept@example.com', name: 'Kept Name' });
    const before = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

    revokeAllSessions();

    const after = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    expect(after).toEqual({ ...before, token_version: before.token_version + 1 });
  });

  it('is a no-op on an empty users table', () => {
    expect(revokeAllSessions()).toBe(0);
  });
});
