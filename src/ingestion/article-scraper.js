const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');

// Many publishers lazy-load images: the <img src> is a tiny placeholder and
// the real URL lives in a data-* attribute (or only in a <picture><source>),
// swapped in by client-side JS that never runs during a server-side scrape.
// Rewrite those back to the real URL so a static HTML renderer shows them.
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

// Matches a formatted date in either day-first ("21 Dec 2025") or
// month-first ("Dec 21, 2025") order, or ISO ("2025-12-21") - used to
// recognize a byline/dateline element that combines the read time with one
// or more publish/update dates, which some publishers emit as a single long
// line rather than a short standalone one.
const MONTH_NAME = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?';
const DATE_LIKE_PATTERN = new RegExp(
  `\\b\\d{1,2}\\s+${MONTH_NAME}\\s+\\d{4}\\b` +
    `|\\b${MONTH_NAME}\\s+\\d{1,2},?\\s+\\d{4}\\b` +
    `|\\b\\d{4}-\\d{2}-\\d{2}\\b`,
  'i'
);

// The article's lead image is already shown as a hero above the title, so
// drop the first inline image here to avoid showing it twice. Climbs up
// through wrapper elements that contain nothing but that image (regardless
// of how deeply a given publisher nests <picture>/<figure> markup), then
// checks whether a caption paragraph immediately follows it.
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
    // A generic "under 220 chars" cutoff was too loose - plenty of real
    // article ledes are short too, and were being misidentified as photo
    // captions and shown as if they credited the (now-removed) image.
    // Require either an explicit credit keyword or genuinely caption-length
    // text (typical photo captions run well under 100 chars). Explicitly
    // excludes "N min read" text, which sometimes sits right where a
    // caption would (immediately after the lead image) - that belongs to
    // extractReadTime, not the caption.
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

// Some publishers' "N min read" byline text survives Readability's
// extraction as a short standalone element near the top of the body (rather
// than being stripped as page chrome). Pull it out so the frontend can show
// it as its own pill instead of leaving it as a stray line in the body text.
function extractReadTime(document) {
  // Readability's output is often wrapped in several container divs before
  // reaching the actual byline line, so the read-time text can end up
  // several elements deep even though it's still "near the top" - search by
  // tag instead of only body's direct children, in document order (which
  // visits a parent before its own children, so a combined byline
  // paragraph is matched and removed whole rather than leaving stray
  // fragments behind), and only look reasonably close to the top.
  const candidates = Array.from(document.querySelectorAll('p, div, span, li')).slice(0, 10);
  for (const el of candidates) {
    const text = el.textContent.trim().replace(/\s+/g, ' ');
    const match = text.match(READ_TIME_PATTERN);
    if (!match) continue;
    // Only treat this as leaked byline/meta text, not genuine article prose
    // that happens to mention a reading time - either a short standalone
    // line, or a longer byline/dateline combining the read time with one or
    // more publish/update dates (a strong signal it's page chrome, not
    // prose - real sentences essentially never contain two formatted dates).
    const looksLikeMetadata = text.length <= 60 || DATE_LIKE_PATTERN.test(text);
    if (looksLikeMetadata) {
      el.remove();
      return Number(match[1]);
    }
  }
  return null;
}

// Fetches an article's original page and extracts its main content (with
// inline images) via Readability - the same extraction Firefox Reader View
// and Pocket use. Returns null if the page can't be fetched or parsed.
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
