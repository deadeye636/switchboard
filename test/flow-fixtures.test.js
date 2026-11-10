'use strict';
// The session-flow fixtures (#826) are hand-built. This pins that they stay parseable and stay free of
// anything that could name a real machine, user or path. The machine terms are computed at run time, the
// same way test/no-local-paths.test.js does, so this file never spells them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeOversizedLine } = require('./helpers/flow-fixture-gen');

const DIR = path.join(__dirname, 'fixtures', 'flow');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}
const files = walk(DIR);
const rel = (f) => path.relative(DIR, f).split(path.sep).join('/');

// A letter, a colon, then a separator and a path character. A single backslash before a letter is a JSON
// escape (`"note:\nnext"`), so a backslash counts only when doubled (escaped in JSON) or when a forward
// slash is used. `https://` is not a drive: the letter run before the colon must be one letter.
const DRIVE_AND_UNC = [
  ['a drive-letter path', /(?<![A-Za-z0-9])[A-Za-z]:(?:\\\\|\\(?![nrtbfu"\\/])|\/)[\w$.~-]/],
  ['a UNC path', /(?:^|[^:\w])(?:\\{2,4}|\/\/)[\w$.-]+[\\/]+[\w$.-]+/m],
];

test('the drive and UNC patterns catch real shapes and skip JSON escapes', () => {
  const drive = DRIVE_AND_UNC[0][1];
  const unc = DRIVE_AND_UNC[1][1];
  for (const s of ['E:/x', 'E:\\\\x\\\\y', 'C:\\Users', '"p":"d:/proj"']) assert.ok(drive.test(s), s);
  for (const s of ['"note:\\nnext"', 'see https://example.org', 'a:\\ttab', 'ratio a:b']) assert.ok(!drive.test(s), s);
  for (const s of ['//host/share', '\\\\\\\\host\\\\share']) assert.ok(unc.test(s), s);
  assert.ok(!unc.test('https://example.org/x'));
});

test('the fixture folder holds the expected families', () => {
  const names = files.map(rel);
  for (const want of ['claude-main.jsonl', 'claude-parent.jsonl', 'claude-parent/subagents/agent-a1b2c3.jsonl',
    'claude-parent/subagents/agent-a1b2c3.meta.json', 'codex-rollout.jsonl', 'codex-parent.jsonl',
    'codex-child.jsonl', 'codex-guardian.jsonl', 'pi-session.jsonl', 'README.md']) {
    assert.ok(names.includes(want), `missing fixture ${want}`);
  }
});

test('every JSONL line and meta file parses as JSON', () => {
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    if (f.endsWith('.jsonl')) {
      text.split('\n').filter(Boolean).forEach((line, i) => {
        assert.doesNotThrow(() => JSON.parse(line), `${rel(f)}:${i + 1} is not JSON`);
      });
    } else if (f.endsWith('.json')) {
      assert.doesNotThrow(() => JSON.parse(text), `${rel(f)} is not JSON`);
    }
  }
});

test('the parent names its subagent by agentId, and the child file exists', () => {
  const parent = fs.readFileSync(path.join(DIR, 'claude-parent.jsonl'), 'utf8');
  assert.match(parent, /"agentId":"a1b2c3"/);
  assert.ok(fs.existsSync(path.join(DIR, 'claude-parent', 'subagents', 'agent-a1b2c3.jsonl')));
});

test('no fixture carries a local identifier', () => {
  const user = (os.userInfo().username || '').trim();
  const home = os.homedir() || '';
  const checks = [
    ...DRIVE_AND_UNC,
    ['an e-mail shape', /[\w.+-]+@[\w-]+\.[\w.-]+/],
    ['an absolute POSIX home', /\/(?:home|Users)\//i],
  ];
  if (home.length >= 4) checks.push(['this machine\'s home', { test: (s) => s.toLowerCase().includes(home.toLowerCase()) }]);
  if (user.length >= 4) {
    const esc = user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    checks.push(['this machine\'s account name', new RegExp(`(?:[\\\\/]${esc}(?=[\\\\/'"\`\\s,;:)\\]}.!?<>|]|$)|\\b${esc}@)`, 'i')]);
  }
  const hits = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const [why, re] of checks) if (re.test(text)) hits.push(`${rel(f)} carries ${why}`);
  }
  assert.deepEqual(hits, [], 'fixtures must be invented; use placeholders such as <project> and ~');
});

test('the oversized-line generator writes the size asked for and cleans up', () => {
  const g = writeOversizedLine(300000);
  try {
    const lines = fs.readFileSync(g.path, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 3);
    assert.ok(Math.abs(Buffer.byteLength(lines[1]) - 300000) <= 2);
    assert.doesNotThrow(() => JSON.parse(lines[1]));
  } finally {
    g.cleanup();
  }
  assert.equal(fs.existsSync(g.path), false);
});
