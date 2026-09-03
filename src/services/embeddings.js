// Stage 3 semantic similarity - see docs/embeddings.md.
const { pipeline } = require('@huggingface/transformers');
const logger = require('../logger');

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DIMENSIONS = 384;

// See "Lazy singleton model load" in docs/embeddings.md.
let extractorPromise = null;
function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline('feature-extraction', MODEL_NAME);
  }
  return extractorPromise;
}

// See "getEmbedding never throws" in docs/embeddings.md.
async function getEmbedding(text) {
  if (!text) return null;
  try {
    const extractor = await getExtractor();
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    return Float32Array.from(output.data);
  } catch (err) {
    logger.error({ err: err.message }, 'embedding computation failed');
    return null;
  }
}

// See "cosineSimilarity" in docs/embeddings.md.
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// See "Storage as a compact BLOB" in docs/embeddings.md.
function serializeEmbedding(embedding) {
  if (!embedding) return null;
  return Buffer.from(Float32Array.from(embedding).buffer);
}

function deserializeEmbedding(buffer) {
  if (!buffer) return null;
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / Float32Array.BYTES_PER_ELEMENT);
}

// See "updateCentroid" in docs/embeddings.md.
function updateCentroid(existingCentroid, existingCount, newEmbedding) {
  if (!existingCentroid || existingCount <= 0) return newEmbedding;
  if (!newEmbedding) return existingCentroid;

  const updated = new Float32Array(existingCentroid.length);
  for (let i = 0; i < existingCentroid.length; i++) {
    updated[i] = (existingCentroid[i] * existingCount + newEmbedding[i]) / (existingCount + 1);
  }

  let norm = 0;
  for (let i = 0; i < updated.length; i++) norm += updated[i] * updated[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return updated;
  for (let i = 0; i < updated.length; i++) updated[i] /= norm;
  return updated;
}

module.exports = {
  MODEL_NAME,
  EMBEDDING_DIMENSIONS,
  getEmbedding,
  cosineSimilarity,
  serializeEmbedding,
  deserializeEmbedding,
  updateCentroid,
};
