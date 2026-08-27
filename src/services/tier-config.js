// Every tunable knob for per-source refresh tiering lives here, mirroring
// clustering-config.js/ranking-config.js's own pattern. See
// docs/tier-system.md for the full reasoning (why per-source not
// per-language, and which failure direction every default favors).

// --- Rate thresholds (articles/hour) -> tier ---
const TIER_THRESHOLDS_PER_HOUR = {
  fast: 15,
  medium: 2,
  // below `medium` -> 'slow'
};

function tierFromRate(articlesPerHour) {
  if (articlesPerHour >= TIER_THRESHOLDS_PER_HOUR.fast) return 'fast';
  if (articlesPerHour >= TIER_THRESHOLDS_PER_HOUR.medium) return 'medium';
  return 'slow';
}

// --- Refresh cadence per tier ---
// See "Cadence values" in docs/tier-system.md.
const TIER_INTERVAL_MINUTES = {
  fast: 15,
  medium: 30,
  slow: 120,
};

const TIER_CRON = {
  fast: '*/15 * * * *',
  medium: '*/30 * * * *',
  slow: '0 */2 * * *',
};

const DEFAULT_TIER = 'fast';

// --- Recomputing tiers from real data ---
// See "Recomputing tiers from real data" in docs/tier-system.md.
const TIER_LOOKBACK_DAYS = 7;
const MIN_SAMPLES_TO_TRUST_RATE = 10;
const TIER_RECOMPUTE_CRON = '0 4 * * *';

module.exports = {
  TIER_THRESHOLDS_PER_HOUR,
  tierFromRate,
  TIER_INTERVAL_MINUTES,
  TIER_CRON,
  DEFAULT_TIER,
  TIER_LOOKBACK_DAYS,
  MIN_SAMPLES_TO_TRUST_RATE,
  TIER_RECOMPUTE_CRON,
};
