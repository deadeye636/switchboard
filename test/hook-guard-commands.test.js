'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { firstProblem, READ_ONLY_REMOTES } = require('../.claude/hooks/guard-commands.js');

// The strings below are DATA. Nothing here spawns a shell — the point of the guard is that these
// commands are recognised before anything runs them.
const KILL = 'taskkill /IM ' + 'electron.exe /F';
const STOP = 'Stop-Process -Name ' + 'electron -Force';

test('a kill aimed at every electron on the machine is refused', () => {
  assert.match(firstProblem(KILL) || '', /stop:dev/);
  assert.match(firstProblem(STOP) || '', /stop:dev/);
});

test('gh against the upstream repo is refused, ordinary gh is not', () => {
  assert.match(firstProblem('gh issue list -R doctly/switchboard') || '', /fork/);
  assert.equal(firstProblem('gh issue view 211'), null);
  assert.equal(firstProblem('gh pr create --fill'), null);
});

test('a push to a read-only remote is refused, origin is not', () => {
  for (const remote of READ_ONLY_REMOTES) {
    assert.ok(firstProblem(`git push ${remote} main`), `${remote} should be refused`);
  }
  assert.equal(firstProblem('git push origin main'), null);
  assert.equal(firstProblem('git push --force-with-lease origin main'), null);
});

// Reading from the forks is the documented workflow (docs/ai/fork-and-porting.md,
// `npm run upstream:check`). A guard that blocked it would be refusing the thing it exists to serve.
test('reading from the forks stays allowed', () => {
  assert.equal(firstProblem('git fetch upstream'), null);
  assert.equal(firstProblem('npm run upstream:check'), null);
  assert.equal(firstProblem('git log upstream/main --oneline'), null);
  assert.equal(firstProblem('git remote -v'), null);
});

test('everyday commands are untouched', () => {
  for (const cmd of ['npm test', 'npm run stop:dev', 'node scripts/check-doc-refs.js', 'git status']) {
    assert.equal(firstProblem(cmd), null, cmd);
  }
});
