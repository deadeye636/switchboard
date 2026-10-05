const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const local = require('../src/backends/agy/local-usage');

test('agy local usage: Windows netstat is scoped to the owning pid and listening sockets', () => {
  const text = [
    '  TCP    127.0.0.1:43111      0.0.0.0:0      LISTENING       42',
    '  TCP    127.0.0.1:43112      127.0.0.1:9    ESTABLISHED     42',
    '  TCP    [::1]:43113          [::]:0         ABHÖREN         42',
    '  TCP    127.0.0.1:43114      0.0.0.0:0      LISTENING       99',
  ].join('\r\n');
  assert.deepEqual(local.parseWindowsNetstat(text, 42), [43111, 43113]);
});

test('agy local usage: lsof parser returns unique listening ports', () => {
  const text = [
    'agy 42 user 12u IPv4 TCP 127.0.0.1:43111 (LISTEN)',
    'agy 42 user 13u IPv6 TCP [::1]:43111 (LISTEN)',
    'agy 42 user 14u IPv4 TCP 127.0.0.1:43112 (LISTEN)',
  ].join('\n');
  assert.deepEqual(local.parseLsof(text), [43111, 43112]);
});

test('agy local usage: proc parser matches only listening socket inodes', () => {
  const text = [
    'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode',
    '0: 0100007F:A867 00000000:0000 0A 0:0 00:0 0 1000 0 12345',
    '1: 0100007F:A868 0100007F:0016 01 0:0 00:0 0 1000 0 12346',
  ].join('\n');
  assert.deepEqual(local.parseProcNet(text, new Set(['12345', '12346'])), [43111]);
});

test('agy local usage: quota summary is preferred over legacy model endpoints', async () => {
  const calls = [];
  const result = await local.fetchFromPid(42, {
    listeningPorts: async () => [43111],
    postJson: async (_port, requestPath) => {
      calls.push(requestPath);
      return { response: { groups: [{ displayName: 'Gemini Models', buckets: [] }] } };
    },
  });
  assert.equal(result.kind, 'summary');
  assert.deepEqual(calls, [local.QUOTA_SUMMARY_PATH]);
});

test('agy local usage: model config is the fallback when quota summary is absent', async () => {
  const result = await local.fetchFromPid(42, {
    listeningPorts: async () => [43111],
    postJson: async (_port, requestPath) => {
      if (requestPath === local.QUOTA_SUMMARY_PATH) return {};
      if (requestPath === local.USER_STATUS_PATH) {
        return { userStatus: { cascadeModelConfigData: { clientModelConfigs: [] } } };
      }
      throw new Error('unexpected endpoint');
    },
  });
  assert.equal(result.kind, 'models');
});

test('agy local usage: blocking authentication prompts are detected', () => {
  assert.equal(local.containsAuthPrompt('Select login method:'), true);
  assert.equal(local.containsAuthPrompt('You are not logged into Antigravity'), true);
  assert.equal(local.containsAuthPrompt('Ready for a prompt'), false);
});

test('agy local usage: endpoint authentication and rate limits stay distinct', async () => {
  const denied = await local.fetchFromPid(42, {
    listeningPorts: async () => [43111],
    postJson: async () => { const err = new Error('denied'); err.status = 403; throw err; },
  });
  assert.equal(denied.kind, 'authRequired');

  const throttled = await local.fetchFromPid(42, {
    listeningPorts: async () => [43111],
    postJson: async () => {
      const err = new Error('slow down');
      err.status = 429;
      err.retryAfterSeconds = 120;
      throw err;
    },
  });
  assert.deepEqual(throttled, { kind: 'rateLimited', retryAfterSeconds: 120 });
});

test('agy local usage: a managed probe asks its owned process to exit after a successful read', async () => {
  const writes = [];
  const fakeProcess = {
    pid: 2147483646,
    onData: () => {},
    onExit: () => {},
    write: value => writes.push(value),
    kill: () => {},
  };
  const result = await local.runManagedProbe('agy', {
    pty: { spawn: () => fakeProcess },
    listeningPorts: async () => [43111],
    postJson: async () => ({ response: { groups: [{ displayName: 'Gemini', buckets: [] }] } }),
    delay: async () => {},
  });
  assert.equal(result.kind, 'summary');
  assert.deepEqual(writes, ['/exit\r']);
});

// A stand-in for https.request: enough of the shape postJson drives, none of the network.
function fakeRequest({ statusCode = 200, body = '', headers = {} }) {
  return (_options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = statusCode;
      res.headers = headers;
      callback(res);
      setImmediate(() => {
        if (body) res.emit('data', Buffer.from(body));
        res.emit('end');
      });
    };
    return req;
  };
}

