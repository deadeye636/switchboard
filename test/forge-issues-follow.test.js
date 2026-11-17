// The refresh timer of an open, visible issues list (#882): one timer per project and query in main, driven here by a
// fake clock and a fake CLI. Nothing starts a process and nothing waits in real time.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const forgeIssues = require('../src/app/forge-issues');
const { FOCUSED_MS, VISIBLE_MS, MAX_MS, AWAY_RECHECK_MS } = require('../src/app/forge-issues-follow');

const MIN = 60 * 1000;
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };

function clock() {
  let t = 1e9;
  const timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => { const h = { at: t + ms, fn, unref() {} }; timers.push(h); return h; },
    clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = Math.max(t, next.at);
        next.fn();
        await settle();
      }
      t = end;
    },
    pending: () => timers.length,
  };
}

function sender(id) {
  const sent = [];
  const handlers = {};
  return {
    id, sent, handlers,
    send: (channel, payload) => sent.push({ channel, payload }),
    once: (ev, cb) => { handlers[ev] = cb; },
    on() {},
    isDestroyed: () => false,
  };
}

function setup({ failing = false, remote = 'https://github.com/o/r.git' } = {}) {
  const clk = clock();
  // `reads` are the list reads, `names` the GitLab user-name lookups.
  const state = { away: false, failing, quitting: false, reads: [], names: 0, settingsThrow: false, cliThrows: false };
  forgeIssues.init({
    effectiveSettings: () => {
      if (state.settingsThrow) throw new Error('settings');
      return { forgeIssuesEnabled: true, forgeProvider: 'auto', forgeRemote: 'origin' };
    },
    getSetting: () => ({}),
    execFile: (file, args, options, cb) => {
      if (file === 'git') { setImmediate(() => cb(null, `${remote}\n`, '')); return {}; }
      if (state.cliThrows) throw new Error('spawn');
      if (args[0] === 'api') { state.names++; setImmediate(() => cb(null, '{"username":"me"}', '')); return {}; }
      state.reads.push(args.join(' '));
      setImmediate(() => (state.failing ? cb({ code: 1 }, '', 'boom') : cb(null, '[]', '')));
      return {};
    },
    isUserAway: () => state.away,
    getAppQuitting: () => state.quitting,
    now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer,
  });
  return { clk, state };
}

const Q = { state: 'open' };

test('a focused sidebar is read every 5 minutes, a visible one every 15', async () => {
  const { clk, state } = setup();
  const a = sender(1);
  forgeIssues.follow('s1', a, '<project>', Q, 'focused');
  await clk.advance(FOCUSED_MS - 1000);
  assert.equal(state.reads.length, 0);
  await clk.advance(1000);
  assert.equal(state.reads.length, 1);
  assert.deepEqual(a.sent.map((m) => m.channel), ['forge-issues-updated']);
  assert.equal(a.sent[0].payload.projectPath, '<project>');
  assert.equal(a.sent[0].payload.query.state, 'open');
  forgeIssues.follow('s1', a, '<project>', Q, 'visible');   // the same sidebar, now unfocused
  await clk.advance(VISIBLE_MS - 1000);
  assert.equal(state.reads.length, 1);
  await clk.advance(1000);
  assert.equal(state.reads.length, 2);
  forgeIssues.stop();
});

test('the fastest live follower decides, and the interval relaxes when it leaves', async () => {
  const { clk, state } = setup();
  const a = sender(1);
  const b = sender(2);
  forgeIssues.follow('s1', a, '<project>', Q, 'visible');
  forgeIssues.follow('s2', b, '<project>', Q, 'focused');
  await clk.advance(FOCUSED_MS);
  assert.equal(state.reads.length, 1);
  forgeIssues.unfollow('s2', b);
  await clk.advance(VISIBLE_MS - 1000);
  assert.equal(state.reads.length, 1, 'the visible follower alone waits 15 minutes from the last read');
  await clk.advance(1000);
  assert.equal(state.reads.length, 2);
  forgeIssues.stop();
});

test('two sidebars of one project and query share one timer and one request', async () => {
  const { clk, state } = setup();
  const a = sender(1);
  const b = sender(2);
  forgeIssues.follow('s1', a, '<project>', Q, 'focused');
  forgeIssues.follow('s2', b, '<project>', Q, 'focused');
  forgeIssues.follow('s3', a, '<project>', Q, 'focused');   // a second sidebar of the same window
  assert.equal(clk.pending(), 1);
  await clk.advance(FOCUSED_MS);
  assert.equal(state.reads.length, 1);
  assert.equal(a.sent.length, 1, 'one notice per window; the window asks for every sidebar of its own');
  assert.equal(b.sent.length, 1);
  forgeIssues.stop();
});

