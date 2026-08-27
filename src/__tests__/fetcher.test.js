// fetcher.js requires db.js at load time (to prepare its INSERT statement) -
// point it at an in-memory database so tests never touch the real
// articles.db file, even though this suite doesn't exercise the DB directly.
process.env.DB_PATH = ':memory:';

const fetchAllFeeds = require('../ingestion/fetcher');
const { extractImageUrl, normalizeArticleUrl, extractDescription, resolveArticleCategory } =
  fetchAllFeeds;

describe('extractImageUrl', () => {
  test('prefers enclosure.url when present', () => {
    const item = {
      enclosure: { url: 'https://example.com/enclosure.jpg' },
      mediaContent: [{ $: { url: 'https://example.com/media.jpg' } }],
    };
    expect(extractImageUrl(item)).toBe('https://example.com/enclosure.jpg');
  });

  test('falls back to mediaContent[0] when no enclosure', () => {
    const item = { mediaContent: [{ $: { url: 'https://example.com/media.jpg' } }] };
    expect(extractImageUrl(item)).toBe('https://example.com/media.jpg');
  });

  test('falls back to mediaThumbnail when no enclosure or mediaContent', () => {
    const item = { mediaThumbnail: { $: { url: 'https://example.com/thumb.jpg' } } };
    expect(extractImageUrl(item)).toBe('https://example.com/thumb.jpg');
  });

  test('returns null when no image source is present anywhere', () => {
    expect(extractImageUrl({})).toBeNull();
  });

  test('applies thumbnail rewriting to the extracted URL (Indian Express)', () => {
    const item = { enclosure: { url: 'https://images.indianexpress.com/2026/photo.jpg' } };
    expect(extractImageUrl(item)).toBe('https://images.indianexpress.com/2026/photo.jpg?w=300');
  });

  test('handles a mediaContent array with more than one entry (uses the first)', () => {
    const item = {
      mediaContent: [
        { $: { url: 'https://example.com/first.jpg' } },
        { $: { url: 'https://example.com/second.jpg' } },
      ],
    };
    expect(extractImageUrl(item)).toBe('https://example.com/first.jpg');
  });
});

describe('extractDescription', () => {
  test('prefers contentSnippet when present', () => {
    const item = { contentSnippet: 'Plain snippet', summary: 'Summary', content: '<p>Content</p>' };
    expect(extractDescription(item)).toBe('Plain snippet');
  });

  test('falls back to summary, then content', () => {
    expect(extractDescription({ summary: 'Summary text' })).toBe('Summary text');
    expect(extractDescription({ content: 'Content text' })).toBe('Content text');
  });

  test('strips HTML tags from the fallback fields', () => {
    expect(extractDescription({ content: '<p>Hello <b>world</b></p>' })).toBe('Hello world');
  });

  test('returns null when nothing is present', () => {
    expect(extractDescription({})).toBeNull();
  });

  test('returns null rather than an empty string when the only content is markup with no text', () => {
    expect(extractDescription({ content: '<img src="x.jpg" />' })).toBeNull();
  });
});

describe('normalizeArticleUrl', () => {
  test('strips known tracking params', () => {
    expect(
      normalizeArticleUrl(
        'https://example.com/story?utm_source=rss&utm_medium=feed&id=42'
      )
    ).toBe('https://example.com/story?id=42');
  });

  test('strips a URL fragment', () => {
    expect(normalizeArticleUrl('https://example.com/story#comments')).toBe(
      'https://example.com/story'
    );
  });

  test('strips a trailing slash from the path', () => {
    expect(normalizeArticleUrl('https://example.com/story/')).toBe(
      'https://example.com/story'
    );
  });

  test('leaves a bare origin ("/") untouched', () => {
    expect(normalizeArticleUrl('https://example.com/')).toBe(
      'https://example.com/'
    );
  });

  test('two links differing only by tracking params normalize to the same URL', () => {
    const a = normalizeArticleUrl('https://example.com/story?utm_source=feed1');
    const b = normalizeArticleUrl('https://example.com/story?utm_source=feed2');
    expect(a).toBe(b);
  });

  test('leaves an already-clean URL unchanged', () => {
    expect(normalizeArticleUrl('https://example.com/story?id=42')).toBe(
      'https://example.com/story?id=42'
    );
  });

  test('returns falsy input as-is', () => {
    expect(normalizeArticleUrl('')).toBe('');
    expect(normalizeArticleUrl(null)).toBeNull();
  });

  test('returns a non-URL string unchanged instead of throwing', () => {
    expect(normalizeArticleUrl('not a url')).toBe('not a url');
  });
});

describe('resolveArticleCategory', () => {
  const ndtvProfitSrc = {
    name: 'NDTV',
    url: 'https://feeds.feedburner.com/ndtvprofit-latest',
    category: 'business',
  };

  test('every other source just uses its own registered category, unaffected', () => {
    const src = { name: 'Times of India', url: 'https://example.com/feed', category: 'sports' };
    expect(resolveArticleCategory(src, 'https://timesofindia.indiatimes.com/story')).toBe('sports');
  });

  test.each([
    ['https://www.ndtvprofit.com/markets/some-stock-story', 'business'],
    ['https://www.ndtvprofit.com/business/some-company-story', 'business'],
    ['https://www.ndtvprofit.com/economy/gdp-story', 'business'],
    ['https://www.ndtvprofit.com/lifestyle/some-wellness-story', 'lifestyle'],
    ['https://www.ndtvprofit.com/india/some-national-story', 'india'],
    ['https://www.ndtvprofit.com/technology/some-gadget-story', 'tech'],
    ['https://www.ndtvprofit.com/world/some-foreign-story', 'world'],
    ['https://www.ndtvprofit.com/trending/some-viral-story', 'opinion'],
  ])(
    'derives the real category from the NDTV Profit feed link\'s own path (%s -> %s)',
    (link, expectedCategory) => {
      expect(resolveArticleCategory(ndtvProfitSrc, link)).toBe(expectedCategory);
    }
  );

  test('falls back to the feed\'s registered category for an unrecognized NDTV Profit path', () => {
    expect(resolveArticleCategory(ndtvProfitSrc, 'https://www.ndtvprofit.com/some-new-section/story')).toBe(
      'business'
    );
  });

  test('falls back to the feed\'s registered category when the link is malformed/empty', () => {
    expect(resolveArticleCategory(ndtvProfitSrc, '')).toBe('business');
  });
});
