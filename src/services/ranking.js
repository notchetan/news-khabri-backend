// Stage 1 ranking service - see docs/ranking-pipeline.md.
const {
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
  DEFAULT_TOP_STORIES_LIMIT,
} = require('./ranking-config');

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// See "computeFreshness" in docs/ranking-pipeline.md.
function computeFreshness(publishedAt, now = new Date()) {
  if (!publishedAt) return 0;
  const publishedDate = new Date(publishedAt);
  if (Number.isNaN(publishedDate.getTime())) return 0;

  const ageInHours = (now.getTime() - publishedDate.getTime()) / (1000 * 60 * 60);
  const freshness = Math.exp(-ageInHours / FRESHNESS_DECAY_HOURS);
  return clamp(freshness, 0, 1);
}

// See ranking-config.js's SOURCE_AUTHORITY / docs/ranking-tuning.md.
function computeSourceAuthority(sourceName) {
  if (sourceName && Object.prototype.hasOwnProperty.call(SOURCE_AUTHORITY, sourceName)) {
    return SOURCE_AUTHORITY[sourceName];
  }
  return DEFAULT_SOURCE_AUTHORITY;
}

// See "matchedKeywords" in docs/ranking-pipeline.md.
function matchedKeywords(text, list) {
  const matched = list.filter((keyword) => text.includes(keyword));
  return matched.filter(
    (keyword) => !matched.some((other) => other !== keyword && other.includes(keyword))
  );
}

// See "computeImportance" in docs/ranking-pipeline.md.
function computeImportance(article) {
  const text = [article.title, article.description, article.category]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  let score = IMPORTANCE_BASELINE;
  for (const keyword of matchedKeywords(text, IMPORTANCE_KEYWORDS.boost)) {
    score += IMPORTANCE_BOOST_WEIGHT;
  }
  for (const keyword of matchedKeywords(text, IMPORTANCE_KEYWORDS.penalize)) {
    score -= IMPORTANCE_PENALIZE_WEIGHT;
  }
  for (const pattern of IMPORTANCE_PENALIZE_PATTERNS) {
    if (pattern.test(text)) score -= IMPORTANCE_PATTERN_PENALIZE_WEIGHT;
  }

  return clamp(score, IMPORTANCE_MIN, IMPORTANCE_MAX);
}

// See "computeRankingScore" in docs/ranking-pipeline.md.
function computeRankingScore(article, now = new Date()) {
  const freshness = computeFreshness(article.published_at, now);
  const importance = computeImportance(article);
  const sourceAuthority = computeSourceAuthority(article.source);

  const score =
    RANKING_WEIGHTS.importance * importance +
    RANKING_WEIGHTS.freshness * freshness +
    RANKING_WEIGHTS.sourceAuthority * sourceAuthority;

  return { score, freshness, importance, sourceAuthority };
}

// See "rankArticles" in docs/ranking-pipeline.md.
function rankArticles(articles, options = {}) {
  const {
    limit = DEFAULT_TOP_STORIES_LIMIT,
    maxPerSource = MAX_PER_SOURCE,
    maxPerCategory,
    now = new Date(),
  } = options;

  const scored = articles
    .map((article) => ({ article, ...computeRankingScore(article, now) }))
    .sort((a, b) => b.score - a.score);

  const sourceCounts = new Map();
  const categoryCounts = new Map();
  const picked = [];
  const overflow = [];

  for (const entry of scored) {
    if (picked.length >= limit) break;
    const source = entry.article.source;
    const category = entry.article.category;
    const sourceCount = sourceCounts.get(source) || 0;
    const categoryCount = categoryCounts.get(category) || 0;
    const withinSourceCap = sourceCount < maxPerSource;
    const withinCategoryCap = maxPerCategory == null || categoryCount < maxPerCategory;
    if (withinSourceCap && withinCategoryCap) {
      picked.push(entry);
      sourceCounts.set(source, sourceCount + 1);
      categoryCounts.set(category, categoryCount + 1);
    } else {
      overflow.push(entry);
    }
  }

  for (const entry of overflow) {
    if (picked.length >= limit) break;
    picked.push(entry);
  }

  return picked.map(({ article, score, freshness, importance, sourceAuthority }) => ({
    ...article,
    ranking_score: score,
    ranking_freshness: freshness,
    ranking_importance: importance,
    ranking_sourceAuthority: sourceAuthority,
  }));
}

module.exports = {
  computeFreshness,
  computeSourceAuthority,
  computeImportance,
  computeRankingScore,
  rankArticles,
};
