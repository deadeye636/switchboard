// The global settings' "MCP servers" category (#790 T5 and T6, spec 38): the catalog rows, the PATH check on first
// sight, Copy, the registry search, and Add to project. Real renderer files in jsdom; `window.api`, the clipboard
// and the dialog are fakes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const REN = path.join(__dirname, '..', 'src', 'renderer');
const SCRIPTS = ['lib/utils.js', '../shared/external-mcp-validate.js', '../shared/external-mcp-form.js',
  '../shared/mcp-addon-catalog.js', 'panels/settings-external-mcp.js'];
const PAGE = '<!DOCTYPE html><html><body><div id="body">'
  + '<section class="settings-cat" data-cat="mcp-addons"><div class="settings-cat-head"><h2>MCP servers</h2></div>'
  + '<div id="sv-mcp-addons"></div></section></div></body></html>';

const tick = () => new Promise(r => setTimeout(r, 0));

function setup({ check, search, clipboard, projects, dialog } = {}) {
  const dom = new JSDOM(PAGE, { url: 'http://localhost/', runScripts: 'outside-only' });
  const ctx = dom.getInternalVMContext();
  for (const rel of SCRIPTS) vm.runInContext(fs.readFileSync(path.join(REN, rel), 'utf8'), ctx, { filename: rel });
  const { window } = dom;
  const calls = { check: [], search: [], copied: [], projects: 0, opened: [], dialogs: [] };
  window.showControlDialog = async (o) => { calls.dialogs.push(o); return dialog === undefined ? true : dialog; };
  window.api = {
    getProjectsAdmin: async () => {
      calls.projects += 1;
      return projects === undefined ? { ok: true, projects: [] } : projects;
    },
    openSettingsWindow: (scope, projectPath, seed) => { calls.opened.push({ scope, projectPath, seed }); },
    checkExternalMcp: async (projectPath, entries) => {
      calls.check.push({ projectPath, entries });
      return check ? check(entries, calls.check.length) : { ok: true, results: [] };
    },
    searchMcpRegistry: async (term) => {
      calls.search.push(term);
      return search ? search(term, calls.search.length) : { ok: true, results: [] };
    },
  };
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboard || (async (t) => { calls.copied.push(t); }) },
  });
  const body = window.document.getElementById('body');
  const ctl = new window.AbortController();
  window.settingsExternalMcp.bindAddons(body, ctl.signal);
  const show = () => body.querySelector('section[data-cat="mcp-addons"]').dispatchEvent(new window.CustomEvent('settings-cat-shown', { bubbles: true }));
  return { dom, window, body, calls, show, ctl };
}

// A reply that answers every probe with `stateFor(command)`.
const answering = (stateFor) => (entries) => ({
  ok: true,
  results: entries.map((e, index) => ({ index, name: e.name, enabled: true, transport: 'stdio', command: stateFor(e.command), variables: [], takes: [], envGap: false })),
});

// The catalog's ids as a plain array of this realm (the window's arrays are jsdom's, not deepStrictEqual to ours).
const ids = (window) => JSON.parse(JSON.stringify(window.MCP_ADDON_CATALOG.map(i => i.id)));

const buttonsNamed = (root, label) => [...root.querySelectorAll('button')].filter(b => b.textContent === label);

test('one row per catalog entry, as a settings field, with the licence, the source and both commands per runtime', () => {
  const { dom, window, body } = setup();
  try {
    const rows = [...body.querySelectorAll('.settings-field.sv-addon')];
    assert.deepEqual(rows.map(r => r.dataset.addon), ids(window));
    for (const [i, item] of window.MCP_ADDON_CATALOG.entries()) {
      const text = rows[i].textContent;
      assert.ok(text.includes(item.name) && text.includes(item.licence) && text.includes(item.source), item.id);
      const lines = [...rows[i].querySelectorAll('.sv-addon-command code')].map(c => c.textContent);
      for (const r of item.runtimes) {
        assert.ok(lines.includes(r.install.join(' ')), `${item.id} ${r.runtime} install`);
        assert.ok(lines.includes(r.uninstall.join(' ')), `${item.id} ${r.runtime} uninstall`);
      }
      assert.ok([...rows[i].querySelectorAll('.sv-mcp-chip')].every(c => /not checked yet/.test(c.textContent)));
    }
    for (const b of body.querySelectorAll('button')) assert.ok(b.classList.contains('settings-action-btn'), b.textContent);
    assert.equal(body.querySelector('details'), null, 'no disclosure: the settings search would force it open');
  } finally { dom.window.close(); }
});

