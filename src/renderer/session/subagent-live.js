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
// The scan's completion guess, once it has held for long enough that no live agent explains it (#518).
// It may retract a hook-owned agent, and it is the only thing that may: a cancelled subagent emits no
// SubagentStop, so without this the entry the hook opened has no edge that can ever close it.
const SUBAGENT_SOURCE_FINAL = 'scan-final';

function subagentKey(parentSessionId, agentId) {
  return parentSessionId + ':' + agentId;
}

// Which agents the hook has ever owned, per live set. This exists because a settled retraction can be
// WRONG: the agent sat inside a long tool call, wrote nothing for over two minutes, and comes back
// through the scan's spawn path. Without a memory that would make it scan-owned — and a scan-owned
// agent is retractable by the ordinary 30 s guess, so #121's flicker would be back on a fuse four
// times shorter than the bug this deadline was written to fix. `SubagentStart` fires once per agent
// and cannot re-assert anything, so the set remembers on the hook's behalf. Only a real SubagentStop
// forgets: that agent is over, and nothing about it needs protecting any more.
const hookOwned = new WeakMap();

function rememberedAsHook(live, key) {
  const seen = hookOwned.get(live);
  return !!seen && seen.has(key);
}

// Apply one edge to `live` (Map<key, source>). Returns true when the agent's
// liveness actually flipped, i.e. when the UI needs repainting. Upgrading a
// scan-owned entry to hook-owned is a bookkeeping change, not a visible one.
function applySubagentEdge(live, parentSessionId, agentId, isLive, source = SUBAGENT_SOURCE_SCAN) {
  if (!live || !parentSessionId || !agentId) return false;
  const key = subagentKey(parentSessionId, agentId);
  const current = live.get(key);

  if (isLive) {
    if (source === SUBAGENT_SOURCE_HOOK) {
      if (!hookOwned.has(live)) hookOwned.set(live, new Set());
      hookOwned.get(live).add(key);
    }
    // Hook ownership sticks: a later scan sighting must not downgrade it, or the
    // scan would regain the right to retract the agent. It also survives a settled
    // retraction, so an agent that comes back is protected exactly as it was.
    const owned = current === SUBAGENT_SOURCE_HOOK || rememberedAsHook(live, key);
    const next = owned ? SUBAGENT_SOURCE_HOOK : source;
    if (current === next) return false;
    live.set(key, next);
    return current === undefined;
  }

  if (source === SUBAGENT_SOURCE_HOOK) {
    const seen = hookOwned.get(live);
    if (seen) seen.delete(key);
  }
  if (current === undefined) return false;
  // The heuristic may only retract what it owns — unless it is the settled one, which outranks a hook
  // edge that was never going to arrive.
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
    SUBAGENT_SOURCE_FINAL,
    subagentKey,
    applySubagentEdge,
    isSubagentLive,
    liveSubagentCount,
    liveSubagentParents,
  };
}
