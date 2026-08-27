require('dotenv').config({ quiet: true });

const express = require('express');
const cron = require('node-cron');
const cors = require('cors');
const fetchAllFeeds = require('./ingestion/fetcher');
const { discoverAllSources } = require('./ingestion/discovery');
const { setSources, getSources } = require('./ingestion/source-registry');
const { clusterNewArticles } = require('./ingestion/clusterer');
const { recomputeSourceTiers, getAllSourceTiers } = require('./ingestion/tier-tracker');
const { TIER_CRON, TIER_RECOMPUTE_CRON, DEFAULT_TIER } = require('./services/tier-config');
const articlesRouter = require('./routes/articles');
const storiesRouter = require('./routes/stories');

const app = express();
app.use(cors());
app.use(express.json());
app.use(articlesRouter);
app.use(storiesRouter);

async function refreshSourcesAndFetch() {
  const discovered = await discoverAllSources();
  setSources(discovered);
  const publisherCount = new Set(discovered.map((s) => s.name)).size;
  console.log(`Discovered ${discovered.length} feeds across ${publisherCount} publishers`);
  await fetchAllFeeds();
  await clusterNewArticles();
}

// Every publisher name currently registered whose refresh tier (see
// ingestion/tier-tracker.js) matches `tier` - a source with no tier
// computed yet (just discovered, or added before the first daily recompute
// has run) falls back to DEFAULT_TIER rather than being silently excluded
// from every tier's fetch.
function sourceNamesForTier(tier) {
  const tiers = getAllSourceTiers();
  const names = new Set();
  for (const src of getSources()) {
    const sourceTier = tiers.get(src.name) || DEFAULT_TIER;
    if (sourceTier === tier) names.add(src.name);
  }
  return names;
}

async function fetchTier(tier) {
  const names = sourceNamesForTier(tier);
  if (names.size === 0) return;
  await fetchAllFeeds(names);
  await clusterNewArticles();
}

// Only run side effects (real network fetches, cron, binding a port) when
// this file is actually launched as the server - not when a test suite
// imports `app` for supertest, which would otherwise trigger live fetches
// and an unwanted extra port binding on every test run.
if (require.main === module) {
  // Rediscover each publisher's section feeds once a day (a full fetch of
  // everything, ignoring tiers, so a brand-new source's very first articles
  // land immediately rather than waiting for its first tier-scheduled
  // fetch). Each refresh tier (see services/tier-config.js) then re-fetches
  // only its own sources on its own cadence, sized to how often that
  // publisher actually publishes rather than one interval for everyone -
  // see tier-config.js's own comment for why this is keyed by source, not
  // language. Stage 2 clustering runs right after each fetch - it only ever
  // looks at articles with no story_id yet, so it's naturally incremental
  // across cron cycles regardless of which tier triggered it.
  refreshSourcesAndFetch();
  cron.schedule('0 3 * * *', refreshSourcesAndFetch);
  cron.schedule(TIER_RECOMPUTE_CRON, () => recomputeSourceTiers());

  cron.schedule(TIER_CRON.fast, () => fetchTier('fast'));
  cron.schedule(TIER_CRON.medium, () => fetchTier('medium'));
  cron.schedule(TIER_CRON.slow, () => fetchTier('slow'));

  const PORT = 3000;
  app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
module.exports.refreshSourcesAndFetch = refreshSourcesAndFetch;
module.exports.sourceNamesForTier = sourceNamesForTier;
module.exports.fetchTier = fetchTier;
