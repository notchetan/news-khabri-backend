// If a job holds its lock longer than this without releasing it, treat
// the lock as abandoned (the process that held it crashed, or was killed,
// without reaching the `finally`) and let the next tick take over - see
// services/cron-lock.js. Set comfortably above the slowest real job: a
// full daily refreshSourcesAndFetch (discovery + fetching every source +
// clustering) can genuinely run several minutes, and this needs to stay
// well clear of that so a still-healthy long run is never preempted mid-way.
const STALE_LOCK_MS = 30 * 60 * 1000; // 30 minutes

module.exports = { STALE_LOCK_MS };
