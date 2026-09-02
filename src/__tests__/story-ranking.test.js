const { computeStoryScore, rankStories } = require('../services/story-ranking');

const NOW = new Date('2026-08-26T18:00:00Z');

function hoursAgo(hours) {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
}

function makeStory(overrides = {}) {
  return {
    id: 1,
    title: 'Headline',
    latest_published_at: NOW.toISOString(),
    ...overrides,
  };
}

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

describe('computeStoryScore', () => {
  test('returns a full breakdown alongside the total score', () => {
    const result = computeStoryScore(makeStory(), [makeArticle()], NOW);
    expect(result).toEqual(
      expect.objectContaining({
        score: expect.any(Number),
        bestArticleScore: expect.any(Number),
        sourceCountSignal: expect.any(Number),
        recencySignal: expect.any(Number),
        momentumSignal: expect.any(Number),
        personalizationSignal: expect.any(Number),
        distinctSourceCount: expect.any(Number),
      })
    );
  });

  test('personalizationSignal is 0 when readProfile is omitted or explicitly null - anonymous/first-time-signed-in requests are unaffected', () => {
    const omitted = computeStoryScore(makeStory(), [makeArticle()], NOW);
    const explicitNull = computeStoryScore(makeStory(), [makeArticle()], NOW, null);
    expect(omitted.personalizationSignal).toBe(0);
    expect(explicitNull.personalizationSignal).toBe(0);
    expect(omitted.score).toBe(explicitNull.score);
  });

  test('a matching readProfile raises the score above the same story with no profile', () => {
    const story = makeStory({ category: 'business' });
    const members = [makeArticle({ source: 'The Hindu' })];
    const readProfile = {
      categoryCounts: new Map([['business', 5]]),
      sourceCounts: new Map([['The Hindu', 5]]),
      entities: new Set(),
      totalReads: 5,
    };

    const withProfile = computeStoryScore(story, members, NOW, readProfile);
    const withoutProfile = computeStoryScore(story, members, NOW);

    expect(withProfile.personalizationSignal).toBeGreaterThan(0);
    expect(withProfile.score).toBeGreaterThan(withoutProfile.score);
  });

  test('bestArticleScore is the maximum member score, not an average', () => {
    const strong = makeArticle({ id: 1, title: 'War breaks out amid ceasefire collapse', source: 'The Hindu' });
    const weak = makeArticle({ id: 2, title: 'A quiet Tuesday in the markets', source: 'Aaj Tak' });

    const result = computeStoryScore(makeStory(), [strong, weak], NOW);
    const { computeRankingScore } = require('../services/ranking');
    const strongScore = computeRankingScore(strong, NOW).score;
    const weakScore = computeRankingScore(weak, NOW).score;

    expect(result.bestArticleScore).toBeCloseTo(Math.max(strongScore, weakScore));
    expect(result.bestArticleScore).not.toBeCloseTo((strongScore + weakScore) / 2);
  });

  test('distinctSourceCount counts unique sources, not raw article count (syndicated duplicates do not inflate it)', () => {
    const members = [
      makeArticle({ id: 1, source: 'Times of India' }),
      makeArticle({ id: 2, source: 'Times of India' }),
      makeArticle({ id: 3, source: 'Times of India' }),
    ];
    const result = computeStoryScore(makeStory(), members, NOW);
    expect(result.distinctSourceCount).toBe(1);
  });

  test('sourceCountSignal saturates rather than growing unbounded', () => {
    const manySources = Array.from({ length: 20 }, (_, i) => makeArticle({ id: i, source: `Source ${i}` }));
    const result = computeStoryScore(makeStory(), manySources, NOW);
    expect(result.sourceCountSignal).toBe(1);
  });

  test('recencySignal decays for an older latest_published_at', () => {
    const fresh = computeStoryScore(makeStory({ latest_published_at: NOW.toISOString() }), [makeArticle()], NOW);
    const stale = computeStoryScore(makeStory({ latest_published_at: hoursAgo(48) }), [makeArticle()], NOW);
    expect(fresh.recencySignal).toBeGreaterThan(stale.recencySignal);
  });

  test('momentumSignal only counts sources that published within the momentum window', () => {
    const recent = [makeArticle({ id: 1, source: 'A', published_at: NOW.toISOString() })];
    const stale = [makeArticle({ id: 1, source: 'A', published_at: hoursAgo(24) })];
    const recentResult = computeStoryScore(makeStory(), recent, NOW);
    const staleResult = computeStoryScore(makeStory(), stale, NOW);
    expect(recentResult.momentumSignal).toBeGreaterThan(staleResult.momentumSignal);
  });

  test('an empty member list does not throw and yields a 0 bestArticleScore', () => {
    expect(() => computeStoryScore(makeStory(), [], NOW)).not.toThrow();
    expect(computeStoryScore(makeStory(), [], NOW).bestArticleScore).toBe(0);
  });

  test('a single very important article outranks ten trivial articles from several sources (article count is never the dominant signal)', () => {
    const importantStory = makeStory({ id: 1, latest_published_at: NOW.toISOString() });
    const importantMembers = [
      makeArticle({
        id: 1,
        title: 'War escalates as government declares emergency after earthquake disaster',
        source: 'The Hindu',
        published_at: NOW.toISOString(),
      }),
    ];

    const trivialStory = makeStory({ id: 2, latest_published_at: NOW.toISOString() });
    const trivialMembers = Array.from({ length: 10 }, (_, i) =>
      makeArticle({
        id: 10 + i,
        title: 'Celebrity horoscope and lifestyle listicle roundup',
        source: `Source ${i % 5}`,
        published_at: NOW.toISOString(),
      })
    );

    const importantScore = computeStoryScore(importantStory, importantMembers, NOW).score;
    const trivialScore = computeStoryScore(trivialStory, trivialMembers, NOW).score;

    expect(importantScore).toBeGreaterThan(trivialScore);
  });
});

