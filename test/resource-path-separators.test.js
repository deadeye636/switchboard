'use strict';
// #534 — the Windows path-separator bug Antigravity fixed on its own side, asked of our resource listing.
//
// Antigravity CLI 1.1.25 fixed skill path matching and grouping where a host path separator (`\`) sorted
// global and workspace skills into the wrong group. We group the same kind of directories, on the same
// platform. The issue asks for the answer to be a TEST rather than a reading of the code, including when
// the answer is "the bug is not here" — a reading is what let the same defect sit in a sibling backend
// four times over.
//
// **The answer is that the bug is not here, and this is why:**
//
//   1. **A group is DECLARED, not derived from the path it ends up on.** Every backend hands its listing
//      entries a literal `scope: 'global' | 'project'` (`src/backends/*/resources.js`), and both groupers
//      — `src/app/skills.js` and `src/app/plans-memory.js` — read that field. Antigravity's bug was a
//      compare between a path and a home directory deciding the group; there is no such compare on this
//      path. (There is exactly ONE path-string compare that reaches a scope at all: `samePath` in
//      `src/backends/claude/plugins.js`, which decides whether a locally installed plugin belongs to this
//      project. It is separator-safe because `path.resolve` normalises, and it is pinned by
//      `test/claude-plugin-skills.test.js` — but it is not realpath-aware, so do not read the sentence
//      above as "no path compare exists anywhere".)
//   2. **Every listed path goes through `path.join`,** which normalises separators to the platform's own.
//      A project handed in with forward slashes yields backslash entries, so nothing downstream ever sees
//      the caller's spelling.
//   3. **Containment goes through `src/app/path-containment.js`,** which resolves both sides through the
//      filesystem before comparing and ignores case on Windows. Note this is the SECOND half: the lexical
//      pre-check in `src/app/backend-resources.js` runs first on the paths as spelled, and it is separator-
//      safe but not link-aware. That is a different defect from this issue's and has its own.
//
// **Read the skips.** Half of what is below can only mean anything on Windows, and this repo's CI is
// Linux-only. Those cases are declared `skip` rather than left to pass while asserting nothing — a green
// `ok` on an assertion that never ran is precisely the reading-instead-of-testing this issue asks against.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const backendResources = require('../src/app/backend-resources');
const agyResources = require('../src/backends/agy/resources');
const claudeResources = require('../src/backends/claude/resources');
const { isInside, isAtOrInside } = require('../src/app/path-containment');

const WIN = process.platform === 'win32';
const SKILL_FRONTMATTER = ['---', 'name: demo', '---', ''].join('\n');

function fakeRegistry(map) {
  return { get: (id) => map[id] || null };
}

/** A project directory with the files a backend looks for, so the listing has something real to find. */
function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sep-'));
  fs.writeFileSync(path.join(dir, 'GEMINI.md'), '# project instructions\n');
  fs.mkdirSync(path.join(dir, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.gemini', 'settings.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# project instructions\n');
  fs.mkdirSync(path.join(dir, '.claude', 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'skills', 'demo', 'SKILL.md'), SKILL_FRONTMATTER);
  return dir;
}

/**
 * agy's own home, well away from the project — returns its conversations directory, which is what the
 * descriptor is given.
 *
 * The two have to be separate directories or the test proves nothing: with the global home INSIDE the
 * project, every global entry is also inside the project and "was this grouped correctly" has no answer.
 */
function makeAgyStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sep-agy-'));
  const conversations = path.join(dir, 'antigravity-cli', 'conversations');
  fs.mkdirSync(conversations, { recursive: true });
  fs.mkdirSync(path.join(dir, 'antigravity-cli', 'knowledge'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'GEMINI.md'), '# global instructions\n');
  fs.writeFileSync(path.join(dir, 'settings.json'), '{}\n');
  return conversations;
}

