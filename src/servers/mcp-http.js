/**
 * mcp-http.js — One app-wide streamable-HTTP listener for the MCP bridge.
 *
 * Where Claude keeps a WebSocket server per session (mcp-bridge.js), the other backends share a single
 * loopback HTTP listener for the whole app instance. A session is a REGISTRATION on it, named by a
 * Bearer token rather than by a socket. The request handling, the registry, the pending-diff lifecycle
 * and the re-key on fork all belong to mcp-bridge.js and are reused here unchanged — this module only
 * owns the socket, the token, and the reply shape (a JSON body or an SSE event).
 *
 * Granularity (O9) and the DNS-rebinding guard are in docs/specs/34-switchboard-mcp-server.md
 * ("The diff tool for agy", "Granularity (O9)").
 */

'use strict';

const http = require('http');
const crypto = require('crypto');
const bridge = require('./mcp-bridge');

// The streamable-HTTP endpoint. agy opens it with POST (a JSON-RPC body) and a GET (the server→client
// SSE channel); every other path is a probe or a mistake and gets a 404.
const ENDPOINT_PATH = '/mcp';

// A request body cap: every POST body is JSON.parsed on the main process, so a same-user client must not
// be able to spike RSS / block the event loop with a giant frame. Matches the ws transport's maxPayload.
const MAX_BODY_BYTES = 8 * 1024 * 1024;

// ── Module state (one listener per app instance) ─────────────────────

let server = null;        // the single http.Server, bound lazily on first registerSession
let binding = null;       // Promise<{ ok: true } | { ok: false, reason }> — the in-flight / settled bind
let boundPort = null;     // the OS-assigned loopback port once listening

// token → registration { token, tokenDigest, entry }. Keyed by the token so a re-key (which changes the
// session id but not the token) needs no bookkeeping here; auth iterates the VALUES in constant time.
const registrations = new Map();

// ── JSON-RPC frame builders (the same envelope mcp-bridge writes) ────

