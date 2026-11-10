'use strict';
// The schedule in src/app/idle-maintenance.js (spec 45, #827), on a fake clock and a fake session handle.
const test = require('node:test');
const assert = require('node:assert/strict');

const idle = require('../src/app/idle-maintenance');

const MIN = 60000;
const PI_LIKE = { cacheClass: '5m', maxRefreshMs: 270000, warm: true, compact: true, callsCold: true };
const CLAUDE_LIKE = { cacheClass: '1h', maxRefreshMs: 50 * MIN, warm: true, compact: true, callsCold: false };

function setup(settings, { answer = PI_LIKE, usageAfter = () => ({ input: 10, read: 5000, write: 10 }) } = {}) {
  let time = 1000;
  let timers = [];
  const sent = [];
  const records = [];
  const notes = [];
  let open = true;
  let usage = { input: 10, read: 5000, write: 10 };
  const handle = {
    tag: 't1',
    projectPath: 'p',
    sessionId: () => 's1',
    open: () => open,
    busy: () => false,
    linesSent: () => 0,
    usage: () => usage,
    maintain: async ({ action }) => {
      sent.push(action);
      return { ok: true, endsBy: action === 'warm' ? 'idle' : 'answer', key: action === 'warm' ? 'k' : null, text: action === 'warm' ? 'warm text' : null };
    },
  };
  idle.init({
    now: () => time,
    setTimer: (fn, ms) => { const t = { fn, at: time + ms }; timers.push(t); return t; },
    clearTimer: (t) => { timers = timers.filter((x) => x !== t); },
    effectiveSettings: () => ({ idleMaintenanceMode: 'off', ...settings }),
    capabilityOf: () => answer,
    recordMaintenance: (r) => records.push(r),
    recordLifecycle: (id, kind, label, detail) => notes.push({ kind, label, detail }),
    log: { info() {}, warn() {} },
  });
  const edge = (e, quiet = false) => idle.track({ edge: e, handle, quiet });
  // Run the clock to the next timer, its action, and the quiet edges a warm turn would bring.
  const step = async () => {
    const next = timers.sort((a, b) => a.at - b.at)[0];
    if (!next) return false;
    timers = timers.filter((t) => t !== next);
    time = Math.max(time, next.at);
    const before = sent.length;
    await next.fn();
    await Promise.resolve();
    if (sent.length > before && sent.at(-1) === 'warm') { usage = usageAfter(sent.length); edge('idle', true); }
    return true;
  };
  // A real turn of the user's: its busy edge, a model call, its idle edge.
  const realTurn = () => { edge('busy'); usage = { input: 10, read: 5000, write: 10 }; edge('idle'); };
  const advance = (ms) => { time += ms; };
  return { edge, step, realTurn, advance, sent, records, notes, timers: () => timers, setOpen: (v) => { open = v; }, time: () => time, handle };
}

test('off does nothing, and a declining backend does nothing whatever the setting', async (t) => {
  t.after(() => idle.stop());
  const off = setup({});
  off.edge('idle');
  assert.equal(off.timers().length, 0);
  const declined = setup({ idleMaintenanceMode: 'warm' }, { answer: null });
  declined.edge('idle');
  assert.equal(declined.timers().length, 0);
  assert.equal(idle.getState('s1').declined, true);
});

test('keep warm sends the first refresh within the bound, stops at the limit, and a real turn starts over', async (t) => {
  t.after(() => idle.stop());
  const h = setup({ idleMaintenanceMode: 'warm', idleMaintenanceRefreshLimit: 2 });
  h.edge('idle');
  assert.equal(idle.getState('s1').nextAt, 1000 + 270000, 'the bound, not the 10 idle minutes (E14)');
  assert.equal(await h.step(), true);
  assert.equal(await h.step(), true);
  assert.deepEqual(h.sent, ['warm', 'warm']);
  assert.equal(await h.step(), false, 'the limit ended it');
  assert.equal(idle.getState('s1').ended, 'limit');
  h.realTurn();
  assert.equal(idle.getState('s1').refreshes, 0);
  assert.equal(await h.step(), true);
  assert.equal(h.sent.length, 3);
});

