// Stage 2 story-clustering decision engine - pure, framework/DB-free
// functions (no Express/SQLite coupling here), exactly like ranking.js, so
// they're trivially unit-testable and so a persistence layer
// (ingestion/clusterer.js) can drive them without this file knowing
// anything about SQL.
//
// IMPORTANT: this is a deterministic, lexical-similarity first pass (jaccard
// over tokens + a heuristic capitalized-run entity extractor), not a claim
// that it solves semantic clustering perfectly - see cluster_decisions
// (persisted by ingestion/clusterer.js) for how to inspect false and missed
// merges against real RSS data. All four similarity signals are produced by
// one function, computeSimilaritySignals, so a future embedding-based
// similarity can replace/extend its internals without touching the
// merge-decision gating logic below (evaluateCandidate/decideAssignment).
const { normalizeTokens, jaccardSimilarity } = require('./text-similarity');
const { extractEntities } = require('./entity-extraction');
const { computeRankingScore } = require('./ranking');
const { cosineSimilarity } = require('./embeddings');
const {
  TITLE_SIMILARITY_THRESHOLD,
  CONTENT_SIMILARITY_THRESHOLD,
  CONTENT_SIMILARITY_FLOOR,
  MIN_TITLE_TOKENS_FOR_SIMILARITY,
  ENTITY_OVERLAP_THRESHOLD,
  MIN_SHARED_ENTITY_COUNT,
  GENERIC_TOPIC_ENTITIES,
  SEMANTIC_SIMILARITY_THRESHOLD,
  MIN_TIME_PROXIMITY_FOR_SEMANTIC,
  TIME_DECAY_HOURS,
  CONFIDENCE_WEIGHTS,
  MERGE_CONFIDENCE_THRESHOLD,
  REP_WEIGHTS,
} = require('./clustering-config');

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function articleText(article) {
  return [article.title, article.description].filter(Boolean).join(' ');
}

// A story "candidate" here is the minimal shape clustering needs - see
// ingestion/clusterer.js for how a `stories` row is mapped into this
// (entities_json parsed into an array, etc). Kept separate from the DB row
// shape so this file never needs to know about JSON serialization.
//
// Every one of the four signals below is independently meaningful and
// individually inspectable - that's what makes a merge/no-merge decision
// explainable rather than a single opaque number (see decideAssignment).
function computeSimilaritySignals(article, story) {
  const articleTitleTokens = normalizeTokens(article.title);
  const articleContentTokens = normalizeTokens(articleText(article));
  // GENERIC_TOPIC_ENTITIES (country/nationality names) are dropped here only
  // - they're real entities (extractEntities keeps producing them), just not
  // trusted as evidence of "same specific development" for this signal. See
  // GENERIC_TOPIC_ENTITIES's comment in clustering-config.js.
  const articleEntities = new Set(
    extractEntities(articleText(article)).filter((e) => !GENERIC_TOPIC_ENTITIES.has(e))
  );

  // Compared against both the story's display headline and its most
  // recently-seen phrasing - an evolving story's wording drifts over time,
  // so matching only the very first headline would erode over updates.
  const titleSim = Math.max(
    jaccardSimilarity(articleTitleTokens, normalizeTokens(story.title)),
    jaccardSimilarity(articleTitleTokens, normalizeTokens(story.latestTitle))
  );

  const storyContentTokens = normalizeTokens(
    [story.latestTitle, story.latestDescription].filter(Boolean).join(' ')
  );
  const rawContentSim = jaccardSimilarity(articleContentTokens, storyContentTokens);
  // Below the floor, treat as no signal rather than noise from two mostly
  // unrelated snippets sharing a couple of common words.
  const contentSim = rawContentSim < CONTENT_SIMILARITY_FLOOR ? 0 : rawContentSim;

  const storyEntities = new Set(
    (story.entities || []).filter((e) => !GENERIC_TOPIC_ENTITIES.has(e))
  );
  let sharedEntityCount = 0;
  for (const entity of articleEntities) {
    if (storyEntities.has(entity)) sharedEntityCount += 1;
  }
  const entityOverlap = jaccardSimilarity(articleEntities, storyEntities);

  // 0 when either side has no embedding (model failure, or a pre-Stage-3
  // row) - cosineSimilarity already treats that as "no signal" rather than
  // throwing, so this degrades gracefully to Stage 2-only behavior. Also 0
  // for non-English articles regardless of the raw model output - the
  // embedding model (Xenova/all-MiniLM-L6-v2) is English-only, and real
  // cluster_decisions data showed it producing high but meaningless
  // "similarity" between unrelated Hindi/Gujarati articles (see
  // SEMANTIC_SIMILARITY_THRESHOLD's comment in clustering-config.js).
  // Candidates are already same-language as the article by construction
  // (ingestion/clusterer.js's SQL blocking query), so checking the
  // article's own language is sufficient.
  const isEnglish = (article.language || 'en') === 'en';
  const semanticSim = isEnglish ? cosineSimilarity(article.embedding, story.embedding) : 0;

  const articlePublishedAt = new Date(article.published_at);
  const storyLatestPublishedAt = new Date(story.latestPublishedAt);
  const hasValidDates =
    !Number.isNaN(articlePublishedAt.getTime()) && !Number.isNaN(storyLatestPublishedAt.getTime());
  const hoursApart = hasValidDates
    ? Math.abs(articlePublishedAt.getTime() - storyLatestPublishedAt.getTime()) / (1000 * 60 * 60)
    : Infinity;
  const timeProximity = clamp(Math.exp(-hoursApart / TIME_DECAY_HOURS), 0, 1);

  return {
    titleSim,
    titleTokenCount: articleTitleTokens.size,
    contentSim,
    entityOverlap,
    sharedEntityCount,
    semanticSim,
    hoursApart,
    timeProximity,
  };
}

