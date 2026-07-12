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
  const handoffLibrary = !!((await window.api.getSetting('global'))?.handoffLibrary);
  const evidence = health.reasons.length
    ? health.reasons.map(reason => reason.label).join(', ')
    : 'This session is still within healthy bounds.';
  const tone = health.tier === 'strong' || health.tier === 'warning' ? 'warning' : 'default';
  const details = {
    Session: cleanDisplayName(session.name || session.aiTitle || session.summary) || session.sessionId,
    Project: session.projectPath ? session.projectPath.split('/').filter(Boolean).slice(-2).join('/') : '',
    Recommendation: health.label,
    Running: canAskRunningSession ? 'Yes' : '',
  };

  // Which buttons to show is decided by the pure helper (unit-tested matrix).
  const actions = computeHandoffActions({
    canAskRunning: canAskRunningSession,
    handoffLibrary,
    hasProject: !!project,
  });

  // Running mode: a live agent can summarize and there is a project to launch into.
  if (actions.mode === 'running') {
    const action = await showControlDialog({
      title: 'Hand Off Session',
      message: `This session is becoming expensive: ${evidence}. The guided handoff asks the running agent for a summary (spends tokens), then starts a fresh, lean session in the same project seeded with it. You'll review the packet before anything new is started. Or copy a local starter packet instead.`,
      confirmLabel: actions.confirm,
      secondaryLabel: actions.secondary || undefined,
      tertiaryLabel: actions.tertiary || undefined,
      cancelLabel: 'Close',
      tone,
      details,
    });
    if (action === true) {
      await runHandoff(session, project);
    } else if (action === 'secondary') {
      await window.api.writeClipboard(buildHandoffTemplate(session));
      showControlToast({ message: 'Handoff copied to clipboard.' });
    } else if (action === 'tertiary') {
      await newSessionFromHandoff(project, session);
    }
    return;
  }

  // Local mode (no live agent): local starter packet — copy, plus "New session" and,
  // with the Integrated Handoff System on, "Save to library".
  const action = await showControlDialog({
    title: 'Create Handoff',
    message: `This session is becoming expensive: ${evidence}. Copy a short handoff packet and start fresh when you reach a natural breakpoint.${actions.secondary ? ' Or save it to this project to resume later.' : ''}`,
    confirmLabel: actions.confirm,
    secondaryLabel: actions.secondary || undefined,
    tertiaryLabel: actions.tertiary || undefined,
    cancelLabel: 'Close',
    tone,
    details,
  });
  if (action === 'tertiary') {
    await newSessionFromHandoff(project, session);
    return;
  }
  if (action === 'secondary') {
    const label = await showHandoffSaveDialog(session);
    if (label === null) return;
    await window.api.saveHandoff({
      projectPath: project.projectPath, label, content: buildHandoffTemplate(session),
      backendId: backendOfSession(session),   // provenance, or the resume picker's default is a lie
    });
    showControlToast({ message: 'Handoff saved to project.' });
    return;
  }
  if (!action) return;
  await window.api.writeClipboard(buildHandoffTemplate(session));
  showControlToast({ message: 'Handoff copied to clipboard.' });
}

// Start a fresh session in the project seeded directly with the local handoff
// template (no agent round-trip). Used by the "New session" action in both dialogs.
// A handoff is not a Claude artifact (#148). The fresh session it seeds runs on the backend the packet
// came FROM — resolving Claude's defaults here would hand a Claude model to `pi --model`, and would put
// a Codex packet into a Claude session without anyone asking.
function backendOfSession(session) {
  return (typeof sessionBackendId === 'function' ? sessionBackendId(session) : null) || 'claude';
}

