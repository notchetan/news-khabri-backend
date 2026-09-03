# Google Sign-In and account-linked preferences

## Architecture: our own session token, not the Google ID token, after the first exchange

The frontend uses `@react-native-google-signin/google-signin` to get a
Google ID token from the native sign-in flow, then sends it once to `POST
/auth/google`. This route verifies it with `google-auth-library`
(signature + `aud` claim, matching `GOOGLE_WEB_CLIENT_ID`), upserts a
`users` row keyed on the token's `sub` claim (the account's stable
identifier - `email` can change, `sub` doesn't), and issues this app's own
JWT (`services/auth.js`'s `signSessionToken`). The frontend stores and
sends *that* token (`Authorization: Bearer <token>`) on every later
request - it never re-sends the Google token. This is the standard shape
for a mobile app backed by Google Sign-In: Google is only involved in the
initial identity handshake, not in every request afterward.

## Why the Web client ID, not an Android-specific one

`@react-native-google-signin/google-signin` is configured with a single
`webClientId` (a Google Cloud Console "Web application" OAuth client, not
the Android one you also register there for the SHA-1/package-name
match). That's deliberately what ends up as the ID token's own `aud`
claim on every platform, Android included - so the backend only ever
needs to check the token against one client ID
(`GOOGLE_WEB_CLIENT_ID`) regardless of which platform the sign-in
happened on.

## `sources_json` mirrors the frontend's own AsyncStorage shape

`user_preferences.sources_json` stores the exact same `{ en: [...], hi:
[...] }` per-language shape the frontend's own `sourcesPreference`
AsyncStorage key already uses (see the frontend's
`contexts/sources-preference.tsx`), rather than a normalized per-language
table.

`PUT /me/preferences` is a **partial patch**: it merges the fields present
in the request body over the stored row and leaves absent fields
untouched. The app sends only the field(s) a device actually changed
(`auth-context.tsx`'s `diffPreferenceBundle` against a last-synced
baseline), so two signed-in devices editing *different* preferences no
longer clobber each other. A client that sends the whole bundle (a new
account's first sync) still works - every field is present, so the merge
is a full replace. There are no per-field timestamps yet, so two devices
racing on the *same* field is still last-writer-wins for that one field.

## `DELETE /me` clears every table explicitly

Foreign keys are enforced (better-sqlite3's default) but no table declares
`ON DELETE CASCADE`, so account deletion can't lean on the parent delete
alone. `DELETE /me` (auth required) runs one transaction that clears
`read_events`, `bookmarks`, and `user_preferences` for the user - child
rows first - and then the `users` row itself. Add any future
user-referencing table to that transaction in `routes/auth.js`.
`push_subscriptions` is deliberately not in it: it's keyed by device push
token, not `user_id`, so there's nothing there to attribute to the
account. The app stores are the reason this exists at all (Apple
guideline 5.1.1(v)). The old session JWT stays signature-valid until it
expires, but every authed route returns 404 once the `users` row is gone,
and the app drops its stored token on a successful delete.

## `JWT_SECRET` fails loudly outside tests

`services/auth.js` throws at require-time if `JWT_SECRET` is unset,
*unless* `NODE_ENV === 'test'` (which Jest sets on its own, unprompted -
the whole test suite gets a working default secret without any test file
needing to set one itself, unlike `DB_PATH`, which genuinely does need to
differ per test file for an isolated in-memory DB). Any real run needs its
own `.env` (see `.env.example`) - silently defaulting a real deployment to
a guessable secret would let anyone forge a session token.
