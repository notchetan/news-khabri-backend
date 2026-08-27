const {
  cosineSimilarity,
  serializeEmbedding,
  deserializeEmbedding,
  updateCentroid,
} = require('../services/embeddings');

describe('cosineSimilarity', () => {
  test('is 1 for identical vectors', () => {
    const v = Float32Array.from([1, 0, 0]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1);
  });

  test('is 0 for orthogonal vectors', () => {
    const a = Float32Array.from([1, 0]);
    const b = Float32Array.from([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0);
  });

  test('is -1 for opposite vectors', () => {
    const a = Float32Array.from([1, 0]);
    const b = Float32Array.from([-1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1);
  });

  test('computes the correct value for a partial-overlap pair', () => {
    const a = Float32Array.from([1, 1, 0]);
    const b = Float32Array.from([1, 0, 0]);
    // cos = (1*1+1*0+0*0) / (sqrt(2)*sqrt(1)) = 1/sqrt(2)
    expect(cosineSimilarity(a, b)).toBeCloseTo(1 / Math.sqrt(2));
  });

  test('returns 0 (not NaN or a throw) when either vector is null', () => {
    const v = Float32Array.from([1, 0]);
    expect(cosineSimilarity(null, v)).toBe(0);
    expect(cosineSimilarity(v, null)).toBe(0);
    expect(cosineSimilarity(null, null)).toBe(0);
  });

  test('returns 0 for mismatched-length vectors rather than throwing', () => {
    const a = Float32Array.from([1, 0]);
    const b = Float32Array.from([1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  test('returns 0 for a zero vector rather than dividing by zero into NaN', () => {
    const zero = Float32Array.from([0, 0]);
    const v = Float32Array.from([1, 0]);
    expect(cosineSimilarity(zero, v)).toBe(0);
  });
});

describe('serializeEmbedding / deserializeEmbedding', () => {
  test('round-trips a vector through Buffer storage exactly', () => {
    const original = Float32Array.from([0.1, -0.2, 0.3, 1, -1]);
    const buffer = serializeEmbedding(original);
    expect(Buffer.isBuffer(buffer)).toBe(true);

    const restored = deserializeEmbedding(buffer);
    expect(Array.from(restored)).toEqual(Array.from(Float32Array.from(original)));
  });

  test('serializeEmbedding returns null for a null input', () => {
    expect(serializeEmbedding(null)).toBeNull();
  });

  test('deserializeEmbedding returns null for a null input', () => {
    expect(deserializeEmbedding(null)).toBeNull();
  });

  test('round-trips a realistically-sized (384-dim) vector', () => {
    const original = Float32Array.from({ length: 384 }, (_, i) => Math.sin(i));
    const restored = deserializeEmbedding(serializeEmbedding(original));
    expect(restored.length).toBe(384);
    expect(Array.from(restored)).toEqual(Array.from(original));
  });
});

describe('updateCentroid', () => {
  test('returns the new embedding as-is when there is no existing centroid', () => {
    const newEmbedding = Float32Array.from([1, 0]);
    expect(Array.from(updateCentroid(null, 0, newEmbedding))).toEqual([1, 0]);
  });

  test('returns the existing centroid as-is when the new embedding is missing', () => {
    const existing = Float32Array.from([1, 0]);
    expect(updateCentroid(existing, 1, null)).toBe(existing);
  });

  test('averages two identical unit vectors back to the same unit vector', () => {
    const v = Float32Array.from([1, 0]);
    const result = updateCentroid(v, 1, v);
    expect(result[0]).toBeCloseTo(1);
    expect(result[1]).toBeCloseTo(0);
  });

  test('the result is re-normalized to a unit vector even when the inputs pull in different directions', () => {
    const existing = Float32Array.from([1, 0]);
    const incoming = Float32Array.from([0, 1]);
    const result = updateCentroid(existing, 1, incoming);

    let norm = 0;
    for (const x of result) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1);
    // Halfway between [1,0] and [0,1], normalized.
    expect(result[0]).toBeCloseTo(1 / Math.sqrt(2));
    expect(result[1]).toBeCloseTo(1 / Math.sqrt(2));
  });

  test('weights the existing centroid by its member count, not evenly', () => {
    const existing = Float32Array.from([1, 0]);
    const incoming = Float32Array.from([0, 1]);
    // With 9 existing members, the 10th (incoming) should barely move the
    // centroid off [1, 0].
    const result = updateCentroid(existing, 9, incoming);
    expect(result[0]).toBeGreaterThan(0.9);
  });
});
