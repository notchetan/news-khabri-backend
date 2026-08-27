// Every tunable knob for Stage 2 story clustering lives here, mirroring how
// ranking-config.js holds Stage 1's knobs - the clustering/story-ranking
// logic itself never hardcodes a number. Start conservative: false merges
// (unrelated articles grouped as one story) are worse than missed merges
// (the same story split across two entries) - see clustering.js for how
// these are combined into a merge decision.
//
// These starting values are a first deterministic pass, not a claim that
// jaccard/entity-overlap solves semantic clustering perfectly - see
// cluster_decisions (ingestion/clusterer.js) for how to inspect false/missed
// merges against real RSS data and re-tune from there.

// --- Text similarity thresholds ---
// jaccard(title tokens, title tokens) needed to count as a "strong" signal
// on its own.
const TITLE_SIMILARITY_THRESHOLD = 0.5;
// jaccard(title+description tokens) needed to count as "strong" on its own.
// Lower than the title threshold because longer text has a naturally lower
// jaccard ceiling even for genuine duplicates (more total distinct tokens).
const CONTENT_SIMILARITY_THRESHOLD = 0.35;
// Below this, content similarity is treated as 0 in the weighted sum rather
// than contributing noise from two mostly-unrelated snippets that happen to
// share a couple of common words.
const CONTENT_SIMILARITY_FLOOR = 0.15;
// Title token counts below this can never qualify as a "strong" signal by
// themselves - with very few tokens, one shared word can spike jaccard
// misleadingly (e.g. two 2-word titles sharing 1 word = 0.33+ jaccard).
const MIN_TITLE_TOKENS_FOR_SIMILARITY = 3;

// --- Entity overlap thresholds ---
// jaccard(entity set, entity set) needed to count as "strong" on its own.
// Lowered from an initial 0.34 after checking real cluster_decisions data:
// two genuine near-duplicate headlines from the same publisher minutes
// apart (same Nepal-floods update) landed at entityOverlap 0.133 - each
// mentions 2-3 *other* entities the other doesn't (a different official, a
// different agency), which dilutes the ratio even though the 2 shared
// entities are exactly the strong signal MIN_SHARED_ENTITY_COUNT exists to
// catch. The ratio is a secondary check on top of that count floor, not the
// primary defense - see MIN_SHARED_ENTITY_COUNT's comment below.
const ENTITY_OVERLAP_THRESHOLD = 0.1;
// A hard floor on the number of *shared* entities (not just the ratio) -
// this is what stops "Apple launches iPhone" from merging with "Apple
// reports revenue" just because both mention "Apple": one shared entity is
// never enough evidence on its own, regardless of how small either set is.
// This is the primary false-merge defense for the entity path (every
// should-NOT-cluster case checked during tuning shares at most 1 entity),
// so ENTITY_OVERLAP_THRESHOLD above can stay permissive without reopening
// those cases.
const MIN_SHARED_ENTITY_COUNT = 2;
// Country/nationality names that provide almost no distinguishing power for
// "is this the same specific development" clustering in an India-focused
// aggregator - nearly every article about an India-linked international
// story mentions India, and nearly every article about a disaster abroad
// mentions the country it happened in. Found via real cluster_decisions
// data: four genuinely distinct Nepal-floods articles (an MEA briefing, a
// state helpline notice, a Tamil Nadu CM directive, an ex-official's
// interview) each cleared MIN_SHARED_ENTITY_COUNT against each other with
// "nepal" + "india" as their only 2 "shared" entities - true overlap, but
// zero evidence they're the same development rather than just the same
// disaster. Excluded from the entity *overlap* signal only (see
// clustering.js's computeSimilaritySignals) - extractEntities itself stays
// a general-purpose extractor; this is a clustering-relevance filter, not a
// claim that "India" isn't a real entity.
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
// trusted for English articles at all - see clustering.js's
// computeSimilaritySignals, which zeroes this signal out for non-English
// text: the model is English-only, and on Hindi/Gujarati it was found (via
// real cluster_decisions data) producing high "similarity" between
// completely unrelated articles - a farmer-protest report, a Raksha Bandhan
// shopping piece, and an MLA visiting a monk all scored 0.6-0.8 against one
// unrelated murder-case story, none sharing any real topic.
//
// Raised from an initial 0.62 to 0.86 after the same real-data check showed
// 0.62 was not just a Hindi/Gujarati problem: English false positives landed
// in the same 0.6-0.8 band the threshold was meant to sit above (four
// distinct Nepal-floods articles - an MEA briefing, a state helpline notice,
// a Tamil Nadu CM directive, an ex-official interview - scored 0.71-0.78
// against each other despite covering different specific developments; an
// astrology "lunar eclipse" piece and an unrelated daily horoscope scored
// 0.76; two different product-price articles scored 0.63). Genuine
// cross-publisher duplicates in the same data averaged 0.82 and mostly
// cleared 0.85-1.0, so 0.86 keeps most of them while sitting above where the
// false positives actually landed - some of the hardest genuine duplicates
// (very differently-worded paraphrases with zero lexical overlap) will now
// be missed rather than wrongly merged, a deliberate tradeoff: this file's
// own header comment says false merges are worse than missed ones.
const SEMANTIC_SIMILARITY_THRESHOLD = 0.86;
// Embeddings capture topic/entity similarity strongly even across unrelated
// time-separated events - the same "Cyclone Biparjoy" pair used to calibrate
// MIN_SHARED_ENTITY_COUNT above (landfall report vs. an economic-impact
// piece weeks later) scored 0.82 semantically, well past
// SEMANTIC_SIMILARITY_THRESHOLD. A semantic match is therefore only trusted
// as a strong signal when the timing is still plausible for it to be the
// same event - see MIN_TIME_PROXIMITY_FOR_SEMANTIC's use in
// clustering.js's evaluateCandidate, and the matching time-discount on the
// semantic term in the confidence sum below. exp(-hoursApart/TIME_DECAY_HOURS)
// with TIME_DECAY_HOURS=8 puts this floor at roughly a 24-hour effective
// window.
const MIN_TIME_PROXIMITY_FOR_SEMANTIC = 0.05;

