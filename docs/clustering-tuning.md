# Story clustering: threshold calibration history

Every tunable knob for Stage 2/3 story clustering lives in
`src/services/clustering-config.js`, mirroring how `ranking-config.js`
holds Stage 1's knobs - the clustering/story-ranking logic itself never
hardcodes a number. This doc is the calibration history behind each
value: what real `cluster_decisions` data showed, and why each number
landed where it did. The config file itself only keeps a one-line summary
of what each knob controls.

**Guiding principle**: start conservative. False merges (unrelated
articles grouped as one story) are worse than missed merges (the same
story split across two entries). These starting values are a first
deterministic pass, not a claim that jaccard/entity-overlap/embeddings
solve semantic clustering perfectly - see `cluster_decisions`
(`ingestion/clusterer.js`) for how to inspect false/missed merges against
real RSS data and re-tune from there.

## Text similarity thresholds

- `TITLE_SIMILARITY_THRESHOLD` (0.5): jaccard(title tokens) needed to
  count as a "strong" signal on its own.
- `CONTENT_SIMILARITY_THRESHOLD` (0.35): jaccard(title+description
  tokens), lower than the title threshold because longer text has a
  naturally lower jaccard ceiling even for genuine duplicates (more total
  distinct tokens).
- `CONTENT_SIMILARITY_FLOOR` (0.15): below this, content similarity is
  treated as 0 in the weighted sum rather than contributing noise from
  two mostly-unrelated snippets that happen to share a couple of common
  words.
- `MIN_TITLE_TOKENS_FOR_SIMILARITY` (3): title token counts below this
  can never qualify as a "strong" signal by themselves - with very few
  tokens, one shared word can spike jaccard misleadingly (e.g. two
  2-word titles sharing 1 word = 0.33+ jaccard).

## Entity overlap thresholds

- `ENTITY_OVERLAP_THRESHOLD` (0.1): jaccard(entity set, entity set)
  needed to count as "strong" on its own. Lowered from an initial 0.34
  after checking real `cluster_decisions` data: two genuine near-duplicate
  headlines from the same publisher minutes apart (same Nepal-floods
  update) landed at entityOverlap 0.133 - each mentions 2-3 *other*
  entities the other doesn't (a different official, a different agency),
  which dilutes the ratio even though the 2 shared entities are exactly
  the strong signal `MIN_SHARED_ENTITY_COUNT` exists to catch. The ratio
  is a secondary check on top of that count floor, not the primary
  defense.
- `MIN_SHARED_ENTITY_COUNT` (2): a hard floor on the number of *shared*
  entities (not just the ratio) - this is what stops "Apple launches
  iPhone" from merging with "Apple reports revenue" just because both
  mention "Apple": one shared entity is never enough evidence on its own,
  regardless of how small either set is. This is the primary false-merge
  defense for the entity path (every should-NOT-cluster case checked
  during tuning shares at most 1 entity), so `ENTITY_OVERLAP_THRESHOLD`
  can stay permissive without reopening those cases.