test('no PATH check at bind; one on the first show, none on a second, one more on Check again', async () => {
  const { dom, body, calls, show } = setup({ check: answering(() => ({ state: 'found' })) });
  try {
    await tick();
    assert.equal(calls.check.length, 0);
    show(); await tick();
    assert.equal(calls.check.length, 1);
    assert.equal(calls.check[0].projectPath, null);
    show(); await tick();
    assert.equal(calls.check.length, 1);
    buttonsNamed(body, 'Check again')[0].click(); await tick();
    assert.equal(calls.check.length, 2);
  } finally { dom.window.close(); }
});

test('found, not found on PATH and not checked render as words, never as "missing"', async () => {
  const states = { uv: { state: 'found' }, pipx: { state: 'missing' }, 'jcodemunch-mcp': { state: 'unknown', reason: 'unreadable' } };
  const { dom, body, show } = setup({ check: answering(cmd => states[cmd] || { state: 'unknown', reason: 'some-new-code' }) });
  try {
    show(); await tick(); await tick();
    const chips = [...body.querySelectorAll('[data-addon="jcodemunch"] .sv-mcp-chip')].map(c => [c.textContent, c.classList.contains('sv-mcp-chip-unknown')]);
    assert.deepEqual(chips, [
      ['uv: found', false],
      ['pipx: not found on PATH', false],
      ['jcodemunch-mcp: not checked: a folder on PATH could not be read', true],
    ]);
    const other = body.querySelector('[data-addon="jdocmunch"]').textContent;
    assert.match(other, /jdocmunch-mcp: not checked: the reason is not known to this version/);
    assert.doesNotMatch(body.textContent, /missing/);
  } finally { dom.window.close(); }
});

test('a stale check reply is dropped, and a failed one keeps the shown states and says so', async () => {
  let release;
  const slow = new Promise(r => { release = r; });
  const { dom, body, show } = setup({
    check: async (entries, n) => {
      if (n === 1) { await slow; return answering(() => ({ state: 'missing' }))(entries); }
      if (n === 2) return answering(() => ({ state: 'found' }))(entries);
      return { ok: false, reason: 'The check could not run.' };
    },
  });
  try {
    show();
    buttonsNamed(body, 'Check again')[0].click(); await tick(); await tick();
    release(); await tick(); await tick();
    const chip = () => body.querySelector('[data-addon="jcodemunch"] .sv-mcp-chip').textContent;
    assert.equal(chip(), 'uv: found', 'the later answer stands');
    buttonsNamed(body, 'Check again')[0].click(); await tick(); await tick();
    assert.equal(chip(), 'uv: found');
    assert.match(body.textContent, /The check could not run\. The states shown are from the last check\./);
  } finally { dom.window.close(); }
});

test('Copy puts the exact command on the clipboard; a refused clipboard says so', async () => {
  const { dom, window, body, calls } = setup();
  try {
    const item = window.MCP_ADDON_CATALOG[0];
    const line = [...body.querySelectorAll(`[data-addon="${item.id}"] .sv-addon-command`)]
      .find(l => l.querySelector('code').textContent === item.runtimes[0].uninstall.join(' '));
    const button = line.querySelector('button');
    button.click(); await tick();
    assert.deepEqual(calls.copied, [item.runtimes[0].uninstall.join(' ')]);
    assert.equal(button.textContent, 'Copied');
  } finally { dom.window.close(); }

  const refused = setup({ clipboard: async () => { throw new Error('denied'); } });
  try {
    buttonsNamed(refused.body, 'Copy')[0].click(); await tick();
    assert.match(refused.body.textContent, /Could not copy\. Select the text and copy it by hand\./);
  } finally { refused.dom.window.close(); }
});

