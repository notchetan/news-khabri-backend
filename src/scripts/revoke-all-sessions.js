// One-shot ops script: invalidates every session token ever issued, by
// bumping every account's token_version (the same counter a fresh sign-in
// bumps - see services/auth.js). Every device is signed out and has to
// re-authenticate with Google/Apple; no user data is touched.
//
// Written for the aftermath of a credential exposure - session JWTs live
// for 30 days (SESSION_TOKEN_TTL), so one that leaked (into logs, a
// support ticket, a shared HAR file) stays usable until it expires or the
// version it was signed with stops matching.
//
//   DB_PATH=/path/to/articles.db node src/scripts/revoke-all-sessions.js --yes
//
// Deliberately requires nothing from services/auth.js: a plain UPDATE is
// the whole operation, and importing that module would demand a JWT_SECRET
// this script never uses.
const db = require('../db');
const logger = require('../logger');

const bumpAll = db.prepare('UPDATE users SET token_version = token_version + 1');

// Returns how many accounts were affected, so a caller (and the CLI below)
// can report something more useful than "done".
function revokeAllSessions() {
  return bumpAll.run().changes;
}

// Signing every user out is disruptive enough to be worth typing a flag
// for - an accidental `node src/scripts/revoke-all-sessions.js` with no
// argument does nothing. Same require.main guard the rest of the repo uses
// (see index.js) so requiring this for the test has no side effect.
if (require.main === module) {
  if (!process.argv.includes('--yes')) {
    logger.error('refusing to run without --yes: this signs every user out of every device');
    process.exitCode = 1;
  } else {
    const accounts = revokeAllSessions();
    logger.info({ accounts }, 'revoked all sessions');
  }
}

module.exports = { revokeAllSessions };
