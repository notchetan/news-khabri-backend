// Keeps articles_fts (see db/index.js) in sync with the articles table, and
// turns free-text user search input into a safe FTS5 query - see docs/search.md.
const db = require('./index');

const deleteFtsRowStmt = db.prepare('DELETE FROM articles_fts WHERE rowid = ?');
const insertFtsRowStmt = db.prepare(
  'INSERT INTO articles_fts(rowid, title, description, content) VALUES (?, ?, ?, ?)'
);
const getArticleForFtsStmt = db.prepare(
  'SELECT id, title, description, content FROM articles WHERE id = ?'
);

// Call this at every site that inserts a new article row or updates its
// title/description/content (currently: ingestion/fetcher.js's insert, and
// the content backfill in routes/articles.js's GET /articles/:id) - no DB
// triggers in this codebase, so nothing else keeps this in sync. Re-reads
// the row rather than taking the caller's own fields, so a partial update
// (e.g. just backfilling `content` later) still ends up with a complete,
// correct FTS row rather than blanking out title/description.
function syncArticleFts(articleId) {
  const article = getArticleForFtsStmt.get(articleId);
  if (!article) return;
  // FTS5 doesn't support UPDATE the way an ordinary table does -
  // delete-then-insert is the documented way to change a row's indexed
  // text, for both a fresh insert (deleting a rowid that was never indexed
  // is a safe no-op on this plain FTS5 table - see db/index.js's own
  // comment on why it's plain rather than external-content) and a real update.
  deleteFtsRowStmt.run(article.id);
  insertFtsRowStmt.run(article.id, article.title || '', article.description || '', article.content || '');
}

// Turns raw user search input into an FTS5 MATCH query: each whitespace-
// separated word becomes its own prefix match (so "elect" matches
// "election"), ANDed together. Strips FTS5's own query-syntax characters
// out of each word first so free-text input can never be interpreted as
// query syntax (an unbalanced quote, a bareword "AND"/"OR"/"NOT", a NEAR()
// call, etc.) - every word becomes a plain quoted-phrase-prefix instead,
// which has no operator meaning of its own.
// Returns null if nothing usable is left (e.g. a search of only punctuation).
function buildFtsQuery(search) {
  const terms = String(search)
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/["*^:()]/g, ''))
    .filter(Boolean)
    .map((term) => `"${term}"*`);
  return terms.length ? terms.join(' AND ') : null;
}

module.exports = { syncArticleFts, buildFtsQuery };
