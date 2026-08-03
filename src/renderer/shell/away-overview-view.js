// --- "While you were away": the one overview, and the inbox entry that opens it (#402) ---
//
// The recap used to be a banner over the terminal, in whichever window happened to render the session it
// was about. That put the answer to "what did I miss" wherever the sessions had been scattered to, made it
// per session rather than per absence, and let a stray keystroke destroy it before it was read.
//
// This is the other shape: ONE entry in the attention inbox, and ONE overview listing every session that
// changed while the user was gone. The pure half — grouping the record's cross-session read into per-session
// summaries — is `buildAwayOverview` in shell/away-summary.js, beside the per-session builder it reuses.
//
// A PLAIN CLASSIC SCRIPT, loaded AFTER app.js: everything it reaches for is another classic script's
// top-level declaration, resolved at call time through the shared global lexical scope. What it reaches
// into, by file, because the header is the only import graph this renderer has:
//
//   app.js                   appGlobalSettings, refreshSidebar, placeholder, terminalArea,
//                            returnToTerminal, sessionMap
//   shell/away-summary.js    buildAwayOverview (UMD → window property)
//   shell/attention-engine.js raisesAttention
//   views/plans-memory-view.js hideAllViewers
//   lib/utils.js             escapeHtml, cleanDisplayName
//   preload                  getTimelineSince, revealSession, onPresenceReturned,
//                            getPendingAbsence, discardAbsence
//
// IT OWNS ITS OWN STATE — the pending recap and which rows are expanded are read and written by nothing
// else. The sidebar asks for the inbox entry through `awayRecapInboxEntry()`; sidebar-events.js calls the
// three verbs (open, dismiss, and the row's two actions).
//
// ONE surface across ALL windows, and that has to be ENFORCED rather than assumed. A singleton inside one
// renderer is not unique across several — every window loads this file. Two things make it one:
//
//   * `raisesAttention()` (#390) — the same answer that decides whether a window may badge, chime or
//     notify. The recap is attention-shaped and addressed to the window that holds the inbox, so a window
//     of its own keeps no pending recap and opens no overview.
//   * the view kind names no loader, so `canLeaveWindow` in views/panes-view.js refuses to hand its tab
//     to another window. A recap dragged across would arrive blank AND leave a second surface behind.

// The absence this recap is about, and what the record said had happened during it. Null when there is
// nothing to report — which is also what the inbox reads to decide whether it has an entry to draw.
let awayRecapPending = null;
// Rows the user opened. Kept across a re-render so a second absence does not fold everything back up.
const awayOverviewExpanded = new Set();

const awayOverviewEl = () => document.getElementById('away-overview-viewer');
const awayOverviewBodyEl = () => document.getElementById('away-overview-body');

/**
 * Is the recap switched on? Default ON — only an explicit `false` turns it off, the shape every other
 * opt-out setting in this renderer uses. Read at call time, because the settings window applies live.
 */
function awayRecapEnabled() {
  return !(typeof appGlobalSettings !== 'undefined' && appGlobalSettings.awaySummary === false);
}

/** May THIS window hold the recap? Only the one that owns the inbox — see the header. */
function awayRecapIsMine() {
  return typeof raisesAttention !== 'function' || raisesAttention();
}

/** Is the overview the surface currently on screen? */
function awayOverviewOpen() {
  const el = awayOverviewEl();
  return !!(el && el.style.display !== 'none');
}

/**
 * What the attention inbox draws, or null when there is nothing to say.
 *
 * Deliberately a plain object rather than the overview itself: the inbox says how much is waiting and
 * nothing about which sessions, and giving it the full structure would invite a second renderer of it.
 */
function awayRecapInboxEntry() {
  if (!awayRecapPending || !awayRecapEnabled() || !awayRecapIsMine()) return null;
  const { overview } = awayRecapPending;
  return {
    sessionCount: overview.sessionCount,
    waitingCount: overview.waitingCount,
    sinceText: overview.sinceText,
  };
}

