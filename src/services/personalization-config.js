// Every tunable knob for personalized ranking lives here, mirroring
// ranking-config.js/clustering-config.js's own pattern - the scoring logic
// in personalization.js never hardcodes a number. See docs/personalization.md.

// How much of a signed-in user's reading history to consider when scoring
// a story - a recency-capped window, not their entire lifetime history, so
// a user's interests can shift over time without stale reads from months
// ago permanently anchoring their feed.
const READ_HISTORY_LIMIT = 50;
const READ_HISTORY_DAYS = 30;

// Must sum to ~1 - blended into computePersonalizationSignal's single 0-1
// output. Entity overlap is weighted highest since it's the most specific
// signal (two stories can share a category/source and still be about
// completely different things; sharing named entities is a much stronger
// "this is the kind of thing you've been reading" signal).
const PERSONALIZATION_SUB_WEIGHTS = {
  category: 0.3,
  source: 0.2,
  entity: 0.5,
};

module.exports = {
  READ_HISTORY_LIMIT,
  READ_HISTORY_DAYS,
  PERSONALIZATION_SUB_WEIGHTS,
};
