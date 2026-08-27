const {
  computeFreshness,
  computeSourceAuthority,
  computeImportance,
  computeRankingScore,
  rankArticles,
} = require('../services/ranking');
const {
  FRESHNESS_DECAY_HOURS,
  RANKING_WEIGHTS,
  DEFAULT_SOURCE_AUTHORITY,
  IMPORTANCE_BASELINE,
} = require('../services/ranking-config');

const NOW = new Date('2026-01-15T12:00:00Z');

function hoursAgo(hours) {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
}

describe('computeFreshness', () => {
  test('is 1 for an article published right now', () => {
    expect(computeFreshness(NOW.toISOString(), NOW)).toBeCloseTo(1, 5);
  });

  test('decays to ~1/e at exactly FRESHNESS_DECAY_HOURS old', () => {
    expect(computeFreshness(hoursAgo(FRESHNESS_DECAY_HOURS), NOW)).toBeCloseTo(
      Math.exp(-1),
      5
    );
  });

  test('decreases monotonically as age increases', () => {
    const f1 = computeFreshness(hoursAgo(1), NOW);
    const f6 = computeFreshness(hoursAgo(6), NOW);
    const f24 = computeFreshness(hoursAgo(24), NOW);
    expect(f1).toBeGreaterThan(f6);
    expect(f6).toBeGreaterThan(f24);
  });

  test('never goes negative for very old articles', () => {
    expect(computeFreshness(hoursAgo(24 * 365), NOW)).toBeGreaterThanOrEqual(0);
  });

  test('clamps to 1 rather than exceeding it for a future-dated article', () => {
    expect(computeFreshness(hoursAgo(-5), NOW)).toBe(1);
  });

  test('returns 0 for a missing published_at', () => {
    expect(computeFreshness(null, NOW)).toBe(0);
    expect(computeFreshness(undefined, NOW)).toBe(0);
  });

  test('returns 0 for an unparsable published_at instead of throwing', () => {
    expect(computeFreshness('not a date', NOW)).toBe(0);
  });
});

describe('computeSourceAuthority', () => {
  test('returns the configured value for a known source', () => {
    expect(computeSourceAuthority('The Hindu')).toBe(0.9);
  });

  test('falls back to the default for an unknown/new source', () => {
    expect(computeSourceAuthority('Some Brand New Source')).toBe(
      DEFAULT_SOURCE_AUTHORITY
    );
  });

  test('falls back to the default for a missing source', () => {
    expect(computeSourceAuthority(null)).toBe(DEFAULT_SOURCE_AUTHORITY);
    expect(computeSourceAuthority(undefined)).toBe(DEFAULT_SOURCE_AUTHORITY);
  });
});