// --- The absence, and what it turns into -------------------------------------
//
// `presence-returned` is main's one global answer to "the user was gone, from T, for D"
// (`src/app/presence.js`). It reaches every window; only the one that owns the inbox acts on it.

window.api.onPresenceReturned?.(async (absence) => {
  if (!absence || !Number.isFinite(absence.awaySince)) return;
  if (!awayRecapEnabled() || !awayRecapIsMine()) return;
  await refreshAwayRecap(absence);
});

/**
 * Take the pending recap back after a reload (#422).
 *
 * The record has survived a reload since #396; the fact that an absence just ended did not, because it
 * arrived as one event in this renderer and nothing asked for it again. Main holds it now, so this asks —
 * and asks for the ABSENCE, not for a recap: the summary is rebuilt from the record, which is the same
 * path the live announcement takes, so the two cannot answer differently.
 *
 * Called from app.js's settings init rather than at parse time, because `awayRecapEnabled` reads the
 * settings blob and a recap restored before it loads would ignore the user having switched the feature
 * off. `awayRecapIsMine` is the same one-inbox gate the live path uses — a window of its own must not
 * claim the recap by reloading.
 */
async function restoreAwayRecap() {
  if (awayRecapPending) return;
  if (!awayRecapEnabled() || !awayRecapIsMine()) return;
  let absence = null;
  try {
    absence = await window.api.getPendingAbsence?.();
  } catch {
    // An older main process, or one that cannot answer — the recap is simply not restored.
  }
  if (!absence || !Number.isFinite(absence.awaySince)) return;
  await refreshAwayRecap(absence);
}

/**
 * Read the record for this absence and turn it into the pending recap.
 *
 * A second absence REPLACES the first rather than adding to it — including when it found nothing, which
 * is why this can clear as well as set. Leaving the previous one standing would leave the inbox asserting
 * "you were away 12m" about an absence that ended two absences ago.
 */
async function refreshAwayRecap(absence) {
  let record = { events: [], truncated: false };
  try {
    record = (await window.api.getTimelineSince?.(absence.awaySince)) || record;
  } catch {
    // A record that cannot be read is not an emergency — it is a recap that says nothing.
  }
  const overview = typeof buildAwayOverview === 'function'
    ? buildAwayOverview({
      events: record.events,
      truncated: record.truncated,
      awaySince: absence.awaySince,
      now: Date.now(),
    })
    : null;

  if (!overview || !overview.hasChanges) {
    const wasOpen = awayOverviewOpen();
    awayRecapPending = null;
    if (wasOpen) closeAwayOverview();
    refreshSidebar?.();
    return;
  }

  awayRecapPending = { absence, overview };
  // In place, wherever it currently lives — an open overview is updated, never replaced by a second one.
  if (awayOverviewOpen()) renderAwayOverview();
  refreshSidebar?.();
}

// --- Opening, closing, discarding --------------------------------------------

/**
 * Show the overview.
 *
 * Opening does NOT consume the entry. The view is a view: closing it — the header ×, Escape, switching to
 * a session — leaves the recap in the inbox to be opened again. Only `dismissAwayRecap` throws it away,
 * which is what the inbox entry's own × is for.
 */
function openAwayOverview() {
  if (!awayRecapPending) return;
  const el = awayOverviewEl();
  if (!el) return;
  if (typeof hideAllViewers === 'function') hideAllViewers();
  if (typeof placeholder !== 'undefined' && placeholder) placeholder.style.display = 'none';
  if (typeof terminalArea !== 'undefined' && terminalArea) terminalArea.style.display = 'none';
  el.style.display = 'flex';
  renderAwayOverview();
  // Panes mode hosts this element in a pane, and opening a view is not a tab change — nothing else would
  // say the set of views changed (#371).
  window.panesView?.reportViews?.();
}

