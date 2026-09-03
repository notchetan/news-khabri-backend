// Rolling-window retention for the two append-only tables that would
// otherwise grow forever (one row per article open, one per clustering
// decision). Pruned daily - see services/retention.js and the cron in
// index.js. Config-file-not-inline-numbers, same as ranking-config.js etc.

// read_events feeds personalized ranking, which itself only ever looks at
// the last READ_HISTORY_DAYS (30) and caps at READ_HISTORY_LIMIT rows per
// user - see personalization-config.js. 90 keeps a 3x safety margin in
// case that window is widened later, while still bounding the table.
const READ_EVENTS_RETENTION_DAYS = 90;

// cluster_decisions is a debug/ops trail only - never read by any API
// route (see AGENTS.md). Kept just long enough to investigate a recent
// bad or missed merge against real data.
const CLUSTER_DECISIONS_RETENTION_DAYS = 30;

// Daily at 04:10 - after the 03:00 source rediscovery + full fetch has
// settled, and off the every-5-minutes notification tick.
const RETENTION_CRON = '10 4 * * *';

module.exports = {
  READ_EVENTS_RETENTION_DAYS,
  CLUSTER_DECISIONS_RETENTION_DAYS,
  RETENTION_CRON,
};
