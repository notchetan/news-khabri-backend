# DB-touching clustering orchestration (`src/ingestion/clusterer.js`)

The only file that reads/writes the `stories`/`cluster_decisions` tables
or touches `articles.story_id`. The actual merge-or-create decision is
delegated to the pure `services/clustering.js` (see
[`clustering-pipeline.md`](./clustering-pipeline.md)) so that logic stays
framework/DB-free and independently unit-testable, mirroring how
`ingestion/fetcher.js` is the DB-touching counterpart to the pure
`services/ranking.js`.

## Why candidate filtering happens in JS, not SQL

`published_at` comes straight from RSS feeds (often RFC 2822, e.g. "Wed,
26 Aug 2026 15:30:57 +0000") and is stored as raw TEXT - NOT reliably
sortable/comparable as a SQL string (the existing `/articles` route
already works around this same issue by paginating on `fetched_at`
instead). So `selectCandidateStoriesStmt` only blocks by the cheap,
reliable columns (language, category, status) and a generous id-ordered
pool (`SQL_FETCH_MULTIPLIER`); the real time-window math happens in JS
afterward in `filterCandidatesByTimeWindow`, using proper `Date` parsing,
which also caps the final candidate list handed to the more expensive
similarity math at `CANDIDATE_STORY_POOL_SIZE`, most-recent first.

## No LIMIT on the unclustered-articles query

`selectUnclusteredArticlesStmt` has no `LIMIT` on purpose: it only ever
processes rows that haven't been clustered yet, which trends toward zero
as the backlog clears, and clustering runs as a background cron step (see
`index.js`), never inline with a user-facing request - there's no reason
to artificially cap and stretch a one-time historical backlog (e.g. right
after this migration first runs) across many 15-minute cron cycles when
it can safely clear in one pass instead.

## `clusterNewArticles`

The main incremental pass, called after `fetchAllFeeds()`. Only articles
with `story_id IS NULL` are considered; since the fetcher's `ON CONFLICT`
upsert preserves an article's id across re-fetches (see `fetcher.js`),
already-clustered articles are never re-touched.

Async since Stage 3: each article needs its embedding computed once
(`getEmbedding`) before `decideAssignment` can use the semantic signal -
the decision logic itself (`services/clustering.js`) stays
synchronous/pure, the embedding is just data by the time it gets there.

## `mergeStories`: the reconciliation mechanism

The *policy* of automatically detecting that two existing stories
describe the same event is a Stage 3 job - `mergeStories` is the
mechanism it would call into, not that policy itself. It repoints every
member article from `sourceStoryId` to `targetStoryId`, recomputes the
target's aggregates from its complete new membership, and marks the
source `status='merged'` rather than deleting it, so its id/history stay
resolvable.

The target's embedding centroid is recomputed from the full final
membership (not incrementally, unlike `mergeArticleIntoStory`'s
single-article update via `updateCentroid`), since this reconciles two
already-established stories, each already an accumulated centroid in its
own right.

## `resolveActiveStory`

Follows `merged_into_story_id` chains so a pre-merge id still resolves to
the canonical, currently-active story rather than 404ing.
