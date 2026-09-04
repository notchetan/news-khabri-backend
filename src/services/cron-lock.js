const crypto = require('crypto');
const db = require('../db');
const { STALE_LOCK_MS } = require('./cron-lock-config');
const logger = require('../logger');

// Guards a cron job against running twice at once - see docs/cron-locking.md
// for why this is a real, current bug (not just a future multi-instance
// concern): node-cron doesn't itself stop a schedule's next tick from
// firing while the previous tick is still running, and a slow fetch cycle
// genuinely can outlast its own interval. A DB row rather than an
// in-memory flag, so the same guard also covers this process ever being
// scaled to more than one instance sharing the database, without this code
// needing to know which case applies.
const HOLDER_ID = crypto.randomUUID();

const tryAcquire = db.prepare(`
  INSERT INTO cron_locks (job_name, holder_id, locked_at)
  VALUES (@jobName, @holderId, @now)
  ON CONFLICT(job_name) DO UPDATE SET
    holder_id = excluded.holder_id,
    locked_at = excluded.locked_at
  WHERE cron_locks.locked_at < @staleBefore
`);
const release = db.prepare('DELETE FROM cron_locks WHERE job_name = ? AND holder_id = ?');

// Runs `fn` only if no other run of `jobName` currently holds the lock;
// otherwise logs and skips this tick entirely. Always releases on the way
// out, success or failure, so a thrown error still frees the lock for the
// next tick rather than stranding it until STALE_LOCK_MS passes.
async function withCronLock(jobName, fn) {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_LOCK_MS);
  const result = tryAcquire.run({
    jobName,
    holderId: HOLDER_ID,
    now: now.toISOString(),
    staleBefore: staleBefore.toISOString(),
  });
  if (result.changes === 0) {
    logger.info({ job: jobName }, 'cron job already running - skipped this tick');
    return;
  }
  try {
    await fn();
  } finally {
    // Only release the lock if it's still ours - if this run took longer
    // than STALE_LOCK_MS and another holder has since taken over, don't
    // delete their fresh lock out from under them.
    release.run(jobName, HOLDER_ID);
  }
}

module.exports = { withCronLock };
