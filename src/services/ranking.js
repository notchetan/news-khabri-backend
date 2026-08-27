// Stage 1 ranking service - pure, framework-free functions (no Express/DB
// coupling) so they're trivially unit-testable and so Stage 2 additions
// (story clustering, cross-source coverage, momentum, personalization,
// semantic similarity) can plug into rankArticles/computeRankingScore
// without restructuring anything here.
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

// exp(-ageInHours / FRESHNESS_DECAY_HOURS) - decays smoothly rather than
// treating older articles as suddenly irrelevant. Missing/invalid dates (or
// dates in the future, e.g. clock skew from a source) are treated as not
// fresh / not in the future respectively rather than throwing.
function computeFreshness(publishedAt, now = new Date()) {
  if (!publishedAt) return 0;
  const publishedDate = new Date(publishedAt);
  if (Number.isNaN(publishedDate.getTime())) return 0;

  const ageInHours = (now.getTime() - publishedDate.getTime()) / (1000 * 60 * 60);
  const freshness = Math.exp(-ageInHours / FRESHNESS_DECAY_HOURS);
  return clamp(freshness, 0, 1);
}

// A relatively small, configurable per-source signal - see
// ranking-config.js's SOURCE_AUTHORITY for the reasoning and how to add a
// new source.
function computeSourceAuthority(sourceName) {
  if (sourceName && Object.prototype.hasOwnProperty.call(SOURCE_AUTHORITY, sourceName)) {
    return SOURCE_AUTHORITY[sourceName];
  }
  return DEFAULT_SOURCE_AUTHORITY;
}

// Which keywords in `list` actually match `text`, with one refinement: when
// one matched keyword is itself a substring of another matched keyword
// (e.g. 'court' inside 'supreme court'), only the longer/more specific one
// counts - otherwise a single mention of "Supreme Court" would double-boost
// via both keywords for what is, semantically, one signal. Generalizes past
// the couple of pairs found by auditing the current lists, so a future
// addition to either list doesn't need a fresh manual overlap check.
function matchedKeywords(text, list) {
  const matched = list.filter((keyword) => text.includes(keyword));
  return matched.filter(
    (keyword) => !matched.some((other) => other !== keyword && other.includes(keyword))
  );
}

// Deterministic, keyword-based importance score - not ML, on purpose (see
// ranking-config.js's IMPORTANCE_KEYWORDS for the actual word lists this
// checks against, and to extend them; IMPORTANCE_PENALIZE_PATTERNS for the
// regex-based penalties layered on top for phrasing conventions a literal
// keyword list can't express, like "any single-company stock move").
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

// Combines the three signals into the final weighted score. Returns the
// breakdown alongside the total - that breakdown is what makes the result
// explainable (and testable) rather than a single opaque number.
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

// Scores every candidate, sorts by score, then applies a simple per-source
// cap so one prolific source can't fill the whole list with near-duplicate
// wire stories - a stand-in for real story clustering/dedup, which is
// explicitly a Stage 2 concern, not implemented here. If the cap would
// leave fewer than `limit` results (not enough source diversity in the
// candidate pool), the highest-scoring capped-out articles backfill the
// remaining slots rather than returning a short list.
//
// maxPerCategory works the same way but is opt-in (no default) - a caller
// that already filtered its candidates to one category (e.g.
// /articles/top?category=business) must not pass it, or every result would
// be truncated to the cap instead of the requested limit. Only the
// "all categories" top-stories view should pass this.
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
