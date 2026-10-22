// The pure form <-> entry mapping for the MCP servers editor (#789 slice B, spec 36).
// Real behaviour over the module; validation stays in external-mcp-validate.js (D-B7) and is only called here to
// prove that what the mapping builds is something the launch accepts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { entryToForm, formToEntry } = require('../src/shared/external-mcp-form');
const { validateExternalMcpServers } = require('../src/shared/external-mcp-validate');

const CASES = {
  'stdio with args, env, cwd': {
    name: 'files', transport: 'stdio', command: 'npx', args: ['-y', 'some server', '--flag'],
    env: { MODE: 'fast' }, cwd: '~/work',
  },
  'stdio with a passthrough row': {
    name: 'search', transport: 'stdio', command: 'search-mcp', env: { API_HOME: '/opt/x', KEEP: '${KEEP}' },
  },
  'http with headers': {
    name: 'remote', transport: 'http', url: 'https://example.invalid/mcp',
    headers: { 'X-Team': 'blue', Authorization: '${TEAM_AUTH}' },
  },
  'unknown key carried through': {
    name: 'future', transport: 'stdio', command: 'run', note: 'kept', nested: { a: [1, 2] },
  },
  'enabled false and backends': {
    name: 'scoped', transport: 'http', url: 'https://example.invalid/x', enabled: false, backends: ['b-one', 'b-two'],
  },
  'bare stdio': { name: 'bare', transport: 'stdio', command: 'x' },
};

for (const [label, entry] of Object.entries(CASES)) {
  test(`round trip: ${label}`, () => {
    const back = formToEntry(entryToForm(entry));
    assert.deepEqual(back, entry);
    const res = validateExternalMcpServers([back]);
    assert.equal(res.rejected.length, 0, JSON.stringify(res.rejected));
  });
}

test('arguments are one per line and never shell-split; blank lines drop out', () => {
  const form = entryToForm({ name: 'a', transport: 'stdio', command: 'c' });
  form.args = 'one\n\n  \ntwo words\r\n"quoted"';
  assert.deepEqual(formToEntry(form).args, ['one', 'two words', '"quoted"']);
});

test('empty env, header and passthrough rows are ignored; passthrough builds NAME: ${NAME}', () => {
  const form = entryToForm({ name: 'a', transport: 'stdio', command: 'c' });
  form.envRows = [{ name: '', value: 'x' }, { name: '  ', value: '' }, { name: 'K', value: 'v' }];
  form.passthrough = ['HOME_DIR', '', '  '];
  assert.deepEqual(formToEntry(form).env, { K: 'v', HOME_DIR: '${HOME_DIR}' });
  const bare = entryToForm({ name: 'a', transport: 'stdio', command: 'c' });
  bare.envRows = [{ name: '', value: '' }];
  assert.equal('env' in formToEntry(bare), false);
});

test('passthrough rows are derived from an env row that is exactly its own ${NAME}', () => {
  const form = entryToForm({ name: 'a', transport: 'stdio', command: 'c', env: { A: '${A}', B: '${A}', C: 'c' } });
  assert.deepEqual(form.passthrough, ['A']);
  assert.deepEqual(form.envRows, [{ name: 'B', value: '${A}' }, { name: 'C', value: 'c' }]);
});

test('a form with both stdio and http fields filled yields only the chosen transport', () => {
  const both = {
    name: 'x', command: 'run', args: 'a', envRows: [{ name: 'K', value: 'v' }], passthrough: ['P'], cwd: '/w',
    url: 'https://example.invalid/m', headerRows: [{ name: 'H', value: 'v' }],
  };
  const stdio = formToEntry({ ...both, transport: 'stdio' });
  assert.deepEqual(Object.keys(stdio).sort(), ['args', 'command', 'cwd', 'env', 'name', 'transport']);
  const http = formToEntry({ ...both, transport: 'http' });
  assert.deepEqual(Object.keys(http).sort(), ['headers', 'name', 'transport', 'url']);
  for (const e of [stdio, http]) assert.equal(validateExternalMcpServers([e]).rejected.length, 0);
});

test('switching transport on an existing entry drops the other side but keeps unknown keys', () => {
  const form = entryToForm({ name: 'a', transport: 'stdio', command: 'c', args: ['x'], env: { K: 'v' }, cwd: '/w', extra1: 1 });
  form.transport = 'http';
  form.url = 'https://example.invalid/m';
  assert.deepEqual(formToEntry(form), { name: 'a', transport: 'http', url: 'https://example.invalid/m', extra1: 1 });
});

test('backends are omitted when empty; enabled stays absent unless the entry had it', () => {
  const form = entryToForm({ name: 'a', transport: 'stdio', command: 'c' });
  assert.equal(form.enabled, undefined);
  form.backends = [];
  const entry = formToEntry(form);
  assert.equal('backends' in entry, false);
  assert.equal('enabled' in entry, false);
  assert.equal(formToEntry({ ...entryToForm({ name: 'a', transport: 'stdio', command: 'c', enabled: true }) }).enabled, true);
});

test('the mapping does not validate: a bad name passes through for the validator to refuse', () => {
  const entry = formToEntry({ name: 'bad name', transport: 'stdio', command: 'c' });
  assert.equal(entry.name, 'bad name');
  assert.equal(validateExternalMcpServers([entry]).rejected.length, 1);
});

test('entryToForm on a non-object yields an empty stdio form', () => {
  for (const raw of [null, undefined, 'x', []]) {
    const form = entryToForm(raw);
    assert.equal(form.transport, 'stdio');
    assert.equal(form.name, '');
    assert.deepEqual(form.extra, {});
  }
});
