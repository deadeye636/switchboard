'use strict';
// A resume of a session whose working directory is gone (#862): the decision, the Pi descriptor's half, the
// spawn guard's wiring and the dialog wiring.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const missingCwd = require('../src/app/terminal/missing-cwd');
const piResumeCwd = require('../src/backends/pi/resume-cwd');
const pi = require('../src/backends/pi');
const piNative = require('../src/backends/pi-native');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-missing-cwd-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function transcript(name, cwd) {
  const file = path.join(root, name);
  const header = { type: 'session', version: 3, id: name, timestamp: '2026-01-01T00:00:00.000Z', cwd };
  const msg = { type: 'message', id: 'a1', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: [] } };
  fs.writeFileSync(file, `${JSON.stringify(header)}\r\n${JSON.stringify(msg)}\n`);
  return file;
}

const stub = (read) => ({ transcriptPathFor: (row) => row && row.filePath, resumeCwd: { read, continueIn: () => ({ ok: true }) } });

test('assess: a backend without the hook is not asked', () => {
  assert.strictEqual(missingCwd.assess({ backend: { transcriptPathFor: () => 'x' }, row: {}, projectPath: root }).state, 'ok');
});

test('assess: folder present, gone, unrecorded', () => {
  const backend = stub(() => path.join(root, 'there'));
  const row = { filePath: 'f' };
  assert.strictEqual(missingCwd.assess({ backend, row, projectPath: root, exists: () => true }).state, 'ok');
  const gone = missingCwd.assess({ backend, row, projectPath: root, exists: () => false });
  assert.strictEqual(gone.state, 'gone');
  assert.strictEqual(gone.file, 'f');
  assert.strictEqual(missingCwd.assess({ backend: stub(() => null), row, projectPath: root }).state, 'unknown');
  assert.strictEqual(missingCwd.assess({ backend, row: null, projectPath: root }).state, 'unknown');
});

test('assess: a network path of a share no project is on is never touched', () => {
  let touched = 0;
  const exists = () => { touched++; return false; };
  const row = { filePath: 'f' };
  const foreign = missingCwd.assess({ backend: stub(() => '\\\\evil\\share\\proj'), row, projectPath: 'C:\\work', exists });
  assert.strictEqual(foreign.state, 'unknown');
  assert.strictEqual(touched, 0);
  // the project itself lives on that share: the check is made
  const own = missingCwd.assess({ backend: stub(() => '\\\\nas\\share\\old'), row, projectPath: '\\\\nas\\share\\new', exists });
  assert.strictEqual(own.state, 'gone');
  assert.strictEqual(touched, 1);
});

test('assess: a network path on the share of a registered project is checked, though the resumed project is elsewhere', () => {
  let touched = 0;
  const exists = () => { touched++; return false; };
  const r = missingCwd.assess({ backend: stub(() => '\\\\nas\\share\\old'), row: { filePath: 'f' }, projectPath: 'C:\\work', knownPaths: ['\\\\nas\\share\\other'], exists });
  assert.strictEqual(r.state, 'gone');
  assert.strictEqual(touched, 1);
});

test('assess: a throwing hook or existence check does not stop the resume', () => {
  const row = { filePath: 'f' };
  assert.strictEqual(missingCwd.assess({ backend: stub(() => { throw new Error('x'); }), row, projectPath: root }).state, 'unknown');
  assert.strictEqual(missingCwd.assess({ backend: stub(() => 'D:\\a'), row, projectPath: root, exists: () => { throw new Error('x'); } }).state, 'ok');
});

test('continueHere: answers the file to resume by, or a sentence', () => {
  const f = transcript('d.jsonl', 'a');
  const ok = missingCwd.continueHere({ backend: stub(() => 'x'), file: f, storedCwd: 'a', cwd: 'b' });
  assert.deepStrictEqual(ok, { ok: true, ref: f });
  const bad = missingCwd.continueHere({ backend: { resumeCwd: { continueIn: () => ({ ok: false, reason: 'unreadable' }) } }, file: f, storedCwd: 'a', cwd: 'b' });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /unreadable/);
  assert.strictEqual(missingCwd.continueHere({ backend: { resumeCwd: {} }, file: f, storedCwd: 'a', cwd: 'b' }).ok, false);
  // the transcript vanished between the question and the answer: no launch of a missing file
  let called = 0;
  const vanished = missingCwd.continueHere({ backend: { resumeCwd: { continueIn: () => { called++; return { ok: true }; } } }, file: path.join(root, 'vanished.jsonl'), storedCwd: 'a', cwd: 'b' });
  assert.strictEqual(vanished.ok, false);
  assert.strictEqual(called, 0);
});

