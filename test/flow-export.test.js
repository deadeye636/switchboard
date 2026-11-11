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
    for (const format of ['dot', '', undefined, '__proto__', 'toString']) {
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

// ----- PDF (plan T19): an injected window factory stands in for the hidden BrowserWindow -----

function fakeWindowFactory({ pdf = Buffer.from('%PDF-1.4 fake'), loadFile, print } = {}) {
  const made = [];
  const create = () => {
    const w = {
      destroyed: false,
      html: null,
      isDestroyed() { return this.destroyed; },
      destroy() { this.destroyed = true; },
      async loadFile(file) { this.file = file; this.html = fs.readFileSync(file, 'utf8'); if (loadFile) await loadFile(this); },
      webContents: { printToPDF: async (opts) => { w.opts = opts; if (print) return print(w); return pdf; } },
    };
    made.push(w);
    return w;
  };
  return { create, made };
}

function setupPdf(fake, extra = {}) {
  const s = setup({ pickedName: 'out.pdf' });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-pdf-tmp-'));
  flowExport.init({
    log, getAppVersion: () => '9.9.9', getParentWindow: () => null,
    readFlow: async () => snapshotWithStep(),
    createPdfWindow: fake.create, tempDir,
    dialog: { showSaveDialog: async (parent, opts) => { s.calls.dialog.push(opts); return { canceled: false, filePath: path.join(s.dir, 'out.' + opts.filters[0].extensions[0]) }; } },
    ...extra,
  });
  return { ...s, tempDir, cleanup: () => { s.cleanup(); fs.rmSync(tempDir, { recursive: true, force: true }); } };
}

test('pdf: the bytes are written as they are, the window is destroyed, the temp file is gone, the HTML holds no script', async () => {
  const fake = fakeWindowFactory();
  const s = setupPdf(fake);
  try {
    assert.equal(flowExport.FORMATS.pdf.ext, 'pdf');
    const res = await flowExport.exportFlow({ sessionId: 'abcdef123456', format: 'pdf' }, { sender: { id: 3 } });
    assert.deepEqual(res, { ok: true, canceled: false, name: 'out.pdf' });
    assert.deepEqual(fs.readFileSync(path.join(s.dir, 'out.pdf')), Buffer.from('%PDF-1.4 fake'));
    assert.deepEqual(s.calls.dialog[0].filters, [{ name: 'PDF', extensions: ['pdf'] }]);
    assert.equal(fake.made.length, 1);
    assert.equal(fake.made[0].destroyed, true);
    assert.deepEqual(fs.readdirSync(s.tempDir), []);
    assert.deepEqual(fs.readdirSync(s.dir), ['out.pdf'], 'no temp file is left beside the result');
    const html = fake.made[0].html;
    // Inert, asked of a parser rather than a pattern (as the SVG test does; test/page-scripts.test.js refuses a tag pattern).
    const { JSDOM } = require('jsdom');
    const doc = new JSDOM(html).window.document;
    assert.equal(doc.querySelectorAll('script').length, 0);
    assert.equal(doc.querySelectorAll('[href]').length, 0);
    for (const el of doc.querySelectorAll('*')) {
      for (const a of el.getAttributeNames()) assert.ok(!/^on/i.test(a), `no event attribute (${a} on ${el.tagName})`);
    }
    assert.ok(html.includes('Session abcdef12'));
    assert.equal(fake.made[0].opts.pageSize, 'A4');
    assert.equal(fake.made[0].opts.printBackground, true);
  } finally { s.cleanup(); }
});

test('pdf: a cancelled dialog builds nothing and opens no window', async () => {
  const fake = fakeWindowFactory();
  const s = setupPdf(fake, { dialog: { showSaveDialog: async () => ({ canceled: true }) } });
  try {
    const res = await flowExport.exportFlow({ sessionId: 'abcdef123456', format: 'pdf' }, null);
    assert.deepEqual(res, { ok: false, canceled: true });
    assert.equal(fake.made.length, 0);
  } finally { s.cleanup(); }
});

test('pdf: a failed print answers a sentence without a path, writes nothing and still destroys the window', async () => {
  const fake = fakeWindowFactory({ print: async () => { throw new Error('boom ' + os.tmpdir()); } });
  const s = setupPdf(fake);
  try {
    const res = await flowExport.exportFlow({ sessionId: 'abcdef123456', format: 'pdf' }, null);
    assert.equal(res.ok, false);
    assert.equal(res.canceled, false);
    assert.ok(!JSON.stringify(res).includes(os.tmpdir()));
    assert.equal(fake.made[0].destroyed, true);
    assert.deepEqual(fs.readdirSync(s.dir), []);
    assert.deepEqual(fs.readdirSync(s.tempDir), []);
  } finally { s.cleanup(); }
});

test('pdf: a print that never ends is stopped at the timeout and the window is destroyed', async () => {
  const fake = fakeWindowFactory({ loadFile: () => new Promise(() => {}) });
  const s = setupPdf(fake, { pdfTimeoutMs: 40 });
  try {
    const res = await flowExport.exportFlow({ sessionId: 'abcdef123456', format: 'pdf' }, null);
    assert.equal(res.ok, false);
    assert.match(res.error, /too long/);
    assert.equal(fake.made[0].destroyed, true);
    assert.deepEqual(fs.readdirSync(s.tempDir), []);
  } finally { s.cleanup(); }
});

test('pdf: a second export while one runs is refused with a sentence; the gate opens again afterwards', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const fake = fakeWindowFactory({ loadFile: () => gate });
  const s = setupPdf(fake);
  try {
    const first = flowExport.exportFlow({ sessionId: 'abcdef123456', format: 'pdf' }, null);
    await new Promise((r) => setTimeout(r, 20));
    const second = await flowExport.exportFlow({ sessionId: 'abcdef123456', format: 'pdf' }, null);
    assert.equal(second.ok, false);
    assert.match(second.error, /still running/);
    // A text format is not held back by the running PDF.
    const svg = await flowExport.exportFlow({ sessionId: 'abcdef123456', format: 'svg' }, null);
    assert.equal(svg.ok, true);
    assert.ok(fs.existsSync(path.join(s.dir, 'out.svg')));
    release();
    assert.equal((await first).ok, true);
    const third = await flowExport.exportFlow({ sessionId: 'abcdef123456', format: 'pdf' }, null);
    assert.equal(third.ok, true);
  } finally { release(); s.cleanup(); }
});

