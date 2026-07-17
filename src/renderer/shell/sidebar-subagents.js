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
// sidebar.js for shortSessionLabel/subagentLiveStatusOn's siblings and into app.js for the runtime maps
// — all at call time, from a click or a render, so tag order does not decide them.

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

  const typePill = document.createElement('span');
  typePill.className = 'sidebar-subagent-type';
  typePill.textContent = session.subagentType || 'sub';
  typePill.style.background = bg;
  typePill.style.borderColor = border;

  const dot = document.createElement('span');
  const subLive = subagentLiveStatusOn() && typeof window._isSubagentLive === 'function'
    && session.parentSessionId && session.agentId
    && window._isSubagentLive(session.parentSessionId, session.agentId);
  dot.className = 'session-status-dot' + (activePtyIds.has(session.sessionId) || subLive ? ' running' : '');

  const info = document.createElement('div');
  info.className = 'session-info';

  const summaryEl = document.createElement('div');
  summaryEl.className = 'session-summary';
  summaryEl.textContent = session.description || session.summary || session.aiTitle || session.sessionId;

  const metaEl = document.createElement('div');
  metaEl.className = 'session-meta';
  // Count, then the same relative time the session cards show, from the same
  // value (`modified`) — two cards under each other must not print the same
  // number with different meanings (#179).
  const subAge = session.modified ? formatDate(new Date(session.modified)) : '';
  metaEl.textContent = [session.messageCount ? session.messageCount + ' msgs' : '', subAge]
    .filter(Boolean).join(' · ');

  info.appendChild(summaryEl);
  info.appendChild(metaEl);

  row.appendChild(typePill);
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
    if (dot && !activePtyIds.has(item.dataset.sessionId)) dot.classList.toggle('running', on && isLive);
  });
  updateSubagentCaret(parentSessionId);
  // The parent's two-color overlay follows the live-subagent set (#112).
  if (typeof window._recomputeSubagentActive === 'function') window._recomputeSubagentActive(parentSessionId);
};

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
