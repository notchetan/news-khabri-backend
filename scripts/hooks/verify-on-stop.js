/* eslint-disable no-console */
// Stop hook: runs the backend suite when something under src/ has changed.
// Gated on a real diff so a question-answering turn doesn't trigger a run.
//
// Reports through systemMessage rather than blocking - a Stop hook that
// refuses to stop can loop.

const { execSync, spawnSync } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..", "..");

try {
  execSync("git diff --quiet HEAD -- src/", { cwd: root, stdio: "pipe" });
  process.exit(0);
} catch {
  // changes present - verify
}

// jest writes its summary to stderr, so read both streams.
const res = spawnSync("npx jest --ci --silent", {
  cwd: root,
  encoding: "utf8",
  shell: true,
});
const out = (res.stdout || "") + (res.stderr || "");
const summary = (
  out.match(/Tests:.*/) || [res.status === 0 ? "tests passed" : "jest failed"]
)[0].trim();

console.log(
  JSON.stringify({
    systemMessage:
      res.status === 0 ? `Backend OK - ${summary}` : `Backend tests FAILED - ${summary}`,
    suppressOutput: true,
  })
);
