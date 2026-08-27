# News Khabri backend — notes for AI agents

This file is for Claude and any other model working in this repo. It
covers what isn't obvious from reading the code cold: the pipeline's
shape, and conventions this codebase actually follows (as opposed to
generic Node/Express defaults).

The frontend that consumes this API lives in a sibling repo,
`news-khabri` (Expo/React Native). It has its own `AGENTS.md`.

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
(`clustering-config.js`, `ranking-config.js`, `tier-config.js`) — the
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
disable this if the table grows too large in practice.

## Schema migrations: a guarded `ALTER TABLE`, not a migration framework

There's no migration tool. New columns are added in `src/db/index.js`
via `PRAGMA table_info(<table>)` to check whether a column already
exists, then `ALTER TABLE ... ADD COLUMN` if not — this runs on every
boot and is idempotent. Follow this exact pattern for any new column;
don't reach for a migration library, and don't assume a fresh
`CREATE TABLE` will pick up a new column on an existing `articles.db` —
it won't, the guarded `ALTER TABLE` is what does.

## `require.main === module` — side effects only run when launched directly

`src/index.js` gates cron scheduling, the initial `refreshSourcesAndFetch()`
call, and `app.listen()` behind `if (require.main === module)`. When
`supertest` (or anything else) `require()`s the module to get `app` for
route tests, none of that fires — no live network fetches, no extra
port binding, no cron timers running during a test suite. Keep any new
top-level side effect inside that same guard, or a test importing this
file will trigger it.

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

- This is **not currently a git repository** (no `.git`). There's no
  commit history to lean on — be extra careful with anything
  destructive, and mention to the user if `git init` would help before
  doing something hard to undo by hand.
- `articles.db` (the real SQLite file) and its timestamped `.bak-*`
  copies sit at the repo root, alongside several `server*.log` files
  from past manual runs. These are working artifacts, not something to
  commit or clean up unprompted — leave them alone unless the user asks.
