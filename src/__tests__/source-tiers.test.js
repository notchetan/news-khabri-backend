const { computeSourceTier } = require('../services/source-tiers');
const { tierFromRate, DEFAULT_TIER, MIN_SAMPLES_TO_TRUST_RATE } = require('../services/tier-config');

describe('tierFromRate', () => {
  test('classifies a high-volume source as fast', () => {
    expect(tierFromRate(220)).toBe('fast');
    expect(tierFromRate(15)).toBe('fast');
  });

  test('classifies a moderate-volume source as medium', () => {
    expect(tierFromRate(10)).toBe('medium');
    expect(tierFromRate(2)).toBe('medium');
  });

  test('classifies a low-volume source as slow', () => {
    expect(tierFromRate(1.9)).toBe('slow');
    expect(tierFromRate(0)).toBe('slow');
  });
});

describe('computeSourceTier', () => {
  test('defaults to the safe tier when there are too few samples to trust', () => {
    const result = computeSourceTier(MIN_SAMPLES_TO_TRUST_RATE - 1, 24);
    expect(result.tier).toBe(DEFAULT_TIER);
    expect(result.articlesPerHour).toBeNull();
  });

  test('defaults to the safe tier for a brand-new source with zero samples', () => {
    const result = computeSourceTier(0, 24);
    expect(result.tier).toBe(DEFAULT_TIER);
    expect(result.articlesPerHour).toBeNull();
  });

  test('computes a real rate and tier once enough samples exist', () => {
    // 15 samples over 24 hours = 0.625/hour -> slow.
    const result = computeSourceTier(15, 24);
    expect(result.articlesPerHour).toBeCloseTo(0.625);
    expect(result.tier).toBe('slow');
  });

  test('classifies a high-volume source correctly with enough samples', () => {
    // 500 samples over 24 hours ≈ 20.8/hour -> fast.
    const result = computeSourceTier(500, 24);
    expect(result.tier).toBe('fast');
  });

  test('does not throw and defaults to the safe tier for a zero/invalid lookback window', () => {
    expect(computeSourceTier(50, 0)).toEqual({ tier: DEFAULT_TIER, articlesPerHour: null });
    expect(computeSourceTier(50, null)).toEqual({ tier: DEFAULT_TIER, articlesPerHour: null });
  });
});
