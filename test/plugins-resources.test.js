'use strict';
// #823 T3 — the Agents, Commands and Rules views (spec 40, spec 44), in jsdom.
//
// `window.api` is a stub that records every call. Pinned: the lazy read, the rows and the CLI chips from what main
// serves, the decline line, the editor's door (read and save by id with the view named, a conflict keeps the user's
// text), New only where main offers a place, Delete only on a deletable row and only after a confirmation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const REN = path.join(__dirname, '..', 'src', 'renderer');
const tick = () => new Promise(r => setTimeout(r, 0));

function setup(api, { confirm = true } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body><section class="settings-cat"><div id="host"></div></section></body></html>',
    { url: 'http://localhost/', runScripts: 'outside-only' });
  const ctx = dom.getInternalVMContext();
  for (const rel of ['panels/plugins-kit.js', 'panels/plugins-views.js', 'panels/plugins-resources.js']) {
    vm.runInContext(fs.readFileSync(path.join(REN, rel), 'utf8'), ctx, { filename: rel });
  }
  const calls = [];
  dom.window.api = new Proxy(api, {
    get(t, p) { return (...args) => { calls.push([p, ...args]); return Promise.resolve(t[p] ? t[p](...args) : null); }; },
  });
  const dialogs = [];
  dom.window.showControlDialog = async (o) => { dialogs.push(o); return confirm; };
  return { dom, window: dom.window, res: dom.window.pluginsResources, host: dom.window.document.getElementById('host'), calls, dialogs };
}

function fakeEditor() {
  const made = [];
  const factory = async (parent, text, hint, readOnly) => {
    let value = text;
    const ed = { hint, readOnly: !!readOnly, getText: () => value, setText: (t) => { value = t; }, onSave() {}, destroy() {}, type: (t) => { value = t; } };
    made.push(ed);
    return ed;
  };
  return { factory, made };
}

const CLAUDE = { key: 'c', label: 'Claude' };
const PI = { key: 'p', label: 'Pi' };
const row = (over) => ({ id: 'a1', name: 'review', kind: 'command', scope: 'global', sourceLabel: 'Claude commands', originLabel: 'Claude commands',
  cli: CLAUDE, clis: [CLAUDE], editable: true, deletable: true, fromPlugin: false, creatable: true, ...over });
const names = (host) => [...host.querySelectorAll('.plugins-row-name')].map(n => n.textContent);
const btn = (root, label) => [...root.querySelectorAll('button')].find(b => b.textContent === label);
const open = (host, i) => { host.querySelectorAll('.plugins-row-open')[i].click(); return host.querySelector('.plugins-detail'); };

test('the three views name their view to main, list rows, chips and the decline line', async () => {
  const asked = [];
  const { dom, res, host } = setup({
    getResourceInventory: (view, pp) => { asked.push([view, pp]); return { ok: true, rows: [row({ id: 'x1', name: 'one' }), row({ id: 'x2', name: 'two', cli: PI, clis: [PI] })],
      declines: [{ cli: { key: 'h', label: 'Hermes' }, sentence: 'Hermes keeps no agents here.' }] }; },
    getResourcePlaces: () => ({ ok: true, places: [] }),
  });
  try {
    assert.deepEqual(Object.keys(res.VIEWS), ['agents', 'commands', 'rules']);
    await res.mountResourceView('agents')(host, { projectPath: null });
    assert.deepEqual(asked, [['agents', null]]);
    assert.deepEqual(names(host), ['one', 'two']);
    assert.equal(host.querySelectorAll('.plugins-chip-row button').length, 2, 'one chip per CLI');
    assert.match(host.querySelector('.plugins-declines').textContent, /Hermes keeps no agents here\./);
    await tick();
    assert.equal(btn(host, 'New agent'), undefined, 'no place to create in: no New');
    assert.match(host.querySelector('.plugins-filter').getAttribute('placeholder') || '', /agents/);
  } finally { dom.window.close(); }
});

test('an unreadable inventory says so and mounts nothing', async () => {
  const { dom, res, host } = setup({ getResourceInventory: () => ({ ok: false, reason: 'x' }) });
  try {
    const out = await res.mountResourceView('rules')(host, { projectPath: null });
    assert.equal(out, null);
    assert.match(host.textContent, /rules could not be read/);
  } finally { dom.window.close(); }
});

