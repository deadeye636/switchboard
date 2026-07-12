// --- Handoff orchestration ---
// Moved out of dialogs.js for cohesion. Drives the (one-click / Integrated Handoff
// System) flow: request packet, review, save-to-library, resume, and direct "New session".
// Depends on globals from other classic scripts (shared top-level scope):
//   getSessionHealth, buildHandoffTemplate, buildHandoffRequestPrompt,
//   DEFAULT_HANDOFF_PROMPT, fillHandoffPrompt (session-health.js);
//   extractLatestAssistantText (handoff-extract.js); computeHandoffActions (handoff-actions.js);
//   showControlDialog, showControlToast (control-dialogs.js);
//   activePtyIds, findProjectForSession, resolveDefaultSessionOptions, launchNewSession,
//   cleanDisplayName (dialogs.js / app.js / utils.js); window.api.

async function showHandoffPrompt(session) {
  const health = getSessionHealth(session);
  const canAskRunningSession = activePtyIds.has(session.sessionId) && session.type !== 'terminal';
  const project = findProjectForSession(session);

  // Can a FRESH agent read this session? Backends declare how their transcript is reachable
  // (`transcriptAccess`), so a store-backed one (Hermes today) exports it rather than being excluded.
  let transcript = null;
  try { transcript = await window.api.backends.transcriptPath(session.sessionId); } catch { transcript = null; }
  const canReadTranscript = !!(transcript && transcript.ok);

  const actions = computeHandoffActions({
    canAskRunning: canAskRunningSession,
    hasProject: !!project,
    canReadTranscript,
  });

  // The button is on EVERY session now, so the copy must not assume trouble: handing over at a clean
  // breakpoint is a normal thing to do, not an emergency.
  const recommended = health.state !== 'healthy';
  const evidence = health.reasons.map(reason => reason.label).join(', ');
  const why = recommended
    ? `This session is becoming expensive: ${evidence}.`
    : 'Handing over at a clean breakpoint keeps the next session lean.';

  const choice = await showControlDialog({
    title: 'Who writes the handoff?',
    message: `${why}

A handoff is a packet that summarises the actual state of the work, written by an `
      + `agent. Choose who writes it — you review it before anything is started or saved.`,
    confirmLabel: actions.producers[0] ? actions.producers[0].label : 'Cancel',
    secondaryLabel: actions.producers[1] ? actions.producers[1].label : undefined,
    tertiaryLabel: actions.starter ? 'Copy starter prompt' : undefined,
    cancelLabel: 'Close',
    tone: health.tier === 'strong' || health.tier === 'warning' ? 'warning' : 'default',
    details: {
      Session: cleanDisplayName(session.name || session.aiTitle || session.summary) || session.sessionId,
      Project: session.projectPath ? session.projectPath.split('/').filter(Boolean).slice(-2).join('/') : '',
      Recommendation: health.label,
      [actions.producers[0] ? actions.producers[0].label : '']: actions.producers[0] ? actions.producers[0].detail : '',
      [actions.producers[1] ? actions.producers[1].label : '']: actions.producers[1] ? actions.producers[1].detail : '',
    },
  });

  const producer = choice === true ? actions.producers[0]
    : choice === 'secondary' ? actions.producers[1]
      : null;

  if (choice === 'tertiary') {
    // The local skeleton. NOT a handoff — it contains no summary, only instructions to a next session to
    // work the state out for itself. It is offered for pasting somewhere, and it never enters the library.
    await window.api.writeClipboard(buildHandoffTemplate(session));
    showControlToast({ message: 'Starter prompt copied. It contains no summary — it tells a fresh session what to work out for itself.' });
    return;
  }
  if (!producer) return;

  const packet = producer.id === 'new'
    ? await handoffFromNewSession(session, project, transcript.path)
    : await handoffFromThisSession(session, project, { needsResume: producer.needsResume });

  if (!packet) return;
  await reviewAndPlacePacket(session, project, packet);
}

// Route 1 — THIS session's agent summarises what it is holding. Resumed for one turn if it is not running.
async function handoffFromThisSession(session, project, { needsResume }) {
  if (!needsResume) return askRunningAgentForHandoff(session);
  return runHandoffOnStoppedSession(session, project);
}

