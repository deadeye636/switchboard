'use strict';
// The reader behind the session-discovery tools (#507 Phase 1, spec 35).
//
// For ONE project — the caller session's — it answers four questions: which sessions the project has
// (across backends), a bounded view of one session's recent turns, which handoff packets the project
// keeps, and one slice of a packet. It reads only what the app already indexes, spawns nothing, writes
// nothing and has no IPC handler: the bridge handler calls it through `entry.discovery` (spec 35, D8).
//
// Electron-free and db-free. It is a factory over plain dependencies, so a test builds it with fakes and
// main.js hands it the real readers (`createDiscoveryReader` in the spawn ctx). Nothing here is module state.
//
// Scope (D2, D11): every answer is derived from a listing that is re-built on each call and bounded to the
// caller's project. A session or a handoff is named by an id and answered only when the fresh listing holds
// it, so an id of another project and an id that does not exist give the same sentence — no existence oracle.
// A result is `{ ok: true, ... }` or `{ ok: false, error }`; the bridge turns the second into `isError`.

const path = require('path');
const { samePath, pathKey } = require('./path-containment');
const { buildTurnView, DEFAULTS: TURN_DEFAULTS, MAXIMA: TURN_MAXIMA } = require('../session/turn-view');

const NO_SUCH_SESSION = 'No such session in this project.';
const NO_SUCH_HANDOFF = 'No such handoff in this project.';
const UNAVAILABLE = 'Session discovery is not available right now.';
const NO_PROJECT = 'This session has no project, so there is nothing to list.';

const LIMITS = Object.freeze({
  sessions: { def: 25, max: 100 },
  handoffs: { def: 20, max: 50 },
  handoffChars: { def: 16000, max: 32000 },
});
const TITLE_CAP = 120;
const FIRST_PROMPT_CAP = 200;
// A turn is a user message and the assistant messages that follow it; the digest is asked for a few more
// messages than turns, and the builder cuts to the turn cap.
const MESSAGES_PER_TURN = 8;
const MAX_MESSAGES = 400;
const DIGEST_TIMEOUT_MS = 15000;

function clamp(value, def, max, min = 1) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** At most `cap` code points, with an ellipsis when something was cut. */
function cap(text, limit) {
  const chars = Array.from(String(text == null ? '' : text).replace(/\s+/g, ' ').trim());
  return chars.length <= limit ? chars.join('') : chars.slice(0, limit - 1).join('') + '…';
}

