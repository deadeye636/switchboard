'use strict';
// Pi 1.5.1 warms its own prompt cache between runs (#861): when that holds, pi-native leaves the refresh to Pi.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cw = require('../src/backends/pi/cache-warming');
const piNative = require('../src/backends/pi-native');

const PKG = '@earendil-works/pi-coding-agent';

// A fake npm layout under the temp dir: <root>/bin/pi.cmd beside <root>/bin/node_modules/<pkg>/package.json.
function fakePi(version, settings) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pi-warm-'));
  const bin = path.join(root, 'bin');
  const pkg = path.join(bin, 'node_modules', PKG);
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(bin, 'pi.cmd'), '');
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: PKG, version }));
  const dir = path.join(root, 'agent');
  fs.mkdirSync(dir);
  if (settings !== undefined) fs.writeFileSync(path.join(dir, 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings));
  return { root, exe: path.join(bin, 'pi.cmd'), dir };
}

test('the mode is the global setting, the default idle when unset or not a known value', (t) => {
  const none = fakePi('1.5.2');
  t.after(() => fs.rmSync(none.root, { recursive: true, force: true }));
  assert.equal(cw.warmingMode(none.dir), 'idle');
  for (const [settings, want] of [[{ cacheWarming: 'off' }, 'off'], [{ cacheWarming: 'streaming' }, 'streaming'], [{ cacheWarming: 'idle' }, 'idle'], [{ cacheWarming: 'sometimes' }, 'idle'], ['not json', 'idle']]) {
    const p = fakePi('1.5.2', settings);
    t.after(() => fs.rmSync(p.root, { recursive: true, force: true }));
    assert.equal(cw.warmingMode(p.dir), want, JSON.stringify(settings));
  }
});

test('Pi warms between runs from 1.5.1 with the mode idle, and not otherwise', (t) => {
  const cases = [
    ['1.5.2', undefined, true], ['1.5.1', { cacheWarming: 'idle' }, true], ['1.6.0', undefined, true], ['2.0.0', undefined, true],
    ['1.5.0', undefined, false], ['1.4.9', { cacheWarming: 'idle' }, false],
    ['1.5.2', { cacheWarming: 'off' }, false], ['1.5.2', { cacheWarming: 'streaming' }, false],
  ];
  for (const [version, settings, want] of cases) {
    cw.resetCache();
    const p = fakePi(version, settings);
    t.after(() => fs.rmSync(p.root, { recursive: true, force: true }));
    assert.equal(cw.runtimeWarmsIdle({ exe: p.exe, dir: p.dir }), want, `${version} ${JSON.stringify(settings)}`);
  }
});

test('an unreadable version or no binary says nothing, so Switchboard keeps its own refresh', () => {
  cw.resetCache();
  assert.equal(cw.runtimeWarmsIdle({ exe: null }), false);
  assert.equal(cw.runtimeWarmsIdle({ exe: path.join(os.tmpdir(), 'sb-no-such-pi.cmd') }), false);
});

test('pi-native answers warm false and says whose job it is only when Pi does it', (t) => {
  cw.resetCache();
  const on = fakePi('1.5.2');
  const old = fakePi('1.5.0');
  t.after(() => { fs.rmSync(on.root, { recursive: true, force: true }); fs.rmSync(old.root, { recursive: true, force: true }); });
  const by = piNative.idleMaintenance({ exe: on.exe, dir: on.dir });
  assert.equal(by.warm, false);
  assert.equal(by.compact, true);
  assert.equal(by.warmBy, 'runtime');
  assert.match(by.warmNote, /done by Pi/);
  assert.equal(by.maxRefreshMs, 270000);
  const ours = piNative.idleMaintenance({ exe: old.exe, dir: old.dir });
  assert.equal(ours.warm, true);
  assert.equal('warmBy' in ours, false);
});

test('pi-native reads the agent directory of the session\'s own environment', (t) => {
  cw.resetCache();
  const p = fakePi('1.5.2');
  const other = fakePi('1.5.2', { cacheWarming: 'off' });
  t.after(() => { fs.rmSync(p.root, { recursive: true, force: true }); fs.rmSync(other.root, { recursive: true, force: true }); });
  assert.equal(piNative.idleMaintenance({ exe: p.exe, env: { PI_CODING_AGENT_DIR: p.dir } }).warmBy, 'runtime');
  assert.equal(piNative.idleMaintenance({ exe: p.exe, env: { PI_CODING_AGENT_DIR: other.dir } }).warm, true, 'a profile with warming off is refreshed from here');
});

test('the answer is remembered briefly: a busy/idle edge reads no file when nothing changed', (t) => {
  cw.resetCache();
  const p = fakePi('1.5.2');
  t.after(() => { cw.resetCache(); fs.rmSync(p.root, { recursive: true, force: true }); });
  assert.equal(cw.runtimeWarmsIdle({ exe: p.exe, dir: p.dir }), true);
  const real = fs.readFileSync;
  const statReal = fs.statSync;
  let reads = 0;
  fs.readFileSync = (...a) => { reads++; return real(...a); };
  fs.statSync = (...a) => { reads++; return statReal(...a); };
  try {
    for (let i = 0; i < 5; i++) assert.equal(cw.runtimeWarmsIdle({ exe: p.exe, dir: p.dir }), true);
    assert.equal(reads, 0, 'served from memory');
    fs.writeFileSync(path.join(p.dir, 'settings.json'), JSON.stringify({ cacheWarming: 'off' }));
    assert.equal(cw.runtimeWarmsIdle({ exe: p.exe, dir: p.dir }), true, 'a change is seen after the memo runs out');
    cw.resetCache();
    assert.equal(cw.runtimeWarmsIdle({ exe: p.exe, dir: p.dir }), false);
    assert.ok(reads > 0);
  } finally { fs.readFileSync = real; fs.statSync = statReal; }
});
