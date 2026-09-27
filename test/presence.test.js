// #386 — was the user away, and for how long?
//
// The recap used to be triggered by a focus change on one session, so it fired while the user sat
// there switching sessions and stayed silent when they walked away from a window that stayed in
// front. Presence is a fact about the MACHINE, so main owns it; this covers the decision it makes.

const test = require('node:test');
const assert = require('node:assert/strict');

const presence = require('../src/app/presence');
const { absenceEnded, resolveIdleMs, MIN_ABSENCE_MS, DEFAULT_IDLE_MINUTES } = presence;

const MIN = 60_000;
const T0 = new Date('2026-06-12T10:00:00.000Z').getTime();

test('the idle threshold defaults to ten minutes and takes whole minutes', () => {
  assert.equal(resolveIdleMs(undefined), DEFAULT_IDLE_MINUTES * MIN);
  assert.equal(resolveIdleMs(25), 25 * MIN);
  assert.equal(resolveIdleMs('25'), 25 * MIN);
  assert.equal(resolveIdleMs(3.7), 3 * MIN);
});

test('a threshold under a minute is refused rather than honoured', () => {
  // Under a minute every pause for thought is an absence, and the recap then fires constantly —
  // which is the defect this issue is about, reached from the other side.
  for (const bad of [0, -5, 0.5, 'x', null, NaN, Infinity]) {
    assert.equal(resolveIdleMs(bad), DEFAULT_IDLE_MINUTES * MIN, `should refuse ${JSON.stringify(bad)}`);
  }
});

test('a gap past the threshold is an absence, and it started at the last activity', () => {
  const out = absenceEnded({ lastActivityAt: T0, now: T0 + 20 * MIN, idleMs: 10 * MIN });
  assert.deepEqual(out, { awaySince: T0, awayMs: 20 * MIN });
});

test('a gap under the threshold is not an absence', () => {
  assert.equal(absenceEnded({ lastActivityAt: T0, now: T0 + 9 * MIN, idleMs: 10 * MIN }), null);
});

test('the floor holds even when the threshold is set below it', () => {
  // `resolveIdleMs` cannot produce under a minute, but the floor is applied here too rather than
  // trusted from one caller away: this is the function that decides.
  assert.equal(absenceEnded({ lastActivityAt: T0, now: T0 + 30_000, idleMs: 1_000 }), null);
  assert.equal(MIN_ABSENCE_MS, MIN);
});

test('the first sign of life is not an absence — nobody was away from a launch', () => {
  assert.equal(absenceEnded({ lastActivityAt: null, now: T0, idleMs: 10 * MIN }), null);
  assert.equal(absenceEnded({ lastActivityAt: undefined, now: T0, idleMs: 10 * MIN }), null);
});

test('a clock that went backwards reports nothing rather than a negative absence', () => {
  assert.equal(absenceEnded({ lastActivityAt: T0, now: T0 - 5 * MIN, idleMs: 10 * MIN }), null);
  assert.equal(absenceEnded({ lastActivityAt: T0, now: T0, idleMs: 10 * MIN }), null);
});

test('activity is recorded across calls, and only the gap that crosses the threshold reports', () => {
  presence.init({ getSetting: () => ({ awayIdleMinutes: 10 }), log: { info() {} } });

  assert.equal(presence.recordActivity(T0), null, 'the first report has nothing to compare against');
  assert.equal(presence.recordActivity(T0 + 2 * MIN), null, 'still here');
  assert.deepEqual(presence.recordActivity(T0 + 40 * MIN), { awaySince: T0 + 2 * MIN, awayMs: 38 * MIN },
    'away from the last sign of life, not from the first');
  assert.equal(presence.recordActivity(T0 + 41 * MIN), null, 'and back is only reported once');
});

// --- The absence survives a renderer reload (#422) ---------------------------------

test('#422: the reported absence is HELD, so a window that reloads can ask for it', () => {
  presence.init({ getSetting: () => ({ awayIdleMinutes: 10 }), log: { info() {} } });
  assert.equal(presence.pendingRecapAbsence(), null, 'nothing has happened yet');

  presence.recordActivity(T0);
  presence.recordActivity(T0 + 40 * MIN);
  assert.deepEqual(presence.pendingRecapAbsence(), { awaySince: T0, awayMs: 40 * MIN });

  presence.recordActivity(T0 + 41 * MIN);
  assert.deepEqual(presence.pendingRecapAbsence(), { awaySince: T0, awayMs: 40 * MIN },
    'ordinary activity is not an answer to the recap — only a discard or a newer absence is');
});

