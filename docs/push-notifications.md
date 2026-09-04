# Trending-story push notifications (`services/push-notifications.js`, `routes/push.js`)

## Why server-driven push, not local scheduled notifications

The frontend lets a user pick a notification interval as fine as 5 minutes.
A purely on-device approach (`expo-notifications`' local scheduling +
background fetch to refresh the content before each fire) can't guarantee
that cadence - iOS in particular does not let an app wake itself in the
background on a fixed short interval; `BGTaskScheduler` intervals are
system-decided and commonly much longer than 15 minutes, with no delivery
guarantee at all. A real push notification (sent from this server through
Expo's push service to APNs/FCM) doesn't have that problem - delivery is
driven by this server's own cron, not the device's background-execution
budget, so a 5-minute interval is actually a 5-minute interval.

## Schema

`push_subscriptions` - one row per device (`db/index.js`):
`push_token` (Expo's own token format, e.g. `ExponentPushToken[...]`,
unique), `interval_minutes` (0 = off - see `routes/push.js`'s
`VALID_INTERVALS`), `language` (which language's trending story this
device wants), `last_notified_at`, `user_id` (nullable - the account the
device was signed into when it last registered; guests stay `NULL`).

`POST /push-subscriptions` upserts by `push_token` - called every time the
interval or language preference changes, not just once at signup, so
switching from "Off" to "15m" (or switching language) takes effect on the
very next cron tick rather than requiring a fresh install-time
registration. It's **anonymous by design** (guests get notifications
too), but an `Authorization: Bearer` header - sent when the device is
signed in - sets `user_id`, and a re-register after sign-out (no header)
nulls it back out. The endpoint also rejects anything
`Expo.isExpoPushToken` doesn't accept. `DELETE /push-subscriptions
{ pushToken }` (no auth - the caller holds the token) is how a device
forgets its own subscription on sign-out.

## Cron cadence and due-checking

`index.js` runs `sendTrendingNotifications()` every 5 minutes - the finest
interval a device can choose. Running the cron itself more often than some
devices' own interval doesn't over-notify them: `isDue()` compares each
subscription's own `interval_minutes` against how long it's actually been
since `last_notified_at` (never-notified counts as due immediately, so a
device that just turned notifications on doesn't wait a full interval for
its first one). A device on a 60-minute interval only actually gets
notified on roughly 1 in 12 ticks.

## One ranking pass per language

`getTopStory(language)` is the same candidate-pool-then-`rankStories` shape
`GET /stories/top?limit=1` uses (reusing `routes/stories.js`'s own
`loadMembersByStoryId` rather than duplicating that query), computed once
per distinct language among the due subscriptions - not once per device -
since every device sharing a language shares the same trending story.

## What isn't implemented: receipt polling

Expo's push service returns a "ticket" immediately at send time, but the
*actual* delivery outcome (whether Apple/Google could reach the device) is
only knowable later via a separate receipt-fetch call, usually ~30 minutes
after sending (see `expo-server-sdk`'s own README). This service only acts
on immediate, send-time information: a token Expo already knows is
malformed (`Expo.isExpoPushToken`) or a `DeviceNotRegistered` ticket error
returned inline. It does not poll receipts afterward to catch a
`DeviceNotRegistered` that only surfaces at the receipt stage, so a
device that uninstalled the app may still be retried for a while before
Expo's own ticket-level check catches it. A real gap, left as a known
follow-up rather than scope creep on the first pass - the core "notify on
your chosen interval" behavior doesn't depend on it.

## No `accessToken` configured

`expo-server-sdk`'s `Expo` client optionally accepts an `accessToken` for
Expo's push-security feature (restricts who can send to your app's
tokens). Not configured here - basic token-based sending doesn't require
it. Worth revisiting if push notifications are ever spoofed/abused.
