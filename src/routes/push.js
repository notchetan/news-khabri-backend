const express = require('express');
const { z } = require('zod');
const { Expo } = require('expo-server-sdk');
const db = require('../db');
const validate = require('../middleware/validate');
const { verifySessionToken } = require('../services/auth');

const router = express.Router();

// Matches the frontend's own picker options exactly (0 = off) - rejecting
// anything else here means a malformed/future client value can never sit
// in the DB silently never firing (or firing every cron tick).
const VALID_INTERVALS = new Set([0, 5, 15, 30, 60, 120]);

const pushSubscriptionBody = z.object({
  pushToken: z.string().trim().min(1),
  intervalMinutes: z
    .number()
    .refine((n) => VALID_INTERVALS.has(n), 'intervalMinutes must be one of 0, 5, 15, 30, 60, 120'),
  language: z.string().trim().min(1).optional(),
});
const pushTokenOnly = z.object({ pushToken: z.string().trim().min(1) });

const upsert = db.prepare(`
  INSERT INTO push_subscriptions (push_token, interval_minutes, language, user_id, updated_at)
  VALUES (@pushToken, @intervalMinutes, @language, @userId, CURRENT_TIMESTAMP)
  ON CONFLICT(push_token) DO UPDATE SET
    interval_minutes = excluded.interval_minutes,
    language = excluded.language,
    user_id = excluded.user_id,
    updated_at = CURRENT_TIMESTAMP
`);
const deleteByToken = db.prepare('DELETE FROM push_subscriptions WHERE push_token = ?');

// Anonymous by design - notifications are offered to guests too - but an
// Authorization header, when present and valid, links the row to that
// account (so DELETE /me can clean it up, and a re-register after sign-out
// nulls it back to NULL). No requireAuth; a missing/invalid token just
// means "guest".
function optionalUserId(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  return verifySessionToken(token) || null;
}

// Registers (or updates) one device's notification preference - called
// whenever the interval or language preference changes, not just once at
// signup, so a device that switches from "Off" to "15m" or from English to
// Hindi is picked up on its very next cron tick. See
// docs/push-notifications.md.
router.post('/push-subscriptions', validate({ body: pushSubscriptionBody }), (req, res) => {
  const { pushToken, intervalMinutes, language } = req.body;
  const token = pushToken.trim();
  // Reject anything that isn't a real Expo push token up front - the cron
  // already discards these before sending, so there's no point storing one.
  if (!Expo.isExpoPushToken(token)) {
    res.status(400).json({ error: 'pushToken is not a valid Expo push token' });
    return;
  }
  upsert.run({
    pushToken: token,
    intervalMinutes,
    language: language || 'en',
    userId: optionalUserId(req),
  });
  res.status(204).end();
});

// Called by a device on sign-out to forget its own subscription (it holds
// the token, so no auth needed). 204 even if there was nothing to delete.
router.delete('/push-subscriptions', validate({ body: pushTokenOnly }), (req, res) => {
  deleteByToken.run(req.body.pushToken.trim());
  res.status(204).end();
});

module.exports = router;
module.exports.VALID_INTERVALS = VALID_INTERVALS;