// The false-merge defense: a weighted-sum confidence alone is not enough,
// since several *medium* signals (same category, close in time, one shared
// generic entity) can add up to clear a bare threshold without actually
// describing the same event. At least one signal must independently clear
// its own bar ("strongSignal") - and MIN_SHARED_ENTITY_COUNT specifically
// blocks "shared exactly one entity" from ever counting as strong on its
// own (e.g. two articles both mentioning "Apple" but about unrelated
// events).
function evaluateCandidate(article, story) {
  const signals = computeSimilaritySignals(article, story);

  const strongSignal =
    (signals.titleSim >= TITLE_SIMILARITY_THRESHOLD &&
      signals.titleTokenCount >= MIN_TITLE_TOKENS_FOR_SIMILARITY) ||
    signals.contentSim >= CONTENT_SIMILARITY_THRESHOLD ||
    (signals.entityOverlap >= ENTITY_OVERLAP_THRESHOLD &&
      signals.sharedEntityCount >= MIN_SHARED_ENTITY_COUNT) ||
    // Requires the timing to still be plausible, not just a high raw score -
    // see SEMANTIC_SIMILARITY_THRESHOLD's comment in clustering-config.js:
    // a stale-but-same-topic pair can score higher semantically than a
    // genuine near-duplicate, so this path alone is not trustworthy without
    // the time co-requirement.
    (signals.semanticSim >= SEMANTIC_SIMILARITY_THRESHOLD &&
      signals.timeProximity >= MIN_TIME_PROXIMITY_FOR_SEMANTIC);

  const confidence =
    CONFIDENCE_WEIGHTS.title * signals.titleSim +
    CONFIDENCE_WEIGHTS.content * signals.contentSim +
    CONFIDENCE_WEIGHTS.entity * signals.entityOverlap +
    CONFIDENCE_WEIGHTS.time * signals.timeProximity +
    // Time-discounted, same reasoning as the strongSignal gate above: a high
    // semantic score against a stale story should contribute close to
    // nothing here too, not just fail its own OR-path, otherwise it could
    // still drag confidence over MERGE_CONFIDENCE_THRESHOLD via an entity
    // path that's already strongSignal-true on its own (the stale Cyclone
    // Biparjoy pair clears the entity gate independently of this term).
    CONFIDENCE_WEIGHTS.semantic * signals.semanticSim * signals.timeProximity;

  return { storyId: story.id, confidence, strongSignal, ...signals };
}

// Candidates have already passed the SQL blocking gate (same language,
// category, and within the time window - see ingestion/clusterer.js) by the
// time they reach here; this only does the more expensive similarity math,
// never a full-table comparison.
function decideAssignment(article, candidates) {
  const allCandidateScores = candidates.map((story) => evaluateCandidate(article, story));

  const eligible = allCandidateScores
    .filter((c) => c.strongSignal && c.confidence >= MERGE_CONFIDENCE_THRESHOLD)
    .sort((a, b) => b.confidence - a.confidence);

  if (eligible.length === 0) {
    return { action: 'create', story: null, confidence: null, signals: null, allCandidateScores };
  }

  const winner = eligible[0];
  const winnerStory = candidates.find((story) => story.id === winner.storyId);
  return { action: 'merge', story: winnerStory, confidence: winner.confidence, signals: winner, allCandidateScores };
}

const CLICKBAIT_PATTERNS = [
  /^\s*\d+\s/, // "10 reasons..."
  /you won.t believe/i,
  /shocking/i,
  /this is why/i,
  /goes viral/i,
];

function titleClarityScore(title) {
  if (!title) return 0;
  let score = 1;
  if (CLICKBAIT_PATTERNS.some((pattern) => pattern.test(title))) score -= 0.3;

  const letters = title.replace(/[^a-zA-Z]/g, '');
  const upper = title.replace(/[^A-Z]/g, '');
  if (letters.length > 0 && upper.length / letters.length > 0.4) score -= 0.2;

  if (/!!|\?\?|!\s*$/.test(title)) score -= 0.15;

  return clamp(score, 0, 1);
}

function completenessScore(article) {
  return ((article.description ? 1 : 0) + (article.image_url ? 1 : 0)) / 2;
}

// Used both to decide whether a joining article should become the story's
// representative headline, and as the initial value when a story is first
// created. Reuses Stage 1's computeRankingScore instead of reinventing a
// source-authority/importance signal - "prefer a clear factual headline
// over clickbait" leans on titleClarityScore, "completeness" rewards having
// a description/image, "existing Stage 1 score" is the ranking score itself.
function computeQuality(article, now = new Date()) {
  const rankingScore = computeRankingScore(article, now).score;
  return (
    REP_WEIGHTS.rankingScore * rankingScore +
    REP_WEIGHTS.completeness * completenessScore(article) +
    REP_WEIGHTS.titleClarity * titleClarityScore(article.title)
  );
}

module.exports = {
  computeSimilaritySignals,
  evaluateCandidate,
  decideAssignment,
  computeQuality,
  titleClarityScore,
  completenessScore,
};
