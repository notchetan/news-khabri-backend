const { extractEntities } = require('../services/entity-extraction');

describe('extractEntities', () => {
  test('extracts a multi-word capitalized run as one entity', () => {
    expect(extractEntities('Manchester United signs a new striker')).toContain('manchester united');
  });

  test('extracts a mid-sentence single capitalized word as an entity', () => {
    expect(extractEntities('The match ended with Ronaldo scoring twice')).toContain('ronaldo');
  });

  test('excludes a sentence-initial common word from being misread as an entity', () => {
    const entities = extractEntities('New economic policy announced by India');
    expect(entities).not.toContain('new');
    expect(entities).toContain('india');
  });

  test('excludes sentence-initial generic nouns like Government/Minister/President', () => {
    expect(extractEntities('Government unveils new economic measures')).not.toContain('government');
    expect(extractEntities('President addresses the nation')).not.toContain('president');
  });

  test('still keeps a sentence-initial word when it is a genuine proper noun', () => {
    expect(extractEntities('India announces new economic policy')).toContain('india');
  });

  test('dedupes repeated entities', () => {
    const entities = extractEntities('Apple unveils new iPhone. Apple shares rose after the Apple event.');
    expect(entities.filter((e) => e === 'apple')).toHaveLength(1);
  });

  test('caps a long Title Case run rather than swallowing the whole headline', () => {
    const entities = extractEntities('The Very Long Title Case Headline About Something Important Today');
    expect(entities.every((e) => e.split(' ').length <= 4)).toBe(true);
  });

  test('returns an empty array for text with no capitalized words', () => {
    expect(extractEntities('the match ended in a draw')).toEqual([]);
  });

  test('returns an empty array for empty/null/undefined text without throwing', () => {
    expect(extractEntities('')).toEqual([]);
    expect(extractEntities(null)).toEqual([]);
    expect(extractEntities(undefined)).toEqual([]);
  });

  test('handles a very short headline without throwing', () => {
    expect(() => extractEntities('Modi')).not.toThrow();
    expect(extractEntities('Modi wins')).toContain('modi');
  });

  test('excludes a day-of-week regardless of position in the sentence', () => {
    // Found via real clustering data: "on Wednesday" mid-sentence was being
    // extracted as the entity "wednesday", which then counted as real
    // corroborating evidence between two otherwise-unrelated articles.
    const entities = extractEntities(
      'India dispatched 37.5 tonnes of aid after an initial consignment on Wednesday.'
    );
    expect(entities).not.toContain('wednesday');
    expect(entities).toContain('india');
  });

  test('excludes further sentence-initial common words found in real headlines', () => {
    expect(extractEntities('Here are helpline numbers for stranded residents')).not.toContain('here');
    expect(extractEntities('Regional collaboration is crucial for recovery')).not.toContain('regional');
    expect(extractEntities('Reconstruction efforts will require support')).not.toContain('reconstruction');
  });
});