/** Take the overview off screen. The recap survives — see `openAwayOverview`. */
function closeAwayOverview() {
  const el = awayOverviewEl();
  if (el) el.style.display = 'none';
  if (typeof returnToTerminal === 'function') returnToTerminal();
}

/**
 * Throw the recap away — the deliberate discard, from the inbox entry's ×.
 *
 * For when the answer to "what did I miss" is "I do not care": the entry goes, and with it the overview
 * if it happens to be open. Nothing else clears it, so it survives every stray keystroke until then.
 */
function dismissAwayRecap() {
  const wasOpen = awayOverviewOpen();
  // Main has to hear it, or the next reload asks for the absence and hands the entry straight back
  // (#422). Told which absence is being discarded, so one that ended between the click and this call
  // survives — main decides, this only reports.
  //
  // Not awaited, and it does not need to be: the message is posted before this function returns, and a
  // reload started afterwards can only ask for the absence from a page that has yet to load. Awaiting it
  // would make every caller of a click handler async for an answer nothing reads.
  const discarded = awayRecapPending && awayRecapPending.absence;
  if (discarded && Number.isFinite(discarded.awaySince)) {
    try { window.api.discardAbsence?.(discarded.awaySince); } catch { /* an older main process */ }
  }
  awayRecapPending = null;
  awayOverviewExpanded.clear();
  if (wasOpen) closeAwayOverview();
  refreshSidebar?.();
}

// --- The rows ------------------------------------------------------------------

function toggleAwayOverviewRow(sessionId) {
  if (!sessionId) return;
  if (awayOverviewExpanded.has(sessionId)) awayOverviewExpanded.delete(sessionId);
  else awayOverviewExpanded.add(sessionId);
  renderAwayOverview();
}

/**
 * Reveal the session a row is about, in the window that holds it.
 *
 * Always through main, even for a session this window renders: `reveal-session` resolves the owner per
 * session, and a row here may well be about a session in a window of its own — mounting that locally
 * would put two xterms on one PTY. One path, so the two cases cannot drift.
 */
function revealAwayOverviewSession(sessionId) {
  if (!sessionId) return;
  try { window.api.revealSession?.(sessionId); } catch { /* the window went away mid-click */ }
}

function awayOverviewSessionName(sessionId) {
  const session = typeof sessionMap !== 'undefined' ? sessionMap.get(sessionId) : null;
  if (!session) return sessionId;
  return cleanDisplayName(session.name || session.aiTitle || session.summary) || sessionId;
}

function awayOverviewBasename(path) {
  if (!path) return '';
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1] || String(path);
}

