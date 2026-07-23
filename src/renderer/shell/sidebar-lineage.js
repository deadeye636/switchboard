// --- Session lineage in the sidebar: a continuation reads as one (#193) ---
//
// A session that continued another's work (a Claude fork, a /clear, a Hermes/Pi child) carries
// `lineageParentId` (+ `lineageKind`: 'fork'/'parent'/'compaction' are hard, 'clear' is the soft
// mtime-freeze guess). This renders that as PROVENANCE — Model A, decided in the design: each live/leaf
// session is the face row and walks its OWN path UP the parent chain; idle ancestors fold under it rather
// than showing as separate rows. Lineage is a TREE (resuming an ancestor and clearing it again branches
// it), so nothing groups by root — each head walks up independently and a shared ancestor may appear under
// more than one head. That is honest, not a bug.
//
// A classic <script>. Reads app.js's maps at call time: sessionMap, activePtyIds, launchPending(),
// activeSessionId; utils' cleanDisplayName; a11y-utils' ariaButton. Never runs at parse time. The click
// on the "N earlier" toggle and on an ancestor row is delegated in sidebar-events.js — nothing is bound
// per node here (#218 opt6).

// The chain of resolvable ancestors, newest → oldest (the root last). Guarded against a cycle.
function lineageAncestorChain(session) {
  const chain = [];
  const seen = new Set(session ? [session.sessionId] : []);
  let cur = session;
  let guard = 0;
  while (cur && cur.lineageParentId && guard++ < 25) {
    const parent = sessionMap.get(cur.lineageParentId);
    if (!parent || seen.has(parent.sessionId)) break;
    seen.add(parent.sessionId);
    chain.push(parent);
    cur = parent;
  }
  return chain;
}

// Ids that must NOT render as their own top-level row: they are another visible session's lineage parent
// AND idle (not running, not the active tab). A LIVE ancestor (the user went back to it) stays its own row.
function foldedAncestorIds(sessions) {
  const present = new Set(sessions.map(s => s.sessionId));
  const folded = new Set();
  for (const s of sessions) {
    const pid = s.lineageParentId;
    if (!pid || !present.has(pid)) continue;
    const running = activePtyIds.has(pid) || (typeof launchPending === 'function' && launchPending(pid));
    if (!running && pid !== activeSessionId) folded.add(pid);
  }
  return folded;
}

// The collapsed thread beneath a head: a toggle plus the idle ancestors it folded, newest → oldest. Each
// ancestor row behaves exactly like its top-level twin — the delegated open in sidebar-events.js routes it
// by the session's own fields, so a plain session resumes and a subagent opens its transcript (#288).
// Returns null when there is no chain.
function buildLineageThread(session) {
  const chain = lineageAncestorChain(session);
  if (chain.length === 0) return null;
  const wrap = document.createElement('div');
  wrap.className = 'session-lineage-thread';

  // Same affordance as the subagent caret (▶ that rotates to ▼ via `.expanded`) so a folded thread reads
  // like every other collapsible nesting in the sidebar. `session-lineage-toggle` stays for the delegated
  // click selector; `sidebar-children-caret` brings the shared caret look.
  const toggle = document.createElement('div');
  toggle.className = 'session-lineage-toggle sidebar-children-caret';
  toggle.innerHTML = `<span class="caret-arrow">&#9654;</span> ${chain.length} earlier`;
  toggle.setAttribute('aria-expanded', 'false'); // flipped in sidebar-events.js, preserved in sidebar.js
  ariaButton(toggle, `Show ${chain.length} earlier session${chain.length === 1 ? '' : 's'} in this thread`);

  // Each ancestor is a REAL session, so render it as a full session row — every normal action (open,
  // transcript, timeline, tags, …) works through the delegated sidebar events, no special-casing. Pass
  // noLineageThread so the flat chain does not recurse (this head already lists the whole chain), and
  // ancestorCopy because lineage is a TREE: the same ancestor can appear under two heads, so this row is
  // one of several views of that session and must not claim the session's DOM id (#288).
  const list = document.createElement('div');
  list.className = 'session-lineage-ancestors';
  list.style.display = 'none';
  for (const anc of chain) {
    list.appendChild(buildSessionItem(anc, { noLineageThread: true, ancestorCopy: true }));
  }

  wrap.appendChild(toggle);
  wrap.appendChild(list);
  return wrap;
}
