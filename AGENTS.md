# News Khabri backend — notes for AI agents

This file is for Claude and any other model working in this repo. It
covers what isn't obvious from reading the code cold: the pipeline's
shape, and conventions this codebase actually follows (as opposed to
generic Node/Express defaults).

The frontend that consumes this API lives in a sibling repo,
`news-khabri` (Expo/React Native). It has its own `AGENTS.md`.

## Comment convention

Keep inline comments short - a line or two of "why", right next to the
code it explains. A comment that would run 5+ lines (a threshold's full
calibration history, a real-data investigation, a design tradeoff with
alternatives considered) belongs in its own file under `docs/` instead,
with a one-line pointer left in the code (`// See docs/whatever.md.`).
This repo's `docs/clustering-tuning.md` and `docs/ranking-tuning.md` are
the biggest examples - every threshold in `clustering-config.js`/
`ranking-config.js` has its full backstory there, not inline. Skip
comments that only restate what a past bug was and that it's fixed now -
that belongs in the PR/commit history, not the code. `docs/` is organized
by topic, not 1:1 with source files - check whether an existing doc
already covers the area before creating a new one.

## What this is

Node/Express + `better-sqlite3` (synchronous, no ORM) + `node-cron`.
Pulls articles from Indian publishers' RSS feeds, clusters same-event
coverage across sources into "stories", ranks everything, and serves it
via a small REST API (`src/routes/articles.js`, `src/routes/stories.js`).
No git history to check for context — treat comments in the code as the
primary record of *why*, not just commit messages you won't find.

Pipeline, in order:

1. **Discovery** (`ingestion/discovery.js`) — finds each publisher's
   section RSS feeds.
2. **Fetch** (`ingestion/fetcher.js`) — pulls new items from registered
   feeds into `articles`. Scheduled per-source at a cadence based on how
   often that publisher actually posts, not one interval for everyone —
   see `ingestion/tier-tracker.js` / `services/tier-config.js` for how a
   source's tier (fast/medium/slow) gets computed and re-computed daily.
3. **Stage 1 — importance/ranking** (`services/ranking.js` +
   `services/ranking-config.js`) — per-article score from recency,
   source authority, keyword-based importance.
4. **Stage 2 — clustering** (`services/clustering.js` +
   `ingestion/clusterer.js` + `services/clustering-config.js`) — groups
   same-event articles into `stories` rows via jaccard text similarity +
   entity overlap + time proximity. Runs incrementally: it only ever
   looks at articles with `story_id IS NULL`, so it's naturally safe to
   call after every fetch cycle regardless of which tier triggered it.
5. **Stage 3 — semantic similarity** (`services/embeddings.js`) — a
   local sentence-embedding model (`Xenova/all-MiniLM-L6-v2` via
   `@huggingface/transformers`, no hosted API) adds a semantic-similarity
   signal into Stage 2's clustering decision, on top of (not replacing)
   the lexical signals — see `clustering-config.js`'s own comments for
   why this stays additive and English-only for now.
6. **Story ranking** (`services/story-ranking.js`) — aggregates
   member-article scores + source count + momentum into a per-story
   score for `/stories/top`.

## The core convention: config files, not inline numbers

Every tunable threshold/weight lives in a dedicated `*-config.js` file
(`clustering-config.js`, `ranking-config.js`, `tier-config.js`,
`retention-config.js`, `push-notifications-config.js`) — the
logic files (`clustering.js`, `ranking.js`, etc.) never hardcode a
number. **Read the comments in these config files before touching any
threshold.** They're not generic explanations — most of them cite a
*specific real result* that justified the current value (an exact
headline pair, an exact score it landed at, why that was wrong, what
changing it broke or fixed). That's the standard to match if you change
one: trace a real bad result back to the responsible term using
`cluster_decisions` (see below), change the value, then re-run the full
relevant test suite (`clustering.test.js`, `story-ranking.test.js`,
etc.) and confirm nothing else regressed. Don't guess a number because
it "feels right" — every existing value in these files came from doing
this the slow way, and it shows in what they actually catch.

The recurring design bias, stated explicitly in `clustering-config.js`'s
own header comment: **false merges (unrelated articles grouped as one
story) are worse than missed merges (the same story split across two
entries).** Any new tunable should default toward that same asymmetry
unless there's a specific reason not to.

## `cluster_decisions` — the debugging trail, not an API concern