test('#422: a newer absence replaces the held one rather than queueing behind it', () => {
  presence.init({ getSetting: () => ({ awayIdleMinutes: 10 }), log: { info() {} } });
  presence.recordActivity(T0);
  presence.recordActivity(T0 + 40 * MIN);
  presence.recordActivity(T0 + 200 * MIN);

  assert.deepEqual(presence.pendingRecapAbsence(), { awaySince: T0 + 40 * MIN, awayMs: 160 * MIN },
    'an entry about an absence that ended two absences ago is wrong, not merely old');
});

test('#422: a discard is keyed on WHICH absence, so a newer one is not thrown away with it', () => {
  presence.init({ getSetting: () => ({ awayIdleMinutes: 10 }), log: { info() {} } });
  presence.recordActivity(T0);
  presence.recordActivity(T0 + 40 * MIN);

  assert.equal(presence.discardRecapAbsence(T0 + 999), false, 'an absence that is not the current one');
  assert.deepEqual(presence.pendingRecapAbsence(), { awaySince: T0, awayMs: 40 * MIN }, 'still held');

  assert.equal(presence.discardRecapAbsence(T0), true);
  assert.equal(presence.pendingRecapAbsence(), null, 'discarded stays discarded across a reload');
  assert.equal(presence.discardRecapAbsence(T0), false, 'and a second discard has nothing to do');
});

test('#422: a discard that lost the race leaves the absence the user has not seen', () => {
  presence.init({ getSetting: () => ({ awayIdleMinutes: 10 }), log: { info() {} } });
  presence.recordActivity(T0);
  presence.recordActivity(T0 + 40 * MIN);
  // A second absence ends between the click and the message arriving in main.
  presence.recordActivity(T0 + 200 * MIN);

  assert.equal(presence.discardRecapAbsence(T0), false);
  assert.deepEqual(presence.pendingRecapAbsence(), { awaySince: T0 + 40 * MIN, awayMs: 160 * MIN },
    'the recap the user has not seen must not be discarded by a click about the previous one');
});

test('#422: the two halves are reachable over IPC, and a fresh wiring holds nothing', () => {
  const handlers = new Map();
  presence.init({ getSetting: () => ({ awayIdleMinutes: 10 }), log: { info() {} } });
  presence.registerIpc({ on() {}, handle: (channel, fn) => handlers.set(channel, fn) });
  const invoke = (channel, ...args) => handlers.get(channel)(null, ...args);

  assert.equal(invoke('presence:pending-absence'), null, 'init clears what a previous wiring held');
  presence.recordActivity(T0);
  presence.recordActivity(T0 + 40 * MIN);
  assert.deepEqual(invoke('presence:pending-absence'), { awaySince: T0, awayMs: 40 * MIN });

  assert.equal(invoke('presence:discard-absence', T0), true);
  assert.equal(invoke('presence:pending-absence'), null);
});

test('a settings store that throws does not stop presence being tracked', () => {
  presence.init({ getSetting: () => { throw new Error('no db'); }, log: { info() {} } });
  assert.equal(presence.recordActivity(T0), null);
  assert.deepEqual(presence.recordActivity(T0 + 30 * MIN), { awaySince: T0, awayMs: 30 * MIN },
    'falls back to the default threshold rather than reporting nothing');
});

// --- Input anywhere on the machine is presence (#673) -------------------------------

/** A wiring whose OS idle time the test sets, and the windows that heard an absence. */
function wireWithIdle(settings = { awayIdleMinutes: 10 }) {
  const state = { idleSeconds: 0 };
  const sent = [];
  const win = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };
  presence.init({
    getSetting: () => settings,
    getMainWindow: () => win,
    getSystemIdleSeconds: () => state.idleSeconds,
    log: { info() {} },
  });
  return { state, sent };
}

test('#673: the last input is dated from the idle time', () => {
  const { lastInputFromIdle } = presence;
  assert.equal(lastInputFromIdle({ idleSeconds: 90, now: T0 + 10 * MIN }), T0 + 10 * MIN - 90_000);
  assert.equal(lastInputFromIdle({ idleSeconds: 0, now: T0 }), T0, 'an OS that answers 0 reads as present');
  for (const bad of [undefined, null, NaN, -1, 'x']) {
    assert.equal(lastInputFromIdle({ idleSeconds: bad, now: T0 }), null, `should refuse ${JSON.stringify(bad)}`);
  }
});