test('New appears when main offers a place, creates by view and opens the new page', async () => {
  let created = null;
  let rows = [];
  const { dom, res, host, calls } = setup({
    getResourceInventory: () => ({ ok: true, rows, declines: [] }),
    getResourcePlaces: () => ({ ok: true, places: [{ id: 'pl1', label: 'Claude, global commands', scope: 'global', kind: 'command' }] }),
    createResourceItem: (view, place, name) => { created = [view, place, name]; rows = [row({ id: 'n1', name })]; return { ok: true, id: 'n1' }; },
    readResourceItem: () => ({ ok: true, content: 'hello' }),
  });
  const ed = fakeEditor();
  try {
    await res.mountResourceView('commands')(host, { projectPath: null, createEditor: ed.factory });
    await tick();
    const doc = host.ownerDocument;
    btn(host, 'New command').click();
    await tick();
    const form = doc.querySelector('.plugins-new-skill');
    assert.ok(form, 'the form opens');
    form.querySelector('input').value = 'fresh';
    btn(form, 'Create').click();
    await tick(); await tick(); await tick();
    assert.deepEqual(created, ['commands', 'pl1', 'fresh']);
    assert.ok(calls.some(c => c[0] === 'readResourceItem' && c[1] === 'n1' && c[3] === 'commands'), 'the new page reads by id, naming the view');
    assert.equal(ed.made.length, 1);
  } finally { dom.window.close(); }
});

test('the editor saves by id with the view; a conflict keeps the text and writes nothing', async () => {
  const saves = [];
  const { dom, res, host } = setup({
    getResourceInventory: () => ({ ok: true, rows: [row({ id: 'e1', name: 'lint' })], declines: [] }),
    getResourcePlaces: () => ({ ok: true, places: [] }),
    readResourceItem: () => ({ ok: true, content: 'one' }),
    saveResourceItem: (id, pp, text, baseline, view) => {
      saves.push([id, pp, text, baseline, view]);
      return saves.length === 1 ? { ok: false, conflict: true, diskContent: 'two' } : { ok: true, content: text };
    },
  });
  const ed = fakeEditor();
  try {
    await res.mountResourceView('commands')(host, { projectPath: '/p', createEditor: ed.factory });
    const detail = open(host, 0);
    await tick(); await tick();
    ed.made[0].type('mine');
    btn(detail, 'Save').click();
    await tick(); await tick();
    assert.deepEqual(saves[0], ['e1', '/p', 'mine', 'one', 'commands']);
    assert.match(detail.textContent, /The version on disk now/);
    assert.equal(ed.made[0].getText(), 'mine', 'the text is kept');
    btn(detail, 'Save mine over it').click();
    await tick(); await tick();
    assert.equal(saves[1][3], 'two', 'the disk text is now the baseline');
    assert.match(detail.textContent, /Saved\./);
  } finally { dom.window.close(); }
});

test('unsaved text refuses to leave the page (the kit asks the view)', async () => {
  const { dom, res, host } = setup({
    getResourceInventory: () => ({ ok: true, rows: [row({ id: 'e1' })], declines: [] }),
    getResourcePlaces: () => ({ ok: true, places: [] }),
    readResourceItem: () => ({ ok: true, content: 'one' }),
  });
  const ed = fakeEditor();
  try {
    const view = await res.mountResourceView('rules')(host, { projectPath: null, createEditor: ed.factory });
    open(host, 0);
    await tick(); await tick();
    assert.equal(view.canLeave(), true);
    ed.made[0].type('changed');
    assert.equal(view.canLeave(), false);
    assert.equal(view.showList({ focus: false }), false);
  } finally { dom.window.close(); }
});

