// --- The subagent tree under a session row (#218) ---
//
// A session that spawned subagents gets a caret and a nested list of them. This holds all of it: which
// carets are expanded (a localStorage set, with a one-shot GC for ids whose sessions are long gone), the
// accent colour per subagent type, the row DOM, and the caret's running badge.
//
// Came out of sidebar.js, where it was the cleanest thing to cut: `buildSessionsList` is its only
// inbound caller, its state is private to it, and nothing else in the app has ever read that state.
//
// `window._updateSubagentLive` is exported the way it always was — jsonl-viewer.js calls it (guarded)
// when a subagent's transcript shows it going live, and it flips the badge IN PLACE rather than asking
// for a re-render. That is the one thing in this file that runs at parse time: the assignment itself.
// jsonl-viewer.js loads BEFORE this file and reads it guarded, so that ordering already survived; do not
// make the read unguarded on the strength of the tag order alone.
//
// A classic <script>, like the file it came from: same shared global lexical scope. It reaches back into
// app.js for the runtime maps (sessionMap, activePtyIds, attentionSessions, responseReadySessions,
// sessionBusyState, appGlobalSettings) and into the UMD helpers for getSessionStatus / getSessionHealth
// — all at call time, from a click or a render, so tag order does not decide them.
//
// `subagentLiveStatusOn` is NOT a reach-back — it is defined right here. This line claimed otherwise
// until a verifier checked it.

// ===== Subagent sidebar rendering (ported from JBR #1/#2/#9, integrated into
// HaydnG's buildSessionsList) =====

// One-time GC of the expandedSubagents localStorage key to keep it from growing
// indefinitely across long-lived Switchboard instances.
let _expandedSubagentsGCDone = false;
function _gcExpandedSubagentsOnce() {
  if (_expandedSubagentsGCDone) return;
  _expandedSubagentsGCDone = true;
  try {
    const raw = new Set(JSON.parse(localStorage.getItem('expandedSubagents') || '[]'));
    const pruned = new Set([...raw].filter(id => sessionMap.has(id)));
    if (pruned.size !== raw.size) {
      localStorage.setItem('expandedSubagents', JSON.stringify([...pruned]));
    }
  } catch {}
}

function getExpandedSubagents() {
  _gcExpandedSubagentsOnce();
  return new Set(readLsJson('expandedSubagents', '[]'));
}

function saveExpandedSubagents(set) {
  try {
    localStorage.setItem('expandedSubagents', JSON.stringify([...set]));
  } catch (e) {}
}

// Subagent type → accent color (background / border)
const SUBAGENT_TYPE_COLORS = {
  explore:   { bg: 'rgba(62,207,130,0.18)',  border: '#3ecf82' },
  plan:      { bg: 'rgba(128,136,255,0.20)', border: '#8088ff' },
  implement: { bg: 'rgba(255,170,64,0.18)',  border: '#ffaa40' },
  review:    { bg: 'rgba(96,190,240,0.18)',  border: '#60bef0' },
  test:      { bg: 'rgba(255,100,100,0.18)', border: '#ff6464' },
  default:   { bg: 'rgba(160,160,180,0.15)', border: '#a0a0b4' },
};
function subagentTypeColor(type) {
  const key = (type || '').toLowerCase();
  return SUBAGENT_TYPE_COLORS[key] || SUBAGENT_TYPE_COLORS.default;
}