test('#673: working in another application is presence — no absence from a busy machine', () => {
  const { state, sent } = wireWithIdle();
  presence.recordActivity(T0);                    // the last input in a Switchboard window
  // An hour in another app: every poll finds input a few seconds old.
  for (let t = T0 + 20_000; t <= T0 + 60 * MIN; t += 20_000) {
    state.idleSeconds = 3;
    presence.pollSystemIdle(t);
  }
  // …and then a keystroke in Switchboard is no return, because nobody left.
  assert.equal(presence.recordActivity(T0 + 60 * MIN + 1000), null);
  assert.deepEqual(sent, []);
  assert.equal(presence.pendingRecapAbsence(), null);
});

test('#673: a return noticed by the poll is announced, dated from the last input on the machine', () => {
  const { state, sent } = wireWithIdle();
  presence.recordActivity(T0);
  // Last input anywhere at T0 + 5 min, then nothing: the idle time grows with the clock.
  state.idleSeconds = 0;
  presence.pollSystemIdle(T0 + 5 * MIN);
  for (let t = T0 + 5 * MIN + 20_000; t < T0 + 45 * MIN; t += 20_000) {
    state.idleSeconds = (t - (T0 + 5 * MIN)) / 1000;
    assert.equal(presence.pollSystemIdle(t), null, 'still away — the last input has not moved');
  }
  // Back, in another application: input 4 s before the next poll.
  state.idleSeconds = 4;
  const absence = presence.pollSystemIdle(T0 + 45 * MIN + 4000);
  assert.deepEqual(absence, { awaySince: T0 + 5 * MIN, awayMs: 40 * MIN });
  assert.deepEqual(sent, [{ channel: 'presence-returned', payload: absence }]);
  assert.deepEqual(presence.pendingRecapAbsence(), absence, 'held for a reload like any other (#422)');
});

test('#673: a poll never moves the last sign of life backwards past a renderer report', () => {
  const { state, sent } = wireWithIdle();
  presence.recordActivity(T0);
  presence.recordActivity(T0 + 30 * MIN);         // the renderer announced the return itself
  sent.length = 0;
  // A poll answering from BEFORE that report — the OS rounds to whole seconds, and polls lag.
  state.idleSeconds = 20;
  assert.equal(presence.pollSystemIdle(T0 + 30 * MIN + 10_000), null);
  // Were it recorded, this report would be measured from T0 + 29:50 — still no absence, but the
  // stored sign of life must be the renderer's, so the next gap is measured from the right point.
  assert.deepEqual(presence.recordActivity(T0 + 50 * MIN), { awaySince: T0 + 30 * MIN, awayMs: 20 * MIN });
});

test('#673: the renderer path stays the fast one and the poll does not announce the same return twice', () => {
  const { state, sent } = wireWithIdle();
  const handlers = new Map();
  presence.registerIpc({ on: (channel, fn) => handlers.set(channel, fn), handle() {} });
  presence.recordActivity(T0);
  state.idleSeconds = 0;
  handlers.get('presence-activity')();             // Date.now(): long after T0, so an absence
  assert.equal(sent.length, 1, 'the keystroke announces the return at once');
  presence.pollSystemIdle(Date.now() + 1000);
  assert.equal(sent.length, 1, 'the poll after it finds the same input, not a second return');
});

test('#673: an idle reader that throws or is missing is no reading — never presence, never absence', () => {
  presence.init({
    getSetting: () => ({ awayIdleMinutes: 10 }),
    getSystemIdleSeconds: () => { throw new Error('not ready'); },
    log: { info() {} },
  });
  presence.recordActivity(T0);
  assert.equal(presence.pollSystemIdle(T0 + 30 * MIN), null);
  assert.deepEqual(presence.recordActivity(T0 + 30 * MIN), { awaySince: T0, awayMs: 30 * MIN },
    'the failed reading did not count as a sign of life');

  // A window report with no reading behind it still counts: the tolerance check needs a reading to
  // contradict the report, and "no reading" must never read as "the machine was idle".
  presence.recordActivity(T0);
  assert.deepEqual(presence.recordWindowActivity(T0 + 30 * MIN), { awaySince: T0, awayMs: 30 * MIN },
    'a window report is a return when the idle reader has nothing to say');

  presence.init({ getSetting: () => ({}), log: { info() {} } });
  assert.equal(presence.pollSystemIdle(T0), null);
  assert.equal(presence.startSystemIdlePoll(), false, 'nothing to poll without a reader');
  assert.equal(presence.isPollingSystemIdle(), false);
});

