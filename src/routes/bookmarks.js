const express = require('express');
const db = require('../db');
const requireAuth = require('../middleware/require-auth');

const router = express.Router();

const getArticleStmt = db.prepare('SELECT id FROM articles WHERE id = ?');
const insertBookmarkStmt = db.prepare(`
  INSERT INTO bookmarks (user_id, article_id)
  VALUES (@user_id, @article_id)
  ON CONFLICT(user_id, article_id) DO NOTHING
`);
const deleteBookmarkStmt = db.prepare(
  'DELETE FROM bookmarks WHERE user_id = ? AND article_id = ?'
);
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

router.post('/me/bookmarks', requireAuth, (req, res) => {
  const articleId = Number(req.body.articleId);
  if (!Number.isInteger(articleId)) {
    res.status(400).json({ error: 'articleId is required' });
    return;
  }

  if (!getArticleStmt.get(articleId)) {
    res.status(404).json({ error: 'Article not found' });
    return;
  }

  insertBookmarkStmt.run({ user_id: req.userId, article_id: articleId });
  res.status(204).end();
});

// Idempotent - removing a bookmark that isn't there is still a 204, so the
// app never has to care whether its optimistic local state was already
// ahead of the server.
router.delete('/me/bookmarks/:articleId', requireAuth, (req, res) => {
  const articleId = Number(req.params.articleId);
  if (!Number.isInteger(articleId)) {
    res.status(400).json({ error: 'articleId must be an integer' });
    return;
  }

  deleteBookmarkStmt.run(req.userId, articleId);
  res.status(204).end();
});

module.exports = router;