// Route 2 — a FRESH agent reads the old session's transcript and writes the packet itself.
//
// Nothing is resumed; the old session costs nothing. The new agent is launched on the same backend as
// the old session (a Codex packet is written by Codex), seeded with the read-prompt, and we then wait for
// its answer exactly as we do for the other route.
async function handoffFromNewSession(session, project, transcriptPath) {
  const g = (await window.api.getSetting('global')) || {};
  const backendId = backendOfSession(session);
  const backend = (typeof getBackend === 'function' ? getBackend(backendId) : null) || { id: backendId };

  const prompt = fillHandoffPrompt(
    resolveHandoffPrompt(backend, g, 'read'),
    { ...session, transcriptPath },
  );

  const options = await resolveLaunchOptionsFor(project, backendId);
  const newId = await launchNewSession(project, options, prompt);
  if (!newId) return null;

  showControlToast({ message: 'A fresh agent is reading the previous session — the packet will be offered for review.' });

  // Wait for THAT session to answer. It is brand new, so anything it says is the packet.
  const reader = { sessionId: newId, projectPath: session.projectPath, backendId };
  const packet = await waitForAgentAnswer(reader, { before: '' });
  if (!packet) {
    showControlMessage({
      title: 'The new session did not produce a handoff',
      message: 'It was asked to read the previous session and summarise it, but it has not answered. Its tab is open — you can look at what it is doing.',
      tone: 'warning',
    });
    return null;
  }
  return packet;
}

// Review the packet, then place it: start a fresh session with it, or store it in the library.
async function reviewAndPlacePacket(session, project, packet) {
  const review = await showHandoffReviewDialog(session, true, packet);
  if (review === null) return;

  if (review.action === 'save') {
    const label = await showHandoffSaveDialog(session);
    if (label === null) return;
    await window.api.saveHandoff({
      projectPath: project.projectPath,
      label,
      content: review.text,
      backendId: backendOfSession(session),   // provenance: the resume picker defaults to it
    });
    showControlToast({ message: 'Handoff saved to this project.' });
    return;
  }

  const options = await resolveLaunchOptionsFor(project, backendOfSession(session));
  const newId = await launchNewSession(project, options, review.text);
  if (newId) showControlToast({ message: 'Fresh session seeded with the handoff packet.' });
}

// Start a fresh session in the project seeded directly with the local handoff
// template (no agent round-trip). Used by the "New session" action in both dialogs.
// A handoff is not a Claude artifact (#148). The fresh session it seeds runs on the backend the packet
// came FROM — resolving Claude's defaults here would hand a Claude model to `pi --model`, and would put
// a Codex packet into a Claude session without anyone asking.
function backendOfSession(session) {
  return (typeof sessionBackendId === 'function' ? sessionBackendId(session) : null) || 'claude';
}

async function readLatestHandoffPacket(session) {
  try {
    const result = await window.api.readSessionJsonl(session.sessionId);
    if (result && Array.isArray(result.entries)) {
      const text = extractLatestAssistantText(result.entries);
      if (text) return text;
    }
  } catch {}
  return '';
}

