// Stamp build-info.json with the git commit a build was made from, so the About
// pane can show which commit an installation originates from. Run before every
// build (and on `npm start`) — see the build scripts in package.json and the CI
// "Stamp build info" step. The file is gitignored: its content changes every
// commit, so committing it would create churn and go stale. Best-effort — falls
// back to "unknown" when git is unavailable (e.g. a source tarball).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', cwd: path.join(__dirname, '..') }).trim();
  } catch {
    return '';
  }
}

// In CI the checkout is a detached HEAD, so `rev-parse --abbrev-ref HEAD` yields
// "HEAD"; prefer the ref name GitHub Actions provides.
const branch = process.env.GITHUB_REF_NAME || git(['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown';
const commit = git(['rev-parse', '--short', 'HEAD']) || 'unknown';
const dirty = git(['status', '--porcelain']).length > 0;
const info = { branch, commit, dirty, builtAt: new Date().toISOString() };

fs.writeFileSync(
  path.join(__dirname, '..', 'build-info.json'),
  JSON.stringify(info, null, 2) + '\n'
);
console.log(`build-info: ${branch} @ ${commit}${dirty ? ' (dirty)' : ''}`);