test('the registry is asked only on Search or Enter, never while typing', async () => {
  const { dom, window, body, calls } = setup();
  try {
    const input = body.querySelector('input.settings-input');
    input.value = 'demo';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    await tick();
    assert.deepEqual(calls.search, []);
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
    assert.deepEqual(calls.search, ['demo']);
    buttonsNamed(body, 'Search')[0].click(); await tick();
    assert.deepEqual(calls.search, ['demo', 'demo']);
    assert.match(body.textContent, /Press Search to send this text to the registry\./);
  } finally { dom.window.close(); }
});

test('registry text holding markup stays text, marked Unverified, with Copy for a built command only', async () => {
  const evil = '<img src=x onerror="window.__pwned=1">';
  const { dom, window, body } = setup({
    search: () => ({ ok: true, results: [{
      name: evil, title: '<b>bold</b>', description: '<script>window.__pwned=2</script>', source: 'https://example.invalid/x',
      packages: [
        { registry: 'pypi', identifier: 'demo-mcp', commands: [{ runtime: 'uv', install: 'uv tool install demo-mcp' }] },
        { registry: 'npm', identifier: '<i>left-pad</i>' },
      ],
    }] }),
  });
  try {
    const results = () => body.querySelector('[aria-live="polite"].sv-mcp-cards');
    assert.equal(results().textContent, '', 'nothing from the registry before a search');
    buttonsNamed(body, 'Search')[0].click(); await tick(); await tick();
    const card = results().querySelector('.sv-mcp-card');
    assert.ok(card.textContent.includes(evil));
    assert.ok(card.textContent.includes('<b>bold</b>'));
    assert.equal(card.querySelector('img, b, script, i'), null, 'no element built from registry text');
    assert.equal(window.__pwned, undefined);
    assert.ok([...card.querySelectorAll('.sv-mcp-chip')].some(c => c.textContent === 'Unverified'));
    const codes = [...card.querySelectorAll('.sv-addon-command code')].map(c => c.textContent);
    assert.deepEqual(codes, ['https://example.invalid/x', 'uv tool install demo-mcp']);
  } finally { dom.window.close(); }
});

test('a later search wins over an earlier one still out; a refusal shows main\'s sentence', async () => {
  let release;
  const slow = new Promise(r => { release = r; });
  const { dom, body } = setup({
    search: async (term, n) => {
      if (n === 1) { await slow; return { ok: true, results: [{ name: 'first', packages: [] }] }; }
      if (n === 2) return { ok: true, results: [{ name: 'second', packages: [] }] };
      return { ok: false, reason: 'Type a name to search for.' };
    },
  });
  try {
    const search = buttonsNamed(body, 'Search')[0];
    search.click(); search.click(); await tick(); await tick();
    release(); await tick(); await tick();
    const names = () => [...body.querySelectorAll('.sv-mcp-card .settings-label')].map(n => n.textContent);
    assert.deepEqual(names(), ['second']);
    search.click(); await tick(); await tick();
    assert.match(body.textContent, /Type a name to search for\./);
  } finally { dom.window.close(); }
});

test('a settings search keeps a matching row and hides the others (rows are .settings-field)', () => {
  const { dom, window, body } = setup();
  try {
    // The settings search's own rule (settings-panel.js applyGlobalSearch): a field shows when its text holds the query.
    const visible = (q) => [...body.querySelectorAll('.settings-cat .settings-field')]
      .filter(f => f.textContent.toLowerCase().includes(q.toLowerCase()))
      .map(f => f.dataset.addon).filter(Boolean);
    assert.deepEqual(visible('jDocMunch'), ['jdocmunch']);
    assert.deepEqual(visible('Dual-Use'), ids(window));
    assert.deepEqual(visible('no such thing'), []);
  } finally { dom.window.close(); }
});

// --- Add to project (T6): the picker and the hand-off. ---