/** A Claude home with one global skill in it. */
function makeClaudeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sep-claude-'));
  fs.mkdirSync(path.join(dir, 'skills', 'global-demo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'global-demo', 'SKILL.md'), SKILL_FRONTMATTER);
  return dir;
}

/** The same directory, spelled with forward slashes. Windows only — POSIX has one spelling. */
function forwardSlashed(dir) {
  return dir.replace(/\\/g, '/');
}

// --- What holds on every platform ---------------------------------------------------------------------

test('a listing entry is grouped by its declared scope, and the grouping is true (#534)', () => {
  // The core of the null finding, and it needs no separator to state: whatever a backend calls `project`
  // really is inside the project, and whatever it calls `global` really is not. Antigravity's bug made
  // that untrue for a path spelled with the host separator; here the two answers come from different
  // places entirely — one declared, one resolved through the filesystem — so they can be cross-checked.
  const dir = makeProject();
  const listed = agyResources.createListResources({ conversationsRoot: () => makeAgyStore() })({ projectPath: dir });

  const project = listed.resources.filter(r => r.scope === 'project');
  const global = listed.resources.filter(r => r.scope === 'global');
  assert.ok(project.length >= 1, "the project's own files were found");
  assert.ok(global.length >= 1, 'the global half of the listing is populated');

  for (const entry of project) {
    assert.ok(isAtOrInside(entry.path, dir), `${entry.path} is really inside the project it was grouped under`);
  }
  for (const entry of global) {
    assert.equal(isAtOrInside(entry.path, dir), false, `${entry.path} was grouped global but sits in the project`);
  }
});

test("Claude's listing groups by the same rule (#534)", () => {
  // A second backend, because the defect this guards against is the one that gets fixed in one folder and
  // kept in its siblings. Claude is the backend with the skills tree Antigravity's bug was about, so it
  // gets the same cross-check rather than a weaker one.
  const dir = makeProject();
  const home = makeClaudeHome();
  const listed = claudeResources.createListResources({ claudeHome: () => home })({ projectPath: dir });

  const project = listed.resources.filter(r => r.scope === 'project');
  const global = listed.resources.filter(r => r.scope === 'global');
  assert.ok(project.length >= 1, 'the project half of the listing is populated');
  assert.ok(global.length >= 1, 'the global half of the listing is populated');

  for (const entry of project) assert.ok(isAtOrInside(entry.path, dir), `${entry.path} grouped project, sits outside`);
  for (const entry of global) assert.equal(isAtOrInside(entry.path, dir), false, `${entry.path} grouped global, sits inside`);
});

test('a prefix is not containment, whatever the separator (#534)', () => {
  // The compare underneath every answer above. A sibling whose name merely STARTS with the project's is
  // the classic way a string compare says yes — and the reason the separator has to be part of the
  // compare rather than trimmed off it.
  const dir = makeProject();
  assert.equal(isInside(path.join(dir, '.gemini', 'settings.json'), dir), true);
  assert.equal(isInside(dir + '-other' + path.sep + 'f.md', dir), false);
  assert.equal(isInside(dir, dir), false, 'a directory is not inside itself');
  assert.equal(isAtOrInside(dir, dir), true, 'but it is at-or-inside itself');
});

test('a backslash inside a POSIX directory NAME is a character, not a separator (#534)', { skip: WIN }, () => {
  // The mirror image of Antigravity's bug, and the only form of it a Linux runner can stage: on POSIX a
  // backslash is a perfectly ordinary filename character, so anything that "normalises" it to a separator
  // would split one directory into two and put its contents in the wrong group.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sep-posix-'));
  const odd = path.join(dir, 'a\\b');
  fs.mkdirSync(odd);
  const child = path.join(odd, 'note.md');
  fs.writeFileSync(child, '# note\n');

  assert.equal(isInside(child, odd), true, 'the child of a backslash-named directory is inside it');
  assert.equal(isInside(child, path.join(dir, 'a')), false, 'the name was not split at the backslash');
  assert.equal(isAtOrInside(odd, dir), true);
});

// --- What only Windows can answer ---------------------------------------------------------------------

test('a project spelled with forward slashes lists identically (#534)', { skip: !WIN }, () => {
  const dir = makeProject();
  const conversations = makeAgyStore();
  const listResources = agyResources.createListResources({ conversationsRoot: () => conversations });

  const backslash = listResources({ projectPath: dir });
  const forwardish = listResources({ projectPath: forwardSlashed(dir) });

  assert.equal(backslash.ok, true);
  assert.ok(backslash.resources.length > 0, 'the fixture produced a listing to compare');
  // Entry for entry: same kinds, same scopes, same paths. This is the load-bearing half — a `path.join`
  // that carried the caller's spelling through would make the two listings differ, one `\` and one `/`.
  assert.deepEqual(
    forwardish.resources.map(r => [r.kind, r.scope, r.path, r.source]),
    backslash.resources.map(r => [r.kind, r.scope, r.path, r.source]),
  );

  // And the separator that actually came out, which the comparison above cannot see: a join that
  // normalised to the WRONG separator would produce two identical listings and still be wrong.
  const projectPaths = forwardish.resources.filter(r => r.scope === 'project').map(r => r.path);
  assert.ok(projectPaths.length > 0, 'the project half of the listing is populated');
  for (const p of projectPaths) {
    assert.ok(p.includes('\\'), `${p} kept the platform separator`);
    assert.equal(p.includes('/'), false, `${p} carries no trace of how the project was spelled`);
  }
});

test('project scope survives a forward-slash project path (#534)', { skip: !WIN }, () => {
  const dir = makeProject();
  const listResources = agyResources.createListResources({ conversationsRoot: () => makeAgyStore() });
  const listed = listResources({ projectPath: forwardSlashed(dir) });

  const project = listed.resources.filter(r => r.scope === 'project');
  assert.ok(project.length >= 1, "the project's own files were found");
  for (const entry of project) assert.ok(isAtOrInside(entry.path, dir), `${entry.path} grouped project, sits outside`);
  for (const entry of listed.resources.filter(r => r.scope === 'global')) {
    assert.equal(isAtOrInside(entry.path, dir), false, `${entry.path} grouped global, sits inside`);
  }
});

test('containment answers the same for either spelling of the same path (#534)', { skip: !WIN }, () => {
  const dir = makeProject();
  const child = path.join(dir, '.gemini', 'settings.json');

  assert.equal(isInside(child, forwardSlashed(dir)), true, 'the parent spelled the other way is the same parent');
  assert.equal(isInside(forwardSlashed(child), dir), true, 'the child spelled the other way is the same child');
  // A mixed spelling is what a path assembled from two sources actually looks like.
  assert.equal(isInside(dir + '/.gemini' + path.sep + 'settings.json', dir), true, 'mixed separators');
  assert.equal(isInside(child, dir.toUpperCase()), true, 'Windows compares without regard to case');
});

test('reachability of a listed file is an exact match, and that is deliberate (#534)', { skip: !WIN }, () => {
  // The one spelling-sensitive answer left in the chain, and it fails CLOSED: a path that does not match a
  // listing entry byte for byte is refused rather than resolved into one. Every guard here is re-derived
  // per call and none of it is trusted from the renderer, which round-trips the listed path unmodified —
  // so in the panel's own flow the two spellings never diverge.
  //
  // Nothing retries on the user's behalf; a refusal reaches the screen. Pinned so that a future
  // "just normalise it" reads as the behaviour change it is, rather than as a tidy-up.
  const listed = { kind: 'settings', scope: 'global', path: path.join('C:', 'store', 'settings.json') };
  backendResources.init({
    shell: { openPath: async () => '' },
    backends: fakeRegistry({ agy: { listResources: async () => ({ ok: true, resources: [listed] }) } }),
  });

  return Promise.all([
    backendResources.openResource('agy', listed.path, null),
    backendResources.openResource('agy', forwardSlashed(listed.path), null),
  ]).then(([exact, other]) => {
    assert.deepEqual(exact, { ok: true });
    assert.equal(other.ok, false);
    assert.match(other.reason, /not a discovered resource/);
  });
});
