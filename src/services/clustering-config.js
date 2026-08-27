// Every tunable knob for Stage 2/3 story clustering lives here, mirroring
// how ranking-config.js holds Stage 1's knobs - the clustering/story-
// ranking logic itself never hardcodes a number. See docs/clustering-
// tuning.md for the full calibration history behind each value below
// (what real cluster_decisions data showed, and why each number landed
// where it did) - this file only keeps a one-line summary of what each
// knob controls.

// --- Text similarity thresholds ---
// jaccard(title tokens, title tokens) needed to count as a "strong" signal
// on its own.
const TITLE_SIMILARITY_THRESHOLD = 0.5;
// jaccard(title+description tokens) needed to count as "strong" on its own.
const CONTENT_SIMILARITY_THRESHOLD = 0.35;
// Below this, content similarity is treated as 0 in the weighted sum.
const CONTENT_SIMILARITY_FLOOR = 0.15;
// Title token counts below this can never qualify as a "strong" signal by
// themselves.
const MIN_TITLE_TOKENS_FOR_SIMILARITY = 3;

// --- Entity overlap thresholds ---
// jaccard(entity set, entity set) needed to count as "strong" on its own.
const ENTITY_OVERLAP_THRESHOLD = 0.1;
// A hard floor on the number of *shared* entities (not just the ratio) -
// the primary false-merge defense for the entity path.
const MIN_SHARED_ENTITY_COUNT = 2;
// Country/nationality names excluded from the entity *overlap* signal only
// (see clustering.js's computeSimilaritySignals) - almost no distinguishing
// power for "is this the same specific development" in an India-focused
// aggregator.
const GENERIC_TOPIC_ENTITIES = new Set([
  'india', 'indian', 'indians',
  'nepal', 'nepali', 'nepalese',
  'china', 'chinese',
  'pakistan', 'pakistani',
  'bangladesh', 'bangladeshi',
  'sri lanka', 'sri lankan',
  'america', 'american', 'americans', 'us', 'usa',
  'uk', 'britain', 'british',
]);

// --- Semantic similarity (Stage 3) ---
// cosine similarity between article/story embeddings (services/embeddings.js,
// Xenova/all-MiniLM-L6-v2) needed to count as "strong" on its own. Only
// trusted for English articles - see clustering.js's computeSimilaritySignals.
const SEMANTIC_SIMILARITY_THRESHOLD = 0.86;
// A semantic match is only trusted as a strong signal when the timing is
// still plausible for it to be the same event - see MIN_TIME_PROXIMITY_
// FOR_SEMANTIC's use in clustering.js's evaluateCandidate.
const MIN_TIME_PROXIMITY_FOR_SEMANTIC = 0.05;

// --- Time-aware clustering ---
// Hard cutoff: an article can only be a candidate for a story whose
// latest_published_at is within this many hours.
const TIME_WINDOW_HOURS = 36;
// A second, outer hard cap measured from the story's first_published_at.
const STORY_MAX_LIFETIME_HOURS = 72;
// Decay constant for the *soft* time-proximity score within the hard
// window above: exp(-hoursApart / TIME_DECAY_HOURS).
const TIME_DECAY_HOURS = 8;

// --- Combining signals into a merge decision ---
// Must sum to ~1. See clustering.js's decideAssignment - the weighted sum
// alone is never sufficient to merge; at least one individual signal must
// also clear its own threshold above.
const CONFIDENCE_WEIGHTS = {
  title: 0.15,
  content: 0.1,
  entity: 0.15,
  time: 0.3,
  semantic: 0.3,
};
// The strongSignal gate (see clustering.js's evaluateCandidate) is the
// primary false-merge defense; this threshold separates genuine
// multi-signal corroboration from a single coincidental strong signal.
const MERGE_CONFIDENCE_THRESHOLD = 0.28;

// How many of the most-recently-updated same (language, category) active
// stories to load as candidates per article.
const CANDIDATE_STORY_POOL_SIZE = 25;

// --- Representative headline selection ---
// Must sum to ~1. rankingScore reuses Stage 1's computeRankingScore.
const REP_WEIGHTS = {
  rankingScore: 0.6,
  completeness: 0.25,
  titleClarity: 0.15,
};
// A newly-joining article only replaces the current representative if its
// quality score beats the incumbent's by more than this margin.
const REPRESENTATIVE_SWITCH_MARGIN = 0.05;

// --- Story-level score aggregation (see story-ranking.js) ---
// Diminishing-returns caps: beyond this many distinct/recently-arrived
// sources, additional ones stop adding to the signal.
const SOURCE_COUNT_SATURATION = 6;
const MOMENTUM_SATURATION = 3;
// How recently a member must have been published to count toward momentum.
const MOMENTUM_WINDOW_HOURS = 3;
// Must sum to ~1. See docs/clustering-tuning.md for why this is
// deliberately dominated by bestArticle.
const STORY_SCORE_WEIGHTS = {
  bestArticle: 0.62,
  sourceCount: 0.2,
  recency: 0.1,
  momentum: 0.08,
};
const DEFAULT_TOP_STORIES_LIMIT = 20;
// How many active stories the /stories/top route pulls as a ranking pool
// before applying rankStories + limit.
const STORY_FEED_POOL_SIZE = 100;
// Caps how many of the final ranked stories can share the same category -
// only meaningful for an unfiltered ranking pass (see routes/stories.js).
const MAX_PER_CATEGORY = 4;

// Whether to persist a row to cluster_decisions for every clustering
// decision - the explainability/debugging trail for inspecting false and
// missed merges. Never exposed via any API route.
const LOG_CLUSTER_DECISIONS = true;

module.exports = {
  TITLE_SIMILARITY_THRESHOLD,
  CONTENT_SIMILARITY_THRESHOLD,
  CONTENT_SIMILARITY_FLOOR,
  MIN_TITLE_TOKENS_FOR_SIMILARITY,
  ENTITY_OVERLAP_THRESHOLD,
  MIN_SHARED_ENTITY_COUNT,
  GENERIC_TOPIC_ENTITIES,
  SEMANTIC_SIMILARITY_THRESHOLD,
  MIN_TIME_PROXIMITY_FOR_SEMANTIC,
  TIME_WINDOW_HOURS,
  STORY_MAX_LIFETIME_HOURS,
  TIME_DECAY_HOURS,
  CONFIDENCE_WEIGHTS,
  MERGE_CONFIDENCE_THRESHOLD,
  CANDIDATE_STORY_POOL_SIZE,
  REP_WEIGHTS,
  REPRESENTATIVE_SWITCH_MARGIN,
  SOURCE_COUNT_SATURATION,
  MOMENTUM_SATURATION,
  MOMENTUM_WINDOW_HOURS,
  STORY_SCORE_WEIGHTS,
  DEFAULT_TOP_STORIES_LIMIT,
  STORY_FEED_POOL_SIZE,
  MAX_PER_CATEGORY,
  LOG_CLUSTER_DECISIONS,
};
