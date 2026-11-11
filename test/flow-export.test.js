'use strict';
// The Flow export (spec 46, #826, plan T17): a validated neutral snapshot, no sources or paths, refused formats,
// cancel, and the write through safe-write.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateSnapshot, emptyFlowSnapshot } = require('../src/shared/flow-snapshot');
const { stripComments } = require('./helpers/strip-comments');
const flowExport = require('../src/app/flow-export');
const dialogDirs = require('../src/app/dialog-dirs');

const log = { debug() {}, info() {}, warn() {} };
const SECRET_FILE = path.join(os.tmpdir(), 'transcripts', 'secret-session.jsonl');

function snapshotWithStep() {
  const snap = emptyFlowSnapshot();
  snap.lanes = [{ id: 'main', kind: 'main', label: 'main' }];
  snap.steps = [{ id: 's1', laneId: 'main', ordinal: 0, kind: 'start', label: 'hello', source: {}, flags: [] }];
  snap.fingerprint = { size: 123, mtimeMs: 4, head: 'abc' };
  snap.sources = [{ file: SECRET_FILE, role: 'main' }];
  return snap;
}

function setup({ snapshot = snapshotWithStep(), pickedName = 'out.json', canceled = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-export-'));
  const calls = { dialog: [], read: [] };
  const store = {};
  dialogDirs.init({ getSetting: (k) => store[k], setSetting: (k, v) => { store[k] = v; }, log });
  flowExport.init({
    log,
    getAppVersion: () => '9.9.9',
    getParentWindow: () => null,
    readFlow: async (id, sender) => { calls.read.push([id, sender]); return snapshot; },
    dialog: { showSaveDialog: async (parent, opts) => { calls.dialog.push(opts); return canceled ? { canceled: true } : { canceled: false, filePath: path.join(dir, pickedName) }; } },
  });
  return { dir, calls, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('writes a validated neutral snapshot with the envelope', async () => {
  const s = setup();
  try {
    const res = await flowExport.exportFlow({ sessionId: 'abcdef123456', format: 'json' }, { sender: { id: 3 } });
    assert.deepEqual(res, { ok: true, canceled: false, name: 'out.json' });
    const doc = JSON.parse(fs.readFileSync(path.join(s.dir, 'out.json'), 'utf8'));
    assert.equal(doc.exportVersion, 1);
    assert.deepEqual(doc.app, { name: 'Switchboard', version: '9.9.9' });
    assert.ok(!Number.isNaN(Date.parse(doc.exportedAt)));
    assert.deepEqual(validateSnapshot(doc.snapshot).errors, []);
    assert.equal(doc.snapshot.steps.length, 1);
    assert.match(path.basename(s.calls.dialog[0].defaultPath), /^abcdef12-flow\.json$/);
  } finally { s.cleanup(); }
});

test('the file holds no sources, transcript path or fingerprint', async () => {
  const s = setup();
  try {
    await flowExport.exportFlow({ sessionId: 'abcdef123456', format: 'json' }, { sender: { id: 3 } });
    const text = fs.readFileSync(path.join(s.dir, 'out.json'), 'utf8');
    const doc = JSON.parse(text);
    assert.equal(doc.snapshot.fingerprint, null);
    assert.ok(!text.includes('secret-session'));
    assert.ok(!text.includes('"head"'));
    assert.ok(!text.includes('"size"'));
  } finally { s.cleanup(); }
});

test('the answer holds no path', async () => {
  const s = setup();
  try {
    const res = await flowExport.exportFlow({ sessionId: 'abcdef123456', format: 'json' }, null);
    assert.ok(!JSON.stringify(res).includes(s.dir));
  } finally { s.cleanup(); }
});

test('an unknown format is refused before any read or dialog', async () => {
  const s = setup();
  try {
    for (const format of ['pdf', 'mermaid', '', undefined, '__proto__', 'toString']) {
      const res = await flowExport.exportFlow({ sessionId: 'abcdef123456', format }, null);
      assert.equal(res.ok, false);
      assert.equal(res.canceled, false);
    }
    assert.equal(s.calls.read.length, 0);
    assert.equal(s.calls.dialog.length, 0);
  } finally { s.cleanup(); }
});

test('a cancelled dialog answers canceled and writes nothing', async () => {
  const s = setup({ canceled: true });
  try {
    const res = await flowExport.exportFlow({ sessionId: 'abcdef123456', format: 'json' }, null);
    assert.deepEqual(res, { ok: false, canceled: true });
    assert.deepEqual(fs.readdirSync(s.dir), []);
  } finally { s.cleanup(); }
});

test('an empty read and an invalid snapshot are refused without a dialog', async () => {
  for (const snapshot of [null, emptyFlowSnapshot(), { ...snapshotWithStep(), schemaVersion: 999 }]) {
    const s = setup({ snapshot });
    try {
      const res = await flowExport.exportFlow({ sessionId: 'abcdef123456', format: 'json' }, null);
      assert.equal(res.ok, false);
      assert.equal(s.calls.dialog.length, 0);
    } finally { s.cleanup(); }
  }
});

test('the export reads under a key of its own, not a window key', async () => {
  const s = setup();
  try {
    await flowExport.exportFlow({ sessionId: 'abcdef123456', format: 'json' }, { sender: { id: 3 } });
    assert.ok(s.calls.read[0][1] < 0);
  } finally { s.cleanup(); }
});

test('the write goes through safe-write, not fs.writeFileSync', () => {
  const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'flow-export.js'), 'utf8'));
  assert.match(src, /safeWrite\.writeTextFile\(/);
  assert.doesNotMatch(src, /writeFileSync|fs\.promises\.writeFile/);
});

test('the read is asked not to remember a fingerprint', async () => {
  const s = setup();
  let opts = null;
  try {
    flowExport.init({ log, getAppVersion: () => '1', readFlow: async (id, k, o) => { opts = o; return snapshotWithStep(); },
      dialog: { showSaveDialog: async () => ({ canceled: true }) } });
    await flowExport.exportFlow({ sessionId: 'abcdef123456', format: 'json' }, null);
    assert.deepEqual(opts, { remember: false });
  } finally { s.cleanup(); }
});

test('a read cancelled by a newer one answers canceled, not a failure', async () => {
  const cancelled = emptyFlowSnapshot({ limitations: [{ id: 'read-cancelled', text: 'x' }] });
  const s = setup({ snapshot: cancelled });
  try {
    const res = await flowExport.exportFlow({ sessionId: 'abcdef123456', format: 'json' }, null);
    assert.deepEqual(res, { ok: false, canceled: true });
    assert.equal(s.calls.dialog.length, 0);
  } finally { s.cleanup(); }
});

test('a sender destroyed during the read cancels before the dialog; a throwing parent lookup is survived', async () => {
  const s = setup();
  try {
    const res = await flowExport.exportFlow({ sessionId: 'abcdef123456', format: 'json' }, { sender: { id: 1, isDestroyed: () => true } });
    assert.deepEqual(res, { ok: false, canceled: true });
    assert.equal(s.calls.dialog.length, 0);
    flowExport.init({ log, getAppVersion: () => '1', getParentWindow: () => { throw new Error('destroyed'); },
      readFlow: async () => snapshotWithStep(),
      dialog: { showSaveDialog: async () => ({ canceled: false, filePath: path.join(s.dir, 'p.json') }) } });
    const ok = await flowExport.exportFlow({ sessionId: 'abcdef123456', format: 'json' }, { sender: { id: 1, isDestroyed: () => false } });
    assert.equal(ok.ok, true);
  } finally { s.cleanup(); }
});

test('overwriting a file that has a BOM and CRLF writes plain UTF-8 and LF', async () => {
  const s = setup();
  try {
    fs.writeFileSync(path.join(s.dir, 'out.json'), String.fromCharCode(0xFEFF) + 'old' + String.fromCharCode(13, 10));
    const res = await flowExport.exportFlow({ sessionId: 'abcdef123456', format: 'json' }, null);
    assert.equal(res.ok, true);
    const buf = fs.readFileSync(path.join(s.dir, 'out.json'));
    assert.notDeepEqual([...buf.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
    assert.ok(!buf.includes(13));
  } finally { s.cleanup(); }
});

test('svg is a registered format: .svg file, the same fresh read, well-formed output', async () => {
  const s = setup({ pickedName: 'out.svg' });
  try {
    assert.ok(flowExport.FORMATS.svg && flowExport.FORMATS.json);
    const res = await flowExport.exportFlow({ sessionId: 'abcdef123456', format: 'svg' }, { sender: { id: 3 } });
    assert.deepEqual(res, { ok: true, canceled: false, name: 'out.svg' });
    assert.equal(s.calls.read.length, 1);
    assert.match(path.basename(s.calls.dialog[0].defaultPath), /^abcdef12-flow\.svg$/);
    assert.deepEqual(s.calls.dialog[0].filters, [{ name: 'SVG', extensions: ['svg'] }]);
    const text = fs.readFileSync(path.join(s.dir, 'out.svg'), 'utf8');
    assert.ok(text.startsWith('<?xml'));
    assert.ok(text.includes('Session abcdef12'));
    assert.ok(!text.includes('secret-session'));
  } finally { s.cleanup(); }
});

test('the backend label from the view is sanitised; a missing or non-string label prints no backend', async () => {
  const s = setup({ pickedName: 'l.svg' });
  const run = async (backendLabel) => {
    await flowExport.exportFlow({ sessionId: 'abcdef123456', format: 'svg', backendLabel }, null);
    return fs.readFileSync(path.join(s.dir, 'l.svg'), 'utf8');
  };
  try {
    const ok = await run('  Claude Code ' + String.fromCharCode(0, 7) + ' ');
    assert.ok(ok.includes('Session abcdef12 · Claude Code · exported'));
    const capped = await run('x'.repeat(500));
    assert.ok(capped.includes('x'.repeat(80)) && !capped.includes('x'.repeat(81)));
    const escaped = await run('<b>&</b>');
    assert.ok(escaped.includes('&lt;b&gt;&amp;&lt;/b&gt;') && !escaped.includes('<b>'));
    for (const bad of [undefined, null, 42, {}, ['a']]) {
      const text = await run(bad);
      assert.ok(!/Session abcdef12 · (undefined|null|42|\[object|a  ·)/.test(text));
      assert.ok(/Session abcdef12 · exported /.test(text));
    }
  } finally { s.cleanup(); }
});

test('main derives no backend label itself', () => {
  const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'flow-export.js'), 'utf8'));
  assert.doesNotMatch(src, /openerFor|backendLabelOf|transcriptsOf/);
});
