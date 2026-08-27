# Full-article scraping (`src/ingestion/article-scraper.js`)

Fetches an article's original page and extracts its main content (with
inline images) via Readability - the same extraction Firefox Reader View
and Pocket use. Returns `null` if the page can't be fetched or parsed.

## Lazy-loaded images

Many publishers lazy-load images: the `<img src>` is a tiny placeholder
and the real URL lives in a `data-*` attribute (or only in a
`<picture><source>`), swapped in by client-side JS that never runs during
a server-side scrape. `fixLazyImages` rewrites those back to the real URL
so a static HTML renderer shows them.

## Stripping the duplicate lead image

The article's lead image is already shown as a hero above the title, so
`stripLeadImage` drops the first inline image to avoid showing it twice.
It climbs up through wrapper elements that contain nothing but that image
(regardless of how deeply a given publisher nests `<picture>`/`<figure>`
markup), then checks whether a caption paragraph immediately follows it.

A generic "under 220 chars" cutoff for caption detection was too loose -
plenty of real article ledes are short too, and were being misidentified
as photo captions and shown as if they credited the (now-removed) image.
The current check requires either an explicit credit keyword or genuinely
caption-length text (typical photo captions run well under 100 chars),
and explicitly excludes "N min read" text, which sometimes sits right
where a caption would (immediately after the lead image) - that belongs
to `extractReadTime`, not the caption.

## Extracting leaked "N min read" byline text

Some publishers' "N min read" byline text survives Readability's
extraction as a short standalone element near the top of the body (rather
than being stripped as page chrome). `extractReadTime` pulls it out so
the frontend can show it as its own pill instead of leaving it as a stray
line in the body text.

Readability's output is often wrapped in several container divs before
reaching the actual byline line, so the read-time text can end up several
elements deep even though it's still "near the top" - the search covers
`p, div, span, li` instead of only the body's direct children, in
document order (which visits a parent before its own children, so a
combined byline paragraph is matched and removed whole rather than
leaving stray fragments behind), and only looks reasonably close to the
top (first 10 candidates).

To avoid treating genuine article prose that happens to mention a reading
time as leaked metadata, a match only counts if it's either a short
standalone line, or a longer byline/dateline combining the read time with
one or more publish/update dates (`DATE_LIKE_PATTERN`) - a strong signal
it's page chrome, not prose, since real sentences essentially never
contain two formatted dates.
