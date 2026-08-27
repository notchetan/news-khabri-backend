process.env.DB_PATH = ':memory:';

jest.mock('rss-parser');
const Parser = require('rss-parser');

const db = require('../db');
const { setSources } = require('../ingestion/source-registry');
const fetchAllFeeds = require('../ingestion/fetcher');

beforeEach(() => {
  db.exec('DELETE FROM articles');
  jest.clearAllMocks();
});

describe('fetchAllFeeds', () => {
  test('inserts articles from every registered source', async () => {
    Parser.prototype.parseURL.mockResolvedValue({
      items: [
        { title: 'Story One', link: 'https://example.com/1', pubDate: '2026-08-25' },
        { title: 'Story Two', link: 'https://example.com/2', pubDate: '2026-08-25' },
      ],
    });
    setSources([{ name: 'Test Source', url: 'https://example.com/feed', category: 'national', language: 'en' }]);

    await fetchAllFeeds();

    const rows = db.prepare('SELECT * FROM articles ORDER BY id').all();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      title: 'Story One',
      link: 'https://example.com/1',
      source: 'Test Source',
      category: 'national',
      language: 'en',
    });
  });

  test('trims leading/trailing whitespace from the title (some feeds indent their <title> content)', async () => {
    Parser.prototype.parseURL.mockResolvedValue({
      items: [
        {
          title: '\n                 Padded headline text \n             ',
          link: 'https://example.com/padded',
          pubDate: '2026-08-25',
        },
      ],
    });
    setSources([{ name: 'Test Source', url: 'https://example.com/feed', category: 'national', language: 'en' }]);

    await fetchAllFeeds();

    const row = db.prepare('SELECT title FROM articles WHERE link = ?').get('https://example.com/padded');
    expect(row.title).toBe('Padded headline text');
  });

  test('persists a plain-text description extracted from the feed item', async () => {
    Parser.prototype.parseURL.mockResolvedValue({
      items: [
        {
          title: 'Story with description',
          link: 'https://example.com/desc',
          pubDate: '2026-08-25',
          contentSnippet: 'A short plain-text summary',
        },
      ],
    });
    setSources([{ name: 'Test Source', url: 'https://example.com/feed', category: 'national', language: 'en' }]);

    await fetchAllFeeds();

    const row = db.prepare('SELECT description FROM articles WHERE link = ?').get('https://example.com/desc');
    expect(row.description).toBe('A short plain-text summary');
  });

  test('deduplicates by link via INSERT ... ON CONFLICT', async () => {
    Parser.prototype.parseURL.mockResolvedValue({
      items: [{ title: 'Same Link', link: 'https://example.com/dup', pubDate: '2026-08-25' }],
    });
    setSources([{ name: 'A', url: 'https://a.example.com/feed', category: 'national', language: 'en' }]);

    await fetchAllFeeds();
    await fetchAllFeeds();

    const rows = db.prepare('SELECT * FROM articles WHERE link = ?').all('https://example.com/dup');
    expect(rows).toHaveLength(1);
  });

  test('deduplicates the same story listed under different tracking params (e.g. two overlapping category feeds)', async () => {
    setSources([
      { name: 'A', url: 'https://a.example.com/business-feed', category: 'business', language: 'en' },
    ]);

    Parser.prototype.parseURL.mockResolvedValueOnce({
      items: [
        { title: 'Same Story', link: 'https://example.com/story?utm_source=business', pubDate: '2026-08-25' },
      ],
    });
    await fetchAllFeeds();

    Parser.prototype.parseURL.mockResolvedValueOnce({
      items: [
        { title: 'Same Story', link: 'https://example.com/story?utm_source=topnews', pubDate: '2026-08-25' },
      ],
    });
    await fetchAllFeeds();

    const rows = db.prepare('SELECT * FROM articles').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].link).toBe('https://example.com/story');
  });

  test('backfills a null image_url on conflict but never overwrites an existing one', async () => {
    setSources([{ name: 'A', url: 'https://a.example.com/feed', category: 'national', language: 'en' }]);

    Parser.prototype.parseURL.mockResolvedValueOnce({
      items: [{ title: 'T', link: 'https://example.com/img-test', pubDate: '2026-08-25' }],
    });
    await fetchAllFeeds();
    expect(
      db.prepare('SELECT image_url FROM articles WHERE link = ?').get('https://example.com/img-test').image_url
    ).toBeNull();

    Parser.prototype.parseURL.mockResolvedValueOnce({
      items: [
        {
          title: 'T',
          link: 'https://example.com/img-test',
          pubDate: '2026-08-25',
          enclosure: { url: 'https://example.com/new-image.jpg' },
        },
      ],
    });
    await fetchAllFeeds();
    expect(
      db.prepare('SELECT image_url FROM articles WHERE link = ?').get('https://example.com/img-test').image_url
    ).toBe('https://example.com/new-image.jpg');

    // A second, different image_url must NOT overwrite the one we just backfilled.
    Parser.prototype.parseURL.mockResolvedValueOnce({
      items: [
        {
          title: 'T',
          link: 'https://example.com/img-test',
          pubDate: '2026-08-25',
          enclosure: { url: 'https://example.com/yet-another.jpg' },
        },
      ],
    });
    await fetchAllFeeds();
    expect(
      db.prepare('SELECT image_url FROM articles WHERE link = ?').get('https://example.com/img-test').image_url
    ).toBe('https://example.com/new-image.jpg');
  });

  test('continues to the next source when one source fails to fetch', async () => {
    setSources([
      { name: 'Broken', url: 'https://broken.example.com/feed', category: 'national', language: 'en' },
      { name: 'Working', url: 'https://working.example.com/feed', category: 'national', language: 'en' },
    ]);
    Parser.prototype.parseURL.mockImplementation((url) => {
      if (url.includes('broken')) return Promise.reject(new Error('fetch failed'));
      return Promise.resolve({
        items: [{ title: 'Survived', link: 'https://example.com/survived', pubDate: '2026-08-25' }],
      });
    });

    await expect(fetchAllFeeds()).resolves.toBeUndefined();

    const rows = db.prepare('SELECT * FROM articles').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('Working');
  });

  test('derives the real category from the link path for the NDTV Profit feed, not its blanket "business" label', async () => {
    Parser.prototype.parseURL.mockResolvedValue({
      items: [
        { title: 'A stock story', link: 'https://www.ndtvprofit.com/markets/a-stock-story', pubDate: '2026-08-27' },
        { title: 'An eclipse story', link: 'https://www.ndtvprofit.com/trending/an-eclipse-story', pubDate: '2026-08-27' },
      ],
    });
    setSources([
      { name: 'NDTV', url: 'https://feeds.feedburner.com/ndtvprofit-latest', category: 'business', language: 'en' },
    ]);

    await fetchAllFeeds();

    const stock = db.prepare('SELECT category FROM articles WHERE link = ?').get('https://www.ndtvprofit.com/markets/a-stock-story');
    const eclipse = db.prepare('SELECT category FROM articles WHERE link = ?').get('https://www.ndtvprofit.com/trending/an-eclipse-story');
    expect(stock.category).toBe('business');
    expect(eclipse.category).toBe('opinion');
  });

  test('defaults missing title/link to empty strings and missing pubDate to null', async () => {
    Parser.prototype.parseURL.mockResolvedValue({ items: [{}] });
    setSources([{ name: 'A', url: 'https://a.example.com/feed', category: 'national', language: 'en' }]);

    await fetchAllFeeds();

    const row = db.prepare('SELECT * FROM articles').get();
    expect(row.title).toBe('');
    expect(row.link).toBe('');
    expect(row.published_at).toBeNull();
  });

  test('with a source name filter, only fetches feeds belonging to those publishers', async () => {
    Parser.prototype.parseURL.mockImplementation((url) => {
      const source = url.includes('fast') ? 'Fast Source' : 'Slow Source';
      return Promise.resolve({
        items: [{ title: `Item from ${source}`, link: `${url}/item`, pubDate: '2026-08-27' }],
      });
    });
    setSources([
      { name: 'Fast Source', url: 'https://example.com/fast-feed', category: 'national', language: 'en' },
      { name: 'Slow Source', url: 'https://example.com/slow-feed', category: 'national', language: 'en' },
    ]);

    await fetchAllFeeds(new Set(['Fast Source']));

    const rows = db.prepare('SELECT * FROM articles').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('Fast Source');
    expect(Parser.prototype.parseURL).toHaveBeenCalledTimes(1);
    expect(Parser.prototype.parseURL).toHaveBeenCalledWith('https://example.com/fast-feed');
  });

  test('with no filter, fetches every registered source (unchanged default behavior)', async () => {
    Parser.prototype.parseURL.mockResolvedValue({
      items: [{ title: 'Item', link: 'https://example.com/item', pubDate: '2026-08-27' }],
    });
    setSources([
      { name: 'A', url: 'https://a.example.com/feed', category: 'national', language: 'en' },
      { name: 'B', url: 'https://b.example.com/feed', category: 'national', language: 'en' },
    ]);

    await fetchAllFeeds();

    expect(Parser.prototype.parseURL).toHaveBeenCalledTimes(2);
  });
});