function rpcResultFrame(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function rpcErrorFrame(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

// ── Auth: constant-time, no length leak ──────────────────────────────

// Compare two tokens without leaking their length or an early mismatch. Hashing to a fixed 32-byte digest
// first means timingSafeEqual never sees unequal-length buffers (which would throw and leak the length),
// and the compare itself is constant-time over the digest.
function tokensEqual(a, b) {
  const da = crypto.createHash('sha256').update(String(a)).digest();
  const db = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(da, db);
}

// Resolve a presented Bearer token to its registration, comparing against every live one in constant
// time. One token reaches exactly one registration, so a session's token can never address another's.
function authenticate(presented) {
  if (!presented) return null;
  for (const reg of registrations.values()) {
    if (tokensEqual(presented, reg.token)) return reg;
  }
  return null;
}

function bearerOf(req) {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return null;
  const m = /^Bearer\s+(.+)$/.exec(header);
  return m ? m[1] : null;
}

// ── DNS-rebinding guard (loopback only) ──────────────────────────────

// The streamable-HTTP transport asks for this: a Host that is not our loopback address and port, or ANY
// Origin header at all, is a browser or a rebind attempt rather than the local CLI, and is refused.
function originAndHostOk(req) {
  if (req.headers['origin'] !== undefined) return false;
  const host = req.headers['host'];
  return host === `127.0.0.1:${boundPort}`;
}

// ── Reply shape: JSON body vs SSE event (the O-T6c seam) ─────────────

// agy accepted both a JSON-on-POST reply and an SSE "server upgrades the POST" reply, and which it
// ultimately needs is unknown until G2 (spec, O-T6c). So the mode is a clear seam decided per request
// from the Accept header, and the writer below answers in either shape. A GET opens a long-lived SSE
// channel; a POST reply in `sse` mode is a single event that then ends the response.
function replyModeFor(req) {
  const accept = String(req.headers['accept'] || '');
  return accept.includes('text/event-stream') ? 'sse' : 'json';
}

// Open the SSE headers for a POST answered as a stream, so the client sees the channel before the (often
// much later) openDiff result arrives. A JSON-mode reply defers all headers until the frame is ready.
function openSseResponse(res) {
  if (res.headersSent) return;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
}

function writeFrame(target, frame) {
  const { res, mode } = target;
  if (res.writableEnded) return;
  if (mode === 'sse') {
    openSseResponse(res);
    res.write(`event: message\ndata: ${frame}\n\n`);
    res.end();
  } else {
    if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(frame);
  }
}

// The reply callback an http entry carries. mcp-bridge's sendResult/sendError call it with the finished
// frame; it routes by the request id to the response that is still parked on that id. A frame with no
// parked response (a notification, or one already answered) is simply dropped.
function makeReply(entry) {
  return (frame) => {
    let id;
    try { id = JSON.parse(frame).id; } catch { id = undefined; }
    if (id === undefined || id === null) return;
    const target = entry.pendingHttp.get(id);
    if (!target) return;
    entry.pendingHttp.delete(id);
    writeFrame(target, frame);
  };
}

// ── HTTP responses ───────────────────────────────────────────────────

function sendStatus(res, code, body) {
  if (res.writableEnded || res.headersSent) return;
  res.writeHead(code, { 'Content-Type': 'text/plain' });
  res.end(body || '');
}

// ── Request handling (every path wrapped) ────────────────────────────

// A GET with an SSE Accept opens the server→client channel and keeps it open — this is where a streamed
// reply or a server push goes (none in Plan A, but agy opens it, so it must not be a 405). One channel
// per registration; a second GET replaces the first.
function handleGet(reg, req, res) {
  const entry = reg.entry;
  openSseResponse(res);
  // Flush the headers to the client right away with an SSE comment — a bare writeHead on a streaming
  // response is not sent until the first body chunk, so without this the client never sees the channel open.
  res.write(': open\n\n');
  if (entry.sseChannel && entry.sseChannel !== res && !entry.sseChannel.writableEnded) {
    try { entry.sseChannel.end(); } catch {}
  }
  entry.sseChannel = res;
  const drop = () => { if (entry.sseChannel === res) entry.sseChannel = null; };
  req.on('close', drop);
  res.on('close', drop);
}

async function handlePost(reg, req, res, log) {
  const entry = reg.entry;
  const mode = replyModeFor(req);

  // Collect the body under the cap.
  const chunks = [];
  let size = 0;
  let overflowed = false;
  const body = await new Promise((resolve) => {
    req.on('data', (chunk) => {
      if (overflowed) return;          // past the cap: drain and discard the rest, do not tear the socket
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        overflowed = true;
        chunks.length = 0;             // free what we held; the body is refused
        return;
      }
      chunks.push(chunk);
    });
    // Resolve on `end` either way — draining the oversize body to completion lets the 413 reach the client
    // as a clean response instead of a connection reset mid-upload.
    req.on('end', () => resolve(overflowed ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });

  if (overflowed) {
    sendStatus(res, 413, 'Payload Too Large');
    return;
  }

  let msg;
  try {
    msg = JSON.parse(body);
  } catch {
    writeFrame({ res, mode }, rpcErrorFrame(null, -32700, 'Parse error'));
    return;
  }

  const id = msg && msg.id;

  // Notifications (no id) are fire-and-forget — hand to the shared handler, answer 202, expect no reply.
  if (id === undefined || id === null) {
    try { bridge.dispatchMessage(entry, body, log); } catch (err) {
      if (log) log.error(`[mcp-http] notification dispatch threw: ${err && err.message}`);
    }
    sendStatus(res, 202, '');
    return;
  }

  // server/discover is agy's opener; answer it here with the entry's own manifest. Everything else goes
  // through the shared handler (initialize, tools/list, tools/call, …) so it behaves as a ws entry would.
  if (msg.method === 'server/discover') {
    writeFrame({ res, mode }, rpcResultFrame(id, { tools: bridge.toolsForEntry(entry) }));
    return;
  }

  // Park the response on the request id; the shared handler's reply will land here (possibly much later,
  // for an openDiff that waits on the renderer). In SSE mode open the stream now so the client sees it.
  entry.pendingHttp.set(id, { res, mode });
  if (mode === 'sse') openSseResponse(res);

  // The handler-wrap: a throw (or a rejected tool call) answers a JSON-RPC error on this id and leaves
  // the listener untouched, so the next request still works.
  try {
    await bridge.dispatchMessage(entry, body, log);
  } catch (err) {
    if (log) log.error(`[mcp-http] handler threw for ${msg.method}: ${err && err.message}`);
    const target = entry.pendingHttp.get(id);
    if (target) {
      entry.pendingHttp.delete(id);
      writeFrame(target, rpcErrorFrame(id, -32603, 'Internal error'));
    }
  }
}

function onRequest(req, res, log) {
  // The outer wrap: nothing a single request does may throw out of here and take the listener down.
  try {
    const urlPath = String(req.url || '').split('?')[0];

    // The DNS-rebinding guard applies to every request, before anything else is read.
    if (!originAndHostOk(req)) {
      sendStatus(res, 403, 'Forbidden');
      return;
    }

    // OAuth discovery probes: agy asks, Switchboard is not an OAuth resource server — 404 them.
    if (req.method === 'GET' && urlPath.startsWith('/.well-known/oauth-protected-resource')) {
      sendStatus(res, 404, 'Not Found');
      return;
    }

    if (urlPath !== ENDPOINT_PATH) {
      sendStatus(res, 404, 'Not Found');
      return;
    }

    // Bearer on every request, compared in constant time; wrong/absent is 401.
    const reg = authenticate(bearerOf(req));
    if (!reg) {
      sendStatus(res, 401, 'Unauthorized');
      return;
    }

    if (req.method === 'GET') {
      handleGet(reg, req, res);
      return;
    }
    if (req.method === 'POST') {
      handlePost(reg, req, res, log).catch((err) => {
        if (log) log.error(`[mcp-http] POST handling threw: ${err && err.message}`);
        sendStatus(res, 500, 'Internal Server Error');
      });
      return;
    }
    sendStatus(res, 405, 'Method Not Allowed');
  } catch (err) {
    if (log) log.error(`[mcp-http] request handling threw: ${err && err.message}`);
    try { sendStatus(res, 500, 'Internal Server Error'); } catch {}
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────

// Bind the single listener once, on the first registration. A bind failure resolves to { ok: false }
// (so registerSession returns "unavailable" and the spawn path reads a result, never a throw) and clears
// the memo so a later spawn can retry.
function ensureListener(log) {
  if (binding) return binding;
  binding = new Promise((resolve) => {
    const srv = http.createServer((req, res) => onRequest(req, res, log));
    const onError = (err) => {
      binding = null;
      if (log) log.error(`[mcp-http] listener bind failed: ${err && err.message}`);
      resolve({ ok: false, reason: `bind failed (${(err && err.code) || 'unknown'})` });
    };
    srv.once('error', onError);
    srv.listen(0, '127.0.0.1', () => {
      srv.off('error', onError);
      srv.on('error', (err) => { if (log) log.error(`[mcp-http] listener error: ${err && err.message}`); });
      server = srv;
      boundPort = srv.address().port;
      // Let mcp-bridge take the listener down at app quit without requiring this module (no cycle).
      bridge.setHttpListenerCloser(shutdownListener);
      resolve({ ok: true });
    });
  });
  return binding;
}

/**
 * Register a session on the app-wide HTTP listener.
 *
 * @returns {Promise<{ url, token, release } | { unavailable: true, reason }>}
 *   `release` deregisters the session: it invalidates the token (drops it from the registry so a later
 *   request with it is 401) and rejects every open diff of that session through the shared bridge, exactly
 *   as a ws session's shutdown does. A bind failure is reported as `unavailable`, never thrown.
 */
async function registerSession({ sessionId, projectPath, getWindow, groups, diffTimeoutMs, discovery, log }) {
  const bound = await ensureListener(log);
  if (!bound.ok) return { unavailable: true, reason: bound.reason };

  const token = crypto.randomBytes(32).toString('hex');
  const entry = bridge.createHttpEntry({ sessionId, getWindow, groups, projectPath, diffTimeoutMs, discovery });
  entry.pendingHttp = new Map();
  entry.sseChannel = null;
  entry.reply = makeReply(entry);

  const reg = { token, entry, projectPath };
  registrations.set(token, reg);
  if (log) log.info(`[mcp-http] session=${sessionId} registered on port ${boundPort}`);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    registrations.delete(token);
    if (entry.sseChannel && !entry.sseChannel.writableEnded) {
      try { entry.sseChannel.end(); } catch {}
    }
    entry.sseChannel = null;
    // Reject open diffs + clear the renderer + drop the entry — read the id live so a re-key is honoured.
    bridge.shutdownMcpServer(entry.sessionId, log);
  };

  return { url: `http://127.0.0.1:${boundPort}${ENDPOINT_PATH}`, token, release };
}

// Close the socket and every open server→client stream, and forget the bind so a later run can rebind.
// Called by bridge.shutdownAll after it has already settled each session's diffs.
function shutdownListener() {
  for (const reg of registrations.values()) {
    const ch = reg.entry.sseChannel;
    if (ch && !ch.writableEnded) { try { ch.end(); } catch {} }
    reg.entry.sseChannel = null;
  }
  registrations.clear();
  if (server) { try { server.close(); } catch {} }
  server = null;
  boundPort = null;
  binding = null;
  bridge.setHttpListenerCloser(null);
}

module.exports = {
  registerSession,
  shutdownListener,
  // Exposed for tests/measurement; not part of the spawn-path contract.
  MAX_BODY_BYTES,
  ENDPOINT_PATH,
};
