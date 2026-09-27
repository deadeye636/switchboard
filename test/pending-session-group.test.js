// #671: a running session the index has not read yet is placed in the group main already holds for its
// directory, whichever spelling of that directory it carries.
//
// A group carries the spelling of the first row main read (#245). A pending session carries the spawn's,
// and the two can name one directory in two spellings (slash direction, drive-letter case). The renderer
// compares no paths itself: the spellings of a group's own sessions are main's answer to "same directory".
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { findProjectGroup } = require('../src/renderer/lib/project-name.js');

const SLASHED = '/work/alpha';
const BACKSLASHED = '\\work\\alpha';

function group(projectPath, sessions) {
  return { projectPath, folder: 'f', sessions };
}

test('a spelling the group carries matches it directly', () => {
  const list = [group(SLASHED, [])];
  assert.strictEqual(findProjectGroup(list, SLASHED, [list]), list[0]);
});

test('a spelling only a session of the group carries finds that group (#671)', () => {
  const list = [group(SLASHED, [{ sessionId: 's1', projectPath: BACKSLASHED }])];
  assert.strictEqual(findProjectGroup(list, BACKSLASHED, [list]), list[0]);
});

test('a group spelled differently in the two lists is found through the other list', () => {
  // The default list's bucket happened to carry the other spelling and holds no session in the pending one.
  const all = [group(SLASHED, [{ sessionId: 's1', projectPath: BACKSLASHED }])];
  const def = [group(SLASHED, [{ sessionId: 's2', projectPath: SLASHED }])];
  assert.strictEqual(findProjectGroup(def, BACKSLASHED, [all, def]), def[0]);
});

test('a spelling no group holds matches nothing, so a first session opens its own group', () => {
  const list = [group(SLASHED, [{ sessionId: 's1', projectPath: SLASHED }])];
  assert.strictEqual(findProjectGroup(list, '/work/beta', [list]), null);
  // Not even the other spelling of the same directory: the renderer does not normalise paths.
  assert.strictEqual(findProjectGroup(list, BACKSLASHED, [list]), null);
});

test('the exact group wins over one that only shares a session spelling', () => {
  const exact = group(BACKSLASHED, []);
  const list = [group(SLASHED, [{ sessionId: 's1', projectPath: BACKSLASHED }]), exact];
  assert.strictEqual(findProjectGroup(list, BACKSLASHED, [list]), exact);
});

test('no list or no path answers null rather than throwing', () => {
  assert.strictEqual(findProjectGroup(null, SLASHED, null), null);
  assert.strictEqual(findProjectGroup([group(SLASHED, [])], '', null), null);
});

// --- the wiring: injectPendingSession in app.js asks the helper ---------------------------------------

// The function's source out of app.js, by matching braces from its declaration. Its body holds no brace
// inside a string or a comment, which the assertion on the slice's end keeps honest.
function sliceFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found in app.js`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`${name} has no closing brace`);
}

function loadInject(cachedProjects, cachedAllProjects) {
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  const ctx = vm.createContext({ cachedProjects, cachedAllProjects, findProjectGroup });
  vm.runInContext(`${sliceFunction(app, 'injectPendingSession')}; this.inject = injectPendingSession;`, ctx);
  return ctx.inject;
}

test('a pending session spelled like a sibling joins the existing group instead of opening a second (#671)', () => {
  const def = [group(SLASHED, [{ sessionId: 's1', projectPath: BACKSLASHED }])];
  const all = [group(SLASHED, [{ sessionId: 's1', projectPath: BACKSLASHED }])];
  const inject = loadInject(def, all);
  const pending = { sessionId: 'p1', projectPath: BACKSLASHED, archived: 0 };
  inject(pending, BACKSLASHED, 'folder');
  assert.strictEqual(def.length, 1, 'default list grew a phantom group');
  assert.strictEqual(all.length, 1, 'archive-inclusive list grew a phantom group');
  assert.deepStrictEqual(def[0].sessions.map(s => s.sessionId), ['p1', 's1']);
  assert.deepStrictEqual(all[0].sessions.map(s => s.sessionId), ['p1', 's1']);
  // Re-injection on the next refresh stays deduplicated.
  inject(pending, BACKSLASHED, 'folder');
  assert.strictEqual(def[0].sessions.length, 2);
});

test('a pending session in a directory no group holds still opens a new group', () => {
  const def = [group(SLASHED, [{ sessionId: 's1', projectPath: SLASHED }])];
  const all = [group(SLASHED, [{ sessionId: 's1', projectPath: SLASHED }])];
  const inject = loadInject(def, all);
  inject({ sessionId: 'p1', projectPath: '/work/beta', archived: 0 }, '/work/beta', 'beta-folder');
  assert.strictEqual(def.length, 2);
  assert.strictEqual(def[0].projectPath, '/work/beta');
  assert.strictEqual(def[0].folder, 'beta-folder');
  assert.deepStrictEqual(Array.from(def[0].sessions, s => s.sessionId), ['p1']); // the new group's array is the vm's
});
