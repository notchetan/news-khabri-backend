// Personalized ranking from read history - see docs/personalization.md.
const db = require('../db');
const { jaccardSimilarity } = require('./text-similarity');
const {
  READ_HISTORY_LIMIT,
  READ_HISTORY_DAYS,
  PERSONALIZATION_SUB_WEIGHTS,
} = require('./personalization-config');

const getRecentReadsStmt = db.prepare(`
  SELECT category, source, entities_json FROM read_events
  WHERE user_id = ? AND read_at >= ?
  ORDER BY read_at DESC
  LIMIT ?
`);

// Builds a lightweight profile of a user's recent reading (category/source
// frequency, a merged entity set) from read_events - call this once per
// request and reuse the same profile across every story being scored,
// rather than re-querying read_events per story. Returns null for a signed-
// out request (no userId) or a signed-in user with no read history yet -
// computePersonalizationSignal treats null the same way in both cases: no
// signal, ranking falls back to exactly what it was before this feature.
function loadReadProfile(userId) {
  if (!userId) return null;
  const cutoff = new Date(Date.now() - READ_HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const rows = getRecentReadsStmt.all(userId, cutoff, READ_HISTORY_LIMIT);
  if (rows.length === 0) return null;

  const categoryCounts = new Map();
  const sourceCounts = new Map();
  const entities = new Set();
  for (const row of rows) {
    if (row.category) categoryCounts.set(row.category, (categoryCounts.get(row.category) || 0) + 1);
    if (row.source) sourceCounts.set(row.source, (sourceCounts.get(row.source) || 0) + 1);
    if (row.entities_json) {
      for (const entity of JSON.parse(row.entities_json)) entities.add(entity);
    }
  }
  return { categoryCounts, sourceCounts, entities, totalReads: rows.length };
}

// 0-1 signal: how well `story` matches a user's recent reading, per
// loadReadProfile's profile - 0 for a null profile (signed out, or no
// history yet), so an anonymous/first-time request's ranking is completely
// unaffected by this signal. Blends three sub-signals (weights in
// personalization-config.js): what fraction of the user's recent reads were
// this category, the strongest source-affinity among the story's own
// member articles (a story has several sources, not one - `stories` itself
// has no `source` column, unlike `articles` - so this takes the best match
// across `memberArticles` rather than a single value), and entity overlap
// (jaccardSimilarity - the exact same function clustering.js already uses
// for entityOverlap between two stories, here pointed at a story's entities
// vs. the user's own merged recent-read entity set instead).
function computePersonalizationSignal(profile, story, memberArticles = []) {
  if (!profile) return 0;

  const categoryAffinity = story.category
    ? (profile.categoryCounts.get(story.category) || 0) / profile.totalReads
    : 0;

  let sourceAffinity = 0;
  for (const article of memberArticles) {
    const affinity = article.source
      ? (profile.sourceCounts.get(article.source) || 0) / profile.totalReads
      : 0;
    if (affinity > sourceAffinity) sourceAffinity = affinity;
  }

  const storyEntities = story.entities_json ? new Set(JSON.parse(story.entities_json)) : new Set();
  const entityAffinity = jaccardSimilarity(storyEntities, profile.entities);

  return (
    PERSONALIZATION_SUB_WEIGHTS.category * categoryAffinity +
    PERSONALIZATION_SUB_WEIGHTS.source * sourceAffinity +
    PERSONALIZATION_SUB_WEIGHTS.entity * entityAffinity
  );
}

module.exports = { loadReadProfile, computePersonalizationSignal };
