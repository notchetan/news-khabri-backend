// Every tunable knob for Stage 1 ranking lives here so the scoring logic in
// ranking.js never hardcodes a number - tune freshness decay, the
// importance/freshness/sourceAuthority mix, or add a new source's authority
// without touching the scoring code itself.

// The divisor in exp(-ageInHours / FRESHNESS_DECAY_HOURS) - smaller values
// make freshness fall off faster. 12 means a 12-hour-old article has decayed
// to ~37% freshness (1/e).
const FRESHNESS_DECAY_HOURS = 12;

// Must stay roughly summing to 1 for the final score to land in [0, 1], but
// nothing enforces that mechanically - these are just relative weights.
// importance leads (was 0.35) and freshness was cut back (was 0.4) after
// real /stories/top data showed the previous balance meant "whatever was
// published in the last 20 minutes" beat genuinely more significant but
// slightly older stories almost every time - freshness should break ties
// among similarly-important stories, not override importance outright.
const RANKING_WEIGHTS = {
  importance: 0.5,
  freshness: 0.25,
  sourceAuthority: 0.25,
};

// A relatively small signal by design (RANKING_WEIGHTS.sourceAuthority is
// the smallest of the three) - reflects each source's general editorial
// reach/reliability, not a judgment on any single article. Add an entry
// here for each new source as it's onboarded; anything missing falls back
// to DEFAULT_SOURCE_AUTHORITY.
const SOURCE_AUTHORITY = {
  'Times of India': 0.8,
  'The Hindu': 0.9,
  'Economic Times': 0.85,
  'Indian Express': 0.8,
  // NDTV (English) had no entry here at all before it went from 1 feed to
  // 7 - every one of its articles was silently falling back to
  // DEFAULT_SOURCE_AUTHORITY. Tiered with Times of India/Indian Express,
  // matching its comparable standing as a major national English outlet.
  NDTV: 0.8,
  'NDTV Khabar': 0.75,
  'Aaj Tak': 0.7,
  'Amar Ujala': 0.65,
  'Dainik Bhaskar': 0.65,
  'Divya Bhaskar': 0.65,
};
const DEFAULT_SOURCE_AUTHORITY = 0.5;

// Rule-based importance signal - every article starts at IMPORTANCE_BASELINE
// and each matching keyword nudges the score up or down. Deliberately just
// keyword lists (no ML/embeddings) so it stays explainable and easy to
// extend by editing this list.
const IMPORTANCE_BASELINE = 0.5;

const IMPORTANCE_BOOST_KEYWORDS = [
  // Political/government
  'election', 'government', 'parliament', 'president', 'prime minister',
  'cabinet', 'court', 'supreme court', 'verdict', 'law', 'policy',
  // War/conflict
  'war', 'conflict', 'attack', 'military', 'strike', 'troops', 'ceasefire',
  'killed', 'casualties', 'terror',
  // Natural disasters
  'earthquake', 'flood', 'cyclone', 'disaster', 'wildfire', 'landslide',
  'tsunami', 'evacuate',
  // Economic/financial - deliberately only genuinely national-scale economic
  // signals. Generic financial vocabulary ('crore', 'billion', 'trillion',
  // bare 'stock market') used to be in this list and fired on nearly every
  // routine company-level markets story (any stock report mentions rupee
  // amounts in crore), not just significant ones - see
  // IMPORTANCE_PENALIZE_PATTERNS below for the complementary fix targeting
  // that same class of story directly.
  'rbi', 'inflation', 'recession', 'market crash', 'gdp',
  'interest rate', 'budget',
  // Major corporate
  'acquisition', 'merger', 'ipo', 'bankruptcy', 'layoffs', 'ceo resigns',
  // Major tech
  'breakthrough', 'launch', 'unveils', 'ai model', 'chip',
  // Major sports
  'world cup', 'olympics', 'final', 'championship', 'gold medal',
  // Deaths of public figures
  'dies', 'death', 'passes away', 'obituary',
];