test('a cold verdict stays cold: an override or a late setting change sends nothing more', async (t) => {
  t.after(() => idle.stop());
  const settings = { idleMaintenanceMode: 'warm-compact', idleMaintenanceBestEffortCompact: true };
  const h = setup(settings, { usageAfter: () => ({ input: 10, read: 0, write: 4000 }) });
  h.realTurn();
  h.setOpen(true);
  await h.step();
  assert.deepEqual(h.sent, ['warm']);
  h.setOpen(false);
  await h.step();
  assert.equal(idle.getState('s1').nextAction, 'compact');
  idle.setOverride('s1', { idleMaintenanceCeilingMinutes: 200 });
  assert.equal(idle.getState('s1').nextAction, 'compact', 'not back to a refresh');
  settings.idleMaintenanceBestEffortCompact = false;
  h.setOpen(true);
  await h.step();
  assert.deepEqual(h.sent, ['warm']);
  assert.equal(idle.getState('s1').ended, 'cold');
});

test('a compaction held back past the bound is dropped unless best effort is allowed', async (t) => {
  t.after(() => idle.stop());
  const h = setup({ idleMaintenanceMode: 'warm-compact', idleMaintenanceRefreshLimit: 1 });
  h.realTurn();
  await h.step();
  h.setOpen(false);
  h.advance(30 * MIN);
  await h.step();
  assert.deepEqual(h.sent, ['warm']);
  assert.equal(idle.getState('s1').ended, 'late');
  idle.stop();

  const b = setup({ idleMaintenanceMode: 'warm-compact', idleMaintenanceRefreshLimit: 1, idleMaintenanceBestEffortCompact: true });
  b.realTurn();
  await b.step();
  b.advance(30 * MIN);
  await b.step();
  assert.deepEqual(b.sent, ['warm', 'compact']);
  assert.equal(b.notes.at(-1).label, 'Compacted while idle (best effort)');
});

test('a move in the middle of a turn starts no period on the new conversation', (t) => {
  t.after(() => idle.stop());
  const h = setup({ idleMaintenanceMode: 'warm' });
  h.handle.busy = () => true;
  h.edge('busy');
  h.edge('rekey');
  h.handle.busy = () => false;
  h.edge('idle');
  assert.equal(h.timers().length, 0);
});

test('a refused warm turn that begins after all starts nothing', async (t) => {
  t.after(() => idle.stop());
  const h = setup({ idleMaintenanceMode: 'warm' });
  h.handle.linesSent = () => 7;
  h.realTurn();
  const timer = h.timers()[0];
  h.advance(270000);
  h.handle.maintain = async () => ({ ok: false, reason: 'no answer', inPipe: true, endsBy: 'idle' });
  timer.fn();
  await new Promise((resolve) => setImmediate(resolve));
  h.edge('maintenance-ended');
  h.edge('busy');
  h.edge('idle');
  assert.equal(idle.getState('s1').ended, 'refused');
  assert.equal(h.timers().filter((x) => x !== timer).length, 0);
  h.handle.linesSent = () => 8;
  h.realTurn();
  assert.equal(idle.getState('s1').ended, null);
});

test('a line that reached no model does not move the clock or restart an ended period', async (t) => {
  t.after(() => idle.stop());
  const h = setup({ idleMaintenanceMode: 'warm', idleMaintenanceRefreshLimit: 1 });
  h.edge('busy');
  h.edge('idle');
  assert.equal(h.timers().length, 0, 'a first local command is no turn to keep warm');
  h.realTurn();
  const due = idle.getState('s1').nextAt;
  h.advance(60000);
  h.edge('busy');
  h.edge('idle');
  assert.equal(idle.getState('s1').nextAt, due, 'still measured from the real turn');
  await h.step();
  assert.equal(idle.getState('s1').ended, 'limit');
  h.edge('busy');
  h.edge('idle');
  assert.equal(idle.getState('s1').ended, 'limit');
  assert.equal(h.timers().length, 0);
});

test('a setting changed to off is seen before anything is spent', async (t) => {
  t.after(() => idle.stop());
  const settings = { idleMaintenanceMode: 'warm-compact' };
  const h = setup(settings);
  h.realTurn();
  settings.idleMaintenanceMode = 'off';
  await h.step();
  assert.deepEqual(h.sent, []);
  assert.equal(h.timers().length, 0);
});

test('a refresh past the bound is not sent: a machine asleep, or an override long after the last turn', async (t) => {
  t.after(() => idle.stop());
  const h = setup({ idleMaintenanceMode: 'warm' });
  h.realTurn();
  h.advance(2 * 3600000);
  await h.step();
  assert.deepEqual(h.sent, []);
  assert.equal(idle.getState('s1').ended, 'late');
  idle.stop();

  const o = setup({});
  o.realTurn();
  o.advance(2 * 3600000);
  idle.setOverride('s1', { idleMaintenanceMode: 'warm' });
  await o.step();
  assert.deepEqual(o.sent, []);
  assert.equal(idle.getState('s1').ended, 'late');
});

