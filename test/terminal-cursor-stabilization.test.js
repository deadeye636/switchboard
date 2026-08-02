'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCursorStabilizer, HIDE_CURSOR, SHOW_CURSOR } = require('../src/renderer/terminal/cursor-stabilization');

function harness() {
  let nextId = 1;
  const timers = new Map();
  const cleared = [];
  const controls = [];
  const stabilizer = createCursorStabilizer({
    settleMs: 80,
    setTimer(fn, ms) { const id = nextId++; timers.set(id, { fn, ms }); return id; },
    clearTimer(id) { cleared.push(id); timers.delete(id); },
    writeControl(control) { controls.push(control); },
  });
  return { stabilizer, timers, cleared, controls, run(id) { const t = timers.get(id); timers.delete(id); t.fn(); } };
}

test('only the two measured split-cursor TUIs opt into stabilization', () => {
  const backends = require('../src/backends').list().filter(b => b.status === 'ready' && !b.isProfile);
  const settled = backends.filter(b => b.cursorUpdatePolicy === 'settle').map(b => b.id).sort();
  assert.deepEqual(settled, ['codex', 'pi']);
  for (const backend of backends) {
    assert.ok(backend.cursorUpdatePolicy === undefined || backend.cursorUpdatePolicy === 'settle',
      `${backend.id}: unknown cursorUpdatePolicy`);
  }

  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(main, /cursorUpdatePolicy:\s*b\.cursorUpdatePolicy/,
    'the descriptor policy must cross backends-list IPC');
  const registry = fs.readFileSync(path.join(__dirname, '..', 'src', 'backends', 'index.js'), 'utf8');
  assert.match(registry, /cursorUpdatePolicy:\s*base\s*\?\s*base\.cursorUpdatePolicy/,
    'a template must inherit the cursor behaviour of its base binary');
  const manager = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'terminal', 'terminal-manager.js'), 'utf8');
  assert.match(manager, /function writeTerminalOutput[\s\S]*ensureCursorStabilizer\(entry\)/,
    'every TUI output write must resolve the policy lazily, because backend caches race restored terminals at boot');
});

test('a TUI update cannot leave its intermediate hardware cursor visible', () => {
  const h = harness();
  const data = '\x1b[?25l\x1b[9;2Hupdate\x1b[?25h';
  assert.equal(h.stabilizer.wrap(data), HIDE_CURSOR + data + HIDE_CURSOR);
  assert.equal(h.stabilizer.wantedVisible(), true, 'the application still owns the final visibility');
  h.stabilizer.parsed();
  const [[id, timer]] = h.timers;
  assert.equal(timer.ms, 80);
  h.run(id);
  assert.deepEqual(h.controls, [SHOW_CURSOR], 'the cursor returns only after output settles');
});

test('Pi final hide remains authoritative after the burst settles', () => {
  const h = harness();
  h.stabilizer.wrap('\x1b[?25hdraw\x1b[?25l');
  assert.equal(h.stabilizer.wantedVisible(), false);
  h.stabilizer.parsed();
  const [id] = h.timers.keys();
  h.run(id);
  assert.deepEqual(h.controls, [HIDE_CURSOR]);
});

test('new output cancels the pending cursor reveal', () => {
  const h = harness();
  h.stabilizer.wrap('\x1b[?25h');
  h.stabilizer.parsed();
  const [first] = h.timers.keys();
  h.stabilizer.wrap('next frame');
  assert.ok(h.cleared.includes(first));
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.controls, []);
});

test('cursor visibility follows the last sequence in a coalesced chunk', () => {
  const h = harness();
  h.stabilizer.wrap('\x1b[?25lfirst\x1b[?25hsecond\x1b[?25l');
  assert.equal(h.stabilizer.wantedVisible(), false);
});

test('dispose prevents a delayed write into a dead terminal', () => {
  const h = harness();
  h.stabilizer.wrap('\x1b[?25h');
  h.stabilizer.parsed();
  const [id] = h.timers.keys();
  h.stabilizer.dispose();
  assert.ok(h.cleared.includes(id));
  assert.equal(h.timers.size, 0);
});
