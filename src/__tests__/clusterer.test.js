process.env.DB_PATH = ':memory:';

// Only getEmbedding touches the real ML pipeline (model load + inference) -
// everything else in this module (cosineSimilarity, serialize/deserialize,
// updateCentroid) is pure math that clustering.js/clusterer.js both depend
// on directly, so it stays real here via requireActual. Defaults to
// resolving null (no embedding) so existing tests that don't care about the
// semantic signal keep exercising Stage 2-only behavior, matching how a
// real embedding failure degrades gracefully in production.
jest.mock('../services/embeddings', () => ({
  ...jest.requireActual('../services/embeddings'),
  getEmbedding: jest.fn().mockResolvedValue(null),
}));

const db = require('../db');
const { clusterNewArticles, mergeStories, resolveActiveStory } = require('../ingestion/clusterer');
const { getEmbedding, serializeEmbedding } = require('../services/embeddings');

function insertArticle(overrides = {}) {
  const article = {
    id: overrides.id,
    title: 'Cyclone Biparjoy makes landfall in Gujarat',
    link: `https://example.com/${overrides.id}`,
    source: 'Times of India',
    category: 'world',
    published_at: '2026-08-26T09:00:00Z',
    image_url: null,
    fetched_at: '2026-08-26 09:00:00',
    content: null,
    image_caption: null,
    read_time_minutes: null,
    language: 'en',
    description: null,
    story_id: null,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO articles (id, title, link, source, category, published_at, image_url, fetched_at, content, image_caption, read_time_minutes, language, description, story_id)
     VALUES (@id, @title, @link, @source, @category, @published_at, @image_url, @fetched_at, @content, @image_caption, @read_time_minutes, @language, @description, @story_id)`
  ).run(article);
  return article;
}

function insertStory(overrides = {}) {
  const story = {
    title: 'Cyclone Biparjoy makes landfall in Gujarat',
    summary: null,
    category: 'world',
    language: 'en',
    entities_json: JSON.stringify(['cyclone biparjoy', 'gujarat']),
    latest_title: 'Cyclone Biparjoy makes landfall in Gujarat',
    latest_description: null,
    representative_article_id: null,
    representative_quality: 0.5,
    article_count: 1,
    source_count: 1,
    first_published_at: '2026-08-26T09:00:00Z',
    latest_published_at: '2026-08-26T09:00:00Z',
    status: 'active',
    merged_into_story_id: null,
    ...overrides,
  };
  const result = db
    .prepare(
      `INSERT INTO stories (title, summary, category, language, entities_json, latest_title, latest_description,
         representative_article_id, representative_quality, article_count, source_count,
         first_published_at, latest_published_at, status, merged_into_story_id)
       VALUES (@title, @summary, @category, @language, @entities_json, @latest_title, @latest_description,
         @representative_article_id, @representative_quality, @article_count, @source_count,
         @first_published_at, @latest_published_at, @status, @merged_into_story_id)`
    )
    .run(story);
  return result.lastInsertRowid;
}

beforeEach(() => {
  db.exec('DELETE FROM articles');
  db.exec('DELETE FROM stories');
  db.exec('DELETE FROM cluster_decisions');
  getEmbedding.mockClear();
  getEmbedding.mockResolvedValue(null);
});

describe('clusterNewArticles', () => {
  test('a genuinely new article with no candidates creates its own story', async () => {
    insertArticle({ id: 1 });

    await clusterNewArticles();

    const article = db.prepare('SELECT * FROM articles WHERE id = 1').get();
    expect(article.story_id).not.toBeNull();

    const story = db.prepare('SELECT * FROM stories WHERE id = ?').get(article.story_id);
    expect(story.article_count).toBe(1);
    expect(story.source_count).toBe(1);
    expect(story.title).toBe('Cyclone Biparjoy makes landfall in Gujarat');
  });

  test('a new article merges into an existing active story and updates its aggregates', async () => {
    const storyId = insertStory();
    insertArticle({ id: 1, story_id: storyId }); // the story's existing sole member (Times of India)
    insertArticle({ id: 2, title: 'Cyclone Biparjoy hits Gujarat coast', source: 'The Hindu', story_id: null });

    await clusterNewArticles();

    const article = db.prepare('SELECT * FROM articles WHERE id = 2').get();
    expect(article.story_id).toBe(storyId);

    const story = db.prepare('SELECT * FROM stories WHERE id = ?').get(storyId);
    expect(story.article_count).toBe(2);
    expect(story.source_count).toBe(2); // Times of India (pre-existing) + The Hindu
    expect(story.latest_title).toBe('Cyclone Biparjoy hits Gujarat coast');
  });

  test('a merged-away story is never matched as a candidate', async () => {
    const mergedAwayId = insertStory({ status: 'merged' });
    insertArticle({ id: 3, title: 'Cyclone Biparjoy hits Gujarat coast', source: 'The Hindu', story_id: null });

    await clusterNewArticles();

    const article = db.prepare('SELECT * FROM articles WHERE id = 3').get();
    expect(article.story_id).not.toBe(mergedAwayId);
    // Since the only "matching" story was inactive, this had to create a new one.
    const newStory = db.prepare('SELECT * FROM stories WHERE id = ?').get(article.story_id);
    expect(newStory.status).toBe('active');
  });

  test('an already-clustered article (story_id already set) is never re-touched', async () => {
    const storyId = insertStory();
    insertArticle({ id: 4, story_id: storyId });

    const countBefore = db.prepare('SELECT COUNT(*) AS n FROM stories').get().n;
    await clusterNewArticles();
    const countAfter = db.prepare('SELECT COUNT(*) AS n FROM stories').get().n;

    expect(countAfter).toBe(countBefore); // no new story created, nothing re-clustered
  });

  test('writes a cluster_decisions row per decision with the full candidate list', async () => {
    insertStory();
    insertArticle({ id: 5, title: 'Cyclone Biparjoy hits Gujarat coast', source: 'The Hindu', story_id: null });

    await clusterNewArticles();

    const rows = db.prepare('SELECT * FROM cluster_decisions WHERE article_id = 5').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('merge');
    expect(JSON.parse(rows[0].candidates_json)).toHaveLength(1);
    expect(JSON.parse(rows[0].signals_json)).toEqual(
      expect.objectContaining({ confidence: expect.any(Number), strongSignal: true })
    );
  });

  test('processes multiple unclustered articles in one pass', async () => {
    insertArticle({ id: 6, title: 'Unrelated local story one', story_id: null });
    insertArticle({ id: 7, title: 'Unrelated local story two', story_id: null });

    await clusterNewArticles();

    const remaining = db.prepare('SELECT COUNT(*) AS n FROM articles WHERE story_id IS NULL').get().n;
    expect(remaining).toBe(0);
  });

  test('persists the computed embedding onto the article row', async () => {
    getEmbedding.mockResolvedValue(Float32Array.from([1, 0, 0]));
    insertArticle({ id: 8 });

    await clusterNewArticles();

    const article = db.prepare('SELECT embedding FROM articles WHERE id = 8').get();
    expect(Buffer.isBuffer(article.embedding)).toBe(true);
    expect(article.embedding).toEqual(serializeEmbedding(Float32Array.from([1, 0, 0])));
  });

  test('a newly-created story is seeded with its sole member\'s embedding', async () => {
    getEmbedding.mockResolvedValue(Float32Array.from([0, 1, 0]));
    insertArticle({ id: 9 });

    await clusterNewArticles();

    const article = db.prepare('SELECT story_id FROM articles WHERE id = 9').get();
    const story = db.prepare('SELECT embedding FROM stories WHERE id = ?').get(article.story_id);
    expect(story.embedding).toEqual(serializeEmbedding(Float32Array.from([0, 1, 0])));
  });

  test('merging into a story updates its embedding to the running centroid', async () => {
    // Article 20 is pre-clustered (story_id already set), so it never goes
    // through getEmbedding - only article 21 (below) does. Its story-side
    // embedding is seeded directly via SQL instead.
    const storyId = insertStory();
    insertArticle({ id: 20, story_id: storyId });
    db.prepare('UPDATE stories SET embedding = ? WHERE id = ?').run(serializeEmbedding(Float32Array.from([1, 0])), storyId);

    getEmbedding.mockResolvedValueOnce(Float32Array.from([0, 1]));
    insertArticle({ id: 21, title: 'Cyclone Biparjoy hits Gujarat coast', source: 'The Hindu', story_id: null });

    await clusterNewArticles();

    const story = db.prepare('SELECT embedding FROM stories WHERE id = ?').get(storyId);
    const centroid = new Float32Array(story.embedding.buffer, story.embedding.byteOffset, story.embedding.length / 4);
    // Halfway between [1,0] and [0,1], re-normalized to a unit vector.
    expect(centroid[0]).toBeCloseTo(1 / Math.sqrt(2));
    expect(centroid[1]).toBeCloseTo(1 / Math.sqrt(2));
  });
});

describe('mergeStories', () => {
  test('repoints every member article from the source story to the target', () => {
    const targetId = insertStory({ latest_title: 'Target story' });
    const sourceId = insertStory({ latest_title: 'Source story' });
    insertArticle({ id: 10, story_id: sourceId, source: 'Times of India' });
    insertArticle({ id: 11, story_id: sourceId, source: 'Aaj Tak' });
    insertArticle({ id: 12, story_id: targetId, source: 'The Hindu' });

    mergeStories(sourceId, targetId);

    const articles = db.prepare('SELECT id, story_id FROM articles ORDER BY id').all();
    expect(articles.every((a) => a.story_id === targetId)).toBe(true);
  });

  test('recomputes the target story aggregates from its full new membership', () => {
    const targetId = insertStory({
      first_published_at: '2026-08-26T09:00:00Z',
      latest_published_at: '2026-08-26T09:00:00Z',
      entities_json: JSON.stringify(['gujarat']),
    });
    const sourceId = insertStory({
      first_published_at: '2026-08-26T08:00:00Z',
      latest_published_at: '2026-08-26T12:00:00Z',
      entities_json: JSON.stringify(['cyclone biparjoy']),
    });
    insertArticle({ id: 13, story_id: sourceId, source: 'Times of India', published_at: '2026-08-26T08:00:00Z' });
    insertArticle({ id: 14, story_id: sourceId, source: 'Aaj Tak', published_at: '2026-08-26T12:00:00Z' });
    insertArticle({ id: 15, story_id: targetId, source: 'The Hindu', published_at: '2026-08-26T09:00:00Z' });

    mergeStories(sourceId, targetId);

    const target = db.prepare('SELECT * FROM stories WHERE id = ?').get(targetId);
    expect(target.article_count).toBe(3);
    expect(target.source_count).toBe(3);
    expect(target.first_published_at).toBe('2026-08-26T08:00:00Z');
    expect(target.latest_published_at).toBe('2026-08-26T12:00:00Z');
    expect(JSON.parse(target.entities_json).sort()).toEqual(['cyclone biparjoy', 'gujarat']);
  });

  test('recomputes the target story embedding as the centroid of the full new membership', () => {
    const targetId = insertStory();
    const sourceId = insertStory();
    insertArticle({ id: 17, story_id: sourceId, source: 'Times of India' });
    db.prepare('UPDATE articles SET embedding = ? WHERE id = ?').run(
      serializeEmbedding(Float32Array.from([1, 0])),
      17
    );
    insertArticle({ id: 18, story_id: targetId, source: 'The Hindu' });
    db.prepare('UPDATE articles SET embedding = ? WHERE id = ?').run(
      serializeEmbedding(Float32Array.from([0, 1])),
      18
    );

    mergeStories(sourceId, targetId);

    const target = db.prepare('SELECT embedding FROM stories WHERE id = ?').get(targetId);
    const centroid = new Float32Array(target.embedding.buffer, target.embedding.byteOffset, target.embedding.length / 4);
    expect(centroid[0]).toBeCloseTo(1 / Math.sqrt(2));
    expect(centroid[1]).toBeCloseTo(1 / Math.sqrt(2));
  });

  test('marks the source story as merged rather than deleting it', () => {
    const targetId = insertStory();
    const sourceId = insertStory();
    insertArticle({ id: 16, story_id: sourceId });

    mergeStories(sourceId, targetId);

    const source = db.prepare('SELECT * FROM stories WHERE id = ?').get(sourceId);
    expect(source).not.toBeNull(); // row still exists
    expect(source.status).toBe('merged');
    expect(source.merged_into_story_id).toBe(targetId);
  });

  test('throws when merging a story into itself', () => {
    const id = insertStory();
    expect(() => mergeStories(id, id)).toThrow();
  });

  test('throws when either story does not exist', () => {
    const id = insertStory();
    expect(() => mergeStories(id, 999999)).toThrow();
    expect(() => mergeStories(999999, id)).toThrow();
  });
});

describe('resolveActiveStory', () => {
  test('returns the story directly when it is already active', () => {
    const id = insertStory();
    const resolved = resolveActiveStory(id);
    expect(resolved.id).toBe(id);
  });

  test('follows merged_into_story_id to the canonical active story', () => {
    const targetId = insertStory();
    const sourceId = insertStory({ status: 'merged', merged_into_story_id: targetId });

    const resolved = resolveActiveStory(sourceId);
    expect(resolved.id).toBe(targetId);
  });

  test('returns null for a completely unknown id', () => {
    expect(resolveActiveStory(999999)).toBeNull();
  });
});
