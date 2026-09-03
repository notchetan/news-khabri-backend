const db = require('../db');
const {
  READ_EVENTS_RETENTION_DAYS,
  CLUSTER_DECISIONS_RETENTION_DAYS,
} = require('./retention-config');

// read_at / created_at are TEXT in SQLite's own CURRENT_TIMESTAMP format
// ('YYYY-MM-DD HH:MM:SS', UTC), which datetime('now', ...) also produces -
// so a plain string `<` comparison is a correct chronological one.
const deleteOldReadEvents = db.prepare(
  "DELETE FROM read_events WHERE read_at < datetime('now', ?)"
);
const deleteOldClusterDecisions = db.prepare(
  "DELETE FROM cluster_decisions WHERE created_at < datetime('now', ?)"
);

// Trims both append-only tables to their configured rolling windows.
// Returns the number of rows removed from each (for the cron's log line
// and the tests).
function pruneRetention() {
  const readEvents = deleteOldReadEvents.run(
    `-${READ_EVENTS_RETENTION_DAYS} days`
  ).changes;
  const clusterDecisions = deleteOldClusterDecisions.run(
    `-${CLUSTER_DECISIONS_RETENTION_DAYS} days`
  ).changes;
  return { readEvents, clusterDecisions };
}

module.exports = { pruneRetention };
