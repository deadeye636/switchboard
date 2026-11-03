'use strict';
// #803 T9 — the Plugins, Apps and Skills views over the list kit (spec 40 D1, D4, E3, E6, E11), in jsdom.
//
// `window.api` is a stub that records every call, so what is pinned is the lazy read, the rows and pages built
// from what main serves (labels, states and sentences passed through, never derived), and the skill editor's
// door: read and save by id, a conflict keeps the user's text, unsaved text refuses to leave the page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const REN = path.join(__dirname, '..', 'src', 'renderer');
const tick = () => new Promise(r => setTimeout(r, 0));

function setup(api) {
  const dom = new JSDOM('<!DOCTYPE html><html><body><section class="settings-cat"><div id="host"></div></section></body></html>',
    { url: 'http://localhost/', runScripts: 'outside-only' });
  const ctx = dom.getInternalVMContext();
  for (const rel of ['panels/plugins-kit.js', 'panels/plugins-views.js']) {
    vm.runInContext(fs.readFileSync(path.join(REN, rel), 'utf8'), ctx, { filename: rel });
  }
  const calls = [];
  dom.window.api = new Proxy(api, {
    get(t, p) { return (...args) => { calls.push([p, ...args]); return Promise.resolve(t[p] ? t[p](...args) : null); }; },
  });
  return { dom, window: dom.window, views: dom.window.pluginsViews, host: dom.window.document.getElementById('host'),
    section: dom.window.document.querySelector('section'), calls };
}

/** A stand-in for the CodeMirror editor, with the same small interface. */
function fakeEditor() {
  const made = [];
  const factory = async (parent, text) => {
    let value = text;
    let save = null;
    const ed = { destroyed: 0, getText: () => value, setText: (t) => { value = t; }, onSave: (cb) => { save = cb; }, destroy() { ed.destroyed++; }, type: (t) => { value = t; }, ctrlS: () => save && save() };
    made.push(ed);
    parent.appendChild(parent.ownerDocument.createElement('div'));
    return ed;
  };
  return { factory, made };
}

const rowNames = (host) => [...host.querySelectorAll('.plugins-row-name')].map(n => n.textContent);
const metas = (host) => [...host.querySelectorAll('.plugins-row-meta')].map(n => n.textContent);
const open = (host, i) => { host.querySelectorAll('.plugins-row-open')[i].click(); return host.querySelector('.plugins-detail'); };
const btn = (root, label) => [...root.querySelectorAll('button')].find(b => b.textContent === label);

test('bindLazy: nothing at bind, one mount on the first show, none on a second', () => {
  const { dom, window, views, section } = setup({});
  try {
    let mounted = 0;
    views.bindLazy(section, () => { mounted++; });
    assert.equal(mounted, 0);
    section.dispatchEvent(new window.CustomEvent('settings-cat-shown'));
    section.dispatchEvent(new window.CustomEvent('settings-cat-shown'));
    assert.equal(mounted, 1);
  } finally { dom.window.close(); }
});

