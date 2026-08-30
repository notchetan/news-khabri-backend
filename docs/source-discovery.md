# RSS source discovery (`src/ingestion/discovery.js`)

How each publisher's feed list is discovered, and the research behind
every manual fallback list and filter.

## Redirect resolution

`resolveRedirect` does a cheap HEAD request (no body download) to resolve
a single redirect hop. Some publishers' RSS index pages list a feed URL
with no category slug in it at all - the slug only appears after a 301 to
the real URL - so the slug needed to categorize the feed isn't visible
without resolving it once at discovery time. Resolves to the original URL
on any error, or if there's no redirect (registering the original URL
either way is correct in that case, not just a fallback).

## Indian Express: an allowlist-shaped exclusion list

Indian Express's RSS index lists ~47 section feeds - far more than any
other publisher (Times of India: 16, Economic Times: 17, The Hindu: 7) -
because its page sections a story into much finer sub-splits than other
sites' section structures do. Left unfiltered, this single publisher ends
up as ~60% of the entire ingested article volume on raw feed-count alone,
skewing the candidate pool for both ranking and clustering toward one
publisher's editorial slicing regardless of any per-article scoring.

`INDIAN_EXPRESS_EXCLUDED_SLUGS` excludes sections that are either
redundant sub-splits of a broader category already covered by another
feed (fifa/olympics -> sports, smart-stocks -> business), reference/
explainer content rather than news (how-to, what-is, when-is, who-is,
upsc-current-affairs), or feature/gossip/filler content of the kind
already penalized elsewhere in ranking (horoscope, puzzles-and-games,
trending, good-news, delhi-confidential) - not a blanket cut, every
substantively newsy section (politics, business, world, sports,
entertainment, tech, health, education, ...) stays.

## NDTV: manual fallback, scripted access blocked

NDTV blocks scripted access to every RSS index path tried, so its feed
list can't be discovered automatically - it stays a manual fallback
(`NDTV_FALLBACK`). This was previously leaving NDTV at just 1 feed (167
articles) versus e.g. Times of India's 16 (935) or Indian Express's
dozens - not because NDTV publishes less, but because only its single
generic feed was ever being read. The category feed URLs in
`NDTV_FALLBACK` were confirmed live and genuinely distinct (not aliases
redirecting to the same underlying content) by fetching each directly and
comparing item titles.

## Hindi and Gujarati: manual fallbacks, unlabeled index pages

Dainik Bhaskar's RSS index page (bhaskar.com/rss/) lists category feed
URLs with no adjacent readable label (unlike the English publishers
above), so `HINDI_FALLBACK`'s category names were identified by fetching
each feed and reading its own `<title>` rather than scraped from a page.

Divya Bhaskar (the first source in a language beyond English/Hindi) is
the same publisher group/CMS as Dainik Bhaskar (same
`rss-v1--category-N.xml` URL shape, same manual category-identification
situation). Only the genuinely newsy categories are included in
`GUJARATI_FALLBACK`, the same selectivity as the Indian Express filter
above - Divya Bhaskar's index also lists a utility/how-to section, a
religion/spirituality section, a general "Original" features section, a
magazine section, and an NRI-specific section, none of which made the cut
either.

## Times Group's regional-language properties: one shared parser

Times Group runs the exact same publishing platform behind several
regional-language properties (Vijay Karnataka/Kannada, Maharashtra
Times/Marathi, and the Samayam network for Tamil/Telugu/Malayalam) as
timesofindia.indiatimes.com/economictimes.indiatimes.com - an RSS-index
page listing every section feed, just a newer HTML template
(`class="rss-page__feed-item"` + a `title` attribute, not the older
`id`-based one those two use) - so `discoverTimesGroupRegional` handles
all five instead of five bespoke scraper functions.