function iso(value) {
  if (value == null || value === '') return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function capabilityState(descriptor, id) {
  const c = descriptor && descriptor.capabilities && descriptor.capabilities[id];
  return typeof c === 'string' ? c : (c && c.state) || null;
}

/**
 * @param {object} deps
 *   projectPath        the caller's project; every answer is bounded to it
 *   callerSessionId    the calling session, marked `self` in the list
 *   getCachedSessions  () => session_cache rows (all projects; this module filters)
 *   getSessionMeta     () => Map<sessionId, { name, archived }> — what the user decided
 *   activeSessions     Map<sessionId, { exited }> — the live-process map
 *   backends           the registry (`get(id)`) — the only source of a backend's label and transcript reader
 *   handoffs           { getHandoffs(projectPath), isAllowedHandoffPath(file, projectPath) }
 *   isForeignNetworkFile  (path) => boolean — a network path is refused before any stat
 *   log                electron-log
 */
function createDiscoveryReader(deps = {}) {
  const { projectPath, callerSessionId = null, log } = deps;
  const warn = (message, err) => {
    try { if (log && log.warn) log.warn(`[discovery] ${message}${err ? `: ${err && err.message ? err.message : err}` : ''}`); } catch {}
  };
  const unavailable = (what) => {
    try { if (log && log.error) log.error(`[discovery] ${what}`); } catch {}
    return { ok: false, error: UNAVAILABLE };
  };
  const hasProject = typeof projectPath === 'string' && projectPath.trim() !== '';

  function labelOf(backendId) {
    try {
      const d = deps.backends && deps.backends.get(backendId);
      return (d && d.label) || backendId;
    } catch { return backendId; }
  }

  function isLive(sessionId) {
    const s = deps.activeSessions && deps.activeSessions.get && deps.activeSessions.get(sessionId);
    return !!s && !s.exited;
  }

  function rowOf(row, meta) {
    const m = meta && meta.get ? meta.get(row.sessionId) : null;
    const backendId = row.backendId || null;
    return {
      id: row.sessionId,
      backend: { id: backendId, label: labelOf(backendId) },
      title: cap((m && m.name) || row.aiTitle || row.summary || row.firstPrompt || '', TITLE_CAP),
      firstPrompt: cap(row.firstPrompt || '', FIRST_PROMPT_CAP),
      state: isLive(row.sessionId) ? 'running' : 'stopped',
      lastActivity: iso(row.lastEntryAt || row.modified),
      startedAt: iso(row.startedAt || row.created),
      turns: row.userMessageCount || 0,
      messages: row.messageCount || 0,
      self: row.sessionId === callerSessionId,
    };
  }

  /** The project's sessions, newest activity first — subagent and archived rows left out. Re-derived per call. */
  function derive() {
    if (typeof deps.getCachedSessions !== 'function' || typeof deps.getSessionMeta !== 'function') return null;
    const rows = deps.getCachedSessions() || [];
    const meta = deps.getSessionMeta() || new Map();
    const key = pathKey(projectPath);
    if (!key) return [];
    const out = [];
    for (const row of rows) {
      if (!row || !row.sessionId || !row.projectPath) continue;
      if (row.parentSessionId || row.agentId) continue;
      const m = meta.get ? meta.get(row.sessionId) : null;
      if (m && m.archived) continue;
      if (pathKey(row.projectPath) !== key) continue;
      out.push({ row, view: rowOf(row, meta) });
    }
    out.sort((a, b) => String(b.view.lastActivity || '').localeCompare(String(a.view.lastActivity || '')));
    return out;
  }

  function listSessions(args = {}) {
    if (!hasProject) return { ok: false, error: NO_PROJECT };
    try {
      const all = derive();
      if (!all) return unavailable('listSessions: the session reader is missing');
      const limit = clamp(args.limit, LIMITS.sessions.def, LIMITS.sessions.max);
      return { ok: true, total: all.length, sessions: all.slice(0, limit).map((e) => e.view) };
    } catch (err) {
      warn('listSessions failed', err);
      return { ok: false, error: UNAVAILABLE };
    }
  }

  async function readSession(args = {}) {
    if (!hasProject) return { ok: false, error: NO_PROJECT };
    try {
      const all = derive();
      if (!all) return unavailable('readSession: the session reader is missing');
      const id = typeof args.sessionId === 'string' ? args.sessionId : '';
      // The listing is the allow-list: a session of another project and one that does not exist are both
      // simply absent from it, and answer the same sentence.
      const hit = id ? all.find((e) => e.row.sessionId === id) : null;
      if (!hit) return { ok: false, error: NO_SUCH_SESSION };
      // The row's project is the caller's by the key compare above; the real-path compare is the guard.
      if (!samePath(hit.row.projectPath, projectPath)) return { ok: false, error: NO_SUCH_SESSION };

      const descriptor = deps.backends && deps.backends.get(hit.row.backendId);
      const state = capabilityState(descriptor, 'turnDigest');
      if (!descriptor || typeof descriptor.readTurnDigest !== 'function' || state === 'no') {
        return { ok: true, session: hit.view, available: false, reason: 'No transcript view is available for this backend.' };
      }
      const turns = clamp(args.turns, TURN_DEFAULTS.turns, TURN_MAXIMA.turns);
      const maxMessages = Math.min(MAX_MESSAGES, turns * MESSAGES_PER_TURN);
      let digest = null;
      try {
        digest = await descriptor.readTurnDigest(hit.row, { maxMessages, signal: AbortSignal.timeout(DIGEST_TIMEOUT_MS) });
      } catch (err) {
        warn(`readTurnDigest failed for a ${hit.row.backendId} session`, err);
        return { ok: true, session: hit.view, available: false, reason: 'The transcript could not be read.' };
      }
      if (!digest || !Array.isArray(digest.messages)) {
        return { ok: true, session: hit.view, available: false, reason: 'No transcript view is available for this session.' };
      }
      const view = buildTurnView(digest.messages, {
        turns: args.turns,
        roles: args.roles,
        maxCharsPerTurn: args.maxCharsPerTurn,
        partial: digest.partial === true,
      });
      const result = {
        ok: true, session: hit.view, available: true,
        turns: view.turns, returned: view.returned, omitted: view.omitted, partial: view.partial,
      };
      if (view.partial || view.omitted > 0) {
        result.note = 'Older history exists that this call did not return.';
      }
      return result;
    } catch (err) {
      warn('readSession failed', err);
      return { ok: false, error: UNAVAILABLE };
    }
  }

  /** The id of a packet: its path relative to the project root, with forward slashes. */
  function handoffId(filePath) {
    return path.relative(path.resolve(projectPath), filePath).split(path.sep).join('/');
  }

  function derivedHandoffs() {
    const h = deps.handoffs;
    if (!h || typeof h.getHandoffs !== 'function' || typeof h.isAllowedHandoffPath !== 'function') return null;
    return (h.getHandoffs(projectPath) || []).map((row) => ({ row, id: handoffId(row.filePath) }));
  }

  function listHandoffs(args = {}) {
    if (!hasProject) return { ok: false, error: NO_PROJECT };
    try {
      const all = derivedHandoffs();
      if (!all) return unavailable('listHandoffs: the handoff reader is missing');
      const limit = clamp(args.limit, LIMITS.handoffs.def, LIMITS.handoffs.max);
      return {
        ok: true,
        total: all.length,
        handoffs: all.slice(0, limit).map(({ row, id }) => ({
          id,
          title: row.title,
          modified: row.modified,
          createdAt: row.createdAt || null,
          backend: row.backendId || null,
          bytes: Buffer.byteLength(row.content || '', 'utf8'),
        })),
      };
    } catch (err) {
      warn('listHandoffs failed', err);
      return { ok: false, error: UNAVAILABLE };
    }
  }

  // An id that is not a plain relative `.md` path under the project root is refused before anything is
  // resolved: no `..`, no absolute or drive path, no backslash, no network prefix.
  function plainRelativeId(id) {
    if (typeof id !== 'string' || id === '' || id.length > 1024) return false;
    if (id.includes('\\') || id.includes('\0') || id.startsWith('/') || /^[A-Za-z]:/.test(id)) return false;
    if (id.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return false;
    return id.toLowerCase().endsWith('.md');
  }

  function readHandoff(args = {}) {
    if (!hasProject) return { ok: false, error: NO_PROJECT };
    try {
      const id = args.id;
      if (!plainRelativeId(id)) return { ok: false, error: NO_SUCH_HANDOFF };
      const resolved = path.resolve(projectPath, id);
      // A network path is refused before any stat (#780); then it must be an allowed handoff path of THIS
      // project and be in the fresh listing.
      if (typeof deps.isForeignNetworkFile === 'function' && deps.isForeignNetworkFile(resolved)) {
        return { ok: false, error: NO_SUCH_HANDOFF };
      }
      const h = deps.handoffs;
      if (!h || typeof h.isAllowedHandoffPath !== 'function' || typeof h.getHandoffs !== 'function') {
        return unavailable('readHandoff: the handoff reader is missing');
      }
      if (!h.isAllowedHandoffPath(resolved, projectPath)) return { ok: false, error: NO_SUCH_HANDOFF };
      const hit = derivedHandoffs().find((e) => e.id === id);
      if (!hit) return { ok: false, error: NO_SUCH_HANDOFF };

      const chars = Array.from(hit.row.content || '');
      const offset = Math.min(chars.length, Math.max(0, Math.floor(Number(args.offset)) || 0));
      const maxChars = clamp(args.maxChars, LIMITS.handoffChars.def, LIMITS.handoffChars.max);
      const slice = chars.slice(offset, offset + maxChars);
      return {
        ok: true,
        id,
        title: hit.row.title,
        offset,
        returned: slice.length,
        total: chars.length,
        more: offset + slice.length < chars.length,
        text: slice.join(''),
      };
    } catch (err) {
      warn('readHandoff failed', err);
      return { ok: false, error: UNAVAILABLE };
    }
  }

  return { listSessions, readSession, listHandoffs, readHandoff };
}

module.exports = { createDiscoveryReader, NO_SUCH_SESSION, NO_SUCH_HANDOFF, UNAVAILABLE, LIMITS };
