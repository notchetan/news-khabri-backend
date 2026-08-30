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
const { sendTrendingNotifications } = require('./services/push-notifications');
const articlesRouter = require('./routes/articles');
const storiesRouter = require('./routes/stories');
const pushRouter = require('./routes/push');

const app = express();
app.use(cors());
app.use(express.json());
app.use(articlesRouter);
app.use(storiesRouter);
app.use(pushRouter);

async function refreshSourcesAndFetch() {
  const discovered = await discoverAllSources();
  setSources(discovered);
  const publisherCount = new Set(discovered.map((s) => s.name)).size;
  console.log(`Discovered ${discovered.length} feeds across ${publisherCount} publishers`);
  await fetchAllFeeds();
  await clusterNewArticles();
}

// See "Cron orchestration" in docs/tier-system.md.
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
  // See "Cron orchestration" in docs/tier-system.md.
  refreshSourcesAndFetch();
  cron.schedule('0 3 * * *', refreshSourcesAndFetch);
  cron.schedule(TIER_RECOMPUTE_CRON, () => recomputeSourceTiers());

  cron.schedule(TIER_CRON.fast, () => fetchTier('fast'));
  cron.schedule(TIER_CRON.medium, () => fetchTier('medium'));
  cron.schedule(TIER_CRON.slow, () => fetchTier('slow'));

  // Every 5 minutes - the finest interval a device can choose (see
  // push.js's VALID_INTERVALS) - sendTrendingNotifications itself only
  // actually notifies whichever devices are due (see push-notifications.js's
  // isDue), so this doesn't over-notify anyone on a longer interval.
  cron.schedule('*/5 * * * *', () => sendTrendingNotifications());

  const PORT = 3000;
  app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
module.exports.refreshSourcesAndFetch = refreshSourcesAndFetch;
module.exports.sourceNamesForTier = sourceNamesForTier;
module.exports.fetchTier = fetchTier;
