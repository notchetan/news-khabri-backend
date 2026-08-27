const { normalizeTokens, jaccardSimilarity } = require('../services/text-similarity');

describe('normalizeTokens', () => {
  test('lowercases, strips punctuation, and splits on whitespace', () => {
    expect(normalizeTokens('India Announces New, Economic Policy!')).toEqual(
      new Set(['india', 'announc', 'new', 'economic', 'policy'])
    );
  });

  test('removes stopwords', () => {
    expect(normalizeTokens('the government of India')).toEqual(new Set(['government', 'india']));
  });

  test('lightly stems common suffixes so paraphrased wording overlaps', () => {
    const a = normalizeTokens('India announces new policy');
    const b = normalizeTokens('India announced new policies');
    expect(a).toEqual(b);
    expect(a).toEqual(new Set(['india', 'announc', 'new', 'policy']));
  });

  test('returns an empty set for null/undefined/empty text', () => {
    expect(normalizeTokens(null)).toEqual(new Set());
    expect(normalizeTokens(undefined)).toEqual(new Set());
    expect(normalizeTokens('')).toEqual(new Set());
  });

  test('dedupes repeated words', () => {
    expect(normalizeTokens('India India India')).toEqual(new Set(['india']));
  });
});

describe('jaccardSimilarity', () => {
  test('is 1 for identical sets', () => {
    const set = new Set(['a', 'b', 'c']);
    expect(jaccardSimilarity(set, new Set(['a', 'b', 'c']))).toBe(1);
  });

  test('is 0 for disjoint sets', () => {
    expect(jaccardSimilarity(new Set(['a']), new Set(['b']))).toBe(0);
  });

  test('is 0 (not NaN) for two empty sets', () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
  });

  test('computes the correct fraction for partial overlap', () => {
    // intersection {b,c} = 2, union {a,b,c,d} = 4
    expect(jaccardSimilarity(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))).toBeCloseTo(0.5);
  });

  test('is 0 when only one set is empty', () => {
    expect(jaccardSimilarity(new Set(), new Set(['a']))).toBe(0);
  });
});