// Follow-up dialog that lets the human review/edit the captured handoff packet
// before a fresh session is started. Resolves with { action: 'start' | 'save',
// text } (the edited packet), or null on cancel. Prefilled by reading the latest
// assistant turn from the session JSONL (no brittle terminal scraping); falls back
// to the local starter template. With the Integrated Handoff System on, the target
// choice (start fresh vs save for later) lives here — no separate follow-up dialog.
// `packet` = what the chosen agent wrote. Always offered for review, always editable, and always with
// both destinations (start a session with it, or store it) — the library is just where a packet is kept,
// not a separate "system" the user has to switch on.
async function showHandoffReviewDialog(session, _unused, packet) {
  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'new-session-dialog';
  const hint = 'Review and edit the packet. “Start fresh session” launches a new, lean session in this '
    + 'project seeded with it (spends tokens; the old session is untouched). “Save for later” stores it '
    + 'in this project’s handoff library. If the agent is still writing, use “Refresh from session”.';
  // `new-session-secondary-btn` carries the LOOK; the handoff-* class stays as the hook the code uses.
  // A button with only a behaviour class inherits nothing in this renderer and lands as a raw white
  // native control — which is exactly what these two were doing, right next to two styled ones.
  const saveBtn = '<button type="button" class="new-session-secondary-btn handoff-save-btn">Save for later</button>';
  dialog.innerHTML = `
    <h3>Review Handoff Packet</h3>
    <div class="add-project-hint">${hint}</div>
    <textarea id="handoff-packet-text" class="settings-input handoff-packet-text" spellcheck="false"></textarea>
    <div class="new-session-actions handoff-actions">
      <button type="button" class="new-session-cancel-btn">Cancel</button>
      <div class="handoff-actions-main">
        <button type="button" class="new-session-secondary-btn handoff-refresh-btn">Refresh from session</button>
        ${saveBtn}
        <button type="button" class="new-session-start-btn">Start fresh session</button>
      </div>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const textarea = dialog.querySelector('#handoff-packet-text');
  // The packet the producer wrote. (Falling back to the transcript's last turn keeps "Refresh from
  // session" meaningful, and the starter is the last resort — but it is never what the library gets.)
  textarea.value = packet || (await readLatestHandoffPacket(session)) || buildHandoffTemplate(session);
  textarea.focus();

  return new Promise(resolve => {
    function close(result) {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }

    dialog.querySelector('.new-session-cancel-btn').onclick = () => close(null);
    dialog.querySelector('.handoff-refresh-btn').onclick = async () => {
      const latest = await readLatestHandoffPacket(session);
      if (latest) textarea.value = latest;
    };
    const saveEl = dialog.querySelector('.handoff-save-btn');
    if (saveEl) saveEl.onclick = () => {
      const value = textarea.value.trim();
      if (value) close({ action: 'save', text: value });
    };
    dialog.querySelector('.new-session-start-btn').onclick = () => {
      const value = textarea.value.trim();
      if (value) close({ action: 'start', text: value });
    };
    // A click BESIDE this dialog does nothing.
    //
    // It used to close it, like every other overlay in the app — and every other overlay is a question,
    // where closing costs nothing. This one holds the packet an agent just spent minutes and tokens
    // writing, and it cannot be got back: the session may already have been stopped again, and the
    // producer will not write the same summary twice. A stray click is not an instruction to throw that
    // away. The Cancel button is right there for people who mean it.
    //
    // Escape is the same reflex, so it asks first rather than acting.
    async function discard() {
      const value = textarea.value.trim();
      if (!value) { close(null); return; }
      const go = typeof showControlDialog === 'function'
        ? await showControlDialog({
            title: 'Discard this handoff?',
            message: 'The packet the agent wrote is thrown away. It cannot be recovered — the agent would '
              + 'have to be asked again, which costs another turn.',
            confirmLabel: 'Discard it',
            cancelLabel: 'Keep it open',
            tone: 'danger',
          })
        : true;
      if (go) close(null);
    }

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); discard(); }
    }
    document.addEventListener('keydown', onKey);
  });
}

// Small dialog to name a handoff before saving it to the project library.
// Resolves the (trimmed) label, or null on cancel.
function showHandoffSaveDialog(session) {
  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'new-session-dialog';
  const title = cleanDisplayName(session.name || session.aiTitle || session.summary) || 'Handoff';
  const now = new Date();
  const stamp = `${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth() + 1).padStart(2, '0')}. ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const suggested = `${title} · ${stamp}`;
  dialog.innerHTML = `
    <h3>Save Handoff</h3>
    <div class="add-project-hint">Stored with this project. Resume it later from the new-session menu → "Resume from handoff", on any backend you like.</div>
    <input type="text" id="handoff-save-label" class="settings-input" style="width:100%;box-sizing:border-box;">
    <div class="new-session-actions">
      <button type="button" class="new-session-cancel-btn">Cancel</button>
      <button type="button" class="new-session-start-btn">Save handoff</button>
    </div>
  `;
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  const input = dialog.querySelector('#handoff-save-label');
  input.value = suggested;
  input.focus();
  input.select();
  return new Promise(resolve => {
    function close(result) { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(result); }
    dialog.querySelector('.new-session-cancel-btn').onclick = () => close(null);
    dialog.querySelector('.new-session-start-btn').onclick = () => close(input.value.trim() || suggested);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });
    function onKey(e) {
      if (e.key === 'Escape') close(null);
      else if (e.key === 'Enter') close(input.value.trim() || suggested);
    }
    document.addEventListener('keydown', onKey);
  });
}

