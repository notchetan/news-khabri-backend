jest.mock('https');
const https = require('https');

function mockHtmlResponse(mapUrlToHtml) {
  https.get.mockImplementation((url, options, callback) => {
    const html = mapUrlToHtml(url);
    const listeners = {};
    const res = {
      on: (event, handler) => {
        listeners[event] = handler;
        return res;
      },
    };
    callback(res);
    // Simulate the chunked data event(s) then end, synchronously-ish via microtask.
    Promise.resolve().then(() => {
      listeners.data(html);
      listeners.end();
    });
    return { on: () => {} };
  });
}

// https.request (HEAD, used to resolve a redirect) - mapUrlToLocation
// returns a Location header value, or null/undefined for "no redirect".
function mockHeadRedirect(mapUrlToLocation) {
  https.request.mockImplementation((url, options, callback) => {
    const location = mapUrlToLocation(url);
    callback({ headers: location ? { location } : {} });
    return { on: () => {}, end: () => {} };
  });
}

// Re-require discovery fresh per test file run (jest.mock above is hoisted,
// so this picks up the mocked https from the start).
const {
  discoverAllSources,
  discoverTimesGroupRegional,
} = require('../ingestion/discovery');

describe('discovery scrapers (network mocked)', () => {
  test('discoverAllSources parses Times of India style markup for at least one topical feed', async () => {
    mockHtmlResponse((url) => {
      if (url.includes('timesofindia')) {
        return `
          Main Feeds
          <a href="https://timesofindia.indiatimes.com/rssfeedstopstories.cms" id="1">Top Stories</a>
          <a href="https://timesofindia.indiatimes.com/rssfeedmostshared.cms" id="2">Most Shared</a>
          Sectionwise Feeds
        `;
      }
      return 'Main Feeds Sectionwise Feeds'; // empty section for the other scrapers
    });

    const sources = await discoverAllSources();
    const toi = sources.filter((s) => s.name === 'Times of India');

    expect(toi.some((s) => s.category === 'top stories')).toBe(true);
    // "Most Shared" is in the non-topical exclusion list and must be filtered out.
    expect(toi.some((s) => s.category === 'most shared')).toBe(false);
  });

  test('discoverAllSources parses Economic Times markup, resolving relative URLs', async () => {
    mockHtmlResponse((url) => {
      if (url.includes('economictimes')) {
        return `
          Economic Times Main Feeds
          <a href="/markets/rssfeeds/1977021501.cms"><span></span>Markets</a>
          <a href="https://economictimes.indiatimes.com/rssfeedsdefault.cms">Top Stories</a>
          Sectionwise Feeds
        `;
      }
      return 'Main Feeds Sectionwise Feeds';
    });

    const sources = await discoverAllSources();
    const et = sources.filter((s) => s.name === 'Economic Times');

    // "Markets" is folded into "business" by category-aliases.js - see
    // that file's ALIASES map.
    expect(et).toContainEqual(
      expect.objectContaining({
        category: 'business',
        url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms',
      })
    );
    expect(et).toContainEqual(
      expect.objectContaining({
        category: 'top stories',
        url: 'https://economictimes.indiatimes.com/rssfeedsdefault.cms',
      })
    );
  });

  test('discoverAllSources parses The Hindu style markup', async () => {
    mockHtmlResponse((url) => {
      if (url.includes('thehindu.com/rssfeeds')) {
        return `<ul class="double-border-top"><li><a href="/news/national/feeder/default.rss">National</a></li></ul>`;
      }
      return 'Main Feeds Sectionwise Feeds';
    });

    const sources = await discoverAllSources();
    const hindu = sources.filter((s) => s.name === 'The Hindu');
    // "National" normalizes to "india" - see category-aliases.js's
    // consolidation of the long tail of near-synonymous national-news
    // category names.
    expect(hindu).toContainEqual(
      expect.objectContaining({
        category: 'india',
        url: 'https://www.thehindu.com/news/national/feeder/default.rss',
      })
    );
  });

  test('discoverAllSources parses Indian Express section-feed links and de-dupes by slug', async () => {
    mockHtmlResponse((url) => {
      if (url.includes('indianexpress.com/rss')) {
        return `
          <a href="https://indianexpress.com/section/sports/feed/">x</a>
          <a href="https://indianexpress.com/section/sports/feed/">duplicate</a>
          <a href="https://indianexpress.com/section/business/feed/">y</a>
        `;
      }
      return 'Main Feeds Sectionwise Feeds';
    });

    const sources = await discoverAllSources();
    const ie = sources.filter((s) => s.name === 'Indian Express');
    expect(ie).toHaveLength(2);
    expect(ie.map((s) => s.category).sort()).toEqual(['business', 'sports']);
  });

  test('discoverAllSources excludes Indian Express sections that are redundant/filler, not genuine news categories', async () => {
    mockHtmlResponse((url) => {
      if (url.includes('indianexpress.com/rss')) {
        return `
          <a href="https://indianexpress.com/section/sports/feed/">x</a>
          <a href="https://indianexpress.com/section/horoscope/feed/">y</a>
          <a href="https://indianexpress.com/section/puzzles-and-games/feed/">z</a>
          <a href="https://indianexpress.com/section/fifa/feed/">w</a>
        `;
      }
      return 'Main Feeds Sectionwise Feeds';
    });

    const sources = await discoverAllSources();
    const ie = sources.filter((s) => s.name === 'Indian Express');
    // sports (a genuine section) stays; horoscope/puzzles-and-games/fifa
    // (filler or redundant with sports) are filtered at discovery time so
    // this one publisher's page structure doesn't get to inflate its own
    // ingested volume with sections no other publisher's feed list has an
    // equivalent of.
    expect(ie.map((s) => s.category)).toEqual(['sports']);
  });

  test('discoverAllSources still returns fallback sources when every scraper fails', async () => {
    https.get.mockImplementation(() => {
      throw new Error('network down');
    });

    const sources = await discoverAllSources();
    // NDTV + Hindi fallbacks are static, not scraped, so they should survive
    // even a total scraping outage.
    expect(sources.some((s) => s.name === 'NDTV')).toBe(true);
    expect(sources.some((s) => s.name === 'NDTV Khabar')).toBe(true);
    expect(sources.filter((s) => s.language === 'hi').length).toBeGreaterThan(0);
  });

  test('discoverAllSources always includes the manual NDTV and Hindi fallback sources', async () => {
    mockHtmlResponse(() => 'Main Feeds Sectionwise Feeds');

    const sources = await discoverAllSources();
    expect(sources).toContainEqual(
      expect.objectContaining({ name: 'NDTV', category: 'india', language: 'en' })
    );
    expect(sources.filter((s) => s.name === 'Dainik Bhaskar').length).toBe(6);
  });

  test('NDTV fallback covers multiple categories, not just a single generic feed', async () => {
    mockHtmlResponse(() => 'Main Feeds Sectionwise Feeds');

    const sources = await discoverAllSources();
    const ndtv = sources.filter((s) => s.name === 'NDTV');
    // Previously just 1 (the generic top-stories feed) - RSS discovery
    // doesn't work for NDTV's own index page, so category coverage has to
    // be hand-mapped the same way Dainik Bhaskar's is above.
    expect(ndtv.length).toBeGreaterThan(1);
    expect(ndtv.map((s) => s.category)).toEqual(
      expect.arrayContaining(['world', 'sports', 'business', 'entertainment'])
    );
  });

  test('discoverAllSources always includes the new regional-language fallback sources', async () => {
    mockHtmlResponse(() => 'Main Feeds Sectionwise Feeds');

    const sources = await discoverAllSources();
    expect(sources).toContainEqual(
      expect.objectContaining({ name: 'ABP Live', language: 'bn' })
    );
    expect(sources).toContainEqual(
      expect.objectContaining({ name: 'Prajavani', language: 'kn' })
    );
    expect(sources).toContainEqual(
      expect.objectContaining({ name: 'Mathrubhumi', language: 'ml' })
    );
    expect(sources.filter((s) => s.language === 'or').length).toBe(2);
  });
});