test('agy local usage: a response that is not JSON is rejected, never parsed half-way', async () => {
  await assert.rejects(
    () => local.postJson(43111, local.QUOTA_SUMMARY_PATH, {}, { requestImpl: fakeRequest({ body: '<html>nope' }) }),
    /not JSON/,
  );
});

test('agy local usage: an HTTP status is carried on the error, 401 included', async () => {
  await assert.rejects(
    () => local.postJson(43111, local.QUOTA_SUMMARY_PATH, {}, { requestImpl: fakeRequest({ statusCode: 401, body: '{}' }) }),
    err => err.status === 401,
  );

  const denied = await local.fetchFromPid(42, {
    listeningPorts: async () => [43111],
    postJson: async () => { const err = new Error('unauthorized'); err.status = 401; throw err; },
  });
  assert.equal(denied.kind, 'authRequired');
});

test('agy local usage: a 401 saying the CSRF token is missing is csrfRequired, a plain 401 stays authRequired', async () => {
  const csrfBody = '{"code":"unauthenticated","message":"missing CSRF token"}';
  const csrf = await local.fetchFromPid(42, {
    listeningPorts: async () => [43111],
    postJson: (port, requestPath, payload, opts) => local.postJson(port, requestPath, payload, {
      ...opts, requestImpl: fakeRequest({ statusCode: 401, body: csrfBody }),
    }),
  });
  assert.equal(csrf.kind, 'csrfRequired');

  const plain = await local.fetchFromPid(42, {
    listeningPorts: async () => [43111],
    postJson: (port, requestPath, payload, opts) => local.postJson(port, requestPath, payload, {
      ...opts, requestImpl: fakeRequest({ statusCode: 401, body: '{"code":"unauthenticated","message":"not signed in"}' }),
    }),
  });
  assert.equal(plain.kind, 'authRequired');
});

const CSRF_BODY = '{"code":"unauthenticated","message":"missing CSRF token"}';
const failing = (status, body = '{}') => () => {
  const err = new Error(`HTTP ${status}`);
  err.status = status;
  err.body = body;
  err.retryAfterSeconds = status === 429 ? 30 : 0;
  throw err;
};
const csrf401 = failing(401, CSRF_BODY);
const plain401 = failing(401);
const limited429 = failing(429);
const reading = () => ({ response: { groups: [{ displayName: 'Gemini', buckets: [] }] } });

test('agy local usage: ports of one pid combine by strength, whatever the order', async () => {
  const cases = [
    ['csrf then plain 401', [csrf401, plain401], 'csrfRequired'],
    ['plain 401 then csrf', [plain401, csrf401], 'csrfRequired'],
    ['csrf then 429', [csrf401, limited429], 'rateLimited'],
    ['429 then csrf', [limited429, csrf401], 'rateLimited'],
  ];
  for (const [name, handlers, kind] of cases) {
    const result = await local.fetchFromPid(42, {
      listeningPorts: async () => handlers.map((_, i) => 43111 + i),
      postJson: async (port) => handlers[port - 43111](),
    });
    assert.equal(result.kind, kind, name);
  }
});

test('agy local usage: several pids keep the strongest failure and any reading wins', async () => {
  const run = (handlersByPid, livePids) => local.fetchLocalRaw({
    livePids,
    allowLaunch: false,
    deps: {
      discoverPids: async () => [],
      listeningPorts: async pid => [40000 + pid],
      postJson: async port => handlersByPid[port - 40000](),
    },
  });
  const cases = [
    ['csrf, plain', { 11: csrf401, 12: plain401 }, [11, 12], 'csrfRequired'],
    ['plain, csrf', { 11: plain401, 12: csrf401 }, [11, 12], 'csrfRequired'],
    ['csrf, 429', { 11: csrf401, 12: limited429 }, [11, 12], 'rateLimited'],
    ['429, csrf', { 11: limited429, 12: csrf401 }, [11, 12], 'rateLimited'],
    ['csrf, reading', { 11: csrf401, 12: reading }, [11, 12], 'summary'],
    ['reading, csrf', { 11: reading, 12: csrf401 }, [11, 12], 'summary'],
  ];
  for (const [name, handlers, pids, kind] of cases) {
    local.resetProbeBackoff();
    assert.equal((await run(handlers, pids)).kind, kind, name);
  }
});

test('agy local usage: a 429 without Retry-After is still a rate limit, with the shared default wait', async () => {
  const { DEFAULT_USAGE_RETRY_SECONDS } = require('../src/backends/usage-cache');
  const noWait = () => { const err = new Error('slow down'); err.status = 429; err.retryAfterSeconds = 0; throw err; };
  const result = await local.fetchFromPid(42, { listeningPorts: async () => [43111], postJson: async () => noWait() });
  assert.deepEqual(result, { kind: 'rateLimited', retryAfterSeconds: DEFAULT_USAGE_RETRY_SECONDS });
});

