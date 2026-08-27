const { scrapeArticle } = require('../ingestion/article-scraper');

const ARTICLE_HTML = `
<!DOCTYPE html>
<html>
  <head><title>Test Article</title></head>
  <body>
    <article>
      <h1>A Real Article Headline That Is Long Enough For Readability</h1>
      <img src="https://example.com/hero.jpg">
      <p>Photo Credit: Test Photographer</p>
      <p>${'This is the first real paragraph of the article body. '.repeat(6)}</p>
      <p>${'This is the second real paragraph of the article body. '.repeat(6)}</p>
    </article>
  </body>
</html>
`;

beforeEach(() => {
  global.fetch = jest.fn();
});

afterEach(() => {
  delete global.fetch;
});

describe('scrapeArticle', () => {
  test('returns null when the fetch response is not ok', async () => {
    global.fetch.mockResolvedValue({ ok: false });
    const result = await scrapeArticle('https://example.com/article');
    expect(result).toBeNull();
  });

  test('extracts content, strips the lead image, and captures its caption', async () => {
    global.fetch.mockResolvedValue({ ok: true, text: async () => ARTICLE_HTML });

    const result = await scrapeArticle('https://example.com/article');

    expect(result).not.toBeNull();
    expect(result.content).toContain('first real paragraph');
    expect(result.content).toContain('second real paragraph');
    // The lead image and its caption should have been stripped from the body.
    expect(result.content).not.toContain('<img');
    expect(result.imageCaption).toBe('Photo Credit: Test Photographer');
  });

  test('extracts and strips a leaked "N min read" byline near the top of the body', async () => {
    const htmlWithReadTime = `
      <!DOCTYPE html>
      <html>
        <head><title>Test Article</title></head>
        <body>
          <article>
            <h1>A Real Article Headline That Is Long Enough For Readability</h1>
            <p>3 min read</p>
            <p>${'This is the first real paragraph of the article body. '.repeat(6)}</p>
            <p>${'This is the second real paragraph of the article body. '.repeat(6)}</p>
          </article>
        </body>
      </html>
    `;
    global.fetch.mockResolvedValue({ ok: true, text: async () => htmlWithReadTime });

    const result = await scrapeArticle('https://example.com/article');

    expect(result.readTimeMinutes).toBe(3);
    expect(result.content).not.toContain('min read');
  });

  test('sends a browser-like User-Agent header', async () => {
    global.fetch.mockResolvedValue({ ok: true, text: async () => ARTICLE_HTML });

    await scrapeArticle('https://example.com/article');

    const [, options] = global.fetch.mock.calls[0];
    expect(options.headers['User-Agent']).toContain('Mozilla');
  });

  test('returns null when Readability cannot extract meaningful content', async () => {
    global.fetch.mockResolvedValue({ ok: true, text: async () => '<html><body></body></html>' });

    const result = await scrapeArticle('https://example.com/article');
    expect(result).toBeNull();
  });
});