// Ask a STOPPED session for a handoff packet.
//
// A stopped session has no agent to ask, which is why the old code quietly fell back to the local
// starter — a metadata skeleton that tells the next session to work the state out for itself. Saved to
// the library it looked like a handoff and contained none, and the user only found out one session
// later, when the context was not there.
//
// The honest way is the expensive one: resume the session for a single turn, ask, take the answer, and
// put it back the way we found it. That spends tokens and starts an agent, so it is confirmed first —
// in those words.
async function runHandoffOnStoppedSession(session, project) {
  const backend = (typeof getBackend === 'function' ? getBackend(backendOfSession(session)) : null);
  const agent = (backend && backend.label) || 'the agent';

  const go = await showControlDialog({
    title: 'Resume the agent to write a handoff?',
    message: `This session is not running. To get a real handoff packet — a summary of the actual state, `
      + `not a to-do list for your next session — ${agent} has to be asked, so it will be resumed for one `
      + `turn and closed again afterwards.

That starts the agent and spends tokens.`,
    confirmLabel: `Resume ${agent} and ask`,
    cancelLabel: 'Cancel',
    tone: 'warning',
  });
  if (!go) return null;

  // Resume it. It stays open while we wait — the user can watch the agent work.
  const wasOpen = typeof openSessions !== 'undefined' && openSessions.has(session.sessionId);
  try {
    await openSession(session);
  } catch {
    showControlMessage({ title: 'Could not resume the session', message: 'The agent did not start.', tone: 'danger' });
    return null;
  }

  const packet = await askRunningAgentForHandoff(session, { waitForBoot: true });

  // Put it back: a session we resumed only to ask a question does not stay running.
  if (!wasOpen) {
    try { await window.api.stopSession(session.sessionId); } catch { /* best effort */ }
    if (typeof activePtyIds !== 'undefined') activePtyIds.delete(session.sessionId);
    if (typeof refreshSidebar === 'function') refreshSidebar();
  }
  return packet;
}

// Send the configured prompt to a RUNNING session and wait for the agent to answer. Returns the packet
// text, or null when it never answered (the caller decides what to do about that).
//
// "Answered" = its last assistant turn changed. Anything else — a prompt it did not understand, a
// session that is not listening — would otherwise hand the user its PREVIOUS message as the packet,
// which is the silent wrongness this whole feature must not produce.
async function askRunningAgentForHandoff(session, { waitForBoot = false } = {}) {
  const g = (await window.api.getSetting('global')) || {};
  const backendId = backendOfSession(session);
  const backend = (typeof getBackend === 'function' ? getBackend(backendId) : null) || { id: backendId };

  // What it had already said. If that is still its last word afterwards, it produced nothing — and
  // offering THAT as the packet is the silent wrongness this feature must never commit. Read it BEFORE
  // the prompt goes in.
  const before = await readLatestHandoffPacket(session);
  const requestPrompt = fillHandoffPrompt(resolveHandoffPrompt(backend, g, 'summarise'), session);

  // Hand it to the SAME seeding primitive the other route uses (app.js `seedSessionWhenReady`).
  //
  // This one used to do its own thing: sleep a fixed grace, paste, and end with a LINE FEED. Enter is a
  // CARRIAGE RETURN on a terminal — a line feed only moves the cursor down. So the prompt was pasted into
  // the input and never submitted, while the code below sat polling for an answer that could only arrive
  // once the user pressed Enter themselves. The app said "Asked the agent" and had asked nobody.
  //
  // The shared primitive also waits for the CLI to fall QUIET instead of for a fixed delay, so we never
  // type into an agent that is still printing.
  seedSessionWhenReady(session.sessionId, requestPrompt, {
    graceMs: waitForBoot ? ((backend && backend.seedGraceMs) || 1500) : 0,
    timelineLabel: 'Handoff requested',
    timelineNote: 'Asked the agent to summarise the session into a handoff packet.',
  });
  showControlToast({ message: 'Asked the agent for a handoff — the packet is offered for review when it answers.' });

  const packet = await waitForAgentAnswer(session, { before });
  if (!packet) {
    const go = await showControlDialog({
      title: 'The agent has not answered',
      message: 'Its last message is unchanged since the handoff was requested — the prompt may not have '
        + 'reached it, or it did not understand it. Its previous message is NOT a handoff. Use it anyway?',
      confirmLabel: 'Review its last message',
      cancelLabel: 'Cancel',
      tone: 'warning',
    });
    if (!go) return null;
    return before || buildHandoffTemplate(session);
  }
  return packet;
}

// Poll the transcript until the agent's last assistant turn CHANGES. That is the only honest signal that
// it answered: the terminal going quiet says nothing (a spinner is output, so is an echoed keystroke).
async function waitForAgentAnswer(session, { before = '', deadlineMs = 5 * 60 * 1000, pollMs = 1500 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < deadlineMs) {
    await new Promise(resolve => setTimeout(resolve, pollMs));
    const now = await readLatestHandoffPacket(session);
    if (now && now !== before) return now;
  }
  return null;
}

