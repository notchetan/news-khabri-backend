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

// See "Redirect resolution" in docs/source-discovery.md.
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

// See "Indian Express: an allowlist-shaped exclusion list" in
// docs/source-discovery.md.
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

// See "NDTV: manual fallback, scripted access blocked" in
// docs/source-discovery.md.
const NDTV_FALLBACK = [
  toEntry('NDTV', 'national', 'https://feeds.feedburner.com/ndtvnews-top-stories'),
  toEntry('NDTV', 'india', 'https://feeds.feedburner.com/ndtvnews-india-news'),
  toEntry('NDTV', 'world', 'https://feeds.feedburner.com/ndtvnews-world-news'),
  toEntry('NDTV', 'sports', 'https://feeds.feedburner.com/ndtvsports-latest'),
  toEntry('NDTV', 'entertainment', 'https://feeds.feedburner.com/ndtvmovies-latest'),
  toEntry('NDTV', 'tech', 'https://feeds.feedburner.com/gadgets360-latest'),
  toEntry('NDTV', 'business', 'https://feeds.feedburner.com/ndtvprofit-latest'),
];

// See "Hindi and Gujarati: manual fallbacks, unlabeled index pages" in
// docs/source-discovery.md.
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

const GUJARATI_FALLBACK = [
  toEntry('Divya Bhaskar', 'મારું ગુજરાત', 'https://www.divyabhaskar.co.in/rss-v1--category-1035.xml', 'gu'),
  toEntry('Divya Bhaskar', 'ઈન્ડિયા', 'https://www.divyabhaskar.co.in/rss-v1--category-1037.xml', 'gu'),
  toEntry('Divya Bhaskar', 'વર્લ્ડ', 'https://www.divyabhaskar.co.in/rss-v1--category-1038.xml', 'gu'),
  toEntry('Divya Bhaskar', 'બિઝનેસ', 'https://www.divyabhaskar.co.in/rss-v1--category-969.xml', 'gu'),
  toEntry('Divya Bhaskar', 'સ્પોર્ટ્સ', 'https://www.divyabhaskar.co.in/rss-v1--category-970.xml', 'gu'),
  toEntry('Divya Bhaskar', 'એન્ટરટેઇનમેન્ટ', 'https://www.divyabhaskar.co.in/rss-v1--category-12042.xml', 'gu'),
];

// See "Times Group's regional-language properties: one shared parser" in
// docs/source-discovery.md.
const REGIONAL_CATEGORY_PATTERNS = [
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

// See "Bengali, Malayalam, Odia: single combined-feed sources" in
// docs/source-discovery.md.
const BENGALI_FALLBACK = [
  toEntry('ABP Live', 'national', 'https://bengali.abplive.com/home/feed', 'bn'),
];

const KANNADA_FALLBACK = [toEntry('Prajavani', 'national', 'https://www.prajavani.net/feed', 'kn')];

const MALAYALAM_FALLBACK = [toEntry('Mathrubhumi', 'national', 'https://www.mathrubhumi.com/rss', 'ml')];

const ODIA_FALLBACK = [
  toEntry('OdishaTV', 'national', 'https://odishatv.in/feed', 'or'),
  toEntry('Pragativadi', 'national', 'https://www.pragativadi.com/feed', 'or'),
];

// See "BBC Sport: manual fallback, sports-only publisher" in
// docs/source-discovery.md.
const SPORTS_FALLBACK = [
  toEntry('BBC Sport', 'sports', 'https://feeds.bbci.co.uk/sport/rss.xml'),
  toEntry('BBC Sport', 'cricket', 'https://feeds.bbci.co.uk/sport/cricket/rss.xml'),
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
    ...SPORTS_FALLBACK,
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
