'use strict';
// G2 (plan 789 T4): the card says what the launch does. One fixture list goes through the REAL
// `externalServersSource` + `composeMcpInjection` (Pi and pi-native through their session-resources path) for every
// registered backend and through `checkEntries`; per backend and entry "takes / reason" must equal "injected /
// dropped, why". The launch's why is read from the log lines it writes and from the emitted artefact, not from
// anything in the check module. A flipped declaration must fail the comparison (last test).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const backends = require('../src/backends');
const { composeMcpInjection, externalServersSource, externalServersFor } = require('../src/app/mcp-inject');
const { checkEntries } = require('../src/app/external-mcp-check');
const { resolveEnvRefs } = require('../src/backends/env-refs');
const { forgetListing } = require('../src/app/path-resolve');

const OWNER = '/proj/app';
const IDS = ['claude', 'claude-native', 'codex', 'agy', 'pi', 'pi-native', 'hermes'];

const APP_ENV = { SET_VAR: 'a-value', EMPTY_VAR: '' };
// A whole-value `$VAR` is a reference that spawn resolves against the app (`resolveEnvRefs`) and drops when the
// app lacks it; the launch side below does exactly that with the real function.
const BACKEND_ENV = {
  codex: { BE_VAR: 'b-value', REF_OK: '$SET_VAR', REF_GONE: '$NOT_IN_APP' },
  agy: { REF_GONE: '$NOT_IN_APP', REF_OK: '${SET_VAR}' },
};

const FIXTURE = [
  { name: 'plain', transport: 'stdio', command: 'node', args: ['s.js'] },
  { name: 'off', transport: 'stdio', command: 'node', enabled: false },
  { name: 'filtered', transport: 'stdio', command: 'node', backends: ['codex'] },
  { name: 'unsetarg', transport: 'stdio', command: 'node', args: ['${UNSET_VAR}'] },
  { name: 'defaulted', transport: 'stdio', command: 'node', args: ['${UNSET_VAR:-d}'] },
  { name: 'appvar', transport: 'stdio', command: 'node', args: ['${SET_VAR}'] },
  { name: 'backendvar', transport: 'stdio', command: 'node', env: { K: '${BE_VAR}' } },
  { name: 'remote', transport: 'http', url: 'https://example.invalid/mcp' },
  { name: 'remoteunset', transport: 'http', url: 'https://example.invalid/mcp', headers: { X: '${UNSET_VAR}' } },
  { name: 'withcwd', transport: 'stdio', command: 'node', cwd: 'sub' },
  { name: 'emptycwd', transport: 'stdio', command: 'node', cwd: '${EMPTY_VAR:-}' },
  { name: 'refok', transport: 'stdio', command: 'node', args: ['${REF_OK}'] },
  { name: 'refgone', transport: 'stdio', command: 'node', args: ['${REF_GONE}'] },
  { name: 'unsetcwd', transport: 'stdio', command: 'node', cwd: '${UNSET_VAR}/x' },
];

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function captureLog() {
  const lines = [];
  const push = (m) => lines.push(String(m));
  return { lines, log: { debug: push, info: push, warn: push, error: push } };
}

// Spawn's `quietSessionEnv`: the app's env, then the backend's bundle resolved by the real `resolveEnvRefs`.
const envFor = (id) => ({ ...APP_ENV, ...resolveEnvRefs(BACKEND_ENV[id] || {}, APP_ENV).env });

// The names an emitter actually kept, read from the artefact the CLI would read.
function keptNames(backend, got, cwd) {
  if (!got) return [];
  if (backend.id === 'codex') {
    const names = new Set();
    for (const a of got.args) {
      const m = /^mcp_servers\.([A-Za-z0-9_-]+)\.(command|url)=/.exec(a);
      if (m) names.add(m[1]);
    }
    return [...names];
  }
  let file;
  if (backend.id === 'agy') {
    const root = path.join(cwd, '.agents', 'plugins');
    const bundle = fs.readdirSync(root).find((n) => n.startsWith('switchboard-'));
    file = path.join(root, bundle, 'mcp_config.json');
  } else {
    file = got.args[got.args.indexOf('--mcp-config') + 1];
  }
  return Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers);
}

