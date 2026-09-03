const express = require('express');
const db = require('../db');
const { rankStories, computeStoryScore } = require('../services/story-ranking');
const { loadReadProfile } = require('../services/personalization');
const { verifySessionToken } = require('../services/auth');
const {
  DEFAULT_TOP_STORIES_LIMIT,
  STORY_FEED_POOL_SIZE,
  MAX_PER_CATEGORY,
} = require('../services/clustering-config');
const { resolveActiveStory } = require('../ingestion/clusterer');

const router = express.Router();

const REPRESENTATIVE_FIELDS = 'id, title, link, source, image_url, published_at';
const MEMBER_FIELDS = 'id, title, link, source, image_url, published_at, language';

// Opt-in, not opt-out: the ?debug=true score breakdown is only ever
// exposed when ENABLE_RANKING_DEBUG is explicitly "true". Keying it off
// `NODE_ENV !== 'production'` meant an unset NODE_ENV in a real deployment
// silently left it on.
function isDebugAllowed(req) {
  return req.query.debug === 'true' && process.env.ENABLE_RANKING_DEBUG === 'true';
}

// Distinct from requireAuth (middleware/require-auth.js) - /stories/top
// stays public. A missing/invalid/expired token just means no
// personalization signal for this request, not a 401 - see
// docs/personalization.md. verifySessionToken never throws (returns null
// for anything invalid), so this is always safe to call.
function getOptionalUserId(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  return verifySessionToken(token);
}

// Loads member articles for a set of story ids in one query, grouped into a
// Map<storyId, article[]> - the shape story-ranking.js's rankStories/
// computeStoryScore expect.
function loadMembersByStoryId(storyIds) {
  const map = new Map();
  if (storyIds.length === 0) return map;
  const placeholders = storyIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM articles WHERE story_id IN (${placeholders})`)
    .all(...storyIds);
  for (const row of rows) {
    if (!map.has(row.story_id)) map.set(row.story_id, []);
    map.get(row.story_id).push(row);
  }
  return map;
}

function toRepresentativeArticle(story, membersByStoryId) {
  const members = membersByStoryId.get(story.id) || [];
  const rep = members.find((m) => m.id === story.representative_article_id);
  if (rep) {
    return {
      id: rep.id,
      title: rep.title,
      link: rep.link,
      source: rep.source,
      image_url: rep.image_url,
      published_at: rep.published_at,
    };
  }
  // Representative row wasn't in the members batch (shouldn't normally
  // happen) - fall back to a direct lookup rather than omitting the field.
  return db
    .prepare(`SELECT ${REPRESENTATIVE_FIELDS} FROM articles WHERE id = ?`)
    .get(story.representative_article_id) || null;
}

function toStoryResponse(story, membersByStoryId, { debug, readProfile } = {}) {
  const members = membersByStoryId.get(story.id) || [];
  const breakdown = computeStoryScore(story, members, new Date(), readProfile);
  const base = {
    id: story.id,
    title: story.title,
    summary: story.summary,
    category: story.category,
    language: story.language,
    articleCount: story.article_count,
    sourceCount: story.source_count,
    firstPublishedAt: story.first_published_at,
    latestPublishedAt: story.latest_published_at,
    storyScore: breakdown.score,
    representativeArticle: toRepresentativeArticle(story, membersByStoryId),
  };
  if (debug) {
    base.scoreBreakdown = {
      bestArticleScore: breakdown.bestArticleScore,
      sourceCountSignal: breakdown.sourceCountSignal,
      recencySignal: breakdown.recencySignal,
      momentumSignal: breakdown.momentumSignal,
      personalizationSignal: breakdown.personalizationSignal,
    };
  }
  return base;
}

router.get('/stories/top', (req, res) => {
  const { category, sources } = req.query;
  const language = req.query.language || 'en';
  const limit = Math.min(Number(req.query.limit) || DEFAULT_TOP_STORIES_LIMIT, 50);
  const debug = isDebugAllowed(req);
  const readProfile = loadReadProfile(getOptionalUserId(req));

  const conditions = ["status = 'active'", 'language = ?'];
  const params = [language];
  if (category) {
    conditions.push('category = ?');
    params.push(category);
  }
  // A story clusters articles from several publishers, so "filter by
  // source" can't be a plain column check like /articles' own - it means
  // "at least one member article came from a selected source" instead.
  const sourceList = sources ? String(sources).split(',').filter(Boolean) : [];
  if (sourceList.length > 0) {
    conditions.push(
      `EXISTS (SELECT 1 FROM articles WHERE articles.story_id = stories.id AND articles.source IN (${sourceList
        .map(() => '?')
        .join(',')}))`
    );
    params.push(...sourceList);
  }

  // Pool by updated_at, not id: `updated_at` is bumped every time a story
  // gains a member (see ingestion/clusterer.js), so an older story that's
  // still attracting fresh coverage stays in the candidate pool instead of
  // aging out behind newer-but-quiet stories. rankStories re-orders what
  // survives. (updated_at is SQLite's own timestamp format - sortable as a
  // string, unlike the raw-RSS `latest_published_at`.)
  const candidateStories = db
    .prepare(
      `SELECT * FROM stories WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ?`
    )
    .all(...params, STORY_FEED_POOL_SIZE);

  const membersByStoryId = loadMembersByStoryId(candidateStories.map((s) => s.id));
  // Only enforce category diversity on the unfiltered "all categories" view
  // - candidateStories is already scoped to one category above when the
  // caller passed one, and capping there would wrongly truncate results.
  const ranked = rankStories(candidateStories, membersByStoryId, {
    limit,
    maxPerCategory: category ? undefined : MAX_PER_CATEGORY,
    readProfile,
  });

  res.json(ranked.map((story) => toStoryResponse(story, membersByStoryId, { debug, readProfile })));
});

router.get('/stories/:id', (req, res) => {
  const story = resolveActiveStory(req.params.id);
  if (!story) {
    res.status(404).json({ error: 'Story not found' });
    return;
  }

  const debug = isDebugAllowed(req);
  const membersByStoryId = loadMembersByStoryId([story.id]);
  const response = toStoryResponse(story, membersByStoryId, { debug });

  // fetched_at (not published_at) for ordering - published_at is raw RSS
  // text (often RFC 2822) and isn't reliably sortable as a SQL string, the
  // same reason /articles paginates on fetched_at instead (see routes/articles.js).
  const members = db
    .prepare(`SELECT ${MEMBER_FIELDS} FROM articles WHERE story_id = ? ORDER BY fetched_at DESC`)
    .all(story.id);

  res.json({ ...response, members });
});

module.exports = router;
// Reused by services/push-notifications.js to compute the same "top story"
// a device would see on /stories/top, without duplicating this query.
module.exports.loadMembersByStoryId = loadMembersByStoryId;