// --- Time-aware clustering ---
// Hard cutoff: an article can only be a candidate for a story whose
// latest_published_at is within this many hours. Generous enough for an
// evolving story (breaking news -> updates over several hours) without
// letting a same-category coincidence from days ago drift in.
const TIME_WINDOW_HOURS = 36;
// A second, outer hard cap measured from the story's first_published_at
// (not just its latest update) - stops a long chain of near-miss updates
// from slowly dragging a cluster's lifetime out indefinitely. A genuinely
// new development several days later (e.g. economic consequences of an
// earthquake) falls outside this even if it would otherwise pass every
// other gate.
const STORY_MAX_LIFETIME_HOURS = 72;
// Decay constant for the *soft* time-proximity score computed within the
// hard window above: exp(-hoursApart / TIME_DECAY_HOURS). Smaller = time
// proximity matters more.
const TIME_DECAY_HOURS = 8;

// --- Combining signals into a merge decision ---
// Must sum to ~1. See clustering.js's decideAssignment for exactly how
// these combine with the "strong signal" gate - the weighted sum alone is
// never sufficient to merge; at least one individual signal must also clear
// its own threshold above. Time carries a heavy share: two headlines can
// share 2 entities and little else (a real generic-topic coincidence, e.g.
// "Cyclone Biparjoy" mentioned in both a landfall report and an unrelated
// economic-impact piece weeks later) - a heavy time weight is what makes a
// near-zero timeProximity still veto that pairing even though the entity
// gate alone would let it through, while a genuinely same-day update (high
// timeProximity) gets full credit. This matters even more now that
// `semantic` is in the mix: that same stale Cyclone pair scores 0.82 on raw
// semantic similarity (see SEMANTIC_SIMILARITY_THRESHOLD's comment) - see
// clustering.js's evaluateCandidate for how the semantic term is multiplied
// by timeProximity before entering this sum, so a stale match's high
// semantic score contributes near-zero rather than pushing confidence over
// the threshold on its own.
const CONFIDENCE_WEIGHTS = {
  title: 0.15,
  content: 0.1,
  entity: 0.15,
  time: 0.3,
  semantic: 0.3,
};
// The strongSignal gate above (see clustering.js's evaluateCandidate) is
// the primary false-merge defense - every should-NOT-cluster case checked
// during tuning (shared-topic-only, same-org-different-event, generic
// same-subject headlines) failed strongSignal outright regardless of this
// number. This threshold's job is narrower: separating genuine multi-signal
// corroboration (a real evolving story, moderate on several signals at
// once) from a single coincidental strong signal. Lowered from an initial
// 0.4 to 0.28 after real cluster_decisions data showed a genuine same-story
// pair (two publishers' Nepal-floods updates, 2 shared entities, high time
// proximity) landing at confidence 0.302 - below 0.4 despite being exactly
// the kind of match this system exists to catch. Safe to lower because
// strongSignal (not this number) is what rejects every false-merge case in
// clustering.test.js - re-tune further from real data as it accumulates.
const MERGE_CONFIDENCE_THRESHOLD = 0.28;

