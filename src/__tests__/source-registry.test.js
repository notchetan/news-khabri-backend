const { setSources, getSources } = require('../ingestion/source-registry');

describe('source-registry', () => {
  test('getSources returns an empty array before anything is set', () => {
    expect(getSources()).toEqual([]);
  });

  test('setSources replaces what getSources returns', () => {
    const sources = [{ name: 'Test', category: 'national', url: 'https://example.com', language: 'en' }];
    setSources(sources);
    expect(getSources()).toBe(sources);
  });

  test('setSources overwrites a previous set (not merges)', () => {
    setSources([{ name: 'A' }]);
    setSources([{ name: 'B' }]);
    expect(getSources()).toEqual([{ name: 'B' }]);
  });
});
