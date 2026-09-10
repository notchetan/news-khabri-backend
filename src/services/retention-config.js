// Rolling-window retention so nothing ingestion keeps adding grows forever.
// Pruned daily - see services/retention.js, docs/retention.md and the cron in
// index.js. Config-file-not-inline-numbers, same as ranking-config.js etc.

// read_events feeds personalized ranking, which itself only ever looks at
// the last READ_HISTORY_DAYS (30) and caps at READ_HISTORY_LIMIT rows per
// user - see personalization-config.js. 90 keeps a 3x safety margin in
// case that window is widened later, while still bounding the table.
const READ_EVENTS_RETENTION_DAYS = 90;

// cluster_decisions is a debug/ops trail only - never read by any API
// route (see AGENTS.md). At 30 days it was 280 MB of a 740 MB DB after only
// 12 days of data; a week is still enough to chase a merge noticed in the feed.
const CLUSTER_DECISIONS_RETENTION_DAYS = 7;

// Whole stories no feed has listed for this long (bookmarked/read ones are
// kept). ~2 GB steady state at current ingest - see docs/retention.md.
const ARTICLES_RETENTION_DAYS = 60;

// Daily at 04:10 - after the 03:00 source rediscovery + full fetch has
// settled, and off the every-5-minutes notification tick.
const RETENTION_CRON = '10 4 * * *';

module.exports = {
  READ_EVENTS_RETENTION_DAYS,
  CLUSTER_DECISIONS_RETENTION_DAYS,
  ARTICLES_RETENTION_DAYS,
  RETENTION_CRON,
};
