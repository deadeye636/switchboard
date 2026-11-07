'use strict';
// #823 T6 — the Instructions category (spec 44, plan P1 and P9), in jsdom. `window.api` is a recording stub.
// Pinned: its own nav item and section, the scope each window asks for, the sections by name, the editor's door, no
// New and no Delete, the content filter's door, the declines line, the pointer to the other scope.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const REN = path.join(__dirname, '..', 'src', 'renderer');
const tick = () => new Promise(r => setTimeout(r, 0));

function setup(api) {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="body"></div></body></html>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const ctx = dom.getInternalVMContext();
  for (const rel of ['panels/plugins-kit.js', 'panels/plugins-views.js', 'panels/settings-instructions.js']) {
    vm.runInContext(fs.readFileSync(path.join(REN, rel), 'utf8'), ctx, { filename: rel });
  }
  const calls = [];
  dom.window.api = new Proxy(api, {
    get(t, p) { return (...args) => { calls.push([p, ...args]); return Promise.resolve(t[p] ? t[p](...args) : null); }; },
  });
  dom.window.showControlDialog = async () => true;
  const body = dom.window.document.getElementById('body');
  return { dom, si: dom.window.settingsInstructions, body, calls };
}

const CLAUDE = { key: 'c', label: 'Claude' };
const row = (over) => ({ id: 'i1', name: 'CLAUDE.md', kind: 'instructions', section: 'Instructions', scope: 'global', ext: '.md',
  cli: CLAUDE, clis: [CLAUDE], sourceLabel: 'Claude', editable: true, ...over });
const btn = (root, label) => [...root.querySelectorAll('button')].find(b => b.textContent === label);
const fakeEditor = () => {
  const made = [];
  return { made, factory: async (parent, text, hint, readOnly) => {
    const ed = { hint, readOnly: !!readOnly, getText: () => text, setText() {}, onSave() {}, destroy() {} };
    made.push(ed);
    return ed;
  } };
};

test('its own nav item and section, outside the Plugins group', () => {
  const { dom, si } = setup({});
  try {
    assert.match(si.navHtml(), /data-cat="instructions" data-count-own="1"/);
    assert.match(si.sectionHtml('global'), /data-cat="instructions"/);
    assert.match(si.sectionHtml('project'), /for this project/);
  } finally { dom.window.close(); }
});

test('nothing is read at bind; the first settings-cat-shown reads the scope of the window, in sections', async () => {
  const asked = [];
  const { dom, si, body } = setup({
    getInstructionInventory: (scope) => {
      asked.push(scope);
      return { ok: true, rows: [row(), row({ id: 'm1', name: 'notes.md', section: 'Memory', kind: 'memory' })],
        declines: [{ cli: CLAUDE, sentence: 'Hermes keeps no instructions here.' }] };
    },
  });
  try {
    body.innerHTML = si.sectionHtml('project');
    const counts = [];
    si.bind(body, new dom.window.AbortController().signal, { scope: 'project', projectPath: '/p/one', setCount: (c, n) => counts.push([c, n]), mayLeave: () => true });
    await tick();
    assert.deepEqual(asked, [], 'no read at bind');
    body.querySelector('.settings-cat').dispatchEvent(new dom.window.CustomEvent('settings-cat-shown'));
    await tick(); await tick();
    assert.deepEqual(asked, ['/p/one']);
    const text = body.textContent;
    assert.ok(text.indexOf('Memory') > text.indexOf('CLAUDE.md'), 'Instructions section before Memory');
    assert.match(body.querySelector('.plugins-declines').textContent, /Hermes keeps no instructions here\./);
    assert.deepEqual(counts[counts.length - 1], ['instructions', 2]);
    assert.equal(btn(body, 'New file'), undefined, 'no New');
  } finally { dom.window.close(); }
});

