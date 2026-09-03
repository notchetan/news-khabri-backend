const express = require('express');
const { z } = require('zod');
const db = require('../db');
const requireAuth = require('../middleware/require-auth');
const validate = require('../middleware/validate');

const router = express.Router();

const articleId = z.coerce.number().int().positive();
const articleIdBody = z.object({ articleId });
const bulkBody = z.object({ articleIds: z.array(articleId).max(500, 'at most 500 articleIds') });
const articleIdParam = z.object({ articleId: z.string().regex(/^\d+$/) });

const getArticleStmt = db.prepare('SELECT id FROM articles WHERE id = ?');
const insertBookmarkStmt = db.prepare(`
  INSERT INTO bookmarks (user_id, article_id)
  VALUES (@user_id, @article_id)
  ON CONFLICT(user_id, article_id) DO NOTHING
`);
const deleteBookmarkStmt = db.prepare(
  'DELETE FROM bookmarks WHERE user_id = ? AND article_id = ?'
);
const deleteAllBookmarksStmt = db.prepare('DELETE FROM bookmarks WHERE user_id = ?');
// Joined back to articles so the app's Saved screen can render a real card
// (title/image/source) for each row - the same column set /articles
// exposes, plus bookmarked_at. Newest save first.
const listBookmarksStmt = db.prepare(`
  SELECT
    a.id, a.title, a.link, a.source, a.category,
    a.published_at, a.image_url, a.language,
    b.created_at AS bookmarked_at
  FROM bookmarks b
  JOIN articles a ON a.id = b.article_id
  WHERE b.user_id = ?
  ORDER BY b.created_at DESC, b.article_id DESC
`);

// The account-linked counterpart to the app's on-device guest bookmark
// list - see docs/bookmarks.md. Bookmarks get their own add/remove/list
// endpoints rather than riding in PUT /me/preferences' whole-object
// bundle: the collection is unbounded and changes one item at a time.
router.get('/me/bookmarks', requireAuth, (req, res) => {
  res.json(listBookmarksStmt.all(req.userId));
});

router.post('/me/bookmarks', requireAuth, validate({ body: articleIdBody }), (req, res) => {
  if (!getArticleStmt.get(req.body.articleId)) {
    res.status(404).json({ error: 'Article not found' });
    return;
  }

  insertBookmarkStmt.run({ user_id: req.userId, article_id: req.body.articleId });
  res.status(204).end();
});

// One call to replay a whole on-device guest list at sign-in, instead of
// the app firing N parallel POST /me/bookmarks. Idempotent (ON CONFLICT
// DO NOTHING), deduped, skips ids that aren't real articles (cap enforced
// by the zod schema).
const insertBookmarksBulk = db.transaction((userId, articleIds) => {
  for (const id of articleIds) {
    insertBookmarkStmt.run({ user_id: userId, article_id: id });
  }
});

router.post('/me/bookmarks/bulk', requireAuth, validate({ body: bulkBody }), (req, res) => {
  const ids = [...new Set(req.body.articleIds)];
  if (ids.length === 0) {
    res.status(204).end();
    return;
  }

  const placeholders = ids.map(() => '?').join(',');
  const existing = db
    .prepare(`SELECT id FROM articles WHERE id IN (${placeholders})`)
    .all(...ids)
    .map((r) => r.id);

  insertBookmarksBulk(req.userId, existing);
  res.status(204).end();
});

// Clear the whole list in one call - the app's "Clear all" action. 204
// even when there was nothing to clear.
router.delete('/me/bookmarks', requireAuth, (req, res) => {
  deleteAllBookmarksStmt.run(req.userId);
  res.status(204).end();
});

// Idempotent - removing a bookmark that isn't there is still a 204, so the
// app never has to care whether its optimistic local state was already
// ahead of the server.
router.delete(
  '/me/bookmarks/:articleId',
  requireAuth,
  validate({ params: articleIdParam }),
  (req, res) => {
    deleteBookmarkStmt.run(req.userId, Number(req.params.articleId));
    res.status(204).end();
  }
);

module.exports = router;
