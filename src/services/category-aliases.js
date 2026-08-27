// Merges category spellings that differ across publishers, and consolidates
// the long tail of narrow/niche section feeds into a small set of ~10
// categories a general reader actually recognizes. See
// docs/category-taxonomy.md for the full reasoning, and for why this needs
// a one-time backfill whenever ALIASES changes.
const ALIASES = {
  sport: 'sports',
  technology: 'tech',
  'life & style': 'lifestyle',
  nri: 'business',
  markets: 'business',
  'market data': 'business',
  sme: 'business',
  mf: 'business',

  // -> india (domestic politics/governance/general national news formats)
  national: 'india',
  politics: 'india',
  governance: 'india',
  'political pulse': 'india',
  cities: 'india',
  'north east india': 'india',
  news: 'india',
  explained: 'india',
  // Hindi's "general news" feeds - see docs/category-taxonomy.md.
  'ताज़ा ख़बरें': 'देश',
  होम: 'देश',

  // -> world (foreign affairs)
  us: 'world',
  pakistan: 'world',

  // -> business (finance/markets sub-sections, already narrow enough that
  // splitting them further isn't worth a separate pill)
  industry: 'business',
  wealth: 'business',
  'personal finance': 'business',
  etprime: 'business',
  'top trending products': 'business',
  insurance: 'business',

  // Cricket deliberately NOT folded into "sports" - see
  // docs/category-taxonomy.md.

  // -> entertainment (feature/culture content, not hard news)
  magazines: 'entertainment',
  podcasts: 'entertainment',

  // -> tech (mirrors Dainik Bhaskar's own native "टेक-ऑटो" combination)
  ai: 'tech',
  auto: 'tech',
  'auto travel': 'tech',

  // -> lifestyle
  astrology: 'lifestyle',
  'health wellness': 'lifestyle',
  weather: 'lifestyle',

  // -> education
  careers: 'education',
  jobs: 'education',

  // -> science
  environment: 'science',

  // -> opinion - see docs/category-taxonomy.md.
  evergreen: 'opinion',
  'express exclusive': 'opinion',
  'express sunday eye': 'opinion',
  'fine reading': 'opinion',
  'how to': 'opinion',
  'idea exchange': 'opinion',
  'long reads': 'opinion',
  'puzzles and games': 'opinion',
  research: 'opinion',
  trending: 'opinion',
  'what is': 'opinion',
  'when is': 'opinion',
  'who is': 'opinion',

  // Same historical-cleanup situation as above, but these map to a real
  // topic bucket rather than opinion.
  'books and literature': 'lifestyle',
  'delhi confidential': 'india',
  'entertainment video': 'entertainment',
  fifa: 'sports',
  'good news': 'lifestyle',
  horoscope: 'lifestyle',
  'live news': 'india',
  'news briefs': 'india',
  'news today': 'india',
  'smart stocks': 'business',
  'upsc current affairs': 'education',
};

// See "HIDDEN_CATEGORIES" in docs/category-taxonomy.md.
const HIDDEN_CATEGORIES = new Set(['opinion', 'top stories']);

function normalizeCategory(rawName) {
  const key = rawName.trim().toLowerCase();
  return ALIASES[key] || key;
}

module.exports = { normalizeCategory, HIDDEN_CATEGORIES };
