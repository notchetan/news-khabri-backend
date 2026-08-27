// Every tunable knob for per-source refresh tiering lives here, mirroring
// clustering-config.js/ranking-config.js's own pattern - the tiering logic
// itself never hardcodes a number.
//
// Why per-source rather than per-language: real ingestion data shows
// sources within one language can differ as much as sources across
// different languages - Indian Express (~220 articles/hour) vs NDTV
// (~14/hour) is roughly the same spread as Odisha TV (~11/hour) vs
// Mathrubhumi (~0.2/hour on its main feed). Keying the refresh interval off
// language would just pick "whatever fits that language's fastest member"
// and waste requests on everyone slower in the same group - keying off the
// source itself tracks the real signal instead.
//
// The two ways a tier assignment can be wrong aren't equally bad: too
// frequent just wastes a request (the ON CONFLICT(link) dedup on articles
// makes a re-fetch of unchanged content a no-op); too infrequent risks
// actually losing articles - an RSS feed only exposes its most recent items,
// so a fast source polled too rarely can have articles scroll off the feed
// before they're ever seen. Every default below is chosen to fail toward
// "wasteful" rather than "lossy".

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
// Chosen to divide cleanly into cron minute/hour fields (15 and 30 both
// divide 60; 120 is a clean 2-hour step) rather than an arbitrary number
// like 45 that cron's step syntax can't express as a true fixed interval.
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

// A source with no tier computed yet (brand new, or added since the last
// recompute run) gets the safe choice - see the module comment above on why
// "too frequent" is the failure direction to default toward.
const DEFAULT_TIER = 'fast';

// --- Recomputing tiers from real data ---
// Trailing window a source's rate is measured over - long enough to smooth
// past a single unusually quiet or busy day, short enough that a real,
// lasting change in a source's cadence (a newsroom slows down, or starts
// running a live-blog during a big story) is reflected within about a week
// rather than staying stale indefinitely, which is exactly the problem this
// whole system replaces a single fixed interval to avoid.
const TIER_LOOKBACK_DAYS = 7;

// Below this many observed articles in the lookback window, the computed
// rate is too noisy to trust (a source with 2 articles over 7 days could be
// genuinely slow, or could just be new and short on data) - stays on
// DEFAULT_TIER until enough real signal accumulates.
const MIN_SAMPLES_TO_TRUST_RATE = 10;

// When the tier-recompute job itself runs - see ingestion/tier-tracker.js.
// After the 3am full source-rediscovery pass so a newly-discovered source's
// very first fetch is already reflected before tiers are recomputed.
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
