const db = require('../db');
const {
  READ_EVENTS_RETENTION_DAYS,
  CLUSTER_DECISIONS_RETENTION_DAYS,
  ARTICLES_RETENTION_DAYS,
} = require('./retention-config');

// Every timestamp compared here is TEXT in SQLite's own CURRENT_TIMESTAMP
// format ('YYYY-MM-DD HH:MM:SS', UTC), which datetime('now', ...) also
// produces - so a plain string `<` comparison is a correct chronological one.
const deleteOldReadEvents = db.prepare(
  "DELETE FROM read_events WHERE read_at < datetime('now', ?)"
);
const deleteOldClusterDecisions = db.prepare(
  "DELETE FROM cluster_decisions WHERE created_at < datetime('now', ?)"
);
const cutoffStmt = db.prepare("SELECT datetime('now', ?) AS t");

// A story's articles go all together or not at all: none of them seen in a
// feed within the window, bookmarked, or read. See docs/retention.md.
const STALE_ARTICLE_IDS = `
  SELECT id FROM articles
  WHERE COALESCE(last_seen_at, fetched_at) < @cutoff
    AND id NOT IN (SELECT article_id FROM bookmarks)
    AND id NOT IN (SELECT article_id FROM read_events)
    AND (story_id IS NULL OR story_id NOT IN (
      SELECT story_id FROM articles
      WHERE story_id IS NOT NULL AND (
        COALESCE(last_seen_at, fetched_at) >= @cutoff
        OR id IN (SELECT article_id FROM bookmarks)
        OR id IN (SELECT article_id FROM read_events)
      )
    ))
`;
// articles_fts has no triggers (see docs/search.md) - clear it first, while
// the articles it matches still exist.
const deleteStaleFts = db.prepare(`DELETE FROM articles_fts WHERE rowid IN (${STALE_ARTICLE_IDS})`);
const deleteStaleArticles = db.prepare(`DELETE FROM articles WHERE id IN (${STALE_ARTICLE_IDS})`);
// updated_at keeps a just-merged (member-less) story resolvable; the last
// clause respects the merged_into_story_id foreign key.
const deleteEmptyStories = db.prepare(`
  DELETE FROM stories
  WHERE updated_at < @cutoff
    AND NOT EXISTS (SELECT 1 FROM articles WHERE articles.story_id = stories.id)
    AND NOT EXISTS (SELECT 1 FROM stories s WHERE s.merged_into_story_id = stories.id)
`);

// Trims everything to its configured rolling window, in one transaction.
// Returns the rows removed per table (for the cron's log line and the tests).
const pruneRetention = db.transaction(() => {
  // read_events first, so an expired read no longer protects its article.
  const readEvents = deleteOldReadEvents.run(`-${READ_EVENTS_RETENTION_DAYS} days`).changes;
  const clusterDecisions = deleteOldClusterDecisions.run(
    `-${CLUSTER_DECISIONS_RETENTION_DAYS} days`
  ).changes;
  // One cutoff for all three, so the FTS and articles deletes match the same rows.
  const cutoff = cutoffStmt.get(`-${ARTICLES_RETENTION_DAYS} days`).t;
  deleteStaleFts.run({ cutoff });
  const articles = deleteStaleArticles.run({ cutoff }).changes;
  const stories = deleteEmptyStories.run({ cutoff }).changes;
  return { readEvents, clusterDecisions, articles, stories };
});

module.exports = { pruneRetention };
