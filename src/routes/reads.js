const express = require('express');
const { z } = require('zod');
const db = require('../db');
const requireAuth = require('../middleware/require-auth');
const validate = require('../middleware/validate');

const router = express.Router();

const articleIdBody = z.object({ articleId: z.coerce.number().int().positive() });

const getArticleStmt = db.prepare('SELECT id, story_id, category, source FROM articles WHERE id = ?');
const getStoryEntitiesStmt = db.prepare('SELECT entities_json FROM stories WHERE id = ?');
const insertReadEventStmt = db.prepare(`
  INSERT INTO read_events (user_id, article_id, story_id, category, source, entities_json)
  VALUES (@user_id, @article_id, @story_id, @category, @source, @entities_json)
`);

// Records that a signed-in user read an article - the source signal behind
// services/personalization.js's ranking boost. Looks the article up
// server-side and denormalizes its category/source/story-entities onto the
// read_events row (see docs/personalization.md) rather than trusting
// whatever the client might send for those fields.
router.post('/me/reads', requireAuth, validate({ body: articleIdBody }), (req, res) => {
  const article = getArticleStmt.get(req.body.articleId);
  if (!article) {
    res.status(404).json({ error: 'Article not found' });
    return;
  }

  const story = article.story_id ? getStoryEntitiesStmt.get(article.story_id) : null;

  insertReadEventStmt.run({
    user_id: req.userId,
    article_id: article.id,
    story_id: article.story_id,
    category: article.category,
    source: article.source,
    entities_json: story ? story.entities_json : null,
  });

  res.status(204).end();
});

module.exports = router;
