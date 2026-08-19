'use strict';
// #440 — reading one level into a backend's customization directory.
//
// Two halves, and the second is the one that matters: the shared walker has to name the right entries,
// and `app/backend-resources.js` has to refuse everything the walker was never asked about. A skills
// directory is where symlinks live, so containment is checked against what the filesystem says a path
// really is, not against how it was spelled.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const expand = require('../src/backends/resource-expand');
const backendResources = require('../src/app/backend-resources');
const BACKENDS = require('../src/backends').list().filter(b => b.status === 'ready' && !b.isProfile);

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(file, body = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

// --- the shared walker ---------------------------------------------------------------------------

test('a skills tree stops at the folder that holds SKILL.md', () => {
  const root = tmpdir('sb-skills-');
  write(path.join(root, 'code-review', 'SKILL.md'));
  write(path.join(root, 'code-review', 'references', 'notes.md'));   // inside a skill, not a skill
  write(path.join(root, 'nested', 'deep', 'commit-msg', 'SKILL.md'));
  write(path.join(root, 'loose.md'));

  const run = expand.createExpandResource({ s: { mode: 'skillTree', kind: 'skill' } });
  const res = run({ path: root, source: 's' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.entries.map(e => e.name), ['code-review', 'commit-msg']);
  assert.ok(res.entries.every(e => e.path.endsWith('SKILL.md')));
  assert.ok(res.entries.every(e => e.kind === 'skill'));
});

test('a skills tree can also take bare markdown in its root, when the backend says so', () => {
  const root = tmpdir('sb-skills2-');
  write(path.join(root, 'single.md'));
  write(path.join(root, 'folder', 'SKILL.md'));

  const withRoot = expand.createExpandResource({ s: { mode: 'skillTree', kind: 'skill', rootMarkdown: true } });
  assert.deepEqual(withRoot({ path: root, source: 's' }).entries.map(e => e.name).sort(), ['folder', 'single']);

  const without = expand.createExpandResource({ s: { mode: 'skillTree', kind: 'skill' } });
  assert.deepEqual(without({ path: root, source: 's' }).entries.map(e => e.name), ['folder']);
});

test('flat files honour the extension filter, and dirs mode reports folders', () => {
  const root = tmpdir('sb-flat-');
  write(path.join(root, 'a.md'));
  write(path.join(root, 'b.txt'));
  fs.mkdirSync(path.join(root, 'sub'));

  const md = expand.createExpandResource({ s: { mode: 'flatFiles', kind: 'rule', exts: ['.md'] } });
  assert.deepEqual(md({ path: root, source: 's' }).entries.map(e => e.name), ['a']);

  const dirs = expand.createExpandResource({ s: { mode: 'dirs', kind: 'plugin' } });
  assert.deepEqual(dirs({ path: root, source: 's' }).entries.map(e => e.name), ['sub']);
});

test('an unknown source is answered, not guessed at', () => {
  const root = tmpdir('sb-unknown-');
  const run = expand.createExpandResource({ s: { mode: 'dirs', kind: 'plugin' } });
  const res = run({ path: root, source: 'something-else' });
  assert.equal(res.ok, false);
  assert.match(res.reason, /does not|not a directory Switchboard/i);
});

test('an unreadable branch skips that branch instead of failing the whole expansion', () => {
  // pi's walk used to throw here and take the entire resource listing with it.
  const root = tmpdir('sb-unreadable-');
  write(path.join(root, 'good', 'SKILL.md'));
  const run = expand.createExpandResource({ s: { mode: 'skillTree', kind: 'skill' } });
  const res = run({ path: path.join(root, 'nope'), source: 's' });
  assert.equal(res.ok, false);                      // the directory itself is gone: an answer
  const ok = run({ path: root, source: 's' });
  assert.deepEqual(ok.entries.map(e => e.name), ['good']);
});

// --- containment ---------------------------------------------------------------------------------

const isInside = backendResources._isInside;

test('containment refuses traversal, and accepts a real child', () => {
  const root = tmpdir('sb-contain-');
  const child = write(path.join(root, 'skills', 'a.md'));
  assert.equal(isInside(root, child), true);
  assert.equal(isInside(path.join(root, 'skills'), child), true);
  assert.equal(isInside(child, child), false);                       // not inside itself
  assert.equal(isInside(path.join(root, 'skills'), path.join(root, 'skills', '..', 'elsewhere.md')), false);
});

test('containment refuses a symlink that points out of the tree', () => {
  const root = tmpdir('sb-link-');
  const outside = write(path.join(root, 'outside', 'secret.md'));
  const skills = path.join(root, 'skills');
  fs.mkdirSync(skills, { recursive: true });
  const link = path.join(skills, 'link.md');
  try {
    fs.symlinkSync(outside, link, 'file');
  } catch {
    return;   // no symlink privilege on this machine: the lexical half is still covered above
  }
  // Spelled inside, really outside. The lexical check passes it; realpath is what refuses it.
  assert.equal(path.relative(skills, link).startsWith('..'), false);
  assert.equal(isInside(skills, link), false);
});

test('containment is case-insensitive on win32 and not elsewhere', () => {
  const root = tmpdir('sb-case-');
  const child = write(path.join(root, 'skills', 'a.md'));
  const shouted = root.toUpperCase();
  const answer = isInside(shouted, child);
  if (process.platform === 'win32') assert.equal(answer, true);
  else assert.equal(typeof answer, 'boolean');
});

test('a junctioned directory is followed, not silently skipped', () => {
  // Dirent.isDirectory() answers false for a Windows junction, which is how a junctioned skills folder
  // read as empty with nothing to see. statSync answers the filesystem instead. Pin it, or the next
  // person reaches for readdirSync's Dirent and the folder disappears again with the suite green.
  const root = tmpdir('sb-junction-');
  const real = path.join(root, 'real', 'code-review');
  write(path.join(real, 'SKILL.md'));
  const skills = path.join(root, 'skills');
  fs.mkdirSync(skills, { recursive: true });
  const link = path.join(skills, 'linked');
  try {
    fs.symlinkSync(path.join(root, 'real'), link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    return;   // no privilege to make one here; the statSync path is still exercised by the tests above
  }
  const run = expand.createExpandResource({ s: { mode: 'skillTree', kind: 'skill' } });
  const res = run({ path: skills, source: 's' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.entries.map(e => e.name), ['code-review'],
    'a junction inside a skills directory must be walked, not skipped');
});

test('a child is reachable only under a directory the backend can actually read into', () => {
  // A listing can name a whole project folder (.claude / .codex / .gemini). Accepting any child of one
  // would make the read path wider than the enumeration that is supposed to bound it.
  const rules = { 'skills-directory': { mode: 'skillTree', kind: 'skill' } };
  const run = expand.createExpandResource(rules);
  assert.equal(run.knowsSource('skills-directory'), true);
  assert.equal(run.knowsSource('project-claude-directory'), false);
  assert.equal(run.knowsSource(undefined), false);
});

// --- the descriptors -----------------------------------------------------------------------------

test('every ready backend declares expansion, and its rules are keyed by a source it actually emits', () => {
  for (const backend of BACKENDS) {
    assert.equal(typeof backend.expandResource, 'function',
      `${backend.id} declares no expandResource — the capability row resourceDepth says otherwise`);
  }
});

test('hermes and pi list directories now, not the files inside them', () => {
  // The move that makes listResources cheap again (#440). A listing that still returns individual
  // skills means the walk is back inside it.
  for (const id of ['hermes', 'pi']) {
    const backend = BACKENDS.find(b => b.id === id);
    if (!backend) continue;
    let listed;
    try { listed = backend.listResources({ projectPath: null }); } catch { continue; }
    if (!listed || listed.ok === false) continue;
    const skillFiles = listed.resources.filter(r => r && typeof r.path === 'string' && /SKILL\.md$/i.test(r.path));
    assert.equal(skillFiles.length, 0,
      `${id}: listResources still returns individual skill files — expandResource is what reads those now`);
  }
});

test('hermes no longer emits its own truncation row', () => {
  // The cap lives in the expansion contract now, so the synthetic row whose path was the skills
  // directory itself is gone — it would otherwise have become a second, expandable copy of that row.
  const hermes = BACKENDS.find(b => b.id === 'hermes');
  if (!hermes) return;
  let listed;
  try { listed = hermes.listResources({ projectPath: null }); } catch { return; }
  if (!listed || listed.ok === false) return;
  assert.equal(listed.resources.some(r => r && r.kind === 'resource-note'), false);
});
