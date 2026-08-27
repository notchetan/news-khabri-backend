// Every tunable knob for Stage 1 ranking lives here so the scoring logic in
// ranking.js never hardcodes a number. See docs/ranking-tuning.md for the
// calibration history behind each value below.

// The divisor in exp(-ageInHours / FRESHNESS_DECAY_HOURS).
const FRESHNESS_DECAY_HOURS = 12;

// Must stay roughly summing to 1 - see docs/ranking-tuning.md.
const RANKING_WEIGHTS = {
  importance: 0.5,
  freshness: 0.25,
  sourceAuthority: 0.25,
};

// Add an entry here for each new source as it's onboarded; anything
// missing falls back to DEFAULT_SOURCE_AUTHORITY. See docs/ranking-tuning.md.
const SOURCE_AUTHORITY = {
  'Times of India': 0.8,
  'The Hindu': 0.9,
  'Economic Times': 0.85,
  'Indian Express': 0.8,
  NDTV: 0.8,
  'NDTV Khabar': 0.75,
  'Aaj Tak': 0.7,
  'Amar Ujala': 0.65,
  'Dainik Bhaskar': 0.65,
  'Divya Bhaskar': 0.65,
};
const DEFAULT_SOURCE_AUTHORITY = 0.5;

// Rule-based importance signal - every article starts at IMPORTANCE_BASELINE
// and each matching keyword nudges the score up or down. See
// docs/ranking-tuning.md.
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
  // Economic/financial - see docs/ranking-tuning.md for why this is
  // deliberately narrower than generic financial vocabulary.
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
  // Inspirational/filler content - see docs/ranking-tuning.md.
  'proverb', 'quote of the day', 'thought for the day', 'motivational',
  'motivational quote', 'life lesson', 'moral of the story', 'zen story',
  'inspirational story', 'did you know',
];

// See "Single-company stock-price penalty pattern" in docs/ranking-tuning.md.
const IMPORTANCE_PENALIZE_PATTERNS = [
  /\bshares?\b[^.]{0,60}\b\d+(\.\d+)?\s*%/i,
  /\bstocks?\b[^.]{0,60}\b\d+(\.\d+)?\s*%/i,
];

const IMPORTANCE_KEYWORDS = {
  boost: IMPORTANCE_BOOST_KEYWORDS,
  penalize: IMPORTANCE_PENALIZE_KEYWORDS,
};

// How much each keyword match shifts the score, and the floor/ceiling it's
// clamped to afterwards - the pattern-based penalty is weighted heavier
// than a single keyword match (see docs/ranking-tuning.md).
const IMPORTANCE_BOOST_WEIGHT = 0.08;
const IMPORTANCE_PENALIZE_WEIGHT = 0.1;
const IMPORTANCE_PATTERN_PENALIZE_WEIGHT = 0.15;
const IMPORTANCE_MIN = 0;
const IMPORTANCE_MAX = 1;

// See "Diversity caps" in docs/ranking-tuning.md.
const MAX_PER_SOURCE = 3;
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
