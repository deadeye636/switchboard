// --- Session navigation, and the app's keyboard shortcut table (#218) ---
//
// Moving between sessions: linearly (Cmd+Shift+[ / ]), spatially across the grid mosaic (Cmd+Arrow,
// by bounding rect, so "right" means what it looks like), and every other re-bindable shortcut the app
// dispatches — next-attention, toggle grid, session history.
//
// It lived in grid-view.js and was never grid code. `appShortcuts` is THE shortcut table: app.js reads
// it three times and terminal-manager.js four, all of them unguarded, and it was declared 1600 lines
// into a file about drawing cards. `setAppShortcuts` is what the settings page calls when the user
// re-binds a key. Neither has anything to do with a grid; only `navigateGrid` does, and it only reads
// gridCards to find the neighbour.
//
// This is the split's real find. Nothing was broken — it just could not be found: a reader looking for
// "where are the keyboard shortcuts" had no reason to open grid-view.js, and the last four issues that
// touched shortcuts all had to.
//
// LOAD ORDER MATTERS HERE, and more than for its siblings:
//
//   `let appShortcuts = normalizeShortcuts(null)` runs at PARSE time and CALLS normalizeShortcuts from
//   shell/shortcuts.js. A `<script>` cannot call into one that has not run yet, so this file must load
//   AFTER shortcuts.js. Not "should" — the page throws on load if it does not, which is at least loud.
//
//   The quiet half: app.js and terminal-manager.js read `appShortcuts` as a bare identifier. Those are
//   reads inside functions, so they resolve when a key is pressed, not when the tag is parsed — order
//   cannot break them. But a top-level `let` is NOT on `window`: it lives in the global lexical scope,
//   so `window.appShortcuts` is undefined and always was. Do not "fix" a reader by reaching through
//   window; add the file to test/fixtures/script-order.json instead, which is the only place this
//   dependency is written down.
//
// A classic <script>, like the file it came from.

// --- Session navigation (Cmd+Shift+[/], Cmd+Arrow) ---

// Returns ordered list of open (non-closed) session IDs matching sidebar order.
function getOrderedOpenSessionIds() {
  const items = sidebarContent.querySelectorAll('.session-item[data-session-id]');
  const ids = [];
  for (const item of items) {
    const sid = item.dataset.sessionId;
    const entry = openSessions.get(sid);
    if (entry && !entry.closed) ids.push(sid);
  }
  return ids;
}

function navigateSession(direction) {
  const ids = getOrderedOpenSessionIds();
  const current = gridViewActive ? gridFocusedSessionId : activeSessionId;
  const idx = ids.indexOf(current);
  let next;
  if (idx === -1) {
    next = ids[0];
  } else {
    next = ids[(idx + direction + ids.length) % ids.length];
  }
  if (ids.length === 0 || !next) return;
  if (gridViewActive) {
    focusGridCard(next);
  } else {
    showSession(next);
  }
}

// Navigate the grid in 2D by visual position using bounding rects.
// Project headings break the simple index math, so we use actual screen positions.
function navigateGrid(direction) {
  if (!gridViewActive) return;
  // Exclude cards hidden inside a collapsed region — they have no usable
  // geometry and shouldn't be reachable by 2D navigation.
  const cards = [...terminalsEl.querySelectorAll('.grid-card')].filter(c => c.offsetParent !== null);
  if (cards.length === 0) return;
  const currentCard = gridCards.get(gridFocusedSessionId || activeSessionId);
  if (!currentCard || !cards.includes(currentCard)) {
    for (const [sid, card] of gridCards) {
      if (card === cards[0]) { focusGridCard(sid); return; }
    }
    return;
  }
  const cur = currentCard.getBoundingClientRect();
  const curCx = cur.left + cur.width / 2;
  const curCy = cur.top + cur.height / 2;
  let best = null;
  let bestDist = Infinity;
  for (const card of cards) {
    if (card === currentCard) continue;
    const r = card.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    // Filter by direction
    const dx = cx - curCx;
    const dy = cy - curCy;
    let valid = false;
    switch (direction) {
      case 'left':  valid = dx < -10; break;
      case 'right': valid = dx > 10; break;
      case 'up':    valid = dy < -10; break;
      case 'down':  valid = dy > 10; break;
    }
    if (!valid) continue;
    // For left/right prefer same row (small dy), for up/down prefer same column (small dx)
    let dist;
    if (direction === 'left' || direction === 'right') {
      dist = Math.abs(dy) * 3 + Math.abs(dx);
    } else {
      dist = Math.abs(dx) * 3 + Math.abs(dy);
    }
    if (dist < bestDist) {
      bestDist = dist;
      best = card;
    }
  }
  if (!best) return;
  for (const [sid, card] of gridCards) {
    if (card === best) { focusGridCard(sid); return; }
  }
}