describe('discoverTimesGroupRegional (Vijay Karnataka / Maharashtra Times / Samayam network)', () => {
  test('keeps a feed whose href already carries an allowlisted category slug', async () => {
    mockHtmlResponse(
      () => `
        <a href="https://vijaykarnataka.com/news/india/rssfeed/111.xml" target="_blank" rel="noopener" class="rss-page__feed-item" title="ದೇಶ">ದೇಶ</a>
      `
    );
    mockHeadRedirect(() => null); // no redirect - slug is already in the href

    const entries = await discoverTimesGroupRegional('Vijay Karnataka', 'kn', 'https://vijaykarnataka.com/rss');

    expect(entries).toEqual([
      expect.objectContaining({
        name: 'Vijay Karnataka',
        category: 'india',
        language: 'kn',
        url: 'https://vijaykarnataka.com/news/india/rssfeed/111.xml',
      }),
    ]);
  });

  test('resolves a redirect to find the category slug when the href has none', async () => {
    mockHtmlResponse(
      () => `
        <a href="https://maharashtratimes.com//rssfeed/222.xml" target="_blank" rel="noopener" class="rss-page__feed-item" title="देश बातम्या">देश बातम्या</a>
      `
    );
    mockHeadRedirect(() => 'https://maharashtratimes.com/india-news/rssfeed/222.xml');

    const entries = await discoverTimesGroupRegional('Maharashtra Times', 'mr', 'https://maharashtratimes.com/rss');

    expect(entries).toEqual([
      expect.objectContaining({
        name: 'Maharashtra Times',
        category: 'india',
        language: 'mr',
        url: 'https://maharashtratimes.com/india-news/rssfeed/222.xml',
      }),
    ]);
  });

  test('excludes a feed whose resolved slug is not on the allowlist (e.g. a hyper-local district edition)', async () => {
    mockHtmlResponse(
      () => `
        <a href="https://vijaykarnataka.com/news/yadgir/rssfeed/333.xml" target="_blank" rel="noopener" class="rss-page__feed-item" title="ಯಾದಗಿರಿ">ಯಾದಗಿರಿ</a>
        <a href="https://vijaykarnataka.com/news/india/rssfeed/111.xml" target="_blank" rel="noopener" class="rss-page__feed-item" title="ದೇಶ">ದೇಶ</a>
      `
    );
    mockHeadRedirect(() => null);

    const entries = await discoverTimesGroupRegional('Vijay Karnataka', 'kn', 'https://vijaykarnataka.com/rss');

    expect(entries).toHaveLength(1);
    expect(entries[0].category).toBe('india');
  });

  test('categorizes an "international" slug as world, not india (a bare substring match on "national" would wrongly fire)', async () => {
    mockHtmlResponse(
      () => `
        <a href="https://maharashtratimes.com/international/rssfeed/444.xml" target="_blank" rel="noopener" class="rss-page__feed-item" title="जागतिक">जागतिक</a>
      `
    );
    mockHeadRedirect(() => null);

    const entries = await discoverTimesGroupRegional('Maharashtra Times', 'mr', 'https://maharashtratimes.com/rss');

    expect(entries).toHaveLength(1);
    expect(entries[0].category).toBe('world');
  });

  test('does not throw and returns an empty array when the index page has no feed links', async () => {
    mockHtmlResponse(() => 'nothing here');

    const entries = await discoverTimesGroupRegional('Vijay Karnataka', 'kn', 'https://vijaykarnataka.com/rss');

    expect(entries).toEqual([]);
  });
});
