const pino = require('pino');

const isTest = process.env.NODE_ENV === 'test';
const isProd = process.env.NODE_ENV === 'production';

// pino-http's default serializer logs the whole request header block, so
// without this the 30-day session JWT (services/auth.js) lands in plaintext
// in every request line. Header names arrive lowercased from Node, hence
// `authorization`.
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

// JSON to stdout everywhere except local dev, where pino-pretty makes it
// readable. No transport under test - it spawns a worker thread that would
// outlive Jest's teardown. `silent` under test keeps the suite quiet;
// LOG_LEVEL overrides in any environment.
// Exported (not just applied) so __tests__/logger-redaction.test.js can
// build an identically-configured logger over a capturable stream - pino
// binds its stdout destination at construction, so the real singleton's
// output can't be intercepted after the fact.
const loggerOptions = {
  level: process.env.LOG_LEVEL || (isTest ? 'silent' : 'info'),
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  transport:
    !isTest && !isProd
      ? {
          target: 'pino-pretty',
          options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        }
      : undefined,
};

const logger = pino(loggerOptions);

module.exports = logger;
module.exports.loggerOptions = loggerOptions;