// -> { injected: Set<name>, why: Map<name, reason>, lines }
async function launch(id) {
  const backend = backends.get(id);
  const { lines, log } = captureLog();
  const getSetting = (k) => (k === 'project:' + OWNER ? { externalMcpServers: FIXTURE } : {});
  const source = externalServersSource({ backend, getSetting, projectPath: OWNER, getEnv: () => envFor(id), log });
  const dir = tmp('sb-agree-dir-');
  const cwd = tmp('sb-agree-cwd-');
  let injected = [];
  try {
    if (backend.providesMcpInjection === true) {
      const got = await composeMcpInjection({ backend, ctx: { log }, sources: [source], dir, tag: 't', cwd });
      try { injected = keptNames(backend, got, cwd); } finally { if (got) got.release(); }
    } else if (backend.providesSessionResources === true) {
      const built = await backend.buildSessionResources({ dir, tag: 't', options: {}, externalServers: source, log });
      injected = built ? built.mcpServers.map((m) => m.name) : [];
      if (built && built.cleanup) backend.releaseSessionResources(built.cleanup, log);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  const why = new Map();
  for (const l of lines) {
    let m;
    if ((m = /skipped external server "([^"]+)": unset variable/.exec(l))) why.set(m[1], 'unset-variable');
    else if ((m = /dropped server "([^"]+)": transport/.exec(l))) why.set(m[1], 'transport');
    else if ((m = /external MCP server "([^"]+)" not given to Pi: only stdio/.exec(l))) why.set(m[1], 'transport');
    else if ((m = /external MCP server "([^"]+)" not given to Pi: a working directory/.exec(l))) why.set(m[1], 'cwd');
    else if ((m = /declined "([^"]+)": .*cwd/.exec(l))) why.set(m[1], 'cwd');
  }
  // Silent drops are the entry's own filter: the real function lists what survives it.
  const meant = new Set(externalServersFor({ backend, getSetting, projectPath: OWNER }).map((s) => s.name));
  for (const e of FIXTURE) {
    if (meant.has(e.name) || why.has(e.name)) continue;
    why.set(e.name, e.enabled === false ? 'entry-disabled' : 'backend-filter');
  }
  return { injected: new Set(injected), why, lines, backend };
}

// Every mismatch between the launch and the check, as readable strings (empty = they agree).
async function mismatches(overrides = {}) {
  forgetListing();
  const descriptors = IDS.map((id) => {
    const real = backends.get(id);
    return { ...real, enabled: true, status: 'ready', ...(overrides[id] || {}) };
  });
  const results = await checkEntries(FIXTURE, {
    projectPath: OWNER, env: { ...APP_ENV, PATH: '' }, backendEnv: BACKEND_ENV, backends: descriptors, platform: 'linux',
    fs: { promises: { readdir: async () => [], stat: async () => ({ isDirectory: () => false }) } },
  });
  const out = [];
  for (const id of IDS) {
    const run = await launch(id);
    FIXTURE.forEach((entry, i) => {
      const row = results[i].takes.find((t) => t.id === id);
      const taken = run.injected.has(entry.name);
      if (row.takes !== taken) out.push(`${id}/${entry.name}: check says ${row.takes}, launch ${taken}`);
      else if (!taken) {
        const expected = run.backend.externalMcpTakes === null ? null : run.why.get(entry.name);
        // A backend with no channel logs nothing; the check says why with its own code.
        if (expected !== null && row.reason !== expected) out.push(`${id}/${entry.name}: check reason ${row.reason}, launch ${expected}`);
        if (expected === null && !['no-channel', 'entry-disabled', 'backend-filter'].includes(row.reason)) out.push(`${id}/${entry.name}: no-channel backend gave ${row.reason}`);
      } else if (row.reason !== null) out.push(`${id}/${entry.name}: taken but reason ${row.reason}`);
    });
  }
  return out;
}

test('G2: the check and the real launch agree for every backend and every fixture entry', async () => {
  assert.deepEqual(await mismatches(), []);
});

test('G2: the launch log lines carry no value', async () => {
  for (const id of IDS) {
    const run = await launch(id);
    assert.ok(!run.lines.join('\n').includes('a-value'), id);
    assert.ok(!run.lines.join('\n').includes('b-value'), id);
  }
});

test('G2: the fixture exercises every reason the card can give', async () => {
  const seen = new Set();
  for (const id of IDS) for (const [, why] of (await launch(id)).why) seen.add(why);
  for (const r of ['entry-disabled', 'backend-filter', 'unset-variable', 'transport', 'cwd']) assert.ok(seen.has(r), r);
});

test('G2: a deliberate disagreement fails the comparison', async () => {
  const claude = backends.get('claude');
  const flipped = { ...claude.externalMcpTakes, cwd: true };
  const diff = await mismatches({ claude: { externalMcpTakes: flipped } });
  assert.ok(diff.some((d) => d.startsWith('claude/withcwd')), diff.join('\n'));
  const pi = backends.get('pi');
  const diff2 = await mismatches({ pi: { externalMcpTakes: { ...pi.externalMcpTakes, transports: ['stdio', 'http'] } } });
  assert.ok(diff2.some((d) => d.startsWith('pi/remote')), diff2.join('\n'));
});
