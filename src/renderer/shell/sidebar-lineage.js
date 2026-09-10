// --- Session lineage in the sidebar: a continuation reads as one (#193) ---
//
// A session that continued another's work (a fork, a /clear, a Hermes child) carries `lineageParentId`
// (+ `lineageKind`: 'fork'/'parent' are hard — the backend recorded the link; 'clear'/'terminal' are soft
// — Switchboard inferred it from a re-key). This renders that as PROVENANCE — Model A, decided in the design: each live/leaf
// session is the face row and walks its OWN path UP the parent chain; idle ancestors fold under it rather
// than showing as separate rows. Lineage is a TREE (resuming an ancestor and clearing it again branches
// it), so nothing groups by root — each head walks up independently and a shared ancestor may appear under
// more than one head. That is honest, not a bug.
//
// A classic <script>. Reads app.js's maps at call time: sessionMap, activePtyIds, launchPending(),
// activeSessionId; utils' cleanDisplayName and readLsJson (the expanded-thread set below);
// a11y-utils' ariaButton. Never runs at parse time. The click
// on the "N earlier" toggle and on an ancestor row is delegated in sidebar-events.js — nothing is bound
// per node here (#218 opt6).

// --- Which threads are open, across renders and re-keys (#229) ---
//
// The expanded state used to live only on the DOM, which meant it died with the node. Morphdom carried it
// through an ordinary re-render (preserveSidebarState in sidebar-state.js), but a node whose id CHANGES is
// a new node with nothing to carry from — and that is precisely what a `/clear` does (#223 mints a new
// session id, so the head row's `si-<id>` is new). The thread folded shut on the very event that had just
// extended it. A search does the same, because that path renders ancestors top-level instead of folded.
//
// So it is persisted, like the subagent caret's set — but keyed on the ROOT of the chain, not on the head.
// The head is a moving pointer by construction; the root is the fixed end of the relationship and survives
// every re-key. The subagent caret gets away with a parent-id key because nothing ever rewrites which
// parent a subagent points at.
//
// The consequence, which is deliberate: lineage is a tree, so two heads can share a root, and a root-keyed
// set opens the thread under both of them. That matches Model A's stance on a shared ancestor above.
let _expandedLineageGCDone = false;
function _gcExpandedLineageOnce() {
  if (_expandedLineageGCDone) return;
  _expandedLineageGCDone = true;
  try {
    const raw = new Set(JSON.parse(localStorage.getItem('expandedLineage') || '[]'));
    const pruned = new Set([...raw].filter(id => sessionMap.has(id)));
    if (pruned.size !== raw.size) {
      localStorage.setItem('expandedLineage', JSON.stringify([...pruned]));
    }
  } catch {}
}

function getExpandedLineage() {
  _gcExpandedLineageOnce();
  return new Set(readLsJson('expandedLineage', '[]'));
}

function setLineageExpanded(rootId, expanded) {
  if (!rootId) return;
  try {
    const set = getExpandedLineage();
    if (expanded) set.add(rootId); else set.delete(rootId);
    localStorage.setItem('expandedLineage', JSON.stringify([...set]));
  } catch {}
}

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

// May this ancestor fold under a descendant at all? Idle, not starting, not the session on screen — a
// LIVE ancestor (the user went back to it) keeps its own row. ONE definition, because three places ask:
// which rows the sidebar drops (below), which ancestors the thread lists (`lineageThreadChain`), and what
// the archive scope covers (sidebar-events.js). They were two copies for the length of #502, and a rule
// written twice is a rule that will be changed once.
// ARCHIVED counts as "does not fold", and the reason is that this file does NOT see the sidebar's
// filter. `foldedAncestorIds` runs on the filtered rows, but `lineageThreadChain` walks `sessionMap`,
// which holds the archived sessions unconditionally (app.js fetches both lists on every load). Leave
// archived out of the rule and a thread lists an archived ancestor as a full row while "Show archived"
// is OFF — hidden from the sidebar, and back in it one nesting level down. The visible cost is the other
// direction: with the toggle ON, an archived ancestor keeps its own row instead of folding. Nothing
// disappears that way, which is the failure worth avoiding.
function foldsUnderDescendant(session) {
  if (!session || session.archived) return false;
  const id = session.sessionId;
  if (activePtyIds.has(id)) return false;
  if (typeof launchPending === 'function' && launchPending(id)) return false;
  return id !== activeSessionId;
}

// Ids that must NOT render as their own top-level row: they are another visible session's lineage parent
// AND idle (not running, not the active tab). A LIVE ancestor (the user went back to it) stays its own row.
function foldedAncestorIds(sessions) {
  const present = new Set(sessions.map(s => s.sessionId));
  const folded = new Set();
  for (const s of sessions) {
    const pid = s.lineageParentId;
    if (!pid || !present.has(pid)) continue;
    if (foldsUnderDescendant(sessionMap.get(pid))) folded.add(pid);
  }
  return folded;
}