describe('rankStories', () => {
  test('sorts stories by score descending', () => {
    const low = makeStory({ id: 1, latest_published_at: hoursAgo(40) });
    const high = makeStory({ id: 2, latest_published_at: NOW.toISOString() });
    const members = new Map([
      [1, [makeArticle({ id: 1, published_at: hoursAgo(40) })]],
      [2, [makeArticle({ id: 2, published_at: NOW.toISOString() })]],
    ]);

    const ranked = rankStories([low, high], members, { now: NOW });
    expect(ranked[0].id).toBe(2);
    expect(ranked[1].id).toBe(1);
  });

  test('attaches a story_score field to each result', () => {
    const s = makeStory();
    const members = new Map([[1, [makeArticle()]]]);
    const ranked = rankStories([s], members, { now: NOW });
    expect(ranked[0]).toEqual(
      expect.objectContaining({
        story_score: expect.any(Number),
        story_score_bestArticle: expect.any(Number),
        story_score_sourceCount: expect.any(Number),
        story_score_recency: expect.any(Number),
        story_score_momentum: expect.any(Number),
        story_score_personalization: expect.any(Number),
      })
    );
  });

  test('omitting readProfile vs. passing an empty pool of stories with no history produces the same order as before personalization existed', () => {
    const stories = [
      makeStory({ id: 1, latest_published_at: hoursAgo(2) }),
      makeStory({ id: 2, latest_published_at: NOW.toISOString() }),
    ];
    const members = new Map([
      [1, [makeArticle({ id: 1, published_at: hoursAgo(2) })]],
      [2, [makeArticle({ id: 2, published_at: NOW.toISOString() })]],
    ]);

    const withoutReadProfile = rankStories(stories, members, { now: NOW });
    const withNullReadProfile = rankStories(stories, members, { now: NOW, readProfile: null });

    expect(withoutReadProfile.map((s) => s.id)).toEqual(withNullReadProfile.map((s) => s.id));
    expect(withoutReadProfile.map((s) => s.story_score)).toEqual(withNullReadProfile.map((s) => s.story_score));
  });

  test('a readProfile can change the ranked order - a personalized match overtakes an otherwise-fresher story', () => {
    // Nearly identical otherwise (freshness/importance), so the only real
    // lever left to flip their order is the personalization signal.
    const matching = makeStory({ id: 1, category: 'business', latest_published_at: hoursAgo(1) });
    const fresher = makeStory({ id: 2, category: 'sports', latest_published_at: NOW.toISOString() });
    const members = new Map([
      [1, [makeArticle({ id: 1, source: 'The Hindu', category: 'business', published_at: hoursAgo(1) })]],
      [2, [makeArticle({ id: 2, source: 'The Hindu', category: 'sports', published_at: NOW.toISOString() })]],
    ]);
    const readProfile = {
      categoryCounts: new Map([['business', 20]]),
      sourceCounts: new Map([['The Hindu', 20]]),
      entities: new Set(),
      totalReads: 20,
    };

    const withoutProfile = rankStories([matching, fresher], members, { now: NOW });
    expect(withoutProfile.map((s) => s.id)).toEqual([2, 1]); // fresher wins with no personalization

    const withProfile = rankStories([matching, fresher], members, { now: NOW, readProfile });
    expect(withProfile.map((s) => s.id)).toEqual([1, 2]); // matching overtakes it once personalized
  });

  test('respects the limit option', () => {
    const stories = Array.from({ length: 5 }, (_, i) => makeStory({ id: i }));
    const members = new Map(stories.map((s) => [s.id, [makeArticle({ id: s.id })]]));
    const ranked = rankStories(stories, members, { limit: 2, now: NOW });
    expect(ranked).toHaveLength(2);
  });

  test('a story with no entry in the members map does not throw', () => {
    const s = makeStory({ id: 999 });
    expect(() => rankStories([s], new Map(), { now: NOW })).not.toThrow();
  });

  test('caps how many results come from the same category (maxPerCategory)', () => {
    const stories = [
      ...Array.from({ length: 10 }, (_, i) => makeStory({ id: i, category: 'business' })),
      ...Array.from({ length: 3 }, (_, i) => makeStory({ id: 100 + i, category: 'sports' })),
    ];
    const members = new Map(stories.map((s) => [s.id, [makeArticle({ id: s.id, source: `Source ${s.id}` })]]));

    const ranked = rankStories(stories, members, { limit: 6, maxPerCategory: 3, now: NOW });

    const fromThatCategory = ranked.filter((s) => s.category === 'business');
    expect(fromThatCategory.length).toBeLessThanOrEqual(3);
  });

  test('backfills from capped-out categories when there is not enough category diversity to fill the limit', () => {
    const stories = Array.from({ length: 5 }, (_, i) => makeStory({ id: i, category: 'business' }));
    const members = new Map(stories.map((s) => [s.id, [makeArticle({ id: s.id, source: `Source ${s.id}` })]]));

    const ranked = rankStories(stories, members, { limit: 5, maxPerCategory: 3, now: NOW });
    expect(ranked).toHaveLength(5);
  });

  test('maxPerCategory is opt-in - omitting it applies no category cap at all', () => {
    const stories = Array.from({ length: 5 }, (_, i) => makeStory({ id: i, category: 'business' }));
    const members = new Map(stories.map((s) => [s.id, [makeArticle({ id: s.id, source: `Source ${s.id}` })]]));

    const ranked = rankStories(stories, members, { limit: 5, now: NOW });
    expect(ranked).toHaveLength(5);
  });
});