test('the global window asks for the global scope; the filter matches content through its own door', async () => {
  const matched = [];
  const { dom, si, body, calls } = setup({
    getInstructionInventory: () => ({ ok: true, rows: [row({ id: 'a', name: 'one.md' }), row({ id: 'b', name: 'two.md' })], declines: [] }),
    matchInstructionContent: (scope, q) => { matched.push([scope, q]); return { ok: true, ids: ['b'] }; },
  });
  try {
    await si.mountInstructions(body, { projectPath: null });
    assert.deepEqual(calls[0], ['getInstructionInventory', 'global']);
    const filter = body.querySelector('.plugins-filter');
    filter.value = 'zzz';
    filter.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    assert.deepEqual(matched, [['global', 'zzz']]);
    assert.deepEqual([...body.querySelectorAll('.plugins-row-name')].map(n => n.textContent), ['two.md']);
  } finally { dom.window.close(); }
});

test('an editable row opens the editor (save by id and scope, main\'s verdict shown); a read-only row opens a viewer', async () => {
  const saves = [];
  const { dom, si, body } = setup({
    getInstructionInventory: () => ({ ok: true, declines: [], rows: [
      row({ id: 'a', name: 'one.md' }), row({ id: 'r', name: 'built-in.txt', editable: false, ext: '.txt', section: 'Resources' })] }),
    readInstruction: () => ({ ok: true, content: 'hello' }),
    saveInstruction: (id, scope, text, baseline) => { saves.push([id, scope, text, baseline]); return { ok: false, reason: 'Not valid JSON' }; },
  });
  const ed = fakeEditor();
  try {
    await si.mountInstructions(body, { projectPath: '/p/one', createEditor: ed.factory });
    body.querySelectorAll('.plugins-row-open')[0].click();
    await tick(); await tick();
    assert.equal(ed.made.length, 1);
    assert.equal(ed.made[0].readOnly, false);
    assert.equal(ed.made[0].hint, 'item.md');
    btn(body, 'Save').click();
    await tick();
    assert.deepEqual(saves, [['a', '/p/one', 'hello', 'hello']]);
    assert.match(body.textContent, /Not valid JSON/);
    assert.equal(btn(body, 'Delete file'), undefined, 'no Delete');
  } finally { dom.window.close(); }
});

test('a read-only row opens a read-only viewer', async () => {
  const { dom, si, body } = setup({
    getInstructionInventory: () => ({ ok: true, declines: [], rows: [row({ id: 'r', name: 'built-in.txt', editable: false, ext: '.txt' })] }),
    readInstruction: () => ({ ok: true, content: 'text' }),
  });
  const ed = fakeEditor();
  try {
    await si.mountInstructions(body, { projectPath: null, createEditor: ed.factory });
    body.querySelector('.plugins-row-open').click();
    await tick(); await tick();
    assert.equal(ed.made.length, 1);
    assert.equal(ed.made[0].readOnly, true);
    assert.equal(btn(body, 'Save'), undefined);
  } finally { dom.window.close(); }
});

test('the pointer: a project window opens the global list, and unsaved text stops the switch', async () => {
  const opened = [];
  const { dom, si, body } = setup({ openSettingsWindow: (...a) => { opened.push(a); } });
  try {
    body.innerHTML = si.sectionHtml('project');
    si.bind(body, new dom.window.AbortController().signal, { scope: 'project', projectPath: '/p/one', setCount() {}, mayLeave: () => true });
    btn(body, 'Open the global instructions').click();
    await tick();
    assert.deepEqual(JSON.parse(JSON.stringify(opened)), [['global', null, { cat: 'instructions' }]]);
    let refused = 0;
    body.innerHTML = si.sectionHtml('project');
    si.bind(body, new dom.window.AbortController().signal, { scope: 'project', projectPath: '/p/one', setCount() {}, mayLeave: () => { refused++; return false; } });
    btn(body, 'Open the global instructions').click();
    await tick();
    assert.equal(refused, 1);
    assert.equal(opened.length, 1);
  } finally { dom.window.close(); }
});

