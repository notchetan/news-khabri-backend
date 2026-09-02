# Stage 1 ranking: calibration history

Every tunable knob for Stage 1 ranking lives in
`src/services/ranking-config.js`, so the scoring logic in `ranking.js`
never hardcodes a number. This doc is the calibration history behind each
value.

## `RANKING_WEIGHTS`

Must stay roughly summing to 1 for the final score to land in `[0, 1]`,
but nothing enforces that mechanically - these are just relative weights.
`importance` leads (was 0.35) and `freshness` was cut back (was 0.4)
after real `/stories/top` data showed the previous balance meant
"whatever was published in the last 20 minutes" beat genuinely more
significant but slightly older stories almost every time - freshness
should break ties among similarly-important stories, not override
importance outright.

`FRESHNESS_DECAY_HOURS` (12) is the divisor in
`exp(-ageInHours / FRESHNESS_DECAY_HOURS)` - smaller values make
freshness fall off faster. 12 means a 12-hour-old article has decayed to
~37% freshness (1/e).

## `SOURCE_AUTHORITY`

A relatively small signal by design (`sourceAuthority` is the smallest of
the three weights) - reflects each source's general editorial
reach/reliability, not a judgment on any single article. NDTV (English)
had no entry here at all before it went from 1 feed to 7 - every one of
its articles was silently falling back to `DEFAULT_SOURCE_AUTHORITY`.
Tiered with Times of India/Indian Express (0.8), matching its comparable
standing as a major national English outlet.

## Importance keyword lists

Rule-based, deliberately just keyword lists (no ML/embeddings) so it
stays explainable and easy to extend by editing the list. Every article
starts at `IMPORTANCE_BASELINE` (0.5) and each matching keyword nudges
the score up or down.

The economic/financial boost keywords are deliberately only genuinely
national-scale economic signals. Generic financial vocabulary ('crore',
'billion', 'trillion', bare 'stock market') used to be in this list and
fired on nearly every routine company-level markets story (any stock
report mentions rupee amounts in crore), not just significant ones - see
"Single-company stock-price penalty pattern" below for the complementary
fix targeting that same class of story directly.

The "inspirational/filler content" penalize keywords (proverb, quote of
the day, motivational, ...) were added after a real ranking trace: a
"proverb of the day" piece scored a neutral 0.5 (no boost, no penalty)
and rode freshness alone into the top 20 alongside genuine breaking news.

### Per-language lists

`IMPORTANCE_KEYWORDS` is keyed by language (`en`, `hi`, `gu`, `bn`, `kn`,
`mr`, `ml`, `ta`, `te`, `or`) - `computeImportance()` looks up
`article.language`, falling back to `en` for anything unrecognized. Before
this, the list was English-only, so a non-English article could never
match any keyword and always scored exactly `IMPORTANCE_BASELINE`
regardless of actual newsworthiness, while English articles got real
differentiation - a language-fairness bug, not just a missing feature,
since `computeImportance`'s output feeds `bestArticleScore`, the dominant
term (0.62) in `computeStoryScore()` (`story-ranking.js`).

Each language keeps the same category groupings as the English list
(political, war, disaster, economic, corporate, tech, sports, deaths) so
the calibration history above still applies per-category regardless of
language. Institutional acronyms (RBI, GDP, IPO, CEO, AI) stay in Latin
script in every language's list - that's how they actually appear in real
regional-language news text, not an untranslated gap.

The hi/gu/bn/kn/mr/ml/ta/te/or lists are DRAFT machine-assisted
translations, not reviewed by native speakers - same caveat as the
frontend's own bn/kn/mr/ml/ta/te/or locale files
(`news-khabri`'s `src/i18n/locales/bn.ts`). To extend an existing list or
add a new language, add an entry to `IMPORTANCE_KEYWORDS` in
`ranking-config.js` following the same category grouping, then re-run
`ranking.test.js`'s per-language `computeImportance` cases against a few
real recent headlines in that language before trusting the calibration.

## Single-company stock-price penalty pattern

`IMPORTANCE_PENALIZE_PATTERNS` targets single-company stock-price-movement
stories ("XYZ shares surge 14% after ...", "ABC stock jumps 8% on ...") -
routine, narrow-audience financial news (one company's share price, not
the wider economy) that nonetheless reads as "important" to a keyword
scanner since it's full of numbers and financial vocabulary.

Distinguished from a genuinely broad market move by phrasing convention:
a whole-market story is normally reported around an index ("Sensex
tumbles 1,000 points", "Nifty falls 2%"), not "shares" - this pattern
only fires on the individual-company phrasing, so market-wide news keeps
its `'market crash'` boost keyword untouched. Found by tracing the actual
#1 `/stories/top` result to a single Economic Times "shares surge 14%"
filing story.

The pattern-based penalty (`IMPORTANCE_PATTERN_PENALIZE_WEIGHT`, 0.15) is
weighted heavier than a single keyword match
(`IMPORTANCE_PENALIZE_WEIGHT`, 0.1) - a regex match on a specific
phrasing convention is a much more confident signal than one coincidental
word.

## Diversity caps

- `MAX_PER_SOURCE` (3): the "avoid too many very similar articles"
  stand-in for Stage 1 (real clustering is a Stage 2 concern) - caps how
  many of the final ranked results can come from the same source.
- `MAX_PER_CATEGORY` (4): caps how many of the final ranked results can
  share the same category, so one narrow vertical (business/markets was
  the concrete case that motivated this) can't crowd out a broad
  mainstream feed even when its articles happen to score well. Only
  meaningful for an unfiltered ("all categories") ranking pass - a caller
  that already filtered candidates to a single category must NOT pass
  this, or the result would be truncated to this cap instead of the
  requested limit (see `routes/articles.js`).