test('#673: the poll starts once and is cleared on teardown and re-wiring', () => {
  wireWithIdle();
  assert.equal(presence.startSystemIdlePoll({ now: T0 }), true);
  assert.equal(presence.startSystemIdlePoll({ now: T0 }), false, 'a second start adds no second timer');
  assert.equal(presence.isPollingSystemIdle(), true);
  presence.stopSystemIdlePoll();
  assert.equal(presence.isPollingSystemIdle(), false);

  presence.startSystemIdlePoll({ now: T0 });
  wireWithIdle();                                  // init again, as a re-wiring would
  assert.equal(presence.isPollingSystemIdle(), false, 'init clears a timer a previous wiring left');
});

/** Polls every 20 s from `from` (exclusive) up to `to` (inclusive), idle since `lastInput`. */
function pollIdleSince(state, lastInput, from, to) {
  for (let t = from + 20_000; t <= to; t += 20_000) {
    state.idleSeconds = (t - lastInput) / 1000;
    presence.pollSystemIdle(t);
  }
}

test('#673: input between two polls is not lost — a switch to Switchboard after an IDE line is no absence', () => {
  // Reading from T0, a line typed in an IDE at 9:55 (5 s after a poll), then a keystroke in Switchboard at
  // 10:05, before the next poll. The keystroke is input too, so the OS answers 0 by then and the IDE line
  // is invisible — the gap measures 10:05, but the last reading only vouched for 9:50 of quiet.
  const { state, sent } = wireWithIdle();
  presence.recordActivity(T0);                     // the last input before reading
  pollIdleSince(state, T0, T0 - 10_000, T0 + 9 * MIN + 50_000);
  state.idleSeconds = 0;                           // the Switchboard keystroke itself
  assert.equal(presence.recordWindowActivity(T0 + 10 * MIN + 5_000), null);
  assert.deepEqual(sent, []);
  assert.equal(presence.pendingRecapAbsence(), null);
});

test('#673: a real absence ending in a Switchboard window is still announced at once', () => {
  const { state, sent } = wireWithIdle();
  state.idleSeconds = 0;
  presence.pollSystemIdle(T0);
  pollIdleSince(state, T0, T0, T0 + 40 * MIN);
  state.idleSeconds = 0;
  const absence = presence.recordWindowActivity(T0 + 40 * MIN + 10_000);
  assert.deepEqual(absence, { awaySince: T0, awayMs: 40 * MIN + 10_000 });
  assert.equal(sent.length, 1, 'announced once, not by the poll AND the window');
});

test('#673: what the OS last vouched for decides, and a reading that does not vouch defers to the gap', () => {
  const { gapIsConfirmed } = presence;
  const idleMs = 10 * MIN;
  assert.equal(gapIsConfirmed({ lastActivityAt: T0, lastReadingAt: null, idleMs, vouches: false }), true,
    'no reading at all: the window reports are the only source, as before #673');
  assert.equal(gapIsConfirmed({ lastActivityAt: T0, lastReadingAt: T0 + 9 * MIN, idleMs, vouches: false }), true,
    'a stale reading, or one from before a suspend, says nothing');
  assert.equal(gapIsConfirmed({ lastActivityAt: T0, lastReadingAt: T0 + 9 * MIN + 50_000, idleMs, vouches: true }), false,
    'the OS saw only 9:50 of quiet — the rest may have been input it never saw');
  assert.equal(gapIsConfirmed({ lastActivityAt: T0, lastReadingAt: T0 + 30 * MIN, idleMs, vouches: true }), true);
});

test('#673: input elsewhere after the last timer reading is recorded before a window report is measured', () => {
  // Away from T0; the timer saw nothing up to 40:00. Input in another app at 40:05, then a window report at
  // 40:15 that is not itself fresh input. The absence ended at 40:05, and that is what it measures.
  const { state, sent } = wireWithIdle();
  presence.recordActivity(T0);
  pollIdleSince(state, T0, T0, T0 + 40 * MIN);
  state.idleSeconds = 10;
  const absence = presence.recordWindowActivity(T0 + 40 * MIN + 15_000);
  assert.deepEqual(absence, { awaySince: T0, awayMs: 40 * MIN + 5_000 });
  assert.equal(sent.length, 1);
});