test('the global window\'s picker: no project says so and opens nothing; a chosen project is named in the dialog and opened', async () => {
  const opened = [];
  const dialogs = [];
  const { dom, si, body } = setup({
    openSettingsWindow: (...a) => { opened.push(a); },
    getProjectsAdmin: () => ({ ok: true, projects: [{ projectPath: '/p/one', displayName: 'One', registered: true }] }),
    getInstructionInventory: () => ({ ok: true, rows: [], declines: [] }),
  });
  dom.window.showControlDialog = async (o) => { dialogs.push(o); return true; };
  const ext = { fillPicker(picker, button, projects) {
    picker.textContent = '';
    for (const p of Array.isArray(projects) ? projects : []) { const o = dom.window.document.createElement('option'); o.value = p.path; o.textContent = p.label; picker.appendChild(o); }
  }, pickableProjects: (res) => res.projects.map(r => ({ path: r.projectPath, label: r.displayName })) };
  dom.window.settingsExternalMcp = ext;
  try {
    body.innerHTML = si.sectionHtml('global');
    si.bind(body, new dom.window.AbortController().signal, { scope: 'global', projectPath: null, setCount() {}, mayLeave: () => true });
    btn(body, 'Open its instructions').click();
    await tick();
    assert.match(body.textContent, /Choose a project first\./);
    assert.deepEqual(opened, []);
    body.querySelector('.settings-cat').dispatchEvent(new dom.window.CustomEvent('settings-cat-shown'));
    await tick(); await tick();
    const picker = body.querySelector('select');
    picker.value = '/p/one';
    btn(body, 'Open its instructions').click();
    await tick();
    assert.deepEqual(JSON.parse(JSON.stringify(dialogs[0].details)), { Project: 'One' });
    assert.deepEqual(JSON.parse(JSON.stringify(opened)), [['project', '/p/one', { cat: 'instructions' }]]);
  } finally { dom.window.close(); }
});

test('work files (T10): header with n of total, open shows text, delete asks, cancel keeps, confirm deletes and refreshes', async () => {
  let rows = [{ id: 'w1', name: 'a.txt', relativePath: 'a.txt', size: 3 }, { id: 'w2', name: 'b.txt', relativePath: 'sub/b.txt', size: 3 }];
  let total = 5;
  const { dom, si, body, calls } = setup({
    getInstructionInventory: () => ({ ok: true, rows: [], declines: [] }),
    getInstructionWorkFiles: () => ({ ok: true, rows, total }),
    readInstructionWorkFile: (id) => ({ ok: true, content: 'text of ' + id }),
    deleteInstructionWorkFile: (id) => { rows = rows.filter(r => r.id !== id); total -= 1; return { ok: true }; },
  });
  try {
    assert.doesNotMatch(si.sectionHtml('global'), /sv-instr-workfiles/, 'no section in the global window');
    body.innerHTML = si.sectionHtml('project');
    si.bind(body, new dom.window.AbortController().signal, { scope: 'project', projectPath: '/p/one', setCount() {}, mayLeave: () => true });
    body.querySelector('.settings-cat').dispatchEvent(new dom.window.CustomEvent('settings-cat-shown'));
    await tick(); await tick();
    const box = body.querySelector('.sv-instr-workfiles');
    assert.match(box.querySelector('h3').textContent, /Work files \(2 of 5\)/);
    assert.equal(box.querySelectorAll('.sv-instr-workfile').length, 2);
    // Open
    btn(box.querySelectorAll('.sv-instr-workfile')[1], 'Open').click();
    await tick();
    assert.equal(box.querySelector('pre').textContent, 'text of w2');
    assert.deepEqual(calls.find(c => c[0] === 'readInstructionWorkFile'), ['readInstructionWorkFile', 'w2', '/p/one']);
    // Delete: cancel keeps
    let asked = 0; let answer = false;
    dom.window.showControlDialog = async () => { asked += 1; return answer; };
    btn(box.querySelector('.sv-instr-workfile'), 'Delete').click();
    await tick(); await tick();
    assert.equal(asked, 1);
    assert.ok(!calls.some(c => c[0] === 'deleteInstructionWorkFile'), 'cancel deletes nothing');
    // Delete: confirm deletes and refreshes
    answer = true;
    btn(box.querySelector('.sv-instr-workfile'), 'Delete').click();
    await tick(); await tick(); await tick();
    assert.deepEqual(calls.find(c => c[0] === 'deleteInstructionWorkFile'), ['deleteInstructionWorkFile', 'w1', '/p/one']);
    assert.equal(box.querySelectorAll('.sv-instr-workfile').length, 1, 'the list is read again');
    assert.match(box.querySelector('h3').textContent, /Work files \(1 of 4\)/);
  } finally { dom.window.close(); }
});
