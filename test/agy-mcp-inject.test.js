'use strict';
// agy's per-spawn MCP channel (spec 34, plan 333 T8): a workspace plugin bundle under the project's
// `.agents/`, one dir per session, one shared plugins.json. The user's shared agy config is never written.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const agy = require('../src/backends/agy');
const { sweepStaleBundles } = require('../src/backends/agy/mcp-inject');

const TOKEN = 'tok-0123456789abcdef';
const ROW = { name: 'switchboard', transport: 'http', url: 'http://127.0.0.1:4711/mcp', headers: { Authorization: `Bearer ${TOKEN}` } };

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mcp-')); }
function pluginsRoot(cwd) { return path.join(cwd, '.agents', 'plugins'); }
function bundles(cwd) { return fs.readdirSync(pluginsRoot(cwd)).filter(n => n.startsWith('switchboard-')); }

test('agy declares the hook quartet', () => {
  assert.equal(agy.providesMcpInjection, true);
  assert.deepEqual(agy.acceptsMcpTransports, ['http']);
  assert.equal(typeof agy.buildMcpInjection, 'function');
  assert.equal(typeof agy.releaseMcpInjection, 'function');
});

test('declines without servers or cwd', () => {
  const cwd = tmp();
  assert.equal(agy.buildMcpInjection({ cwd, servers: [] }), null);
  assert.equal(agy.buildMcpInjection({ servers: [ROW] }), null);
  assert.equal(fs.existsSync(path.join(cwd, '.agents')), false);
});

test('writes the bundle under cwd, token only in the file, never in argv or env; real config untouched', () => {
  const cwd = tmp();
  const home = tmp();
  const cfg = path.join(home, '.gemini', 'config', 'mcp_config.json');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, '{"mcpServers":{}}');
  const past = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(cfg, past, past);
  const before = { bytes: fs.readFileSync(cfg), mtime: fs.statSync(cfg).mtimeMs };

  const writes = [];
  const realWrite = fs.writeFileSync;
  const realOpen = fs.openSync;
  fs.writeFileSync = function (p, ...rest) { writes.push(String(p)); return realWrite.call(this, p, ...rest); };
  fs.openSync = function (p, ...rest) { writes.push(String(p)); return realOpen.call(this, p, ...rest); };
  let out;
  try {
    out = agy.buildMcpInjection({ dir: home, tag: 'abc123', cwd, servers: [ROW], options: {}, log: {} });
  } finally {
    fs.writeFileSync = realWrite;
    fs.openSync = realOpen;
  }
  assert.ok(out);
  assert.deepEqual(out.args, []);
  assert.deepEqual(out.env, {});
  assert.ok(!JSON.stringify(out.args).includes(TOKEN) && !JSON.stringify(out.env).includes(TOKEN));

  // (a) no write to an mcp_config.json outside the per-spawn plugin location; the real file is byte/mtime identical
  const sep = path.sep;
  for (const p of writes.filter(w => w.endsWith('mcp_config.json'))) {
    assert.ok(p.startsWith(pluginsRoot(cwd) + sep), `mcp_config.json written outside .agents/plugins: ${p}`);
  }
  assert.ok(writes.some(w => w.endsWith('mcp_config.json')), 'the probe must have seen the write');
  assert.ok(before.bytes.equals(fs.readFileSync(cfg)));
  assert.equal(fs.statSync(cfg).mtimeMs, before.mtime);
  assert.deepEqual(fs.readdirSync(home), ['.gemini']);

  const [name] = bundles(cwd);
  const bundle = path.join(pluginsRoot(cwd), name);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(bundle, 'plugin.json'), 'utf8')), { name, version: '0.0.1' });
  const conf = JSON.parse(fs.readFileSync(path.join(bundle, 'mcp_config.json'), 'utf8'));
  assert.deepEqual(conf, { mcpServers: { switchboard: { type: 'http', url: ROW.url, headers: { Authorization: `Bearer ${TOKEN}` } } } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, '.agents', 'plugins.json'), 'utf8')), { entries: [{ path: '.agents/plugins' }] });

  // (c) owner-only where the platform has modes
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(bundle, 'mcp_config.json')).mode & 0o077, 0);
  }
});

