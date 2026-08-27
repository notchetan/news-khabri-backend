// Stage 3 semantic similarity - a local sentence-embedding model (no hosted
// API, no per-call cost, no network dependency after the one-time model
// download) computed once per article at ingestion time. This is the
// concrete answer to Stage 2's known ceiling: jaccard/entity-overlap can't
// bridge headlines that are worded too differently across newsrooms for the
// same event - a semantic embedding can.
//
// Pure math helpers here (cosineSimilarity, serialize/deserialize,
// updateCentroid) stay synchronous so services/clustering.js can keep using
// them without becoming async - only actually computing a NEW embedding
// (getEmbedding) touches the model and is async; see ingestion/clusterer.js
// for where that happens (once per newly-ingested article, never on any
// read path).
const { pipeline } = require('@huggingface/transformers');

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DIMENSIONS = 384;

// Loaded once per process on first use, not per article - model loading
// takes a few seconds, computing an embedding with an already-loaded model
// is fast (tens of milliseconds).
let extractorPromise = null;
function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline('feature-extraction', MODEL_NAME);
  }
  return extractorPromise;
}

// Never throws - a failed model load or inference (e.g. the one-time
// download failing, out of memory) returns null instead of crashing
// ingestion. Every caller downstream already treats a missing embedding as
// "no semantic signal available" rather than a hard error, the same
// graceful-degradation shape used elsewhere in this app for optional
// capabilities.
async function getEmbedding(text) {
  if (!text) return null;
  try {
    const extractor = await getExtractor();
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    return Float32Array.from(output.data);
  } catch (err) {
    console.error('Failed to compute embedding:', err.message);
    return null;
  }
}

// Both vectors are already unit-normalized by getEmbedding's `normalize:
// true`, so this is just a dot product - but computed as a full cosine
// similarity (not assuming normalization) so it stays correct for any
// vectors passed in from elsewhere (e.g. a centroid before its own
// re-normalization step). Returns 0 - not NaN, not a throw - for null or
// mismatched-length inputs, matching how a missing embedding elsewhere in
// this module is treated as "no signal" rather than an error.
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

// Storage as a compact BLOB (384 floats * 4 bytes = 1536 bytes) rather than
// JSON text (which would run to several KB per row as a string) - this
// column is written on every newly-clustered article and read back for
// every clustering comparison, so the smaller/faster format matters more
// here than it does for entities_json's occasional JSON parse.
function serializeEmbedding(embedding) {
  if (!embedding) return null;
  return Buffer.from(Float32Array.from(embedding).buffer);
}

function deserializeEmbedding(buffer) {
  if (!buffer) return null;
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / Float32Array.BYTES_PER_ELEMENT);
}

// Incremental running mean, re-normalized afterward - averaging two unit
// vectors doesn't itself produce a unit vector, and cosineSimilarity above
// assumes/benefits from comparing against a normalized centroid. Used to
// keep a story's embedding representing its whole membership (the same
// "accumulate as members join" shape entities_json already uses), not just
// its first or most recent article.
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
