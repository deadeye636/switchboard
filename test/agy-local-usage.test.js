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
