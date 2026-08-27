# Stage 3 semantic similarity (`src/services/embeddings.js`)

A local sentence-embedding model (no hosted API, no per-call cost, no
network dependency after the one-time model download) computed once per
article at ingestion time. This is the concrete answer to Stage 2's known
ceiling: jaccard/entity-overlap can't bridge headlines that are worded
too differently across newsrooms for the same event - a semantic
embedding can.

Pure math helpers here (`cosineSimilarity`, serialize/deserialize,
`updateCentroid`) stay synchronous so `services/clustering.js` can keep
using them without becoming async - only actually computing a NEW
embedding (`getEmbedding`) touches the model and is async; see
`ingestion/clusterer.js` for where that happens (once per newly-ingested
article, never on any read path).

## Lazy singleton model load

`getExtractor` loads the model once per process on first use, not per
article - model loading takes a few seconds, computing an embedding with
an already-loaded model is fast (tens of milliseconds).

## `getEmbedding` never throws

A failed model load or inference (e.g. the one-time download failing, out
of memory) returns `null` instead of crashing ingestion. Every caller
downstream already treats a missing embedding as "no semantic signal
available" rather than a hard error, the same graceful-degradation shape
used elsewhere in this app for optional capabilities.

## `cosineSimilarity`

Both vectors are already unit-normalized by `getEmbedding`'s
`normalize: true`, so this is just a dot product - but computed as a full
cosine similarity (not assuming normalization) so it stays correct for
any vectors passed in from elsewhere (e.g. a centroid before its own
re-normalization step). Returns 0 - not NaN, not a throw - for null or
mismatched-length inputs, matching how a missing embedding elsewhere in
this module is treated as "no signal" rather than an error.

## Storage as a compact BLOB

384 floats * 4 bytes = 1536 bytes, rather than JSON text (which would run
to several KB per row as a string) - this column is written on every
newly-clustered article and read back for every clustering comparison, so
the smaller/faster format matters more here than it does for
`entities_json`'s occasional JSON parse.

## `updateCentroid`

Incremental running mean, re-normalized afterward - averaging two unit
vectors doesn't itself produce a unit vector, and `cosineSimilarity`
assumes/benefits from comparing against a normalized centroid. Used to
keep a story's embedding representing its whole membership (the same
"accumulate as members join" shape `entities_json` already uses), not
just its first or most recent article.