test('another query or project is its own timer', async () => {
  const { clk, state } = setup();
  const a = sender(1);
  forgeIssues.follow('s1', a, '<project>', { state: 'open' }, 'focused');
  forgeIssues.follow('s2', a, '<project>', { state: 'closed' }, 'focused');
  assert.equal(clk.pending(), 2);
  await clk.advance(FOCUSED_MS);
  assert.equal(state.reads.length, 2);
  forgeIssues.stop();
});

test('an absent user pauses the reads and the first look after the return reads', async () => {
  const { clk, state } = setup();
  const a = sender(1);
  forgeIssues.follow('s1', a, '<project>', Q, 'focused');
  state.away = true;
  await clk.advance(FOCUSED_MS + 10 * MIN);
  assert.equal(state.reads.length, 0, 'no CLI start while away');
  assert.equal(a.sent.length, 0);
  state.away = false;
  await clk.advance(AWAY_RECHECK_MS);
  assert.equal(state.reads.length, 1);
  forgeIssues.stop();
});

test('a failed read doubles the interval up to 30 minutes, and a good one starts over', async () => {
  const { clk, state } = setup({ failing: true });
  const a = sender(1);
  forgeIssues.follow('s1', a, '<project>', Q, 'focused');
  const gaps = [];
  let last = clk.now();
  for (let i = 0; i < 6; i++) {
    const before = state.reads.length;
    while (state.reads.length === before) await clk.advance(MIN);
    gaps.push(Math.round((clk.now() - last) / MIN));
    last = clk.now();
  }
  assert.deepEqual(gaps, [5, 10, 20, 30, 30, 30]);
  assert.equal(a.sent.length, 0, 'a failed read tells nobody: the last good list stays');
  assert.equal(forgeIssues._followers()._groups()[0].intervalMs, MAX_MS);
  state.failing = false;
  while (state.reads.length < 7) await clk.advance(MIN);
  assert.equal(a.sent.length, 1);
  assert.equal(forgeIssues._followers()._groups()[0].intervalMs, FOCUSED_MS);
  forgeIssues.stop();
});

test('a forced read (the Reload buttons) starts the clock over', async () => {
  const { clk, state } = setup();
  const a = sender(1);
  forgeIssues.follow('s1', a, '<project>', Q, 'focused');
  await clk.advance(4 * MIN);
  await forgeIssues.listIssues('<project>', Q, { force: true });
  assert.equal(state.reads.length, 1);
  await clk.advance(4 * MIN);
  assert.equal(state.reads.length, 1, 'the old due time passed without a read');
  await clk.advance(MIN);
  assert.equal(state.reads.length, 2);
  forgeIssues.stop();
});

test('nobody following means no timer and no request', async () => {
  const { clk, state } = setup();
  await clk.advance(2 * 60 * MIN);
  assert.equal(state.reads.length, 0);
  assert.equal(clk.pending(), 0);
  const a = sender(1);
  forgeIssues.follow('s1', a, '<project>', Q, 'focused');
  assert.equal(clk.pending(), 1);
  forgeIssues.unfollow('s1', a);
  assert.equal(clk.pending(), 0);
  await clk.advance(2 * 60 * MIN);
  assert.equal(state.reads.length, 0);
});

test('a destroyed or navigated window stops following', async () => {
  const { clk, state } = setup();
  const a = sender(1);
  const b = sender(2);
  forgeIssues.follow('s1', a, '<project>', Q, 'focused');
  forgeIssues.follow('s1', b, '<project>', Q, 'focused');
  a.handlers.destroyed();
  await clk.advance(FOCUSED_MS);
  assert.equal(state.reads.length, 1);
  assert.equal(a.sent.length, 0);
  assert.equal(b.sent.length, 1);
  b.handlers.destroyed();
  assert.equal(clk.pending(), 0);
  forgeIssues.stop();
});

test('stopping for the quit ends every timer, and a quitting app reads nothing', async () => {
  const { clk, state } = setup();
  const a = sender(1);
  forgeIssues.follow('s1', a, '<project>', Q, 'focused');
  forgeIssues.stop();
  assert.equal(clk.pending(), 0);
  await clk.advance(60 * MIN);
  assert.equal(state.reads.length, 0);
  assert.deepEqual(forgeIssues.follow('s1', a, '<project>', Q, 'focused'), { ok: true });
  state.quitting = true;
  await clk.advance(60 * MIN);
  assert.equal(state.reads.length, 0);
  forgeIssues.stop();
});

test('a malformed follow is refused and starts nothing', () => {
  const { clk } = setup();
  const a = sender(1);
  for (const args of [[null, a, '<project>', Q, 'focused'], ['s', null, '<project>', Q, 'focused'], ['s', a, '', Q, 'focused'], ['s', a, 5, Q, 'focused']]) {
    assert.deepEqual(forgeIssues.follow(...args), { ok: false });
  }
  assert.equal(clk.pending(), 0);
});