async function newSessionFromHandoff(project, session) {
  if (!project) return;
  const options = await resolveLaunchOptionsFor(project, backendOfSession(session));
  const newId = await launchNewSession(project, options, buildHandoffTemplate(session));
  if (newId) showControlToast({ message: 'New session seeded with the handoff.' });
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
async function showHandoffReviewDialog(session, handoffLibrary) {
  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'new-session-dialog';
  const hint = handoffLibrary
    ? 'This text seeds a brand-new, lean session in the same project — or save it to resume later. Review and edit it first. Starting a session spends tokens; the old session is left untouched. If the agent is still writing, use “Refresh from session”.'
    : 'This text seeds a brand-new, lean session in the same project. Review and edit it, then start the fresh session. Starting the session spends tokens; the old session is left untouched. If the agent is still writing, use “Refresh from session”.';
  const saveBtn = handoffLibrary
    ? '<button type="button" class="handoff-save-btn">Save for later</button>'
    : '';
  dialog.innerHTML = `
    <h3>Review Handoff Packet</h3>
    <div class="add-project-hint">${hint}</div>
    <textarea id="handoff-packet-text" class="settings-input" spellcheck="false" style="width:100%;min-height:260px;font-family:monospace;font-size:12px;line-height:1.5;resize:vertical;box-sizing:border-box;"></textarea>
    <div class="new-session-actions">
      <button type="button" class="new-session-cancel-btn">Cancel</button>
      <button type="button" class="handoff-refresh-btn">Refresh from session</button>
      ${saveBtn}
      <button type="button" class="new-session-start-btn">Start fresh session</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const textarea = dialog.querySelector('#handoff-packet-text');
  const captured = await readLatestHandoffPacket(session);
  textarea.value = captured || buildHandoffTemplate(session);
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
    overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });

    function onKey(e) {
      if (e.key === 'Escape') close(null);
    }
    document.addEventListener('keydown', onKey);
  });
}

// Guided one-click handoff: request packet → review → fresh lean session seeded
// with it → switch. Linear orchestration (the old handoff-flow state machine was
// removed). Every token-spending step is gated behind an explicit user confirmation;
// cancelling at any point leaves both the old and (not-yet-created) new session untouched.
// Non-modal bar shown after the request prompt is sent, so the user can answer an
// interactive skill question (e.g. /handoff asking chat-vs-file) in the live terminal
// before capturing. Resolves 'capture' or 'cancel'. Used only in Handoff-library mode.
function showHandoffCaptureBar() {
  document.querySelectorAll('.handoff-capture-bar').forEach(el => el.remove());
  const bar = document.createElement('div');
  bar.className = 'handoff-capture-bar';
  bar.innerHTML = `
    <span class="handoff-capture-text">Prompt sent — answer any skill question in the terminal, then capture.</span>
    <button type="button" class="handoff-capture-confirm">Capture handoff</button>
    <button type="button" class="handoff-capture-cancel">Cancel</button>
  `;
  document.body.appendChild(bar);
  return new Promise(resolve => {
    function onKey(e) { if (e.key === 'Escape') close('cancel'); }
    function close(result) { bar.remove(); document.removeEventListener('keydown', onKey); resolve(result); }
    bar.querySelector('.handoff-capture-confirm').onclick = () => close('capture');
    bar.querySelector('.handoff-capture-cancel').onclick = () => close('cancel');
    // Escape dismisses (as cancel) so the bar/promise can't linger forever (issue #78).
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

async function runHandoff(session, project) {
  const g = (await window.api.getSetting('global')) || {};
  const handoffLibrary = !!g.handoffLibrary;
  const template = (typeof g.handoffPrompt === 'string' && g.handoffPrompt.trim())
    ? g.handoffPrompt : DEFAULT_HANDOFF_PROMPT;

  // Token step #1 — authorized by the "Hand off (guided)" button. The prompt (or a
  // skill command like /handoff) is typed into the running session.
  const requestPrompt = fillHandoffPrompt(template, session);
  window.api.sendInput(session.sessionId, `\x1b[200~${requestPrompt}\x1b[201~\r`);

  if (handoffLibrary) {
    // Decoupled capture: the prompt may be an interactive skill — let the user answer
    // in the terminal, then capture explicitly (no modal covering the terminal).
    const cap = await showHandoffCaptureBar();
    if (cap !== 'capture') return;
  } else {
    showControlToast({ message: 'Asked the agent for a handoff packet — review it once it finishes.' });
  }

  // Token step #0 (no tokens) — review/edit the captured packet. In library mode
  // the target choice (start fresh vs save for later) is part of this dialog.
  const review = await showHandoffReviewDialog(session, handoffLibrary);
  if (review === null) return;
  const packet = review.text;

  // Library mode: "Save for later" chosen in the review dialog → store, done.
  if (handoffLibrary && review.action === 'save') {
    const label = await showHandoffSaveDialog(session);
    if (label === null) return;
    await window.api.saveHandoff({
      projectPath: project.projectPath, label, content: packet,
      backendId: backendOfSession(session),   // so a later resume can default to where it came from
    });
    showControlToast({ message: 'Handoff saved to project.' });
    return;
  }

  // Token step #2 — start a FRESH lean session (not a fork) seeded with the packet, on the same backend.
  const options = await resolveLaunchOptionsFor(project, backendOfSession(session));
  const newId = await launchNewSession(project, options, packet);
  if (!newId) return;
  showControlToast({ message: 'Handed off → fresh lean session seeded with the packet.' });
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