// How many of the most-recently-updated same (language, category) active
// stories to load as candidates per article - a defensive cap so a single
// busy category/time-window slice can never make one article's clustering
// pass do unbounded work, independent of how large the `stories` table
// grows overall.
const CANDIDATE_STORY_POOL_SIZE = 25;

// --- Representative headline selection ---
// Must sum to ~1. rankingScore reuses Stage 1's computeRankingScore instead
// of reinventing a source-authority/importance signal.
const REP_WEIGHTS = {
  rankingScore: 0.6,
  completeness: 0.25,
  titleClarity: 0.15,
};
// A newly-joining article only replaces the current representative if its
// quality score beats the incumbent's by more than this margin - hysteresis
// to stop the headline flapping back and forth between two near-identical
// articles as more of them arrive.
const REPRESENTATIVE_SWITCH_MARGIN = 0.05;

// --- Story-level score aggregation (see story-ranking.js) ---
// Diminishing-returns caps: beyond this many distinct sources/recently-
// arrived sources, additional ones stop adding to the signal.
const SOURCE_COUNT_SATURATION = 6;
const MOMENTUM_SATURATION = 3;
// How recently a member must have been published to count toward momentum
// ("is this story still actively developing right now").
const MOMENTUM_WINDOW_HOURS = 3;
// Must sum to ~1. Deliberately dominated by the best member article's own
// Stage 1 score - article/source count are secondary signals, never the
// dominant one. Tuned so a single very important article (high importance +
// authoritative source) still outranks a ten-article/five-source story of
// low-quality (penalized-keyword) articles even when every one of those ten
// is simultaneously maximally fresh and "in-momentum" - the worst case for
// this property, not just the typical one (see story-ranking.test.js).
//
// recency/momentum shrank and sourceCount grew (was 0.65/0.15/0.12/0.08)
// after tracing a real /stories/top result: bestArticle already embeds
// Stage 1's own freshness term (RANKING_WEIGHTS.freshness), so a fresh
// single-source story was effectively getting credit for its freshness
// twice - once inside bestArticle, again via recency/momentum here - which
// is how a 20-minute-old single-outlet stock filing outranked slower, more
// broadly significant stories. distinctSourceCount (independent outlets
// covering the same story) is a much better "this genuinely matters" signal
// than raw recency for an aggregator, so it gained more than either
// recency-flavored term lost. Deliberately not pushed further than this:
// a larger sourceCount share was tried and it broke the adversarial
// guarantee above (5 sources of pure horoscope content outscored 1 source
// of war/disaster coverage) - see story-ranking.test.js's "ranks a story
// with one important article above a story with several trivial ones".
const STORY_SCORE_WEIGHTS = {
  bestArticle: 0.62,
  sourceCount: 0.2,
  recency: 0.1,
  momentum: 0.08,
};
const DEFAULT_TOP_STORIES_LIMIT = 20;
// How many active stories the /stories/top route pulls as a ranking pool
// before applying rankStories + limit - mirrors ranking-config.js's own
// CANDIDATE_POOL_SIZE for the equivalent per-article endpoint.
const STORY_FEED_POOL_SIZE = 100;
// Caps how many of the final ranked stories can share the same category -
// mirrors ranking-config.js's own MAX_PER_CATEGORY and the same caveat
// applies: only meaningful for an unfiltered ("all categories") ranking
// pass, never when the caller already filtered candidates to one category
// (see routes/stories.js).
const MAX_PER_CATEGORY = 4;

// Whether to persist a row to cluster_decisions for every clustering
// decision (merge or create), including the full candidate list - this is
// the explainability/debugging trail requested for inspecting false and
// missed merges after running against real RSS data. Never exposed via any
// API route - purely an operational/debug artifact. Safe to flip off if the
// table grows too large in practice.
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