test('#673: a window report the OS contradicts is not a return — an app-caused focus ends no absence', () => {
  // A detached window closing hands the main window the focus while the user is still away. The OS says
  // the machine has been idle past the threshold, so that report records nothing, and the real return
  // later still gets its recap.
  const { state, sent } = wireWithIdle();
  presence.recordActivity(T0);
  pollIdleSince(state, T0, T0, T0 + 15 * MIN);
  state.idleSeconds = (15 * MIN + 10_000) / 1000;
  assert.equal(presence.recordWindowActivity(T0 + 15 * MIN + 10_000), null);
  assert.deepEqual(sent, []);
  pollIdleSince(state, T0, T0 + 15 * MIN, T0 + 30 * MIN);
  state.idleSeconds = 0;
  assert.deepEqual(presence.recordWindowActivity(T0 + 30 * MIN + 10_000), { awaySince: T0, awayMs: 30 * MIN + 10_000 });
});

test('#673: an untouched relaunch records nothing, so the first return is no "away since start"', () => {
  // A crash restart or an update relaunch while the user is away: no input since the app started.
  const { state, sent } = wireWithIdle();
  presence.startSystemIdlePoll({ now: T0 });
  const launchIdle = 3600;                         // the machine had been idle an hour already
  for (let t = T0 + 20_000; t <= T0 + 30 * MIN; t += 20_000) {
    state.idleSeconds = launchIdle + (t - T0) / 1000;
    assert.equal(presence.pollSystemIdle(t), null);
  }
  // Back, in another application, then in Switchboard.
  state.idleSeconds = 2;
  assert.equal(presence.pollSystemIdle(T0 + 30 * MIN + 20_000), null, 'the first sign of life is no absence');
  state.idleSeconds = 0;
  assert.equal(presence.recordWindowActivity(T0 + 30 * MIN + 25_000), null);
  assert.deepEqual(sent, []);
  presence.stopSystemIdlePoll();
});

/** A wiring on two clocks the test moves: `tick(wallMs, monoMs, idleSeconds)`. */
function wireWithClocks() {
  const clock = { wall: T0, mono: 5_000 };
  const state = { idleSeconds: 0 };
  const sent = [];
  presence.init({
    getSetting: () => ({ awayIdleMinutes: 10 }),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (c, p) => sent.push(p) } }),
    getSystemIdleSeconds: () => state.idleSeconds,
    now: () => clock.wall,
    monotonicNow: () => clock.mono,
    log: { info() {} },
  });
  const tick = (wallMs, monoMs, idle) => { clock.wall += wallMs; clock.mono += monoMs; state.idleSeconds = idle; };
  return { clock, sent, tick };
}

test('#673: a night asleep is measured in wall time — the monotonic clock stops during a suspend', () => {
  for (const monoDuringSleep of [20_000, 8 * 60 * MIN]) {    // a Mac or Linux clock, and a Windows one
    const { clock, sent, tick } = wireWithClocks();
    presence.pollSystemIdle();                     // input at the start
    tick(20_000, 20_000, 0); presence.pollSystemIdle();
    const leftAt = clock.wall;                     // the last input; the lid closes a few seconds later
    tick(8 * 60 * MIN, monoDuringSleep, 8 * 60 * 60);
    presence.noteSystemResume();
    tick(3_000, 3_000, 0);                         // the key that woke it
    const absence = presence.recordWindowActivity();
    assert.deepEqual(absence, { awaySince: leftAt, awayMs: 8 * 60 * MIN + 3_000 },
      `the night is an absence (monotonic clock advanced ${monoDuringSleep} ms)`);
    assert.equal(sent.length, 1);
  }
});

