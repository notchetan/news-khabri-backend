// Runs zod schemas against parts of the request before the handler. On
// failure every route gets the same compact 400 shape instead of each one
// re-implementing its own ad-hoc checks. `body` is replaced with the
// parsed (coerced) value; `params` is only checked, not reassigned, so
// the handlers keep their own `Number(...)`.
function validate({ body, params } = {}) {
  return (req, res, next) => {
    if (params) {
      const result = params.safeParse(req.params);
      if (!result.success) return respond(res, result.error);
    }
    if (body) {
      const result = body.safeParse(req.body);
      if (!result.success) return respond(res, result.error);
      req.body = result.data;
    }
    next();
  };
}

function respond(res, error) {
  res.status(400).json({
    error: 'Invalid request',
    details: error.issues.map((i) => ({
      path: i.path.join('.') || '(root)',
      message: i.message,
    })),
  });
}

module.exports = validate;
