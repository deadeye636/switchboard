'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const { collect } = require('../scripts/check-doc-refs.js');

// The rules and specs are read as instructions. A path in one that no longer exists sends the next
// reader — human or agent — to a file that is not there, and nothing else in the suite can see it.
test('every repo path named in the rules and docs still exists', () => {
  const { misses } = collect();
  const detail = misses.map((m) => `${m.file}:${m.line}  ${m.token}`).join('\n');
  assert.equal(misses.length, 0,
    `documented path(s) that no longer exist:\n${detail}\n\n` +
    'Fix the doc, or — if the path is named on purpose (a removal record, a plan option not taken) — ' +
    'add it to DELIBERATE in scripts/check-doc-refs.js WITH the reason.');
});

// An exemption that is no longer needed would silence a real finding the next time that path goes.
test('no exemption in check-doc-refs outlives the path it covers', () => {
  const { staleExemptions } = collect();
  const detail = staleExemptions.map((s) => `${s.file}: ${s.token}`).join('\n');
  assert.equal(staleExemptions.length, 0,
    `exemption(s) whose path exists again — remove them:\n${detail}`);
});

// The guard is only worth what it reads. If it scans nothing, both tests above pass vacuously —
// which is the failure shape docs/ai/lessons.md calls "a guard that lists its targets".
test('the guard actually reads the rules and the specs', () => {
  const { scanned } = collect();
  assert.ok(scanned > 20, `expected the scan to cover the docs tree, saw ${scanned} files`);

  const root = path.resolve(__dirname, '..');
  const rules = fs.readdirSync(path.join(root, '.claude/rules')).filter((f) => f.endsWith('.md'));
  assert.ok(rules.length > 0, '.claude/rules holds no markdown — the scan target moved');
});
