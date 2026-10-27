'use strict';
// #797: the VCS heartbeat reads the settings once a second. It must stop at `before-quit`, or a tick that fires
// after `will-quit` closed the database throws "The database connection is not open" (the #76 class).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripComments } = require('./helpers/strip-comments');

const vcs = require('../src/app/vcs');

test('stop() ends the heartbeat: no settings read after it', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let reads = 0;
  vcs.init({ getSetting: () => { reads++; return { vcsChipEnabled: false }; }, log: { debug() {} } });
  t.mock.timers.tick(3000);
  assert.ok(reads >= 3, `the heartbeat reads the settings while it runs (${reads})`);
  vcs.stop();
  const before = reads;
  t.mock.timers.tick(5000);
  assert.equal(reads, before, 'nothing ticks after stop()');
  vcs.stop(); // a second stop is harmless
});

test('after stop() nothing reads the settings: an in-flight poll or a late vcs-watch gets "off"', () => {
  let reads = 0;
  vcs.init({ getSetting: () => { reads++; return {}; }, log: { debug() {} } });
  vcs.stop();
  const cfg = vcs._readConfig();
  assert.equal(reads, 0, 'the closed database is not asked');
  assert.equal(cfg.enabled, false);
  assert.ok(cfg.pollMs > 0, 'a poll that finishes now still gets a finite next due time');
  vcs.init({ getSetting: () => { reads++; return {}; }, log: { debug() {} } });
  assert.equal(vcs._readConfig().enabled, true, 'a fresh init reads again');
  vcs.stop();
});

test('the quit path stops it: main hands stopVcsPoll to the lifecycle, and before-quit calls it', () => {
  const src = (rel) => stripComments(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));
  assert.match(src('src/main.js'), /stopVcsPoll:\s*\(\)\s*=>\s*vcsPoll\.stop\(\)/);
  const lifecycle = src('src/app/lifecycle.js');
  const beforeQuit = lifecycle.indexOf("'before-quit'");
  const willQuit = lifecycle.indexOf("'will-quit'");
  const call = lifecycle.indexOf('ctx.stopVcsPoll');
  assert.ok(beforeQuit >= 0 && willQuit > beforeQuit, 'both quit handlers are found');
  assert.ok(call > beforeQuit && call < willQuit, 'stopVcsPoll runs in before-quit, before the database closes');
});
