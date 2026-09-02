# Personalized ranking

`GET /stories/top` now blends a fourth, optional signal into
`computeStoryScore()` (`story-ranking.js`): how well a story matches a
signed-in user's own recent reading. This needed a capability that didn't
exist before - nothing recorded what a user actually reads - so this is two
pieces: recording reads, and using them.

## Recording: `read_events` + `POST /me/reads`

One row per article a signed-in user opens (`db/index.js`). `category`,
`source`, and `entities_json` are captured from the article's own story *at
read time* - denormalized onto the row, the same reasoning
`stories.entities_json` already accumulates - so `personalization.js` never
has to re-join back to `articles`/`stories` every time it scores a story
against a user's history.

`POST /me/reads` (`routes/reads.js`, behind the existing `requireAuth`
middleware) is the only writer. It looks the article up server-side rather
than trusting whatever `category`/`source`/`entities` a client might send -
a buggy or malicious client can at most misrecord *its own* reading
history, never fabricate signal it doesn't actually have standing to send.

If the article isn't clustered into a story yet (`story_id` is null),
`entities_json` on the read event is null too - contributes nothing to the
entity-overlap sub-signal below, but category/source affinity still apply.

## Using it: `services/personalization.js`

`loadReadProfile(userId)` builds a lightweight profile from a user's recent
`read_events` - a recency-and-count-capped window
(`personalization-config.js`'s `READ_HISTORY_LIMIT`/`READ_HISTORY_DAYS`),
not their entire lifetime history, so interests can shift over time without
old reads permanently anchoring the feed. Returns `null` for a signed-out
request (`userId` falsy) or a signed-in user with no read history yet -
both cases mean exactly the same thing downstream.

`computePersonalizationSignal(profile, story, memberArticles)` returns a
0-1 signal blending three sub-signals
(`personalization-config.js`'s `PERSONALIZATION_SUB_WEIGHTS`):
- **category affinity** - what fraction of the user's recent reads were
  this story's category.
- **source affinity** - the strongest match among the story's *own* member
  articles' sources (a story has several sources, not one -
  `stories` itself has no `source` column, unlike `articles`).
- **entity overlap** - `jaccardSimilarity` (`text-similarity.js`), the
  *exact same function* `clustering.js` already uses for `entityOverlap`
  between two stories, here pointed at a story's `entities_json` vs. the
  user's own merged recent-read entity set instead. Weighted highest of the
  three - two stories can share a category/source and still be about
  completely different things, but sharing named entities is a much
  stronger "this is the kind of thing you've been reading" signal.

`computePersonalizationSignal(null, ...)` always returns exactly `0` -
this is the one invariant everything else depends on.

## Wiring into ranking

`routes/stories.js`'s `GET /stories/top` reads an *optional* bearer token
via `verifySessionToken` directly (not through `requireAuth`, which would
401 anonymous requests - this route stays fully public).
`loadReadProfile(userId)` runs once per request and the same profile is
reused across every candidate story being scored, rather than re-querying
`read_events` per story.

`STORY_SCORE_WEIGHTS` (`clustering-config.js`) gained a `personalization`
term (0.1). The other four weights were scaled down *proportionally* from
their pre-personalization values, not adjusted individually - uniform
scaling of every term by the same constant preserves relative ranking order
exactly, which is what makes `computePersonalizationSignal(null, ...) === 0`
a real behavioral guarantee for anonymous/first-time-signed-in requests,
not just a documented intention. (The raw `storyScore` *values* do shift
slightly for everyone once this term exists, even at 0 - that's an
informational/debug field, not a stable numeric contract; only the ranking
*order* is the thing actually promised unchanged.)

## Frontend

- `src/api/reads.ts` - `recordRead(token, articleId)`.
- `article-detail-screen.tsx` / `story-detail-screen.tsx` call it
  fire-and-forget (`.catch(() => {})`, matching `auth-context.tsx`'s own
  `putPreferences` swallow-error convention) whenever a signed-in user opens
  an article/story - a failed read-record isn't worth surfacing to the
  reader.
- `fetchStoryFeed` (`src/api/stories.ts`) sends the session token when one
  exists, so `/stories/top` actually receives it and the signal activates.