// M1: a tick and a window's own re-read share one CLI start, in either order.
test('a window\'s read just before the tick serves the tick: one start, and the clock starts over', async () => {
  const { clk, state } = setup();
  const a = sender(1);
  forgeIssues.follow('s1', a, '<project>', Q, 'focused');
  await clk.advance(FOCUSED_MS - 1000);
  await forgeIssues.listIssues('<project>', Q);
  await clk.advance(2000);
  assert.equal(state.reads.length, 1);
  assert.equal(a.sent.length, 0, 'nothing is due yet: the window\'s read restarted the clock');
  forgeIssues.stop();
});

test('a tick just before the window\'s own re-read serves it: one start', async () => {
  const { clk, state } = setup();
  const a = sender(1);
  forgeIssues.follow('s1', a, '<project>', Q, 'focused');
  await clk.advance(FOCUSED_MS);
  assert.equal(state.reads.length, 1);
  const first = await forgeIssues.listIssues('<project>', Q);
  const second = await forgeIssues.listIssues('<project>', Q);
  assert.equal(state.reads.length, 1);
  assert.equal(first, second);
  forgeIssues.stop();
});

test('a tick that finds a read in flight joins it', async () => {
  const { clk, state } = setup();
  const a = sender(1);
  forgeIssues.follow('s1', a, '<project>', Q, 'focused');
  await clk.advance(FOCUSED_MS - 10);
  const window = forgeIssues.listIssues('<project>', Q);   // started, not finished
  await clk.advance(10);
  await window;
  await clk.advance(0);
  assert.equal(state.reads.length, 1);
  forgeIssues.stop();
});

// M2: a tick keeps the cached GitLab user name.
test('GitLab: a tick does not look the user name up again, a forced read does', async () => {
  const { clk, state } = setup({ remote: 'https://gitlab.com/o/r.git' });
  const a = sender(1);
  const mine = { state: 'open', author: true };
  await forgeIssues.listIssues('<project>', mine);
  assert.equal(state.names, 1);
  forgeIssues.follow('s1', a, '<project>', mine, 'focused');
  await clk.advance(FOCUSED_MS);
  await clk.advance(FOCUSED_MS);
  assert.equal(state.reads.length, 3);
  assert.equal(state.names, 1, 'two ticks, one lookup');
  await forgeIssues.listIssues('<project>', mine, { force: true });
  assert.equal(state.names, 2, 'the Reload buttons refresh it');
  forgeIssues.stop();
});

// L2: a window's own re-read starts nothing for an absent user.
test('a background read answers what is held while the user is away, and nothing without it', async () => {
  const { clk, state } = setup();
  state.away = true;
  assert.equal(await forgeIssues.listIssues('<project>', Q, { background: true }), null);
  assert.equal(state.reads.length, 0);
  const held = await forgeIssues.listIssues('<project>', Q);
  assert.equal(state.reads.length, 1, 'the user\'s own open reads');
  assert.equal(await forgeIssues.listIssues('<project>', Q, { background: true }), held, 'a fresh answer is simply the cache');
  await clk.advance(2 * MIN);   // older than the cache: handed over, marked held
  assert.deepEqual(await forgeIssues.listIssues('<project>', Q, { background: true }), { ...held, held: true });
  await forgeIssues.listIssues('<project>', Q, { force: true, background: true });
  assert.equal(state.reads.length, 2, 'a forced read is the user\'s');
  state.away = false;
  await forgeIssues.listIssues('<project>', { state: 'closed' }, { background: true });
  assert.equal(state.reads.length, 3, 'present, a background read reads');
});

// L3: one failed read is one failure, however it failed.
test('a failed read counts once, whether it answered or threw', async () => {
  let s = setup({ failing: true });
  forgeIssues.follow('s1', sender(1), '<project>', Q, 'focused');
  await s.clk.advance(FOCUSED_MS);
  assert.equal(forgeIssues._followers()._groups()[0].failures, 1, 'a CLI that answered an error');
  forgeIssues.stop();

  s = setup();
  s.state.cliThrows = true;
  forgeIssues.follow('s1', sender(1), '<project>', Q, 'focused');
  await s.clk.advance(FOCUSED_MS);
  assert.equal(forgeIssues._followers()._groups()[0].failures, 1, 'a start that threw');
  forgeIssues.stop();

  s = setup();
  s.state.settingsThrow = true;
  forgeIssues.follow('s1', sender(1), '<project>', Q, 'focused');
  await s.clk.advance(FOCUSED_MS);
  assert.equal(forgeIssues._followers()._groups()[0].failures, 1, 'a read that threw before it began');
  forgeIssues.stop();
});

test('the two IPC channels are registered', () => {
  const handled = [];
  const listened = [];
  forgeIssues.registerIpc({ handle: (c) => handled.push(c), on: (c) => listened.push(c) });
  assert.ok(handled.includes('forge-issues-follow'));
  assert.deepEqual(listened, ['forge-issues-unfollow']);
});
