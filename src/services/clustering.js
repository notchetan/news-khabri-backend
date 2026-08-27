// Stage 2 story-clustering decision engine - see docs/clustering-pipeline.md.
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

// See "computeSimilaritySignals" in docs/clustering-pipeline.md.
function computeSimilaritySignals(article, story) {
  const articleTitleTokens = normalizeTokens(article.title);
  const articleContentTokens = normalizeTokens(articleText(article));
  const articleEntities = new Set(
    extractEntities(articleText(article)).filter((e) => !GENERIC_TOPIC_ENTITIES.has(e))
  );

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

  // See "Semantic similarity" in docs/clustering-pipeline.md.
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

// See "evaluateCandidate: the false-merge defense" in
// docs/clustering-pipeline.md.
function evaluateCandidate(article, story) {
  const signals = computeSimilaritySignals(article, story);

  const strongSignal =
    (signals.titleSim >= TITLE_SIMILARITY_THRESHOLD &&
      signals.titleTokenCount >= MIN_TITLE_TOKENS_FOR_SIMILARITY) ||
    signals.contentSim >= CONTENT_SIMILARITY_THRESHOLD ||
    (signals.entityOverlap >= ENTITY_OVERLAP_THRESHOLD &&
      signals.sharedEntityCount >= MIN_SHARED_ENTITY_COUNT) ||
    // Requires the timing to still be plausible too - see
    // docs/clustering-pipeline.md.
    (signals.semanticSim >= SEMANTIC_SIMILARITY_THRESHOLD &&
      signals.timeProximity >= MIN_TIME_PROXIMITY_FOR_SEMANTIC);

  const confidence =
    CONFIDENCE_WEIGHTS.title * signals.titleSim +
    CONFIDENCE_WEIGHTS.content * signals.contentSim +
    CONFIDENCE_WEIGHTS.entity * signals.entityOverlap +
    CONFIDENCE_WEIGHTS.time * signals.timeProximity +
    // Time-discounted, same reasoning as the strongSignal gate above - see
    // docs/clustering-pipeline.md.
    CONFIDENCE_WEIGHTS.semantic * signals.semanticSim * signals.timeProximity;

  return { storyId: story.id, confidence, strongSignal, ...signals };
}

// See "decideAssignment" in docs/clustering-pipeline.md.
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

// See "computeQuality" in docs/clustering-pipeline.md.
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
