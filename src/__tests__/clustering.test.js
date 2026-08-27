const { decideAssignment, computeQuality, titleClarityScore, completenessScore } = require('../services/clustering');
const { TITLE_SIMILARITY_THRESHOLD } = require('../services/clustering-config');

const NOW = new Date('2026-08-26T18:00:00Z');

function article(overrides = {}) {
  return {
    id: 1,
    title: 'Headline',
    description: null,
    category: 'world',
    source: 'Times of India',
    published_at: NOW.toISOString(),
    image_url: null,
    language: 'en',
    ...overrides,
  };
}

// Minimal candidate-story shape clustering.js expects - see
// ingestion/clusterer.js's toCandidateShape for how a real DB row maps to
// this.
function story(overrides = {}) {
  return {
    id: 100,
    title: 'Headline',
    latestTitle: 'Headline',
    latestDescription: null,
    entities: [],
    firstPublishedAt: NOW.toISOString(),
    latestPublishedAt: NOW.toISOString(),
    ...overrides,
  };
}

describe('decideAssignment - should cluster', () => {
  test('same story, different headlines (near-identical reordering)', () => {
    const a = article({ title: 'India announces new economic policy' });
    const existingStory = story({ title: a.title, latestTitle: a.title, entities: ['india'] });
    const b = article({ title: 'New economic policy announced by India' });

    const decision = decideAssignment(b, [existingStory]);
    expect(decision.action).toBe('merge');
    expect(decision.story.id).toBe(existingStory.id);
  });

  test('same event reported by different, independent publishers', () => {
    const a = article({ title: 'Cyclone Biparjoy makes landfall in Gujarat', source: 'Times of India' });
    const existingStory = story({
      title: a.title,
      latestTitle: a.title,
      entities: ['cyclone biparjoy', 'gujarat'],
    });
    const b = article({ title: 'Cyclone Biparjoy hits Gujarat coast', source: 'The Hindu' });

    const decision = decideAssignment(b, [existingStory]);
    expect(decision.action).toBe('merge');
  });

  test('breaking story followed by updates - a chain of merges accumulates into one story', () => {
    // Simulates the real incremental algorithm: each successful merge
    // updates the story's latestTitle/entities before the next comparison,
    // exactly like ingestion/clusterer.js does.
    const updates = [
      { title: 'Cyclone Biparjoy makes landfall in Gujarat', published_at: '2026-08-26T09:00:00Z' },
      {
        title: 'Cyclone Biparjoy weakens after landfall in Gujarat, thousands evacuated',
        published_at: '2026-08-26T11:00:00Z',
      },
      { title: 'Death toll from Cyclone Biparjoy rises to 12 in Gujarat', published_at: '2026-08-26T14:00:00Z' },
      {
        title: 'Gujarat begins cleanup operations after Cyclone Biparjoy passes',
        published_at: '2026-08-26T18:00:00Z',
      },
    ];
    const { extractEntities } = require('../services/entity-extraction');

    let currentStory = story({
      title: updates[0].title,
      latestTitle: updates[0].title,
      entities: extractEntities(updates[0].title),
      firstPublishedAt: updates[0].published_at,
      latestPublishedAt: updates[0].published_at,
    });

    for (let i = 1; i < updates.length; i++) {
      const nextArticle = article(updates[i]);
      const decision = decideAssignment(nextArticle, [currentStory]);
      expect(decision.action).toBe('merge');
      currentStory = {
        ...currentStory,
        latestTitle: nextArticle.title,
        entities: [...new Set([...currentStory.entities, ...extractEntities(nextArticle.title)])],
        latestPublishedAt: nextArticle.published_at,
      };
    }
    // All 4 updates ended up in the same story.
    expect(currentStory.latestTitle).toBe(updates[3].title);
  });

  test('different wording but the same distinctive entities/event', () => {
    const a = article({ title: 'Cyclone Biparjoy makes landfall in Gujarat' });
    const existingStory = story({
      title: a.title,
      latestTitle: a.title,
      entities: ['cyclone biparjoy', 'gujarat'],
    });
    const b = article({ title: 'Gujarat braces for impact as Cyclone Biparjoy comes ashore' });

    const decision = decideAssignment(b, [existingStory]);
    expect(decision.action).toBe('merge');
  });

  test('several independent sources converging picks the highest-confidence candidate among multiple stories', () => {
    const target = story({
      id: 1,
      title: 'Cyclone Biparjoy makes landfall in Gujarat',
      latestTitle: 'Cyclone Biparjoy makes landfall in Gujarat',
      entities: ['cyclone biparjoy', 'gujarat'],
    });
    const unrelated = story({
      id: 2,
      title: 'Stock market rallies on strong earnings',
      latestTitle: 'Stock market rallies on strong earnings',
      entities: [],
    });
    const b = article({ title: 'Cyclone Biparjoy hits Gujarat coast', source: 'The Hindu' });

    const decision = decideAssignment(b, [unrelated, target]);
    expect(decision.action).toBe('merge');
    expect(decision.story.id).toBe(target.id);
  });

  // Stage 3: hand-crafted identical embeddings (cosine = 1), never the real
  // model - deterministic and fast, matching this file's existing precedent
  // of hand-written fixtures for the lexical/entity signals above.
  test('weakly-worded headlines with no shared entity still merge via the semantic signal', () => {
    const sameEmbedding = Float32Array.from([1, 0, 0]);
    const a = article({
      title: 'Deadly floods swamp mountain villages overnight',
      published_at: '2026-08-26T09:00:00Z',
      embedding: sameEmbedding,
    });
    const existingStory = story({
      title: a.title,
      latestTitle: a.title,
      entities: [],
      firstPublishedAt: a.published_at,
      latestPublishedAt: a.published_at,
      embedding: sameEmbedding,
    });
    const b = article({
      title: 'Torrential rain triggers landslides across remote hill settlements',
      published_at: '2026-08-26T10:00:00Z',
      embedding: sameEmbedding,
    });

    const decision = decideAssignment(b, [existingStory]);
    expect(decision.action).toBe('merge');
    expect(decision.signals.semanticSim).toBeCloseTo(1);
    // Confirms this really is the semantic path carrying it - lexical/entity
    // signals are all near-zero for these deliberately dissimilarly-worded
    // titles.
    expect(decision.signals.titleSim).toBeLessThan(TITLE_SIMILARITY_THRESHOLD);
    expect(decision.signals.entityOverlap).toBe(0);
  });
});