Each property lists dozens of section feeds (88 for Vijay Karnataka, 34
for Maharashtra Times when checked) - overwhelmingly hyper-local
district/city editions (Yadgir, Udupi, Kolhapur, Thane, ...), the same
over-representation risk `INDIAN_EXPRESS_EXCLUDED_SLUGS` exists to avoid.
`REGIONAL_CATEGORY_PATTERNS` is deliberately an allowlist rather than a
denylist, since there are far more sections to exclude than to keep here.
It matches against the English URL *slug* each feed's link carries
(`.../india-news/rssfeed/12345.xml`), not the page's own native-script
display text - confident, since it's plain English, rather than a manual
translation of dozens of native-script section names per language nobody
on this project reads fluently enough to verify.

The patterns are substrings, not exact slug equality: the same topic
isn't spelled the same way across these five properties (Vijay Karnataka
uses bare "india"; Maharashtra Times uses "india-news"), and guessing
every property's exact spelling in advance isn't reliable - a pattern
that matches on the recognizable word inside the slug is. World/
international is checked first, and `\b`-bounded on "national" - a bare
`/national/` substring match would also fire on "international"
(inter-national), miscategorizing world news as india. This was found by
actually running the pattern against real Maharashtra Times data, not
guessed: `.../international/rssfeed/...` was landing under "india"
before the fix.

Some of these properties' index pages list a feed URL with no category
slug in it at all - the slug only appears after a 301 redirect to the
real URL (confirmed for Maharashtra Times: every link on its /rss page is
bare `.../rssfeed/N.xml`, redirecting to
`.../maharashtra/pune-news/rssfeed/N.xml`). `discoverTimesGroupRegional`
follows that hop once per candidate feed via `resolveRedirect` so the
slug needed to categorize it is actually visible; a property whose links
already carry the slug directly (Vijay Karnataka) just resolves to
itself, a harmless extra HEAD request during this once-daily discovery
pass.

## Bengali, Malayalam, Odia: single combined-feed sources

These publish one combined "home" feed rather than per-category ones
(same `'national' -> 'india'` alias path Amar Ujala/NDTV's own general
feeds already use - see `services/category-aliases.js`). Verified live
and legitimate, not scraped programmatically. Anandabazar Patrika, Zee
Bengali, and Lokmat were checked during the same research and found to
sit behind bot-blocking WAFs that reject scripted requests entirely (not
just this discovery script - a real risk for the production fetcher too)
- excluded rather than registered and silently failing every fetch.

## BBC Sport: manual fallback, sports-only publisher

A single/few-feed sports publisher, not a full multi-category newsroom
with an RSS index page to scrape - same shape as NDTV's situation above,
just by nature of the publisher rather than any access-blocking.
`SPORTS_FALLBACK`'s two feeds were confirmed live and genuinely distinct
by fetching each directly and reading its own `<title>`/`<description>`:
`sport/rss.xml` ("BBC Sport - Sport Front Page") and `sport/cricket/rss.xml`
("BBC Sport - Cricket") are both kept since cricket is this app's
dominant sport and BBC runs the two as separate feeds rather than one
folding into the other. Categorized as `sports` and `cricket`
respectively - cricket is deliberately its own category, not folded into
`sports` (see `docs/category-taxonomy.md`).

### ESPN Cricinfo: excluded, Akamai blocks every article page

ESPN Cricinfo's RSS feeds themselves are fetchable (`feeds/0.xml` is its
general "Cricket news from Cricinfo.com" feed - not `feeds/6.xml`, which
is India-specific cricket news, already well covered by the existing
Indian publishers), but every article page returns `403 Access Denied`
from Akamai (`errors.edgesuite.net`) regardless of how the request is
made - a plain fetch, full browser-shaped headers, and a real headless
Chromium (Playwright) with a genuine UA all hit the identical block. This
points at an IP-reputation block rather than a header/JS check, since
none of those changed the outcome. That means `article-scraper.js` (see
`docs/article-scraper.md`) can never produce full content for these -
`scrapeArticle` always returns `null`, and every single article would
permanently fall back to the generic "couldn't load article" state
(`articleContentError` in the frontend) rather than that being an
occasional edge case like it is for other sources. Left out rather than
registered in a permanently-degraded state; BBC Sport's own cricket feed
above covers the same beat with working scraping.