function buildSubagentItem(session) {
  const item = document.createElement('div');
  item.className = 'sidebar-subagent session-item js-stateful';
  item.id = 'si-' + session.sessionId;
  if (activePtyIds.has(session.sessionId)) item.classList.add('has-running-pty');
  if (attentionSessions.has(session.sessionId)) item.classList.add('needs-attention');
  if (responseReadySessions.has(session.sessionId)) item.classList.add('response-ready');
  if (sessionBusyState.get(session.sessionId)) item.classList.add('cli-busy');
  item.dataset.sessionId = session.sessionId;
  item.dataset.subagent = '1';

  // Running-subagent indicator (#111): flag the item while the agent is live,
  // gated by the subagentLiveStatus setting (default on). data-sub-live-key lets
  // the live spawn/complete events find and update this item in place.
  if (session.parentSessionId && session.agentId) {
    const liveKey = session.parentSessionId + ':' + session.agentId;
    item.dataset.subLiveKey = liveKey;
    if (subagentLiveStatusOn() && typeof window._isSubagentLive === 'function'
        && window._isSubagentLive(session.parentSessionId, session.agentId)) {
      item.classList.add('subagent-live');
    }
  }

  const { bg, border } = subagentTypeColor(session.subagentType);
  item.style.borderLeftColor = border;

  const row = document.createElement('div');
  row.className = 'session-row';

  const dot = document.createElement('span');
  const subLive = subagentLiveStatusOn() && typeof window._isSubagentLive === 'function'
    && session.parentSessionId && session.agentId
    && window._isSubagentLive(session.parentSessionId, session.agentId);
  // A live subagent's dot is green, an idle one grey — via the shared palette classes, the same way
  // regular rows do it now (#254). The bare `.running` class this used to set lost its CSS in that change.
  const subDotLive = activePtyIds.has(session.sessionId) || subLive;
  dot.className = 'session-status-dot status-dot ' + (subDotLive ? 'status-running' : 'status-idle');

  const info = document.createElement('div');
  info.className = 'session-info';

  const titleText = session.description || session.summary || session.aiTitle || session.sessionId;
  const type = session.subagentType || 'sub';
  // "Distinct" = a type worth badging on its own — anything other than the default general-purpose, which
  // is the common case and carries no information when every row shares it.
  const distinct = !!session.subagentType && session.subagentType.toLowerCase() !== 'general-purpose';
  const layout = subagentLayoutMode();

  // The same relative time the session cards show, from the same `modified` value (#179).
  const subAge = session.modified ? formatDate(new Date(session.modified)) : '';
  const statsText = [session.messageCount ? session.messageCount + ' msgs' : '', subAge].filter(Boolean).join(' · ');

  // A small coloured type badge (layouts B and C). The colour is the type's, kept in every layout.
  const makeBadge = () => {
    const b = document.createElement('span');
    b.className = 'sidebar-subagent-type sm';
    b.textContent = type;
    b.style.background = bg;
    b.style.borderColor = border;
    return b;
  };

  const summaryEl = document.createElement('div');
  summaryEl.className = 'session-summary';
  const metaEl = document.createElement('div');
  metaEl.className = 'session-meta';

  if (layout === 'b') {
    // B — three lines: title (full width), a small type badge, then the stats.
    summaryEl.textContent = titleText;
    const badgeLine = document.createElement('div');
    badgeLine.className = 'subagent-badge-line';
    badgeLine.appendChild(makeBadge());
    metaEl.textContent = statsText;
    info.appendChild(summaryEl);
    info.appendChild(badgeLine);
    info.appendChild(metaEl);
  } else if (layout === 'c') {
    // C — badge only for a non-default type, beside the title (which still ellipsises). general-purpose
    // shows no badge at all — just the coloured left stripe, the title and the stats.
    if (distinct) {
      summaryEl.classList.add('has-inline-badge');
      const titleSpan = document.createElement('span');
      titleSpan.className = 'subagent-title-text';
      titleSpan.textContent = titleText;
      summaryEl.appendChild(titleSpan);
      summaryEl.appendChild(makeBadge());
    } else {
      summaryEl.textContent = titleText;
    }
    metaEl.textContent = statsText;
    info.appendChild(summaryEl);
    info.appendChild(metaEl);
  } else {
    // A (default) — title on its own line; the type demoted (coloured) into the meta line beside the stats.
    summaryEl.textContent = titleText;
    const tySpan = document.createElement('span');
    tySpan.className = 'subagent-meta-type';
    tySpan.textContent = type;
    tySpan.style.color = border;
    metaEl.appendChild(tySpan);
    if (statsText) metaEl.appendChild(document.createTextNode(' · ' + statsText));
    info.appendChild(summaryEl);
    info.appendChild(metaEl);
  }

  row.appendChild(dot);
  row.appendChild(info);
  item.appendChild(row);

  // Click routing (subagent → read-only transcript) is handled centrally in
  // rebindSidebarEvents via session.parentSessionId, so no per-item handler here.
  return item;
}

// Whether the running-subagent indicator is enabled (default on, #111).
function subagentLiveStatusOn() {
  return typeof appGlobalSettings === 'undefined' || appGlobalSettings.subagentLiveStatus !== false;
}

// Whether subagent rows are shown at all (#231, default on). Off hides the caret + nested rows.
function showSubagentsOn() {
  return typeof appGlobalSettings === 'undefined' || appGlobalSettings.showSubagents !== false;
}

// How old an orphan subagent may be before it drops out of the sidebar (#248). 0 = never hide, so a
// stored 0 has to survive — hence the finite-number test rather than `||`. Default 14 days.
function orphanSubagentMaxAgeDays() {
  const v = typeof appGlobalSettings !== 'undefined' && appGlobalSettings
    ? appGlobalSettings.orphanSubagentMaxAgeDays : undefined;
  return Number.isFinite(v) && v >= 0 ? v : 14;
}

