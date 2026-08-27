// Heuristic entity extraction - NOT real NER. There is no NLP/entity
// library in this codebase and none is being added for Stage 2 (see
// clustering.js's header comment). This finds runs of capitalized words
// (people/orgs/places/products typically look like this in English text)
// and treats each run as one "entity". It will miss lowercase entities,
// can't tell a person from a place, and has no coreference resolution -
// documented as a known limitation, good enough as a first deterministic
// signal alongside text similarity, not a claim of true understanding.
const { STOPWORDS } = require('./text-similarity');

// Sentence-initial capitalization alone is a weak signal (any word starting
// a sentence gets capitalized whether or not it's a proper noun) - a
// single-word run is only trusted as an entity when it's NOT sentence-
// initial, or when it's sentence-initial but not one of these common
// headline-starter words that are capitalized purely by position.
const SENTENCE_INITIAL_EXCLUSIONS = new Set([
  'new', 'after', 'before', 'despite', 'amid', 'how', 'why', 'what', 'when',
  'where', 'who', 'report', 'reports', 'study', 'watch', 'exclusive',
  'breaking', 'live', 'update', 'updates', 'is', 'are', 'this', 'here',
  'government', 'minister', 'ministry', 'president', 'police', 'officials',
  'experts', 'company', 'firm', 'sources', 'authorities', 'stock', 'stocks',
  'shares', 'markets', 'court', 'parliament', 'prices', 'regional',
  'reconstruction',
]);

// Unlike SENTENCE_INITIAL_EXCLUSIONS above, these are excluded regardless of
// position - a day-of-week is never an entity no matter where it lands in a
// sentence. Found via real clustering data: "...10-tonne consignment on
// Wednesday" and "...stranded in Nepal due to devastating floods on
// Wednesday" each contributed "wednesday" as an extracted entity, which then
// counted as real corroborating evidence toward MIN_SHARED_ENTITY_COUNT in
// clustering.js for two articles that were not otherwise related.
const NON_ENTITY_WORDS = new Set([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);

// Caps how many consecutive capitalized words a single run can absorb - a
// Title Case headline ("India Announces New Economic Policy") would
// otherwise be swallowed whole as one "entity" instead of yielding useful
// signal.
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
