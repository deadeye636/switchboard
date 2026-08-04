'use strict';
// Who is holding a Claude session right now (#172).
//
// The module exists so a resume that CANNOT succeed is refused before the PTY exists. Everything here is
// about the two ways that guard could make things worse: by being wrong (a false refusal locks the user
// out of a session that is free), and by being slow (a child process on the click path).
const test = require('node:test');
const assert = require('node:assert/strict');

const liveAgents = require('../src/backends/claude/live-agents');

// The two entry shapes, taken from the installed CLI rather than from its documentation — they differ,
// and the difference is the whole reason normalisation exists.
const REAL_OUTPUT = JSON.stringify([
  { id: '7d920199', cwd: 'D:\\p', kind: 'background', startedAt: 1785078127263, sessionId: '7d920199-3886-4ba9-8254-956f5ebbc980', name: 'A background job', state: 'blocked' },
  { pid: 56216, cwd: 'D:\\p', kind: 'interactive', startedAt: 1785825184033, sessionId: '35a20125-0c8b-4960-b3a1-3df4640366b8', name: 'a terminal', status: 'busy' },
]);

/** An execFile stand-in: answers what it is given, records how often it was called. */
function fakeExec(answer, { fail = false } = {}) {
  const calls = [];
  const fn = (bin, args, opts, cb) => {
    calls.push({ bin, args, opts });
    setImmediate(() => (fail ? cb(new Error('nope'), '') : cb(null, answer)));
  };
  fn.calls = calls;
  return fn;
}

test.beforeEach(() => liveAgents.reset());

test('#172: both entry shapes normalise to one, and neither loses its session id', async () => {
  const entries = await liveAgents.refresh({ exec: fakeExec(REAL_OUTPUT) });
  assert.equal(entries.length, 2);

  const [bg, tty] = entries;
  assert.equal(bg.kind, 'background');
  assert.equal(bg.pid, null, 'a background agent runs under the daemon — naming a pid would be inventing one');
  assert.equal(bg.state, 'blocked', 'its liveness key is `state`');

  assert.equal(tty.kind, 'interactive');
  assert.equal(tty.pid, 56216);
  assert.equal(tty.state, 'busy', 'the same question, spelled `status` on this shape');
});

test('#172: the cache is what the click path reads, and a cold one answers "do not know"', async () => {
  assert.equal(liveAgents.peek(), null, 'nothing has been asked yet');
  await liveAgents.refresh({ exec: fakeExec(REAL_OUTPUT) });
  assert.equal(liveAgents.peek().length, 2);
  assert.equal(liveAgents.ownerOf('7d920199-3886-4ba9-8254-956f5ebbc980').kind, 'background');
  assert.equal(liveAgents.ownerOf('11111111-2222-4333-8444-555555555555'), null);
});

// The guard reads the cache and never fetches, so a TTL below the poll interval leaves it cold for most
// of every interval — which is exactly what happened: a real resume of a live background agent spawned
// anyway, because the answer had expired 30 s before the click.
test('#172: the cache outlives the interval that refreshes it', () => {
  const { POLL_MS } = require('../src/app/live-owners');
  assert.ok(liveAgents.DEFAULT_TTL_MS > POLL_MS,
    'a cache that expires between two polls makes the spawn guard unreachable');
});

test('#172: a stale answer is not an answer', async () => {
  const now = 1_000_000;
  await liveAgents.refresh({ exec: fakeExec(REAL_OUTPUT), now: () => now });
  assert.ok(liveAgents.peek({ now: now + 1000 }), 'fresh');
  assert.equal(liveAgents.peek({ now: now + liveAgents.DEFAULT_TTL_MS + 1 }), null,
    'a session can end between two polls — an old list must not refuse a resume that is now free');
});

