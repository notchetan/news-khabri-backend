const express = require('express');
const db = require('../db');
const { syncArticleFts, buildFtsQuery } = require('../db/fts');
const { rankArticles, computeRankingScore } = require('../services/ranking');
const {
  CANDIDATE_POOL_SIZE,
  DEFAULT_TOP_STORIES_LIMIT,
  MAX_PER_CATEGORY,
} = require('../services/ranking-config');
const { scrapeArticle } = require('../ingestion/article-scraper');
const { getSources } = require('../ingestion/source-registry');
const { HIDDEN_CATEGORIES } = require('../services/category-aliases');

const router = express.Router();

const PAGE_SIZE = 20;

// Comma-separated query param -> a clean array (drops empty entries from a
// stray leading/trailing/doubled comma) - shared shape for both the
// `sources` filter below and the frontend's own join(",") of the same list.
function parseListParam(raw) {
  return raw ? String(raw).split(',').filter(Boolean) : [];
}

// Shared by /articles and /articles/top - the language/category/sources
// filtering is identical between "Latest" and "Top Stories", they just
// differ in how the resulting rows get ordered/limited afterwards.
function buildLanguageCategoryConditions(language, category, sources) {
  const conditions = ['language = ?'];
  const params = [language];
  if (category) {
    conditions.push('category = ?');
    params.push(category);
  }
  const sourceList = parseListParam(sources);
  if (sourceList.length > 0) {
    conditions.push(`source IN (${sourceList.map(() => '?').join(',')})`);
    params.push(...sourceList);
  }
  return { conditions, params };
}

