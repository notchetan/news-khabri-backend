const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');

// See "Lazy-loaded images" in docs/article-scraper.md.
const LAZY_SRC_ATTRS = ['data-original', 'data-src', 'data-lazy-src', 'data-lazy'];
const looksLikePlaceholder = (url) => !url || /spacer|blank|placeholder|1x1/i.test(url);

function fixLazyImages(document) {
  document.querySelectorAll('img').forEach((img) => {
    if (!looksLikePlaceholder(img.getAttribute('src'))) return;

    const candidates = LAZY_SRC_ATTRS.map((attr) => img.getAttribute(attr));

    const source = img.closest('picture')?.querySelector('source[srcset]');
    candidates.push(source?.getAttribute('srcset')?.split(',')[0]?.trim()?.split(' ')[0]);

    const real = candidates.find((url) => url && !looksLikePlaceholder(url));
    if (real) img.setAttribute('src', real);
  });
}

// Matches leaked "N min read" byline text - shared between stripLeadImage
// (so it's never swallowed as a photo caption) and extractReadTime (which
// actually pulls it out into its own field).
const READ_TIME_PATTERN = /(\d+)\s*min(?:ute)?s?\s*read/i;

// Matches a formatted date, day-first/month-first/ISO - see
// "Extracting leaked N min read byline text" in docs/article-scraper.md.
const MONTH_NAME = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?';
const DATE_LIKE_PATTERN = new RegExp(
  `\\b\\d{1,2}\\s+${MONTH_NAME}\\s+\\d{4}\\b` +
    `|\\b${MONTH_NAME}\\s+\\d{1,2},?\\s+\\d{4}\\b` +
    `|\\b\\d{4}-\\d{2}-\\d{2}\\b`,
  'i'
);

// See "Stripping the duplicate lead image" in docs/article-scraper.md.
function stripLeadImage(document) {
  const firstImg = document.querySelector('img');
  if (!firstImg) return null;

  let node = firstImg;
  while (
    node.parentElement &&
    node.parentElement !== document.body &&
    node.parentElement.textContent.trim() === node.textContent.trim()
  ) {
    node = node.parentElement;
  }

  const next = node.nextElementSibling;
  node.remove();

  if (next?.tagName === 'P') {
    const text = next.textContent.trim().replace(/\s+/g, ' ');
    const looksLikeCaption =
      !READ_TIME_PATTERN.test(text) &&
      (text.length <= 100 ||
        /photo|credit|image source|representational|file photo/i.test(text));
    if (text && looksLikeCaption) {
      next.remove();
      return text;
    }
  }

  return null;
}

// See "Extracting leaked N min read byline text" in docs/article-scraper.md.
function extractReadTime(document) {
  const candidates = Array.from(document.querySelectorAll('p, div, span, li')).slice(0, 10);
  for (const el of candidates) {
    const text = el.textContent.trim().replace(/\s+/g, ' ');
    const match = text.match(READ_TIME_PATTERN);
    if (!match) continue;
    const looksLikeMetadata = text.length <= 60 || DATE_LIKE_PATTERN.test(text);
    if (looksLikeMetadata) {
      el.remove();
      return Number(match[1]);
    }
  }
  return null;
}

// See docs/article-scraper.md.
async function scrapeArticle(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;

  const html = await res.text();
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const parsed = reader.parse();
  if (!parsed?.content) return null;

  const fragment = new JSDOM(`<body>${parsed.content}</body>`);
  const document = fragment.window.document;
  fixLazyImages(document);
  const imageCaption = stripLeadImage(document);
  const readTimeMinutes = extractReadTime(document);

  return {
    content: document.body.innerHTML,
    excerpt: parsed.excerpt || null,
    imageCaption,
    readTimeMinutes,
  };
}

module.exports = {
  scrapeArticle,
  fixLazyImages,
  stripLeadImage,
  looksLikePlaceholder,
  extractReadTime,
};
