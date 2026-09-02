process.env.DB_PATH = ':memory:';

const db = require('../db');
const { loadReadProfile, computePersonalizationSignal } = require('../services/personalization');

function insertUser(id) {
  db.prepare('INSERT INTO users (id, google_id, email) VALUES (?, ?, ?)').run(
    id,
    `google-${id}`,
    `user${id}@example.com`
  );
}

// read_events.article_id references articles(id) - a minimal row is enough,
// these tests only exercise personalization.js's own reads of read_events
// itself, never joining back to articles.
function insertArticle(id) {
  db.prepare('INSERT INTO articles (id, title, link, source) VALUES (?, ?, ?, ?)').run(
    id,
    'Title',
    `https://example.com/${id}`,
    'Test Source'
  );
}

function insertReadEvent(overrides = {}) {
  db.prepare(
    `INSERT INTO read_events (user_id, article_id, story_id, category, source, entities_json, read_at)
     VALUES (@user_id, @article_id, @story_id, @category, @source, @entities_json, @read_at)`
  ).run({
    user_id: 1,
    article_id: 1,
    story_id: null,
    category: 'business',
    source: 'The Hindu',
    entities_json: null,
    read_at: new Date().toISOString(),
    ...overrides,
  });
}

beforeEach(() => {
  db.exec('DELETE FROM read_events');
  // user_preferences/read_events reference users(id) - delete referencing
  // tables first, same FK-ordering requirement as auth.test.js.
  db.exec('DELETE FROM user_preferences');
  db.exec('DELETE FROM users');
  db.exec('DELETE FROM articles');
  insertUser(1);
  for (let id = 1; id <= 5; id++) insertArticle(id);
});

describe('loadReadProfile', () => {
  test('returns null for a signed-out request (no userId)', () => {
    expect(loadReadProfile(null)).toBeNull();
    expect(loadReadProfile(undefined)).toBeNull();
  });

  test('returns null for a signed-in user with no read history yet', () => {
    expect(loadReadProfile(1)).toBeNull();
  });

  test('builds category/source frequency and a merged entity set from recent reads', () => {
    insertReadEvent({ article_id: 1, category: 'business', source: 'The Hindu', entities_json: JSON.stringify(['rbi']) });
    insertReadEvent({ article_id: 2, category: 'business', source: 'NDTV', entities_json: JSON.stringify(['budget']) });
    insertReadEvent({ article_id: 3, category: 'sports', source: 'The Hindu', entities_json: null });

    const profile = loadReadProfile(1);
    expect(profile.totalReads).toBe(3);
    expect(profile.categoryCounts.get('business')).toBe(2);
    expect(profile.categoryCounts.get('sports')).toBe(1);
    expect(profile.sourceCounts.get('The Hindu')).toBe(2);
    expect(profile.sourceCounts.get('NDTV')).toBe(1);
    expect(profile.entities.has('rbi')).toBe(true);
    expect(profile.entities.has('budget')).toBe(true);
  });

  test('only considers this user - other users’ reads never leak into the profile', () => {
    insertUser(2);
    insertReadEvent({ user_id: 2, category: 'sports' });

    expect(loadReadProfile(1)).toBeNull();
  });

  test('ignores reads older than the recency window', () => {
    const longAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    insertReadEvent({ read_at: longAgo });

    expect(loadReadProfile(1)).toBeNull();
  });
});

describe('computePersonalizationSignal', () => {
  test('returns 0 for a null profile regardless of the story', () => {
    const story = { category: 'business', entities_json: JSON.stringify(['rbi']) };
    expect(computePersonalizationSignal(null, story, [{ source: 'The Hindu' }])).toBe(0);
  });

  test('scores a story higher when it matches the user’s category, source, and entities', () => {
    insertReadEvent({
      category: 'business',
      source: 'The Hindu',
      entities_json: JSON.stringify(['rbi', 'inflation']),
    });
    const profile = loadReadProfile(1);

    const matchingStory = { category: 'business', entities_json: JSON.stringify(['rbi', 'inflation']) };
    const matchingMembers = [{ source: 'The Hindu' }];
    const unrelatedStory = { category: 'sports', entities_json: JSON.stringify(['world cup']) };
    const unrelatedMembers = [{ source: 'Some Other Source' }];

    const matchingSignal = computePersonalizationSignal(profile, matchingStory, matchingMembers);
    const unrelatedSignal = computePersonalizationSignal(profile, unrelatedStory, unrelatedMembers);

    expect(matchingSignal).toBeGreaterThan(unrelatedSignal);
    expect(unrelatedSignal).toBe(0);
  });

  test('takes the strongest source match among a story’s several member articles', () => {
    insertReadEvent({ category: 'business', source: 'NDTV', entities_json: null });
    const profile = loadReadProfile(1);

    const story = { category: null, entities_json: null };
    const members = [{ source: 'Unfamiliar Source' }, { source: 'NDTV' }];

    expect(computePersonalizationSignal(profile, story, members)).toBeGreaterThan(0);
  });

  test('stays within [0, 1] even with a perfect match on every sub-signal', () => {
    insertReadEvent({ category: 'business', source: 'The Hindu', entities_json: JSON.stringify(['rbi']) });
    const profile = loadReadProfile(1);
    const story = { category: 'business', entities_json: JSON.stringify(['rbi']) };
    const members = [{ source: 'The Hindu' }];

    const signal = computePersonalizationSignal(profile, story, members);
    expect(signal).toBeGreaterThanOrEqual(0);
    expect(signal).toBeLessThanOrEqual(1);
  });

  test('handles a story with no members and no category/entities gracefully', () => {
    insertReadEvent();
    const profile = loadReadProfile(1);
    expect(() => computePersonalizationSignal(profile, {}, [])).not.toThrow();
    expect(computePersonalizationSignal(profile, {}, [])).toBe(0);
  });
});