const PROJECTS = { ok: true, projects: [
  { projectPath: '/work/zeta', displayName: 'Zeta', registered: true },
  { projectPath: '/work/alpha', displayName: '', registered: true },
  { projectPath: '/work/hidden', displayName: 'Hidden', registered: true, hidden: true },
  { projectPath: '/work/gone', displayName: 'Gone', registered: true, missing: true },
  { projectPath: '/work/alpha/.claude/worktrees/wt1', displayName: 'wt1', registered: true, worktreeRoot: '/work/alpha' },
  { projectPath: '/work/<b>odd</b>', displayName: '<img src=x onerror="window.__pwned=1">', registered: true },
  // Not on the list: one a backend's config alone knows, and one the user removed.
  { projectPath: '/work/config-only', displayName: '', registered: false, configOnly: true },
  { projectPath: '/work/removed', displayName: 'Removed', registered: false, removedAt: 1 },
] };

test('the project list is read on the first show only, and lists only projects on the list, present and not worktrees, as text', async () => {
  const { dom, window, body, calls, show } = setup({ projects: PROJECTS });
  try {
    const picker = body.querySelector('[data-addon="jcodemunch"] select');
    assert.equal(picker.disabled, true, 'nothing to pick before the list is read');
    await tick();
    assert.equal(calls.projects, 0, 'not read at bind');
    show(); await tick(); await tick();
    show(); await tick();
    assert.equal(calls.projects, 1);
    const options = [...picker.options].slice(1).map(o => [o.value, o.textContent]);
    assert.deepEqual(JSON.parse(JSON.stringify(options)), [
      ['/work/<b>odd</b>', '<img src=x onerror="window.__pwned=1">'],
      ['/work/alpha', 'alpha'],
      ['/work/zeta', 'Zeta'],
    ]);
    assert.equal(picker.querySelector('img, b'), null);
    assert.equal(window.__pwned, undefined);
    assert.equal(picker.disabled, false);
    assert.ok(picker.classList.contains('settings-select'));
  } finally { dom.window.close(); }
});

test('a failed or empty project list says so and offers nothing to press', async () => {
  for (const [projects, words] of [[{ error: 'nope' }, /could not be read/], [{ ok: true, projects: [] }, /No project to add to yet/]]) {
    const { dom, body, show } = setup({ projects });
    try {
      show(); await tick(); await tick();
      const row = body.querySelector('[data-addon="jdocmunch"]');
      assert.match(row.querySelector('select').options[0].textContent, words);
      assert.equal([...row.querySelectorAll('button')].find(b => b.textContent === 'Add to project').disabled, true);
    } finally { dom.window.close(); }
  }
});

test('Add to project warns, then opens the project with the catalog id as the seed; Cancel opens nothing', async () => {
  const run = async (dialog) => {
    const env = setup({ projects: PROJECTS, dialog });
    env.show(); await tick(); await tick();
    const row = env.body.querySelector('[data-addon="jdatamunch"]');
    row.querySelector('select').value = '/work/zeta';
    [...row.querySelectorAll('button')].find(b => b.textContent === 'Add to project').click();
    await tick(); await tick();
    return env;
  };
  const yes = await run(true);
  try {
    assert.equal(yes.calls.dialogs.length, 1);
    assert.match(yes.calls.dialogs[0].message, /not saved are lost/);
    assert.deepEqual(JSON.parse(JSON.stringify(yes.calls.opened)), [{ scope: 'project', projectPath: '/work/zeta', seed: { addon: 'jdatamunch' } }]);
  } finally { yes.dom.window.close(); }
  const no = await run(false);
  try {
    assert.equal(no.calls.dialogs.length, 1);
    assert.deepEqual(no.calls.opened, []);
  } finally { no.dom.window.close(); }
});

test('Add to project without a chosen project asks for one and opens nothing', async () => {
  const { dom, body, calls, show } = setup({ projects: PROJECTS });
  try {
    show(); await tick(); await tick();
    const row = body.querySelector('[data-addon="jcodemunch"]');
    [...row.querySelectorAll('button')].find(b => b.textContent === 'Add to project').click();
    await tick();
    assert.match(body.textContent, /Choose a project first\./);
    assert.deepEqual(calls.dialogs, []);
    assert.deepEqual(calls.opened, []);
  } finally { dom.window.close(); }
});
