'use strict';
// Per-spawn MCP injection (spec 34, "The injection capability"). Turns "sources" into neutral server rows,
// drops the rows a backend cannot take, asks the descriptor's `buildMcpInjection` hook, and hands back
// `{ args, env, release }`. Electron-free and db-free: everything it needs arrives as arguments, so
// `node --test` loads it. It names no backend; what a CLI accepts is a descriptor declaration.
//
// A source is a function `(ctx) => row[] | Promise<row[]>`, or an array of rows. Plan A has one source,
// "own server"; it is supplied by the caller. A source that throws costs only its own rows.
//
// Row: { name, transport: 'http' | 'stdio', url, headers, command, args, env }.
//
// The answer is `null` whenever this launch gets nothing: no capability, no row left, a hook that
// declines, or a hook that throws. Never an error.

const noop = () => {};

function isRow(row) {
  return !!row && typeof row === 'object' && typeof row.name === 'string' && row.name !== ''
    && (row.transport === 'http' || row.transport === 'stdio');
}

async function collectRows(sources, ctx, log) {
  const rows = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    try {
      const got = typeof source === 'function' ? await source(ctx) : source;
      for (const row of Array.isArray(got) ? got : []) {
        if (isRow(row)) rows.push(row);
        else log.debug('[mcp-inject] ignored a malformed server row');
      }
    } catch (err) {
      log.warn(`[mcp-inject] a source could not be read: ${err && err.message}`);
    }
  }
  return rows;
}

// The "own server" source (spec 34, D4/D9): Switchboard's own HTTP endpoint as one neutral row, for a
// launch that asked for it. `registerSession` arrives as an argument (the caller owns the server module),
// which keeps this file free of electron and db. The returned function carries a `release` that the
// composer runs together with the backend's cleanup, so the registration (token, open diffs) goes away
// with the launch — also when the composer ends up building nothing.
function ownServerSource({ backend, enabled, registerSession, sessionId, projectPath, getWindow, log } = {}) {
  const lg = { debug: noop, info: noop, warn: noop, ...(log || {}) };
  let registration = null;
  const source = async () => {
    const accepts = backend && Array.isArray(backend.acceptsMcpTransports) ? backend.acceptsMcpTransports : [];
    if (!accepts.includes('http') || enabled !== true || typeof registerSession !== 'function') return [];
    const got = await registerSession({ sessionId, projectPath, getWindow, groups: ['diff'], log });
    if (!got || got.unavailable || !got.url || !got.token) {
      lg.info(`[mcp-inject] own server unavailable: ${(got && got.reason) || 'no answer'}`);
      return [];
    }
    registration = got;
    return [{ name: 'switchboard', transport: 'http', url: got.url, headers: { Authorization: `Bearer ${got.token}` } }];
  };
  source.release = () => {
    const reg = registration;
    registration = null;
    if (reg && typeof reg.release === 'function') reg.release();
  };
  return source;
}

// `backend` is the descriptor. `ctx` is the app context (only `ctx.log` is read here).
async function composeMcpInjection({ backend, ctx, sources, dir, tag, cwd, options } = {}) {
  const log = { debug: noop, info: noop, warn: noop, ...((ctx && ctx.log) || {}) };
  if (!backend || backend.providesMcpInjection !== true || typeof backend.buildMcpInjection !== 'function') return null;
  // A source may hand back a `release` (a registration it made while being read). It runs once, with the
  // backend's cleanup, and on every path that ends without an injection.
  const sourceReleases = (Array.isArray(sources) ? sources : []).filter((s) => s && typeof s.release === 'function');
  let sourcesReleased = false;
  const releaseSources = () => {
    if (sourcesReleased) return;
    sourcesReleased = true;
    for (const s of sourceReleases) {
      try { s.release(); } catch (err) { log.warn(`[mcp-inject] source release failed: ${err && err.message}`); }
    }
  };
  try {
    const accepts = Array.isArray(backend.acceptsMcpTransports) ? backend.acceptsMcpTransports : [];
    const servers = [];
    for (const row of await collectRows(sources, ctx, log)) {
      if (accepts.includes(row.transport)) servers.push(row);
      else log.info(`[mcp-inject] dropped server "${row.name}": transport ${row.transport} is not accepted by ${backend.id || 'this backend'}`);
    }
    if (!servers.length) { releaseSources(); return null; }

    const built = await backend.buildMcpInjection({ dir, tag, cwd, servers, options, log });
    if (!built || typeof built !== 'object') { releaseSources(); return null; }

    let released = false;
    const cleanup = built.cleanup;
    const release = () => {
      if (released) return;
      released = true;
      releaseSources();
      if (cleanup == null) return;
      try {
        if (typeof backend.releaseMcpInjection === 'function') backend.releaseMcpInjection(cleanup, log);
        else if (typeof cleanup === 'function') cleanup();
      } catch (err) {
        log.warn(`[mcp-inject] release failed: ${err && err.message}`);
      }
    };
    return {
      args: Array.isArray(built.args) ? built.args : [],
      env: built.env && typeof built.env === 'object' ? built.env : null,
      release,
    };
  } catch (err) {
    log.warn(`[mcp-inject] could not set up: ${err && err.message}`);
    releaseSources();
    return null;
  }
}

module.exports = { composeMcpInjection, ownServerSource };
