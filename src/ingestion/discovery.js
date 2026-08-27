const https = require('https');
const { normalizeCategory } = require('../services/category-aliases');

// Meta/utility feeds that aren't topical categories - alternate sort orders
// or whole-site aggregates duplicating a publisher's own flagship feed.
const NON_TOPICAL_NAMES = new Set([
  'most recent stories',
  'most read',
  'most shared',
  'most commented',
  'et home',
  'home',
]);

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
  });
}

// A cheap HEAD request (no body download) to resolve a single redirect hop -
// see discoverTimesGroupRegional's own comment for why this exists: some of
// these publishers' RSS index pages list a feed URL with no category slug in
// it at all (the slug only appears after a 301 to the real URL), so the
// slug this needs to categorize the feed isn't visible without resolving
// it once at discovery time. Resolves to the original url on any error, or
// if there's no redirect (registering the original url either way is
// correct in that case, not just a fallback).
function resolveRedirect(url) {
  return new Promise((resolve) => {
    const req = https.request(
      url,
      { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } },
      (res) => {
        const location = res.headers.location;
        if (!location) return resolve(url);
        try {
          resolve(new URL(location, url).toString());
        } catch {
          resolve(url);
        }
      }
    );
    req.on('error', () => resolve(url));
    req.end();
  });
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

// Guards against publisher-side markup bugs (a broken/unclosed href upstream
// can make the link-extraction regex swallow into unrelated page content).
function looksLikeFeedUrl(url) {
  return !url.includes('utm_source') && !url.includes('?');
}

function toEntry(publisher, rawCategory, url, language = 'en') {
  return {
    name: publisher,
    category: normalizeCategory(decodeEntities(rawCategory)),
    url: decodeEntities(url),
    language,
  };
}

