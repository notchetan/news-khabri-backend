// Heuristic entity extraction - NOT real NER. See docs/entity-extraction.md.
const { STOPWORDS } = require('./text-similarity');

// See "SENTENCE_INITIAL_EXCLUSIONS" in docs/entity-extraction.md.
const SENTENCE_INITIAL_EXCLUSIONS = new Set([
  'new', 'after', 'before', 'despite', 'amid', 'how', 'why', 'what', 'when',
  'where', 'who', 'report', 'reports', 'study', 'watch', 'exclusive',
  'breaking', 'live', 'update', 'updates', 'is', 'are', 'this', 'here',
  'government', 'minister', 'ministry', 'president', 'police', 'officials',
  'experts', 'company', 'firm', 'sources', 'authorities', 'stock', 'stocks',
  'shares', 'markets', 'court', 'parliament', 'prices', 'regional',
  'reconstruction',
]);

// See "NON_ENTITY_WORDS" in docs/entity-extraction.md.
const NON_ENTITY_WORDS = new Set([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);

// See "MAX_ENTITY_RUN_WORDS" in docs/entity-extraction.md.
const MAX_ENTITY_RUN_WORDS = 4;

function splitIntoSentences(text) {
  return text.split(/(?<=[.!?])\s+/).filter(Boolean);
}

function extractEntities(text) {
  if (!text) return [];

  const entities = new Set();

  for (const sentence of splitIntoSentences(text)) {
    const words = sentence.match(/[A-Za-z][A-Za-z'-]*/g) || [];
    let run = [];

    const flushRun = () => {
      if (run.length === 0) return;
      const isSentenceInitial = run[0].index === 0;
      const words_ = run.map((w) => w.word);
      if (words_.length === 1 && isSentenceInitial) {
        if (SENTENCE_INITIAL_EXCLUSIONS.has(words_[0].toLowerCase())) {
          run = [];
          return;
        }
      }
      const capped = words_.slice(0, MAX_ENTITY_RUN_WORDS);
      entities.add(capped.join(' ').toLowerCase());
      run = [];
    };

    words.forEach((word, index) => {
      const isCapitalized =
        /^[A-Z]/.test(word) &&
        !STOPWORDS.has(word.toLowerCase()) &&
        !NON_ENTITY_WORDS.has(word.toLowerCase());
      if (isCapitalized) {
        run.push({ word, index });
      } else {
        flushRun();
      }
    });
    flushRun();
  }

  return [...entities];
}

module.exports = {
  extractEntities,
};