router.get('/articles', (req, res) => {
  const { category, cursor, search, sources } = req.query;
  const language = req.query.language || 'en';
  const limit = Math.min(Number(req.query.limit) || PAGE_SIZE, 50);

  // Cursor pagination (fetched_at, id) instead of OFFSET: the fetch cron
  // inserts new rows every 15 minutes, which shifts numeric offsets underneath
  // an in-progress scroll and produces duplicate/skipped rows across pages.
  // A cursor anchored to a specific row is immune to that. Search results
  // keep this exact same chronological ordering/cursor (not BM25 relevance
  // order) specifically so this pagination contract stays valid whether or
  // not `search` is present - see docs/search.md.
  const { conditions, params } = buildLanguageCategoryConditions(language, category, sources);
  // Full-text search over title/description/content (articles_fts, kept in
  // sync by db/fts.js's syncArticleFts) instead of the old `title LIKE
  // '%search%'` - see docs/search.md.
  let joinFts = false;
  if (search) {
    const ftsQuery = buildFtsQuery(search);
    if (!ftsQuery) {
      // Every character was FTS5 query syntax (e.g. a search of only
      // punctuation) - nothing can match that, so short-circuit rather
      // than asking SQLite to evaluate an empty MATCH.
      res.json([]);
      return;
    }
    joinFts = true;
    conditions.push('articles_fts MATCH ?');
    params.push(ftsQuery);
  }
  if (cursor) {
    const [cursorFetchedAt, cursorId] = String(cursor).split('|');
    conditions.push('(fetched_at < ? OR (fetched_at = ? AND id < ?))');
    params.push(cursorFetchedAt, cursorFetchedAt, Number(cursorId));
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const from = joinFts ? 'articles JOIN articles_fts ON articles_fts.rowid = articles.id' : 'articles';

  const rows = db
    .prepare(`SELECT articles.* FROM ${from} ${where} ORDER BY fetched_at DESC, id DESC LIMIT ?`)
    .all(...params, limit);

  // Order here stays chronological/relevance-based (this is not the ranked
  // "Top Stories" endpoint) - the score is attached purely so the debug
  // weightage pill can show it for verification, wherever articles are
  // listed, without affecting how these results are sorted.
  const now = new Date();
  const rowsWithScores = rows.map((article) => {
    const { score, freshness, importance, sourceAuthority } = computeRankingScore(article, now);
    return {
      ...article,
      ranking_score: score,
      ranking_freshness: freshness,
      ranking_importance: importance,
      ranking_sourceAuthority: sourceAuthority,
    };
  });

  res.json(rowsWithScores);
});

// "Top Stories" - ranked by freshness decay + source authority + rule-based
// importance (see services/ranking.js), not chronological. Registered
// before /articles/:id so "top" is never swallowed by that route's :id
// param.
router.get('/articles/top', (req, res) => {
  const { category, sources } = req.query;
  const language = req.query.language || 'en';
  const limit = Math.min(Number(req.query.limit) || DEFAULT_TOP_STORIES_LIMIT, 50);

  const { conditions, params } = buildLanguageCategoryConditions(language, category, sources);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const candidates = db
    .prepare(`SELECT * FROM articles ${where} ORDER BY fetched_at DESC, id DESC LIMIT ?`)
    .all(...params, CANDIDATE_POOL_SIZE);

  // Only enforce category diversity on the unfiltered "all categories" view
  // - candidates is already scoped to one category above when the caller
  // passed one, and capping there would wrongly truncate results.
  res.json(rankArticles(candidates, { limit, maxPerCategory: category ? undefined : MAX_PER_CATEGORY }));
});

router.get('/articles/:id', async (req, res) => {
  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
  if (!article) {
    res.status(404).json({ error: 'Article not found' });
    return;
  }

  if (!article.content) {
    try {
      const scraped = await scrapeArticle(article.link);
      if (scraped) {
        db.prepare(
          'UPDATE articles SET content = ?, image_caption = ?, read_time_minutes = ? WHERE id = ?'
        ).run(scraped.content, scraped.imageCaption, scraped.readTimeMinutes, article.id);
        syncArticleFts(article.id);
        article.content = scraped.content;
        article.image_caption = scraped.imageCaption;
        article.read_time_minutes = scraped.readTimeMinutes;
      }
    } catch (err) {
      console.error(`Failed to scrape article ${article.id}:`, err.message);
    }
  }

  const related = db
    .prepare(
      `SELECT id, title, link, source, category, published_at, image_url
       FROM articles WHERE category = ? AND language = ? AND id != ? ORDER BY fetched_at DESC LIMIT 10`
    )
    .all(article.category, article.language, article.id);

  res.json({ ...article, related });
});

router.get('/categories', (req, res) => {
  const language = req.query.language || 'en';
  const sourceList = parseListParam(req.query.sources);

  // Unfiltered: the full configured taxonomy for this language (registered
  // feeds, not DB content) - unchanged from before, still correct even for
  // a category whose feed hasn't been fetched yet. Once the caller narrows
  // to specific publishers though, a registered-but-currently-empty
  // category pill would be a dead end (tap it, see nothing) - the "Sources"
  // preference is exactly a request to see only *these* publishers' real
  // content, so this switches to what actually has articles for them.
  if (sourceList.length > 0) {
    const placeholders = sourceList.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT DISTINCT category FROM articles WHERE language = ? AND source IN (${placeholders})`)
      .all(language, ...sourceList);
    const categories = rows
      .map((r) => r.category)
      .filter((category) => !HIDDEN_CATEGORIES.has(category));
    res.json([...new Set(categories)]);
    return;
  }

  const categories = getSources()
    .filter((s) => (s.language || 'en') === language)
    .map((s) => s.category)
    .filter((category) => !HIDDEN_CATEGORIES.has(category));
  res.json([...new Set(categories)]);
});

router.get('/languages', (req, res) => {
  res.json([...new Set(getSources().map((s) => s.language || 'en'))]);
});

// Publisher names for the requested language, for the preferences "Sources"
// multi-select - same shape as /categories (each publisher can register
// several feeds/categories, so this is deduped the same way), sorted since
// (unlike categories) there's no fixed taxonomy order to preserve here.
router.get('/sources', (req, res) => {
  const language = req.query.language || 'en';
  const names = getSources()
    .filter((s) => (s.language || 'en') === language)
    .map((s) => s.name);
  res.json([...new Set(names)].sort());
});

module.exports = router;