// Live session-navigation key bindings (re-bindable via global settings).
// Defaults until the stored `global.shortcuts` setting is applied at startup.
let appShortcuts = normalizeShortcuts(null);
function setAppShortcuts(stored) {
  appShortcuts = normalizeShortcuts(stored);
}

// Returns true if the key combo is a session nav shortcut (used by xterm to block without acting)
function isSessionNavKey(e) {
  if (isSessionNavShortcut(e, isMac, appShortcuts)) return true;
  // Cmd/Ctrl+Shift+A — focus next attention (let it through while a terminal is focused)
  if (typeof isNextAttentionKey === 'function' && isNextAttentionKey(e, nextAttentionBindingForNav())) return true;
  // Grid move mode: the activation chord, plus every key the mode consumes while
  // it runs — otherwise bare arrows would reach the PTY.
  if (isGridMoveModeKey(e)) return true;
  return false;
}

// Resolve the active next-attention binding (override-aware) without coupling
// grid-view to app.js init order.
function nextAttentionBindingForNav() {
  return typeof getNextAttentionBinding === 'function' ? getNextAttentionBinding() : undefined;
}

function handleSessionNavKey(e) {
  // Move mode first: while it runs it owns bare arrows / Esc / Enter, and its
  // activation chord must not fall through to another action.
  if (handleGridMoveModeKey(e)) return true;

  // Cmd/Ctrl+Shift+A — focus next session needing attention
  if (typeof isNextAttentionKey === 'function' && isNextAttentionKey(e, nextAttentionBindingForNav())) {
    e.preventDefault();
    if (e.type === 'keydown' && typeof focusNextAttention === 'function') focusNextAttention();
    return true;
  }

  // Prev/next session (default Cmd/Ctrl+Shift+[ / ])
  if (matchShortcut('sessionNavBrackets', e, isMac, appShortcuts)) {
    e.preventDefault();
    if (e.type === 'keydown') navigateSession(e.code === 'BracketLeft' ? -1 : 1);
    return true;
  }

  // Back/forward through visited sessions (default Cmd/Ctrl+Shift+, / .) — #36.
  // Temporal order, unlike the bracket pair above, which walks the sidebar order.
  if (matchShortcut('sessionHistoryNav', e, isMac, appShortcuts)) {
    e.preventDefault();
    if (e.type === 'keydown' && typeof navigateSessionHistory === 'function') {
      navigateSessionHistory(e.code === 'Comma' ? -1 : 1);
    }
    return true;
  }

  // Arrow nav (default Cmd/Ctrl+Shift+Arrow) — grid view: 2D navigation; single view: cycle sessions
  if (matchShortcut('sessionNavArrows', e, isMac, appShortcuts)) {
    e.preventDefault();
    if (e.type === 'keydown') {
      if (gridViewActive) {
        const dirMap = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
        navigateGrid(dirMap[e.key]);
      } else {
        const dir = (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 1;
        navigateSession(dir);
      }
    }
    return true;
  }

  return false;
}
