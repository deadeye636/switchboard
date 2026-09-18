// #633 — the MCP servers Claude has configured, as neutral rows another backend may take over.
//
// Against a fixture home and project, never the machine's own: the three places Claude keeps servers, the
// order a name is resolved in, the approval a `.mcp.json` server needs, and `${VAR}` expansion.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const claudeConfig = require('../src/backends/claude/config');
const { createListSharedMcpServers, _expand } = require('../src/backends/claude/mcp-servers');

function fixture({ top = null, local = null, entryExtra = {}, mcpJson = null, userSettings = null, localSettings = null, sharedSettings = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mcp633-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'proj');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  const cfg = { projects: {} };
  if (top) cfg.mcpServers = top;
  // Filed under the project path AS SPELLED, which is where Claude files and finds local servers.
  cfg.projects[project.replace(/\\/g, '/')] ={ ...(local ? { mcpServers: local } : {}), ...entryExtra };
  const configFile = path.join(root, '.claude.json');
  fs.writeFileSync(configFile, JSON.stringify(cfg));
  if (mcpJson) fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: mcpJson }));
  if (userSettings) fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(userSettings));
  if (localSettings) fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'), JSON.stringify(localSettings));
  if (sharedSettings) fs.writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify(sharedSettings));
  const list = createListSharedMcpServers({ claudeHome: () => home, configPath: () => configFile });
  return { list, project, configFile, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const server = (arg, extra = {}) => ({ type: 'stdio', command: 'node', args: ['server.js', arg], env: {}, ...extra });

test('user, local and project servers come back in Claude\'s precedence order, each with its scope and origin', (t) => {
  const f = fixture({
    top: { u: server('user') },
    local: { l: server('local') },
    mcpJson: { p: server('proj') },
    entryExtra: { enabledMcpjsonServers: ['p'] },
  });
  t.after(f.cleanup);
  const r = f.list({ projectPath: f.project, env: {} });
  assert.equal(r.ok, true);
  assert.deepEqual(r.servers.map((s) => [s.name, s.origin, s.scope]), [['l', 'local', 'global'], ['p', 'project', 'project'], ['u', 'user', 'global']]);
  assert.equal(r.servers[1].approved, true);
  assert.equal(r.servers[1].path, path.join(f.project, '.mcp.json'));
  assert.deepEqual(r.servers[0].args, ['server.js', 'local']);
});

test('the local scope is read under the project path as spelled, and under no other spelling', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const spelled = f.project.replace(/\\/g, '/');
  const cfg = JSON.parse(fs.readFileSync(f.configFile, 'utf8'));
  cfg.projects = { [spelled]: { mcpServers: { l: server('local') } } };
  fs.writeFileSync(f.configFile, JSON.stringify(cfg));
  // A trailing separator does not change the key.
  assert.deepEqual(f.list({ projectPath: f.project + path.sep, env: {} }).servers.map((s) => [s.name, s.origin]), [['l', 'local']]);
  // Measured: Claude run from the same directory spelled differently does not see that block, so neither
  // does this. Only testable where one directory has two spellings — case on Windows.
  if (process.platform === 'win32') {
    const other = f.project.toUpperCase();
    assert.deepEqual(f.list({ projectPath: other, env: {} }).servers, []);
  }
});

test('approvals are read from every spelling of the project\'s block, and a disable in any of them wins', (t) => {
  const f = fixture({ mcpJson: { p: server('proj'), q: server('q') } });
  t.after(f.cleanup);
  const cfg = JSON.parse(fs.readFileSync(f.configFile, 'utf8'));
  const trustKey = claudeConfig.cliProjectKey(f.project);
  const spelled = f.project.replace(/\\/g, '/');
  cfg.projects = { [spelled]: { enabledMcpjsonServers: ['p'] } };
  cfg.projects[trustKey] = { ...(cfg.projects[trustKey] || {}), enabledMcpjsonServers: ['p', 'q'], ...(trustKey === spelled ? {} : { disabledMcpjsonServers: ['p'] }) };
  fs.writeFileSync(f.configFile, JSON.stringify(cfg));
  const rows = f.list({ projectPath: f.project, env: {} }).servers;
  const approved = Object.fromEntries(rows.map((r) => [r.name, r.approved]));
  assert.equal(approved.q, true);
  assert.equal(approved.p, trustKey === spelled);
});