test('a change to an ended period starts nothing: no second compaction, no rebuilt cache', async (t) => {
  t.after(() => idle.stop());
  const h = setup({ idleMaintenanceMode: 'compact' });
  h.realTurn();
  await h.step();
  assert.deepEqual(h.sent, ['compact']);
  idle.setOverride('s1', { idleMaintenanceCeilingMinutes: 200 });
  assert.equal(h.timers().length, 0);
  assert.equal(idle.getState('s1').ended, 'compacted');
});

test('off during a running warm turn stops what would have followed it', async (t) => {
  t.after(() => idle.stop());
  const h = setup({ idleMaintenanceMode: 'warm' });
  h.realTurn();
  const timerFired = h.timers()[0];
  h.advance(270000);
  h.handle.maintain = async ({ action }) => { h.sent.push(action); idle.setOverride('s1', { idleMaintenanceMode: 'off' }); return { ok: true, endsBy: 'idle' }; };
  await timerFired.fn();
  h.edge('idle', true);
  assert.equal(idle.getState('s1').ended, 'off');
  assert.equal(h.timers().filter((x) => x !== timerFired).length, 0);
});

test('the ceiling ends a period', async (t) => {
  t.after(() => idle.stop());
  const h = setup({ idleMaintenanceMode: 'compact', idleMaintenanceCeilingMinutes: 5, idleMaintenanceIdleMinutes: 10 });
  h.realTurn();
  await h.step();
  assert.deepEqual(h.sent, []);
  assert.equal(idle.getState('s1').ended, 'ceiling');
});

test('a warm turn still in the pipe waits for its edge, and one that never began ends the wait', async (t) => {
  t.after(() => idle.stop());
  const h = setup({ idleMaintenanceMode: 'warm' });
  h.realTurn();
  h.handle.maintain = async () => ({ ok: false, reason: 'no answer', inPipe: true });
  const timer = h.timers()[0];
  h.advance(270000);
  await timer.fn();
  assert.equal(idle.getState('s1').running, 'warm');
  assert.equal(idle.getState('s1').ended, null);
  h.edge('maintenance-ended');
  assert.equal(idle.getState('s1').running, null);
  assert.equal(idle.getState('s1').ended, 'refused');
});

test('an idle edge while a held prompt\'s turn has begun starts no period', (t) => {
  t.after(() => idle.stop());
  const h = setup({ idleMaintenanceMode: 'warm' });
  h.handle.busy = () => true;
  h.realTurn();
  assert.equal(h.timers().length, 0);
});

test('a re-key drops what was planned for the last conversation', (t) => {
  t.after(() => idle.stop());
  const h = setup({ idleMaintenanceMode: 'warm' });
  h.realTurn();
  h.edge('rekey');
  assert.equal(h.timers().length, 0);
  assert.equal(idle.getState('s1').nextAction, null);
});

test('a session that has done nothing yet can hold an override, and reports it', (t) => {
  t.after(() => idle.stop());
  const h = setup({});
  h.edge('start');
  assert.equal(idle.setOverride('s1', { idleMaintenanceMode: 'warm' }).mode, 'warm');
  assert.equal(h.timers().length, 0, 'nothing to keep warm before a real turn');
  h.realTurn();
  assert.equal(h.timers().length, 1);
});

test('a compaction its idle edge ends is reported at that edge, not when it was written', async (t) => {
  t.after(() => idle.stop());
  const h = setup({ idleMaintenanceMode: 'compact' });
  h.handle.maintain = async ({ action }) => { h.sent.push(action); return { ok: true, endsBy: 'idle' }; };
  h.realTurn();
  await h.step();
  assert.equal(idle.getState('s1').running, 'compact');
  assert.equal(idle.getState('s1').ended, null);
  h.edge('idle', true);
  assert.equal(idle.getState('s1').ended, 'compacted');
});

test('a compaction to be ended by its idle edge whose turn never began ends as skipped, not running', async (t) => {
  t.after(() => idle.stop());
  const h = setup({ idleMaintenanceMode: 'compact' });
  h.handle.maintain = async ({ action }) => { h.sent.push(action); return { ok: true, endsBy: 'idle' }; };
  h.realTurn();
  await h.step();
  assert.equal(idle.getState('s1').running, 'compact');
  h.edge('maintenance-ended');
  assert.equal(idle.getState('s1').running, null);
  assert.equal(idle.getState('s1').ended, 'refused');
  assert.deepEqual(h.notes.at(-1), { kind: 'maintenance', label: 'Compaction skipped', detail: 'no turn began' });
});

