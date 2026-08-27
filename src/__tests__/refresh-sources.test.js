process.env.DB_PATH = ':memory:';

jest.mock('../ingestion/discovery');
jest.mock('../ingestion/fetcher');

const { discoverAllSources } = require('../ingestion/discovery');
const fetchAllFeeds = require('../ingestion/fetcher');
const { getSources } = require('../ingestion/source-registry');
const app = require('../index');

describe('refreshSourcesAndFetch', () => {
  test('registers discovered sources and then fetches them', async () => {
    const discovered = [
      { name: 'A', category: 'national', url: 'https://a.example.com', language: 'en' },
      { name: 'A', category: 'business', url: 'https://a.example.com/business', language: 'en' },
      { name: 'B', category: 'national', url: 'https://b.example.com', language: 'en' },
    ];
    discoverAllSources.mockResolvedValue(discovered);
    fetchAllFeeds.mockResolvedValue(undefined);

    await app.refreshSourcesAndFetch();

    expect(getSources()).toBe(discovered);
    expect(fetchAllFeeds).toHaveBeenCalledTimes(1);
  });
});
