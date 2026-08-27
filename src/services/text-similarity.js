// Pure, deterministic lexical similarity - no dependency, no embeddings.
// This is Stage 2's *initial* similarity signal, not a claim that jaccard
// over tokens solves semantic clustering perfectly (see clustering.js's
// header comment for the Stage 3 extension point).

// Small and deliberately generic (not news-domain-specific) - just enough to
// stop the most common connector words from dominating token overlap.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'in', 'on', 'at', 'to',
  'for', 'with', 'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been',
  'this', 'that', 'these', 'those', 'it', 'its', 'has', 'have', 'had',
  'after', 'over', 'amid', 'amid', 'into', 'about', 'than', 'more',
]);

// A deliberately small, conservative suffix list (not a real stemmer) - just
// enough to fold common inflections of the same word together (e.g.
// "announces"/"announced", "measure"/"measures") without a new dependency.
// Order matters: longer/more specific suffixes are tried first.
const SUFFIXES = ['ing', 'edly', 'ed', 'es', 's'];
const MIN_STEM_LENGTH = 4;

function stripSuffix(word) {
  // Handled before the general 'es' rule below - "policies"/"companies"
  // stemming to "polici"/"compani" (the blanket -es strip) would fail to
  // match their singular "policy"/"company" forms, which is exactly the
  // kind of common plural the stemmer exists to fold together.
  if (word.length > MIN_STEM_LENGTH && word.endsWith('ies')) {
    return `${word.slice(0, -3)}y`;
  }
  for (const suffix of SUFFIXES) {
    if (word.length - suffix.length >= MIN_STEM_LENGTH && word.endsWith(suffix)) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

// Lowercases, strips punctuation, splits on whitespace, drops stopwords and
// empty tokens, lightly stems, and de-dupes into a Set ready for jaccard.
function normalizeTokens(text) {
  if (!text) return new Set();
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => !STOPWORDS.has(word))
    .map(stripSuffix)
    .filter((word) => word.length > 0);
  return new Set(words);
}

// |A ∩ B| / |A ∪ B|, 0 for two empty sets (not NaN) rather than throwing.
function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersectionSize = 0;
  for (const item of setA) {
    if (setB.has(item)) intersectionSize += 1;
  }
  const unionSize = setA.size + setB.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

module.exports = {
  STOPWORDS,
  normalizeTokens,
  jaccardSimilarity,
};
