// DB-touching orchestration for per-source refresh tiering - the only file
// that reads/writes the `source_tiers` table, mirroring how
// ingestion/clusterer.js is the DB-touching counterpart to the pure
// services/clustering.js. The actual rate->tier decision is delegated to
// services/source-tiers.js so that logic stays framework/DB-free.
const db = require('../db');
const { computeSourceTier } = require('../services/source-tiers');
const { TIER_LOOKBACK_DAYS, DEFAULT_TIER } = require('../services/tier-config');

const upsertTierStmt = db.prepare(`
  INSERT INTO source_tiers (source, tier, articles_per_hour, sample_count, computed_at)
  VALUES (@source, @tier, @articles_per_hour, @sample_count, CURRENT_TIMESTAMP)
  ON CONFLICT(source) DO UPDATE SET
    tier = excluded.tier,
    articles_per_hour = excluded.articles_per_hour,
    sample_count = excluded.sample_count,
    computed_at = excluded.computed_at
`);

// fetched_at is stored as SQLite's own CURRENT_TIMESTAMP format
// ('YYYY-MM-DD HH:MM:SS', UTC, no 'T'/'Z') - a plain `.toISOString()` cutoff
// would compare against a different string shape and silently miscompare at
// the boundary, the same trap documented on ingestion/clusterer.js's
// SQL_FETCH_MULTIPLIER for published_at. This keeps the cutoff in the exact
// format fetched_at is actually stored in.
function toSqliteTimestamp(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

// Re-derives every source's refresh tier from real ingestion history over
// the trailing TIER_LOOKBACK_DAYS window - see services/tier-config.js for
// the thresholds and services/source-tiers.js for the pure rate->tier
// decision. Meant to run on a daily cron (see index.js); each run's tiers
// replace the previous run's entirely, so a source's tier tracks its
// current real cadence rather than staying fixed at whatever it was once
// assigned - the same staleness problem a single hardcoded interval had.
function recomputeSourceTiers(now = new Date()) {
  const since = toSqliteTimestamp(new Date(now.getTime() - TIER_LOOKBACK_DAYS * 24 * 3600 * 1000));
  const lookbackHours = TIER_LOOKBACK_DAYS * 24;

  const rows = db
    .prepare('SELECT source, COUNT(*) AS count FROM articles WHERE fetched_at >= ? GROUP BY source')
    .all(since);

  return rows.map(({ source, count }) => {
    const { tier, articlesPerHour } = computeSourceTier(count, lookbackHours);
    upsertTierStmt.run({
      source,
      tier,
      articles_per_hour: articlesPerHour,
      sample_count: count,
    });
    return { source, tier, articlesPerHour, sampleCount: count };
  });
}

// A source's tier for scheduling purposes - DEFAULT_TIER (the safe, frequent
// choice) for any source never computed yet, e.g. one just added to
// discovery.js since the last recompute run.
function getSourceTier(sourceName) {
  const row = db.prepare('SELECT tier FROM source_tiers WHERE source = ?').get(sourceName);
  return row ? row.tier : DEFAULT_TIER;
}

// All currently-known tiers as a Map(source -> tier), for grouping a whole
// source list by tier in one pass rather than one query per source.
function getAllSourceTiers() {
  const rows = db.prepare('SELECT source, tier FROM source_tiers').all();
  const map = new Map();
  rows.forEach((r) => map.set(r.source, r.tier));
  return map;
}

module.exports = { recomputeSourceTiers, getSourceTier, getAllSourceTiers };
