// backends/agy/local-usage.js — read the quota service exposed by a running `agy` process (#509).
//
// Current Antigravity releases own their OAuth token in the OS keyring and expose the same quota data
// that `/usage` renders through a loopback HTTPS service. Keeping the request here means AGY remains the
// owner of authentication and refresh; Switchboard never exports the keyring credential.
'use strict';

const fs = require('fs');
const https = require('https');
const os = require('os');
const { execFile } = require('child_process');

const QUOTA_SUMMARY_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';
const USER_STATUS_PATH = '/exa.language_server_pb.LanguageServerService/GetUserStatus';
const MODEL_CONFIG_PATH = '/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const PROBE_TIMEOUT_MS = 10000;
const AUTH_PATTERNS = [
  /select\s+login\s+method\s*:?/i,
  /you\s+are\s+not\s+logged\s+into\s+antigravity/i,
  /keyring\s*auth\s*:\s*timed\s+out\b/i,
];

function parseWindowsNetstat(output, pid) {
  const ports = new Set();
  for (const line of String(output || '').split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || fields[0].toUpperCase() !== 'TCP') continue;
    if (Number(fields[fields.length - 1]) !== Number(pid)) continue;
    const state = String(fields[fields.length - 2] || '').toUpperCase();
    if (!['LISTENING', 'LISTEN', 'ABHÖREN'].includes(state)) continue;
    const match = String(fields[1] || '').match(/:(\d+)$/);
    if (match) ports.add(Number(match[1]));
  }
  return [...ports].filter(validPort).sort((a, b) => a - b);
}

function parseLsof(output) {
  const ports = new Set();
  for (const match of String(output || '').matchAll(/:(\d+)\s+\(LISTEN\)/g)) ports.add(Number(match[1]));
  return [...ports].filter(validPort).sort((a, b) => a - b);
}

function parseProcNet(output, socketInodes) {
  const ports = new Set();
  for (const line of String(output || '').split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || fields[3] !== '0A' || !socketInodes.has(fields[9])) continue;
    const separator = fields[1].lastIndexOf(':');
    if (separator < 0) continue;
    const port = Number.parseInt(fields[1].slice(separator + 1), 16);
    if (validPort(port)) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

function validPort(port) {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function execFileText(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      encoding: 'utf8', windowsHide: true, timeout: 2500, maxBuffer: 1024 * 1024, ...opts,
    }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout || '');
    });
  });
}

function procListeningPorts(pid) {
  const root = `/proc/${pid}`;
  let entries;
  try { entries = fs.readdirSync(`${root}/fd`); } catch { return []; }
  const inodes = new Set();
  for (const entry of entries) {
    let target;
    try { target = fs.readlinkSync(`${root}/fd/${entry}`); } catch { continue; }
    const match = target.match(/^socket:\[(\d+)\]$/);
    if (match) inodes.add(match[1]);
  }
  if (inodes.size === 0) return [];
  const ports = new Set();
  for (const name of ['tcp', 'tcp6']) {
    let text;
    try { text = fs.readFileSync(`${root}/net/${name}`, 'utf8'); } catch { continue; }
    for (const port of parseProcNet(text, inodes)) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

async function listeningPorts(pid, deps = {}) {
  const run = deps.execFileText || execFileText;
  if (!Number.isInteger(pid) || pid <= 0) return [];
  if (process.platform === 'win32') {
    try { return parseWindowsNetstat(await run('netstat.exe', ['-ano', '-p', 'tcp']), pid); }
    catch { return []; }
  }
  try {
    return parseLsof(await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid)]));
  } catch {
    return process.platform === 'linux' ? procListeningPorts(pid) : [];
  }
}

function requestError(status, body) {
  const err = new Error(`Local AGY quota endpoint returned HTTP ${status}`);
  err.status = status;
  err.body = body;
  return err;
}