Every clustering decision (merge or create) gets logged to the
`cluster_decisions` table, including every *candidate* story considered
and its full signal breakdown — not just the winner. This is purely an
operational/debugging artifact for tracing false and missed merges
against real ingested data; it's never read by any API route. If you're
investigating "why did/didn't these two articles cluster", query this
table for the article's `id` before trying to reason about it from the
config alone. `clustering-config.js`'s `LOG_CLUSTER_DECISIONS` flag can
disable this entirely; the daily retention cron (`services/retention.js`,
`services/retention-config.js`) also prunes rows older than
`CLUSTER_DECISIONS_RETENTION_DAYS` (30) - and `read_events` older than
`READ_EVENTS_RETENTION_DAYS` (90) - so neither append-only table grows
without bound.

## Schema migrations: a guarded `ALTER TABLE`, not a migration framework

There's no migration tool. New columns are added in `src/db/index.js`
via `PRAGMA table_info(<table>)` to check whether a column already
exists, then `ALTER TABLE ... ADD COLUMN` if not — this runs on every
boot and is idempotent. Follow this exact pattern for any new column;
don't reach for a migration library, and don't assume a fresh
`CREATE TABLE` will pick up a new column on an existing `articles.db` —
it won't, the guarded `ALTER TABLE` is what does.

