# Sign in with Apple

`POST /auth/apple`, the second sign-in provider alongside `POST /auth/google`
(Apple App Store Guideline 4.8 requires offering it once Google sign-in is
offered). Everything downstream of "verify the third-party token, upsert a
`users` row, issue our own session JWT" is shared with the Google path -
see `docs/google-sign-in.md` for the session-token / `token_version`
revocation machinery. This file is only the Apple-specific bits.

## Verifying the identity token

The app sends Apple's **identity token** (a JWT, RS256, from
`AppleAuthentication.signInAsync`). `services/auth.js`'s
`verifyAppleIdentityToken` checks it with `jose`:

- **signature** against Apple's rotating public keys
  (`https://appleid.apple.com/auth/keys`, a JWKS - `jose`'s
  `createRemoteJWKSet` fetches and caches it, refreshing on key rotation)
- **`iss`** === `https://appleid.apple.com`
- **`aud`** === `APPLE_CLIENT_ID` (default `com.newskhabri.app`). For a
  native iOS sign-in the audience is the app's **bundle id**; a web
  ("Services ID") flow would use that id instead - we only do native.

No client secret is involved: token *verification* uses only Apple's
public keys. The Apple client secret is only for the server-to-server
token endpoints (refresh / revoke), which this app doesn't call.

Returns `{ appleId, email }`. `appleId` is the token's `sub` - the stable
per-user identifier, analogous to Google's `sub`.

## The name quirk

Apple's identity token **never** carries the user's name. The name is
handed to the *client* by `signInAsync`, and **only on the very first
authorization** for this app - every sign-in after that, `fullName` comes
back null. So:

- the app forwards `fullName: { givenName, familyName }` in the request
  body on that first sign-in;
- `POST /auth/apple` joins them into `name` and only ever *fills* an empty
  `users.name` (`ON CONFLICT ... name = COALESCE(users.name, excluded.name)`),
  never overwrites a stored one with a later null.

There's also no avatar - `users.avatar_url` stays null for Apple accounts.

## Email

With the `EMAIL` scope granted, the token's `email` claim is present on
every sign-in - either the real address or Apple's private relay
(`xxxxx@privaterelay.appleid.com`). A brand-new account with no email is
rejected `400` (can't satisfy `users.email NOT NULL`); a return sign-in
with no email is fine, the stored one is kept.

## The `users` schema change

The original table was `google_id TEXT UNIQUE NOT NULL` - Google was the
only provider. `db/index.js` now:

- adds `apple_id TEXT` (guarded `ALTER`);
- **rebuilds the table once** (guarded on `google_id` still being `NOT
  NULL`) to relax that constraint - SQLite can't `ALTER` a `NOT NULL`
  away. Standard rebuild: `foreign_keys OFF`, create/copy/drop/rename in a
  transaction, `foreign_keys ON`. Idempotent; never runs on a fresh
  install (which gets the new `CREATE TABLE` directly) or after the first
  successful rebuild;
- indexes each provider id with a plain `UNIQUE INDEX`. A non-partial
  unique index on a nullable column is correct here: SQLite treats every
  `NULL` as distinct, so all the Apple-only rows sharing `google_id = NULL`
  (and vice-versa) don't collide, and the `ON CONFLICT(google_id)` /
  `ON CONFLICT(apple_id)` upserts still resolve against it.

A row has exactly one of `google_id` / `apple_id` set. There is no
account-linking flow - the same person signing in with Google and then
with Apple gets two separate accounts (same as most apps; revisit only if
there's demand).

## Config

`APPLE_CLIENT_ID` (env, default `com.newskhabri.app`). The `authLimiter`
in `index.js` (30 / 15 min) covers `/auth/apple` as well as `/auth/google`.

## What still needs an Apple Developer account

Nothing server-side - verification is against public JWKS and works today.
The account is needed on the **app** side: enabling the "Sign In with
Apple" capability on the `com.newskhabri.app` App ID, and an EAS build
carrying that entitlement, before the native flow can run on a device.
