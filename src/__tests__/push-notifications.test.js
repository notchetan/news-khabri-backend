process.env.DB_PATH = ':memory:';

// A single Expo instance is constructed once at push-notifications.js's own
// module load time, so the mock's methods need to be created outside the
// factory and exposed via __mocks - the module-scope `new Expo()` call
// needs to return the *same* jest.fn() references every test controls.
jest.mock('expo-server-sdk', () => {
  const chunkPushNotifications = jest.fn((messages) => [messages]);
  const sendPushNotificationsAsync = jest.fn();
  const isExpoPushToken = jest.fn(() => true);
  const Expo = jest.fn().mockImplementation(() => ({
    chunkPushNotifications,
    sendPushNotificationsAsync,
  }));
  Expo.isExpoPushToken = isExpoPushToken;
  Expo.__mocks = { chunkPushNotifications, sendPushNotificationsAsync, isExpoPushToken };
  return { Expo };
});

const db = require('../db');
const { Expo } = require('expo-server-sdk');
const { chunkPushNotifications, sendPushNotificationsAsync, isExpoPushToken } = Expo.__mocks;
const { sendTrendingNotifications, isDue, getTopStory } = require('../services/push-notifications');

function insertArticle(overrides = {}) {
  const article = {
    id: overrides.id,
    title: 'Headline',
    link: `https://example.com/${overrides.id}`,
    source: 'NDTV',
    category: 'world',
    published_at: '2026-08-26T09:00:00Z',
    image_url: null,
    fetched_at: '2026-08-26 09:00:00',
    content: null,
    image_caption: null,
    read_time_minutes: null,
    language: 'en',
    description: null,
    story_id: null,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO articles (id, title, link, source, category, published_at, image_url, fetched_at, content, image_caption, read_time_minutes, language, description, story_id)
     VALUES (@id, @title, @link, @source, @category, @published_at, @image_url, @fetched_at, @content, @image_caption, @read_time_minutes, @language, @description, @story_id)`
  ).run(article);
  return article;
}

function insertStory(overrides = {}) {
  const story = {
    title: 'Trending headline',
    summary: null,
    category: 'world',
    language: 'en',
    entities_json: JSON.stringify([]),
    latest_title: 'Trending headline',
    latest_description: null,
    representative_article_id: null,
    representative_quality: 0.5,
    article_count: 1,
    source_count: 1,
    first_published_at: '2026-08-26T09:00:00Z',
    latest_published_at: '2026-08-26T09:00:00Z',
    status: 'active',
    merged_into_story_id: null,
    ...overrides,
  };
  const result = db
    .prepare(
      `INSERT INTO stories (title, summary, category, language, entities_json, latest_title, latest_description,
         representative_article_id, representative_quality, article_count, source_count,
         first_published_at, latest_published_at, status, merged_into_story_id)
       VALUES (@title, @summary, @category, @language, @entities_json, @latest_title, @latest_description,
         @representative_article_id, @representative_quality, @article_count, @source_count,
         @first_published_at, @latest_published_at, @status, @merged_into_story_id)`
    )
    .run(story);
  return result.lastInsertRowid;
}

function insertSubscription(overrides = {}) {
  const subscription = {
    push_token: 'ExponentPushToken[test]',
    interval_minutes: 15,
    language: 'en',
    last_notified_at: null,
    ...overrides,
  };
  const result = db
    .prepare(
      `INSERT INTO push_subscriptions (push_token, interval_minutes, language, last_notified_at)
       VALUES (@push_token, @interval_minutes, @language, @last_notified_at)`
    )
    .run(subscription);
  return result.lastInsertRowid;
}

beforeEach(() => {
  db.exec('DELETE FROM articles');
  db.exec('DELETE FROM stories');
  db.exec('DELETE FROM push_subscriptions');
  jest.clearAllMocks();
  chunkPushNotifications.mockImplementation((messages) => [messages]);
  isExpoPushToken.mockReturnValue(true);
  // One 'ok' ticket per message sent, matching Expo's own real response
  // shape - tests that need a specific ticket (an error, a short list)
  // override this explicitly.
  sendPushNotificationsAsync.mockImplementation((chunk) => Promise.resolve(chunk.map(() => ({ status: 'ok' }))));
});

describe('isDue', () => {
  test('a never-notified subscription is due immediately', () => {
    expect(isDue({ interval_minutes: 15, last_notified_at: null })).toBe(true);
  });

  test('is not due before its own interval has elapsed', () => {
    const now = new Date('2026-08-26T10:00:00Z');
    expect(
      isDue({ interval_minutes: 15, last_notified_at: '2026-08-26T09:50:00Z' }, now)
    ).toBe(false);
  });

  test('is due once its own interval has elapsed', () => {
    const now = new Date('2026-08-26T10:00:00Z');
    expect(
      isDue({ interval_minutes: 15, last_notified_at: '2026-08-26T09:45:00Z' }, now)
    ).toBe(true);
  });
});

describe('getTopStory', () => {
  test('returns the highest-ranked active story for the given language', () => {
    const loId = insertStory({ language: 'en', latest_published_at: '2026-08-26T06:00:00Z' });
    insertArticle({ id: 1, story_id: loId, language: 'en', published_at: '2026-08-26T06:00:00Z' });
    db.prepare('UPDATE stories SET representative_article_id = 1 WHERE id = ?').run(loId);

    const hiId = insertStory({ language: 'en', latest_published_at: '2026-08-26T09:55:00Z' });
    insertArticle({ id: 2, story_id: hiId, language: 'en', published_at: '2026-08-26T09:55:00Z' });
    db.prepare('UPDATE stories SET representative_article_id = 2 WHERE id = ?').run(hiId);

    const top = getTopStory('en');
    expect(top.id).toBe(hiId);
  });

  test('returns null when there are no active stories for that language', () => {
    expect(getTopStory('hi')).toBeNull();
  });

  test('ignores stories in a different language', () => {
    const hiId = insertStory({ language: 'hi' });
    insertArticle({ id: 1, story_id: hiId, language: 'hi' });
    db.prepare('UPDATE stories SET representative_article_id = 1 WHERE id = ?').run(hiId);

    expect(getTopStory('en')).toBeNull();
  });
});

describe('sendTrendingNotifications', () => {
  let nextArticleId = 1;

  // Article ids are explicit (not autoincrement) elsewhere in this file, so
  // a counter avoids collisions across the several stories one test can
  // create - unlike story ids, which autoincrement and are read back from
  // insertStory's own return value instead of assumed.
  function activeStory(language = 'en') {
    const storyId = insertStory({ language, title: 'Big story', latest_title: 'Big story' });
    const articleId = nextArticleId++;
    insertArticle({ id: articleId, story_id: storyId, language });
    db.prepare('UPDATE stories SET representative_article_id = ? WHERE id = ?').run(articleId, storyId);
    return storyId;
  }

  test('does nothing when there are no subscriptions', async () => {
    await sendTrendingNotifications();
    expect(sendPushNotificationsAsync).not.toHaveBeenCalled();
  });

  test('skips a subscription with interval_minutes = 0 (off)', async () => {
    activeStory();
    insertSubscription({ interval_minutes: 0 });

    await sendTrendingNotifications();
    expect(sendPushNotificationsAsync).not.toHaveBeenCalled();
  });

  test('skips a subscription that is not due yet', async () => {
    activeStory();
    const now = new Date('2026-08-26T10:00:00Z');
    insertSubscription({ interval_minutes: 15, last_notified_at: now.toISOString() });

    await sendTrendingNotifications(now);
    expect(sendPushNotificationsAsync).not.toHaveBeenCalled();
  });

  test('sends the trending story title to a due subscription and marks it notified', async () => {
    const storyId = activeStory();
    const id = insertSubscription({ interval_minutes: 15, last_notified_at: null });
    const now = new Date('2026-08-26T10:00:00Z');

    await sendTrendingNotifications(now);

    expect(sendPushNotificationsAsync).toHaveBeenCalledWith([
      expect.objectContaining({
        to: 'ExponentPushToken[test]',
        body: 'Big story',
        data: { storyId },
      }),
    ]);
    const row = db.prepare('SELECT last_notified_at FROM push_subscriptions WHERE id = ?').get(id);
    expect(row.last_notified_at).toBe(now.toISOString());
  });

  test('sends each language its own trending story, computed once per language not once per device', async () => {
    const enStoryId = activeStory('en');
    const hiStoryId = activeStory('hi');
    insertSubscription({ push_token: 'ExponentPushToken[en1]', language: 'en' });
    insertSubscription({ push_token: 'ExponentPushToken[en2]', language: 'en' });
    insertSubscription({ push_token: 'ExponentPushToken[hi1]', language: 'hi' });

    await sendTrendingNotifications();

    const [sentMessages] = sendPushNotificationsAsync.mock.calls[0];
    expect(sentMessages).toHaveLength(3);
    expect(sentMessages.filter((m) => m.data.storyId === enStoryId)).toHaveLength(2); // both 'en' devices
    expect(sentMessages.filter((m) => m.data.storyId === hiStoryId)).toHaveLength(1); // the 'hi' device
  });

  test('does not notify a language with no active story yet', async () => {
    insertSubscription({ language: 'en' });

    await sendTrendingNotifications();
    expect(sendPushNotificationsAsync).not.toHaveBeenCalled();
  });

  test('deletes a subscription whose token Expo already knows is invalid, without sending to it', async () => {
    activeStory();
    isExpoPushToken.mockReturnValue(false);
    const id = insertSubscription();

    await sendTrendingNotifications();

    expect(sendPushNotificationsAsync).not.toHaveBeenCalled();
    expect(db.prepare('SELECT * FROM push_subscriptions WHERE id = ?').get(id)).toBeUndefined();
  });

  test('deletes a subscription when Expo reports DeviceNotRegistered at send time', async () => {
    activeStory();
    const id = insertSubscription();
    sendPushNotificationsAsync.mockResolvedValue([
      { status: 'error', details: { error: 'DeviceNotRegistered' } },
    ]);

    await sendTrendingNotifications();

    expect(db.prepare('SELECT * FROM push_subscriptions WHERE id = ?').get(id)).toBeUndefined();
  });

  test('a chunk send failure for one language does not stop other chunks from being sent', async () => {
    activeStory('en');
    activeStory('hi');
    insertSubscription({ push_token: 'ExponentPushToken[en1]', language: 'en' });
    insertSubscription({ push_token: 'ExponentPushToken[hi1]', language: 'hi' });
    // Two separate chunks, one per message, so one can fail independently.
    chunkPushNotifications.mockImplementation((messages) => messages.map((m) => [m]));
    sendPushNotificationsAsync
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce([{ status: 'ok', id: 'receipt-1' }]);

    await sendTrendingNotifications();

    expect(sendPushNotificationsAsync).toHaveBeenCalledTimes(2);
  });
});
