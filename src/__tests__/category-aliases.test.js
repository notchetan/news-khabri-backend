const { normalizeCategory, HIDDEN_CATEGORIES } = require('../services/category-aliases');

describe('normalizeCategory', () => {
  test('maps known aliases to their canonical spelling', () => {
    expect(normalizeCategory('Sport')).toBe('sports');
    expect(normalizeCategory('Technology')).toBe('tech');
    expect(normalizeCategory('Life & Style')).toBe('lifestyle');
  });

  test('folds narrow finance sub-sections into business', () => {
    expect(normalizeCategory('NRI')).toBe('business');
    expect(normalizeCategory('Markets')).toBe('business');
    expect(normalizeCategory('Market Data')).toBe('business');
    expect(normalizeCategory('SME')).toBe('business');
    expect(normalizeCategory('MF')).toBe('business');
  });

  test('lowercases and trims regardless of alias match', () => {
    expect(normalizeCategory('  Weather  ')).toBe('lifestyle');
    expect(normalizeCategory('BUSINESS')).toBe('business');
  });

  test('passes through unknown categories unchanged (besides case/trim)', () => {
    expect(normalizeCategory('Somebrandnewcategory')).toBe('somebrandnewcategory');
    expect(normalizeCategory('बिजनेस')).toBe('बिजनेस');
  });

  test('alias matching is case-insensitive', () => {
    expect(normalizeCategory('SPORT')).toBe('sports');
    expect(normalizeCategory('sport')).toBe('sports');
  });

  test('consolidates the long tail of niche English sections into ~9 recognizable categories', () => {
    // -> india
    ['National', 'Politics', 'Governance', 'Political Pulse', 'Cities', 'North East India', 'News', 'Explained'].forEach(
      (raw) => expect(normalizeCategory(raw)).toBe('india')
    );
    // -> world
    ['US', 'Pakistan'].forEach((raw) => expect(normalizeCategory(raw)).toBe('world'));
    // -> business
    ['Industry', 'Wealth', 'Personal Finance', 'ETPrime', 'Top Trending Products', 'Insurance'].forEach(
      (raw) => expect(normalizeCategory(raw)).toBe('business')
    );
    // -> entertainment
    ['Magazines', 'Podcasts'].forEach((raw) => expect(normalizeCategory(raw)).toBe('entertainment'));
    // -> tech
    ['AI', 'Auto', 'Auto Travel'].forEach((raw) => expect(normalizeCategory(raw)).toBe('tech'));
    // -> lifestyle
    ['Astrology', 'Health Wellness', 'Weather'].forEach((raw) => expect(normalizeCategory(raw)).toBe('lifestyle'));
    // -> education
    ['Careers', 'Jobs'].forEach((raw) => expect(normalizeCategory(raw)).toBe('education'));
    // -> science
    expect(normalizeCategory('Environment')).toBe('science');
  });

  test('consolidates Hindi\'s redundant general-news feeds into a single देश category', () => {
    expect(normalizeCategory('ताज़ा ख़बरें')).toBe('देश');
    expect(normalizeCategory('होम')).toBe('देश');
  });

  test('keeps cricket split from general sports (deliberately not folded)', () => {
    expect(normalizeCategory('Cricket')).toBe('cricket');
    expect(normalizeCategory('Sports')).toBe('sports');
  });

  test('folds legacy/no-longer-fetched section names into a real topic bucket', () => {
    // Historical rows only - these sections are all in
    // ingestion/discovery.js's INDIAN_EXPRESS_EXCLUDED_SLUGS, so no live
    // feed produces them anymore, but old rows still needed a home.
    expect(normalizeCategory('Books And Literature')).toBe('lifestyle');
    expect(normalizeCategory('Delhi Confidential')).toBe('india');
    expect(normalizeCategory('Entertainment Video')).toBe('entertainment');
    expect(normalizeCategory('Fifa')).toBe('sports');
    expect(normalizeCategory('Good News')).toBe('lifestyle');
    expect(normalizeCategory('Horoscope')).toBe('lifestyle');
    expect(normalizeCategory('Live News')).toBe('india');
    expect(normalizeCategory('News Briefs')).toBe('india');
    expect(normalizeCategory('News Today')).toBe('india');
    expect(normalizeCategory('Smart Stocks')).toBe('business');
    expect(normalizeCategory('UPSC Current Affairs')).toBe('education');
  });

  test('folds legacy feature/magazine/reference section names into the already-hidden opinion bucket', () => {
    [
      'Evergreen', 'Express Exclusive', 'Express Sunday Eye', 'Fine Reading',
      'How To', 'Idea Exchange', 'Long Reads', 'Puzzles And Games', 'Research',
      'Trending', 'What Is', 'When Is', 'Who Is',
    ].forEach((raw) => expect(normalizeCategory(raw)).toBe('opinion'));
  });
});

describe('HIDDEN_CATEGORIES', () => {
  test('flags opinion as hidden', () => {
    expect(HIDDEN_CATEGORIES.has('opinion')).toBe(true);
  });

  test('flags top stories as hidden (a publisher front-page feed, not a real topic)', () => {
    expect(HIDDEN_CATEGORIES.has('top stories')).toBe(true);
  });

  test('does not flag ordinary categories as hidden', () => {
    expect(HIDDEN_CATEGORIES.has('business')).toBe(false);
    expect(HIDDEN_CATEGORIES.has('sports')).toBe(false);
  });
});
