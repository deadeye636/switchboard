'use strict';
// A remap must move the WHOLE project (#171).
//
// It rewrote `~/.claude/projects/**` and stopped there. Reproduced against a real install before this was
// written: remapping a project with Claude AND Codex sessions left the Codex ones behind at the old path,
// so one project became two — the rename, and a phantom holding the user's Codex history. And a project
// with only Codex sessions could not be remapped at all: the handler looked for its sessions in Claude's
// store, did not find them, and answered "No session data found for this project".
//
// Each backend knows where its own cwd lives, so each declares how to rewrite it. Hermes declares
// nothing: its cwd is a column in a database we may only read (#2914).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { rewriteTranscript, claudeLine, codexLine, piLine, samePath } = require('../src/backends/rewrite-cwd');
const backends = require('../src/backends');

const OLD = 'D:\\temp\\project';
const NEW = 'D:\\temp\\project-moved';

function tmpFile(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remap-'));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return { file, dir, read: () => fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) };
}

test('Claude writes cwd on every line — so every line moves', () => {
  const t = tmpFile([
    { type: 'user', cwd: OLD, message: { role: 'user', content: 'one' } },
    { type: 'assistant', cwd: OLD, message: { role: 'assistant', content: 'two' } },
    { type: 'user', cwd: 'D:\\elsewhere', message: { role: 'user', content: 'not mine' } },
  ]);
  try {
    assert.deepStrictEqual(backends.get('claude').rewriteProjectPath(t.file, OLD, NEW), { ok: true, changed: true });
    const rows = t.read();
    assert.deepStrictEqual(rows.map(r => r.cwd), [NEW, NEW, 'D:\\elsewhere'],
      'a line belonging to another cwd is left alone');
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('Codex writes cwd ONCE, in the session_meta header', () => {
  const t = tmpFile([
    { timestamp: 't', type: 'session_meta', payload: { id: 'x', cwd: OLD } },
    { timestamp: 't', type: 'event_msg', payload: { type: 'user_message', message: 'hi' } },
  ]);
  try {
    assert.deepStrictEqual(backends.get('codex').rewriteProjectPath(t.file, OLD, NEW), { ok: true, changed: true });
    const rows = t.read();
    assert.strictEqual(rows[0].payload.cwd, NEW, 'the header follows the project');
    assert.strictEqual(rows[1].payload.type, 'user_message', 'and nothing else is touched');
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('Pi writes cwd ONCE, on its header line', () => {
  const t = tmpFile([
    { type: 'session', version: 3, id: 'x', cwd: OLD },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
  ]);
  try {
    assert.deepStrictEqual(backends.get('pi').rewriteProjectPath(t.file, OLD, NEW), { ok: true, changed: true });
    assert.strictEqual(t.read()[0].cwd, NEW);
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('a transcript that is not this project\'s is not rewritten, and not touched', () => {
  const t = tmpFile([{ type: 'user', cwd: 'D:\\other', message: { role: 'user', content: 'x' } }]);
  try {
    const before = fs.statSync(t.file).mtimeMs;
    assert.deepStrictEqual(backends.get('claude').rewriteProjectPath(t.file, OLD, NEW), { ok: true, changed: false },
      'nothing to do — and since #557 that no longer reads the same as a write that failed');
    assert.strictEqual(fs.statSync(t.file).mtimeMs, before, 'and the file is not rewritten for nothing');
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('the same directory in another spelling still moves', () => {
  // Windows: a store carries `d:\temp\project` and `D:\Temp\Project` for the same directory. A remap that
  // compared strings exactly would leave half the sessions behind.
  if (process.platform !== 'win32') return;
  const t = tmpFile([{ type: 'user', cwd: 'd:\\TEMP\\Project', message: { role: 'user', content: 'x' } }]);
  try {
    assert.strictEqual(samePath('d:\\TEMP\\Project', OLD), true);
    assert.deepStrictEqual(backends.get('claude').rewriteProjectPath(t.file, OLD, NEW), { ok: true, changed: true });
    assert.strictEqual(t.read()[0].cwd, NEW);
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('a truncated last line (a live session, mid-write) does not lose the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remap-t-'));
  const file = path.join(dir, 's.jsonl');
  try {
    fs.writeFileSync(file,
      JSON.stringify({ type: 'user', cwd: OLD, message: { role: 'user', content: 'x' } }) + '\n'
      + '{"type":"assistant","cw');   // being appended right now

    assert.deepStrictEqual(rewriteTranscript(file, OLD, NEW, claudeLine), { ok: true, changed: true });
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('"cwd":"' + NEW.replace(/\\/g, '\\\\') + '"'), 'the good line moved');
    assert.ok(text.includes('{"type":"assistant","cw'), 'and the half-written one survived untouched');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the rules do not fire on each other\'s files', () => {
  // Codex' rule must not rewrite a Claude line (which carries a top-level cwd), and Pi's must not either
  // — otherwise a shared store would corrupt across backends.
  const claudeEntry = { type: 'user', cwd: OLD };
  assert.strictEqual(codexLine({ ...claudeEntry }, OLD, NEW), false);
  assert.strictEqual(piLine({ ...claudeEntry }, OLD, NEW), false, 'Pi only moves its own header');

  const codexEntry = { type: 'session_meta', payload: { cwd: OLD } };
  assert.strictEqual(claudeLine({ ...codexEntry }, OLD, NEW), false, 'Claude reads a top-level cwd only');
});

// --- the compare is about the REAL path, not the spelling (#563) ---
//
// A remap that decides by string leaves behind exactly the lines it was called to move: a project reached
// through a junction, a symlink or a `subst` drive is spelled two ways, so the transcript keeps the old
// path and the phantom project this whole file exists to prevent comes back. Exercised with a link that
// really exists — a fixture that only looks like one passes the string compare too.
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

test('a cwd recorded under a linked spelling is the same project, and moves with it', () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'remap-link-')));
  try {
    const realProject = path.join(root, 'project');
    fs.mkdirSync(realProject);
    const viaLink = path.join(root, 'project-link');
    try { fs.symlinkSync(realProject, viaLink, LINK_TYPE); } catch {
      assert.fail('could not create a link on this platform — that IS the case under test, so it is not skipped silently');
    }
    const moved = path.join(root, 'project-moved');

    // The transcript recorded the linked spelling; the remap is asked about the real one.
    assert.strictEqual(samePath(viaLink, realProject), true, 'one directory, however it was reached');

    const file = path.join(root, 's.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'user', cwd: viaLink, message: { role: 'user', content: 'mine' } }),
      JSON.stringify({ type: 'user', cwd: path.join(root, 'somewhere-else'), message: { role: 'user', content: 'not mine' } }),
    ].join('\n') + '\n');

    assert.deepStrictEqual(rewriteTranscript(file, realProject, moved, claudeLine), { ok: true, changed: true },
      'the line belongs to this project and must be rewritten');
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    assert.strictEqual(rows[0].cwd, moved);
    assert.strictEqual(rows[1].cwd, path.join(root, 'somewhere-else'), 'and a genuinely other directory is left alone');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
