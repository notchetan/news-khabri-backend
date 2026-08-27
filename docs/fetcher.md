# RSS fetching (`src/ingestion/fetcher.js`)

## URL normalization for dedup

A publisher can list the same story more than once (e.g. once per
category feed it belongs to) with only tracking params or a trailing
slash differing between the links - `normalizeArticleUrl` strips
`TRACKING_PARAMS` and normalizes trailing slashes before a link is used
as the dedup key, or the `link` UNIQUE constraint won't catch them and the
same article shows up twice.

## NDTV Profit: per-article category from the URL path

NDTV Profit's "latest" feed (see `ingestion/discovery.js`'s
`NDTV_FALLBACK`) isn't purely business content the way its feed URL/name
implies - it's everything ndtvprofit.com publishes, including a
lifestyle/trending section. Found by tracing real "why is this
eclipse/movie-review article filed under Business" reports back to this
feed: ~40% of what it contributed to "business" wasn't business at all.

ndtvprofit.com's own URLs already encode which section an article is
actually in (`ndtvprofit.com/markets/...`, `/lifestyle/...`,
`/trending/...`), so `resolveArticleCategory` derives the real category
per-article from that path instead of the one blanket label the feed
registration gives every item. Its `trending` section maps to `opinion` -
a trending/viral aggregation section, same as Indian Express's own
"trending" section elsewhere in this app (not a topic in itself - see
`services/category-aliases.js`'s `ALIASES` for the same fold there).

## `fetchAllFeeds`'s `sourceNameFilter`

An optional `Set<string>` of publisher names (matching each source's
`name`, see `ingestion/discovery.js`'s `toEntry`) - when given, only
feeds belonging to one of those publishers are fetched. Used by
`index.js` to run each refresh tier (`ingestion/tier-tracker.js`) on its
own cron schedule instead of always fetching every registered feed.
Omitted entirely (`undefined`), this fetches everything, same as before
tiering existed - the 3am full-rediscovery pass still wants that.
