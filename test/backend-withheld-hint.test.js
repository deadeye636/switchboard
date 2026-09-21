'use strict';
// #645 — what a launch option does NOT deliver on its own, said in the form that sets it.
//
// Two of the four kinds "Resources from" can hand over need a second toggle, and both toggles are off
// until somebody turns them on. That is deliberate and stays. What was missing is the sentence: the
// field's description buries it, the preview beside it shows it only once opened, and at launch the
// dropped rows go to the log. So a session kept its skills and commands and the user found out about
// the agents when an agent answered that it was not available.
//
// The panel is mounted in a real DOM rather than grepped, for the reason the sibling panel test gives:
// what is asserted here is what somebody sees, and a source check cannot tell a rendered line from a
// hidden one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PANEL = path.join(__dirname, '..', 'src', 'renderer', 'panels', 'backends-panel.js');

const PROJECT_PATH = '/home/someone/projects/demo';

const AGENTS_NOTE = 'agents are not passed';
const SERVERS_NOTE = 'MCP servers are not started';

// A backend shaped like the one that declares this (a source select plus the two toggles that decide
// whether two of its kinds come along). Named so nothing here depends on a real backend's wording.
const BACKEND = {
  id: 'runtime', label: 'Runtime', status: 'ready', available: true, resourceDiscovery: false,
  configFields: [
    {
      id: 'resourcesFrom', label: 'Resources from', type: 'select',
      choices: ['', 'other'], choiceLabels: { '': 'None' }, default: '',
      withheld: [
        { requires: 'subagentTool', note: `The source's ${AGENTS_NOTE} while the subagent tool is off.` },
        { requires: 'mcpServers', note: `The source's ${SERVERS_NOTE} while their own toggle is off.` },
      ],
    },
    { id: 'subagentTool', label: 'Subagent tool', type: 'toggle', default: false },
    { id: 'mcpServers', label: 'MCP servers from the source', type: 'toggle', default: false },
  ],
};

function setup(backend = BACKEND) {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  window.api = {
    backends: {
      list: async () => ({ backends: [backend], defaultLaunchTarget: backend.id }),
      listResources: async () => ({ ok: true, resources: [] }),
    },
    profiles: { list: async () => ({ profiles: [] }) },
  };
  window.navigator.clipboard = { writeText: async () => {} };
  vm.runInContext(fs.readFileSync(PANEL, 'utf8'), dom.getInternalVMContext(), { filename: PANEL });
  return { window, dom, root: window.document.getElementById('root') };
}

/** Mount the PROJECT scope, whose page draws every launch option of a backend directly. */
async function mountWith(ctx, own) {
  await ctx.window.backendsPanel.mount(ctx.root, {
    isProject: true,
    projectPath: PROJECT_PATH,
    settings: { backendDefaults: { [BACKEND.id]: own } },
    globalDefaults: {},
    fieldValue: (_id, fallback) => fallback,
    useGlobalCheckbox: () => '',
  });
}

const box = (ctx) => ctx.root.querySelector('.backend-withheld');
const shownNotes = (ctx) => [...ctx.root.querySelectorAll('.backend-withheld-note')]
  .filter(n => !n.hidden)
  .map(n => n.textContent);

test('a source with both toggles off says so, once per kind', async () => {
  const ctx = setup();
  try {
    await mountWith(ctx, { resourcesFrom: 'other' });
    assert.equal(box(ctx).hidden, false, 'the lines are drawn without opening anything');
    const notes = shownNotes(ctx);
    assert.equal(notes.length, 2);
    assert.ok(notes.some(t => t.includes(AGENTS_NOTE)), `agents: ${notes.join(' | ')}`);
    assert.ok(notes.some(t => t.includes(SERVERS_NOTE)), `servers: ${notes.join(' | ')}`);
  } finally { ctx.dom.window.close(); }
});

test('the kind whose toggle is on says nothing', async () => {
  const ctx = setup();
  try {
    await mountWith(ctx, { resourcesFrom: 'other', subagentTool: true });
    const notes = shownNotes(ctx);
    assert.equal(notes.length, 1, `only the other kind is still withheld: ${notes.join(' | ')}`);
    assert.ok(notes[0].includes(SERVERS_NOTE));
  } finally { ctx.dom.window.close(); }
});

test('with both toggles on there is nothing to say', async () => {
  const ctx = setup();
  try {
    await mountWith(ctx, { resourcesFrom: 'other', subagentTool: true, mcpServers: true });
    assert.equal(box(ctx).hidden, true);
    assert.deepEqual(shownNotes(ctx), []);
  } finally { ctx.dom.window.close(); }
});

test('no source chosen: the lines are about a field nobody set, so they stay away', async () => {
  const ctx = setup();
  try {
    await mountWith(ctx, { resourcesFrom: '' });
    assert.equal(box(ctx).hidden, true, 'an empty select is "nothing chosen", not a withheld kind');
    assert.deepEqual(shownNotes(ctx), []);
  } finally { ctx.dom.window.close(); }
});

test('switching a toggle while the page is open follows it, without a request', async () => {
  const ctx = setup();
  try {
    await mountWith(ctx, { resourcesFrom: 'other', subagentTool: false });
    assert.equal(shownNotes(ctx).length, 2);
    const toggle = ctx.root.querySelector(`.backend-default-input[data-opt="subagentTool"]`);
    assert.ok(toggle, 'the toggle is on the page');
    toggle.checked = true;
    toggle.dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
    const notes = shownNotes(ctx);
    assert.equal(notes.length, 1, `the agents line goes as soon as the tool is on: ${notes.join(' | ')}`);
    assert.ok(notes[0].includes(SERVERS_NOTE));
  } finally { ctx.dom.window.close(); }
});

// The stored blob holds only what somebody SET, and the control beside the note falls back to the field's
// declared default. A note that read the blob alone would put "this kind is withheld" next to a toggle
// drawn as on — one screen, two answers.
test('an option whose declared default is on is on, even with nothing stored', async () => {
  const onByDefault = {
    ...BACKEND,
    configFields: BACKEND.configFields.map(f => (f.id === 'subagentTool' ? { ...f, default: true } : f)),
  };
  const ctx = setup(onByDefault);
  try {
    await mountWith(ctx, { resourcesFrom: 'other' });
    const notes = shownNotes(ctx);
    assert.equal(notes.length, 1, `the kind its default already delivers says nothing: ${notes.join(' | ')}`);
    assert.ok(notes[0].includes(SERVERS_NOTE));
  } finally { ctx.dom.window.close(); }
});

test('a note reuses an existing hint style rather than shipping an unstyled line', async () => {
  const ctx = setup();
  try {
    await mountWith(ctx, { resourcesFrom: 'other' });
    const notes = [...ctx.root.querySelectorAll('.backend-withheld-note')];
    // Counted first: a loop over an empty list asserts nothing and would pass with the lines gone.
    assert.equal(notes.length, 2);
    for (const note of notes) {
      assert.ok(note.classList.contains('settings-hint'), 'a new control inherits no styling of its own');
    }
  } finally { ctx.dom.window.close(); }
});
