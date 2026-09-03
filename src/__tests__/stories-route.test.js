process.env.DB_PATH = ':memory:';

const request = require('supertest');
const db = require('../db');
const app = require('../index');

function insertArticle(overrides = {}) {
  const article = {
    id: overrides.id,
    title: 'Headline',
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
    summary: 'A powerful cyclone has made landfall.',
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
});

describe('GET /stories/top', () => {
  test('returns stories shaped for card display, including the representative article', () => {
    const storyId = insertStory();
    insertArticle({ id: 1, story_id: storyId, title: 'Cyclone Biparjoy makes landfall in Gujarat' });
    db.prepare('UPDATE stories SET representative_article_id = 1 WHERE id = ?').run(storyId);

    return request(app)
      .get('/stories/top')
      .then((res) => {
        expect(res.status).toBe(200);
        expect(res.body[0]).toEqual(
          expect.objectContaining({
            id: storyId,
            title: 'Cyclone Biparjoy makes landfall in Gujarat',
            articleCount: 1,
            sourceCount: 1,
            storyScore: expect.any(Number),
            representativeArticle: expect.objectContaining({ id: 1, source: 'Times of India' }),
          })
        );
        expect(res.body[0].scoreBreakdown).toBeUndefined();
      });
  });

  test('ranks a story with one important article above a story with several trivial ones', async () => {
    const importantId = insertStory({
      title: 'War escalates as government declares emergency after earthquake disaster',
      latest_title: 'War escalates as government declares emergency after earthquake disaster',
    });
    insertArticle({
      id: 1,
      story_id: importantId,
      title: 'War escalates as government declares emergency after earthquake disaster',
      source: 'The Hindu',
    });
    db.prepare('UPDATE stories SET representative_article_id = 1 WHERE id = ?').run(importantId);

    const trivialId = insertStory({ title: 'Celebrity horoscope roundup', latest_title: 'Celebrity horoscope roundup' });
    for (let i = 2; i <= 6; i++) {
      insertArticle({
        id: i,
        story_id: trivialId,
        title: 'Celebrity horoscope roundup',
        source: `Source ${i}`,
      });
    }
    db.prepare('UPDATE stories SET representative_article_id = 2, article_count = 5, source_count = 5 WHERE id = ?').run(
      trivialId
    );

    const res = await request(app).get('/stories/top');
    expect(res.body[0].id).toBe(importantId);
  });

  test('filters by language and category', async () => {
    const wanted = insertStory({ category: 'business', language: 'en' });
    insertArticle({ id: 1, story_id: wanted, category: 'business', language: 'en' });
    db.prepare('UPDATE stories SET representative_article_id = 1 WHERE id = ?').run(wanted);

    const unwanted = insertStory({ category: 'sports', language: 'en' });
    insertArticle({ id: 2, story_id: unwanted, category: 'sports', language: 'en' });
    db.prepare('UPDATE stories SET representative_article_id = 2 WHERE id = ?').run(unwanted);

    const res = await request(app).get('/stories/top?language=en&category=business');
    expect(res.body.map((s) => s.id)).toEqual([wanted]);
  });

  test('filters by sources - a story counts if any member article matches, not just the representative one', async () => {
    // wanted's representative article is from NDTV, but a second member came
    // from BBC Sport - filtering by BBC Sport should still surface it,
    // proving this checks every member, not just representative_article_id.
    const wanted = insertStory();
    insertArticle({ id: 1, story_id: wanted, source: 'NDTV' });
    insertArticle({ id: 2, story_id: wanted, source: 'BBC Sport' });
    db.prepare('UPDATE stories SET representative_article_id = 1 WHERE id = ?').run(wanted);

    const unwanted = insertStory();
    insertArticle({ id: 3, story_id: unwanted, source: 'The Hindu' });
    db.prepare('UPDATE stories SET representative_article_id = 3 WHERE id = ?').run(unwanted);

    const res = await request(app).get(`/stories/top?sources=${encodeURIComponent('BBC Sport')}`);
    expect(res.body.map((s) => s.id)).toEqual([wanted]);
  });

  test('caps how many stories from the same category appear in the unfiltered feed', async () => {
    const { MAX_PER_CATEGORY } = require('../services/clustering-config');
    let nextId = 1;

    // A handful of *other* categories, each fresher than every business
    // story below - guarantees they outscore business on recency alone, so
    // they fill their own slots before the cap loop even reaches business,
    // making the cap's effect on business deterministic rather than
    // dependent on tie-breaking among near-identical default fixtures.
    const otherCategories = ['sports', 'entertainment', 'tech', 'world'];
    for (const category of otherCategories) {
      const storyId = insertStory({
        category,
        latest_title: `${category} story`,
        latest_published_at: '2026-08-26T12:00:00Z',
      });
      const id = nextId++;
      insertArticle({ id, story_id: storyId, category, published_at: '2026-08-26T12:00:00Z' });
      db.prepare('UPDATE stories SET representative_article_id = ? WHERE id = ?').run(id, storyId);
    }

    // More business stories than the cap allows, older than the others
    // above (so they never outscore them, isolating the cap's effect).
    for (let i = 1; i <= MAX_PER_CATEGORY + 3; i++) {
      const storyId = insertStory({
        category: 'business',
        latest_title: `Business story ${i}`,
        latest_published_at: '2026-08-26T09:00:00Z',
      });
      const id = nextId++;
      insertArticle({ id, story_id: storyId, category: 'business', published_at: '2026-08-26T09:00:00Z' });
      db.prepare('UPDATE stories SET representative_article_id = ? WHERE id = ?').run(id, storyId);
    }

    // limit = exactly (the 4 other-category stories) + (the category cap) -
    // just enough that every other-category story fits before the cap even
    // needs to bite into business, and not so much that backfill would pull
    // in business's overflow anyway.
    const limit = otherCategories.length + MAX_PER_CATEGORY;
    const res = await request(app).get(`/stories/top?language=en&limit=${limit}`);

    const fromBusiness = res.body.filter((s) => s.category === 'business');
    expect(fromBusiness.length).toBeLessThanOrEqual(MAX_PER_CATEGORY);
    expect(res.body.filter((s) => s.category !== 'business').length).toBe(otherCategories.length);
  });

  test('does NOT truncate a category-filtered request to the diversity cap', async () => {
    const { MAX_PER_CATEGORY } = require('../services/clustering-config');
    const total = MAX_PER_CATEGORY + 3;
    for (let i = 1; i <= total; i++) {
      const storyId = insertStory({ category: 'business', latest_title: `Business story ${i}` });
      insertArticle({ id: i, story_id: storyId, category: 'business' });
      db.prepare('UPDATE stories SET representative_article_id = ? WHERE id = ?').run(i, storyId);
    }

    const res = await request(app).get('/stories/top?language=en&category=business');

    // Filtering to one category is an explicit request for that category's
    // full feed - the diversity cap exists to protect the unfiltered "all
    // categories" view, not to also shrink a view the user already scoped
    // themselves.
    expect(res.body).toHaveLength(total);
  });

  test('excludes merged-away stories from the feed', async () => {
    const target = insertStory();
    insertArticle({ id: 1, story_id: target });
    db.prepare('UPDATE stories SET representative_article_id = 1 WHERE id = ?').run(target);

    insertStory({ status: 'merged', merged_into_story_id: target });

    const res = await request(app).get('/stories/top');
    expect(res.body).toHaveLength(1);
  });

  test('returns an empty array rather than erroring when there are no stories', async () => {
    const res = await request(app).get('/stories/top');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('keeps an older story with recent activity in the candidate pool (pooled by updated_at, not id)', async () => {
    const { STORY_FEED_POOL_SIZE } = require('../services/clustering-config');

    // The oldest story (lowest id) - would sit last under `ORDER BY id DESC`.
    const oldStoryId = insertStory({ title: 'Old but still developing', latest_title: 'Old but still developing' });
    insertArticle({ id: 1, story_id: oldStoryId, title: 'Old but still developing' });
    db.prepare('UPDATE stories SET representative_article_id = 1 WHERE id = ?').run(oldStoryId);

    // Enough newer, quiet stories to completely fill the pool by id.
    let nextArticleId = 2;
    for (let i = 0; i < STORY_FEED_POOL_SIZE; i++) {
      const sid = insertStory({ title: `Quiet story ${i}`, latest_title: `Quiet story ${i}` });
      insertArticle({ id: nextArticleId, story_id: sid, title: `Quiet story ${i}` });
      db.prepare('UPDATE stories SET representative_article_id = ? WHERE id = ?').run(nextArticleId, sid);
      nextArticleId += 1;
    }

    // The old story just gained fresh coverage - its updated_at is now the newest.
    db.prepare("UPDATE stories SET updated_at = datetime('now', '+1 hour') WHERE id = ?").run(oldStoryId);

    const res = await request(app).get('/stories/top?limit=100');
    expect(res.body.map((s) => s.id)).toContain(oldStoryId);
  });
});

describe('GET /stories/:id', () => {
  test('returns 404 for a completely unknown id', async () => {
    const res = await request(app).get('/stories/999999');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Story not found' });
  });

  test('returns the story with its full member list, latest first', async () => {
    const storyId = insertStory();
    insertArticle({ id: 1, story_id: storyId, source: 'Times of India', fetched_at: '2026-08-26 09:00:00' });
    insertArticle({ id: 2, story_id: storyId, source: 'The Hindu', fetched_at: '2026-08-26 10:00:00' });
    db.prepare('UPDATE stories SET representative_article_id = 1, article_count = 2, source_count = 2 WHERE id = ?').run(
      storyId
    );

    const res = await request(app).get(`/stories/${storyId}`);
    expect(res.status).toBe(200);
    expect(res.body.members).toHaveLength(2);
    expect(res.body.members[0].id).toBe(2); // most recently fetched first
    expect(res.body.members.map((m) => m.source).sort()).toEqual(['The Hindu', 'Times of India']);
  });

  test('resolves a merged-away story id to the canonical target instead of 404ing', async () => {
    const targetId = insertStory({ title: 'Canonical story' });
    insertArticle({ id: 1, story_id: targetId });
    db.prepare('UPDATE stories SET representative_article_id = 1 WHERE id = ?').run(targetId);

    const sourceId = insertStory({ status: 'merged', merged_into_story_id: targetId });

    const res = await request(app).get(`/stories/${sourceId}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(targetId);
    expect(res.body.title).toBe('Canonical story');
  });
});

describe('debug output gating', () => {
  const original = process.env.ENABLE_RANKING_DEBUG;
  afterEach(() => {
    if (original === undefined) delete process.env.ENABLE_RANKING_DEBUG;
    else process.env.ENABLE_RANKING_DEBUG = original;
  });

  test('debug=true is ignored (no scoreBreakdown) unless ENABLE_RANKING_DEBUG is set', async () => {
    delete process.env.ENABLE_RANKING_DEBUG;
    const storyId = insertStory();
    insertArticle({ id: 1, story_id: storyId });
    db.prepare('UPDATE stories SET representative_article_id = 1 WHERE id = ?').run(storyId);

    const res = await request(app).get('/stories/top?debug=true');
    expect(res.body[0].scoreBreakdown).toBeUndefined();
  });

  test('debug=true includes a scoreBreakdown when ENABLE_RANKING_DEBUG is "true"', async () => {
    process.env.ENABLE_RANKING_DEBUG = 'true';
    const storyId = insertStory();
    insertArticle({ id: 1, story_id: storyId });
    db.prepare('UPDATE stories SET representative_article_id = 1 WHERE id = ?').run(storyId);

    const res = await request(app).get('/stories/top?debug=true');
    expect(res.body[0].scoreBreakdown).toEqual(
      expect.objectContaining({
        bestArticleScore: expect.any(Number),
        sourceCountSignal: expect.any(Number),
        recencySignal: expect.any(Number),
        momentumSignal: expect.any(Number),
      })
    );
  });
});
