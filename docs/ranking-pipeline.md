# Stage 1 ranking service (`src/services/ranking.js`)

Pure, framework-free functions (no Express/DB coupling) so they're
trivially unit-testable and so Stage 2 additions (story clustering,
cross-source coverage, momentum, personalization, semantic similarity)
can plug into `rankArticles`/`computeRankingScore` without restructuring
anything here. See [`ranking-tuning.md`](./ranking-tuning.md) for the
calibration history behind the config values these functions read.

## `computeFreshness`

`exp(-ageInHours / FRESHNESS_DECAY_HOURS)` - decays smoothly rather than
treating older articles as suddenly irrelevant. Missing/invalid dates (or
dates in the future, e.g. clock skew from a source) are treated as not
fresh / not in the future respectively rather than throwing.

## `matchedKeywords`

Which keywords in a list actually match the text, with one refinement:
when one matched keyword is itself a substring of another matched keyword
(e.g. `'court'` inside `'supreme court'`), only the longer/more specific
one counts - otherwise a single mention of "Supreme Court" would
double-boost via both keywords for what is, semantically, one signal.
This generalizes past the couple of pairs found by auditing the current
lists, so a future addition to either list doesn't need a fresh manual
overlap check.

## `computeImportance`

Deterministic, keyword-based - not ML, on purpose. See
`ranking-config.js`'s `IMPORTANCE_KEYWORDS` for the actual word lists this
checks against, and `IMPORTANCE_PENALIZE_PATTERNS` for the regex-based
penalties layered on top for phrasing conventions a literal keyword list
can't express (like "any single-company stock move" - see
`ranking-tuning.md`).

## `computeRankingScore`

Combines the three signals into the final weighted score. Returns the
breakdown alongside the total - that breakdown is what makes the result
explainable (and testable) rather than a single opaque number.

## `rankArticles`

Scores every candidate, sorts by score, then applies a simple per-source
cap so one prolific source can't fill the whole list with near-duplicate
wire stories - a stand-in for real story clustering/dedup, which is
explicitly a Stage 2 concern, not implemented here. If the cap would
leave fewer than `limit` results (not enough source diversity in the
candidate pool), the highest-scoring capped-out articles backfill the
remaining slots rather than returning a short list.

`maxPerCategory` works the same way but is opt-in (no default) - a caller
that already filtered its candidates to one category (e.g.
`/articles/top?category=business`) must not pass it, or every result
would be truncated to the cap instead of the requested limit. Only the
"all categories" top-stories view should pass this.

## `story-ranking.js`: Stage 2 story-level ranking

Read-time aggregation of Stage 1 article scores, mirroring this file's own
`computeRankingScore`/`rankArticles` shape. Deliberately does NOT
reimplement freshness/importance/source-authority - every one of those is
reused directly from here so Stage 1 stays the single source of truth for
per-article scoring.

`computeStoryScore` is deliberately dominated by the single best member
article's own Stage 1 score (see `STORY_SCORE_WEIGHTS.bestArticle` in
`ranking-tuning.md`) - article count never appears in this formula at
all, only as display metadata elsewhere. `distinctSourceCount` (not raw
member count) is what rewards genuine independent-source corroboration
over syndicated duplicates padding out one story with copies from a
single source.

`rankStories`'s `memberArticlesByStoryId` is a `Map<storyId, article[]>` -
the caller (`routes/stories.js`) is responsible for loading members,
keeping this file itself DB-free like `ranking.js`. `maxPerCategory`
mirrors `rankArticles`: opt-in (no default), and backfills from
capped-out stories (in score order) if too few distinct categories are in
the pool to fill `limit` outright - never returns a short list just
because the cap bit. A caller that already filtered candidates to a
single category must not pass this (see `routes/stories.js`).