test('a compaction ended by a re-key records nothing; the re-key clears it', async (t) => {
  t.after(() => idle.stop());
  const h = setup({ idleMaintenanceMode: 'compact' });
  h.handle.maintain = async ({ action }) => { h.sent.push(action); return { ok: true, endsBy: 'idle' }; };
  h.realTurn();
  await h.step();
  idle.track({ edge: 'maintenance-ended', handle: h.handle, quiet: false, cause: 'rekey' });
  assert.equal(h.notes.length, 0, 'no "skipped" line for a conversation that moved');
  h.edge('rekey');
  assert.equal(idle.getState('s1').running, null);
});

test('a compaction whose end came while its answer was out is skipped once the answer arrives', async (t) => {
  t.after(() => idle.stop());
  const h = setup({ idleMaintenanceMode: 'compact' });
  let open = true;
  h.handle.maintaining = () => open;
  h.handle.maintain = async ({ action }) => { h.sent.push(action); open = false; return { ok: true, endsBy: 'idle' }; };
  h.realTurn();
  await h.step();
  assert.equal(idle.getState('s1').running, null);
  assert.equal(idle.getState('s1').ended, 'refused');
  assert.deepEqual(h.notes.at(-1), { kind: 'maintenance', label: 'Compaction skipped', detail: 'no turn began' });
});

test('maintenance-ended while the answer is still out leaves the outcome to that answer', async (t) => {
  t.after(() => idle.stop());
  const h = setup({ idleMaintenanceMode: 'compact' });
  let answer;
  h.handle.maintain = ({ action }) => { h.sent.push(action); return new Promise((resolve) => { answer = resolve; }); };
  h.realTurn();
  const stepping = h.step();
  await Promise.resolve();
  h.edge('maintenance-ended');
  assert.equal(idle.getState('s1').ended, null, 'nothing recorded while the answer is out');
  answer({ ok: true, endsBy: 'answer' });
  await stepping;
  await Promise.resolve();
  assert.equal(idle.getState('s1').ended, 'compacted');
});

test('an interval past the backend\'s bound is refused with a reason, not shortened', (t) => {
  t.after(() => idle.stop());
  const h = setup({ idleMaintenanceMode: 'warm-compact', idleMaintenanceRefreshMinutes: 50 });
  h.edge('idle');
  assert.equal(h.timers().length, 0);
  assert.match(idle.getState('s1').refused, /50 minutes/);
});

test('compact only waits the idle time and runs once', async (t) => {
  t.after(() => idle.stop());
  const h = setup({ idleMaintenanceMode: 'compact', idleMaintenanceIdleMinutes: 10 });
  h.edge('idle');
  assert.equal(idle.getState('s1').nextAt, 1000 + 10 * MIN);
  await h.step();
  assert.deepEqual(h.sent, ['compact']);
  assert.equal(await h.step(), false);
  assert.equal(idle.getState('s1').ended, 'compacted');
});

test('warm then compact refreshes to the limit, compacts once, and starts no new cycle', async (t) => {
  t.after(() => idle.stop());
  const h = setup({ idleMaintenanceMode: 'warm-compact', idleMaintenanceRefreshLimit: 2 });
  h.edge('idle');
  while (await h.step());
  assert.deepEqual(h.sent, ['warm', 'warm', 'compact']);
  assert.equal(idle.getState('s1').ended, 'compacted');
  assert.equal(h.timers().length, 0);
});

test('a cold verdict ends keep-alive, and compaction only with the setting', async (t) => {
  t.after(() => idle.stop());
  const coldAfter = () => ({ input: 10, read: 0, write: 4000 });
  const h = setup({ idleMaintenanceMode: 'warm-compact' }, { usageAfter: coldAfter });
  h.edge('idle');
  while (await h.step());
  assert.deepEqual(h.sent, ['warm']);
  assert.equal(idle.getState('s1').ended, 'cold');
  idle.stop();

  const allowed = setup({ idleMaintenanceMode: 'warm-compact', idleMaintenanceBestEffortCompact: true }, { usageAfter: coldAfter });
  allowed.edge('idle');
  while (await allowed.step());
  assert.deepEqual(allowed.sent, ['warm', 'compact']);
});

test('a backend that cannot call a miss goes on after a low read', async (t) => {
  t.after(() => idle.stop());
  const h = setup({ idleMaintenanceMode: 'warm', idleMaintenanceRefreshLimit: 2 }, { answer: CLAUDE_LIKE, usageAfter: () => ({ input: 2, read: 0, write: 900 }) });
  h.edge('idle');
  while (await h.step());
  assert.deepEqual(h.sent, ['warm', 'warm']);
  assert.equal(idle.getState('s1').verdict, 'unknown');
});

