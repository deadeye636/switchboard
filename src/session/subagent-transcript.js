// Which file holds a subagent's transcript — the routing, without Electron (#233/#235).
//
// This lived inside `src/main.js` as a bare function, which meant it could not be loaded by
// `node --test` at all: main.js pulls in Electron on its first line. So the one thing #233 is
// about — that a subagent transcript is resolved through the ROW'S BACKEND and never through a
// direct import of Claude's reader — had no test, exactly the gap `stats-queries.js` was pulled
// out of db.js for.
//
// The dependencies arrive as arguments for the same reason: the registry and the cache read are
// injected, so a test can hand in a backend that declines subagents and assert what happens.
'use strict';

/**
 * @param {object} deps
 * @param {{list: () => Array}} deps.backends  the backend registry
 * @param {(id: string) => object|null} deps.getCachedSession
 * @param {string} parentSessionId
 * @param {string} agentId
 * @returns {{filePath: string} | {error: string}}
 */
function resolveSubagentFile({ backends, getCachedSession }, parentSessionId, agentId) {
  if (!parentSessionId || !agentId) return { error: 'Subagent session not found in cache' };

  // The ROW ID is the backend's to mint (#235): `sub:<parent>:<agent>` is Claude's shape, and building
  // it inline is what silently made it everyone's. Ask each backend that claims subagents for the id it
  // would use, and take the first that actually resolves to a row — the id space is the backend's, so a
  // miss is simply "not mine". A backend that declares supportsSubagents: false is never asked, which is
  // what keeps it from resolving to a path inside another backend's store.
  for (const b of backends.list()) {
    if (!b || b.supportsSubagents !== true || typeof b.subagentSessionId !== 'function') continue;
    let key = null;
    try { key = b.subagentSessionId(parentSessionId, agentId); } catch { continue; }
    if (!key) continue;
    let row = null;
    try { row = getCachedSession(key); } catch { continue; }
    if (!row) continue;
    const filePath = typeof b.transcriptPathFor === 'function' ? b.transcriptPathFor(row) : null;
    if (!filePath) return { error: `${b.label || b.id} cannot say where this subagent's transcript lives.` };
    return { filePath };
  }
  return { error: 'Subagent session not found in cache' };
}

module.exports = { resolveSubagentFile };