test('#673: a wall clock that jumps forward while the user works elsewhere is not an absence', () => {
  // The veto is the OS reading, not a second clock: the reading before the jump covered a few seconds of
  // quiet, and no resume came between — so the hour the wall clock gained is not time anyone was away.
  const { clock, sent, tick } = wireWithClocks();
  presence.pollSystemIdle();                       // input at the start
  for (let i = 0; i < 5; i++) { tick(20_000, 20_000, 3); presence.pollSystemIdle(); }
  tick(60 * MIN, 20_000, 3);                       // an NTP step or a restored VM, no resume in between
  assert.equal(presence.pollSystemIdle(), null, 'twenty seconds passed, whatever the wall clock says');
  tick(5_000, 5_000, 0);
  assert.equal(presence.recordWindowActivity(), null);
  assert.deepEqual(sent, []);

  // …and a real absence after the jump is dated and measured in wall time.
  const leftAt = clock.wall;
  for (let i = 0; i < 90; i++) { tick(20_000, 20_000, (i + 1) * 20); presence.pollSystemIdle(); }
  tick(5_000, 5_000, 0);
  assert.deepEqual(presence.recordWindowActivity(), { awaySince: leftAt, awayMs: 30 * MIN + 5_000 });
});

test('#673: a resume stops vouching only until the next reading — then input between polls is guarded again', () => {
  const { sent, tick } = wireWithClocks();
  presence.pollSystemIdle();                       // input at the start
  presence.noteSystemResume();
  tick(20_000, 20_000, 20); presence.pollSystemIdle();   // one fresh reading after the resume
  // Reading from here on, polls every 20 s up to 9:40 since the last input; IDE input just after that
  // poll; a keystroke in Switchboard at 10:05. The reading at 9:40 vouches again, and it saw under ten
  // minutes of quiet.
  for (let i = 1; i < 29; i++) { tick(20_000, 20_000, 20 + i * 20); presence.pollSystemIdle(); }
  tick(25_000, 25_000, 0);
  assert.equal(presence.recordWindowActivity(), null);
  assert.deepEqual(sent, []);
});

test('#673: the resume listener is taken through ctx, once, and handed back on stop and on re-wiring', () => {
  const listeners = [];
  const wiring = () => ({
    getSetting: () => ({ awayIdleMinutes: 10 }),
    getSystemIdleSeconds: () => 0,
    onSystemResume: (fn) => listeners.push(fn),
    offSystemResume: (fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    log: { info() {} },
  });
  presence.init(wiring());
  assert.equal(listeners.length, 0, 'nothing is subscribed before the poll starts');
  presence.startSystemIdlePoll({ now: T0 });
  presence.startSystemIdlePoll({ now: T0 });
  assert.equal(listeners.length, 1, 'one listener, however often start is asked');
  presence.stopSystemIdlePoll();
  assert.equal(listeners.length, 0, 'stop hands it back');

  presence.startSystemIdlePoll({ now: T0 });
  presence.init(wiring());                         // a re-wiring stops the old poll with the old ctx
  assert.equal(listeners.length, 0, 'init hands back what a previous wiring subscribed');

  // …and a delivered resume reaches the rule: the reading before it no longer vouches.
  presence.startSystemIdlePoll({ now: T0 });
  presence.recordActivity(T0);
  presence.pollSystemIdle(T0 + 5_000);
  listeners[0]();
  // Eleven minutes later on the wall clock, twenty seconds on a monotonic clock that stopped asleep.
  assert.deepEqual(presence.recordActivity(T0 + 25_000 + 11 * MIN, T0 + 25_000),
    { awaySince: T0 + 5_000, awayMs: 11 * MIN + 20_000 });
  presence.stopSystemIdlePoll();
});

test('#673: an input-less window report below the threshold dates nothing late', () => {
  // A focus the app caused, 3 minutes into an absence, with the OS saying 3 minutes idle. Counted as now,
  // the absence would start at 3:00 and the return at 12:00 would be 9 minutes — no recap. The reading's
  // own input time stays the last sign of life instead.
  const { state, sent } = wireWithIdle();
  presence.recordActivity(T0);
  pollIdleSince(state, T0, T0, T0 + 3 * MIN);
  state.idleSeconds = (3 * MIN + 5_000) / 1000;
  assert.equal(presence.recordWindowActivity(T0 + 3 * MIN + 5_000), null);
  pollIdleSince(state, T0, T0 + 3 * MIN, T0 + 12 * MIN);
  state.idleSeconds = 0;
  assert.deepEqual(presence.recordWindowActivity(T0 + 12 * MIN + 10_000), { awaySince: T0, awayMs: 12 * MIN + 10_000 });
  assert.equal(sent.length, 1);
});
