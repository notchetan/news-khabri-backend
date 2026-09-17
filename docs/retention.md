# Retention (`services/retention.js`)

A daily cron (`RETENTION_CRON`, 04:10) trims everything ingestion keeps
adding, in one transaction. Windows live in `services/retention-config.js`.

| Table | Pruned when |
|---|---|
| `read_events` | `read_at` older than 90 days |
| `cluster_decisions` | `created_at` older than 7 days |
| `articles` + `articles_fts` | the article's whole story is stale (below), 60-day window |
| `stories` | no articles left, `updated_at` past the window, nothing merged into it |

## Why 60 days

As of 2026-09 ingest is ~3k articles/day, about 33 MB/day across
`articles`, `stories` and `articles_fts` together, so ~2 GB steady state.
Bookmarked and read articles are exempt, so the window only governs feed and
search history.

## Articles: `last_seen_at`, not `fetched_at` or `published_at`

- `published_at` is the feed's raw RFC-2822 string
  (`Sun, 06 Sep 2026 10:49:16 +0530`) - not comparable as text.
- Some feeds keep listing items for months or years: 12% of articles were
  already 60+ days old when first fetched. Pruning those by `fetched_at`
  would delete articles still in a feed; the next fetch re-inserts them with
  a new `fetched_at` and they'd top the `fetched_at`-sorted feed again, every
  window. `fetcher.js`'s upsert bumps `last_seen_at` on every sighting, so a
  still-listed item is never pruned. Rows from before the column existed fall
  back to `fetched_at` until their next sighting.

## Articles go a whole story at a time

An article is deleted only if no article in its story has been seen within
the window, bookmarked, or read. Deleting some members would leave the
story's `article_count`, `source_count`, representative article and centroid
embedding describing articles that are gone.

Bookmarks and read events protect articles for two reasons: a bookmark is
user data, and both tables have a foreign key to `articles(id)`, which
better-sqlite3 enforces. Read events stop protecting once they age out
themselves (they're pruned first in the same transaction). Bookmarks kept
only on a signed-out device aren't in the table, so opening one past the
window 404s.

## Stories

A story row goes once it has no articles, `updated_at` is past the window
(a just-merged story has no members but must still resolve through
`resolveActiveStory`), and no other story's `merged_into_story_id` points at
it (foreign key). A merge chain therefore unwinds one link per daily run.

## Indexes

Deleting a parent row makes SQLite check every foreign key pointing at it.
Without an index on the child column that check is a full scan of the child
table per deleted row - on the real DB, pruning ~30k stories against an
unindexed `stories.merged_into_story_id` ran for over 10 minutes. `db/index.js`
indexes all three child columns retention deletes through:
`stories.merged_into_story_id`, `read_events.article_id` and
`bookmarks.article_id` (its primary key leads with `user_id`, so it can't
serve an `article_id` lookup).

## Disk size

SQLite reuses freed pages but never shrinks the file by itself. If the file
size matters (e.g. before copying it to a new host), stop the server and run
a one-off `VACUUM`.
