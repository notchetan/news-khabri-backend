const { decodeEntities, looksLikeFeedUrl, toEntry, titleCase } = require('../ingestion/discovery');

describe('decodeEntities', () => {
  test('decodes common HTML entities', () => {
    expect(decodeEntities('Q&amp;A')).toBe('Q&A');
    expect(decodeEntities('It&#39;s')).toBe("It's");
    expect(decodeEntities('It&#039;s')).toBe("It's");
    expect(decodeEntities('&quot;quoted&quot;')).toBe('"quoted"');
    expect(decodeEntities('a &lt; b &gt; c')).toBe('a < b > c');
    expect(decodeEntities('a&nbsp;b')).toBe('a b');
  });

  test('leaves plain text unchanged', () => {
    expect(decodeEntities('Sports')).toBe('Sports');
  });
});

describe('looksLikeFeedUrl', () => {
  test('rejects URLs with a utm_source tracking param', () => {
    expect(looksLikeFeedUrl('https://example.com/feed?utm_source=rss')).toBe(false);
  });

  test('rejects URLs with any query string', () => {
    expect(looksLikeFeedUrl('https://example.com/feed?x=1')).toBe(false);
  });

  test('accepts a clean feed URL', () => {
    expect(looksLikeFeedUrl('https://example.com/section/sports/feed/')).toBe(true);
  });
});

describe('toEntry', () => {
  test('builds an entry with normalized category and decoded fields', () => {
    expect(toEntry('The Hindu', 'Sport', 'https://example.com/feed?a=1&amp;b=2')).toEqual({
      name: 'The Hindu',
      category: 'sports',
      url: 'https://example.com/feed?a=1&b=2',
      language: 'en',
    });
  });

  test('defaults language to "en" when not given', () => {
    expect(toEntry('NDTV', 'national', 'https://example.com/feed').language).toBe('en');
  });

  test('accepts an explicit language', () => {
    expect(toEntry('NDTV Khabar', 'देश', 'https://example.com/feed', 'hi').language).toBe('hi');
  });
});

describe('titleCase', () => {
  test('title-cases a hyphenated slug', () => {
    expect(titleCase('web-series')).toBe('Web Series');
  });

  test('handles a single-word slug', () => {
    expect(titleCase('sports')).toBe('Sports');
  });
});
