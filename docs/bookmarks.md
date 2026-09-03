# Article bookmarks

Readers can save an article to come back to later. This works signed-out
and signed-in, with the same guest-vs-account split every other
preference already has (see `docs/google-sign-in.md`):

- **Guest** - bookmarks live only in the app's own `AsyncStorage`
  (`bookmarks` key), a JSON array of enough article fields to render the
  Saved screen offline.
- **Signed-in** - bookmarks are rows in the `bookmarks` table
  (`db/index.js`), keyed `(user_id, article_id)`, and sync across every
  device that account signs in on.

## Own endpoints, not the preference bundle

`PUT /me/preferences` is a whole-object replace of one row - it works
because the preference set is small and fixed. Bookmarks aren't: the
collection is unbounded and changes one item at a time. So they get their
own endpoints instead (`routes/bookmarks.js`, all behind `requireAuth`),
the same call shape `read_events` / `POST /me/reads` already uses:

- `GET /me/bookmarks` - the user's saved articles, joined back to
  `articles` so each row is a full card (title/image/source/...), newest
  save first, each with `bookmarked_at`.
- `POST /me/bookmarks` `{ articleId }` - looks the article up server-side
  (`404` if unknown), then `INSERT ... ON CONFLICT(user_id, article_id) DO
  NOTHING`. `204`.
- `POST /me/bookmarks/bulk` `{ articleIds: number[] }` - the same insert
  for a whole list in one transaction (deduped, non-integers and ids that
  aren't real articles dropped silently, capped at 500). `204`. Used for
  the sign-in replay below instead of N single POSTs.
- `DELETE /me/bookmarks/:articleId` - `204` even if nothing matched.
- `DELETE /me/bookmarks` - clears the whole list for the user in one call
  (the app's "Clear all" action). `204` even when there was nothing to
  clear.

## No server-side merge

There is no "merge my guest list into my account" endpoint. On sign-in
the app just replays its whole on-device list through
`POST /me/bookmarks/bulk` in one call; the composite primary key means a
re-save of something the account already had is a harmless no-op, and
`DELETE` of something already gone is too. After the replay the app pulls `GET /me/bookmarks`
and adopts that as the device's list. The union happens on the client, and
both endpoints being idempotent is what keeps that safe to do bluntly.