test('Delete shows only on a deletable row, asks first, and removes the row', async () => {
  let rows = [row({ id: 'd1', name: 'gone' }), row({ id: 'k1', name: 'kept', deletable: false, fromPlugin: true, editable: false })];
  const deleted = [];
  const { dom, res, host, dialogs } = setup({
    getResourceInventory: () => ({ ok: true, rows, declines: [] }),
    getResourcePlaces: () => ({ ok: true, places: [] }),
    readResourceItem: () => ({ ok: true, content: 'x' }),
    deleteResourceItem: (id, pp, view) => { deleted.push([id, pp, view]); rows = rows.filter(r => r.id !== id); return { ok: true }; },
  });
  const ed = fakeEditor();
  try {
    let counted = null;
    const view = await res.mountResourceView('commands')(host, { projectPath: null, createEditor: ed.factory, onCount: (n) => { counted = n; } });
    const plug = open(host, 1);
    assert.equal(btn(plug, 'Delete command'), undefined, 'a plugin item is not deletable');
    assert.match(plug.textContent, /came with a plugin/);
    view.showList({ focus: false });
    const detail = open(host, 0);
    btn(detail, 'Delete command').click();
    await tick(); await tick(); await tick();
    assert.equal(dialogs.length, 1, 'confirmation first');
    assert.deepEqual(deleted, [['d1', null, 'commands']]);
    assert.deepEqual(names(host), ['kept']);
    assert.equal(counted, 1);
  } finally { dom.window.close(); }
});

test('a declined confirmation deletes nothing', async () => {
  const deleted = [];
  const { dom, res, host } = setup({
    getResourceInventory: () => ({ ok: true, rows: [row({ id: 'd1' })], declines: [] }),
    getResourcePlaces: () => ({ ok: true, places: [] }),
    readResourceItem: () => ({ ok: true, content: 'x' }),
    deleteResourceItem: (id) => { deleted.push(id); return { ok: true }; },
  }, { confirm: false });
  const ed = fakeEditor();
  try {
    await res.mountResourceView('agents')(host, { projectPath: null, createEditor: ed.factory });
    const detail = open(host, 0);
    btn(detail, 'Delete agent').click();
    await tick(); await tick();
    assert.deepEqual(deleted, []);
  } finally { dom.window.close(); }
});

test('a non-editable row shows its text read-only, with no Save, and the editor gets the extension of the row', async () => {
  const { dom, res, host } = setup({
    getResourceInventory: () => ({ ok: true, rows: [row({ id: 'h1', name: 'hook', ext: '.toml', editable: false, deletable: false })], declines: [] }),
    getResourcePlaces: () => ({ ok: true, places: [] }),
    readResourceItem: () => ({ ok: true, content: 'body' }),
  });
  const ed = fakeEditor();
  try {
    await res.mountResourceView('rules')(host, { projectPath: null, createEditor: ed.factory });
    const detail = open(host, 0);
    await tick(); await tick();
    assert.equal(btn(detail, 'Save'), undefined);
    assert.equal(btn(detail, 'Discard'), undefined);
    assert.match(detail.textContent, /read-only here/);
    assert.equal(ed.made.length, 1);
    assert.equal(ed.made[0].readOnly, true);
    assert.equal(ed.made[0].getText(), 'body');
    assert.equal(ed.made[0].hint, 'item.toml', 'the extension main sent, not a fixed name');
  } finally { dom.window.close(); }
});

test('a late New probe does not bring back a deleted row', async () => {
  let rows = [row({ id: 'd1', name: 'gone' }), row({ id: 'k1', name: 'kept' })];
  let releaseProbe = null;
  const { dom, res, host } = setup({
    getResourceInventory: () => ({ ok: true, rows, declines: [] }),
    getResourcePlaces: () => new Promise((r) => { releaseProbe = () => r({ ok: true, places: [{ id: 'p', label: 'L', scope: 'global', kind: 'command' }] }); }),
    readResourceItem: () => ({ ok: true, content: 'x' }),
    deleteResourceItem: (id) => { rows = rows.filter(r => r.id !== id); return { ok: true }; },
  });
  const ed = fakeEditor();
  try {
    await res.mountResourceView('commands')(host, { projectPath: null, createEditor: ed.factory });
    const detail = open(host, 0);
    btn(detail, 'Delete command').click();
    await tick(); await tick(); await tick();
    assert.deepEqual(names(host), ['kept']);
    releaseProbe();
    await tick(); await tick();
    assert.deepEqual(names(host), ['kept'], 'the probe redraws from the current rows');
    assert.ok(btn(host, 'New command'), 'and still offers New');
  } finally { dom.window.close(); }
});
