'use strict';
// src/app/documents.js (#755): the registry of document paths a session's backend reported, and the narrow
// open that accepts nothing else.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const documents = require('../src/app/documents');
const { documentElement } = require('../src/backends/document-ref');

const SID = 'session-1';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-documents-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the OS will */ } });
  return dir;
}

// A tool_result entry the way a backend stamps it: the element rides in the result block's content array.
const resultEntry = (...els) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [...els, { type: 'text', text: 'x' }] }] } });
const docEntry = (p) => resultEntry(documentElement({ path: p, pages: 1 }));

// `settings` and `sensitive` are what main.js hands in; `sessions` maps a session id to its registry.
function setup({ settings = {}, sensitive = () => false, openResult = '' } = {}) {
  const sessions = new Map();
  const opened = [];
  const logged = [];
  documents.init({
    shell: { openPath: async (p) => { opened.push(p); return openResult; } },
    isSensitivePath: sensitive,
    registryFor: (id) => sessions.get(id) || null,
    getGlobalSettings: () => settings,
    log: { debug: (l) => logged.push(l) },
  });
  const registry = documents.createRegistry();
  sessions.set(SID, registry);
  return { registry, sessions, opened, logged };
}

test('the registry takes the path of a document element and nothing else', () => {
  const r = documents.createRegistry();
  r.note(docEntry('/a/b.pdf'));
  r.note(resultEntry({ type: 'text', text: 'no element' }));
  r.note({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
  r.note(null);
  assert.equal(r.size, 1);
  assert.ok(r.has('/a/b.pdf'));
  assert.ok(!r.has('/a/c.pdf'));
  r.noteAll([docEntry('/a/c.png'), docEntry('/a/d.md')]);
  assert.equal(r.size, 3);
  r.clear();
  assert.equal(r.size, 0);
});

test('a registry belongs to one session: a path noted in one is unknown to another', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'a.pdf');
  fs.writeFileSync(file, '%PDF-1.4');
  const { registry, sessions } = setup();
  const other = documents.createRegistry();
  sessions.set('session-2', other);
  registry.note(docEntry(file));
  assert.equal((await documents.openDocument('session-2', file, 'default')).ok, false);
  assert.equal((await documents.openDocument(SID, file, 'default')).ok, true);
  assert.equal((await documents.openDocument('nobody', file, 'default')).ok, false);
});

test('an unregistered path is refused even if it is a fine pdf', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'a.pdf');
  fs.writeFileSync(file, '%PDF-1.4');
  const { opened } = setup();
  const res = await documents.openDocument(SID, file, 'default');
  assert.equal(res.ok, false);
  assert.deepEqual(opened, []);
});

test('a registered local pdf reaches shell.openPath', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'a.pdf');
  fs.writeFileSync(file, '%PDF-1.4');
  const { registry, opened } = setup();
  registry.note(docEntry(file));
  const res = await documents.openDocument(SID, file, 'default');
  assert.deepEqual(res, { ok: true, action: 'default' });
  assert.equal(opened.length, 1);
  assert.equal(path.basename(opened[0]), 'a.pdf');
});

test('a network path is refused before any stat', async (t) => {
  const { registry, opened } = setup();
  const realStat = fs.promises.stat;
  let statted = 0;
  fs.promises.stat = (...a) => { statted++; return realStat(...a); };
  t.after(() => { fs.promises.stat = realStat; });
  for (const p of ['\\\\host\\share\\a.pdf', '//host/share/a.pdf']) {
    registry.note(docEntry(p));
    const res = await documents.openDocument(SID, p, 'default');
    assert.equal(res.ok, false, p);
  }
  assert.equal(statted, 0);
  assert.deepEqual(opened, []);
});

test('a relative path is refused', async () => {
  const { registry } = setup();
  registry.note(docEntry('docs/a.pdf'));
  assert.equal((await documents.openDocument(SID, 'docs/a.pdf', 'default')).ok, false);
});

test('a directory named like a document is refused', async (t) => {
  const dir = tmp(t);
  const sub = path.join(dir, 'folder.pdf');
  fs.mkdirSync(sub);
  const { registry, opened } = setup();
  registry.note(docEntry(sub));
  const res = await documents.openDocument(SID, sub, 'default');
  assert.equal(res.ok, false);
  assert.deepEqual(opened, []);
});

test('a missing file is refused with a worded error, not the raw one', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'gone.pdf');
  const { registry } = setup();
  registry.note(docEntry(file));
  const res = await documents.openDocument(SID, file, 'default');
  assert.equal(res.ok, false);
  assert.ok(!res.error.includes(dir), 'the error names no path');
});

test('an extension outside the document kinds is refused even when registered', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'tool.exe');
  fs.writeFileSync(file, 'MZ');
  const { registry, opened } = setup();
  // A backend would not stamp one (documentElement answers null), so put the path in by hand.
  registry.note({ message: { content: [{ type: 'document', path: file, kind: 'pdf', name: 'tool.exe', pages: 0 }] } });
  assert.ok(registry.has(file));
  const res = await documents.openDocument(SID, file, 'default');
  assert.equal(res.ok, false);
  assert.deepEqual(opened, []);
});

// Verifier G2: an NTFS alternate data stream of an executable reads as a pdf to every extension check.
test('a path naming an alternate data stream is refused before any stat', async () => {
  const { registry, opened } = setup();
  const p = process.platform === 'win32' ? 'C:\\work\\tool.exe:x.pdf' : '/work/tool.exe:x.pdf';
  registry.note({ message: { content: [{ type: 'document', path: p, kind: 'pdf', name: 'x.pdf', pages: 0 }] } });
  const res = await documents.openDocument(SID, p, 'default');
  assert.equal(res.ok, false);
  assert.deepEqual(opened, []);
});

