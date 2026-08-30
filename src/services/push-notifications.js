const { Expo } = require('expo-server-sdk');
const db = require('../db');
const { rankStories } = require('./story-ranking');
const { STORY_FEED_POOL_SIZE } = require('./clustering-config');
const { loadMembersByStoryId } = require('../routes/stories');

const expo = new Expo();

// Real trending-story lookup, not a mock - same candidate-pool-then-rank
// shape as GET /stories/top?limit=1, just without the HTTP response
// wrapper since this runs from a cron tick, not a request. See
// docs/push-notifications.md.
function getTopStory(language) {
  const candidates = db
    .prepare("SELECT * FROM stories WHERE status = 'active' AND language = ? ORDER BY id DESC LIMIT ?")
    .all(language, STORY_FEED_POOL_SIZE);
  if (candidates.length === 0) return null;

  const membersByStoryId = loadMembersByStoryId(candidates.map((s) => s.id));
  const [top] = rankStories(candidates, membersByStoryId, { limit: 1 });
  return top || null;
}

// Never notified yet counts as due immediately - a device that just turned
// notifications on shouldn't wait a full interval for its first one.
function isDue(subscription, now = new Date()) {
  if (!subscription.last_notified_at) return true;
  const elapsedMs = now.getTime() - new Date(subscription.last_notified_at).getTime();
  return elapsedMs >= subscription.interval_minutes * 60 * 1000;
}

const markNotified = db.prepare('UPDATE push_subscriptions SET last_notified_at = ? WHERE id = ?');
const deleteSubscription = db.prepare('DELETE FROM push_subscriptions WHERE id = ?');

// Runs on a cron tick (see index.js), not per-request - failures for one
// device/language shouldn't stop the rest. Doesn't poll Expo's own delivery
// receipts afterward (a further, optional robustness step - see
// docs/push-notifications.md) - only the immediate send-time ticket errors
// (e.g. a token Expo already knows is dead) are handled here.
async function sendTrendingNotifications(now = new Date()) {
  const subscriptions = db
    .prepare('SELECT * FROM push_subscriptions WHERE interval_minutes > 0')
    .all()
    .filter((s) => isDue(s, now));
  if (subscriptions.length === 0) return;

  // One ranking pass per language, not per device - every device on the
  // same language shares the same trending story.
  const topStoryByLanguage = new Map();
  for (const language of new Set(subscriptions.map((s) => s.language))) {
    topStoryByLanguage.set(language, getTopStory(language));
  }

  const messages = [];
  const subscriptionByToken = new Map();
  for (const subscription of subscriptions) {
    const story = topStoryByLanguage.get(subscription.language);
    if (!story) continue; // Nothing to notify about yet for this language.
    if (!Expo.isExpoPushToken(subscription.push_token)) {
      deleteSubscription.run(subscription.id);
      continue;
    }
    subscriptionByToken.set(subscription.push_token, subscription);
    messages.push({
      to: subscription.push_token,
      title: 'Trending now',
      body: story.title,
      data: { storyId: story.id },
    });
  }
  if (messages.length === 0) return;

  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    let tickets;
    try {
      tickets = await expo.sendPushNotificationsAsync(chunk);
    } catch (err) {
      console.error('Failed to send a push notification chunk:', err.message);
      continue;
    }
    // Tickets come back in the same order as the chunk sent - see
    // expo-server-sdk's own docs.
    tickets.forEach((ticket, i) => {
      const subscription = subscriptionByToken.get(chunk[i].to);
      if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
        // The app was uninstalled/notifications were revoked - Expo will
        // never deliver to this token again, so stop tracking it instead
        // of retrying it forever.
        deleteSubscription.run(subscription.id);
        return;
      }
      markNotified.run(now.toISOString(), subscription.id);
    });
  }
}

module.exports = { sendTrendingNotifications, getTopStory, isDue };
