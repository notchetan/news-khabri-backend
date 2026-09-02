const { verifySessionToken } = require('../services/auth');

// Reads `Authorization: Bearer <token>`, verifies it, and attaches
// `req.userId` - responds 401 directly (rather than calling next(err)) so
// every protected route gets the same plain error shape without each one
// re-implementing this check.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  const userId = verifySessionToken(token);
  if (!userId) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }
  req.userId = userId;
  next();
}

module.exports = requireAuth;