test('Plugins: sections by kind, the served label and state on the row, Open by id, a refusal said on the page', async () => {
  const plugins = [
    { id: 'p1', kind: 'plugin', name: 'caveman', backendLabel: 'Some CLI', scope: 'global', state: 'enabled', path: '/x/caveman', brings: ['skills', 'commands'] },
    { id: 'p2', kind: 'plugin', name: 'off-one', backendLabel: 'Unknown Backend 9', scope: 'global', state: 'disabled', path: '/x/off', brings: [] },
    { id: 'p3', kind: 'package', name: 'npm:thing', backendLabel: 'Other CLI', scope: 'global', state: 'not reported', path: null, brings: [] },
  ];
  const { dom, host, views, calls } = setup({
    getPluginInventory: () => ({ plugins }),
    openPlugin: () => ({ ok: false, reason: 'That path is not a discovered resource for this backend.' }),
  });
  try {
    await views.mountPlugins(host, { projectPath: '/proj' });
    assert.deepEqual([...host.querySelectorAll('.plugins-section-title')].map(t => t.textContent), ['Plugins', 'Packages']);
    assert.deepEqual(metas(host), ['Some CLI · enabled', 'Unknown Backend 9 · disabled', 'Other CLI · state not reported']);
    assert.equal(host.querySelector('.plugins-row-switch'), null, 'read-only: no switch (E6)');
    let page = open(host, 0);
    assert.match(page.textContent, /Switched on in Some CLI's settings\./);
    assert.match(page.textContent, /skills, commands/);
    btn(page, 'Open folder').click(); await tick(); await tick();
    assert.deepEqual(calls.filter(c => c[0] === 'openPlugin').map(c => c.slice(1)), [['p1', '/proj']], 'by id and project, never a path');
    assert.match(page.textContent, /not a discovered resource/);
    host.querySelector('.plugins-back').click();
    page = open(host, 2);
    assert.match(page.textContent, /Other CLI does not report whether it is on\./);
    assert.equal(btn(page, 'Open folder'), undefined, 'no folder, no Open');
    assert.equal(calls.filter(c => c[0] === 'getPluginInventory').length, 1);
  } finally { dom.window.close(); }
});

test('Apps: an honest empty state while no CLI reports any (E3)', async () => {
  const { dom, host, views } = setup({ getAppInventory: () => ({ apps: [] }) });
  try {
    await views.mountApps(host, { projectPath: null });
    assert.equal(host.querySelector('.plugins-empty').textContent, 'No installed CLI reports apps yet.');
  } finally { dom.window.close(); }
});

const SKILLS = [
  { id: 's1', name: 'house-style', scope: 'global', sourceLabel: 'Switchboard', filePath: '/d/skills/house-style/SKILL.md', alsoNamed: [{ sourceLabel: 'Some CLI · global', filePath: '/c/house-style/SKILL.md' }], editable: true },
  { id: 's2', name: 'local', scope: 'project', sourceLabel: 'Some CLI · project', filePath: '/p/.cli/skills/local/SKILL.md', alsoNamed: [], editable: false },
  { id: 's3', name: '<img src=x onerror=alert(1)>', scope: 'global', sourceLabel: '<b>x</b>', filePath: '/d/x.md', alsoNamed: [], editable: false },
];
const DETAIL = { ok: true, targets: [
  { targetLabel: 'Some CLI', state: 'native', sentence: 'Its own skill, run with /house-style.', invocation: '/house-style' },
  { targetLabel: 'Other CLI', state: 'none', sentence: 'Takes no skills from another CLI.', invocation: null },
] };

test('Skills: sections by scope, the served source label, and the page with the delivery sentences as served', async () => {
  const { dom, host, views, calls } = setup({ getSkillInventory: () => ({ skills: SKILLS }), getSkillDetail: () => DETAIL });
  try {
    await views.mountSkills(host, { projectPath: '/proj', createEditor: fakeEditor().factory });
    assert.deepEqual([...host.querySelectorAll('.plugins-section-title')].map(t => t.textContent), ['This project', 'Global']);
    assert.deepEqual(rowNames(host), ['local', 'house-style', '<img src=x onerror=alert(1)>']);
    assert.equal(host.querySelector('img, b'), null, 'text stays text');
    const page = open(host, 0);
    await tick(); await tick();
    assert.match(page.textContent, /read-only here/);
    assert.equal(btn(page, 'Save'), undefined);
    assert.deepEqual([...page.querySelectorAll('.plugins-delivery-row')].map(r => [r.dataset.state, r.querySelector('.settings-description').textContent]),
      [['native', 'Its own skill, run with /house-style.'], ['none', 'Takes no skills from another CLI.']]);
    assert.deepEqual(calls.filter(c => c[0] === 'getSkillDetail').map(c => c.slice(1)), [['s2', '/proj']]);
  } finally { dom.window.close(); }
});

test('Skills editor: read and save by id; a conflict keeps the text and loads the disk version only on request', async () => {
  let saves = 0;
  const ed = fakeEditor();
  const { dom, host, views, calls } = setup({
    getSkillInventory: () => ({ skills: SKILLS }),
    getSkillDetail: () => DETAIL,
    readSkill: () => ({ ok: true, content: '# house\n' }),
    saveSkill: (id, p, content, baseline) => {
      saves++;
      if (saves === 1) return { ok: true, content };
      return { ok: false, conflict: true, diskContent: '# changed outside\n', reason: 'changed' };
    },
  });
  try {
    await views.mountSkills(host, { projectPath: null, createEditor: ed.factory });
    const page = open(host, 1);
    await tick(); await tick(); await tick();
    assert.deepEqual(calls.filter(c => c[0] === 'readSkill').map(c => c.slice(1)), [['s1', null]]);
    assert.match(page.textContent, /Also named in.*Some CLI · global/);
    const editor = ed.made[0];
    editor.type('# house\n\nmore\n');
    btn(page, 'Save').click(); await tick(); await tick();
    assert.deepEqual(calls.filter(c => c[0] === 'saveSkill').map(c => c.slice(1)), [['s1', null, '# house\n\nmore\n', '# house\n']]);
    assert.match(page.textContent, /Saved\./);

    editor.type('# mine\n');
    editor.ctrlS(); await tick(); await tick();
    assert.match(page.textContent, /changed on disk.*Your text is kept here/);
    assert.equal(editor.getText(), '# mine\n', 'the text in the editor stays');
    assert.equal(page.querySelector('.plugins-skill-disk').textContent, '# changed outside\n', 'the disk text is shown, read-only');
    host.querySelector('.plugins-back').click();
    assert.equal(host.querySelector('.plugins-detail-page').hidden, false, 'unsaved text stays on the page');
    assert.ok(btn(page, 'Load the version on disk'), 'a refused Back keeps the conflict choice');
    assert.equal(calls.filter(c => c[0] === 'saveSkill')[1][4], '# house\n\nmore\n', 'the baseline is what the last save wrote');
    btn(page, 'Load the version on disk').click();
    assert.equal(editor.getText(), '# changed outside\n');
  } finally { dom.window.close(); }
});

test('Skills editor: "Save mine over it" saves the user\'s text against the disk version it was shown', async () => {
  let n = 0;
  const ed = fakeEditor();
  const { dom, host, views, calls } = setup({
    getSkillInventory: () => ({ skills: SKILLS }),
    getSkillDetail: () => DETAIL,
    readSkill: () => ({ ok: true, content: 'a\n' }),
    saveSkill: (id, p, content) => (++n === 1 ? { ok: false, conflict: true, diskContent: 'disk\n' } : { ok: true, content }),
  });
  try {
    await views.mountSkills(host, { projectPath: null, createEditor: ed.factory });
    const page = open(host, 1);
    await tick(); await tick(); await tick();
    ed.made[0].type('mine\n');
    btn(page, 'Save').click(); await tick(); await tick();
    btn(page, 'Save mine over it').click(); await tick(); await tick();
    const saves = calls.filter(c => c[0] === 'saveSkill').map(c => [c[3], c[4]]);
    assert.deepEqual(saves, [['mine\n', 'a\n'], ['mine\n', 'disk\n']]);
    assert.match(page.textContent, /Saved\./);
    assert.equal(page.querySelector('.plugins-skill-disk'), null, 'the comparison is gone once settled');
  } finally { dom.window.close(); }
});

test('Skills editor: one save at a time — a second Ctrl+S while one is out sends nothing', async () => {
  let release;
  const ed = fakeEditor();
  const { dom, host, views, calls } = setup({
    getSkillInventory: () => ({ skills: SKILLS }),
    getSkillDetail: () => DETAIL,
    readSkill: () => ({ ok: true, content: 'a\n' }),
    saveSkill: (id, p, content) => new Promise(r => { release = () => r({ ok: true, content }); }),
  });
  try {
    await views.mountSkills(host, { projectPath: null, createEditor: ed.factory });
    open(host, 1);
    await tick(); await tick(); await tick();
    ed.made[0].type('b\n');
    ed.made[0].ctrlS(); ed.made[0].ctrlS();
    await tick();
    assert.equal(calls.filter(c => c[0] === 'saveSkill').length, 1);
    release(); await tick();
  } finally { dom.window.close(); }
});

test('Skills editor: released on Back and on opening another skill; one arriving after the page was left destroys itself', async () => {
  let releaseRead;
  let slow = false;
  const ed = fakeEditor();
  const { dom, host, views } = setup({
    getSkillInventory: () => ({ skills: [SKILLS[0], { ...SKILLS[0], id: 's4', name: 'other' }] }),
    getSkillDetail: () => DETAIL,
    readSkill: () => (slow ? new Promise(r => { releaseRead = () => r({ ok: true, content: 'late\n' }); }) : { ok: true, content: 'a\n' }),
  });
  try {
    await views.mountSkills(host, { projectPath: null, createEditor: ed.factory });
    open(host, 0);
    await tick(); await tick(); await tick();
    host.querySelector('.plugins-back').click();
    assert.equal(ed.made[0].destroyed, 1, 'Back releases the editor');
    open(host, 1);
    await tick(); await tick(); await tick();
    host.querySelector('.plugins-back').click();
    assert.equal(ed.made[1].destroyed, 1, 'and so does leaving another skill');

    slow = true;
    open(host, 0);
    await tick();
    host.querySelector('.plugins-back').click();   // left before the read answered
    releaseRead(); await tick(); await tick(); await tick();
    assert.equal(ed.made.length, 2, 'a read answering after the page was left builds no editor');
  } finally { dom.window.close(); }
});

test('Skills editor: an editor that finishes loading after the page was left destroys itself', async () => {
  let finish;
  const made = [];
  const slowFactory = (parent, text) => new Promise(r => {
    finish = () => {
      const ed = { destroyed: 0, getText: () => text, setText() {}, onSave() {}, destroy() { ed.destroyed++; } };
      made.push(ed);
      r(ed);
    };
  });
  const { dom, host, views } = setup({
    getSkillInventory: () => ({ skills: SKILLS }),
    getSkillDetail: () => DETAIL,
    readSkill: () => ({ ok: true, content: 'a\n' }),
  });
  try {
    await views.mountSkills(host, { projectPath: null, createEditor: slowFactory });
    open(host, 1);
    await tick(); await tick();
    host.querySelector('.plugins-back').click();
    finish(); await tick(); await tick();
    assert.equal(made.length, 1);
    assert.equal(made[0].destroyed, 1);
  } finally { dom.window.close(); }
});

test('a mounted view reads its inventory once across two shows (bindLazy + mountSkills)', async () => {
  const { dom, window, host, views, section, calls } = setup({ getSkillInventory: () => ({ skills: [] }) });
  try {
    views.bindLazy(section, () => views.mountSkills(host, { projectPath: null }));
    assert.equal(calls.length, 0, 'nothing read at bind');
    section.dispatchEvent(new window.CustomEvent('settings-cat-shown'));
    section.dispatchEvent(new window.CustomEvent('settings-cat-shown'));
    await tick();
    assert.equal(calls.filter(c => c[0] === 'getSkillInventory').length, 1);
  } finally { dom.window.close(); }
});

test('a failed apps read says so; a failed skill read leaves Save and Discard disabled', async () => {
  const ed = fakeEditor();
  const { dom, host, views } = setup({
    getAppInventory: () => null,
    getSkillInventory: () => ({ skills: SKILLS }),
    getSkillDetail: () => DETAIL,
    readSkill: () => ({ ok: false, reason: 'That skill is no longer listed.' }),
  });
  try {
    await views.mountApps(host, { projectPath: null });
    assert.match(host.textContent, /apps could not be read/);
    await views.mountSkills(host, { projectPath: null, createEditor: ed.factory });
    const page = open(host, 1);
    await tick(); await tick(); await tick();
    assert.match(page.textContent, /no longer listed/);
    assert.equal(btn(page, 'Save').disabled, true);
    assert.equal(btn(page, 'Discard').disabled, true);
  } finally { dom.window.close(); }
});

test('Skills editor: unsaved text refuses Back until saved or discarded', async () => {
  const ed = fakeEditor();
  const { dom, host, views } = setup({
    getSkillInventory: () => ({ skills: SKILLS }),
    getSkillDetail: () => DETAIL,
    readSkill: () => ({ ok: true, content: 'a\n' }),
  });
  try {
    await views.mountSkills(host, { projectPath: null, createEditor: ed.factory });
    const page = open(host, 1);
    await tick(); await tick(); await tick();
    ed.made[0].type('b\n');
    host.querySelector('.plugins-back').click();
    assert.equal(host.querySelector('.plugins-detail-page').hidden, false);
    assert.match(page.textContent, /unsaved changes/);
    btn(page, 'Discard').click();
    host.querySelector('.plugins-back').click();
    assert.equal(host.querySelector('.plugins-detail-page').hidden, true);
  } finally { dom.window.close(); }
});

test('a failed read says so instead of drawing an empty list', async () => {
  const { dom, host, views } = setup({ getSkillInventory: () => { throw new Error('boom'); }, getPluginInventory: () => null });
  try {
    await views.mountSkills(host, { projectPath: null });
    assert.match(host.textContent, /could not be read/);
    await views.mountPlugins(host, { projectPath: null });
    assert.match(host.textContent, /could not be read/);
  } finally { dom.window.close(); }
});

test('Skills: "New skill" offers main\'s places, creates by place id and opens the new skill\'s page (E15)', async () => {
  let created = false;
  const NEW = { id: 'n1', name: 'fresh', scope: 'global', sourceLabel: 'Some CLI · global', filePath: '/g/fresh/SKILL.md', alsoNamed: [], editable: false };
  const { dom, window, host, views, calls } = setup({
    getSkillInventory: () => ({ skills: created ? [...SKILLS, NEW] : SKILLS }),
    getSkillDetail: () => DETAIL,
    getSkillPlaces: () => ({ ok: true, places: [{ id: 'pl1', label: 'Some CLI · global — /g', scope: 'global' }] }),
    createSkill: (placeId, name) => { created = true; return name === 'fresh' ? { ok: true, id: 'n1' } : { ok: false, reason: 'no' }; },
  });
  try {
    await views.mountSkills(host, { projectPath: '/proj', createEditor: fakeEditor().factory });
    btn(host, 'New skill').click();
    await tick(); await tick();
    const form = window.document.querySelector('.plugins-new-skill');
    assert.ok(form, 'the form is shown above the list');
    assert.deepEqual([...form.querySelectorAll('option')].map(o => [o.value, o.textContent]), [['pl1', 'Some CLI · global — /g']]);
    form.querySelector('input').value = 'fresh';
    btn(form, 'Create').click();
    await tick(); await tick(); await tick(); await tick();
    assert.deepEqual(calls.filter(c => c[0] === 'createSkill').map(c => c.slice(1)), [['pl1', 'fresh', '/proj']]);
    assert.equal(window.document.querySelector('.plugins-new-skill'), null, 'the form closes');
    assert.equal(host.querySelector('.plugins-detail-page').hidden, false, 'the new skill\'s page is open');
    assert.match(host.querySelector('.plugins-detail-page').textContent, /fresh/);
  } finally { dom.window.close(); }
});

test('Skills: "New skill" with no place says so and creates nothing', async () => {
  const { dom, window, host, views, calls } = setup({
    getSkillInventory: () => ({ skills: SKILLS }),
    getSkillPlaces: () => ({ ok: true, places: [] }),
  });
  try {
    await views.mountSkills(host, { projectPath: null, createEditor: fakeEditor().factory });
    btn(host, 'New skill').click();
    await tick(); await tick();
    const form = window.document.querySelector('.plugins-new-skill');
    assert.match(form.textContent, /No CLI here has a skills folder/);
    assert.equal(btn(form, 'Create').disabled, true);
    assert.equal(calls.filter(c => c[0] === 'createSkill').length, 0);
    btn(form, 'Cancel').click();
    assert.equal(window.document.querySelector('.plugins-new-skill'), null);
  } finally { dom.window.close(); }
});

test('Skills: opening a skill\'s page closes the "New skill" form, so a create cannot land on unsaved text (verifier H1)', async () => {
  const { dom, window, host, views } = setup({
    getSkillInventory: () => ({ skills: SKILLS }),
    getSkillDetail: () => DETAIL,
    getSkillPlaces: () => ({ ok: true, places: [{ id: 'pl1', label: 'Some CLI · global — /g', scope: 'global' }] }),
  });
  try {
    await views.mountSkills(host, { projectPath: '/proj', createEditor: fakeEditor().factory });
    btn(host, 'New skill').click();
    await tick(); await tick();
    assert.ok(window.document.querySelector('.plugins-new-skill'));
    open(host, 0);
    assert.equal(window.document.querySelector('.plugins-new-skill'), null);
    await tick(); await tick();
  } finally { dom.window.close(); }
});
