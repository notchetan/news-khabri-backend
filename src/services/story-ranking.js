// Stage 2 story-level ranking - see docs/ranking-pipeline.md.
const { computeRankingScore, computeFreshness } = require('./ranking');
const { computePersonalizationSignal } = require('./personalization');
const {
  SOURCE_COUNT_SATURATION,
  MOMENTUM_SATURATION,
  MOMENTUM_WINDOW_HOURS,
  STORY_SCORE_WEIGHTS,
  DEFAULT_TOP_STORIES_LIMIT,
} = require('./clustering-config');

// `readProfile` (personalization.js's loadReadProfile output) is optional -
// omitting it or passing null gives a personalizationSignal of exactly 0 for
// every story (see computePersonalizationSignal), which is what every
// caller got before this signal existed. See docs/personalization.md.
function computeStoryScore(story, memberArticles, now = new Date(), readProfile = null) {
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

  const personalizationSignal = computePersonalizationSignal(readProfile, story, memberArticles);

  const score =
    STORY_SCORE_WEIGHTS.bestArticle * bestArticleScore +
    STORY_SCORE_WEIGHTS.sourceCount * sourceCountSignal +
    STORY_SCORE_WEIGHTS.recency * recencySignal +
    STORY_SCORE_WEIGHTS.momentum * momentumSignal +
    STORY_SCORE_WEIGHTS.personalization * personalizationSignal;

  return {
    score,
    bestArticleScore,
    sourceCountSignal,
    recencySignal,
    momentumSignal,
    personalizationSignal,
    distinctSourceCount: distinctSources.size,
  };
}

function rankStories(stories, memberArticlesByStoryId, options = {}) {
  const {
    limit = DEFAULT_TOP_STORIES_LIMIT,
    maxPerCategory,
    now = new Date(),
    readProfile = null,
  } = options;

  const scored = stories.map((story) => {
    const members = memberArticlesByStoryId.get(story.id) || [];
    return { story, ...computeStoryScore(story, members, now, readProfile) };
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

  return picked.map(
    ({ story, score, bestArticleScore, sourceCountSignal, recencySignal, momentumSignal, personalizationSignal }) => ({
      ...story,
      story_score: score,
      story_score_bestArticle: bestArticleScore,
      story_score_sourceCount: sourceCountSignal,
      story_score_recency: recencySignal,
      story_score_momentum: momentumSignal,
      story_score_personalization: personalizationSignal,
    })
  );
}

module.exports = {
  computeStoryScore,
  rankStories,
};