function postJson(port, requestPath, payload, { timeoutMs = 1200, requestImpl = https.request } = {}) {
  if (!validPort(port)) return Promise.reject(new Error('Invalid local AGY port'));
  const body = Buffer.from(JSON.stringify(payload || {}));
  return new Promise((resolve, reject) => {
    const req = requestImpl({
      hostname: '127.0.0.1', port, path: requestPath, method: 'POST',
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(body.length),
        'Connect-Protocol-Version': '1',
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(new Error('Local AGY quota response was too large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          const err = requestError(res.statusCode, text);
          err.retryAfterSeconds = Number.parseInt(res.headers['retry-after'] || '0', 10) || 0;
          return reject(err);
        }
        try { resolve(JSON.parse(text)); }
        catch { reject(new Error('Local AGY quota response was not JSON')); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Local AGY quota request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

function quotaSummaryPayload(raw) {
  const payload = raw && (raw.response || raw.summary || raw);
  return payload && Array.isArray(payload.groups) ? payload : null;
}

function modelConfigsPayload(raw) {
  const list = raw?.userStatus?.cascadeModelConfigData?.clientModelConfigs || raw?.clientModelConfigs;
  return Array.isArray(list) ? list : null;
}

async function fetchFromPid(pid, deps = {}) {
  const ports = await (deps.listeningPorts || listeningPorts)(pid, deps);
  const post = deps.postJson || postJson;
  let sawAuth = false;
  let retryAfterSeconds = 0;
  for (const port of ports) {
    try {
      const raw = await post(port, QUOTA_SUMMARY_PATH, { forceRefresh: true }, deps);
      if (quotaSummaryPayload(raw)) return { kind: 'summary', raw };
    } catch (err) {
      if (err?.status === 401 || err?.status === 403) sawAuth = true;
      if (err?.status === 429) retryAfterSeconds = Number(err.retryAfterSeconds || 0);
    }
    for (const requestPath of [USER_STATUS_PATH, MODEL_CONFIG_PATH]) {
      try {
        const raw = await post(port, requestPath, {
          metadata: { ideName: 'antigravity', extensionName: 'antigravity', ideVersion: 'unknown', locale: 'en' },
        }, deps);
        if (modelConfigsPayload(raw)) return { kind: 'models', raw };
      } catch (err) {
        if (err?.status === 401 || err?.status === 403) sawAuth = true;
        if (err?.status === 429) retryAfterSeconds = Number(err.retryAfterSeconds || 0);
      }
    }
  }
  if (retryAfterSeconds || sawAuth) {
    return retryAfterSeconds ? { kind: 'rateLimited', retryAfterSeconds } : { kind: 'authRequired' };
  }
  return { kind: 'unavailable' };
}

function containsAuthPrompt(output) {
  return AUTH_PATTERNS.some(pattern => pattern.test(String(output || '')));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err?.code === 'EPERM'; }
}

async function stopManagedProbe(proc, exited, deps = {}) {
  if (!proc) return;
  try { proc.write('/exit\r'); } catch {}
  await Promise.race([exited, (deps.delay || delay)(400)]);
  if (!isAlive(proc.pid)) return;
  try { proc.kill(); } catch {}
  await Promise.race([exited, (deps.delay || delay)(600)]);
  if (!isAlive(proc.pid) || process.platform !== 'win32') return;
  try {
    await (deps.execFileText || execFileText)('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F']);
  } catch { /* the process may have exited between the probe and taskkill */ }
}

async function runManagedProbe(executable, deps = {}) {
  let proc;
  let recentOutput = '';
  let resolveExited;
  const exited = new Promise(resolve => { resolveExited = resolve; });
  try {
    const pty = deps.pty || require('node-pty');
    proc = pty.spawn(executable, [], {
      name: 'xterm-256color', cols: 80, rows: 24, cwd: os.homedir(), env: deps.env || process.env,
    });
    proc.onData((data) => { recentOutput = (recentOutput + data).slice(-8192); });
    proc.onExit(() => resolveExited());
    const deadline = Date.now() + Number(deps.probeTimeoutMs || PROBE_TIMEOUT_MS);
    while (Date.now() < deadline) {
      if (containsAuthPrompt(recentOutput)) return { kind: 'authRequired' };
      const result = await fetchFromPid(proc.pid, deps);
      if (result.kind !== 'unavailable') return result;
      await (deps.delay || delay)(250);
    }
    return { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  } finally {
    await stopManagedProbe(proc, exited, deps);
  }
}

let _probePromise = null;

async function fetchLocalRaw({ livePids = [], allowLaunch = true, findExecutable, deps = {} } = {}) {
  for (const pid of [...new Set(livePids)].filter(Number.isInteger)) {
    const result = await fetchFromPid(pid, deps);
    if (result.kind !== 'unavailable') return result;
  }
  if (!allowLaunch || typeof findExecutable !== 'function') return { kind: 'unavailable' };
  const executable = findExecutable();
  if (!executable) return { kind: 'unavailable' };
  if (!_probePromise) {
    _probePromise = runManagedProbe(executable, deps).finally(() => { _probePromise = null; });
  }
  return _probePromise;
}

module.exports = {
  QUOTA_SUMMARY_PATH,
  USER_STATUS_PATH,
  MODEL_CONFIG_PATH,
  parseWindowsNetstat,
  parseLsof,
  parseProcNet,
  quotaSummaryPayload,
  modelConfigsPayload,
  containsAuthPrompt,
  postJson,
  fetchFromPid,
  fetchLocalRaw,
  runManagedProbe,
};
