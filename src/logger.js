const pino = require('pino');

const isTest = process.env.NODE_ENV === 'test';
const isProd = process.env.NODE_ENV === 'production';

// JSON to stdout everywhere except local dev, where pino-pretty makes it
// readable. No transport under test - it spawns a worker thread that would
// outlive Jest's teardown. `silent` under test keeps the suite quiet;
// LOG_LEVEL overrides in any environment.
const logger = pino({
  level: process.env.LOG_LEVEL || (isTest ? 'silent' : 'info'),
  transport:
    !isTest && !isProd
      ? {
          target: 'pino-pretty',
          options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        }
      : undefined,
});

module.exports = logger;
