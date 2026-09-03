const { z } = require('zod');
const validate = require('../middleware/validate');

function run(mw, req) {
  const res = {
    statusCode: 200,
    body: undefined,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
  let nextCalled = false;
  mw(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

describe('validate middleware', () => {
  test('calls next and replaces req.body with the parsed value on success', () => {
    const req = { body: { articleId: '42', extra: 'dropped' } };
    const { nextCalled } = run(
      validate({ body: z.object({ articleId: z.coerce.number().int() }) }),
      req
    );
    expect(nextCalled).toBe(true);
    expect(req.body).toEqual({ articleId: 42 });
  });

  test('400 with a compact details list on a bad body, without calling next', () => {
    const { res, nextCalled } = run(
      validate({ body: z.object({ idToken: z.string().min(1) }) }),
      { body: {} }
    );
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Invalid request');
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details[0].path).toBe('idToken');
  });

  test('checks params without reassigning them', () => {
    const req = { params: { id: '7' } };
    const { nextCalled } = run(
      validate({ params: z.object({ id: z.string().regex(/^\d+$/) }) }),
      req
    );
    expect(nextCalled).toBe(true);
    expect(req.params).toEqual({ id: '7' });

    const bad = run(
      validate({ params: z.object({ id: z.string().regex(/^\d+$/) }) }),
      { params: { id: 'abc' } }
    );
    expect(bad.res.statusCode).toBe(400);
    expect(bad.nextCalled).toBe(false);
  });
});
