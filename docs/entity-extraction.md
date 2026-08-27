# Heuristic entity extraction (`src/services/entity-extraction.js`)

NOT real NER. There is no NLP/entity library in this codebase and none is
being added for Stage 2 (see `clustering-pipeline.md`). This finds runs
of capitalized words (people/orgs/places/products typically look like
this in English text) and treats each run as one "entity". It will miss
lowercase entities, can't tell a person from a place, and has no
coreference resolution - a documented known limitation, good enough as a
first deterministic signal alongside text similarity, not a claim of true
understanding.

## `SENTENCE_INITIAL_EXCLUSIONS`

Sentence-initial capitalization alone is a weak signal (any word starting
a sentence gets capitalized whether or not it's a proper noun) - a
single-word run is only trusted as an entity when it's NOT
sentence-initial, or when it's sentence-initial but not one of these
common headline-starter words that are capitalized purely by position.

## `NON_ENTITY_WORDS`

Unlike `SENTENCE_INITIAL_EXCLUSIONS`, these are excluded regardless of
position - a day-of-week is never an entity no matter where it lands in a
sentence. Found via real clustering data: "...10-tonne consignment on
Wednesday" and "...stranded in Nepal due to devastating floods on
Wednesday" each contributed "wednesday" as an extracted entity, which then
counted as real corroborating evidence toward `MIN_SHARED_ENTITY_COUNT`
in `clustering.js` for two articles that were not otherwise related.

## `MAX_ENTITY_RUN_WORDS`

Caps how many consecutive capitalized words a single run can absorb - a
Title Case headline ("India Announces New Economic Policy") would
otherwise be swallowed whole as one "entity" instead of yielding useful
signal.
