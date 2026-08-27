# Category alias consolidation (`src/services/category-aliases.js`)

Merges category spellings that differ across publishers beyond case (e.g.
The Hindu's "Sport" vs. Times of India's "Sports"), and consolidates the
long tail of narrow/niche section feeds (etprime, political pulse, north
east india, auto travel, ...) into a small set of ~10 categories a
general reader actually recognizes (cricket kept split from general
sports - popular enough in India to earn its own pill; see
`ingestion/discovery.js`, which requires no extra source work for this
since Times of India already publishes a dedicated "cricket" feed
distinct from its general "sports" feed).

Before this, the English pill list alone had grown to 37 distinct
categories - genuinely unusable as a grid. Each of these still exists as
its own RSS feed on some publisher's site (that's Stage 1's job to keep
fetching, unaffected by this file) - this only governs which top-level
bucket its articles get filed under.

## Runs at discovery time, and needs a one-time backfill when it changes

This runs both at discovery time (new source registrations) and, when
`ALIASES` changes, needs a one-time backfill re-mapping every already-
stored `articles.category`/`stories.category` value through this same
function too - a stale alias here would silently make the live pill list
and the historical backlog disagree on what "India" means. (Done once on
2026-08-27 via a throwaway script - not committed, per this repo's
convention for one-off migrations.)

## Notable alias groupings

- Hindi's three "general news" feeds (Amar Ujala's "ताज़ा ख़बरें", Aaj
  Tak's generic "होम") are the same redundancy in a different language -
  Dainik Bhaskar/NDTV Khabar's "देश" is the one kept as the category
  name.
- `tech` mirrors Dainik Bhaskar's own native "टेक-ऑटो" combination.
- The `opinion` group folds feature/magazine/reference content into the
  already-hidden bucket rather than a real topic, for the same reason
  `opinion` itself is hidden (see `HIDDEN_CATEGORIES` below): this
  content isn't reliably about one topic, so filing it under any single
  pill would misrepresent it. These are all sections
  `INDIAN_EXPRESS_EXCLUDED_SLUGS` (`ingestion/discovery.js`) already
  stops fetching new articles from - this only re-files the historical
  rows that were ingested before that filter existed, so they stop
  dangling as their own stray pills for anyone who queries by the old raw
  name. A second group of historical-cleanup entries maps to a real topic
  bucket instead of `opinion`, for sections that do have one.

## `HIDDEN_CATEGORIES`

Categories hidden from the category pill list entirely, rather than
merged into another one - e.g. "Opinion" doesn't share a topic with any
other section (an op-ed can be about anything), so folding it into
another bucket would misrepresent its articles. Hiding still only affects
the pill list; the articles themselves are untouched and still show up
under "All".