// The ancestors that belong to THIS head's thread: the chain, cut where the sidebar stops folding (#502).
// Everything above the cut is reachable from the ancestor that stayed a row of its own — it carries its
// own thread — so nothing is hidden, and the head stops claiming provenance that is not folded under it.
// Before this, the toggle said "2 earlier" for a chain whose running middle stood beside it as its own
// row, and the archive scope and the toggle counted the same thread differently.
function lineageThreadChain(session) {
  const chain = lineageAncestorChain(session);
  const cut = chain.findIndex(s => !foldsUnderDescendant(s));
  return cut === -1 ? chain : chain.slice(0, cut);
}

// How a link was established, in words, and whether it is a guess (#229). Hard kinds are the ones a
// backend recorded itself; soft kinds are the ones Switchboard inferred from a re-key it witnessed.
// An unknown kind (an older row, or one a future backend writes) is treated as hard rather than
// labelled a guess — claiming doubt we cannot support is the same error as claiming certainty.
const LINEAGE_LINK_NOTES = {
  fork: { soft: false, note: 'Forked from here — the CLI recorded the link' },
  parent: { soft: false, note: 'Continued from here — the CLI recorded the link' },
  clear: { soft: true, note: 'Continued after /clear — inferred from the CLI’s claim, not a recorded link' },
  terminal: { soft: true, note: 'This terminal ran that session before this one — inferred, not a recorded link' },
};
function lineageLinkNote(kind) {
  return LINEAGE_LINK_NOTES[kind] || null;
}

// The collapsed thread beneath a head: a toggle plus the idle ancestors it folded, newest → oldest. Each
// ancestor row behaves exactly like its top-level twin — the delegated open in sidebar-events.js routes it
// by the session's own fields, so a plain session resumes and a subagent opens its transcript (#288).
// Returns null when there is no chain.
function buildLineageThread(session) {
  const chain = lineageThreadChain(session);
  if (chain.length === 0) return null;
  const wrap = document.createElement('div');
  wrap.className = 'session-lineage-thread';

  // Same affordance as the subagent caret (▶ that rotates to ▼ via `.expanded`) so a folded thread reads
  // like every other collapsible nesting in the sidebar. `session-lineage-toggle` stays for the delegated
  // click selector; `sidebar-children-caret` brings the shared caret look.
  // The key is the TRUE root of the lineage, not the last row this head happens to fold. #229 keyed the
  // open/closed state on the root precisely because it is the one end of the relationship that never
  // moves; keying it on the cut chain would make it move whenever an ancestor starts or stops running —
  // a thread the user opened would fold itself shut, and the ancestor that broke the chain would open its
  // own thread unasked. Two heads sharing a root open together, which is Model A's stated bargain.
  const fullChain = lineageAncestorChain(session);
  const rootId = fullChain[fullChain.length - 1].sessionId;
  const expanded = getExpandedLineage().has(rootId);

  const toggle = document.createElement('div');
  toggle.className = 'session-lineage-toggle sidebar-children-caret' + (expanded ? ' expanded' : '');
  toggle.dataset.lineageRoot = rootId; // read by the delegated click in sidebar-events.js
  toggle.innerHTML = `<span class="caret-arrow">&#9654;</span> ${chain.length} earlier`;
  toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false'); // flipped in sidebar-events.js
  ariaButton(toggle, `Show ${chain.length} earlier session${chain.length === 1 ? '' : 's'} in this thread`);

  // Each ancestor is a REAL session, so render it as a full session row — every normal action (open,
  // transcript, timeline, tags, …) works through the delegated sidebar events, no special-casing. Pass
  // noLineageThread so the flat chain does not recurse (this head already lists the whole chain), and
  // ancestorCopy because lineage is a TREE: the same ancestor can appear under two heads, so this row is
  // one of several views of that session and must not claim the session's DOM id (#288).
  const list = document.createElement('div');
  list.className = 'session-lineage-ancestors';
  list.style.display = expanded ? '' : 'none';
  // The kind belongs to the DESCENDANT — `lineageKind` says how THAT row's link to its parent was
  // established — so an ancestor is marked by the row below it in the chain, and the first ancestor by
  // the head itself (#229). A soft link (Switchboard inferred the continuation) dims the row; a hard one
  // (the backend recorded it) renders normally, so nothing has to be added for the common case.
  chain.forEach((anc, i) => {
    const item = buildSessionItem(anc, { noLineageThread: true, ancestorCopy: true });
    const link = lineageLinkNote((i === 0 ? session : chain[i - 1]).lineageKind);
    if (link) {
      if (link.soft) item.classList.add('lineage-soft');
      item.title = link.note;
    }
    list.appendChild(item);
  });

  wrap.appendChild(toggle);
  wrap.appendChild(list);
  return wrap;
}
