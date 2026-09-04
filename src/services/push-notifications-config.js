// Tunables for the trending-story push cron (services/push-notifications.js,
// scheduled every 5 minutes in index.js). Config-file-not-inline-numbers,
// same as ranking-config.js etc.

// Cap on how many devices get notified in a single cron tick.
//
// Without a cap, a run of missed ticks (a deploy, a crash, a paused
// container) makes every subscription simultaneously due, so the next
// tick fires one burst to the whole base at once - and worse, they all
// get the same last_notified_at and stay in lockstep from then on. With
// the cap, a backlog drains oldest-waiting-first over several ticks (200
// per 5 min), which also staggers last_notified_at enough to de-sync
// those cohorts. Set comfortably above any realistic steady-state
// per-tick count, so it only ever bites during a backlog.
const MAX_NOTIFICATIONS_PER_TICK = 200;

module.exports = {
  MAX_NOTIFICATIONS_PER_TICK,
};