function renderAwayOverview() {
  const body = awayOverviewBodyEl();
  if (!body) return;
  if (!awayRecapPending) {
    body.innerHTML = '<div class="away-overview-empty">Nothing changed while you were away.</div>';
    return;
  }
  const { overview } = awayRecapPending;

  const since = document.getElementById('away-overview-since');
  if (since) since.textContent = overview.sinceText || '';
  const count = document.getElementById('away-overview-count');
  if (count) {
    const sessions = `${overview.sessionCount} session${overview.sessionCount === 1 ? '' : 's'} changed`;
    count.textContent = overview.waitingCount
      ? `${sessions} · ${overview.waitingCount} waiting on you`
      : sessions;
  }

  const rows = overview.sessions.map((entry) => {
    const expanded = awayOverviewExpanded.has(entry.sessionId);
    const eventsHtml = entry.events.map(event => `
      <li class="away-overview-event away-kind-${escapeHtml(event.kind)}">
        <span class="away-overview-event-time">${escapeHtml(event.time)}</span>
        <span class="away-overview-event-label">${escapeHtml(event.label)}</span>
        ${event.detail ? `<span class="away-overview-event-detail">${escapeHtml(event.detail)}</span>` : ''}
      </li>`).join('');
    const moreHtml = entry.extraEventCount
      ? `<li class="away-overview-more">+${entry.extraEventCount} earlier event${entry.extraEventCount === 1 ? '' : 's'}</li>`
      : '';
    const filesHtml = entry.files.length
      ? `<div class="away-overview-files">
          <span class="away-overview-files-label">Files touched</span>
          ${entry.files.map(file => `<span class="away-overview-file" data-kind="${escapeHtml(file.kind)}" title="${escapeHtml(file.path)}">${escapeHtml(awayOverviewBasename(file.path))}</span>`).join('')}
        </div>`
      : '';
    const headline = entry.events[0]
      ? `${entry.events[0].time} · ${entry.events[0].label}`
      : `${entry.files.length} file${entry.files.length === 1 ? '' : 's'} touched`;

    return `
      <div class="away-overview-row${expanded ? ' expanded' : ''}" data-session-id="${escapeHtml(entry.sessionId)}">
        <div class="away-overview-row-head">
          <button type="button" class="away-overview-expand" data-away-expand aria-expanded="${expanded ? 'true' : 'false'}" title="${expanded ? 'Collapse' : 'Expand'}">
            <span class="arrow">&#9654;</span>
          </button>
          <span class="away-overview-row-title">${escapeHtml(awayOverviewSessionName(entry.sessionId))}</span>
          ${entry.waitingOnYou ? '<span class="away-overview-waiting">Waiting on you</span>' : ''}
          <span class="away-overview-row-meta">${escapeHtml(headline)}</span>
          <button type="button" class="away-overview-open-btn" data-away-open title="Reveal this session">Go to session</button>
        </div>
        ${expanded ? `<div class="away-overview-row-body">
          ${eventsHtml || moreHtml ? `<ul class="away-overview-events">${eventsHtml}${moreHtml}</ul>` : ''}
          ${filesHtml}
        </div>` : ''}
      </div>`;
  }).join('');

  const truncatedHtml = overview.truncated
    ? '<div class="away-overview-truncated">The record held more than this list can show — the oldest of the absence is not here.</div>'
    : '';

  body.innerHTML = truncatedHtml + rows;
}

// --- The two facts only the UI can see --------------------------------------
//
// Both came from the banner this replaced, and both are NOTES rather than writes: main validates the kind
// against a short list and does the writing, so the record still has one writer (#396).

/**
 * The agent opened or changed a file, seen through the MCP bridge.
 *
 * The path rides in `detail` and the kind ('diff' / 'open') in `label`, which is all the overview needs to
 * rebuild the files half of a session's entry — no table of its own, and it survives a reload with the
 * rest of the record.
 *
 * That path is also WHAT the event is about, and saying so is what keeps two files touched in the same
 * beat — the ordinary case for a diff over several files — from being read as one event twice (#423).
 */
function recordFileTouched(sessionId, path, kind) {
  if (!sessionId || !path) return;
  window.api.noteTimelineEvent(sessionId, 'file-touched', kind || 'open', path, true);
}

/**
 * The user looked at a session — the focus choke point calls this before the attention state is cleared.
 *
 * Since #402 it does exactly one thing: stamp the look. The recap is no longer per session and no longer
 * decided here, so there is nothing to compute at this moment; what the mark still answers is whether the
 * user has EVER seen a session, which is a different question from what changed while they were gone.
 * It is a marker in the record, replaced rather than accumulated.
 */
function handleSessionViewed(sessionId) {
  if (!sessionId) return;
  window.api.noteTimelineEvent(sessionId, 'viewed', 'Viewed', '');
}

// Delegated, because the body is rebuilt on every expand and on every new absence — a listener attached
// to a row would be lost the first time either happened.
document.addEventListener('click', (e) => {
  const row = e.target.closest && e.target.closest('.away-overview-row');
  if (!row) return;
  const sessionId = row.dataset.sessionId;
  if (e.target.closest('[data-away-open]')) {
    e.stopPropagation();
    revealAwayOverviewSession(sessionId);
    return;
  }
  toggleAwayOverviewRow(sessionId);
});
