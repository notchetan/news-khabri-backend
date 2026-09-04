# Per-source refresh tiering (`src/services/tier-config.js`, `src/ingestion/tier-tracker.js`)

Every tunable knob for per-source refresh tiering lives in
`tier-config.js`, mirroring `clustering-config.js`/`ranking-config.js`'s
own pattern - the tiering logic itself never hardcodes a number.

## Why per-source, not per-language

Real ingestion data shows sources within one language can differ as much
as sources across different languages - Indian Express (~220
articles/hour) vs NDTV (~14/hour) is roughly the same spread as Odisha TV
(~11/hour) vs Mathrubhumi (~0.2/hour on its main feed). Keying the
refresh interval off language would just pick "whatever fits that
language's fastest member" and waste requests on everyone slower in the
same group - keying off the source itself tracks the real signal instead.

## Which failure direction every default favors

The two ways a tier assignment can be wrong aren't equally bad:

- **Too frequent** just wastes a request - the `ON CONFLICT(link)` dedup
  on articles makes a re-fetch of unchanged content a no-op.
- **Too infrequent** risks actually losing articles - an RSS feed only
  exposes its most recent items, so a fast source polled too rarely can
  have articles scroll off the feed before they're ever seen.

Every default in `tier-config.js` is chosen to fail toward "wasteful"
rather than "lossy" - including `DEFAULT_TIER = 'fast'` for a source with
no tier computed yet (brand new, or added since the last recompute run).

## Cadence values

`TIER_INTERVAL_MINUTES`/`TIER_CRON` are chosen to divide cleanly into
cron minute/hour fields (15 and 30 both divide 60; 120 is a clean 2-hour
step) rather than an arbitrary number like 45 that cron's step syntax
can't express as a true fixed interval.

## Recomputing tiers from real data

`TIER_LOOKBACK_DAYS` (7) is the trailing window a source's rate is
measured over - long enough to smooth past a single unusually quiet or
busy day, short enough that a real, lasting change in a source's cadence
(a newsroom slows down, or starts running a live-blog during a big story)
is reflected within about a week rather than staying stale indefinitely,
which is exactly the problem this whole system replaces a single fixed
interval to avoid.

`MIN_SAMPLES_TO_TRUST_RATE` (10): below this many observed articles in
the lookback window, the computed rate is too noisy to trust (a source
with 2 articles over 7 days could be genuinely slow, or could just be new
and short on data) - stays on `DEFAULT_TIER` until enough real signal
accumulates.

`TIER_RECOMPUTE_CRON` runs after the 3am full source-rediscovery pass so
a newly-discovered source's very first fetch is already reflected before
tiers are recomputed.

## `tier-tracker.js`: timestamp format gotcha

`fetched_at` is stored as SQLite's own `CURRENT_TIMESTAMP` format
(`'YYYY-MM-DD HH:MM:SS'`, UTC, no `'T'`/`'Z'`) - a plain
`.toISOString()` cutoff would compare against a different string shape
and silently miscompare at the boundary, the same trap documented on
`ingestion/clusterer.js`'s `SQL_FETCH_MULTIPLIER` for `published_at` (see
`clusterer-orchestration.md`). `toSqliteTimestamp` keeps the cutoff in the
exact format `fetched_at` is actually stored in.

`recomputeSourceTiers` re-derives every source's refresh tier from real
ingestion history over the trailing `TIER_LOOKBACK_DAYS` window. Meant to
run on a daily cron (see `index.js`); each run's tiers replace the
previous run's entirely, so a source's tier tracks its current real
cadence rather than staying fixed at whatever it was once assigned - the
same staleness problem a single hardcoded interval had.

## Cron orchestration (`src/index.js`)

`refreshSourcesAndFetch` rediscovers each publisher's section feeds once a
day (a full fetch of everything, ignoring tiers, so a brand-new source's
very first articles land immediately rather than waiting for its first
tier-scheduled fetch). Each refresh tier then re-fetches only its own
sources on its own cadence, sized to how often that publisher actually
publishes rather than one interval for everyone. Stage 2 clustering runs
right after each fetch - it only ever looks at articles with no
`story_id` yet, so it's naturally incremental across cron cycles
regardless of which tier triggered it.

`sourceNamesForTier` falls back every publisher with no tier computed yet
(just discovered, or added before the first daily recompute has run) to
`DEFAULT_TIER` rather than silently excluding it from every tier's fetch.

Every job scheduled here is wrapped in `withCronLock` - see
`docs/cron-locking.md` for why (a slow tick can genuinely outlast its own
interval, which would otherwise start a second overlapping run of itself).