describe('decideAssignment - should NOT cluster', () => {
  test('same topic, different event (Apple launches iPhone vs Apple reports revenue)', () => {
    const a = article({ title: 'Apple launches new iPhone with major camera upgrade', category: 'tech' });
    const existingStory = story({ title: a.title, latestTitle: a.title, entities: ['apple'] });
    const b = article({ title: 'Apple reports record quarterly revenue', category: 'tech' });

    const decision = decideAssignment(b, [existingStory]);
    expect(decision.action).toBe('create');
  });

  test('same organization, different event (Man United signs a player vs manager discusses a different player)', () => {
    const a = article({ title: 'Manchester United signs striker Viktor Gyokeres', category: 'sports' });
    const existingStory = story({
      title: a.title,
      latestTitle: a.title,
      entities: ['manchester united', 'viktor gyokeres'],
    });
    const b = article({ title: 'Manchester United manager discusses Marcus Rashford', category: 'sports' });

    const decision = decideAssignment(b, [existingStory]);
    expect(decision.action).toBe('create');
  });

  test('same person, unrelated event', () => {
    const a = article({ title: 'Actor Shah Rukh Khan launches new production house' });
    const existingStory = story({ title: a.title, latestTitle: a.title, entities: ['actor shah rukh khan'] });
    const b = article({ title: 'Shah Rukh Khan spotted at airport ahead of vacation' });

    const decision = decideAssignment(b, [existingStory]);
    expect(decision.action).toBe('create');
  });

  test('same organization, unrelated event (two different sports events, same team)', () => {
    const a = article({
      title: 'Manchester United wins Premier League match against Chelsea',
      category: 'sports',
    });
    const existingStory = story({
      title: a.title,
      latestTitle: a.title,
      entities: ['manchester united', 'premier league', 'chelsea'],
    });
    const b = article({
      title: 'Manchester United crashes out of FA Cup to lower league side',
      category: 'sports',
    });

    const decision = decideAssignment(b, [existingStory]);
    expect(decision.action).toBe('create');
  });

  test('two different political stories involving the same politician', () => {
    const a = article({ title: 'Prime Minister Modi inaugurates new highway project' });
    const existingStory = story({ title: a.title, latestTitle: a.title, entities: ['prime minister modi'] });
    const b = article({ title: 'PM Modi meets French president at G20 summit' });

    const decision = decideAssignment(b, [existingStory]);
    expect(decision.action).toBe('create');
  });

  test('similar generic headlines with no distinctive shared entity', () => {
    const a = article({ title: 'Stock market rallies on strong earnings' });
    const existingStory = story({ title: a.title, latestTitle: a.title, entities: [] });
    const b = article({ title: 'Stock market falls amid inflation fears' });

    const decision = decideAssignment(b, [existingStory]);
    expect(decision.action).toBe('create');
  });

  test('old story vs a genuinely new story published outside the merge-relevant window', () => {
    // clustering.js itself doesn't enforce the hard time cutoff (that's
    // ingestion/clusterer.js's SQL-blocking job - see clusterer.test.js),
    // but a large gap should still tank timeProximity heavily enough that
    // an otherwise-borderline case doesn't cross the confidence bar.
    const a = article({
      title: 'Cyclone Biparjoy makes landfall in Gujarat',
      published_at: '2026-08-01T09:00:00Z',
    });
    const existingStory = story({
      title: a.title,
      latestTitle: a.title,
      entities: ['cyclone biparjoy', 'gujarat'],
      firstPublishedAt: a.published_at,
      latestPublishedAt: a.published_at,
    });
    const b = article({
      title: 'Economic impact of Cyclone Biparjoy assessed months later in Gujarat',
      published_at: '2026-08-26T18:00:00Z',
    });

    const decision = decideAssignment(b, [existingStory]);
    expect(decision.action).toBe('create');
    expect(decision.allCandidateScores[0].timeProximity).toBeLessThan(0.01);
  });

  test('a strong semantic score does not overturn the time-based rejection for a stale, same-entity story', () => {
    // Real embeddings scored this exact pairing (landfall report vs. an
    // economic-impact piece weeks later) at 0.82 cosine similarity - even
    // higher than several genuine near-duplicates - which is exactly why the
    // semantic term is time-discounted rather than an unconditional
    // strongSignal path (see clustering-config.js's SEMANTIC_SIMILARITY_
    // THRESHOLD comment). Using an identical (cosine = 1) embedding here is a
    // strictly harder version of that real case.
    const sameEmbedding = Float32Array.from([1, 0, 0]);
    const a = article({
      title: 'Cyclone Biparjoy makes landfall in Gujarat',
      published_at: '2026-08-01T09:00:00Z',
      embedding: sameEmbedding,
    });
    const existingStory = story({
      title: a.title,
      latestTitle: a.title,
      entities: ['cyclone biparjoy', 'gujarat'],
      firstPublishedAt: a.published_at,
      latestPublishedAt: a.published_at,
      embedding: sameEmbedding,
    });
    const b = article({
      title: 'Economic impact of Cyclone Biparjoy assessed months later in Gujarat',
      published_at: '2026-08-26T18:00:00Z',
      embedding: sameEmbedding,
    });

    const decision = decideAssignment(b, [existingStory]);
    expect(decision.allCandidateScores[0].semanticSim).toBeCloseTo(1);
    expect(decision.action).toBe('create');
  });
});

