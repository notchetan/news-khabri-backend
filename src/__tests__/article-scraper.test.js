const { JSDOM } = require('jsdom');
const {
  fixLazyImages,
  stripLeadImage,
  looksLikePlaceholder,
  extractReadTime,
} = require('../ingestion/article-scraper');

function documentFor(html) {
  return new JSDOM(`<body>${html}</body>`).window.document;
}

describe('looksLikePlaceholder', () => {
  test('flags known placeholder filename patterns', () => {
    expect(looksLikePlaceholder('https://example.com/1x1_spacer.png')).toBe(true);
    expect(looksLikePlaceholder('https://example.com/blank.gif')).toBe(true);
    expect(looksLikePlaceholder('https://example.com/placeholder.jpg')).toBe(true);
  });

  test('flags empty/missing values', () => {
    expect(looksLikePlaceholder('')).toBe(true);
    expect(looksLikePlaceholder(null)).toBe(true);
    expect(looksLikePlaceholder(undefined)).toBe(true);
  });

  test('does not flag a real-looking image URL', () => {
    expect(looksLikePlaceholder('https://example.com/photos/article-71389569.jpg')).toBe(false);
  });
});

describe('fixLazyImages', () => {
  test('rewrites src from data-original when src is a placeholder', () => {
    const doc = documentFor(
      '<img src="https://example.com/1x1_spacer.png" data-original="https://example.com/real.jpg">'
    );
    fixLazyImages(doc);
    expect(doc.querySelector('img').getAttribute('src')).toBe('https://example.com/real.jpg');
  });

  test('tries data-src, then data-lazy-src, then data-lazy in order', () => {
    const doc = documentFor(
      '<img src="blank.gif" data-lazy-src="https://example.com/from-lazy-src.jpg" data-lazy="https://example.com/from-lazy.jpg">'
    );
    fixLazyImages(doc);
    expect(doc.querySelector('img').getAttribute('src')).toBe(
      'https://example.com/from-lazy-src.jpg'
    );
  });

  test('skips a data-* candidate that is itself a placeholder and falls through to picture>source', () => {
    const doc = documentFor(`
      <picture>
        <source srcset="https://example.com/from-srcset.jpg 1x">
        <img src="blank.gif" data-original="blank.gif">
      </picture>
    `);
    fixLazyImages(doc);
    expect(doc.querySelector('img').getAttribute('src')).toBe(
      'https://example.com/from-srcset.jpg'
    );
  });

  test('leaves a non-placeholder src untouched even if data-* attributes exist', () => {
    const doc = documentFor(
      '<img src="https://example.com/real.jpg" data-original="https://example.com/other.jpg">'
    );
    fixLazyImages(doc);
    expect(doc.querySelector('img').getAttribute('src')).toBe('https://example.com/real.jpg');
  });

  test('leaves src as-is when no real candidate can be found anywhere', () => {
    const doc = documentFor('<img src="blank.gif">');
    fixLazyImages(doc);
    expect(doc.querySelector('img').getAttribute('src')).toBe('blank.gif');
  });

  test('handles multiple images independently', () => {
    const doc = documentFor(`
      <img src="blank.gif" data-original="https://example.com/first.jpg">
      <img src="https://example.com/second.jpg">
    `);
    fixLazyImages(doc);
    const imgs = doc.querySelectorAll('img');
    expect(imgs[0].getAttribute('src')).toBe('https://example.com/first.jpg');
    expect(imgs[1].getAttribute('src')).toBe('https://example.com/second.jpg');
  });
});

