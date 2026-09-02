process.env.DB_PATH = ':memory:';

const { buildFtsQuery } = require('../db/fts');

describe('buildFtsQuery', () => {
  test('turns a single word into a quoted prefix match', () => {
    expect(buildFtsQuery('market')).toBe('"market"*');
  });

  test('ANDs multiple words together, each as its own prefix match', () => {
    expect(buildFtsQuery('election government')).toBe('"election"* AND "government"*');
  });

  test('collapses extra whitespace between words', () => {
    expect(buildFtsQuery('  election    government  ')).toBe('"election"* AND "government"*');
  });

  test('strips FTS5 query-syntax characters out of each word rather than passing them through', () => {
    // None of these should be interpretable as FTS5 operators/syntax once
    // stripped - e.g. a bareword "AND" is a real FTS5 operator, but wrapped
    // in quotes as a phrase-prefix it has no special meaning.
    expect(buildFtsQuery('rbi"s')).toBe('"rbis"*');
    expect(buildFtsQuery('a*b')).toBe('"ab"*');
    expect(buildFtsQuery('NEAR(x,y)')).toBe('"NEARx,y"*');
  });

  test('returns null for a search of only punctuation - nothing usable is left', () => {
    expect(buildFtsQuery('***')).toBeNull();
    expect(buildFtsQuery('()')).toBeNull();
    expect(buildFtsQuery('   ')).toBeNull();
  });

  test('returns null for an empty string', () => {
    expect(buildFtsQuery('')).toBeNull();
  });
});