test('two sessions in one project get distinct bundles under one plugins.json; release removes only its own', () => {
  const cwd = tmp();
  const a = agy.buildMcpInjection({ tag: 'same', cwd, servers: [ROW] });
  const b = agy.buildMcpInjection({ tag: 'same', cwd, servers: [ROW] });
  assert.ok(a && b);
  assert.notEqual(a.cleanup.bundle, b.cleanup.bundle);
  assert.equal(bundles(cwd).length, 2);
  const pj = path.join(cwd, '.agents', 'plugins.json');
  const pjBytes = fs.readFileSync(pj);

  agy.releaseMcpInjection(a.cleanup, {});
  assert.equal(fs.existsSync(a.cleanup.bundle), false);
  assert.equal(fs.existsSync(b.cleanup.bundle), true);
  assert.ok(pjBytes.equals(fs.readFileSync(pj)));
  agy.releaseMcpInjection(a.cleanup, {});   // idempotent
  agy.releaseMcpInjection(b.cleanup, {});
  assert.equal(bundles(cwd).length, 0);
  assert.ok(fs.existsSync(pj));
});

test('an existing plugins.json gets the entry added; an unparseable one is left alone and the hook declines', () => {
  const cwd = tmp();
  fs.mkdirSync(path.join(cwd, '.agents'));
  const pj = path.join(cwd, '.agents', 'plugins.json');
  fs.writeFileSync(pj, JSON.stringify({ entries: [{ path: 'other' }] }));
  const out = agy.buildMcpInjection({ tag: 't', cwd, servers: [ROW] });
  assert.ok(out);
  assert.deepEqual(JSON.parse(fs.readFileSync(pj, 'utf8')).entries, [{ path: 'other' }, { path: '.agents/plugins' }]);

  const cwd2 = tmp();
  fs.mkdirSync(path.join(cwd2, '.agents'));
  fs.writeFileSync(path.join(cwd2, '.agents', 'plugins.json'), '{ nope');
  assert.equal(agy.buildMcpInjection({ tag: 't', cwd: cwd2, servers: [ROW] }), null);
  assert.equal(fs.readFileSync(path.join(cwd2, '.agents', 'plugins.json'), 'utf8'), '{ nope');
  assert.equal(fs.existsSync(pluginsRoot(cwd2)) ? bundles(cwd2).length : 0, 0);
});

test('the sweep removes only a dead process\'s bundle', () => {
  const cwd = tmp();
  const live = agy.buildMcpInjection({ tag: 'live', cwd, servers: [ROW] });
  const dead = agy.buildMcpInjection({ tag: 'dead', cwd, servers: [ROW] });
  const stranger = path.join(pluginsRoot(cwd), 'user-plugin');
  fs.mkdirSync(stranger);
  const noRecord = path.join(pluginsRoot(cwd), 'switchboard-norecord');
  fs.mkdirSync(noRecord);
  // a pid that is not running: spawn-and-wait is overkill; use a very high pid and confirm it is dead
  let deadPid = 2147483000;
  while (true) { try { process.kill(deadPid, 0); deadPid--; } catch (e) { if (e.code === 'ESRCH') break; deadPid--; } }
  fs.writeFileSync(path.join(dead.cleanup.bundle, '.switchboard-owner'), JSON.stringify({ pid: deadPid }));

  const removed = sweepStaleBundles([cwd, path.join(cwd, 'missing')], {});
  assert.equal(removed.length, 1);
  assert.equal(path.basename(dead.cleanup.bundle), removed[0]);
  assert.equal(fs.existsSync(dead.cleanup.bundle), false);
  assert.equal(fs.existsSync(live.cleanup.bundle), true);
  assert.equal(fs.existsSync(stranger), true);
  assert.equal(fs.existsSync(noRecord), true);
});

test('a build sweeps a dead sibling in the same project (orphan reclaimed on next launch)', () => {
  const cwd = tmp();
  const dead = agy.buildMcpInjection({ tag: 'dead', cwd, servers: [ROW] });
  let deadPid = 2147483000;
  while (true) { try { process.kill(deadPid, 0); deadPid--; } catch (e) { if (e.code === 'ESRCH') break; deadPid--; } }
  fs.writeFileSync(path.join(dead.cleanup.bundle, '.switchboard-owner'), JSON.stringify({ pid: deadPid }));
  assert.equal(bundles(cwd).length, 1);

  const fresh = agy.buildMcpInjection({ tag: 'fresh', cwd, servers: [ROW] });
  assert.ok(fresh);
  assert.equal(fs.existsSync(dead.cleanup.bundle), false);   // the new build swept the dead sibling
  assert.equal(fs.existsSync(fresh.cleanup.bundle), true);
  assert.equal(bundles(cwd).length, 1);
});