describe('stripLeadImage', () => {
  // The caption heuristic treats a paragraph right after the image as a
  // likely caption only if it's short (<=100 chars) or has an explicit
  // credit keyword (see the comment in article-scraper.js) - a genuine
  // "no caption" case needs body text long enough to fall outside that
  // heuristic, same as a real article paragraph would be.
  // Built to a guaranteed length (not hand-counted prose) so it reliably
  // falls outside the caption heuristic's <=100-char threshold.
  const LONG_BODY_PARAGRAPH =
    'This is a realistically long opening paragraph of an article body. ' +
    'word '.repeat(40).trim() +
    '.';

  test('removes a bare lead image with no wrapper and no caption', () => {
    const doc = documentFor(`<img src="https://example.com/hero.jpg"><p>${LONG_BODY_PARAGRAPH}</p>`);
    const caption = stripLeadImage(doc);
    expect(caption).toBeNull();
    expect(doc.querySelector('img')).toBeNull();
    expect(doc.body.textContent).toContain(LONG_BODY_PARAGRAPH);
  });

  test('climbs through nested wrapper divs that contain nothing but the image', () => {
    const doc = documentFor(
      `<div><div><picture><img src="https://example.com/hero.jpg"></picture></div></div><p>${LONG_BODY_PARAGRAPH}</p>`
    );
    stripLeadImage(doc);
    expect(doc.querySelector('img')).toBeNull();
    expect(doc.querySelector('picture')).toBeNull();
    expect(doc.body.textContent.trim()).toBe(LONG_BODY_PARAGRAPH);
  });

  test('treats a short paragraph immediately after the image as a caption (by design)', () => {
    const doc = documentFor('<img src="https://example.com/hero.jpg"><p>A short caption.</p>');
    const caption = stripLeadImage(doc);
    expect(caption).toBe('A short caption.');
    expect(doc.body.textContent).not.toContain('A short caption.');
  });

  test('captures a short caption paragraph immediately following the image and removes it', () => {
    const doc = documentFor(
      '<img src="https://example.com/hero.jpg"><p>Photo Credit: Special Arrangement</p><p>Real article body.</p>'
    );
    const caption = stripLeadImage(doc);
    expect(caption).toBe('Photo Credit: Special Arrangement');
    expect(doc.body.textContent).not.toContain('Photo Credit');
    expect(doc.body.textContent).toContain('Real article body.');
  });

  test('does not treat a long following paragraph as a caption unless it mentions credit/photo', () => {
    const longParagraph = 'x'.repeat(250);
    const doc = documentFor(`<img src="https://example.com/hero.jpg"><p>${longParagraph}</p>`);
    const caption = stripLeadImage(doc);
    expect(caption).toBeNull();
    expect(doc.body.textContent).toContain(longParagraph);
  });

  test('returns null and does nothing when there is no image at all', () => {
    const doc = documentFor('<p>Just text, no image.</p>');
    const caption = stripLeadImage(doc);
    expect(caption).toBeNull();
    expect(doc.body.textContent.trim()).toBe('Just text, no image.');
  });

  test('does not remove a following non-paragraph sibling', () => {
    const doc = documentFor('<img src="https://example.com/hero.jpg"><h2>Not a caption</h2>');
    stripLeadImage(doc);
    expect(doc.querySelector('h2')).not.toBeNull();
  });
});

describe('extractReadTime', () => {
  test('extracts and removes a standalone "N min read" line', () => {
    const doc = documentFor('<p>4 min read</p><p>Real article body.</p>');
    const minutes = extractReadTime(doc);
    expect(minutes).toBe(4);
    expect(doc.body.textContent).not.toContain('min read');
    expect(doc.body.textContent).toContain('Real article body.');
  });

  test('recognizes "minute read" as well as "min read"', () => {
    const doc = documentFor('<p>1 minute read</p>');
    expect(extractReadTime(doc)).toBe(1);
  });

  test('extracts it from a short combined byline line', () => {
    const doc = documentFor('<div>By Jane Doe | 2 min read</div><p>Real article body.</p>');
    expect(extractReadTime(doc)).toBe(2);
  });

  test('only looks reasonably near the top, not the whole body', () => {
    const filler = Array.from({ length: 10 }, (_, i) => `<p>Filler paragraph ${i}.</p>`).join('');
    const doc = documentFor(`${filler}<p>5 min read</p>`);
    expect(extractReadTime(doc)).toBeNull();
  });

  test('extracts and removes a longer byline combining the read time with one or more dates', () => {
    const doc = documentFor(
      '<p><span>7 min read</span><span>Manesar</span>' +
        '<span itemprop="dateModified">Dec 21, 2025 07:50 AM IST</span>' +
        '<span>First published on: Dec 20, 2025 at 02:23 PM IST</span></p>' +
        '<p>Real article body.</p>'
    );
    const minutes = extractReadTime(doc);
    expect(minutes).toBe(7);
    expect(doc.body.textContent).not.toContain('min read');
    expect(doc.body.textContent).not.toContain('Dec 21, 2025');
    expect(doc.body.textContent).not.toContain('First published on');
    expect(doc.body.textContent).toContain('Real article body.');
  });

  test('ignores a long paragraph that merely mentions reading time in passing', () => {
    const longMention =
      'The report, which takes about 5 min read on average according to some readers, goes on to describe events in detail across many more words than that.';
    const doc = documentFor(`<p>${longMention}</p>`);
    expect(extractReadTime(doc)).toBeNull();
    expect(doc.body.textContent).toContain(longMention);
  });

  test('returns null when no read-time text is present', () => {
    const doc = documentFor('<p>Just a regular article paragraph.</p>');
    expect(extractReadTime(doc)).toBeNull();
  });
});