const IMPORTANCE_PENALIZE_KEYWORDS = [
  'opinion', 'editorial', 'column', 'horoscope', 'astrology', 'recipe',
  'celebrity', 'gossip', 'style', 'fashion trend', 'listicle',
  'top 10', 'top 5', 'things you', 'you won’t believe', 'life hacks',
  'announces partnership', 'announces collaboration',
  // Inspirational/filler content - found via real ranking data: a "proverb
  // of the day" piece scored a neutral 0.5 (no boost, no penalty) and rode
  // freshness alone into the top 20 alongside genuine breaking news.
  'proverb', 'quote of the day', 'thought for the day', 'motivational',
  'motivational quote', 'life lesson', 'moral of the story', 'zen story',
  'inspirational story', 'did you know',
];

// Single-company stock-price-movement stories ("XYZ shares surge 14% after
// ...", "ABC stock jumps 8% on ...") - routine, narrow-audience financial
// news (one company's share price, not the wider economy) that nonetheless
// reads as "important" to a keyword scanner since it's full of numbers and
// financial vocabulary. Distinguished from a genuinely broad market move by
// phrasing convention: a whole-market story is normally reported around an
// index ("Sensex tumbles 1,000 points", "Nifty falls 2%"), not "shares" -
// this pattern only fires on the individual-company phrasing, so
// market-wide news keeps its 'market crash' boost above untouched. Found by
// tracing the actual #1 /stories/top result to a single Economic Times
// "shares surge 14%" filing story - see ranking.js's computeImportance for
// where this is applied.
const IMPORTANCE_PENALIZE_PATTERNS = [
  /\bshares?\b[^.]{0,60}\b\d+(\.\d+)?\s*%/i,
  /\bstocks?\b[^.]{0,60}\b\d+(\.\d+)?\s*%/i,
];

const IMPORTANCE_KEYWORDS = {
  boost: IMPORTANCE_BOOST_KEYWORDS,
  penalize: IMPORTANCE_PENALIZE_KEYWORDS,
};

// How much each keyword match shifts the score, and the floor/ceiling it's
// clamped to afterwards. The pattern-based penalty is weighted heavier than
// a single keyword match - a regex match on a specific phrasing convention
// is a much more confident signal than one coincidental word.
const IMPORTANCE_BOOST_WEIGHT = 0.08;
const IMPORTANCE_PENALIZE_WEIGHT = 0.1;
const IMPORTANCE_PATTERN_PENALIZE_WEIGHT = 0.15;
const IMPORTANCE_MIN = 0;
const IMPORTANCE_MAX = 1;

// The "avoid too many very similar articles" stand-in for Stage 1 (real
// clustering is a Stage 2 concern) - caps how many of the final ranked
// results can come from the same source.
const MAX_PER_SOURCE = 3;
// Caps how many of the final ranked results can share the same category, so
// one narrow vertical (business/markets was the concrete case that motivated
// this) can't crowd out a broad mainstream feed even when its articles
// happen to score well. Only meaningful for an unfiltered ("all
// categories") ranking pass - a caller that already filtered candidates to
// a single category must NOT pass this, or the result would be truncated to
// this cap instead of the requested limit (see routes/articles.js).
const MAX_PER_CATEGORY = 4;

// How many recent rows to pull from the DB before ranking - large enough to
// give the ranker a meaningful pool without ranking the entire table.
const CANDIDATE_POOL_SIZE = 100;
const DEFAULT_TOP_STORIES_LIMIT = 20;

module.exports = {
  FRESHNESS_DECAY_HOURS,
  RANKING_WEIGHTS,
  SOURCE_AUTHORITY,
  DEFAULT_SOURCE_AUTHORITY,
  IMPORTANCE_BASELINE,
  IMPORTANCE_KEYWORDS,
  IMPORTANCE_PENALIZE_PATTERNS,
  IMPORTANCE_BOOST_WEIGHT,
  IMPORTANCE_PENALIZE_WEIGHT,
  IMPORTANCE_PATTERN_PENALIZE_WEIGHT,
  IMPORTANCE_MIN,
  IMPORTANCE_MAX,
  MAX_PER_SOURCE,
  MAX_PER_CATEGORY,
  CANDIDATE_POOL_SIZE,
  DEFAULT_TOP_STORIES_LIMIT,
};
