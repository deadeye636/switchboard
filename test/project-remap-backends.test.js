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

const { rewriteTranscript, claudeLine, codexLine, piLine, samePath } = require('../backends/rewrite-cwd');
const backends = require('../backends');

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
    assert.strictEqual(backends.get('claude').rewriteProjectPath(t.file, OLD, NEW), true);
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
    assert.strictEqual(backends.get('codex').rewriteProjectPath(t.file, OLD, NEW), true);
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
    assert.strictEqual(backends.get('pi').rewriteProjectPath(t.file, OLD, NEW), true);
    assert.strictEqual(t.read()[0].cwd, NEW);
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('a transcript that is not this project\'s is not rewritten, and not touched', () => {
  const t = tmpFile([{ type: 'user', cwd: 'D:\\other', message: { role: 'user', content: 'x' } }]);
  try {
    const before = fs.statSync(t.file).mtimeMs;
    assert.strictEqual(backends.get('claude').rewriteProjectPath(t.file, OLD, NEW), false,
      'nothing to do');
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
    assert.strictEqual(backends.get('claude').rewriteProjectPath(t.file, OLD, NEW), true);
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

    assert.strictEqual(rewriteTranscript(file, OLD, NEW, claudeLine), true);
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
