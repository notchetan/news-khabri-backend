# News Khabri backend

The ingestion, clustering, and ranking service behind
[News Khabri](https://github.com/notchetan/news-khabri-frontend), an
Indian news aggregator. This service pulls articles from Indian
publishers' public RSS feeds, groups same-event coverage across sources
into a single story, ranks everything by a mix of source count, recency,
and significance, and serves it all over a small REST API.

The frontend (Expo/React Native) that consumes this API lives in a
separate repo:
[news-khabri-frontend](https://github.com/notchetan/news-khabri-frontend).

## How it works

1. **Discovery** finds each publisher's section RSS feeds.
2. **Fetch** pulls new items into SQLite, per source, on a cadence based
   on how often that publisher actually posts (tracked and re-tiered
   daily) rather than one interval for everyone.
3. **Ranking (Stage 1)** scores each article on recency, source
   authority, and keyword-based importance.
4. **Clustering (Stage 2)** groups same-event articles from different
   publishers into a single "story" using text similarity and entity
   overlap.
5. **Semantic similarity (Stage 3)** adds a local sentence-embedding
   model on top of Stage 2 to catch same-event articles worded too
   differently for lexical matching alone to bridge.
6. **Story ranking** aggregates member articles' scores, source count,
   and momentum into a per-story score for the top-stories feed.

See [`AGENTS.md`](./AGENTS.md) for the detailed pipeline breakdown, file
map, and the conventions this codebase follows.

## Getting started

```bash
npm install
node src/index.js
```

The server listens on `PORT` (default 3000). On first boot it discovers
sources, does a full fetch, and schedules the recurring cron jobs (daily
source rediscovery, per-tier fetches, daily tier recompute) — see
`src/index.js`. `GET /healthz` is an unauthenticated liveness probe. On
`SIGTERM`/`SIGINT` the server drains its listener and closes the database
before exiting.

### Environment variables

See `.env.example`. `GOOGLE_WEB_CLIENT_ID` and `JWT_SECRET` are required
in any non-test run (`JWT_SECRET` throws at startup if unset); the rest
are optional.

| Variable | Default | Purpose |
| --- | --- | --- |
| `GOOGLE_WEB_CLIENT_ID` | — | Web OAuth client ID; the `audience` a Google ID token is verified against. |
| `JWT_SECRET` | — | Secret for signing this app's own session tokens. Required outside tests. |
| `PORT` | `3000` | Port to listen on. |
| `DB_PATH` | `articles.db` | SQLite database file path. Point at a mounted volume on a container host. |
| `CORS_ORIGIN` | — | Comma-separated allowed origins. Unset reflects any origin. |
| `ENABLE_RANKING_DEBUG` | — | Set to `true` to allow `?debug=true` on `/stories/top`. Never set in production. |
| `LOG_LEVEL` | `info` | pino level (`silent` under `NODE_ENV=test`). Pretty-printed in dev, JSON in prod. |

## API

| Route | Description |
| --- | --- |
| `GET /healthz` | Liveness probe (`{ status, uptime }`), no auth. |
| `GET /articles` | Paginated article feed (`language`, `category`, `cursor`, `search`, `limit`). |
| `GET /articles/top` | Ranked ("Top Stories") article feed. |
| `GET /articles/:id` | Single article, with related articles. |
| `GET /categories` | Categories available for a language. |
| `GET /languages` | Languages with at least one article. |
| `GET /stories/top` | Ranked, clustered stories feed. |
| `GET /stories/:id` | Single story with its member articles. |

## Scripts

| Command | Description |
| --- | --- |
| `npm test` | Run the Jest test suite |
| `npm run test:coverage` | Run tests with coverage |

## Project structure

```
src/
  index.js           Express app + cron scheduling entry point
  db/                 SQLite connection + schema (guarded ALTER TABLE migrations)
  routes/              /articles and /stories route handlers
  ingestion/           Discovery, fetching, scraping, clustering, tier tracking
  services/            Ranking, clustering, embeddings, and their *-config.js knobs
  __tests__/           Jest suite (foo.test.js unit, foo-integration.test.js cross-module)
```