async function discoverTimesOfIndia() {
  const html = await fetchHtml('https://timesofindia.indiatimes.com/rss.cms');
  const start = html.indexOf('Main Feeds');
  const end = html.indexOf('Sectionwise Feeds');
  const section = html.slice(start, end);
  const links = [...section.matchAll(/<a[^>]+href="([^"]*rssfeed[^"]*)"[^>]*id="[^"]*">([^<]+)<\/a>/gi)];
  return links
    .filter((m) => !NON_TOPICAL_NAMES.has(m[2].trim().toLowerCase()) && looksLikeFeedUrl(m[1]))
    .map((m) => toEntry('Times of India', m[2].trim(), m[1]));
}

async function discoverEconomicTimes() {
  const html = await fetchHtml('https://economictimes.indiatimes.com/rss.cms');
  const start = html.indexOf('Economic Times Main Feeds');
  const end = html.indexOf('Sectionwise Feeds');
  const section = html.slice(start, end);
  const links = [...section.matchAll(/<a[^>]+href="([^"]+)"[^>]*>(?:<span[^>]*><\/span>)?([^<]+)<\/a>/gi)];
  return links
    .filter((m) => !NON_TOPICAL_NAMES.has(m[2].trim().toLowerCase()) && looksLikeFeedUrl(m[1]))
    .map((m) => {
      const url = m[1].startsWith('http') ? m[1] : `https://economictimes.indiatimes.com${m[1]}`;
      return toEntry('Economic Times', m[2].trim(), url);
    });
}

async function discoverTheHindu() {
  const html = await fetchHtml('https://www.thehindu.com/rssfeeds/');
  const links = [...html.matchAll(/<ul class="double-border-top">\s*<li>\s*<a href="([^"]+)">([^<]+)<\/a>/gi)];
  const seen = new Set();
  const entries = [];
  for (const m of links) {
    const url = m[1].startsWith('http') ? m[1] : `https://www.thehindu.com${m[1]}`;
    const name = m[2].trim();
    if (seen.has(url) || NON_TOPICAL_NAMES.has(name.toLowerCase()) || !looksLikeFeedUrl(url)) continue;
    seen.add(url);
    entries.push(toEntry('The Hindu', name, url));
  }
  return entries;
}

function titleCase(slug) {
  return slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Indian Express's RSS index lists ~47 section feeds - far more than any
// other publisher (Times of India: 16, Economic Times: 17, The Hindu: 7) -
// because its page sections a story into much finer sub-splits than other
// sites' section structures do. Left unfiltered, this single publisher
// ends up as ~60% of the entire ingested article volume on raw feed-count
// alone, skewing the candidate pool for both ranking and clustering toward
// one publisher's editorial slicing regardless of any per-article scoring.
// This excludes sections that are either redundant sub-splits of a broader
// category already covered by another feed (fifa/olympics -> sports,
// smart-stocks -> business), reference/explainer content rather than news
// (how-to, what-is, when-is, who-is, upsc-current-affairs), or feature/
// gossip/filler content of the kind already penalized elsewhere in ranking
// (horoscope, puzzles-and-games, trending, good-news, deldi-confidential) -
// not a blanket cut, every substantively newsy section (politics, business,
// world, sports, entertainment, tech, health, education, ...) stays.
const INDIAN_EXPRESS_EXCLUDED_SLUGS = new Set([
  'books-and-literature',
  'delhi-confidential',
  'entertainment-video',
  'evergreen',
  'express-exclusive',
  'express-sunday-eye',
  'fifa',
  'fine-reading',
  'good-news',
  'horoscope',
  'how-to',
  'idea-exchange',
  'live-news',
  'long-reads',
  'news-briefs',
  'news-today',
  'olympics',
  'puzzles-and-games',
  'research',
  'smart-stocks',
  'trending',
  'upsc-current-affairs',
  'what-is',
  'when-is',
  'who-is',
]);

async function discoverIndianExpress() {
  const html = await fetchHtml('https://indianexpress.com/rss/');
  const links = [...html.matchAll(/href="(https:\/\/indianexpress\.com\/section\/([a-z0-9-]+)\/feed\/)"/gi)];
  const seen = new Set();
  const entries = [];
  for (const m of links) {
    const [, url, slug] = m;
    if (seen.has(slug) || INDIAN_EXPRESS_EXCLUDED_SLUGS.has(slug)) continue;
    seen.add(slug);
    entries.push(toEntry('Indian Express', titleCase(slug), url));
  }
  return entries;
}

// NDTV blocks scripted access to every RSS index path we tried, so its feed
// list can't be discovered - this stays a manual fallback.
// Same NDTV RSS-blocking limitation as the single top-stories feed above,
// but this was previously leaving NDTV at just 1 feed (167 articles) versus
// e.g. Times of India's 16 (935) or Indian Express's dozens - not because
// NDTV publishes less, but because only its single generic feed was ever
// being read. These category feed URLs were confirmed live and genuinely
// distinct (not aliases redirecting to the same underlying content) by
// fetching each directly and comparing item titles.
const NDTV_FALLBACK = [
  toEntry('NDTV', 'national', 'https://feeds.feedburner.com/ndtvnews-top-stories'),
  toEntry('NDTV', 'india', 'https://feeds.feedburner.com/ndtvnews-india-news'),
  toEntry('NDTV', 'world', 'https://feeds.feedburner.com/ndtvnews-world-news'),
  toEntry('NDTV', 'sports', 'https://feeds.feedburner.com/ndtvsports-latest'),
  toEntry('NDTV', 'entertainment', 'https://feeds.feedburner.com/ndtvmovies-latest'),
  toEntry('NDTV', 'tech', 'https://feeds.feedburner.com/gadgets360-latest'),
  toEntry('NDTV', 'business', 'https://feeds.feedburner.com/ndtvprofit-latest'),
];

// Hindi sources. Dainik Bhaskar's RSS index page (bhaskar.com/rss/) lists
// category feed URLs with no adjacent readable label (unlike the English
// publishers above), so these category names were identified by fetching
// each feed and reading its own <title> rather than scraped from a page -
// same manual-fallback situation as NDTV above, just for several feeds
// from one publisher instead of one feed each.
const HINDI_FALLBACK = [
  toEntry('NDTV Khabar', 'देश', 'https://feeds.feedburner.com/ndtvkhabar-latest', 'hi'),
  toEntry('Amar Ujala', 'ताज़ा ख़बरें', 'https://www.amarujala.com/rss/breaking-news.xml', 'hi'),
  toEntry('Aaj Tak', 'होम', 'https://www.aajtak.in/rssfeeds/?id=home', 'hi'),
  toEntry('Dainik Bhaskar', 'देश', 'https://www.bhaskar.com/rss-v1--category-1061.xml', 'hi'),
  toEntry('Dainik Bhaskar', 'बिजनेस', 'https://www.bhaskar.com/rss-v1--category-1051.xml', 'hi'),
  toEntry('Dainik Bhaskar', 'स्पोर्ट्स', 'https://www.bhaskar.com/rss-v1--category-1053.xml', 'hi'),
  toEntry('Dainik Bhaskar', 'विदेश', 'https://www.bhaskar.com/rss-v1--category-1125.xml', 'hi'),
  toEntry('Dainik Bhaskar', 'बॉलीवुड', 'https://www.bhaskar.com/rss-v1--category-11215.xml', 'hi'),
  toEntry('Dainik Bhaskar', 'टेक-ऑटो', 'https://www.bhaskar.com/rss-v1--category-5707.xml', 'hi'),
];

// Gujarati - the first source in a language beyond English/Hindi. Divya
// Bhaskar is the same publisher group/CMS as Dainik Bhaskar above (same
// rss-v1--category-N.xml URL shape, same manual category-identification
// situation - the index page's feed links carry no readable label, so each
// was fetched directly and identified by its own <title>). Only the
// genuinely newsy categories are included, same selectivity as the Indian
// Express filter above - Divya Bhaskar's index also lists a utility/
// how-to section, a religion/spirituality section, a general "Original"
// features section, a magazine section, and an NRI-specific section, none
// of which made the cut there either.
const GUJARATI_FALLBACK = [
  toEntry('Divya Bhaskar', 'મારું ગુજરાત', 'https://www.divyabhaskar.co.in/rss-v1--category-1035.xml', 'gu'),
  toEntry('Divya Bhaskar', 'ઈન્ડિયા', 'https://www.divyabhaskar.co.in/rss-v1--category-1037.xml', 'gu'),
  toEntry('Divya Bhaskar', 'વર્લ્ડ', 'https://www.divyabhaskar.co.in/rss-v1--category-1038.xml', 'gu'),
  toEntry('Divya Bhaskar', 'બિઝનેસ', 'https://www.divyabhaskar.co.in/rss-v1--category-969.xml', 'gu'),
  toEntry('Divya Bhaskar', 'સ્પોર્ટ્સ', 'https://www.divyabhaskar.co.in/rss-v1--category-970.xml', 'gu'),
  toEntry('Divya Bhaskar', 'એન્ટરટેઇનમેન્ટ', 'https://www.divyabhaskar.co.in/rss-v1--category-12042.xml', 'gu'),
];

// Times Group runs the exact same publishing platform behind several
// regional-language properties (Vijay Karnataka/Kannada, Maharashtra
// Times/Marathi, and the Samayam network for Tamil/Telugu/Malayalam) as
// timesofindia.indiatimes.com/economictimes.indiatimes.com above - an
// RSS-index page listing every section feed, just a newer HTML template
// (`class="rss-page__feed-item"` + a `title` attribute, not the older
// `id`-based one those two use) - so one shared parser below handles all
// five instead of five bespoke ones.
//
// Each property lists dozens of section feeds (88 for Vijay Karnataka, 34
// for Maharashtra Times when checked) - overwhelmingly hyper-local
// district/city editions (Yadgir, Udupi, Kolhapur, Thane, ...), the same
// over-representation risk INDIAN_EXPRESS_EXCLUDED_SLUGS above exists to
// avoid. REGIONAL_CATEGORY_PATTERNS is deliberately an allowlist rather than
// a denylist, since there are far more sections to exclude than to keep
// here. It matches against the English URL *slug* each feed's link carries
// (.../india-news/rssfeed/12345.xml), not the page's own native-script
// display text - confident, since it's plain English, rather than a manual
// translation of dozens of native-script section names per language nobody
// on this project reads fluently enough to verify.
//
// Substring patterns, not exact slug equality: the same topic isn't spelled
// the same way across these five properties (Vijay Karnataka uses bare
// "india"; Maharashtra Times uses "india-news"), and guessing every
// property's exact spelling in advance isn't reliable - a pattern that
// matches on the recognizable word inside the slug is.
const REGIONAL_CATEGORY_PATTERNS = [
  // World/international checked first, and \b-bounded on "national" - a
  // bare /national/ substring match would also fire on "international"
  // (inter-national), miscategorizing world news as india. Found by
  // actually running this against real Maharashtra Times data, not
  // guessed - .../international/rssfeed/... was landing under "india".
  [/\bworld\b|\binternational\b/, 'world'],
  [/\bindia\b|\bnational\b/, 'india'],
  [/cricket/, 'cricket'],
  [/sport/, 'sports'],
  [/business|market|finance/, 'business'],
  [/entertain|movie|film/, 'entertainment'],
  [/tech/, 'tech'],
  [/education/, 'education'],
  [/lifestyle/, 'lifestyle'],
];

function categoryForRegionalSlug(slug) {
  const match = REGIONAL_CATEGORY_PATTERNS.find(([pattern]) => pattern.test(slug));
  return match ? match[1] : null;
}

// Some of these properties' index pages list a feed URL with no category
// slug in it at all - the slug only appears after a 301 redirect to the
// real URL (confirmed for Maharashtra Times: every link on its /rss page is
// bare .../rssfeed/N.xml, redirecting to .../maharashtra/pune-news/rssfeed/
// N.xml). resolveRedirect follows that hop once per candidate feed so the
// slug this needs to categorize it is actually visible; a property whose
// links already carry the slug directly (Vijay Karnataka) just resolves to
// itself, a harmless extra HEAD request during this once-daily discovery
// pass.
async function discoverTimesGroupRegional(publisher, language, rssIndexUrl) {
  const html = await fetchHtml(rssIndexUrl);
  const links = [...html.matchAll(/<a[^>]+href="([^"]*rssfeed[^"]*)"[^>]*title="[^"]*"/gi)];
  const seen = new Set();
  const resolved = await Promise.all(
    links.map(async (m) => {
      const rawUrl = m[1].startsWith('http') ? m[1] : `https://${rssIndexUrl.split('/')[2]}${m[1]}`;
      if (!looksLikeFeedUrl(rawUrl)) return null;
      return resolveRedirect(rawUrl);
    })
  );

  const entries = [];
  for (const url of resolved) {
    if (!url || seen.has(url)) continue;
    const slugMatch = /\/([a-z0-9-]+)\/rssfeed\//.exec(url);
    const category = slugMatch && categoryForRegionalSlug(slugMatch[1]);
    if (!category) continue;
    seen.add(url);
    entries.push(toEntry(publisher, category, url, language));
  }
  return entries;
}

const REGIONAL_LANGUAGE_PROPERTIES = [
  { publisher: 'Vijay Karnataka', language: 'kn', rssIndexUrl: 'https://vijaykarnataka.com/rss' },
  { publisher: 'Maharashtra Times', language: 'mr', rssIndexUrl: 'https://maharashtratimes.com/rss' },
  { publisher: 'Samayam Tamil', language: 'ta', rssIndexUrl: 'https://tamil.samayam.com/rss' },
  { publisher: 'Samayam Telugu', language: 'te', rssIndexUrl: 'https://telugu.samayam.com/rss' },
  { publisher: 'Samayam Malayalam', language: 'ml', rssIndexUrl: 'https://malayalam.samayam.com/rss' },
];

// Bengali, Malayalam, and Odia sources that publish one combined "home"
// feed rather than per-category ones (same 'national' -> 'india' alias
// path Amar Ujala/NDTV's own general feeds already use, see
// services/category-aliases.js). Verified live and legitimate, not scraped
// programmatically - see the RSS-source-discovery research this was based
// on: ABP Live (Bengali) and Mathrubhumi/Manorama-adjacent Malayalam
// coverage already exists via Samayam Malayalam above, this adds
// Mathrubhumi as a second Malayalam source. Anandabazar Patrika, Zee
// Bengali, and Lokmat were checked and found to sit behind bot-blocking
// WAFs that reject scripted requests entirely (not just this discovery
// script - a real risk for the production fetcher too) - excluded rather
// than registered and silently failing every fetch.
const BENGALI_FALLBACK = [
  toEntry('ABP Live', 'national', 'https://bengali.abplive.com/home/feed', 'bn'),
];

const KANNADA_FALLBACK = [toEntry('Prajavani', 'national', 'https://www.prajavani.net/feed', 'kn')];

const MALAYALAM_FALLBACK = [toEntry('Mathrubhumi', 'national', 'https://www.mathrubhumi.com/rss', 'ml')];

const ODIA_FALLBACK = [
  toEntry('OdishaTV', 'national', 'https://odishatv.in/feed', 'or'),
  toEntry('Pragativadi', 'national', 'https://www.pragativadi.com/feed', 'or'),
];

async function discoverAllSources() {
  const scrapers = [discoverTimesOfIndia, discoverEconomicTimes, discoverTheHindu, discoverIndianExpress];
  const regionalScrapers = REGIONAL_LANGUAGE_PROPERTIES.map(
    ({ publisher, language, rssIndexUrl }) =>
      () => discoverTimesGroupRegional(publisher, language, rssIndexUrl)
  );
  const allScrapers = [...scrapers, ...regionalScrapers];
  const results = await Promise.allSettled(allScrapers.map((fn) => fn()));

  const discovered = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      discovered.push(...r.value);
    } else {
      const label = i < scrapers.length ? allScrapers[i].name : REGIONAL_LANGUAGE_PROPERTIES[i - scrapers.length].publisher;
      console.error(`Discovery failed for ${label}:`, r.reason.message);
    }
  });

  return [
    ...discovered,
    ...NDTV_FALLBACK,
    ...HINDI_FALLBACK,
    ...GUJARATI_FALLBACK,
    ...BENGALI_FALLBACK,
    ...KANNADA_FALLBACK,
    ...MALAYALAM_FALLBACK,
    ...ODIA_FALLBACK,
  ];
}

module.exports = {
  discoverAllSources,
  discoverTimesGroupRegional,
  decodeEntities,
  looksLikeFeedUrl,
  toEntry,
  titleCase,
};
