const test = require('node:test');
const assert = require('node:assert/strict');

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