// The subagent row layout (#231): 'a' (default, title first + type demoted), 'b' (three lines), 'c'
// (badge only when the type differs from general-purpose). The per-type colour is kept in all three.
function subagentLayoutMode() {
  const v = typeof appGlobalSettings !== 'undefined' && appGlobalSettings.subagentLayout;
  return v === 'b' || v === 'c' ? v : 'a';
}

// Recompute a parent caret's "N running" badge from its live children (#111).
function updateSubagentCaret(parentSessionId) {
  const caret = document.getElementById('sub-caret-' + parentSessionId.replace(/[^a-zA-Z0-9_-]/g, '_'));
  if (!caret) return;
  const container = document.getElementById('subc-' + parentSessionId.replace(/[^a-zA-Z0-9_-]/g, '_'));
  const total = container ? container.querySelectorAll('.sidebar-subagent').length : 0;
  const running = (container && subagentLiveStatusOn())
    ? container.querySelectorAll('.sidebar-subagent.subagent-live').length : 0;
  const arrow = '<span class="caret-arrow">&#9654;</span>';
  const label = `${total} subagent${total !== 1 ? 's' : ''}`;
  const badge = running > 0 ? ` <span class="caret-running">${running} running</span>` : '';
  caret.innerHTML = `${arrow} ${label}${badge}`;
  caret.classList.toggle('has-running', running > 0);
}

// Live spawn/complete hook (called from jsonl-viewer.js): flip a subagent item's
// running indicator in place without a full sidebar rebuild (#111).
window._updateSubagentLive = function (parentSessionId, agentId, isLive) {
  if (!parentSessionId || !agentId) return;
  const on = subagentLiveStatusOn();
  const key = parentSessionId + ':' + agentId;
  document.querySelectorAll(`.sidebar-subagent[data-sub-live-key="${CSS.escape(key)}"]`).forEach(item => {
    item.classList.toggle('subagent-live', on && isLive);
    const dot = item.querySelector('.session-status-dot');
    if (dot && !activePtyIds.has(item.dataset.sessionId)) {
      const live = on && isLive;
      dot.classList.toggle('status-running', live);
      dot.classList.toggle('status-idle', !live);
    }
  });
  updateSubagentCaret(parentSessionId);
  // The parent's two-color overlay follows the live-subagent set (#112).
  if (typeof window._recomputeSubagentActive === 'function') window._recomputeSubagentActive(parentSessionId);
};

// Every session id a project holds, filtered or not (#247). A subagent is an orphan only when its
// parent is missing from THIS set — a parent that a filter, the age cut or the `older` limit merely
// removed from the rendered rows is still there, and its children follow it out of sight.
function buildKnownSessionIds(sessions) {
  const ids = new Set();
  for (const s of sessions) if (s.sessionId) ids.add(s.sessionId);
  return ids;
}

// Build Map<parentSessionId, subagentSession[]> from a project's session list.
function buildSubagentIndex(sessions) {
  const index = new Map();
  for (const s of sessions) {
    if (!s.parentSessionId) continue;
    if (!index.has(s.parentSessionId)) index.set(s.parentSessionId, []);
    index.get(s.parentSessionId).push(s);
  }
  return index;
}

// Attach a collapsible caret + nested subagent children beneath a parent item.
function appendSubagentChildren(parentEl, parentSessionId, subagentIndex) {
  if (!showSubagentsOn()) return;   // #231: subagents hidden entirely — no caret, no rows
  const children = subagentIndex && subagentIndex.get(parentSessionId);
  if (!children || children.length === 0) return;
  const expandedSet = getExpandedSubagents();
  const isExpanded = expandedSet.has(parentSessionId);

  const caret = document.createElement('div');
  caret.className = 'sidebar-children-caret';
  caret.id = 'sub-caret-' + parentSessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (isExpanded) caret.classList.add('expanded');
  caret.innerHTML = `<span class="caret-arrow">&#9654;</span> ${children.length} subagent${children.length !== 1 ? 's' : ''}`;

  const childrenContainer = document.createElement('div');
  childrenContainer.className = 'sidebar-subagents-container';
  childrenContainer.id = 'subc-' + parentSessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  childrenContainer.style.display = isExpanded ? '' : 'none';
  for (const child of children) childrenContainer.appendChild(buildSubagentItem(child));

  caret.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = childrenContainer.style.display !== 'none';
    childrenContainer.style.display = open ? 'none' : '';
    caret.classList.toggle('expanded', !open);
    const set = getExpandedSubagents();
    if (open) { set.delete(parentSessionId); } else { set.add(parentSessionId); }
    saveExpandedSubagents(set);
  });

  parentEl.after(caret);
  caret.after(childrenContainer);
  // Seed the "N running" badge from the children's live state (#111).
  updateSubagentCaret(parentSessionId);
}