test('pi: reads the header cwd, and declines what is not a header', () => {
  const file = transcript('a.jsonl', path.join(root, 'old'));
  assert.strictEqual(piResumeCwd.read(file), path.join(root, 'old'));
  assert.strictEqual(piResumeCwd.read(path.join(root, 'nope.jsonl')), null);
  const junk = path.join(root, 'junk.jsonl');
  fs.writeFileSync(junk, 'not json\n');
  assert.strictEqual(piResumeCwd.read(junk), null);
  fs.writeFileSync(junk, `${JSON.stringify({ type: 'message', cwd: 'x' })}\n`);
  assert.strictEqual(piResumeCwd.read(junk), null);
});

test('pi: continueIn rewrites only the header cwd and keeps every other byte', () => {
  const file = transcript('b.jsonl', path.join(root, 'old'));
  const before = fs.readFileSync(file, 'utf8').split('\n');
  const res = piResumeCwd.continueIn({ file, storedCwd: path.join(root, 'old'), cwd: root });
  assert.deepStrictEqual(res, { ok: true });
  assert.strictEqual(piResumeCwd.read(file), root);
  const after = fs.readFileSync(file, 'utf8').split('\n');
  assert.strictEqual(after[1], before[1]);
  assert.ok(after[0].endsWith('\r'), 'the header line keeps its own terminator');
  assert.strictEqual(piResumeCwd.continueIn({ file: path.join(root, 'nope.jsonl'), storedCwd: 'a', cwd: 'b' }).ok, true);
  assert.strictEqual(piResumeCwd.continueIn({}).ok, false);
});

test('pi: argv for continue (by file), plain resume (by id) and fork', () => {
  const file = path.join(root, 'c.jsonl');
  assert.deepStrictEqual(pi.buildLaunch({ cwd: root, resume: true, sessionId: 'abc', resumeRef: file }).args.slice(0, 2), ['--session', file]);
  assert.deepStrictEqual(pi.buildLaunch({ cwd: root, resume: true, sessionId: 'abc' }).args.slice(0, 2), ['--session', 'abc']);
  assert.deepStrictEqual(pi.buildLaunch({ cwd: root, resume: false, sessionId: 'new', forkFrom: 'abc' }).args.slice(0, 2), ['--fork', 'abc']);
  const native = piNative.buildLaunch({ cwd: root, resume: true, sessionId: 'abc', resumeRef: file }).args;
  assert.ok(native.includes('rpc'));
  assert.strictEqual(native[native.indexOf('--session') + 1], file);
});

test('both Pi backends declare the hook and fork', () => {
  for (const b of [pi, piNative]) {
    assert.strictEqual(typeof b.resumeCwd.read, 'function');
    assert.strictEqual(typeof b.resumeCwd.continueIn, 'function');
    assert.strictEqual(b.supportsFork, true);
  }
});

const src = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('spawn guard: asks before buildLaunch, never for a new session or a fork, names no backend', () => {
  const s = src('src/app/terminal/spawn.js');
  const at = s.indexOf('missingCwd.assess');
  assert.ok(at > 0 && at < s.indexOf('backend.buildLaunch({'), 'the question comes before the launch');
  const guard = s.slice(s.lastIndexOf('let resumeRef', at), at);
  assert.match(guard, /!isNew/);
  assert.match(guard, /!sessionOptions\?\.forkFrom/);
  assert.match(s, /cwdGone:/);
  assert.match(s, /resumeRef,\s*\n?\s*forkFrom/);
});

test('renderer: the refusal opens the dialog; Continue retries with the answer, Fork uses the ordinary fork', () => {
  const app = src('src/renderer/app.js');
  assert.match(app, /result\.cwdGone[\s\S]{0,200}showMissingCwdChoice/);
  assert.match(app, /missingCwd \? \{ missingCwd \}/);
  const dlg = src('src/renderer/dialogs/dialogs.js');
  const fn = dlg.slice(dlg.indexOf('async function showMissingCwdChoice'), dlg.indexOf('window.showMissingCwdChoice'));
  assert.match(fn, /showControlDialog/);
  assert.match(fn, /missingCwd: 'continue'/);
  assert.match(fn, /forkSession\(session, project\)/);
  assert.doesNotMatch(fn, /dismissible/);
});
