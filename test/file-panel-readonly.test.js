'use strict';
// #823 T8 — a file opened READ-ONLY in the preview panel (the session sidebar's Instructions group, spec 43/44): no Save,
// an Edit button only for a file that has somewhere to go, and a reopen of the same path in the other mode re-targets.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupFilePanelDom } = require('./helpers/file-panel-dom');

const FILE = '/srv/projects/api/settings.json';

const json = (v) => JSON.parse(JSON.stringify(v));

// A stand-in for the CodeMirror bundle (jsdom loads none): it records how the editor was built and what it was told
// to do about editing afterwards.
function stubEditor(h) {
  const made = [];
  h.window.CMEditorView = { lineWrapping: {} };
  h.window.createEditableViewer = (parent, content, filename, opts) => {
    const el = h.document.createElement('div');
    parent.appendChild(el);
    const view = {
      dom: el, state: { doc: { length: 0 } }, made: opts, reconfigured: [],
      dispatch(tr) { for (const e of [].concat((tr && tr.effects) || [])) this.reconfigured.push(e); },
      destroy() { el.remove(); },
      focus() {}, _wrapCompartment: { reconfigure: () => ({}) },
      _readOnlyCompartment: { reconfigure: (x) => x }, _readOnlyExtensions: (on) => (on ? 'read-only' : 'editable'),
    };
    made.push(view);
    return view;
  };
  return made;
}

async function opened(h, options) {
  if (!h.made) h.made = stubEditor(h);
  h.init();
  h.switchPanel('s1');
  h.files.set(FILE, '# rules\n');
  await h.openFileInPanel('s1', FILE, options);
  await h.settle();
}
const editBtn = (h) => h.qa('.fp-viewer .viewer-toolbar-controls button').find((b) => b.textContent === 'Edit');
const saveBtn = (h) => h.q('.fp-viewer .fp-save-btn, .fp-viewer [title^="Save"]');

test('a read-only open hides Save, and the viewer is told so', async () => {
  const h = setupFilePanelDom();
  try {
    await opened(h, { readOnly: true });
    assert.deepEqual(json(h.calls.viewerOptions), [{ readOnly: true }]);
    const save = saveBtn(h);
    if (save) assert.equal(save.style.display, 'none');
    assert.equal(editBtn(h).style.display, 'none', 'no Edit link without editInSettings');
  } finally { h.destroy(); }
});

test('typing stops too: the editor is built read-only and reconfigured to the mode of each open', async () => {
  const h = setupFilePanelDom();
  try {
    await opened(h, { readOnly: true });
    const made = h.made;
    assert.equal(made[0].made.readOnly, true);
    assert.ok(made[0].reconfigured.includes('read-only'));
    await h.openFileInPanel('s1', FILE);
    await h.settle();
    assert.equal(made.at(-1).made.readOnly, false);
    assert.ok(made.at(-1).reconfigured.includes('editable'));
  } finally { h.destroy(); }
});

test('an ordinary open passes no mode, so the file itself decides (the probe is kept)', async () => {
  const h = setupFilePanelDom();
  try {
    await opened(h);
    assert.deepEqual(json(h.calls.viewerOptions), [{}]);
  } finally { h.destroy(); }
});

test('Edit is shown with editInSettings, asks main which file this is, then opens Settings on it', async () => {
  const h = setupFilePanelDom();
  try {
    const asked = [];
    const opens = [];
    h.window.api.locateInstruction = (p, project) => { asked.push([p, project]); return Promise.resolve({ id: 'abcdef0123456789', scope: 'project', projectPath: '/srv/projects/api' }); };
    h.window.api.openSettingsWindow = (...a) => { opens.push(a); };
    await opened(h, { readOnly: true, editInSettings: { projectPath: '/srv/projects/api' } });
    const btn = editBtn(h);
    assert.notEqual(btn.style.display, 'none');
    btn.click();
    await h.settle();
    assert.deepEqual(json(asked), [[FILE, '/srv/projects/api']]);
    assert.deepEqual(json(opens), [['project', '/srv/projects/api', { cat: 'instructions', item: 'abcdef0123456789' }]]);
  } finally { h.destroy(); }
});

test('a global file opens the global Settings window, and a path main does not list says so', async () => {
  const h = setupFilePanelDom();
  try {
    const opens = [];
    let answer = { id: '0123456789abcdef', scope: 'global', projectPath: null };
    h.window.api.locateInstruction = () => Promise.resolve(answer);
    h.window.api.openSettingsWindow = (...a) => { opens.push(a); };
    await opened(h, { readOnly: true, editInSettings: { projectPath: null } });
    editBtn(h).click();
    await h.settle();
    assert.deepEqual(json(opens), [['global', null, { cat: 'instructions', item: '0123456789abcdef' }]]);
    answer = null;
    editBtn(h).click();
    await h.settle();
    assert.equal(opens.length, 1, 'no navigation without an answer');
    assert.match(h.calls.toasts.at(-1).message, /not listed/);
  } finally { h.destroy(); }
});

test('reopening the same path in the other mode re-targets the viewer, both ways', async () => {
  const h = setupFilePanelDom();
  try {
    await opened(h, { readOnly: true });
    await h.openFileInPanel('s1', FILE);
    await h.settle();
    await h.openFileInPanel('s1', FILE, { readOnly: true });
    await h.settle();
    assert.deepEqual(json(h.calls.viewerOptions), [{ readOnly: true }, {}, { readOnly: true }]);
  } finally { h.destroy(); }
});

test('a plain re-render of the same tab does not reopen it (edits survive, #458)', async () => {
  const h = setupFilePanelDom();
  try {
    await opened(h, { readOnly: true });
    h.switchPanel('s1');
    h.switchPanel('s1');
    await h.settle();
    assert.equal(h.calls.viewerOpens.length, 1);
  } finally { h.destroy(); }
});