One thing `ALTER TABLE` genuinely *can't* do in SQLite is drop a `NOT
NULL` (or change a column's constraints). The `users` table needed exactly
that when Apple sign-in landed — `google_id` went from `UNIQUE NOT NULL`
to nullable — so `db/index.js` does the standard SQLite table rebuild
(`foreign_keys OFF`, create-new / copy / drop / rename in a transaction,
`foreign_keys ON`), still guarded (on the old constraint being present) so
it runs at most once and never on a fresh DB. See `docs/apple-sign-in.md`.
Reach for this only when `ALTER` truly can't express the change.

The connection opens in `journal_mode = WAL` / `synchronous = NORMAL` (a
no-op for the `:memory:` test DB) — so a real deployment's `articles.db`
grows `-wal` / `-shm` sidecar files; back up / copy all three together,
or checkpoint first.

`db/index.js` growing longer as more tables/columns land is the expected
shape of this approach, not a problem to fix by introducing a numbered-
migrations runner — that was floated once and deliberately not adopted;
a migration framework buys ordering/rollback machinery this single-file
SQLite app with no team of migration authors doesn't need, at the cost of
another layer to learn and debug. The one real, fixable issue this file
did have — the one-time `articles_fts` backfill re-running a full
`COUNT(*)` scan of both `articles` and `articles_fts` on *every* boot
forever, not just checking whether the backfill had already happened —
is fixed: `EXISTS (... LIMIT 1)` instead of `COUNT(*)`, so it's O(1) once
either table has a single row, which is true on every boot after the
first.

## `require.main === module` — side effects only run when launched directly

`src/index.js` gates cron scheduling, the initial `refreshSourcesAndFetch()`
call, and `app.listen()` behind `if (require.main === module)`. When
`supertest` (or anything else) `require()`s the module to get `app` for
route tests, none of that fires — no live network fetches, no extra
port binding, no cron timers running during a test suite. Keep any new
top-level side effect inside that same guard, or a test importing this
file will trigger it.

The listener itself (still inside that guard) reads `PORT` from the
environment and installs a `SIGTERM`/`SIGINT` handler that `server.close()`s
and `db.close()`s before exit, with a 10s force-exit fallback.

Every scheduled job (and the initial `refreshSourcesAndFetch()` call) is
wrapped in `services/cron-lock.js`'s `withCronLock(jobName, fn)` — a DB-row
lock, not an in-memory flag, so a job whose run outlasts its own cron
interval can't start a second overlapping run of itself. See
`docs/cron-locking.md`. Wrap any new scheduled job in it too.

## App-level middleware: helmet, CORS allowlist, rate limits, `/healthz`

`app` (module scope, so route tests see it too) is wrapped in `helmet()`,
a `cors()` whose origin comes from `CORS_ORIGIN` (comma-separated; unset =
reflect any origin), `express.json({ limit: '16kb' })`, and two
`express-rate-limit` instances — a 600/15min global limiter and a 30/15min
limiter on the sign-in routes (`POST /auth/google` and `POST /auth/apple` —
see `docs/apple-sign-in.md`). **Both limiters `skip` when
`NODE_ENV === 'test'`** so the suite's many sequential requests from one
address don't trip them; a test that needs to exercise limiting has to
opt back in itself. `GET /healthz` (`{ status, uptime }`, no auth) is
registered *before* the global limiter so a monitor pinging it can't be
throttled.

## Logging: `src/logger.js` (pino), not `console.*`

There is one shared `logger` (a pino instance). `console.log`/`error`/`warn`
were all replaced by `logger.info({ ...fields }, 'lower-case message')`;
use the same shape for anything new. `pino-http` logs one line per
request in `index.js` (skipping `/healthz`). Under `NODE_ENV=test` the
level is `silent`, so the suite is quiet and there's no transport worker
to leak past Jest; `LOG_LEVEL` overrides. Dev output is `pino-pretty`
(a devDependency), production is JSON.

## Request validation: `middleware/validate.js` + colocated zod schemas

Every route that reads a request **body** or a numeric **`:id` path
param** runs it through `validate({ body, params })` (a small wrapper over
`schema.safeParse`) before the handler. On failure it's a uniform
`400 { error: 'Invalid request', details: [{ path, message }] }`. `body`
is *replaced* with the parsed value (coerced, unknown keys stripped), so
handlers read `req.body.articleId` as a number directly; `params` is only
checked, not reassigned, so handlers keep their own `Number(...)`. Schemas
live at the top of each route file, not a central folder. **The list/feed
*query* params (`language`, `category`, `limit`, `sources`, `cursor`,
`search`) are deliberately still parsed leniently in the handler** -
missing falls back to a default, junk is clamped - so the feed never 400s
a reader over a stray query string.

## Graceful degradation over throwing, for optional signals

`services/embeddings.js`'s `getEmbedding` never throws — a failed model
load or inference returns `null`, and every caller already treats a
missing embedding as "no semantic signal available" rather than a hard
error that would crash ingestion over one bad article. This is the
established shape for any signal that's an *enhancement* on top of a
system that already works without it: fail soft, let the caller's
existing "signal absent" path handle it, don't propagate the exception
up through ingestion.

## Testing conventions

- `npm test` (whole suite) after any change — `jest.config.js` runs
  everything under `src/__tests__/**/*.test.js`, `testEnvironment:
  'node'`.
- File naming signals intent: `foo.test.js` unit-tests one module in
  isolation (mocking its collaborators); `foo-integration.test.js`
  exercises real cross-module behavior — real DB writes against an
  in-memory `:memory:` SQLite instance (`process.env.DB_PATH =
  ':memory:'` at the top of the file), real parsing/extraction logic —
  with only genuine *external* I/O (network calls, e.g. `rss-parser` or
  `global.fetch`) mocked. Neither kind hits the real network or a real
  model; both run fast and deterministically as part of the normal
  suite, there's no separate slow/opt-in test tier here currently.
- `jest.config.js` transforms all of `node_modules` through `babel-jest`
  (`transformIgnorePatterns: []`) rather than chasing individual
  ESM-only transitive deps by name (`jsdom` pulls in several) — if a new
  dependency needs special transform handling, extend `transform`
  there rather than adding it to an ignore-pattern allowlist.
- Route tests use `supertest` against the exported `app` (see the
  `require.main === module` note above for why this is safe to import
  directly).

## Repo state

- Hosted at `github.com/notchetan/news-khabri-backend`, public,
  `main` branch-protected (PR-only, no direct pushes, even for the repo
  owner). Work on a feature/fix branch and open a PR - a direct push to
  `main` will be rejected. CI (`.github/workflows/ci.yml`) runs `npm
  test` on every PR push.
- **Node version matters more than usual here**: `jsdom@30`'s bundled
  `undici` requires Node `^22.22.2 || ^24.15.0 || >=26.0.0` (see this
  repo's own `engines` field) - anything else, including plain Node 20
  or an early Node 22 patch, crashes the moment `jsdom` is
  `require()`'d (`article-scraper.js`, and anything that imports it)
  with `TypeError: webidl.util.markAsUncloneable is not a function`.
  This was found the hard way: it passed silently in local dev (already
  on a satisfying Node version) and only surfaced once CI ran on a
  pinned Node 20.
- `articles.db` (the real SQLite file) and its timestamped `.bak-*`
  copies sit at the repo root, alongside several `server*.log` files
  from past manual runs. These are working artifacts, not something to
  commit or clean up unprompted — leave them alone unless the user asks.
