process.env.DB_PATH = ':memory:';

const db = require('../db');
const { recomputeSourceTiers, getSourceTier, getAllSourceTiers } = require('../ingestion/tier-tracker');
const { DEFAULT_TIER, MIN_SAMPLES_TO_TRUST_RATE, TIER_LOOKBACK_DAYS } = require('../services/tier-config');

let nextId = 1;

function toSqliteTimestamp(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

// recomputeSourceTiers measures a source's rate as (count of articles in the
// trailing TIER_LOOKBACK_DAYS window) / (that window's fixed hour count) - a
// simple average over the whole window, not sensitive to exactly when
// within it an article landed. So this only needs every inserted article to
// fall somewhere inside (or, for the "stale" test, outside) that window -
// here, 1 hour before `now` is enough for "inside".
function insertArticles(source, count, now, { hoursBeforeNow = 1 } = {}) {
  const fetchedAt = toSqliteTimestamp(new Date(now.getTime() - hoursBeforeNow * 3600 * 1000));
  const insertMany = db.transaction((n) => {
    for (let i = 0; i < n; i++) {
      db.prepare(
        `INSERT INTO articles (id, title, link, source, category, published_at, image_url, fetched_at, language)
         VALUES (?, 'Title', ?, ?, 'world', NULL, NULL, ?, 'en')`
      ).run(nextId, `https://example.com/${nextId}`, source, fetchedAt);
      nextId += 1;
    }
  });
  insertMany(count);
}

const LOOKBACK_HOURS = TIER_LOOKBACK_DAYS * 24;

beforeEach(() => {
  db.exec('DELETE FROM articles');
  db.exec('DELETE FROM source_tiers');
});

describe('recomputeSourceTiers', () => {
  test('classifies a high-volume source as fast from real data', () => {
    const now = new Date('2026-08-27T12:00:00Z');
    // 3000 articles over the fixed 7-day/168h window ≈ 17.9/hour -> fast.
    insertArticles('Indian Express', 3000, now);

    const results = recomputeSourceTiers(now);

    const ie = results.find((r) => r.source === 'Indian Express');
    expect(ie.tier).toBe('fast');
    expect(ie.articlesPerHour).toBeCloseTo(3000 / LOOKBACK_HOURS);
  });

  test('classifies a low-volume source as slow from real data', () => {
    const now = new Date('2026-08-27T12:00:00Z');
    // 50 articles over 168h ≈ 0.3/hour -> slow (but still >= the
    // min-samples floor, so this is a trusted computed rate, not a default).
    insertArticles('Mathrubhumi', 50, now);

    const results = recomputeSourceTiers(now);

    const source = results.find((r) => r.source === 'Mathrubhumi');
    expect(source.tier).toBe('slow');
    expect(source.articlesPerHour).toBeCloseTo(50 / LOOKBACK_HOURS);
  });

  test('defaults a source with too few samples to the safe tier', () => {
    const now = new Date('2026-08-27T12:00:00Z');
    insertArticles('New Source', MIN_SAMPLES_TO_TRUST_RATE - 1, now);

    const results = recomputeSourceTiers(now);

    const source = results.find((r) => r.source === 'New Source');
    expect(source.tier).toBe(DEFAULT_TIER);
    expect(source.articlesPerHour).toBeNull();
  });

  test('ignores articles older than the lookback window', () => {
    const now = new Date('2026-08-27T12:00:00Z');
    // Well outside TIER_LOOKBACK_DAYS (7) - should not count toward the rate.
    insertArticles('Stale Source', 50, now, { hoursBeforeNow: 24 * 30 });

    const results = recomputeSourceTiers(now);

    expect(results.find((r) => r.source === 'Stale Source')).toBeUndefined();
  });

  test('persists results so getSourceTier and getAllSourceTiers reflect the latest run', () => {
    const now = new Date('2026-08-27T12:00:00Z');
    insertArticles('Indian Express', 3000, now);
    insertArticles('Mathrubhumi', 50, now);

    recomputeSourceTiers(now);

    expect(getSourceTier('Indian Express')).toBe('fast');
    expect(getSourceTier('Mathrubhumi')).toBe('slow');

    const all = getAllSourceTiers();
    expect(all.get('Indian Express')).toBe('fast');
    expect(all.get('Mathrubhumi')).toBe('slow');
  });

  test("a later run replaces a source's tier rather than accumulating", () => {
    const now = new Date('2026-08-27T12:00:00Z');
    insertArticles('Growing Source', 50, now);
    recomputeSourceTiers(now);
    expect(getSourceTier('Growing Source')).toBe('slow');

    db.exec('DELETE FROM articles');
    insertArticles('Growing Source', 3000, now);
    recomputeSourceTiers(now);
    expect(getSourceTier('Growing Source')).toBe('fast');
  });
});

describe('getSourceTier', () => {
  test('defaults to the safe tier for a source that has never been computed', () => {
    expect(getSourceTier('Never Seen Before')).toBe(DEFAULT_TIER);
  });
});

describe('getAllSourceTiers', () => {
  test('returns an empty map when nothing has been computed yet', () => {
    const all = getAllSourceTiers();
    expect(all.size).toBe(0);
  });
});
