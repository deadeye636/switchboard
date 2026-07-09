// --- Live subagent set: source-aware edges (pure logic, #121) ---
//
// Two sources feed the same set and they are not equally trustworthy:
//   'hook' — SubagentStart / SubagentStop. Exact, both edges, no lag.
//   'scan' — the JSONL spawn→complete heuristic. The fallback when hooks are off.
//
// The scan decides completion from a stable mtime, but a subagent sitting inside a
// long tool call writes nothing for minutes, so the scan can declare it finished
// while it still runs. That guess must never retract an agent the hook is tracking.
//
// Loaded as a classic <script> in the renderer (exposes globals) AND require()-d by
// node tests (module.exports). Keep this file free of DOM references.

const SUBAGENT_SOURCE_HOOK = 'hook';
const SUBAGENT_SOURCE_SCAN = 'scan';

function subagentKey(parentSessionId, agentId) {
  return parentSessionId + ':' + agentId;
}

// Apply one edge to `live` (Map<key, source>). Returns true when the agent's
// liveness actually flipped, i.e. when the UI needs repainting. Upgrading a
// scan-owned entry to hook-owned is a bookkeeping change, not a visible one.
function applySubagentEdge(live, parentSessionId, agentId, isLive, source = SUBAGENT_SOURCE_SCAN) {
  if (!live || !parentSessionId || !agentId) return false;
  const key = subagentKey(parentSessionId, agentId);
  const current = live.get(key);

  if (isLive) {
    // Hook ownership sticks: a later scan sighting must not downgrade it, or the
    // scan would regain the right to retract the agent.
    const next = current === SUBAGENT_SOURCE_HOOK ? SUBAGENT_SOURCE_HOOK : source;
    if (current === next) return false;
    live.set(key, next);
    return current === undefined;
  }

  if (current === undefined) return false;
  // The heuristic may only retract what it owns.
  if (source === SUBAGENT_SOURCE_SCAN && current === SUBAGENT_SOURCE_HOOK) return false;
  live.delete(key);
  return true;
}

function isSubagentLive(live, parentSessionId, agentId) {
  return !!live && live.has(subagentKey(parentSessionId, agentId));
}

function liveSubagentCount(live, parentSessionId) {
  if (!live || !parentSessionId) return 0;
  const prefix = parentSessionId + ':';
  let n = 0;
  for (const key of live.keys()) if (key.startsWith(prefix)) n++;
  return n;
}

function liveSubagentParents(live) {
  const parents = new Set();
  if (!live) return parents;
  for (const key of live.keys()) parents.add(key.slice(0, key.indexOf(':')));
  return parents;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SUBAGENT_SOURCE_HOOK,
    SUBAGENT_SOURCE_SCAN,
    subagentKey,
    applySubagentEdge,
    isSubagentLive,
    liveSubagentCount,
    liveSubagentParents,
  };
}
