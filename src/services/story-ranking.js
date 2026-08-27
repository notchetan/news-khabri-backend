// Stage 2 story-level ranking - read-time aggregation of Stage 1 article
// scores, mirroring ranking.js's own computeRankingScore/rankArticles shape.
// Deliberately does NOT reimplement freshness/importance/source-authority -
// every one of those is reused directly from ranking.js so Stage 1 stays
// the single source of truth for per-article scoring.
const { computeRankingScore, computeFreshness } = require('./ranking');
const {
  SOURCE_COUNT_SATURATION,
  MOMENTUM_SATURATION,
  MOMENTUM_WINDOW_HOURS,
  STORY_SCORE_WEIGHTS,
  DEFAULT_TOP_STORIES_LIMIT,
} = require('./clustering-config');

// Deliberately dominated by the single best member article's own Stage 1
// score (see STORY_SCORE_WEIGHTS.bestArticle in clustering-config.js) -
// article count never appears in this formula at all, only as display
// metadata elsewhere. distinctSourceCount (not raw member count) is what
// rewards genuine independent-source corroboration over syndicated
// duplicates padding out one story with copies from a single source.
function computeStoryScore(story, memberArticles, now = new Date()) {
  const scores = memberArticles.map((article) => computeRankingScore(article, now).score);
  const bestArticleScore = scores.length ? Math.max(...scores) : 0;

  const distinctSources = new Set(memberArticles.map((article) => article.source));
  const sourceCountSignal = Math.min(distinctSources.size, SOURCE_COUNT_SATURATION) / SOURCE_COUNT_SATURATION;

  const recencySignal = computeFreshness(story.latest_published_at, now);

  const momentumCutoff = now.getTime() - MOMENTUM_WINDOW_HOURS * 60 * 60 * 1000;
  const recentSources = new Set(
    memberArticles
      .filter((article) => {
        const publishedAt = new Date(article.published_at);
        return !Number.isNaN(publishedAt.getTime()) && publishedAt.getTime() >= momentumCutoff;
      })
      .map((article) => article.source)
  );
  const momentumSignal = Math.min(recentSources.size, MOMENTUM_SATURATION) / MOMENTUM_SATURATION;

  const score =
    STORY_SCORE_WEIGHTS.bestArticle * bestArticleScore +
    STORY_SCORE_WEIGHTS.sourceCount * sourceCountSignal +
    STORY_SCORE_WEIGHTS.recency * recencySignal +
    STORY_SCORE_WEIGHTS.momentum * momentumSignal;

  return {
    score,
    bestArticleScore,
    sourceCountSignal,
    recencySignal,
    momentumSignal,
    distinctSourceCount: distinctSources.size,
  };
}

// `memberArticlesByStoryId` is a Map<storyId, article[]> - the caller
// (routes/stories.js) is responsible for loading members, keeping this file
// itself DB-free like ranking.js.
//
// maxPerCategory mirrors ranking.js's rankArticles: opt-in (no default), and
// backfills from capped-out stories (in score order) if too few distinct
// categories are in the pool to fill `limit` outright - never returns a
// short list just because the cap bit. A caller that already filtered
// candidates to a single category must not pass this (see routes/stories.js).
function rankStories(stories, memberArticlesByStoryId, options = {}) {
  const { limit = DEFAULT_TOP_STORIES_LIMIT, maxPerCategory, now = new Date() } = options;

  const scored = stories.map((story) => {
    const members = memberArticlesByStoryId.get(story.id) || [];
    return { story, ...computeStoryScore(story, members, now) };
  });

  scored.sort((a, b) => b.score - a.score);

  let picked;
  if (maxPerCategory == null) {
    picked = scored.slice(0, limit);
  } else {
    const categoryCounts = new Map();
    const overflow = [];
    picked = [];
    for (const entry of scored) {
      if (picked.length >= limit) break;
      const category = entry.story.category;
      const count = categoryCounts.get(category) || 0;
      if (count < maxPerCategory) {
        picked.push(entry);
        categoryCounts.set(category, count + 1);
      } else {
        overflow.push(entry);
      }
    }
    for (const entry of overflow) {
      if (picked.length >= limit) break;
      picked.push(entry);
    }
  }

  return picked.map(({ story, score, bestArticleScore, sourceCountSignal, recencySignal, momentumSignal }) => ({
    ...story,
    story_score: score,
    story_score_bestArticle: bestArticleScore,
    story_score_sourceCount: sourceCountSignal,
    story_score_recency: recencySignal,
    story_score_momentum: momentumSignal,
  }));
}

module.exports = {
  computeStoryScore,
  rankStories,
};
