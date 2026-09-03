const express = require('express');
const { z } = require('zod');
const db = require('../db');
const validate = require('../middleware/validate');

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

const upsert = db.prepare(`
  INSERT INTO push_subscriptions (push_token, interval_minutes, language, updated_at)
  VALUES (@pushToken, @intervalMinutes, @language, CURRENT_TIMESTAMP)
  ON CONFLICT(push_token) DO UPDATE SET
    interval_minutes = excluded.interval_minutes,
    language = excluded.language,
    updated_at = CURRENT_TIMESTAMP
`);

// Registers (or updates) one device's notification preference - called
// whenever the interval or language preference changes, not just once at
// signup, so a device that switches from "Off" to "15m" or from English to
// Hindi is picked up on its very next cron tick. See
// docs/push-notifications.md.
router.post('/push-subscriptions', validate({ body: pushSubscriptionBody }), (req, res) => {
  const { pushToken, intervalMinutes, language } = req.body;
  upsert.run({ pushToken: pushToken.trim(), intervalMinutes, language: language || 'en' });
  res.status(204).end();
});

module.exports = router;
module.exports.VALID_INTERVALS = VALID_INTERVALS;