describe('decideAssignment - edge cases', () => {
  test('missing description on both sides does not throw and does not force a merge or a rejection', () => {
    const a = article({ title: 'Cyclone Biparjoy makes landfall in Gujarat', description: null });
    const existingStory = story({
      title: a.title,
      latestTitle: a.title,
      latestDescription: null,
      entities: ['cyclone biparjoy', 'gujarat'],
    });
    const b = article({ title: 'Cyclone Biparjoy hits Gujarat coast', description: null });

    expect(() => decideAssignment(b, [existingStory])).not.toThrow();
  });

  test('missing image_url has no effect on the decision (not a similarity signal)', () => {
    const a = article({ title: 'Cyclone Biparjoy makes landfall in Gujarat', image_url: null });
    const existingStory = story({
      title: a.title,
      latestTitle: a.title,
      entities: ['cyclone biparjoy', 'gujarat'],
    });
    const withImage = decideAssignment(
      article({ title: 'Cyclone Biparjoy hits Gujarat coast', image_url: 'https://example.com/x.jpg' }),
      [existingStory]
    );
    const withoutImage = decideAssignment(
      article({ title: 'Cyclone Biparjoy hits Gujarat coast', image_url: null }),
      [existingStory]
    );
    expect(withImage.confidence).toBe(withoutImage.confidence);
  });

  test('missing/empty entities on both sides does not crash and does not force a merge', () => {
    const existingStory = story({ title: 'Local event happens', latestTitle: 'Local event happens', entities: [] });
    const b = article({ title: 'Another local event happens' });

    expect(() => decideAssignment(b, [existingStory])).not.toThrow();
  });

  test('the semantic signal is 0 (no contribution) rather than throwing when embeddings are missing', () => {
    const existingStory = story({ title: 'Local event happens', latestTitle: 'Local event happens', entities: [] });
    const b = article({ title: 'Another local event happens' });

    const decision = decideAssignment(b, [existingStory]);
    expect(decision.allCandidateScores[0].semanticSim).toBe(0);
  });

  test('a very short headline does not spuriously qualify via the title-similarity path', () => {
    const existingStory = story({ title: 'Modi wins', latestTitle: 'Modi wins', entities: ['modi'] });
    const b = article({ title: 'Modi loses' });

    const decision = decideAssignment(b, [existingStory]);
    // Two 2-word titles sharing "modi" would spike jaccard misleadingly if
    // MIN_TITLE_TOKENS_FOR_SIMILARITY weren't enforced.
    expect(decision.action).toBe('create');
  });

  test('two shared country-name entities alone are not enough to force a merge (real Nepal-floods false-merge regression)', () => {
    // Real production false merge: four distinct Nepal-floods articles (an
    // MEA briefing, a state helpline notice, a Tamil Nadu CM directive, an
    // ex-official interview) each cleared MIN_SHARED_ENTITY_COUNT against
    // each other with "nepal" + "india" as their only 2 "shared" entities -
    // true overlap, but no evidence they're the same specific development.
    const a = article({ title: 'Former National Reconstruction Authority CEO on Nepal floods' });
    const existingStory = story({
      title: a.title,
      latestTitle: a.title,
      entities: ['former national reconstruction authority', 'nepal', 'india'],
    });
    const b = article({ title: 'Jaishankar reviews Nepal flood situation with MEA officials' });

    const decision = decideAssignment(b, [existingStory]);
    expect(decision.action).toBe('create');
  });

  test('a semantic score in the real false-positive band (0.75) no longer merges alone', () => {
    // Real English false positive: the same four Nepal-floods articles
    // scored 0.71-0.78 against each other on cosine similarity despite
    // covering different specific developments - 0.75 is representative of
    // that band, and would have cleared the old 0.62 threshold.
    const cosine075 = Float32Array.from([0.75, Math.sqrt(1 - 0.75 * 0.75)]);
    const a = article({
      title: 'Former National Reconstruction Authority CEO on Nepal floods',
      embedding: Float32Array.from([1, 0]),
    });
    const existingStory = story({
      title: a.title,
      latestTitle: a.title,
      entities: [],
      embedding: Float32Array.from([1, 0]),
    });
    const b = article({
      title: 'Jaishankar reviews Nepal flood situation with MEA officials',
      embedding: cosine075,
    });

    const decision = decideAssignment(b, [existingStory]);
    expect(decision.allCandidateScores[0].semanticSim).toBeCloseTo(0.75);
    expect(decision.action).toBe('create');
  });

  test('non-English articles never merge via the semantic signal alone, even at cosine = 1', () => {
    // The embedding model is English-only - real cluster_decisions data
    // showed it producing high but meaningless "similarity" between
    // completely unrelated Hindi/Gujarati articles (a farmer-protest report
    // and an unrelated murder-case story scored 0.63; a Raksha Bandhan
    // shopping piece and the same unrelated story scored 0.89).
    const sameEmbedding = Float32Array.from([1, 0, 0]);
    const a = article({
      title: 'बाढ़ से भारी तबाही, राहत कार्य जारी',
      language: 'hi',
      embedding: sameEmbedding,
    });
    const existingStory = story({
      title: a.title,
      latestTitle: a.title,
      entities: [],
      embedding: sameEmbedding,
    });
    const b = article({
      title: 'राखी की खरीदारी के लिए बाजार में उमड़ी भीड़',
      language: 'hi',
      embedding: sameEmbedding,
    });

    const decision = decideAssignment(b, [existingStory]);
    expect(decision.allCandidateScores[0].semanticSim).toBe(0);
    expect(decision.action).toBe('create');
  });

  test('no candidates at all creates a new story rather than throwing', () => {
    const decision = decideAssignment(article({ title: 'Something happened' }), []);
    expect(decision.action).toBe('create');
    expect(decision.allCandidateScores).toEqual([]);
  });

  test('decideAssignment returns every candidate score, not just the winner', () => {
    const target = story({ id: 1, title: 'Cyclone Biparjoy makes landfall in Gujarat', latestTitle: 'Cyclone Biparjoy makes landfall in Gujarat', entities: ['cyclone biparjoy', 'gujarat'] });
    const unrelated = story({ id: 2, title: 'Stock market rallies', latestTitle: 'Stock market rallies', entities: [] });
    const decision = decideAssignment(article({ title: 'Cyclone Biparjoy hits Gujarat coast' }), [unrelated, target]);
    expect(decision.allCandidateScores).toHaveLength(2);
    expect(decision.allCandidateScores.map((c) => c.storyId).sort()).toEqual([1, 2]);
  });
});

