const Parser = require('rss-parser');
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

// A publisher can list the same story more than once (e.g. once per
// category feed it belongs to) with only tracking params or a trailing
// slash differing between the links - normalize those away before they're
// used as the dedup key, or the `link` UNIQUE constraint won't catch them
// and the same article shows up twice.
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

// NDTV Profit's "latest" feed (see ingestion/discovery.js's NDTV_FALLBACK)
// isn't purely business content the way its feed URL/name implies - it's
// everything ndtvprofit.com publishes, including a lifestyle/trending
// section. Found by tracing real "why is this eclipse/movie-review article
// filed under Business" reports back to this feed: ~40% of what it
// contributed to "business" wasn't business at all. ndtvprofit.com's own
// URLs already encode which section an article is actually in
// (ndtvprofit.com/markets/..., /lifestyle/..., /trending/...), so this
// derives the real category per-article from that path instead of the one
// blanket label the feed registration gives every item.
const NDTV_PROFIT_FEED_URL = 'https://feeds.feedburner.com/ndtvprofit-latest';
const NDTV_PROFIT_PATH_CATEGORY = {
  markets: 'business',
  business: 'business',
  economy: 'business',
  lifestyle: 'lifestyle',
  india: 'india',
  technology: 'tech',
  world: 'world',
  // A trending/viral aggregation section, same as Indian Express's own
  // "trending" section elsewhere in this app - not a topic in itself, see
  // services/category-aliases.js's ALIASES for the same fold there.
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

// sourceNameFilter is an optional Set<string> of publisher names (matching
// each source's `name`, see ingestion/discovery.js's toEntry) - when given,
// only feeds belonging to one of those publishers are fetched. Used by
// index.js to run each refresh tier (ingestion/tier-tracker.js) on its own
// cron schedule instead of always fetching every registered feed. Omitted
// entirely (undefined), this fetches everything, same as before tiering
// existed - the 3am full-rediscovery pass still wants that.
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
      }
      console.log(`Fetched ${feed.items.length} from ${src.name}`);
    } catch (err) {
      console.error(`Failed to fetch ${src.name}:`, err.message);
    }
  }
}

module.exports = fetchAllFeeds;
module.exports.extractImageUrl = extractImageUrl;
module.exports.normalizeArticleUrl = normalizeArticleUrl;
module.exports.extractDescription = extractDescription;
module.exports.resolveArticleCategory = resolveArticleCategory;