test('pdf: the hidden window is built with a locked-down webPreferences and no preload', () => {
  const flowPdf = require('../src/app/flow-pdf');
  let seen = null;
  const wc = { openHandler: null, listeners: {}, setWindowOpenHandler(fn) { this.openHandler = fn; }, on(ev, fn) { this.listeners[ev] = fn; } };
  function FakeWindow(opts) { seen = opts; this.webContents = wc; }
  flowPdf.makeWindowFactory(FakeWindow)();
  assert.deepEqual(wc.openHandler({ url: 'https://example.invalid' }), { action: 'deny' });
  let prevented = false;
  wc.listeners['will-navigate']({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(seen.show, false);
  assert.deepEqual(seen.webPreferences, { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, webSecurity: true });
  assert.ok(!('preload' in seen.webPreferences));
});

test('pdf: destroyPending destroys a window still alive at quit', async () => {
  const flowPdf = require('../src/app/flow-pdf');
  let release;
  const fake = fakeWindowFactory({ loadFile: () => new Promise((r) => { release = r; }) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-pdf-q-'));
  try {
    const run = flowPdf.htmlToPdf('<p>x</p>', { createWindow: fake.create, tempDir: dir, timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(fs.readdirSync(dir).length, 1, 'the temp directory exists while the print runs');
    flowPdf.destroyPending();
    assert.equal(fake.made[0].destroyed, true);
    assert.deepEqual(fs.readdirSync(dir), [], 'destroyPending removes the temp directory synchronously');
    release();
    await run.catch(() => {});
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('no source file of the Flow export holds a raw control byte (the label filter is written with escapes)', () => {
  for (const f of ['flow-export.js', 'flow-pages.js', 'flow-pdf.js', 'flow-svg.js']) {
    const bytes = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', f));
    const bad = Array.from(bytes).filter(c => c < 9 || (c > 13 && c < 32) || c === 127);
    assert.equal(bad.length, 0, f);
  }
});

test('pdf: the print page is written with the exclusive flag into a directory of its own', () => {
  const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'flow-pdf.js'), 'utf8'));
  assert.match(src, /mkdtempSync\(/);
  assert.match(src, /flag: 'wx'/);
  assert.match(src, /rmSync\(entry\.dir/);
});

test('mermaid is a registered format: .mmd file, the same fresh read and label, plain text out', async () => {
  const s = setup({ pickedName: 'out.mmd' });
  try {
    assert.equal(flowExport.FORMATS.mermaid.ext, 'mmd');
    const res = await flowExport.exportFlow({ sessionId: 'abcdef123456', format: 'mermaid', backendLabel: 'Claude Code' }, { sender: { id: 3 } });
    assert.deepEqual(res, { ok: true, canceled: false, name: 'out.mmd' });
    assert.equal(s.calls.read.length, 1);
    assert.match(path.basename(s.calls.dialog[0].defaultPath), /^abcdef12-flow\.mmd$/);
    assert.deepEqual(s.calls.dialog[0].filters, [{ name: 'Mermaid', extensions: ['mmd'] }]);
    const text = fs.readFileSync(path.join(s.dir, 'out.mmd'), 'utf8');
    assert.ok(text.startsWith('%% Session abcdef12 · Claude Code'));
    assert.ok(text.includes('flowchart TD'));
    assert.ok(!text.includes('secret-session'));
  } finally { s.cleanup(); }
});