test('a blocked tick looks again, and a refresh that cannot go out in time ends the period', async (t) => {
  t.after(() => idle.stop());
  const h = setup({ idleMaintenanceMode: 'warm' });
  h.edge('idle');
  h.setOpen(false);
  await h.step();
  assert.deepEqual(h.sent, []);
  assert.equal(idle.getState('s1').ended, 'blocked', 'at the bound, a later refresh would only rebuild the cache');

  idle.stop();
  const c = setup({ idleMaintenanceMode: 'compact', idleMaintenanceIdleMinutes: 1, idleMaintenanceCeilingMinutes: 1 });
  c.edge('idle');
  c.setOpen(false);
  await c.step();
  assert.equal(idle.getState('s1').ended, 'blocked');
});

test('a retry within the bound goes out once the gate opens', async (t) => {
  t.after(() => idle.stop());
  const h = setup({ idleMaintenanceMode: 'warm', idleMaintenanceRefreshMinutes: 1 });
  h.edge('idle');
  h.setOpen(false);
  await h.step();
  assert.deepEqual(h.sent, []);
  assert.equal(idle.getState('s1').nextAction, 'warm');
  h.setOpen(true);
  await h.step();
  assert.deepEqual(h.sent, ['warm']);
});

test('the user\'s turn cancels what was planned; a quiet edge does not start a period', async (t) => {
  t.after(() => idle.stop());
  const h = setup({ idleMaintenanceMode: 'warm' });
  h.edge('idle');
  h.edge('busy');
  assert.equal(h.timers().length, 0);
  h.edge('idle', true);
  assert.equal(h.timers().length, 0);
});

test('the limit has a hard ceiling whatever the settings hold', (t) => {
  t.after(() => idle.stop());
  const h = setup({ idleMaintenanceMode: 'warm', idleMaintenanceRefreshLimit: 100000 });
  h.edge('idle');
  assert.equal(idle.getState('s1').limit, idle.REFRESH_LIMIT_CEILING);
});

test('a session override changes the plan and writes nothing; removing it returns to the settings', (t) => {
  t.after(() => idle.stop());
  const h = setup({ idleMaintenanceMode: 'off' });
  h.edge('idle');
  assert.equal(idle.getState('s1').mode, 'off');
  assert.equal(idle.setOverride('s1', { idleMaintenanceMode: 'warm', notOurs: 1 }).mode, 'warm');
  assert.equal(h.timers().length, 1);
  assert.deepEqual(idle.getState('s1').overrides, { idleMaintenanceMode: 'warm' });
  assert.equal(idle.setOverride('s1', { idleMaintenanceMode: null }).mode, 'off');
  assert.equal(h.timers().length, 0);
});

test('exit and stop leave no timer, and a warm turn is recorded with its key', async (t) => {
  t.after(() => idle.stop());
  const h = setup({ idleMaintenanceMode: 'warm' });
  h.edge('idle');
  await h.step();
  assert.deepEqual(h.records[0], { sessionId: 's1', kind: 'warm', key: 'k', text: 'warm text', at: h.time() });
  assert.equal(h.notes[0].label, 'Refresh');
  h.edge('exit');
  assert.equal(h.timers().length, 0);
  assert.equal(idle.getState('s1'), null);

  const q = setup({ idleMaintenanceMode: 'warm' });
  q.edge('idle');
  idle.stop();
  assert.equal(q.timers().length, 0);
});

test('the verdict compares against the previous prompt', () => {
  const before = { input: 10, read: 4136, write: 14 };
  assert.equal(idle.hitVerdict(before, { input: 10, read: 4146, write: 16 }, true), 'warm');
  assert.equal(idle.hitVerdict(before, { input: 10, read: 0, write: 4214 }, true), 'cold');
  assert.equal(idle.hitVerdict(before, { input: 2, read: 100, write: 5 }, true), 'unknown');
  assert.equal(idle.hitVerdict(before, { input: 10, read: 0, write: 4214 }, false), 'unknown', 'a miss it cannot call');
  assert.equal(idle.hitVerdict(null, { input: 2, read: 100, write: 5 }, true), 'unknown');
  assert.equal(idle.hitVerdict(before, null, true), 'unknown');
  assert.equal(idle.hitVerdict(before, before, true), 'unknown', 'no new model call found nothing out');
});
