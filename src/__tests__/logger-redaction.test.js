// The shared logger must never write a session token to stdout: pino-http's
// default serializer logs the whole request header block, and the session
// JWT is a 30-day credential (services/auth.js's SESSION_TOKEN_TTL).
//
// pino binds its destination at construction, so the real singleton's
// output can't be captured after the fact - these tests build a logger from
// the same exported options over an in-memory stream instead, which is what
// makes the redact paths themselves the thing under test.
process.env.DB_PATH = ':memory:';

const { Writable } = require('stream');
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');
const request = require('supertest');
const { loggerOptions } = require('../logger');

const TOKEN = 'Bearer eyJhbGciOiJIUzI1NiJ9.super-secret-session-token';

function makeLogger() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk));
      done();
    },
  });
  // `silent` under NODE_ENV=test, and the dev transport would swallow the
  // stream - override both, keep everything else (the redact config).
  const logger = pino({ ...loggerOptions, level: 'info', transport: undefined }, stream);
  return { logger, output: () => chunks.join('') };
}

function appWith(logger) {
  const app = express();
  app.use(pinoHttp({ logger }));
  app.get('/me', (req, res) => res.json({ ok: true }));
  return app;
}

describe('logger redaction', () => {
  it('redacts credential-bearing headers from a direct log call', () => {
    const { logger, output } = makeLogger();

    logger.info({ req: { headers: { authorization: TOKEN, cookie: 'session=abc' } } }, 'test');

    expect(output()).not.toContain('super-secret-session-token');
    expect(output()).not.toContain('session=abc');
    expect(output()).toContain('[redacted]');
  });

  // The paths only hold if they match the shape pino-http actually emits -
  // assert against a real request rather than a hand-built object.
  it('redacts the authorization header of a real request logged by pino-http', async () => {
    const { logger, output } = makeLogger();

    await request(appWith(logger)).get('/me').set('Authorization', TOKEN).expect(200);

    expect(output()).toContain('"authorization":"[redacted]"');
    expect(output()).not.toContain('super-secret-session-token');
  });

  it('still logs the request fields an operator needs', async () => {
    const { logger, output } = makeLogger();

    await request(appWith(logger)).get('/me').set('Authorization', TOKEN).expect(200);

    expect(output()).toContain('"url":"/me"');
    expect(output()).toContain('"statusCode":200');
  });
});