test('agy local usage: the longest named wait across ports wins', async () => {
  const waits = { 43111: 30, 43112: 90, 43113: 45 };
  const result = await local.fetchFromPid(42, {
    listeningPorts: async () => [43111, 43112, 43113],
    postJson: async (port) => { const err = new Error('slow'); err.status = 429; err.retryAfterSeconds = waits[port]; throw err; },
  });
  assert.equal(result.kind, 'rateLimited');
  assert.equal(result.retryAfterSeconds, 90);
});

test('agy local usage: a rate limit stops the pid search, an auth or CSRF refusal does not', async () => {
  const asked = [];
  const run = async (handlersByPid) => {
    asked.length = 0;
    local.resetProbeBackoff();
    return local.fetchLocalRaw({
      livePids: [11, 12, 13],
      allowLaunch: false,
      deps: {
        discoverPids: async () => [],
        listeningPorts: async pid => [40000 + pid],
        postJson: async (port) => { const pid = port - 40000; if (!asked.includes(pid)) asked.push(pid); return handlersByPid[pid](); },
      },
    });
  };
  assert.equal((await run({ 11: csrf401, 12: limited429, 13: reading })).kind, 'rateLimited');
  assert.deepEqual(asked, [11, 12]);
  assert.equal((await run({ 11: plain401, 12: csrf401, 13: reading })).kind, 'summary');
  assert.deepEqual(asked, [11, 12, 13]);
});

test('agy local usage: a payload with a shapeless groups field is not a reading', async () => {
  const result = await local.fetchFromPid(42, {
    listeningPorts: async () => [43111],
    postJson: async () => ({ response: { groups: 'all of them' } }),
  });
  assert.equal(result.kind, 'unavailable');
});

test('agy local usage: the Windows process list yields only agy pids', () => {
  const text = [
    '"agy.exe","4242","Console","1","120.000 K"',
    '"agy-helper.exe","4243","Console","1","12.000 K"',
    'INFO: No tasks are running which match the specified criteria.',
  ].join('\r\n');
  assert.deepEqual(local.parseWindowsTasklist(text), [4242]);
});

test('agy local usage: the POSIX process list yields only agy pids', () => {
  const text = [
    ' 4242 agy',
    ' 4243 /usr/local/bin/agy',
    ' 4244 agyx',
    ' 4245 node',
  ].join('\n');
  assert.deepEqual(local.parsePosixPs(text), [4242, 4243]);
});

test('agy local usage: a process Switchboard did not spawn is read before one is spawned (#509)', async () => {
  local.resetProbeBackoff();
  let spawns = 0;
  const result = await local.fetchLocalRaw({
    livePids: [],
    allowLaunch: true,
    findExecutable: () => 'agy',
    deps: {
      discoverPids: async () => [4242],
      listeningPorts: async pid => (pid === 4242 ? [43111] : []),
      postJson: async () => ({ response: { groups: [{ displayName: 'Gemini', buckets: [] }] } }),
      pty: { spawn: () => { spawns += 1; throw new Error('a probe must not be spawned here'); } },
      delay: async () => {},
    },
  });
  assert.equal(result.kind, 'summary');
  assert.equal(spawns, 0);
});

test('agy local usage: our own session is asked before a discovered process', async () => {
  local.resetProbeBackoff();
  const asked = [];
  await local.fetchLocalRaw({
    livePids: [9, 9],
    allowLaunch: false,
    deps: {
      // 9 appears in both lists, so this pins the order AND that no pid is asked twice.
      discoverPids: async () => [5, 9, 7],
      listeningPorts: async (pid) => { asked.push(pid); return []; },
    },
  });
  assert.deepEqual(asked, [9, 5, 7]);
});

test('agy local usage: a probe that fails backs off instead of respawning every poll (#509)', async () => {
  local.resetProbeBackoff();
  let spawns = 0;
  let clock = 1000;
  const fakeProcess = {
    pid: 2147483646,
    onData: cb => cb('Select login method:'),
    onExit: () => {},
    write: () => {},
    kill: () => {},
  };
  const call = () => local.fetchLocalRaw({
    livePids: [],
    allowLaunch: true,
    findExecutable: () => 'agy',
    deps: {
      now: () => clock,
      discoverPids: async () => [],
      pty: { spawn: () => { spawns += 1; return fakeProcess; } },
      delay: async () => {},
    },
  });

  const first = await call();
  assert.equal(first.kind, 'authRequired');
  assert.equal(spawns, 1);

  // The next poll, a minute later: the remembered answer, no second process.
  clock += 60 * 1000;
  const second = await call();
  assert.equal(second.kind, 'authRequired');
  assert.equal(spawns, 1);

  // Past the first wait, it tries again.
  clock += 5 * 60 * 1000;
  await call();
  assert.equal(spawns, 2);
});
