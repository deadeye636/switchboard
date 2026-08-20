'use strict';
// #444 — a filesystem error is not a message for the user.
//
// The rule the app has to hold is one sentence: nothing shown to a reader carries a raw fs error string.
// It was written for the resource LISTING and missed the other half of the same surface — the Agent
// Files tab reads a resource through the sanitised path and then saves it through one that answered with
// `EACCES: permission denied, open '<home>/…'` in a dialog. Both halves are covered here: the helper
// itself, and the four write/delete paths that were still forwarding.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readableError, ERRNO_WORDS } = require('../src/app/readable-error');
const plansMemory = require('../src/app/plans-memory');

const SECRET = path.join('/home', 'someone', 'projects', 'thing', 'notes.md');

function errnoError(code) {
  const err = new Error(`${code}: what the OS said, open '${SECRET}'`);
  err.code = code;
  return err;
}

// --- the helper ---------------------------------------------------------------

test('a recognised errno becomes words, and the raw message is not one of them', () => {
  const msg = readableError(errnoError('EACCES'), 'Could not save that file.');
  assert.equal(msg, 'Could not save that file. Permission was denied.');
  assert.ok(!msg.includes(SECRET));
});

test('an unrecognised error keeps only the caller sentence', () => {
  // Not trimmed, not scrubbed of the quoted path — dropped. There is no way to tell from here what an
  // unrecognised message carries, so none of it is passed on.
  assert.equal(readableError(new Error(`odd thing about ${SECRET}`), 'Could not save that file.'),
    'Could not save that file.');
  assert.equal(readableError(errnoError('ENOTAREALCODE'), 'Could not save that file.'),
    'Could not save that file.');
  assert.equal(readableError(null, 'Could not save that file.'), 'Could not save that file.');
});

test('every worded answer is a sentence, and none of them names a path', () => {
  for (const [code, words] of Object.entries(ERRNO_WORDS)) {
    assert.match(words, /^[A-Z].*\.$/s, `${code} should read as a sentence`);
    assert.ok(!/[\\/]|~/.test(words), `${code} must not carry anything path-shaped`);
  }
});

test('the codes Windows actually produces are covered', () => {
  // EINVAL and UNKNOWN are what a network share, an antivirus lock or a dropped drive come back as, and
  // they were the two missing when this was first written.
  for (const code of ['EACCES', 'EPERM', 'EROFS', 'ENOENT', 'EBUSY', 'ENOSPC', 'EINVAL', 'UNKNOWN']) {
    assert.ok(ERRNO_WORDS[code], `${code} has no words`);
  }
});

test('the dropped detail goes to the log instead of nowhere', () => {
  const lines = [];
  readableError(errnoError('EACCES'), 'Could not save that file.', { debug: (l) => lines.push(l) });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('EACCES'));
  assert.ok(lines[0].includes(SECRET), 'the log is where the raw message belongs');
});

test('no log is not an error', () => {
  assert.doesNotThrow(() => readableError(errnoError('EACCES'), 'x.'));
  assert.doesNotThrow(() => readableError(errnoError('EACCES'), 'x.', {}));
});

// --- the write and delete paths that were still forwarding ---------------------
//
// Driven through the real functions rather than asserted from the source: a guard that greps for
// `err.message` passes the moment someone writes the same defect a different way. The failure is made
// real by pointing a write at a DIRECTORY — every platform refuses that, with an errno.

function sandbox() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-readable-'));
  const plans = path.join(project, '.plans');
  fs.mkdirSync(plans, { recursive: true });
  fs.mkdirSync(path.join(project, '.work-files'), { recursive: true });

  plansMemory.init({
    log: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
    // One live session in this project is what makes its files reachable at all.
    activeSessions: new Map([['s1', { projectPath: project }]]),
    db: { getProjectStates: () => new Map([[project, { registered: true }]]) },
    backends: { list: () => [{ id: 'x', status: 'ready', plansDir: () => plans, memorySources: () => [] }] },
    getMainWindow: () => null,
    getDetachedWindows: () => [],
  });
  return { project, plans, cleanup: () => { plansMemory.stopWatchingPlansDirs(); fs.rmSync(project, { recursive: true, force: true }); } };
}

/** A path that exists and is writable-looking but is a directory, so the write must fail with an errno. */
function dirNamed(parent, name) {
  const p = path.join(parent, name);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

test('a plan that cannot be saved says so without the path', () => {
  const box = sandbox();
  try {
    const res = plansMemory.savePlan(dirNamed(box.plans, 'blocked.md'), 'text');
    assert.equal(res.ok, false);
    assert.match(res.error, /^Could not save that plan\./);
    assert.ok(!res.error.includes(box.project), 'the dialog would have shown the whole path');
    assert.ok(!/^E[A-Z]+:/.test(res.error), 'nor the errno itself');
  } finally { box.cleanup(); }
});

test('an instruction file that cannot be saved says so without the path', () => {
  const box = sandbox();
  try {
    const res = plansMemory.saveMemory(dirNamed(box.project, 'CLAUDE.md'), 'text');
    assert.equal(res.ok, false);
    assert.match(res.error, /^Could not save that file\./);
    assert.ok(!res.error.includes(box.project));
  } finally { box.cleanup(); }
});

test('a work file that cannot be deleted says so without the path', () => {
  const box = sandbox();
  try {
    // A directory inside .work-files: it exists, it is reachable, and `unlink` refuses it.
    const target = dirNamed(path.join(box.project, '.work-files'), 'stuck');
    const res = plansMemory.deleteWorkFile(target);
    assert.equal(res.ok, false);
    assert.match(res.error, /^Could not delete that file\./);
    assert.ok(!res.error.includes(box.project));
  } finally { box.cleanup(); }
});

test('the refusals a module AUTHORED are left alone', () => {
  const box = sandbox();
  try {
    // These are written for a reader already, and translating them would be a downgrade.
    assert.equal(plansMemory.savePlan(path.join(os.tmpdir(), 'elsewhere.md'), 'x').error,
      'path outside a plans directory');
    assert.equal(plansMemory.saveMemory(path.join(box.project, 'notes.bin'), 'x').error,
      'not an instruction file');
    assert.equal(plansMemory.deleteWorkFile(path.join(box.project, 'plain.md')).error,
      'access denied');
  } finally { box.cleanup(); }
});
