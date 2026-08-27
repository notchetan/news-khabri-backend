module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/src/__tests__/**/*.test.js'],
  collectCoverageFrom: ['src/**/*.js', '!src/__tests__/**'],
  coverageDirectory: 'coverage',
  // jsdom pulls in several ESM-only transitive deps (.js files using
  // `export`, and .mjs files) that Jest's default node_modules exclusion
  // and default transform-by-extension would otherwise leave unhandled.
  // Transforming all of node_modules - including .mjs - through babel-jest
  // is the robust fix rather than chasing each offending package by name.
  transformIgnorePatterns: [],
  moduleFileExtensions: ['js', 'mjs', 'cjs', 'json', 'node'],
  transform: {
    '\\.m?js$': 'babel-jest',
  },
};
