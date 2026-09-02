# Full-text search

`GET /articles?search=...` used to be `title LIKE '%search%'` - exact
substring, title only, no ranking. It's now backed by a SQLite FTS5 virtual
table, `articles_fts` (`db/index.js`), searching title + description +
content.

## Why a plain FTS5 table, not "external content"

FTS5 supports an "external content" mode (`content='articles',
content_rowid='id'`) that avoids duplicating the indexed text in storage -
the FTS index just points back at the real table. This looked like the
obvious choice, and was the original design here, but it has a sharp edge:
an external-content table's `DELETE` has to look up the row's *current*
content in the referenced table to figure out what to remove from the
index. The very first sync for a newly-inserted article deletes a rowid
that was never actually indexed yet (see `syncArticleFts` below) - FTS5's
external-content `DELETE` trips `SQLITE_CORRUPT_VTAB` on that. Verified
empirically (a standalone `better-sqlite3` repro, not a hypothetical), not
a documented gotcha found by reading first.

`articles_fts` is a plain FTS5 table instead - it keeps its own copy of the
text, so `DELETE FROM articles_fts WHERE rowid = ?` for a rowid that was
never indexed is just a safe no-op, matching ordinary SQL semantics. The
duplicated storage (title/description/content, once in `articles`, once in
the FTS index) is a small, worthwhile trade for not hitting that corruption
class at all.

## Keeping it in sync

This codebase has no DB triggers anywhere (`grep "CREATE TRIGGER"
src/db/index.js` is empty) - `articles_fts` stays consistent with that:
`db/fts.js`'s `syncArticleFts(articleId)` is called explicitly at every
site that inserts a new article or changes its title/description/content,
currently:
- `ingestion/fetcher.js`'s `insert.run(...)` (every article, at ingest time)
- `routes/articles.js`'s `GET /articles/:id` content backfill (the lazy
  scrape that fills in `content`/`image_caption`/`read_time_minutes` on
  first detail view)

`syncArticleFts` always re-reads the article row rather than trusting the
caller's own fields, so a partial update (e.g. just backfilling `content`
later) still produces a complete, correct FTS row instead of blanking out
title/description that weren't part of that particular write.

A database that already had articles before this table existed gets a
one-time backfill in `db/index.js`, guarded by "FTS table is empty AND
articles table isn't" - a fresh install has nothing to backfill (the loop
never runs), an existing install gets indexed once, and every article after
that stays in sync via `syncArticleFts` at its own write site.

**Test-suite gotcha**: any test that inserts articles directly via raw SQL
(bypassing `fetcher.js`'s own insert) needs to call `syncArticleFts` itself
too, the same way the real ingestion path does - see `index.test.js`'s
shared `insertArticle` helper. Skipping this doesn't error, it just means
the article silently never shows up in a search test, which reads like a
matching bug rather than a fixture gap - easy to misdiagnose.

## Turning user input into a safe query

`buildFtsQuery` (`db/fts.js`) splits the raw search string into words, each
becoming its own quoted-phrase prefix match (`"word"*`), ANDed together
across words. Every FTS5 query-syntax character is stripped out of each
word first, so free-text user input can never be interpreted as FTS5 query
syntax - a bareword `AND`/`OR`/`NOT`, an unbalanced quote, a `NEAR(...)`
call, etc. all just become part of an inert quoted phrase instead of an
operator. Returns `null` if nothing usable survives (a search of only
punctuation), which the route treats as "no results" rather than asking
SQLite to evaluate an empty `MATCH`.

Prefix matching (not fuzzy/typo-tolerant matching - FTS5 doesn't do that
natively) means "elect" matches "election", but a genuine typo like
"electon" still won't match "election". That's a real, honest limitation,
not oversold as full typo tolerance anywhere in the code comments.

## Ordering and pagination stay chronological, not relevance-ranked

`GET /articles` already used cursor-based pagination
(`fetched_at`/`id`-based, not `OFFSET`) so an in-progress infinite scroll
doesn't skip/duplicate rows as the fetch cron inserts new articles
underneath it. Switching search results to BM25 relevance order would break
that cursor scheme - a client's cursor encodes `fetched_at|id` regardless
of what order produced the page it came from, and relevance order has no
relationship to `fetched_at`. So search results keep the exact same
`ORDER BY fetched_at DESC, id DESC` as every other view of this endpoint -
the improvement here is entirely in *what* matches (title+description+
content, tokenized, prefix-tolerant) rather than *how results are ranked*.
Relevance ranking is a real, deliberately-deferred follow-up, not an
oversight - it would need its own pagination scheme.

## Non-English search quality

FTS5's default tokenizer (`unicode61`) is Latin-script/English-oriented.
Search still works in every supported language (case folding and basic
word-splitting apply everywhere), but stemming/normalization quality is
meaningfully better for English than for the 9 Indic languages this app
also serves - worth saying plainly rather than overselling. Still strictly
better than the old exact-substring-on-title-only behavior in every
language, just not equally strong across all of them.
