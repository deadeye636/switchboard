// Pins each backend's `externalMcpTakes` declaration (spec 36, plan 789 T3) against the REAL emitter: a stdio
// entry with a `cwd`, an http entry and a plain stdio entry go through the path the spawn takes, and what comes
// out must match what the descriptor says it takes. Claude, claude-native, Codex and agy go through
// `composeMcpInjection`; Pi and pi-native take servers through `buildSessionResources` (no quartet); Hermes has
// no channel. A flipped declaration fails here, which is the point.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const backends = require('../src/backends');
const { composeMcpInjection } = require('../src/app/mcp-inject');

// A plain array, deliberately NOT `externalServersSource`: a source marked `external` has its rows filtered by the
// declaration in the composer (spec 37, O8), and this test would then compare the declaration with itself instead
// of with what each real emitter does.
const ROWS = [
  { name: 'withcwd', transport: 'stdio', command: 'node', args: ['server.js'], env: {}, cwd: 'sub' },
  { name: 'remote', transport: 'http', url: 'https://example.invalid/mcp', headers: {} },
  { name: 'plain', transport: 'stdio', command: 'node', args: ['server.js'], env: {} },
];

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Reads what the emitter kept as `{ name: { transport, cwd } }`, from the artefact the CLI would read.
function keptByQuartet(backend) {
  const dir = tmp('sb-ext-dir-');
  const cwd = tmp('sb-ext-cwd-');
  const log = { debug() {}, info() {}, warn() {} };
  let injection = null;
  try {
    return composeMcpInjection({ backend, ctx: { log }, sources: [ROWS], dir, tag: 't', cwd }).then((got) => {
      injection = got;
      const kept = {};
      if (!got) return kept;
      if (backend.id === 'codex') {
        for (let i = 0; i < got.args.length; i++) {
          const m = /^mcp_servers\.([A-Za-z0-9_-]+)\.(command|url|cwd)=/.exec(got.args[i]);
          if (!m) continue;
          kept[m[1]] = kept[m[1]] || { transport: null, cwd: false };
          if (m[2] === 'command') kept[m[1]].transport = 'stdio';
          if (m[2] === 'url') kept[m[1]].transport = 'http';
          if (m[2] === 'cwd') kept[m[1]].cwd = true;
        }
        return kept;
      }
      let file;
      if (backend.id === 'agy') {
        const root = path.join(cwd, '.agents', 'plugins');
        const bundle = fs.readdirSync(root).find((n) => n.startsWith('switchboard-'));
        file = path.join(root, bundle, 'mcp_config.json');
      } else {
        file = got.args[got.args.indexOf('--mcp-config') + 1];
      }
      const servers = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers;
      for (const [name, e] of Object.entries(servers)) {
        kept[name] = { transport: e.url ? 'http' : 'stdio', cwd: e.cwd !== undefined };
      }
      return kept;
    }).finally(() => {
      if (injection) injection.release();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    });
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
    throw err;
  }
}

async function keptByPi(backend) {
  const dir = tmp('sb-ext-pi-');
  const log = { debug() {}, info() {}, warn() {} };
  let built = null;
  try {
    built = await backend.buildSessionResources({ dir, tag: 't', options: {}, externalServers: () => ROWS, log });
    const names = built ? built.mcpServers.map((m) => m.name) : [];
    const kept = {};
    for (const row of ROWS) if (names.includes(row.name)) kept[row.name] = { transport: row.transport, cwd: row.cwd !== undefined };
    return kept;
  } finally {
    if (built && built.cleanup) backend.releaseSessionResources(built.cleanup, log);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// What the declaration implies for the three fixture rows.
function expectedFor(takes) {
  const out = {};
  for (const row of ROWS) {
    if (!takes.transports.includes(row.transport)) continue;
    if (row.cwd !== undefined && !takes.cwd) continue;
    out[row.name] = { transport: row.transport, cwd: row.cwd !== undefined };
  }
  return out;
}

for (const id of ['claude', 'claude-native', 'codex', 'agy']) {
  test(`${id}: externalMcpTakes matches what its injection emitter keeps`, async () => {
    const backend = backends.get(id);
    assert.ok(backend.externalMcpTakes, `${id} declares externalMcpTakes`);
    assert.deepEqual(await keptByQuartet(backend), expectedFor(backend.externalMcpTakes));
  });
}

for (const id of ['pi', 'pi-native']) {
  test(`${id}: externalMcpTakes matches what the resources extension keeps`, async () => {
    const backend = backends.get(id);
    assert.ok(backend.externalMcpTakes, `${id} declares externalMcpTakes`);
    assert.deepEqual(await keptByPi(backend), expectedFor(backend.externalMcpTakes));
  });
}

test('hermes: null means no channel at all', async () => {
  const backend = backends.get('hermes');
  assert.equal(backend.externalMcpTakes, null);
  assert.notEqual(backend.providesMcpInjection, true);
  assert.notEqual(backend.providesSessionResources, true);
  const log = { debug() {}, info() {}, warn() {} };
  assert.equal(await composeMcpInjection({ backend, ctx: { log }, sources: [ROWS], dir: os.tmpdir(), tag: 't', cwd: os.tmpdir() }), null);
});

test('the declarations differ where the emitters differ (the fixture can tell them apart)', () => {
  assert.deepEqual(expectedFor({ transports: ['stdio', 'http'], cwd: true }), {
    withcwd: { transport: 'stdio', cwd: true }, remote: { transport: 'http', cwd: false }, plain: { transport: 'stdio', cwd: false },
  });
  assert.deepEqual(Object.keys(expectedFor({ transports: ['stdio'], cwd: false })), ['plain']);
});
