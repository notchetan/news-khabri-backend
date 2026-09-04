require('dotenv').config({ quiet: true });

const express = require('express');
const cron = require('node-cron');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');
const logger = require('./logger');
const db = require('./db');
const fetchAllFeeds = require('./ingestion/fetcher');
const { discoverAllSources } = require('./ingestion/discovery');
const { setSources, getSources } = require('./ingestion/source-registry');
const { clusterNewArticles } = require('./ingestion/clusterer');
const { recomputeSourceTiers, getAllSourceTiers } = require('./ingestion/tier-tracker');
const { TIER_CRON, TIER_RECOMPUTE_CRON, DEFAULT_TIER } = require('./services/tier-config');
const { sendTrendingNotifications } = require('./services/push-notifications');
const { pruneRetention } = require('./services/retention');
const { RETENTION_CRON } = require('./services/retention-config');
const { withCronLock } = require('./services/cron-lock');
const articlesRouter = require('./routes/articles');
const storiesRouter = require('./routes/stories');
const pushRouter = require('./routes/push');
const authRouter = require('./routes/auth');
const readsRouter = require('./routes/reads');
const bookmarksRouter = require('./routes/bookmarks');

const app = express();
app.set('trust proxy', 1); // behind a PaaS load balancer - needed for correct client IPs / rate limiting.
app.disable('x-powered-by');
app.use(helmet());

// One structured log line per request. Skips /healthz so a monitor
// pinging every few seconds doesn't bury everything else.
app.use(
  pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/healthz' } })
);

// CORS_ORIGIN is a comma-separated allowlist; unset means "reflect any
// origin" (fine for the native app, which isn't subject to CORS anyway -
// lock this down once a web origin exists).
const corsOrigin = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim())
  : true;
app.use(cors({ origin: corsOrigin }));

// Every request body here is tiny (an id, a token, one preference bundle).
app.use(express.json({ limit: '16kb' }));

// Liveness/readiness probe for the host and uptime monitors - before the
// rate limiter so a monitor pinging every few seconds never trips it.
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Rate limiting is off under NODE_ENV=test - the suite fires many
// sequential requests from one address and isn't what these limits are
// for.
const rateLimitingDisabled = process.env.NODE_ENV === 'test';
const limiterBase = {
  windowMs: 15 * 60 * 1000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => rateLimitingDisabled,
};
const globalLimiter = rateLimit({ ...limiterBase, limit: 600 });
// Stricter: the sign-in routes verify a third-party token and can create
// an account, and the providers' verification endpoints have their own
// quotas.
const authLimiter = rateLimit({ ...limiterBase, limit: 30 });

app.use(globalLimiter);
app.use(['/auth/google', '/auth/apple'], authLimiter);

app.use(articlesRouter);
app.use(storiesRouter);
app.use(pushRouter);
app.use(authRouter);
app.use(readsRouter);
app.use(bookmarksRouter);

async function refreshSourcesAndFetch() {
  const discovered = await discoverAllSources();
  setSources(discovered);
  const publisherCount = new Set(discovered.map((s) => s.name)).size;
  logger.info({ feeds: discovered.length, publishers: publisherCount }, 'discovered feeds');
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
  // Every job is wrapped in withCronLock - a slow run outlasting its own
  // interval (or, if this process is ever scaled horizontally, two
  // instances' identical schedules firing together) would otherwise
  // double-fetch and double-notify. See docs/cron-locking.md.

  // See "Cron orchestration" in docs/tier-system.md.
  withCronLock('refreshSourcesAndFetch', refreshSourcesAndFetch);
  cron.schedule('0 3 * * *', () => withCronLock('refreshSourcesAndFetch', refreshSourcesAndFetch));
  cron.schedule(TIER_RECOMPUTE_CRON, () =>
    withCronLock('recomputeSourceTiers', () => recomputeSourceTiers())
  );

  cron.schedule(TIER_CRON.fast, () => withCronLock('fetchTier:fast', () => fetchTier('fast')));
  cron.schedule(TIER_CRON.medium, () => withCronLock('fetchTier:medium', () => fetchTier('medium')));
  cron.schedule(TIER_CRON.slow, () => withCronLock('fetchTier:slow', () => fetchTier('slow')));

  // Every 5 minutes - the finest interval a device can choose (see
  // push.js's VALID_INTERVALS) - sendTrendingNotifications itself only
  // actually notifies whichever devices are due (see push-notifications.js's
  // isDue), so this doesn't over-notify anyone on a longer interval.
  cron.schedule('*/5 * * * *', () =>
    withCronLock('sendTrendingNotifications', () => sendTrendingNotifications())
  );

  // Trim the two append-only tables to their rolling windows so they
  // don't grow forever - see services/retention-config.js.
  cron.schedule(RETENTION_CRON, () =>
    withCronLock('pruneRetention', async () => {
      const { readEvents, clusterDecisions } = pruneRetention();
      logger.info({ readEvents, clusterDecisions }, 'retention prune');
    })
  );

  const PORT = process.env.PORT || 3000;
  const server = app.listen(PORT, '0.0.0.0', () => logger.info({ port: PORT }, 'server listening'));

  // Close the listener and the DB handle on a host stop signal instead of
  // being killed mid-write; force-exit if it hasn't happened in 10s.
  const shutdown = (signal) => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => {
      logger.error('shutdown timed out - forcing exit');
      process.exit(1);
    }, 10000).unref();
  };
  ['SIGTERM', 'SIGINT'].forEach((sig) => process.on(sig, () => shutdown(sig)));
}

module.exports = app;
module.exports.refreshSourcesAndFetch = refreshSourcesAndFetch;
module.exports.sourceNamesForTier = sourceNamesForTier;
module.exports.fetchTier = fetchTier;
