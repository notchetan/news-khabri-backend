# Clustering decision engine (`src/services/clustering.js`)

Pure, framework/DB-free functions (no Express/SQLite coupling here),
exactly like `ranking.js`, so they're trivially unit-testable and so a
persistence layer (`ingestion/clusterer.js`) can drive them without this
file knowing anything about SQL.

This is a deterministic, lexical-similarity-first pass (jaccard over
tokens + a heuristic capitalized-run entity extractor, plus Stage 3
embeddings), not a claim that it solves semantic clustering perfectly -
see `cluster_decisions` (persisted by `ingestion/clusterer.js`) for how to
inspect false and missed merges against real RSS data, and
[`clustering-tuning.md`](./clustering-tuning.md) for the threshold
calibration history. All four similarity signals are produced by one
function, `computeSimilaritySignals`, so a future embedding-based
similarity can replace/extend its internals without touching the
merge-decision gating logic (`evaluateCandidate`/`decideAssignment`).

## `computeSimilaritySignals`

A story "candidate" here is the minimal shape clustering needs - see
`ingestion/clusterer.js` for how a `stories` row is mapped into this
(`entities_json` parsed into an array, etc). Kept separate from the DB row
shape so this file never needs to know about JSON serialization.

Every one of the four signals is independently meaningful and individually
inspectable - that's what makes a merge/no-merge decision explainable
rather than a single opaque number (see `decideAssignment`).

- **Title similarity** is compared against both the story's display
  headline and its most recently-seen phrasing - an evolving story's
  wording drifts over time, so matching only the very first headline
  would erode over updates.
- **Entity overlap**: `GENERIC_TOPIC_ENTITIES` (country/nationality names)
  are dropped here only - they're real entities (`extractEntities` keeps
  producing them), just not trusted as evidence of "same specific
  development" for this signal (see `clustering-tuning.md`).
- **Semantic similarity** is 0 when either side has no embedding (model
  failure, or a pre-Stage-3 row) - `cosineSimilarity` already treats that
  as "no signal" rather than throwing, so this degrades gracefully to
  Stage 2-only behavior. Also 0 for non-English articles regardless of the
  raw model output - the embedding model is English-only, and real
  `cluster_decisions` data showed it producing high but meaningless
  "similarity" between unrelated Hindi/Gujarati articles (see
  `clustering-tuning.md`). Candidates are already same-language as the
  article by construction (`ingestion/clusterer.js`'s SQL blocking query),
  so checking the article's own language is sufficient.

## `evaluateCandidate`: the false-merge defense

A weighted-sum confidence alone is not enough, since several *medium*
signals (same category, close in time, one shared generic entity) can add
up to clear a bare threshold without actually describing the same event.
At least one signal must independently clear its own bar
(`strongSignal`) - and `MIN_SHARED_ENTITY_COUNT` specifically blocks
"shared exactly one entity" from ever counting as strong on its own (e.g.
two articles both mentioning "Apple" but about unrelated events).

The semantic OR-path requires the timing to still be plausible, not just a
high raw score (see `clustering-tuning.md`): a stale-but-same-topic pair
can score higher semantically than a genuine near-duplicate, so this path
alone is not trustworthy without the time co-requirement.

The semantic term in `confidence` is also time-discounted
(`semantic * signals.semanticSim * signals.timeProximity`), same reasoning
as the `strongSignal` gate: a high semantic score against a stale story
should contribute close to nothing here too, not just fail its own
OR-path - otherwise it could still drag confidence over
`MERGE_CONFIDENCE_THRESHOLD` via an entity path that's already
`strongSignal`-true on its own (the stale Cyclone Biparjoy pair clears the
entity gate independently of this term).

## `decideAssignment`

Candidates have already passed the SQL blocking gate (same language,
category, and within the time window - see `ingestion/clusterer.js`) by
the time they reach here; this only does the more expensive similarity
math, never a full-table comparison.

## `computeQuality`

Used both to decide whether a joining article should become the story's
representative headline, and as the initial value when a story is first
created. Reuses Stage 1's `computeRankingScore` instead of reinventing a
source-authority/importance signal - "prefer a clear factual headline over
clickbait" leans on `titleClarityScore`, "completeness" rewards having a
description/image, "existing Stage 1 score" is the ranking score itself.
