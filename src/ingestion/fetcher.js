const Parser = require('rss-parser');
const logger = require('../logger');
const parser = new Parser({
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail'],
    ],
  },
});
const db = require('../db');
const { getSources } = require('./source-registry');
const { toThumbnailUrl } = require('../services/image-thumbnail');
const { syncArticleFts } = require('../db/fts');

// See "URL normalization for dedup" in docs/fetcher.md.
const TRACKING_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'ref',
  'refresh',
];

function normalizeArticleUrl(url) {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    TRACKING_PARAMS.forEach((param) => parsed.searchParams.delete(param));
    parsed.hash = '';
    let normalized = parsed.toString();
    if (normalized.endsWith('/') && parsed.pathname !== '/') {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch {
    // Not a valid absolute URL - leave it as-is rather than dropping the item.
    return url;
  }
}

// See "NDTV Profit: per-article category from the URL path" in
// docs/fetcher.md.
const NDTV_PROFIT_FEED_URL = 'https://feeds.feedburner.com/ndtvprofit-latest';
const NDTV_PROFIT_PATH_CATEGORY = {
  markets: 'business',
  business: 'business',
  economy: 'business',
  lifestyle: 'lifestyle',
  india: 'india',
  technology: 'tech',
  world: 'world',
  trending: 'opinion',
};

function resolveArticleCategory(src, link) {
  if (src.url === NDTV_PROFIT_FEED_URL) {
    const match = /ndtvprofit\.com\/([a-z-]+)\//.exec(link);
    const section = match && NDTV_PROFIT_PATH_CATEGORY[match[1]];
    if (section) return section;
  }
  return src.category;
}

function extractImageUrl(item) {
  const url =
    item.enclosure?.url ||
    item.mediaContent?.[0]?.$?.url ||
    item.mediaThumbnail?.$?.url ||
    null;
  return toThumbnailUrl(url);
}

// Used by the ranking service (importance scoring) alongside the title -
// rss-parser's contentSnippet is already plain text, but the content/summary
// fallbacks can carry HTML, so strip tags for a clean signal either way.
function extractDescription(item) {
  const raw = item.contentSnippet || item.summary || item.content || null;
  if (!raw) return null;
  return raw.replace(/<[^>]+>/g, '').trim() || null;
}

const insert = db.prepare(`
  INSERT INTO articles (title, link, source, category, published_at, image_url, language, description)
  VALUES (@title, @link, @source, @category, @published_at, @image_url, @language, @description)
  ON CONFLICT(link) DO UPDATE SET image_url = excluded.image_url
    WHERE articles.image_url IS NULL AND excluded.image_url IS NOT NULL
`);
// link is UNIQUE, so this reliably finds the row insert.run() just touched
// whether it was a fresh INSERT or the ON CONFLICT UPDATE path above -
// insert.run()'s own lastInsertRowid isn't meaningful on that UPDATE path.
const findIdByLink = db.prepare('SELECT id FROM articles WHERE link = ?');

// See "fetchAllFeeds's sourceNameFilter" in docs/fetcher.md.
async function fetchAllFeeds(sourceNameFilter) {
  const allSources = getSources();
  const sources = sourceNameFilter
    ? allSources.filter((src) => sourceNameFilter.has(src.name))
    : allSources;
  for (const src of sources) {
    try {
      const feed = await parser.parseURL(src.url);
      for (const item of feed.items) {
        const link = normalizeArticleUrl(item.link || '');
        insert.run({
          // Found via Divya Bhaskar's feed, but not source-specific - any
          // publisher whose feed XML indents/wraps its <title> content
          // would hit the same thing, this just happened to be the first
          // one that did. extractDescription already trims; title never did.
          title: (item.title || '').trim(),
          link,
          source: src.name,
          category: resolveArticleCategory(src, link),
          published_at: item.pubDate || null,
          image_url: extractImageUrl(item),
          language: src.language || 'en',
          description: extractDescription(item),
        });
        const { id } = findIdByLink.get(link);
        syncArticleFts(id);
      }
      logger.info({ source: src.name, count: feed.items.length }, "fetched feed");
    } catch (err) {
      logger.error({ source: src.name, err: err.message }, "feed fetch failed");
    }
  }
}

module.exports = fetchAllFeeds;
module.exports.extractImageUrl = extractImageUrl;
module.exports.normalizeArticleUrl = normalizeArticleUrl;
module.exports.extractDescription = extractDescription;
module.exports.resolveArticleCategory = resolveArticleCategory;