- `GENERIC_TOPIC_ENTITIES`: country/nationality names that provide almost
  no distinguishing power for "is this the same specific development"
  clustering in an India-focused aggregator - nearly every article about
  an India-linked international story mentions India, and nearly every
  article about a disaster abroad mentions the country it happened in.
  Found via real `cluster_decisions` data: four genuinely distinct
  Nepal-floods articles (an MEA briefing, a state helpline notice, a Tamil
  Nadu CM directive, an ex-official's interview) each cleared
  `MIN_SHARED_ENTITY_COUNT` against each other with "nepal" + "india" as
  their only 2 "shared" entities - true overlap, but zero evidence
  they're the same development rather than just the same disaster.
  Excluded from the entity *overlap* signal only (see `clustering.js`'s
  `computeSimilaritySignals`) - `extractEntities` itself stays a
  general-purpose extractor; this is a clustering-relevance filter, not a
  claim that "India" isn't a real entity.

## Semantic similarity (Stage 3)

- `SEMANTIC_SIMILARITY_THRESHOLD` (0.86): cosine similarity between
  article/story embeddings (`services/embeddings.js`,
  Xenova/all-MiniLM-L6-v2) needed to count as "strong" on its own. Only
  trusted for English articles at all - `clustering.js`'s
  `computeSimilaritySignals` zeroes this signal out for non-English text:
  the model is English-only, and on Hindi/Gujarati it was found (via real
  `cluster_decisions` data) producing high "similarity" between
  completely unrelated articles - a farmer-protest report, a Raksha
  Bandhan shopping piece, and an MLA visiting a monk all scored 0.6-0.8
  against one unrelated murder-case story, none sharing any real topic.

  Raised from an initial 0.62 to 0.86 after the same real-data check
  showed 0.62 was not just a Hindi/Gujarati problem: English false
  positives landed in the same 0.6-0.8 band the threshold was meant to
  sit above (four distinct Nepal-floods articles - an MEA briefing, a
  state helpline notice, a Tamil Nadu CM directive, an ex-official
  interview - scored 0.71-0.78 against each other despite covering
  different specific developments; an astrology "lunar eclipse" piece and
  an unrelated daily horoscope scored 0.76; two different product-price
  articles scored 0.63). Genuine cross-publisher duplicates in the same
  data averaged 0.82 and mostly cleared 0.85-1.0, so 0.86 keeps most of
  them while sitting above where the false positives actually landed -
  some of the hardest genuine duplicates (very differently-worded
  paraphrases with zero lexical overlap) will now be missed rather than
  wrongly merged, a deliberate tradeoff given the false-merges-are-worse
  principle above.
- `MIN_TIME_PROXIMITY_FOR_SEMANTIC` (0.05): embeddings capture
  topic/entity similarity strongly even across unrelated time-separated
  events - the same "Cyclone Biparjoy" pair used to calibrate
  `MIN_SHARED_ENTITY_COUNT` above (landfall report vs. an economic-impact
  piece weeks later) scored 0.82 semantically, well past
  `SEMANTIC_SIMILARITY_THRESHOLD`. A semantic match is therefore only
  trusted as a strong signal when the timing is still plausible for it to
  be the same event - see this constant's use in `clustering.js`'s
  `evaluateCandidate`, and the matching time-discount on the semantic
  term in `CONFIDENCE_WEIGHTS` below.
  `exp(-hoursApart/TIME_DECAY_HOURS)` with `TIME_DECAY_HOURS=8` puts this
  floor at roughly a 24-hour effective window.

## Time-aware clustering

- `TIME_WINDOW_HOURS` (36): hard cutoff - an article can only be a
  candidate for a story whose `latest_published_at` is within this many
  hours. Generous enough for an evolving story (breaking news -> updates
  over several hours) without letting a same-category coincidence from
  days ago drift in.
- `STORY_MAX_LIFETIME_HOURS` (72): a second, outer hard cap measured from
  the story's `first_published_at` (not just its latest update) - stops a
  long chain of near-miss updates from slowly dragging a cluster's
  lifetime out indefinitely. A genuinely new development several days
  later (e.g. economic consequences of an earthquake) falls outside this
  even if it would otherwise pass every other gate.
- `TIME_DECAY_HOURS` (8): decay constant for the *soft* time-proximity
  score computed within the hard window above:
  `exp(-hoursApart / TIME_DECAY_HOURS)`. Smaller = time proximity matters
  more.

## Combining signals into a merge decision

`CONFIDENCE_WEIGHTS` (must sum to ~1) - see `clustering.js`'s
`decideAssignment` for exactly how these combine with the "strong signal"
gate: the weighted sum alone is never sufficient to merge; at least one
individual signal must also clear its own threshold above.

Time carries a heavy share (0.3): two headlines can share 2 entities and
little else (a real generic-topic coincidence, e.g. "Cyclone Biparjoy"
mentioned in both a landfall report and an unrelated economic-impact
piece weeks later) - a heavy time weight is what makes a near-zero
`timeProximity` still veto that pairing even though the entity gate alone
would let it through, while a genuinely same-day update (high
`timeProximity`) gets full credit. This matters even more now that
`semantic` is in the mix (also 0.3): that same stale Cyclone pair scores
0.82 on raw semantic similarity (see `SEMANTIC_SIMILARITY_THRESHOLD`
above) - see `clustering.js`'s `evaluateCandidate` for how the semantic
term is multiplied by `timeProximity` before entering this sum, so a
stale match's high semantic score contributes near-zero rather than
pushing confidence over the threshold on its own.

`MERGE_CONFIDENCE_THRESHOLD` (0.28): the `strongSignal` gate (see
`clustering.js`'s `evaluateCandidate`) is the primary false-merge
defense - every should-NOT-cluster case checked during tuning
(shared-topic-only, same-org-different-event, generic same-subject
headlines) failed `strongSignal` outright regardless of this number. This
threshold's job is narrower: separating genuine multi-signal
corroboration (a real evolving story, moderate on several signals at
once) from a single coincidental strong signal. Lowered from an initial
0.4 to 0.28 after real `cluster_decisions` data showed a genuine
same-story pair (two publishers' Nepal-floods updates, 2 shared entities,
high time proximity) landing at confidence 0.302 - below 0.4 despite
being exactly the kind of match this system exists to catch. Safe to
lower because `strongSignal` (not this number) is what rejects every
false-merge case in `clustering.test.js` - re-tune further from real data
as it accumulates.

## Story-level score aggregation (see `story-ranking.js`)

`STORY_SCORE_WEIGHTS` (must sum to ~1) is deliberately dominated by the
best member article's own Stage 1 score (`bestArticle: 0.62`) - article/
source count are secondary signals, never the dominant one. Tuned so a
single very important article (high importance + authoritative source)
still outranks a ten-article/five-source story of low-quality
(penalized-keyword) articles even when every one of those ten is
simultaneously maximally fresh and "in-momentum" - the worst case for
this property, not just the typical one (see `story-ranking.test.js`).

`recency`/`momentum` shrank and `sourceCount` grew (was
0.65/0.15/0.12/0.08) after tracing a real `/stories/top` result:
`bestArticle` already embeds Stage 1's own freshness term
(`RANKING_WEIGHTS.freshness`), so a fresh single-source story was
effectively getting credit for its freshness twice - once inside
`bestArticle`, again via `recency`/`momentum` here - which is how a
20-minute-old single-outlet stock filing outranked slower, more broadly
significant stories. `distinctSourceCount` (independent outlets covering
the same story) is a much better "this genuinely matters" signal than raw
recency for an aggregator, so it gained more than either recency-flavored
term lost.

Deliberately not pushed further than this: a larger `sourceCount` share
was tried and it broke the adversarial guarantee above (5 sources of pure
horoscope content outscored 1 source of war/disaster coverage) - see
`story-ranking.test.js`'s "ranks a story with one important article above
a story with several trivial ones".

## Other knobs

- `CANDIDATE_STORY_POOL_SIZE` (25): how many of the most-recently-updated
  same (language, category) active stories to load as candidates per
  article - a defensive cap so a single busy category/time-window slice
  can never make one article's clustering pass do unbounded work,
  independent of how large the `stories` table grows overall.
- `REPRESENTATIVE_SWITCH_MARGIN` (0.05): a newly-joining article only
  replaces the current representative headline if its quality score beats
  the incumbent's by more than this margin - hysteresis to stop the
  headline flapping back and forth between two near-identical articles as
  more of them arrive.
- `SOURCE_COUNT_SATURATION` / `MOMENTUM_SATURATION`: diminishing-returns
  caps - beyond this many distinct/recently-arrived sources, additional
  ones stop adding to the signal.
- `MOMENTUM_WINDOW_HOURS` (3): how recently a member must have been
  published to count toward momentum ("is this story still actively
  developing right now").
- `STORY_FEED_POOL_SIZE` (100): how many active stories the
  `/stories/top` route pulls as a ranking pool before applying
  `rankStories` + limit - mirrors `ranking-config.js`'s own
  `CANDIDATE_POOL_SIZE` for the equivalent per-article endpoint.
- `MAX_PER_CATEGORY` (4): caps how many of the final ranked stories can
  share the same category - mirrors `ranking-config.js`'s own
  `MAX_PER_CATEGORY` and the same caveat applies: only meaningful for an
  unfiltered ("all categories") ranking pass, never when the caller
  already filtered candidates to one category (see `routes/stories.js`).
- `LOG_CLUSTER_DECISIONS`: whether to persist a row to
  `cluster_decisions` for every clustering decision (merge or create),
  including the full candidate list - the explainability/debugging trail
  used to inspect false and missed merges against real RSS data (see the
  guiding principle above). Never exposed via any API route - purely an
  operational/debug artifact. Safe to flip off if the table grows too
  large in practice.