test('without a project only the user\'s servers are listed', (t) => {
  const f = fixture({ top: { u: server('user') }, local: { l: server('local') } });
  t.after(f.cleanup);
  assert.deepEqual(f.list({ projectPath: null, env: {} }).servers.map((s) => s.name), ['u']);
});

test('a .mcp.json server is approved only by what the USER wrote, and a disable wins', (t) => {
  const cases = [
    [{}, false],
    [{ entryExtra: { enabledMcpjsonServers: ['p'] } }, true],
    [{ userSettings: { enableAllProjectMcpServers: true } }, true],
    [{ localSettings: { enabledMcpjsonServers: ['p'] } }, true],
    [{ entryExtra: { enabledMcpjsonServers: ['p'], disabledMcpjsonServers: ['p'] } }, false],
    [{ userSettings: { enableAllProjectMcpServers: true }, localSettings: { disabledMcpjsonServers: ['p'] } }, false],
    // The committed project settings are the repository's, not the user's: they cannot approve its servers.
    [{ sharedSettings: { enableAllProjectMcpServers: true, enabledMcpjsonServers: ['p'] } }, false],
  ];
  for (const [opts, expected] of cases) {
    const f = fixture({ mcpJson: { p: server('proj') }, ...opts });
    try {
      const row = f.list({ projectPath: f.project, env: {} }).servers.find((s) => s.name === 'p');
      assert.equal(row.approved, expected, JSON.stringify(opts));
    } finally { f.cleanup(); }
  }
});

test('an HTTP or SSE server is reported with its transport and no command', (t) => {
  const f = fixture({ top: { h: { type: 'http', url: 'https://example.invalid/mcp' }, legacy: { url: 'https://example.invalid/x' }, s: { type: 'sse', url: 'https://example.invalid/s' } } });
  t.after(f.cleanup);
  const rows = f.list({ projectPath: null, env: {} }).servers;
  assert.deepEqual(rows.map((r) => [r.name, r.transport, r.command]), [['h', 'http', undefined], ['legacy', 'http', undefined], ['s', 'sse', undefined]]);
});

test('${VAR} and ${VAR:-default} are expanded in command, arguments and env; an unset one without a default is reported', (t) => {
  const f = fixture({
    top: {
      x: { command: '${TOOL_BIN}', args: ['--root', '${ROOT:-/fallback}'], env: { TOKEN: '${API_TOKEN}', FIXED: 'plain' } },
      y: { command: 'node', args: ['${MISSING_ONE}'], env: { K: '${MISSING_TWO}' } },
    },
  });
  t.after(f.cleanup);
  const [x, y] = f.list({ projectPath: null, env: { TOOL_BIN: 'tool', API_TOKEN: 't0k' } }).servers;
  assert.equal(x.command, 'tool');
  assert.deepEqual(x.args, ['--root', '/fallback']);
  assert.deepEqual(x.env, { TOKEN: 't0k', FIXED: 'plain' });
  assert.equal(x.missingEnv, undefined);
  assert.deepEqual(y.missingEnv, ['MISSING_ONE', 'MISSING_TWO']);
});

test('the expander leaves text without a variable alone, and an empty value falls back to the default', () => {
  const missing = new Set();
  assert.equal(_expand('plain $HOME text', {}, missing), 'plain $HOME text');
  assert.equal(_expand('${A:-d}', { A: '' }, missing), 'd');
  assert.equal(_expand('x${A}y', { A: '' }, missing), 'xy', 'a set-but-empty variable is empty, not missing');
  assert.equal(missing.size, 0);
});

test('a missing or broken config file lists nothing and does not throw', (t) => {
  const f = fixture();
  t.after(f.cleanup);
  fs.writeFileSync(f.configFile, '{ not json');
  assert.deepEqual(f.list({ projectPath: f.project, env: {} }), { ok: true, servers: [] });
});
