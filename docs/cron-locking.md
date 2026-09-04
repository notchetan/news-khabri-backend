# Cron job locking (`services/cron-lock.js`)

Every scheduled job in `index.js` is wrapped in `withCronLock(jobName, fn)`.

## Why this is a real, current bug - not just a future multi-instance one

`node-cron` fires a schedule's callback at every tick regardless of
whether the *previous* tick's callback has finished. Nothing in this
codebase stopped `fetchTier('fast')` (`*/15 * * * *`) from starting a
second, overlapping run of itself if the first one - a real network fetch
across every fast-tier source plus Stage 2 clustering - happened to take
longer than 15 minutes on a slow day. That's a same-process,
single-instance bug: no horizontal scaling required to hit it, just a
slow tick.

It would *also* cover the case of this process ever running as more than
one instance sharing the same database (two identical schedules firing
together would double-fetch and double-notify) - but that's speculative
given this app's current single-SQLite-file deploy story, not something
being designed around specifically. The lock is a DB row rather than an
in-memory flag for exactly this reason: it costs nothing extra to also
cover the multi-instance case, so there was no reason to build something
narrower that only handles the same-process overlap.

## How it works

One row per job name in `cron_locks`, held only while that job is
actually running:

```sql
CREATE TABLE cron_locks (
  job_name TEXT PRIMARY KEY,
  holder_id TEXT NOT NULL,
  locked_at TEXT NOT NULL
)
```

`withCronLock` tries to acquire with a single atomic upsert:

```sql
INSERT INTO cron_locks (job_name, holder_id, locked_at)
VALUES (@jobName, @holderId, @now)
ON CONFLICT(job_name) DO UPDATE SET
  holder_id = excluded.holder_id, locked_at = excluded.locked_at
WHERE cron_locks.locked_at < @staleBefore
```

No existing row -> plain insert, always succeeds. An existing row whose
`locked_at` is still fresh -> the `WHERE` on the `DO UPDATE` fails, so the
statement is a no-op and `changes()` reports `0` - `withCronLock` treats
that as "someone else is already running this" and skips the tick
entirely (logged, not an error). An existing row older than
`STALE_LOCK_MS` (`cron-lock-config.js`, 30 minutes) -> the `WHERE`
matches, the row is claimed, `changes()` reports `1`, the job runs.

The lock is released in a `finally`, so a job that throws still frees it
for the next tick - and the release is `DELETE ... WHERE job_name = ? AND
holder_id = ?`, not an unconditional delete, so a run that overran
`STALE_LOCK_MS` and had its lock claimed by a fresher tick can't delete
that fresher tick's lock out from under it on its own (late) way out.

`HOLDER_ID` is one `crypto.randomUUID()` generated at module load, shared
by every job this process runs - it only has to be unique *per process*,
not per job, since the lock is already scoped by `job_name`.

## What this doesn't solve

The slow-model-load-blocking-request-handling half of "cron shares the
API process" (the embeddings model, `@huggingface/transformers`, loaded
in-process) is a separate, already-tracked concern - moving that out of
the API process is its own, larger change coupled to a hosting decision
that hasn't been made yet. This only fixes jobs re-entering themselves or
each other.
