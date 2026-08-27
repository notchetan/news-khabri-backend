// Pure, framework/DB-free decision logic for per-source refresh tiering -
// same split as clustering.js/clustering-config.js: this file decides, and
// ingestion/tier-tracker.js is the DB-touching orchestration that feeds it
// real data and persists the result.
const { tierFromRate, DEFAULT_TIER, MIN_SAMPLES_TO_TRUST_RATE } = require('./tier-config');

// Given how many articles a source produced over a known lookback window,
// decide its refresh tier. Kept separate from tierFromRate so the "not
// enough samples yet" policy and the raw rate->tier mapping are each
// independently testable.
function computeSourceTier(sampleCount, lookbackHours) {
  if (!sampleCount || sampleCount < MIN_SAMPLES_TO_TRUST_RATE || !lookbackHours || lookbackHours <= 0) {
    return { tier: DEFAULT_TIER, articlesPerHour: null };
  }
  const articlesPerHour = sampleCount / lookbackHours;
  return { tier: tierFromRate(articlesPerHour), articlesPerHour };
}

module.exports = { computeSourceTier };
