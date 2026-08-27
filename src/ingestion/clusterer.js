// DB-touching orchestration for Stage 2 story clustering - see
// docs/clusterer-orchestration.md.
const db = require('../db');
const { extractEntities } = require('../services/entity-extraction');
const { decideAssignment, computeQuality } = require('../services/clustering');
const { getEmbedding, serializeEmbedding, deserializeEmbedding, updateCentroid } = require('../services/embeddings');
const {
  TIME_WINDOW_HOURS,
  STORY_MAX_LIFETIME_HOURS,
  CANDIDATE_STORY_POOL_SIZE,
  REPRESENTATIVE_SWITCH_MARGIN,
  LOG_CLUSTER_DECISIONS,
} = require('../services/clustering-config');

// See "Why candidate filtering happens in JS, not SQL" in
// docs/clusterer-orchestration.md.
const SQL_FETCH_MULTIPLIER = 4;

const selectCandidateStoriesStmt = db.prepare(`
  SELECT * FROM stories
  WHERE language = ? AND category = ? AND status = 'active'
  ORDER BY id DESC
  LIMIT ?
`);

// No LIMIT on purpose - see "No LIMIT on the unclustered-articles query"
// in docs/clusterer-orchestration.md.
const selectUnclusteredArticlesStmt = db.prepare(`
  SELECT * FROM articles WHERE story_id IS NULL ORDER BY id ASC
`);

const insertStoryStmt = db.prepare(`
  INSERT INTO stories (
    title, summary, category, language, entities_json, latest_title, latest_description,
    representative_article_id, representative_quality, article_count, source_count,
    first_published_at, latest_published_at, embedding
  ) VALUES (@title, @summary, @category, @language, @entities_json, @latest_title, @latest_description,
    @representative_article_id, @representative_quality, 1, 1, @first_published_at, @latest_published_at, @embedding)
`);

const updateStoryOnMergeStmt = db.prepare(`
  UPDATE stories SET
    article_count = article_count + 1,
    source_count = @source_count,
    latest_title = @latest_title,
    latest_description = @latest_description,
    entities_json = @entities_json,
    latest_published_at = @latest_published_at,
    representative_article_id = @representative_article_id,
    title = @title,
    summary = @summary,
    representative_quality = @representative_quality,
    embedding = @embedding,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = @id
`);

const assignArticleStoryIdStmt = db.prepare('UPDATE articles SET story_id = ? WHERE id = ?');
const updateArticleEmbeddingStmt = db.prepare('UPDATE articles SET embedding = ? WHERE id = ?');

const insertClusterDecisionStmt = db.prepare(`
  INSERT INTO cluster_decisions (article_id, action, story_id, confidence, signals_json, candidates_json)
  VALUES (@article_id, @action, @story_id, @confidence, @signals_json, @candidates_json)
`);

const countDistinctSourcesStmt = db.prepare('SELECT COUNT(DISTINCT source) AS count FROM articles WHERE story_id = ?');

function toCandidateShape(storyRow) {
  return {
    id: storyRow.id,
    title: storyRow.title,
    latestTitle: storyRow.latest_title,
    latestDescription: storyRow.latest_description,
    entities: storyRow.entities_json ? JSON.parse(storyRow.entities_json) : [],
    embedding: deserializeEmbedding(storyRow.embedding),
    firstPublishedAt: storyRow.first_published_at,
    latestPublishedAt: storyRow.latest_published_at,
  };
}

function filterCandidatesByTimeWindow(storyRows, article) {
  const articlePublishedAt = new Date(article.published_at);
  if (Number.isNaN(articlePublishedAt.getTime())) return [];

  return storyRows
    .filter((story) => {
      const latest = new Date(story.latest_published_at);
      const first = new Date(story.first_published_at);
      if (Number.isNaN(latest.getTime()) || Number.isNaN(first.getTime())) return false;
      const hoursSinceLatest = Math.abs(articlePublishedAt.getTime() - latest.getTime()) / (1000 * 60 * 60);
      const hoursSinceFirst = Math.abs(articlePublishedAt.getTime() - first.getTime()) / (1000 * 60 * 60);
      return hoursSinceLatest <= TIME_WINDOW_HOURS && hoursSinceFirst <= STORY_MAX_LIFETIME_HOURS;
    })
    .sort((a, b) => new Date(b.latest_published_at) - new Date(a.latest_published_at))
    .slice(0, CANDIDATE_STORY_POOL_SIZE);
}

function laterOf(a, b) {
  if (!a) return b;
  if (!b) return a;
  return new Date(a) > new Date(b) ? a : b;
}

function logDecision(article, decision) {
  if (!LOG_CLUSTER_DECISIONS) return;
  insertClusterDecisionStmt.run({
    article_id: article.id,
    action: decision.action,
    story_id: decision.story ? decision.story.id : null,
    confidence: decision.confidence,
    signals_json: decision.signals ? JSON.stringify(decision.signals) : null,
    candidates_json: JSON.stringify(decision.allCandidateScores),
  });
}

function createStoryForArticle(article, now) {
  const entities = extractEntities([article.title, article.description].filter(Boolean).join(' '));
  const quality = computeQuality(article, now);
  const result = insertStoryStmt.run({
    title: article.title,
    summary: article.description,
    category: article.category,
    language: article.language || 'en',
    entities_json: JSON.stringify(entities),
    latest_title: article.title,
    latest_description: article.description,
    representative_article_id: article.id,
    representative_quality: quality,
    first_published_at: article.published_at,
    latest_published_at: article.published_at,
    embedding: serializeEmbedding(article.embedding),
  });
  return result.lastInsertRowid;
}