describe('computeImportance', () => {
  test('scores a major-event article higher than the neutral baseline', () => {
    const score = computeImportance({
      title: 'Earthquake kills dozens, government declares emergency',
      description: 'Rescue teams deployed after the disaster',
      category: 'national',
    });
    expect(score).toBeGreaterThan(IMPORTANCE_BASELINE);
  });

  test('scores an opinion/lifestyle article lower than the neutral baseline', () => {
    const score = computeImportance({
      title: 'Opinion: Top 10 style tips for the new year',
      description: 'A lifestyle listicle',
      category: 'lifestyle',
    });
    expect(score).toBeLessThan(IMPORTANCE_BASELINE);
  });

  test('a major-event article outscores an opinion piece', () => {
    const major = computeImportance({
      title: 'War escalates as troops cross the border',
      description: null,
      category: 'world',
    });
    const minor = computeImportance({
      title: 'Celebrity gossip: who wore it best',
      description: null,
      category: 'entertainment',
    });
    expect(major).toBeGreaterThan(minor);
  });

  test('is deterministic - same input always gives the same output', () => {
    const article = { title: 'RBI raises interest rate', description: '', category: 'business' };
    expect(computeImportance(article)).toBe(computeImportance(article));
  });

  test('matches keywords case-insensitively', () => {
    const lower = computeImportance({ title: 'earthquake strikes region', category: '' });
    const upper = computeImportance({ title: 'EARTHQUAKE STRIKES REGION', category: '' });
    expect(lower).toBe(upper);
  });

  test('is clamped to [0, 1] even with many matching keywords', () => {
    const score = computeImportance({
      title:
        'War election government earthquake flood disaster market crash layoffs world cup dies death',
      description: 'conflict military strike killed casualties terror rbi inflation recession',
      category: 'national',
    });
    expect(score).toBeLessThanOrEqual(1);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  test('treats a missing description/category as neutral rather than throwing', () => {
    expect(() => computeImportance({ title: 'Some headline' })).not.toThrow();
  });

  test('does not double-count an overlapping keyword pair (e.g. "court" inside "supreme court")', () => {
    const withBoth = computeImportance({
      title: 'Supreme Court issues ruling',
      description: '',
      category: '',
    });
    // A single boost keyword match ('supreme court') should land exactly
    // IMPORTANCE_BOOST_WEIGHT above baseline, not twice that from also
    // separately matching 'court'.
    const { IMPORTANCE_BASELINE, IMPORTANCE_BOOST_WEIGHT } = require('../services/ranking-config');
    expect(withBoth).toBeCloseTo(IMPORTANCE_BASELINE + IMPORTANCE_BOOST_WEIGHT, 5);
  });

  test('penalizes a single-company stock-movement headline ("shares surge N%")', () => {
    const routine = computeImportance({
      title: 'XYZ Corp shares surge 14% after quarterly results',
      description: '',
      category: 'business',
    });
    const neutral = computeImportance({
      title: 'XYZ Corp opens a new office',
      description: '',
      category: 'business',
    });
    expect(routine).toBeLessThan(neutral);
  });

  test('does not penalize a broad market-wide move phrased around an index, not "shares"', () => {
    const marketWide = computeImportance({
      title: 'Sensex crashes 1,200 points amid global sell-off',
      description: '',
      category: 'business',
    });
    const { IMPORTANCE_BASELINE } = require('../services/ranking-config');
    // 'market crash' isn't in this headline, but it shouldn't get dinged by
    // the shares/stock-percentage pattern either - just neutral-or-above.
    expect(marketWide).toBeGreaterThanOrEqual(IMPORTANCE_BASELINE);
  });
});

describe('computeRankingScore', () => {
  test('combines the three signals using RANKING_WEIGHTS', () => {
    const article = {
      title: 'Routine update',
      description: '',
      category: 'national',
      source: 'The Hindu',
      published_at: NOW.toISOString(),
    };
    const { score, freshness, importance, sourceAuthority } = computeRankingScore(article, NOW);

    const expected =
      RANKING_WEIGHTS.importance * importance +
      RANKING_WEIGHTS.freshness * freshness +
      RANKING_WEIGHTS.sourceAuthority * sourceAuthority;
    expect(score).toBeCloseTo(expected, 10);
  });

  test('a fresh, high-authority, important article scores higher than a stale, low-authority, unimportant one', () => {
    const strong = computeRankingScore(
      {
        title: 'Government announces major policy after election win',
        description: '',
        category: 'national',
        source: 'The Hindu',
        published_at: hoursAgo(1),
      },
      NOW
    );
    const weak = computeRankingScore(
      {
        title: 'Opinion: my favorite recipe for the weekend',
        description: '',
        category: 'lifestyle',
        source: 'Some Brand New Source',
        published_at: hoursAgo(72),
      },
      NOW
    );
    expect(strong.score).toBeGreaterThan(weak.score);
  });
});

describe('rankArticles', () => {
  function makeArticle(overrides = {}) {
    return {
      id: 1,
      title: 'Headline',
      description: '',
      category: 'national',
      source: 'The Hindu',
      published_at: NOW.toISOString(),
      ...overrides,
    };
  }

  test('sorts by descending ranking score', () => {
    const older = makeArticle({ id: 1, published_at: hoursAgo(48), title: 'Old routine story' });
    const fresher = makeArticle({ id: 2, published_at: hoursAgo(1), title: 'Fresh routine story' });

    const ranked = rankArticles([older, fresher], { now: NOW });
    expect(ranked.map((a) => a.id)).toEqual([2, 1]);
  });

  test('attaches a ranking_score breakdown to each result', () => {
    const ranked = rankArticles([makeArticle()], { now: NOW });
    expect(ranked[0]).toEqual(
      expect.objectContaining({
        ranking_score: expect.any(Number),
        ranking_freshness: expect.any(Number),
        ranking_importance: expect.any(Number),
        ranking_sourceAuthority: expect.any(Number),
      })
    );
  });

  test('respects the limit option', () => {
    const articles = Array.from({ length: 10 }, (_, i) =>
      makeArticle({ id: i, source: `Source ${i}` })
    );
    expect(rankArticles(articles, { limit: 3, now: NOW })).toHaveLength(3);
  });

  test('caps how many results come from the same source (maxPerSource)', () => {
    // Mix of two sources, enough total candidates that respecting the cap
    // on the first (larger) source doesn't require backfilling from it -
    // isolates the cap behavior from the separate backfill behavior below.
    const articles = [
      ...Array.from({ length: 10 }, (_, i) =>
        makeArticle({ id: i, source: 'Times of India', published_at: hoursAgo(i) })
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        makeArticle({ id: 100 + i, source: 'The Hindu', published_at: hoursAgo(i) })
      ),
    ];
    const ranked = rankArticles(articles, { limit: 6, maxPerSource: 3, now: NOW });

    const fromThatSource = ranked.filter((a) => a.source === 'Times of India');
    expect(fromThatSource.length).toBeLessThanOrEqual(3);
  });

  test('backfills from capped-out articles when there are not enough distinct sources to fill the limit', () => {
    const articles = Array.from({ length: 5 }, (_, i) =>
      makeArticle({ id: i, source: 'Times of India', published_at: hoursAgo(i) })
    );
    // Only one source is available, capped at 3, but 5 requested - the
    // remaining 2 slots should still be filled rather than left short.
    const ranked = rankArticles(articles, { limit: 5, maxPerSource: 3, now: NOW });
    expect(ranked).toHaveLength(5);
  });

  test('does not throw on an empty candidate list', () => {
    expect(rankArticles([], { now: NOW })).toEqual([]);
  });

  test('caps how many results come from the same category (maxPerCategory)', () => {
    const articles = [
      ...Array.from({ length: 10 }, (_, i) =>
        makeArticle({ id: i, category: 'business', source: `Source ${i}`, published_at: hoursAgo(i) })
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        makeArticle({ id: 100 + i, category: 'sports', source: `Sports Source ${i}`, published_at: hoursAgo(i) })
      ),
    ];
    const ranked = rankArticles(articles, { limit: 6, maxPerCategory: 3, now: NOW });

    const fromThatCategory = ranked.filter((a) => a.category === 'business');
    expect(fromThatCategory.length).toBeLessThanOrEqual(3);
  });

  test('backfills from capped-out categories when there is not enough category diversity to fill the limit', () => {
    const articles = Array.from({ length: 5 }, (_, i) =>
      makeArticle({ id: i, category: 'business', source: `Source ${i}`, published_at: hoursAgo(i) })
    );
    const ranked = rankArticles(articles, { limit: 5, maxPerCategory: 3, now: NOW });
    expect(ranked).toHaveLength(5);
  });

  test('maxPerCategory is opt-in - omitting it applies no category cap at all', () => {
    const articles = Array.from({ length: 5 }, (_, i) =>
      makeArticle({ id: i, category: 'business', source: `Source ${i}`, published_at: hoursAgo(i) })
    );
    const ranked = rankArticles(articles, { limit: 5, now: NOW });
    expect(ranked).toHaveLength(5);
  });
});
