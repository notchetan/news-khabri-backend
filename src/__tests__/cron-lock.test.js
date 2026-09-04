process.env.DB_PATH = ':memory:';

const db = require('../db');
const { withCronLock } = require('../services/cron-lock');
const { STALE_LOCK_MS } = require('../services/cron-lock-config');

beforeEach(() => {
  db.exec('DELETE FROM cron_locks');
});

test('runs the job when no lock is held', async () => {
  const fn = jest.fn();
  await withCronLock('job-a', fn);
  expect(fn).toHaveBeenCalledTimes(1);
});

test('releases the lock once the job finishes successfully', async () => {
  await withCronLock('job-a', jest.fn());
  expect(db.prepare('SELECT * FROM cron_locks WHERE job_name = ?').get('job-a')).toBeUndefined();
});

test('releases the lock even when the job throws, so the next tick can still run', async () => {
  await expect(
    withCronLock('job-a', () => {
      throw new Error('boom');
    })
  ).rejects.toThrow('boom');

  expect(db.prepare('SELECT * FROM cron_locks WHERE job_name = ?').get('job-a')).toBeUndefined();
});

test('skips a run of the same job while an earlier run is still holding the lock', async () => {
  let releaseFirst;
  const firstStillRunning = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const secondFn = jest.fn();

  // withCronLock acquires the lock synchronously before its first await,
  // so by the time this line returns (a pending promise, since fn hasn't
  // resolved yet), the lock row already exists.
  const first = withCronLock('job-a', () => firstStillRunning);

  await withCronLock('job-a', secondFn);
  expect(secondFn).not.toHaveBeenCalled();

  releaseFirst();
  await first;
});

test('a fresh lock held by another process is respected, not taken over', async () => {
  db.prepare('INSERT INTO cron_locks (job_name, holder_id, locked_at) VALUES (?, ?, ?)').run(
    'job-a',
    'other-process',
    new Date().toISOString()
  );

  const fn = jest.fn();
  await withCronLock('job-a', fn);

  expect(fn).not.toHaveBeenCalled();
});

test('a stale lock (older than STALE_LOCK_MS - an abandoned run) is taken over', async () => {
  db.prepare('INSERT INTO cron_locks (job_name, holder_id, locked_at) VALUES (?, ?, ?)').run(
    'job-a',
    'crashed-process',
    new Date(Date.now() - STALE_LOCK_MS - 1000).toISOString()
  );

  const fn = jest.fn();
  await withCronLock('job-a', fn);

  expect(fn).toHaveBeenCalledTimes(1);
  // And releases cleanly afterwards, same as any other run.
  expect(db.prepare('SELECT * FROM cron_locks WHERE job_name = ?').get('job-a')).toBeUndefined();
});

test('different job names have independent locks', async () => {
  let releaseB;
  const bStillRunning = new Promise((resolve) => {
    releaseB = resolve;
  });
  const aFn = jest.fn();

  const bPromise = withCronLock('job-b', () => bStillRunning);
  await withCronLock('job-a', aFn);

  expect(aFn).toHaveBeenCalledTimes(1);
  releaseB();
  await bPromise;
});
