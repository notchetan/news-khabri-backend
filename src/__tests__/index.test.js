// Point db.js at an in-memory database before anything requires it, so tests
// never touch the real articles.db file and each test file gets a fresh DB.
process.env.DB_PATH = ':memory:';

jest.mock('../ingestion/article-scraper');

const request = require('supertest');
const db = require('../db');
const { syncArticleFts } = require('../db/fts');
const { setSources } = require('../ingestion/source-registry');
const { scrapeArticle } = require('../ingestion/article-scraper');
const app = require('../index');

function insertArticle(overrides = {}) {
  const article = {
    id: overrides.id,
    title: 'Title',
    link: `https://example.com/${overrides.id}`,
    source: 'Test Source',
    category: 'national',
    published_at: '2026-08-25T12:00:00Z',
    image_url: null,
    fetched_at: '2026-08-25 12:00:00',
    content: null,
    image_caption: null,
    read_time_minutes: null,
    language: 'en',
    description: null,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO articles (id, title, link, source, category, published_at, image_url, fetched_at, content, image_caption, read_time_minutes, language, description)
     VALUES (@id, @title, @link, @source, @category, @published_at, @image_url, @fetched_at, @content, @image_caption, @read_time_minutes, @language, @description)`
  ).run(article);
  // This test helper writes directly to `articles`, bypassing
  // ingestion/fetcher.js's own insert - keep articles_fts in sync the same
  // way that real insert path does, so the GET /articles search tests below
  // exercise real FTS5 matching rather than a table nothing ever populated.
  syncArticleFts(article.id);
  return article;
}

beforeEach(() => {
  db.exec('DELETE FROM articles');
  db.exec('DELETE FROM articles_fts');
  setSources([]);
  jest.clearAllMocks();
});

describe('GET /articles', () => {
  test('defaults to language=en and orders newest first', async () => {
    insertArticle({ id: 1, fetched_at: '2026-08-25 10:00:00' });
    insertArticle({ id: 2, fetched_at: '2026-08-25 12:00:00' });
    insertArticle({ id: 3, fetched_at: '2026-08-25 11:00:00', language: 'hi' });

    const res = await request(app).get('/articles');
    expect(res.status).toBe(200);
    expect(res.body.map((a) => a.id)).toEqual([2, 1]);
  });

  test('filters by language', async () => {
    insertArticle({ id: 1, language: 'en' });
    insertArticle({ id: 2, language: 'hi' });

    const res = await request(app).get('/articles?language=hi');
    expect(res.body.map((a) => a.id)).toEqual([2]);
  });

  test('filters by category', async () => {
    insertArticle({ id: 1, category: 'business' });
    insertArticle({ id: 2, category: 'sports' });

    const res = await request(app).get('/articles?category=sports');
    expect(res.body.map((a) => a.id)).toEqual([2]);
  });

  test('filters by a comma-separated sources list', async () => {
    insertArticle({ id: 1, source: 'NDTV' });
    insertArticle({ id: 2, source: 'BBC Sport' });
    insertArticle({ id: 3, source: 'The Hindu' });

    const sourcesParam = encodeURIComponent('NDTV,The Hindu');
    const res = await request(app).get(`/articles?sources=${sourcesParam}`);
    expect(res.body.map((a) => a.id).sort()).toEqual([1, 3]);
  });

  test('ignores an empty sources param (no filter, same as omitting it)', async () => {
    insertArticle({ id: 1, source: 'NDTV' });
    insertArticle({ id: 2, source: 'BBC Sport' });

    const res = await request(app).get('/articles?sources=');
    expect(res.body).toHaveLength(2);
  });

  test('respects a custom limit', async () => {
    insertArticle({ id: 1, fetched_at: '2026-08-25 10:00:00' });
    insertArticle({ id: 2, fetched_at: '2026-08-25 11:00:00' });
    insertArticle({ id: 3, fetched_at: '2026-08-25 12:00:00' });

    const res = await request(app).get('/articles?limit=2');
    expect(res.body).toHaveLength(2);
  });

  test('caps the limit at 50 even if a larger value is requested', async () => {
    for (let i = 1; i <= 60; i++) {
      insertArticle({ id: i, fetched_at: `2026-08-25 ${String(10 + (i % 12)).padStart(2, '0')}:00:0${i % 10}` });
    }
    const res = await request(app).get('/articles?limit=999');
    expect(res.body.length).toBeLessThanOrEqual(50);
  });

  test('cursor pagination continues without overlap or gaps', async () => {
    for (let i = 1; i <= 5; i++) {
      insertArticle({ id: i, fetched_at: `2026-08-25 10:0${i}:00` });
    }

    const page1 = await request(app).get('/articles?limit=2');
    expect(page1.body.map((a) => a.id)).toEqual([5, 4]);

    const last = page1.body[page1.body.length - 1];
    const cursor = `${last.fetched_at}|${last.id}`;
    const page2 = await request(app).get(`/articles?limit=2&cursor=${encodeURIComponent(cursor)}`);
    expect(page2.body.map((a) => a.id)).toEqual([3, 2]);

    const allIds = [...page1.body, ...page2.body].map((a) => a.id);
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  test('filters by a partial, case-insensitive title match via search', async () => {
    insertArticle({ id: 1, title: 'Stock Markets rally on rate cut hopes' });
    insertArticle({ id: 2, title: 'Cricket team wins series' });

    const res = await request(app).get('/articles?search=market');
    expect(res.body.map((a) => a.id)).toEqual([1]);
  });

  test('combines search with a category filter', async () => {
    insertArticle({ id: 1, title: 'Market update', category: 'business' });
    insertArticle({ id: 2, title: 'Market day at the fair', category: 'lifestyle' });

    const res = await request(app).get('/articles?search=market&category=business');
    expect(res.body.map((a) => a.id)).toEqual([1]);
  });

  test('matches on description, not just title - the old LIKE query could not do this', async () => {
    insertArticle({
      id: 1,
      title: 'Central bank meets today',
      description: 'The RBI is expected to announce a rate decision',
    });
    insertArticle({ id: 2, title: 'Cricket team wins series', description: null });

    const res = await request(app).get('/articles?search=rbi');
    expect(res.body.map((a) => a.id)).toEqual([1]);
  });

  test('matches on content', async () => {
    insertArticle({ id: 1, title: 'Neutral headline', content: 'Full report on the earthquake damage' });
    insertArticle({ id: 2, title: 'Different story', content: 'Nothing related here' });

    const res = await request(app).get('/articles?search=earthquake');
    expect(res.body.map((a) => a.id)).toEqual([1]);
  });

  test('prefix-matches a partial word rather than requiring the exact full word', async () => {
    insertArticle({ id: 1, title: 'Government announces new education policy' });
    insertArticle({ id: 2, title: 'Cricket team wins series' });

    const res = await request(app).get('/articles?search=educ');
    expect(res.body.map((a) => a.id)).toEqual([1]);
  });

  test('requires every search word to match (implicit AND across words)', async () => {
    insertArticle({ id: 1, title: 'Election results announced for the state government' });
    insertArticle({ id: 2, title: 'Election day turnout breaks records' });

    const res = await request(app).get('/articles?search=election%20government');
    expect(res.body.map((a) => a.id)).toEqual([1]);
  });

  test('returns no results (not an error) for a search of only punctuation', async () => {
    insertArticle({ id: 1, title: 'Some headline' });

    const res = await request(app).get(`/articles?search=${encodeURIComponent('***')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('cursor pagination still works correctly when combined with search', async () => {
    for (let i = 1; i <= 3; i++) {
      insertArticle({ id: i, title: 'Budget announcement', fetched_at: `2026-08-25 10:0${i}:00` });
    }

    const page1 = await request(app).get('/articles?search=budget&limit=2');
    expect(page1.body.map((a) => a.id)).toEqual([3, 2]);

    const last = page1.body[page1.body.length - 1];
    const cursor = `${last.fetched_at}|${last.id}`;
    const page2 = await request(app).get(
      `/articles?search=budget&limit=2&cursor=${encodeURIComponent(cursor)}`
    );
    expect(page2.body.map((a) => a.id)).toEqual([1]);
  });

  test('returns everything when search is absent (no regression)', async () => {
    insertArticle({ id: 1, title: 'A' });
    insertArticle({ id: 2, title: 'B' });

    const res = await request(app).get('/articles');
    expect(res.body).toHaveLength(2);
  });

  test('includes a ranking_score breakdown on each result without changing the chronological order', async () => {
    insertArticle({
      id: 1,
      title: 'Company announces routine quarterly update',
      fetched_at: '2026-08-25 12:30:00',
      published_at: '2026-08-25T12:30:00Z',
    });
    insertArticle({
      id: 2,
      title: 'War escalates as government declares emergency after earthquake disaster',
      fetched_at: '2026-08-25 12:00:00',
      published_at: '2026-08-25T12:00:00Z',
    });

    const res = await request(app).get('/articles');
    // Still newest-fetched-first, unlike /articles/top - the score is
    // informational only here, not used to reorder these results.
    expect(res.body.map((a) => a.id)).toEqual([1, 2]);
    expect(res.body[0]).toEqual(
      expect.objectContaining({
        ranking_score: expect.any(Number),
        ranking_freshness: expect.any(Number),
        ranking_importance: expect.any(Number),
        ranking_sourceAuthority: expect.any(Number),
      })
    );
  });
});

describe('GET /articles/top', () => {
  test('does not simply return newest-first (importance/authority can outrank a slightly fresher routine article)', async () => {
    insertArticle({
      id: 1,
      title: 'Company announces routine quarterly update',
      source: 'Test Source',
      fetched_at: '2026-08-25 12:30:00',
      published_at: '2026-08-25T12:30:00Z',
    });
    insertArticle({
      id: 2,
      title: 'War escalates as government declares emergency after earthquake disaster',
      source: 'Test Source',
      fetched_at: '2026-08-25 12:00:00',
      published_at: '2026-08-25T12:00:00Z',
    });

    const res = await request(app).get('/articles/top');
    expect(res.status).toBe(200);
    // Article 2 is slightly older but far more important - it should rank
    // first despite /articles (chronological) putting article 1 first.
    expect(res.body[0].id).toBe(2);
  });

  test('includes a ranking_score breakdown on each result', async () => {
    insertArticle({ id: 1 });

    const res = await request(app).get('/articles/top');
    expect(res.body[0]).toEqual(
      expect.objectContaining({
        ranking_score: expect.any(Number),
        ranking_freshness: expect.any(Number),
        ranking_importance: expect.any(Number),
        ranking_sourceAuthority: expect.any(Number),
      })
    );
  });

  test('filters by language and category the same way /articles does', async () => {
    insertArticle({ id: 1, category: 'business', language: 'en' });
    insertArticle({ id: 2, category: 'sports', language: 'en' });
    insertArticle({ id: 3, category: 'business', language: 'hi' });

    const res = await request(app).get('/articles/top?language=en&category=business');
    expect(res.body.map((a) => a.id)).toEqual([1]);
  });

  test('filters by a comma-separated sources list', async () => {
    insertArticle({ id: 1, source: 'NDTV' });
    insertArticle({ id: 2, source: 'BBC Sport' });

    const res = await request(app).get('/articles/top?sources=NDTV');
    expect(res.body.map((a) => a.id)).toEqual([1]);
  });

  test('respects a custom limit', async () => {
    for (let i = 1; i <= 5; i++) {
      insertArticle({ id: i, fetched_at: `2026-08-25 12:0${i}:00` });
    }

    const res = await request(app).get('/articles/top?limit=2');
    expect(res.body).toHaveLength(2);
  });

  test('returns an empty array rather than erroring when there are no articles', async () => {
    const res = await request(app).get('/articles/top');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('GET /articles/:id', () => {
  test('returns 404 for a missing article', async () => {
    const res = await request(app).get('/articles/999999');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Article not found' });
  });

  test('does not call the scraper when content is already cached', async () => {
    insertArticle({ id: 1, content: '<p>Already scraped.</p>' });

    const res = await request(app).get('/articles/1');
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('<p>Already scraped.</p>');
    expect(scrapeArticle).not.toHaveBeenCalled();
  });

  test('scrapes and persists content when not yet cached', async () => {
    insertArticle({ id: 1, link: 'https://example.com/1', content: null });
    scrapeArticle.mockResolvedValue({
      content: '<p>Fresh.</p>',
      imageCaption: 'Credit: Someone',
      readTimeMinutes: 3,
    });

    const res = await request(app).get('/articles/1');
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('<p>Fresh.</p>');
    expect(res.body.image_caption).toBe('Credit: Someone');
    expect(res.body.read_time_minutes).toBe(3);
    expect(scrapeArticle).toHaveBeenCalledWith('https://example.com/1');

    const stored = db.prepare('SELECT content, image_caption, read_time_minutes FROM articles WHERE id = ?').get(1);
    expect(stored.content).toBe('<p>Fresh.</p>');
    expect(stored.read_time_minutes).toBe(3);
  });

  test('returns the article gracefully (content stays null) when scraping fails', async () => {
    insertArticle({ id: 1, content: null });
    scrapeArticle.mockRejectedValue(new Error('network error'));

    const res = await request(app).get('/articles/1');
    expect(res.status).toBe(200);
    expect(res.body.content).toBeNull();
  });

  test('returns the article gracefully when the scraper returns null', async () => {
    insertArticle({ id: 1, content: null });
    scrapeArticle.mockResolvedValue(null);

    const res = await request(app).get('/articles/1');
    expect(res.status).toBe(200);
    expect(res.body.content).toBeNull();
  });

  test('related articles are same category and language, excluding the article itself', async () => {
    insertArticle({ id: 1, category: 'sports', language: 'en', content: 'x' });
    insertArticle({ id: 2, category: 'sports', language: 'en' });
    insertArticle({ id: 3, category: 'sports', language: 'hi' }); // different language
    insertArticle({ id: 4, category: 'business', language: 'en' }); // different category

    const res = await request(app).get('/articles/1');
    expect(res.body.related.map((a) => a.id)).toEqual([2]);
  });

  test('related list caps at 10 items', async () => {
    insertArticle({ id: 1, category: 'sports', content: 'x' });
    for (let i = 2; i <= 13; i++) {
      insertArticle({ id: i, category: 'sports' });
    }

    const res = await request(app).get('/articles/1');
    expect(res.body.related).toHaveLength(10);
  });
});

describe('GET /categories', () => {
  test('returns unique categories for the requested language only', async () => {
    setSources([
      { name: 'A', category: 'national', language: 'en' },
      { name: 'B', category: 'national', language: 'en' },
      { name: 'C', category: 'business', language: 'en' },
      { name: 'D', category: 'बिजनेस', language: 'hi' },
    ]);

    const en = await request(app).get('/categories?language=en');
    expect(en.body.sort()).toEqual(['business', 'national']);

    const hi = await request(app).get('/categories?language=hi');
    expect(hi.body).toEqual(['बिजनेस']);
  });

  test('defaults to language=en when not specified', async () => {
    setSources([{ name: 'A', category: 'national', language: 'en' }]);
    const res = await request(app).get('/categories');
    expect(res.body).toEqual(['national']);
  });

  test('treats a source with no language field as English', async () => {
    setSources([{ name: 'A', category: 'national' }]);
    const res = await request(app).get('/categories?language=en');
    expect(res.body).toEqual(['national']);
  });

  test('excludes hidden categories like opinion from the pill list', async () => {
    setSources([
      { name: 'A', category: 'national', language: 'en' },
      { name: 'B', category: 'opinion', language: 'en' },
    ]);
    const res = await request(app).get('/categories?language=en');
    expect(res.body).toEqual(['national']);
  });

  test('when a sources filter is given, only returns categories that actually have an article from one of those sources', async () => {
    // Registered for both, but only NDTV has actually published a business
    // article - selecting only NDTV should hide "sports" even though it's
    // a real configured category (registered feeds aren't checked once a
    // sources filter is active - real DB content is).
    setSources([
      { name: 'NDTV', category: 'business', language: 'en' },
      { name: 'NDTV', category: 'sports', language: 'en' },
      { name: 'BBC Sport', category: 'sports', language: 'en' },
    ]);
    insertArticle({ id: 1, source: 'NDTV', category: 'business', language: 'en' });
    insertArticle({ id: 2, source: 'BBC Sport', category: 'sports', language: 'en' });

    const res = await request(app).get('/categories?language=en&sources=NDTV');
    expect(res.body).toEqual(['business']);
  });

  test('a sources filter still excludes hidden categories', async () => {
    insertArticle({ id: 1, source: 'NDTV', category: 'opinion', language: 'en' });
    insertArticle({ id: 2, source: 'NDTV', category: 'business', language: 'en' });

    const res = await request(app).get('/categories?language=en&sources=NDTV');
    expect(res.body).toEqual(['business']);
  });

  test('an empty sources param falls back to the unfiltered, registry-based list', async () => {
    setSources([{ name: 'A', category: 'national', language: 'en' }]);
    const res = await request(app).get('/categories?language=en&sources=');
    expect(res.body).toEqual(['national']);
  });

  test('excludes "top stories" from the pill list (a publisher front-page feed, not a real topic)', async () => {
    setSources([
      { name: 'A', category: 'national', language: 'en' },
      { name: 'B', category: 'top stories', language: 'en' },
    ]);
    const res = await request(app).get('/categories?language=en');
    expect(res.body).toEqual(['national']);
  });
});

describe('GET /languages', () => {
  test('returns the distinct set of languages currently registered', async () => {
    setSources([
      { name: 'A', language: 'en' },
      { name: 'B', language: 'en' },
      { name: 'C', language: 'hi' },
    ]);
    const res = await request(app).get('/languages');
    expect(res.body.sort()).toEqual(['en', 'hi']);
  });

  test('returns an empty list when no sources are registered', async () => {
    const res = await request(app).get('/languages');
    expect(res.body).toEqual([]);
  });
});

describe('GET /sources', () => {
  test('returns unique, sorted publisher names for the requested language only', async () => {
    setSources([
      { name: 'NDTV', category: 'national', language: 'en' },
      { name: 'NDTV', category: 'business', language: 'en' },
      { name: 'BBC Sport', category: 'sports', language: 'en' },
      { name: 'Dainik Bhaskar', category: 'देश', language: 'hi' },
    ]);

    const en = await request(app).get('/sources?language=en');
    expect(en.body).toEqual(['BBC Sport', 'NDTV']);

    const hi = await request(app).get('/sources?language=hi');
    expect(hi.body).toEqual(['Dainik Bhaskar']);
  });

  test('defaults to language=en when not specified', async () => {
    setSources([{ name: 'NDTV', category: 'national', language: 'en' }]);
    const res = await request(app).get('/sources');
    expect(res.body).toEqual(['NDTV']);
  });

  test('returns an empty list when no sources are registered', async () => {
    const res = await request(app).get('/sources');
    expect(res.body).toEqual([]);
  });
});
