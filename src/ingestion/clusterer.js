// DB-touching orchestration for Stage 2 story clustering - the only file
// that reads/writes the `stories`/`cluster_decisions` tables or touches
// `articles.story_id`. The actual merge-or-create decision is delegated to
// the pure services/clustering.js so that logic stays framework/DB-free and
// independently unit-testable, mirroring how ingestion/fetcher.js is the
// DB-touching counterpart to the pure services/ranking.js.
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

// published_at comes straight from RSS feeds (often RFC 2822, e.g. "Wed, 26
// Aug 2026 15:30:57 +0000") and is stored as raw TEXT - NOT reliably
// sortable/comparable as a SQL string (the existing /articles route already
// works around this same issue by paginating on `fetched_at` instead). So
// the SQL query below only blocks by the cheap, reliable columns (language,
// category, status) and a generous id-ordered pool; the real time-window
// math happens in JS afterward using proper Date parsing.
const SQL_FETCH_MULTIPLIER = 4;

const selectCandidateStoriesStmt = db.prepare(`
  SELECT * FROM stories
  WHERE language = ? AND category = ? AND status = 'active'
  ORDER BY id DESC
  LIMIT ?
`);

// No LIMIT here on purpose: this only ever processes rows that haven't been
// clustered yet, which trends toward zero as the backlog clears, and
// clustering runs as a background cron step (see index.js), never inline
// with a user-facing request - there's no reason to artificially cap and
// stretch a one-time historical backlog (e.g. right after this migration
// first runs) across many 15-minute cron cycles when it can safely clear in
// one pass instead.
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

// Precise time-window filtering (real Date parsing, not SQL string
// comparison) - see the comment above SQL_FETCH_MULTIPLIER. Also caps the
// final candidate list handed to the (more expensive) similarity math at
// CANDIDATE_STORY_POOL_SIZE, most-recent first.
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

// The main incremental pass - call after fetchAllFeeds(). Only articles
// with story_id IS NULL are considered; since the fetcher's ON CONFLICT
// upsert preserves an article's id across re-fetches (see fetcher.js),
// already-clustered articles are never re-touched.
//
// Async since Stage 3: each article needs its embedding computed once
// (getEmbedding) before decideAssignment can use the semantic signal - the
// decision logic itself (services/clustering.js) stays synchronous/pure, the
// embedding is just data by the time it gets there.
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

// Reconciliation mechanism (the policy of automatically detecting that two
// existing stories describe the same event is a Stage 3 job - this is the
// mechanism it would call into). Repoints every member article from
// `sourceStoryId` to `targetStoryId`, recomputes the target's aggregates
// from its complete new membership, and marks the source `status='merged'`
// rather than deleting it, so its id/history stay resolvable.
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

    // Recomputed from the full final membership (not incrementally, unlike
    // mergeArticleIntoStory's single-article update) since this reconciles
    // two already-established stories, each already an accumulated centroid
    // in its own right.
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

// Follows merged_into_story_id chains so a pre-merge id still resolves to
// the canonical, currently-active story rather than 404ing.
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