function mergeArticleIntoStory(article, story, now) {
  const entities = extractEntities([article.title, article.description].filter(Boolean).join(' '));
  const mergedEntities = new Set([...toCandidateShape(story).entities, ...entities]);

  const articleQuality = computeQuality(article, now);
  const currentQuality = story.representative_quality ?? -Infinity;
  const promoteToRepresentative = articleQuality > currentQuality + REPRESENTATIVE_SWITCH_MARGIN;

  // +1 for this article, which isn't written yet at count time.
  const existingDistinctSources = countDistinctSourcesStmt.get(story.id).count;
  const sourceAlreadyPresent = db
    .prepare('SELECT 1 FROM articles WHERE story_id = ? AND source = ? LIMIT 1')
    .get(story.id, article.source);
  const newSourceCount = existingDistinctSources + (sourceAlreadyPresent ? 0 : 1);

  // Incremental update (see mergeStories for the full-recompute version).
  const updatedCentroid = updateCentroid(deserializeEmbedding(story.embedding), story.article_count, article.embedding);

  updateStoryOnMergeStmt.run({
    id: story.id,
    source_count: newSourceCount,
    latest_title: article.title,
    latest_description: article.description,
    entities_json: JSON.stringify([...mergedEntities]),
    latest_published_at: laterOf(story.latest_published_at, article.published_at),
    representative_article_id: promoteToRepresentative ? article.id : story.representative_article_id,
    title: promoteToRepresentative ? article.title : story.title,
    summary: promoteToRepresentative ? article.description : story.summary,
    representative_quality: promoteToRepresentative ? articleQuality : story.representative_quality,
    embedding: serializeEmbedding(updatedCentroid),
  });
}

// See "clusterNewArticles" in docs/clusterer-orchestration.md.
async function clusterNewArticles() {
  const now = new Date();
  const unclustered = selectUnclusteredArticlesStmt.all();

  for (const article of unclustered) {
    article.embedding = await getEmbedding([article.title, article.description].filter(Boolean).join(' '));

    const candidateRows = selectCandidateStoriesStmt.all(
      article.language || 'en',
      article.category,
      CANDIDATE_STORY_POOL_SIZE * SQL_FETCH_MULTIPLIER
    );
    const timeFiltered = filterCandidatesByTimeWindow(candidateRows, article);
    const candidates = timeFiltered.map(toCandidateShape);

    const decision = decideAssignment(article, candidates);
    logDecision(article, decision);

    if (decision.action === 'merge') {
      const storyRow = candidateRows.find((row) => row.id === decision.story.id);
      mergeArticleIntoStory(article, storyRow, now);
      assignArticleStoryIdStmt.run(storyRow.id, article.id);
    } else {
      const newStoryId = createStoryForArticle(article, now);
      assignArticleStoryIdStmt.run(newStoryId, article.id);
    }
    updateArticleEmbeddingStmt.run(serializeEmbedding(article.embedding), article.id);
  }

  return unclustered.length;
}

// See "mergeStories: the reconciliation mechanism" in
// docs/clusterer-orchestration.md.
function mergeStories(sourceStoryId, targetStoryId) {
  if (sourceStoryId === targetStoryId) {
    throw new Error('Cannot merge a story into itself');
  }
  const source = db.prepare('SELECT * FROM stories WHERE id = ?').get(sourceStoryId);
  const target = db.prepare('SELECT * FROM stories WHERE id = ?').get(targetStoryId);
  if (!source || !target) {
    throw new Error('Both source and target stories must exist');
  }

  const merge = db.transaction(() => {
    db.prepare('UPDATE articles SET story_id = ? WHERE story_id = ?').run(targetStoryId, sourceStoryId);

    const members = db.prepare('SELECT * FROM articles WHERE story_id = ?').all(targetStoryId);
    const distinctSourceCount = new Set(members.map((m) => m.source)).size;
    const mergedEntities = new Set([
      ...toCandidateShape(source).entities,
      ...toCandidateShape(target).entities,
    ]);
    const firstPublishedAt = members.reduce(
      (min, m) => (!min || new Date(m.published_at) < new Date(min) ? m.published_at : min),
      null
    );
    const latestPublishedAt = members.reduce((max, m) => laterOf(max, m.published_at), null);

    let centroid = null;
    let centroidCount = 0;
    for (const member of members) {
      const memberEmbedding = deserializeEmbedding(member.embedding);
      if (!memberEmbedding) continue;
      centroid = updateCentroid(centroid, centroidCount, memberEmbedding);
      centroidCount += 1;
    }

    db.prepare(
      `UPDATE stories SET article_count = ?, source_count = ?, entities_json = ?,
         first_published_at = ?, latest_published_at = ?, embedding = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(
      members.length,
      distinctSourceCount,
      JSON.stringify([...mergedEntities]),
      firstPublishedAt,
      latestPublishedAt,
      serializeEmbedding(centroid),
      targetStoryId
    );

    db.prepare(
      `UPDATE stories SET status = 'merged', merged_into_story_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(targetStoryId, sourceStoryId);
  });
  merge();
}

// See "resolveActiveStory" in docs/clusterer-orchestration.md.
function resolveActiveStory(storyId) {
  let story = db.prepare('SELECT * FROM stories WHERE id = ?').get(storyId);
  const visited = new Set();
  while (story && story.status === 'merged' && story.merged_into_story_id && !visited.has(story.id)) {
    visited.add(story.id);
    story = db.prepare('SELECT * FROM stories WHERE id = ?').get(story.merged_into_story_id);
  }
  return story || null;
}

module.exports = {
  clusterNewArticles,
  mergeStories,
  resolveActiveStory,
};
