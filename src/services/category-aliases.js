// Merges category spellings that differ across publishers beyond case
// (e.g. The Hindu's "Sport" vs. Times of India's "Sports"), and consolidates
// the long tail of narrow/niche section feeds (etprime, political pulse,
// north east india, auto travel, ...) into a small set of ~10 categories a
// general reader actually recognizes (cricket kept split from general
// sports - popular enough in India to earn its own pill). Before this, the
// English pill list
// alone had grown to 37 distinct categories - genuinely unusable as a grid.
// Each of these still exists as its own RSS feed on some publisher's site
// (that's Stage 1's job to keep fetching, unaffected by this file), this
// only governs which top-level bucket its articles get filed under.
//
// This runs both at discovery time (new source registrations) and, when
// this map changes, needs a one-time backfill re-mapping every already-
// stored articles.category/stories.category value through this same
// function too - a stale alias here would silently make the live pill list
// and the historical backlog disagree on what "India" means. (Done once
// on 2026-08-27 via a throwaway script - not committed, per this repo's
// convention for one-off migrations.)
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
  // Hindi's three "general news" feeds (Amar Ujala's "ताज़ा ख़बरें", Aaj
  // Tak's generic "होम") are the same redundancy in a different language -
  // Dainik Bhaskar/NDTV Khabar's "देश" is the one kept as the category name.
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

  // Deliberately NOT folded into "sports" - cricket is popular enough in
  // India to warrant its own pill rather than being one sport lost among
  // football/tennis/Olympics coverage. Times of India already publishes a
  // dedicated "cricket" feed distinct from its general "sports" feed (see
  // ingestion/discovery.js), so this requires no extra source work - just
  // not merging what was already separate at the source.

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

  // -> opinion (folded into the already-hidden bucket rather than a real
  // topic, for the same reason opinion itself is hidden below: feature/
  // magazine/reference content isn't reliably about one topic, so filing it
  // under any single pill would misrepresent it). These are all sections
  // INDIAN_EXPRESS_EXCLUDED_SLUGS (ingestion/discovery.js) already stops
  // fetching new articles from - this only re-files the historical rows
  // that were ingested before that filter existed, so they stop dangling
  // as their own stray pills for anyone who queries by the old raw name.
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

// Categories that are hidden from the category pill list entirely, rather
// than merged into another one - e.g. "Opinion" doesn't share a topic with
// any other section (an op-ed can be about anything), so folding it into
// another bucket would misrepresent its articles. Hiding still only affects
// the pill list; the articles themselves are untouched and still show up
// under "All".
const HIDDEN_CATEGORIES = new Set(['opinion', 'top stories']);

function normalizeCategory(rawName) {
  const key = rawName.trim().toLowerCase();
  return ALIASES[key] || key;
}

module.exports = { normalizeCategory, HIDDEN_CATEGORIES };