describe('computeQuality (representative headline selection)', () => {
  test('a more complete, clearer, higher-ranking article scores higher than a sparse clickbait one', () => {
    const rich = article({
      title: 'Reserve Bank of India cuts interest rates by 25 basis points',
      description: 'The central bank cited slowing inflation in its latest policy meeting.',
      image_url: 'https://example.com/rbi.jpg',
      source: 'The Hindu',
    });
    const thin = article({
      title: 'YOU WONT BELIEVE what the RBI just did!!',
      description: null,
      image_url: null,
      source: 'Times of India',
    });

    expect(computeQuality(rich, NOW)).toBeGreaterThan(computeQuality(thin, NOW));
  });
});

describe('titleClarityScore', () => {
  test('penalizes clickbait phrasing', () => {
    expect(titleClarityScore('10 things you wont believe about this policy')).toBeLessThan(
      titleClarityScore('Government announces new policy on housing')
    );
  });

  test('penalizes excessive capitalization and punctuation', () => {
    expect(titleClarityScore('THIS IS SHOCKING NEWS!!')).toBeLessThan(titleClarityScore('Government announces new policy'));
  });

  test('returns 0 for an empty/missing title rather than throwing', () => {
    expect(titleClarityScore('')).toBe(0);
    expect(titleClarityScore(null)).toBe(0);
  });
});

describe('completenessScore', () => {
  test('scores 1 when both description and image are present, 0 when neither', () => {
    expect(completenessScore(article({ description: 'x', image_url: 'y' }))).toBe(1);
    expect(completenessScore(article({ description: null, image_url: null }))).toBe(0);
  });

  test('scores 0.5 when only one of description/image is present', () => {
    expect(completenessScore(article({ description: 'x', image_url: null }))).toBe(0.5);
    expect(completenessScore(article({ description: null, image_url: 'y' }))).toBe(0.5);
  });
});
