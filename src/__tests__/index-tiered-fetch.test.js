// Focused on the tier-splitting behavior added to index.js's cron wiring -
// kept separate from the main index.test.js (routes/supertest) so mocking
// fetcher/clusterer here doesn't risk affecting that file's coverage.
process.env.DB_PATH = ':memory:';

const mockFetchAllFeeds = jest.fn().mockResolvedValue(undefined);
jest.mock('../ingestion/fetcher', () => mockFetchAllFeeds);

const mockClusterNewArticles = jest.fn().mockResolvedValue(0);
jest.mock('../ingestion/clusterer', () => ({
  clusterNewArticles: mockClusterNewArticles,
}));

const db = require('../db');
const { setSources } = require('../ingestion/source-registry');
const { DEFAULT_TIER } = require('../services/tier-config');
const { sourceNamesForTier, fetchTier } = require('../index');

beforeEach(() => {
  db.exec('DELETE FROM source_tiers');
  jest.clearAllMocks();
});

describe('sourceNamesForTier', () => {
  test('groups registered sources by their computed tier', () => {
    setSources([
      { name: 'Indian Express', url: 'https://a.example.com', category: 'world', language: 'en' },
      { name: 'Mathrubhumi', url: 'https://b.example.com', category: 'world', language: 'ml' },
    ]);
    db.prepare(
      `INSERT INTO source_tiers (source, tier, articles_per_hour, sample_count) VALUES (?, ?, ?, ?)`
    ).run('Indian Express', 'fast', 20, 100);
    db.prepare(
      `INSERT INTO source_tiers (source, tier, articles_per_hour, sample_count) VALUES (?, ?, ?, ?)`
    ).run('Mathrubhumi', 'slow', 0.2, 30);

    expect(sourceNamesForTier('fast')).toEqual(new Set(['Indian Express']));
    expect(sourceNamesForTier('slow')).toEqual(new Set(['Mathrubhumi']));
    expect(sourceNamesForTier('medium')).toEqual(new Set());
  });

  test('falls back to DEFAULT_TIER for a source with no tier computed yet', () => {
    setSources([
      { name: 'Brand New Source', url: 'https://c.example.com', category: 'world', language: 'bn' },
    ]);

    expect(sourceNamesForTier(DEFAULT_TIER)).toEqual(new Set(['Brand New Source']));
  });
});

describe('fetchTier', () => {
  test('fetches only that tier\'s sources and runs clustering afterward', async () => {
    setSources([
      { name: 'Indian Express', url: 'https://a.example.com', category: 'world', language: 'en' },
      { name: 'Mathrubhumi', url: 'https://b.example.com', category: 'world', language: 'ml' },
    ]);
    db.prepare(
      `INSERT INTO source_tiers (source, tier, articles_per_hour, sample_count) VALUES (?, ?, ?, ?)`
    ).run('Indian Express', 'fast', 20, 100);
    db.prepare(
      `INSERT INTO source_tiers (source, tier, articles_per_hour, sample_count) VALUES (?, ?, ?, ?)`
    ).run('Mathrubhumi', 'slow', 0.2, 30);

    await fetchTier('fast');

    expect(mockFetchAllFeeds).toHaveBeenCalledTimes(1);
    expect(mockFetchAllFeeds).toHaveBeenCalledWith(new Set(['Indian Express']));
    expect(mockClusterNewArticles).toHaveBeenCalledTimes(1);
  });

  test('does nothing when no registered source currently belongs to that tier', async () => {
    setSources([{ name: 'Indian Express', url: 'https://a.example.com', category: 'world', language: 'en' }]);
    db.prepare(
      `INSERT INTO source_tiers (source, tier, articles_per_hour, sample_count) VALUES (?, ?, ?, ?)`
    ).run('Indian Express', 'fast', 20, 100);

    await fetchTier('slow');

    expect(mockFetchAllFeeds).not.toHaveBeenCalled();
    expect(mockClusterNewArticles).not.toHaveBeenCalled();
  });
});