// Every one of these is a way the guard could lock someone out of a session nothing is holding.
test('#172: it fails OPEN — a CLI that errors, times out or babbles answers null', async () => {
  assert.equal(await liveAgents.refresh({ exec: fakeExec('', { fail: true }) }), null, 'non-zero exit');
  liveAgents.reset();
  assert.equal(await liveAgents.refresh({ exec: fakeExec('not json at all') }), null, 'unparseable');
  liveAgents.reset();
  assert.equal(await liveAgents.refresh({ exec: fakeExec('{"agents":[]}') }), null, 'an object where a list was promised');
  liveAgents.reset();
  assert.equal(await liveAgents.refresh({
    exec: () => { throw new Error('spawn EACCES'); },
  }), null, 'a spawn that throws synchronously');
});

test('#172: a failed refresh does not poison the last good answer', async () => {
  await liveAgents.refresh({ exec: fakeExec(REAL_OUTPUT) });
  await liveAgents.refresh({ exec: fakeExec('', { fail: true }) });
  assert.equal(liveAgents.peek().length, 2,
    'the CLI hiccuping once must not make the app forget what it knows');
});

test('#172: two callers in the same tick share one child process', async () => {
  const exec = fakeExec(REAL_OUTPUT);
  const [a, b] = await Promise.all([liveAgents.refresh({ exec }), liveAgents.refresh({ exec })]);
  assert.equal(exec.calls.length, 1, 'the poller and a manual refresh must not each spawn a CLI');
  assert.equal(a, b);
});

test('#172: it is asked with two literal arguments and a timeout, never through a shell', async () => {
  const exec = fakeExec(REAL_OUTPUT);
  await liveAgents.refresh({ exec, bin: 'C:\\bin\\claude.EXE' });
  const [call] = exec.calls;
  assert.deepEqual(call.args, ['agents', '--json']);
  assert.equal(call.opts.shell, false, 'a real executable needs no shell');
  assert.equal(call.opts.timeout, liveAgents.DEFAULT_TIMEOUT_MS);
  assert.equal(call.opts.windowsHide, true, 'a poller must not flash a console window every interval');
});

test('#172: an npm `.cmd` shim is the one case that needs a shell', async () => {
  const exec = fakeExec(REAL_OUTPUT);
  await liveAgents.refresh({ exec, bin: 'C:\\npm\\claude.cmd' });
  assert.equal(exec.calls[0].opts.shell, true,
    'Node refuses to spawn a .cmd without one, and the arguments are two constants');
});

// #241, one layer along. The CLI is spawned from the MAIN process here, not from a session's PTY — and
// main's own environment never carries CLAUDE_CONFIG_DIR. Without the merge, an isolated instance asks
// the user's REAL installation what is running and reports those sessions as its own. A path-composition
// guard cannot see this: nothing composes a path, a child process simply inherits the wrong home.
test('#172/#241: the CLI is asked inside the ISOLATED home, not the real one', async () => {
  const path = require('node:path');
  const claude = require('../src/backends/claude');
  const realRefresh = liveAgents.refresh;
  const before = process.env.SWITCHBOARD_STORE_CLAUDE;
  let seen = null;
  liveAgents.refresh = (opts) => { seen = opts; return Promise.resolve(null); };
  process.env.SWITCHBOARD_STORE_CLAUDE = path.join('C', 'temp', 'sandbox', '.claude', 'projects');
  try {
    await claude.refreshLiveOwners();
    assert.equal(seen.env.CLAUDE_CONFIG_DIR, path.join('C', 'temp', 'sandbox', '.claude'),
      'the sandbox home, or the poller reports the real machine\'s live sessions');
  } finally {
    liveAgents.refresh = realRefresh;
    if (before === undefined) delete process.env.SWITCHBOARD_STORE_CLAUDE;
    else process.env.SWITCHBOARD_STORE_CLAUDE = before;
  }
});

test('#172: an entry with no session id is not an entry', () => {
  const parsed = liveAgents._parseAgents(JSON.stringify([
    { kind: 'background', name: 'nameless' },
    { sessionId: '  ', kind: 'interactive' },
    { sessionId: 'ok-1', kind: 'weird' },
  ]));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].sessionId, 'ok-1');
  assert.equal(parsed[0].kind, 'unknown', 'a kind this build does not know is not silently called interactive');
});