// Picker for the Handoff library: list a project's saved handoffs (with delete),
// and seed a fresh session from the chosen one.
async function showHandoffResumePicker(project, groupId) {
  let handoffs = [];
  try { handoffs = (await window.api.listHandoffs(project.projectPath)) || []; } catch {}

  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'new-session-dialog';
  overlay.appendChild(dialog);

  function pad(n) { return String(n).padStart(2, '0'); }
  function fmt(iso) {
    try { const d = new Date(iso); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
    catch { return ''; }
  }
  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }

  function render() {
    dialog.innerHTML = `
      <h3>Resume from Handoff</h3>
      <div class="add-project-hint">Starts a fresh session seeded with the saved packet. Pick which backend runs it — a handoff is context, not a continuation, so it is not tied to the CLI that wrote it.</div>
      <div class="handoff-list"></div>
      <div class="new-session-actions"><button type="button" class="new-session-cancel-btn">Cancel</button></div>
    `;
    const listEl = dialog.querySelector('.handoff-list');
    if (!handoffs.length) {
      listEl.innerHTML = '<div class="add-project-hint">No saved handoffs for this project.</div>';
    } else {
      // Resuming a handoff starts a NEW session seeded with context — it is not a continuation of the
      // old one. So, unlike resuming an existing session (which is bound to its binary, §5.11), the
      // user may run it on ANY backend, and is asked which (#148). The default is the one the packet
      // came from; a handoff saved before backends existed has none, so it defaults to Claude.
      const launchable = (typeof launchableBackends === 'function') ? launchableBackends() : [];

      handoffs.forEach(h => {
        const row = document.createElement('div');
        row.className = 'handoff-row';
        row.innerHTML = '<button type="button" class="handoff-pick"><span class="handoff-row-label"></span><span class="handoff-row-date"></span></button><select class="handoff-backend settings-select" title="Which backend runs this handoff"></select><button type="button" class="handoff-del" title="Delete handoff">✕</button>';
        row.querySelector('.handoff-row-label').textContent = h.label || 'Handoff';
        row.querySelector('.handoff-row-date').textContent = fmt(h.createdAt);

        // The rules (default, unavailable source, single-backend user) live in resolveHandoffTarget so
        // they are testable — a DOM callback is where behaviour goes to hide.
        const select = row.querySelector('.handoff-backend');
        const source = h.backendId || null;   // NULL = saved before handoffs recorded their origin
        const target = resolveHandoffTarget(source, launchable, window._defaultBackendId || 'claude');

        for (const b of target.options) {
          const opt = document.createElement('option');
          opt.value = b.id;
          opt.textContent = b.label + (b.id === source ? ' (source)' : '');
          if (b.id === target.selected) opt.selected = true;
          select.appendChild(opt);
        }

        if (target.warning) {
          const label = (typeof getBackend === 'function' && getBackend(target.warning) && getBackend(target.warning).label)
            || target.warning;
          const warn = document.createElement('div');
          warn.className = 'handoff-row-warn';
          warn.textContent = `Written by ${label}, which is not available — it will run on the backend you pick.`;
          row.appendChild(warn);
          row.classList.add('handoff-row-stacked');
        }

        if (!target.showPicker) select.remove();   // a single-backend user sees no new control

        row.querySelector('.handoff-pick').onclick = async () => {
          const backendId = select.value || 'claude';
          close();
          const opts = await resolveLaunchOptionsFor(project, backendId);
          await launchNewSession(project, opts, h.content, groupId);
        };
        row.querySelector('.handoff-del').onclick = async () => {
          // Confirm first, and keep the entry if the delete actually fails —
          // previously the failure was swallowed and the row removed anyway (issue #78).
          const ok = await showControlDialog({
            title: 'Delete handoff?',
            message: `"${h.label || h.id}" will be permanently removed.`,
            confirmLabel: 'Delete',
            tone: 'danger',
          });
          if (!ok) return;
          try {
            const res = await window.api.deleteHandoff(h.id);
            if (res && res.ok === false) {
              showControlMessage({ title: 'Delete failed', message: res.error || 'unknown error', tone: 'danger' });
              return;
            }
          } catch (err) {
            showControlMessage({ title: 'Delete failed', message: err.message, tone: 'danger' });
            return;
          }
          handoffs = handoffs.filter(x => x.id !== h.id);
          render();
        };
        listEl.appendChild(row);
      });
    }
    dialog.querySelector('.new-session-cancel-btn').onclick = () => close();
  }

  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  render();
}