test('a sensitive path is refused', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'a.pdf');
  fs.writeFileSync(file, '%PDF-1.4');
  const { registry, opened } = setup({ sensitive: (p) => p.startsWith(dir) });
  registry.note(docEntry(file));
  const res = await documents.openDocument(SID, file, 'default');
  assert.equal(res.ok, false);
  assert.deepEqual(opened, []);
});

test('a link named like a pdf that leads to another kind of file is refused', async (t) => {
  const dir = tmp(t);
  const target = path.join(dir, 'secret.txt');
  const link = path.join(dir, 'a.pdf');
  fs.writeFileSync(target, 'x');
  try { fs.symlinkSync(target, link); } catch (err) { t.skip(`no symlinks here (${err.code})`); return; }
  const { registry, opened } = setup();
  registry.note(docEntry(link));
  const res = await documents.openDocument(SID, link, 'default');
  assert.equal(res.ok, false);
  assert.deepEqual(opened, []);
});

test('a link whose target is a sensitive path is refused', async (t) => {
  const dir = tmp(t);
  const hidden = path.join(dir, 'private');
  fs.mkdirSync(hidden);
  const target = path.join(hidden, 'b.pdf');
  const link = path.join(dir, 'a.pdf');
  fs.writeFileSync(target, '%PDF-1.4');
  try { fs.symlinkSync(target, link); } catch (err) { t.skip(`no symlinks here (${err.code})`); return; }
  const { registry, opened } = setup({ sensitive: (p) => p.includes(`${path.sep}private${path.sep}`) });
  registry.note(docEntry(link));
  const res = await documents.openDocument(SID, link, 'default');
  assert.equal(res.ok, false);
  assert.deepEqual(opened, []);
});

test('shell.openPath failing is worded, and the raw text goes to the log', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'a.pdf');
  fs.writeFileSync(file, '%PDF-1.4');
  const { registry, logged } = setup({ openResult: 'raw failure text' });
  registry.note(docEntry(file));
  const res = await documents.openDocument(SID, file, 'default');
  assert.equal(res.ok, false);
  assert.ok(!res.error.includes('raw failure text'));
  assert.ok(logged.some((l) => l.includes('raw failure text')));
});

test('an unknown `how` is refused', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'a.pdf');
  fs.writeFileSync(file, '%PDF-1.4');
  const { registry, opened } = setup();
  registry.note(docEntry(file));
  assert.equal((await documents.openDocument(SID, file, 'anything')).ok, false);
  assert.deepEqual(opened, []);
});

test("how 'tab' answers ok for the renderer's own file view and opens nothing", async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'a.pdf');
  fs.writeFileSync(file, '%PDF-1.4');
  const { registry, opened } = setup();
  registry.note(docEntry(file));
  assert.deepEqual(await documents.openDocument(SID, file, 'tab'), { ok: true, action: 'tab', path: file });
  assert.deepEqual(opened, []);
});

test("how 'click' follows fileClickTarget: internal is the tab, Ctrl/Cmd flips it", async (t) => {
  const dir = tmp(t);
  const pdf = path.join(dir, 'a.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4');
  const { registry, opened } = setup({ settings: { fileClickTarget: 'internal' } });
  registry.note(docEntry(pdf));
  assert.equal((await documents.openDocument(SID, pdf, 'click', false)).action, 'tab');
  assert.deepEqual(opened, []);
  // inverted: external, and a pdf goes to the default app
  assert.equal((await documents.openDocument(SID, pdf, 'click', true)).action, 'default');
  assert.equal(opened.length, 1);
});

test("how 'click' with external: pdf, image and html go to the default app, markdown to the editor", async (t) => {
  const dir = tmp(t);
  const names = ['a.pdf', 'b.png', 'c.html', 'd.md'];
  const { registry, opened } = setup({ settings: { fileClickTarget: 'external' } });
  for (const n of names) {
    fs.writeFileSync(path.join(dir, n), 'x');
    registry.note(docEntry(path.join(dir, n)));
  }
  for (const n of ['a.pdf', 'b.png', 'c.html']) {
    const res = await documents.openDocument(SID, path.join(dir, n), 'click', false);
    assert.equal(res.action, 'default', n);
  }
  assert.equal(opened.length, 3);
  const md = await documents.openDocument(SID, path.join(dir, 'd.md'), 'click', false);
  assert.deepEqual(md, { ok: true, action: 'editor', path: path.join(dir, 'd.md') });
  assert.equal(opened.length, 3, 'markdown is left to the editor, not the default app');
  // inverted under external means internal
  assert.equal((await documents.openDocument(SID, path.join(dir, 'a.pdf'), 'click', true)).action, 'tab');
});

test('registerIpc binds one channel and passes its arguments through', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'a.pdf');
  fs.writeFileSync(file, '%PDF-1.4');
  const { registry } = setup();
  registry.note(docEntry(file));
  const handlers = new Map();
  documents.registerIpc({ handle: (ch, fn) => handlers.set(ch, fn) });
  assert.deepEqual([...handlers.keys()], ['document-open']);
  const res = await handlers.get('document-open')({}, SID, file, 'tab');
  assert.equal(res.action, 'tab');
});
