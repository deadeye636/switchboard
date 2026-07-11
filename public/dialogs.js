// --- Dialogs & session launch helpers ---
// Depends on globals: launchNewSession, cachedProjects, cachedAllProjects, sessionMap,
// pendingSessions, openSessions, activePtyIds, refreshSidebar, pollActiveSessions (app.js)
// Depends on: ICONS (icons.js), backend-registry.js (launchableBackends/getBackend/refreshBackendCaches),
//   backend-icons.js (renderBackendIcon)

// Claude's brand mark, used for its row in the launch picker (other backends render a monogram badge).
const CLAUDE_POPOVER_ICON = '<svg class="popover-option-icon claude-icon" width="16" height="16" viewBox="0 0 1200 1200" fill="#d97757" stroke="none"><path d="M 233.959793 800.214905 L 468.644287 668.536987 L 472.590637 657.100647 L 468.644287 650.738403 L 457.208069 650.738403 L 417.986633 648.322144 L 283.892639 644.69812 L 167.597321 639.865845 L 54.926208 633.825623 L 26.577238 627.785339 L 3.3e-05 592.751709 L 2.73832 575.27533 L 26.577238 559.248352 L 60.724873 562.228149 L 136.187973 567.382629 L 249.422867 575.194763 L 331.570496 580.026978 L 453.261841 592.671082 L 472.590637 592.671082 L 475.328857 584.859009 L 468.724915 580.026978 L 463.570557 575.194763 L 346.389313 495.785217 L 219.543671 411.865906 L 153.100723 363.543762 L 117.181267 339.060425 L 99.060455 316.107361 L 91.248367 266.01355 L 123.865784 230.093994 L 167.677887 233.073853 L 178.872513 236.053772 L 223.248367 270.201477 L 318.040283 343.570496 L 441.825592 434.738342 L 459.946411 449.798706 L 467.194672 444.64447 L 468.080597 441.020203 L 459.946411 427.409485 L 392.617493 305.718323 L 320.778564 181.932983 L 288.80542 130.630859 L 280.348999 99.865845 C 277.369171 87.221436 275.194641 76.590698 275.194641 63.624268 L 312.322174 13.20813 L 332.8591 6.604126 L 382.389313 13.20813 L 403.248352 31.328979 L 434.013519 101.71814 L 483.865753 212.537048 L 561.181274 363.221497 L 583.812134 407.919434 L 595.892639 449.315491 L 600.40271 461.959839 L 608.214783 461.959839 L 608.214783 454.711609 L 614.577271 369.825623 L 626.335632 265.61084 L 637.771851 131.516846 L 641.718201 93.745117 L 660.402832 48.483276 L 697.530334 24.000122 L 726.52356 37.852417 L 750.362549 72 L 747.060486 94.067139 L 732.886047 186.201416 L 705.100708 330.52356 L 686.979919 427.167847 L 697.530334 427.167847 L 709.61084 415.087341 L 758.496704 350.174561 L 840.644348 247.490051 L 876.885925 206.738342 L 919.167847 161.71814 L 946.308838 140.29541 L 997.61084 140.29541 L 1035.38269 196.429626 L 1018.469849 254.416199 L 965.637634 321.422852 L 921.825562 378.201538 L 859.006714 462.765259 L 819.785278 530.41626 L 823.409424 535.812073 L 832.75177 534.92627 L 974.657776 504.724915 L 1051.328979 490.872559 L 1142.818848 475.167786 L 1184.214844 494.496582 L 1188.724854 514.147644 L 1172.456421 554.335693 L 1074.604126 578.496765 L 959.838989 601.449829 L 788.939636 641.879272 L 786.845764 643.409485 L 789.261841 646.389343 L 866.255127 653.637634 L 899.194702 655.409424 L 979.812134 655.409424 L 1129.932861 666.604187 L 1169.154419 692.537109 L 1192.671265 724.268677 L 1188.724854 748.429688 L 1128.322144 779.194641 L 1046.818848 759.865845 L 856.590759 714.604126 L 791.355774 698.335754 L 782.335693 698.335754 L 782.335693 703.731567 L 836.69812 756.885986 L 936.322205 846.845581 L 1061.073975 962.81897 L 1067.436279 991.490112 L 1051.409424 1014.120911 L 1034.496704 1011.704712 L 924.885986 929.234924 L 882.604126 892.107544 L 786.845764 811.48999 L 780.483276 811.48999 L 780.483276 819.946289 L 802.550415 852.241699 L 919.087341 1027.409424 L 925.127625 1081.127686 L 916.671204 1098.604126 L 886.469849 1109.154419 L 853.288696 1103.114136 L 785.073914 1007.355835 L 714.684631 899.516785 L 657.906067 802.872498 L 650.979858 806.81897 L 617.476624 1167.704834 L 601.771851 1186.147705 L 565.530212 1200 L 535.328857 1177.046997 L 519.302124 1139.919556 L 535.328857 1066.550537 L 554.657776 970.792053 L 570.362488 894.68457 L 584.536926 800.134277 L 592.993347 768.724976 L 592.429626 766.630859 L 585.503479 767.516968 L 514.22821 865.369263 L 405.825531 1011.865906 L 320.053711 1103.677979 L 299.516815 1111.812256 L 263.919525 1093.369263 L 267.221497 1060.429688 L 287.114136 1031.114136 L 405.825531 880.107361 L 477.422913 786.52356 L 523.651062 732.483276 L 523.328918 724.671265 L 520.590698 724.671265 L 205.288605 929.395935 L 149.154434 936.644409 L 124.993355 914.01355 L 127.973183 876.885986 L 139.409409 864.80542 L 234.201385 799.570435 L 233.879227 799.8927 Z"/></svg>';

// Terminal glyphs, shared by the Terminal group of the launch picker (plain terminal, external
// terminal, custom command, saved launchers) so the rows read as one family.
const TERMINAL_POPOVER_ICON = '<svg class="popover-option-icon terminal-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>';
const EXTERNAL_TERMINAL_POPOVER_ICON = '<svg class="popover-option-icon terminal-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/><path d="M15 3h6v6"/><path d="M21 3l-7 7"/></svg>';

// --- New session dialog ---
async function resolveDefaultSessionOptions(project) {
  const effective = await window.api.getEffectiveSettings(project.projectPath);
  const options = {};
  if (effective.dangerouslySkipPermissions) {
    options.dangerouslySkipPermissions = true;
  } else if (effective.permissionMode) {
    options.permissionMode = effective.permissionMode;
  }
  if (effective.worktree) {
    options.worktree = true;
    if (effective.worktreeName) options.worktreeName = effective.worktreeName;
  }
  if (effective.chrome) options.chrome = true;
  if (effective.preLaunchCmd) options.preLaunchCmd = effective.preLaunchCmd;
  if (effective.addDirs) options.addDirs = effective.addDirs;
  if (effective.mcpEmulation === false) options.mcpEmulation = false;
  // NOTE: Claude's launch defaults live HERE (Sessions & CLI), not in backendDefaults.claude.*. Two
  // homes for one setting means invisible precedence — see backends-panel.js. Axis-B backends, which
  // have no legacy home, use backendDefaults.<id> via applyBackendDefaultsToOptions below.
  return options;
}

// Map an Axis-B backend's `configFields` values (backendDefaults.<id>.<opt>) onto sessionOptions.
// The stored blob is AUTHORITATIVE for the keys it contains, so an explicitly-off toggle or a
// cleared text field really does turn the option off (a "skip falsy" merge could only ever turn
// options ON, which silently strands the user's "off").
function applyBackendDefaultsToOptions(options, defaults) {
  if (!defaults || typeof defaults !== 'object') return options;
  for (const [key, value] of Object.entries(defaults)) {
    if (value === '' || value == null || value === false) { delete options[key]; continue; }
    options[key] = value;
  }
  return options;
}

// The effective launch options for ONE backend: Claude (and every Axis-A profile — same binary, same
// options) reuses the existing Claude resolution; an Axis-B binary has its OWN option schema, so it
// only takes its backendDefaults.<id> block. `backendId` rides along so main.js routes the spawn.
async function resolveLaunchOptionsFor(project, backendId) {
  const backend = window.getBackend ? window.getBackend(backendId) : null;
  const isAxisB = backend && backend.axis === 'B';

  let options;
  if (isAxisB) {
    const effective = await window.api.getEffectiveSettings(project.projectPath);
    options = applyBackendDefaultsToOptions({}, (effective.backendDefaults || {})[backendId]);
  } else {
    options = await resolveDefaultSessionOptions(project);
  }

  options.backendId = backendId;
  // A profile is a user-created Axis-A backend; record it in the overlay as the profile too (§5.7).
  if (backend && backend.isProfile) options.profileId = backendId;
  return options;
}

async function forkSession(session, project) {
  const options = await resolveDefaultSessionOptions(project);
  options.forkFrom = session.sessionId;
  launchNewSession(project, options);
}

function findProjectForSession(session) {
  const project = [...cachedAllProjects, ...cachedProjects].find(p =>
    p.sessions && p.sessions.some(s => s.sessionId === session.sessionId)
  );
  return project || (session.projectPath ? { projectPath: session.projectPath } : null);
}

async function launchScheduleCreator(project) {
  const options = await resolveDefaultSessionOptions(project);
  // Pre-create a JSONL session with the schedule creation prompt, then resume into it
  const result = await window.api.createScheduleSession(project.projectPath);
  if (!result || !result.sessionId) return;

  const session = {
    sessionId: result.sessionId,
    summary: 'Create scheduled task',
    firstPrompt: '',
    projectPath: project.projectPath,
    name: null,
    starred: 0,
    archived: 0,
    messageCount: 1,
    modified: new Date().toISOString(),
    created: new Date().toISOString(),
  };

  // Inject into sidebar
  const folder = encodeProjectPath(project.projectPath);
  pendingSessions.set(result.sessionId, { session, projectPath: project.projectPath, folder });
  sessionMap.set(result.sessionId, session);
  injectPendingSession(session, project.projectPath, folder);
  refreshSidebar();

  const entry = createTerminalEntry(session);
  // Resume the pre-seeded session
  options.appendSystemPrompt = result.systemPrompt;
  const openResult = await window.api.openTerminal(result.sessionId, project.projectPath, false, options);
  if (!openResult.ok) {
    entry.terminal.write(`\r\nError: ${openResult.error}\r\n`);
    entry.closed = true;
    showSession(result.sessionId); // surface the failure instead of leaving it in an invisible terminal (issue #78)
    return;
  }
  if (typeof setSessionMcpActive === 'function') setSessionMcpActive(result.sessionId, !!openResult.mcpActive);
  syncPtySize(result.sessionId); // PTY spawned at 120x30 — push the real dimensions (#81)
  showSession(result.sessionId);
  pollActiveSessions();
}

// --- Tier-3 custom launchers (T-3.10) ---
// The effective list for one project: the GLOBAL list is a template for every project, a PROJECT
// entry overrides the same-id global one or adds a project-only launcher (merge in
// custom-launchers.js). Read straight from the two settings blobs — get-effective-settings cascades
// at top-level key granularity and would let a project list REPLACE the global one wholesale.
async function effectiveCustomLaunchers(projectPath, globalSettings) {
  if (typeof window.mergeCustomLaunchers !== 'function') return [];
  let global = globalSettings;
  if (!global) {
    try { global = (await window.api.getSetting('global')) || {}; } catch { global = {}; }
  }
  let projectSettings = {};
  try { projectSettings = (await window.api.getSetting('project:' + projectPath)) || {}; } catch {}
  return window.mergeCustomLaunchers(global.customLaunchers, projectSettings.customLaunchers);
}

// Run one launcher: 'in-app' → a monitored PTY tab (the plain-terminal spawn path); 'external' →
// the OS, launch-and-forget. Tier 3 either way: no backend, no session file, no badge.
async function runCustomLauncher(project, launcher, groupId) {
  if (launcher.runMode === 'external') {
    const res = await window.api.runCustomLauncher(launcher, project.projectPath)
      .catch(err => ({ ok: false, error: String((err && err.message) || err) }));
    // An external launch is unmonitored — there is no terminal tab to print the failure into, so
    // surface it here or it would fail silently.
    if (res && res.ok === false && typeof showControlMessage === 'function') {
      showControlMessage({
        title: `Could not start “${launcher.name}”`,
        message: res.error || 'The external launch failed.',
        tone: 'danger',
      });
    }
    return;
  }
  launchTerminalSession(project, groupId, launcher);
}

// The ad-hoc "Custom command…" (T-3.5): one command, typed now, run in a terminal tab. Same spawn
// path as an in-app launcher — it is just a launcher that was never saved.
function showCustomCommandDialog(project, groupId) {
  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'new-session-dialog';
  dialog.innerHTML = `
    <h3>Custom command — ${escapeHtml(project.projectPath.split(/[\\/]/).filter(Boolean).slice(-2).join('/'))}</h3>
    <div class="settings-field settings-field-wide">
      <div class="settings-field-info">
        <span class="settings-label">Command</span>
        <div class="settings-description">Runs in a terminal tab, in your terminal shell, in this project. Any command or script — <code>npm run dev</code>, a git command, a <code>.ps1</code>/<code>.sh</code>. Save it under Settings → Terminal → Terminal tools to keep it.</div>
      </div>
      <div class="settings-field-control">
        <input type="text" class="settings-input" id="ccd-command" placeholder="e.g. npm run dev" autocomplete="off" spellcheck="false">
      </div>
    </div>
    <div class="new-session-actions">
      <button class="new-session-cancel-btn">Cancel</button>
      <button class="new-session-start-btn">Run</button>
    </div>`;
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const input = dialog.querySelector('#ccd-command');
  input.focus();

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }
  function run() {
    const command = input.value.trim();
    if (!command) { input.focus(); return; }
    close();
    launchTerminalSession(project, groupId, {
      id: 'ad-hoc',
      name: command,
      command,
      runMode: 'in-app',
    });
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
    else if (e.key === 'Enter') run();
  }
  dialog.querySelector('.new-session-cancel-btn').onclick = close;
  dialog.querySelector('.new-session-start-btn').onclick = run;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  document.addEventListener('keydown', onKey);
}

async function showNewSessionPopover(project, anchorEl, { groupId = null } = {}) {
  // Remove any existing popover
  document.querySelectorAll('.new-session-popover').forEach(el => el.remove());

  // Handoff library: when on, offer "Claude Handoff resume" in the menu.
  const globalSettings = (await window.api.getSetting('global')) || {};
  const handoffLibrary = !!globalSettings.handoffLibrary;
  const launchers = await effectiveCustomLaunchers(project.projectPath, globalSettings);

  const popover = document.createElement('div');
  popover.className = 'new-session-popover';

  // One row per ready && enabled backend (T-3.2). The row BODY launches with the effective defaults;
  // the inline gear opens the Configure dialog for a one-off override. This merges Claude's old
  // two-row pattern ("Claude" + "Claude (Configure...)") into a single row per backend, so adding a
  // backend doesn't double the menu length. Only `ready && enabled` backends appear (§5.8) — a
  // `planned` or disabled one is never offered.
  await (window.refreshBackendCaches ? window.refreshBackendCaches() : Promise.resolve());
  const backendList = window.launchableBackends ? window.launchableBackends() : [];
  // Claude first, then the other built-ins, then user profiles — a stable, predictable order.
  backendList.sort((a, b) => {
    if (a.id === 'claude') return -1;
    if (b.id === 'claude') return 1;
    if (!!a.isProfile !== !!b.isProfile) return a.isProfile ? 1 : -1;
    return String(a.label).localeCompare(String(b.label));
  });

  for (const backend of backendList) {
    const row = document.createElement('div');
    row.className = 'popover-option popover-option-backend';

    const launchBtn = document.createElement('button');
    launchBtn.className = 'popover-option-body';
    launchBtn.title = `Start a ${backend.label} session with the current defaults`;
    if (backend.id === 'claude') {
      launchBtn.innerHTML = CLAUDE_POPOVER_ICON;
      launchBtn.append(' Claude');
    } else if (window.renderBackendIcon) {
      const icon = window.renderBackendIcon(backend.icon || backend.id, 16, { monogram: backend.monogram });
      icon.classList.add('popover-option-icon');
      launchBtn.appendChild(icon);
      launchBtn.append(' ' + backend.label);
    } else {
      launchBtn.textContent = backend.label;
    }
    launchBtn.onclick = async () => {
      popover.remove();
      launchNewSession(project, await resolveLaunchOptionsFor(project, backend.id), undefined, groupId);
    };

    const gearBtn = document.createElement('button');
    gearBtn.className = 'popover-option-gear';
    gearBtn.title = `Configure this ${backend.label} session`;
    gearBtn.setAttribute('aria-label', `Configure ${backend.label}`);
    gearBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
    gearBtn.onclick = () => { popover.remove(); showNewSessionDialog(project, groupId, backend.id); };

    row.appendChild(launchBtn);
    row.appendChild(gearBtn);
    popover.appendChild(row);
  }

  const termBtn = document.createElement('button');
  termBtn.className = 'popover-option popover-option-terminal';
  termBtn.innerHTML = TERMINAL_POPOVER_ICON + ' Terminal';
  termBtn.onclick = () => { popover.remove(); launchTerminalSession(project, groupId); };

  // "Claude Handoff resume" — only in Handoff-library mode. Disabled+greyed when the
  // project has no saved handoffs (visible, not hidden).
  if (handoffLibrary) {
    const resumeBtn = document.createElement('button');
    resumeBtn.className = 'popover-option popover-option-handoff';
    resumeBtn.innerHTML = '<svg class="popover-option-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg> Claude Handoff resume';
    resumeBtn.disabled = true;
    resumeBtn.title = 'Checking saved handoffs…';
    resumeBtn.onclick = () => { popover.remove(); showHandoffResumePicker(project, groupId); };
    popover.appendChild(resumeBtn);
    // Enable once we know the project has at least one saved handoff.
    window.api.listHandoffs(project.projectPath).then(list => {
      if (Array.isArray(list) && list.length) {
        resumeBtn.disabled = false;
        resumeBtn.title = 'Start a fresh session from a saved handoff';
      } else {
        resumeBtn.title = 'No saved handoffs for this project';
      }
    }).catch(() => { resumeBtn.title = 'No saved handoffs for this project'; });
  }

  // The Terminal group (T-3.10): the plain terminal, the OS terminal, the ad-hoc custom command,
  // then the user's saved launchers. Everything here is Tier 3 — launch-only, never a session.
  const termLabel = document.createElement('div');
  termLabel.className = 'popover-group-label';
  termLabel.textContent = 'Terminal';
  popover.appendChild(termLabel);

  popover.appendChild(termBtn);

  // External terminal — launch the OS terminal in the project directory
  // (launch-and-forget; not monitored/shown in the app).
  const extTermBtn = document.createElement('button');
  extTermBtn.className = 'popover-option popover-option-terminal';
  extTermBtn.innerHTML = EXTERNAL_TERMINAL_POPOVER_ICON + ' External Terminal';
  extTermBtn.onclick = () => { popover.remove(); window.api.openExternalTerminal(project.projectPath); };
  popover.appendChild(extTermBtn);

  // Ad-hoc custom command (T-3.5) — a one-off command in a terminal tab.
  const customCmdBtn = document.createElement('button');
  customCmdBtn.className = 'popover-option popover-option-terminal';
  customCmdBtn.innerHTML = TERMINAL_POPOVER_ICON + ' Custom command…';
  customCmdBtn.title = 'Run any command once in a terminal tab';
  customCmdBtn.onclick = () => { popover.remove(); showCustomCommandDialog(project, groupId); };
  popover.appendChild(customCmdBtn);

  // Saved launchers (T-3.10) — the effective global ⊕ project list for THIS project.
  for (const launcher of launchers) {
    const btn = document.createElement('button');
    btn.className = 'popover-option popover-option-terminal popover-option-launcher';
    btn.innerHTML = (launcher.runMode === 'external' ? EXTERNAL_TERMINAL_POPOVER_ICON : TERMINAL_POPOVER_ICON)
      + `<span class="popover-option-text">${escapeHtml(launcher.name)}</span>`;
    btn.title = launcher.runMode === 'external'
      ? `${launcher.command} — runs in an external window (not monitored)`
      : `${launcher.command} — runs in a terminal tab`;
    btn.onclick = () => { popover.remove(); runCustomLauncher(project, launcher, groupId); };
    popover.appendChild(btn);
  }

  // Open the project directory in the OS file explorer.
  const explorerBtn = document.createElement('button');
  explorerBtn.className = 'popover-option';
  explorerBtn.innerHTML = '<svg class="popover-option-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 002-2V8a2 2 0 00-2-2h-7.9a2 2 0 01-1.69-.9L9.6 3.9A2 2 0 007.93 3H4a2 2 0 00-2 2v13c0 1.1.9 2 2 2z"/></svg> Open in File Explorer';
  explorerBtn.onclick = () => { popover.remove(); window.api.openPath(project.projectPath); };
  popover.appendChild(explorerBtn);

  // Position relative to anchor, flip upward if it would overflow
  document.body.appendChild(popover);
  const rect = anchorEl.getBoundingClientRect();
  const popoverHeight = popover.offsetHeight;
  if (rect.bottom + 4 + popoverHeight > window.innerHeight) {
    popover.style.top = (rect.top - popoverHeight - 4) + 'px';
  } else {
    popover.style.top = (rect.bottom + 4) + 'px';
  }
  popover.style.left = rect.left + 'px';

  // Close on click outside. Capture phase (true): xterm stops propagation on
  // terminal mousedowns, so a bubble-phase listener never fires when the user
  // clicks into the terminal and the popover would stay open (#93).
  function onClickOutside(e) {
    if (!popover.contains(e.target) && e.target !== anchorEl) {
      popover.remove();
      document.removeEventListener('mousedown', onClickOutside, true);
    }
  }
  setTimeout(() => document.addEventListener('mousedown', onClickOutside, true), 0);
}

// `launcher` (optional, T-3.10/T-3.5): a Tier-3 custom launcher, or the ad-hoc custom command. It
// spawns the SAME monitored PTY tab as a plain terminal — main just types the command into the
// shell once it is up. The session stays a terminal session: no transcript, so nothing downstream
// (scanner, cache, badge) has anything to trip over.
async function launchTerminalSession(project, groupId, launcher = null) {
  const sessionId = crypto.randomUUID();
  const projectPath = project.projectPath;
  const session = {
    sessionId,
    summary: launcher ? launcher.name : 'Terminal',
    firstPrompt: '',
    projectPath,
    name: null,
    starred: 0,
    archived: 0,
    messageCount: 0,
    modified: new Date().toISOString(),
    created: new Date().toISOString(),
    type: 'terminal',
  };

  // Track as pending
  const folder = encodeProjectPath(projectPath);
  pendingSessions.set(sessionId, { session, projectPath, folder });

  // Inject into cached project data
  sessionMap.set(sessionId, session);
  injectPendingSession(session, projectPath, folder);
  if (groupId && typeof assignSessionToGroup === 'function') {
    assignSessionToGroup(sessionId, groupId);
  } else {
    refreshSidebar();
  }

  const entry = createTerminalEntry(session);

  const sessionOptions = { type: 'terminal' };
  if (launcher) sessionOptions.launcher = launcher;
  const result = await window.api.openTerminal(sessionId, projectPath, true, sessionOptions);
  if (!result.ok) {
    entry.terminal.write(`\r\nError: ${result.error}\r\n`);
    entry.closed = true;
    showSession(sessionId); // surface the failure instead of leaving it in an invisible terminal (issue #78)
    return;
  }

  syncPtySize(sessionId); // PTY spawned at 120x30 — push the real dimensions (#81)
  showSession(sessionId);
  pollActiveSessions();
}

// Shared permission-mode picker for the New-session and Resume dialogs (#79).
// Owns the mode list, grid HTML, selection state, and click handling; callers
// embed html() in their dialog markup, bind() the mounted grid element, and
// applyTo() the launch options on confirm.
const PERMISSION_MODES = [
  { value: null, label: 'Default', desc: 'Prompt for all actions' },
  { value: 'acceptEdits', label: 'Accept Edits', desc: 'Auto-accept file edits & common fs commands' },
  { value: 'plan', label: 'Plan Mode', desc: 'Read-only exploration, no writes' },
  { value: 'auto', label: 'Auto', desc: 'Auto-approve tool calls, background safety checks (preview)' },
  { value: 'dontAsk', label: "Don't Ask", desc: 'Auto-deny tools unless pre-approved' },
  { value: 'bypassPermissions', label: 'Bypass', desc: 'Skip all prompts except ask-rules & root/home removals' },
];

function createPermissionModePicker(effective) {
  let selectedMode = effective.permissionMode || null;
  let dangerousSkip = effective.dangerouslySkipPermissions || false;

  const html = () =>
    PERMISSION_MODES.map(m => {
      const isSelected = !dangerousSkip && selectedMode === m.value;
      return `<button class="permission-option${isSelected ? ' selected' : ''}" data-mode="${m.value}"><span class="perm-name">${m.label}</span><span class="perm-desc">${m.desc}</span></button>`;
    }).join('') +
    `<button class="permission-option dangerous${dangerousSkip ? ' selected' : ''}" data-mode="dangerous-skip"><span class="perm-name">Dangerous Skip</span><span class="perm-desc">Skip all safety prompts (use with caution)</span></button>`;

  return {
    html,
    bind(gridEl) {
      gridEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.permission-option');
        if (!btn) return;
        const mode = btn.dataset.mode;
        if (mode === 'dangerous-skip') {
          dangerousSkip = !dangerousSkip;
          if (dangerousSkip) selectedMode = null;
        } else {
          dangerousSkip = false;
          selectedMode = mode === 'null' ? null : mode;
        }
        gridEl.innerHTML = html();
      });
    },
    applyTo(options) {
      if (dangerousSkip) {
        options.dangerouslySkipPermissions = true;
      } else if (selectedMode) {
        options.permissionMode = selectedMode;
      }
    },
  };
}

// The Configure dialog for a backend whose launch options are its OWN (Axis-B: Codex, later Gemini).
// It is GENERATED from the descriptor's `configFields` (00 §4a) and pre-filled from the effective
// per-backend defaults (default → global → project), so a new backend needs no dialog code — it just
// declares its schema. Claude (and every Axis-A profile, which runs the same binary with the same
// options) keeps its purpose-built form below, which carries behaviour the generic schema doesn't
// model (worktree naming, pre-launch command, AFK timeout).
async function showGeneratedConfigDialog(project, groupId, backend) {
  const effective = await window.api.getEffectiveSettings(project.projectPath);
  const saved = (effective.backendDefaults || {})[backend.id] || {};
  const fields = backend.configFields || [];

  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'new-session-dialog';

  const body = fields.map((f, i) => {
    const val = saved[f.id] !== undefined ? saved[f.id] : f.default;
    const id = `gcd-${i}`;
    let control;
    if (f.type === 'select') {
      const opts = (f.choices || []).map(c =>
        `<option value="${escapeHtml(String(c))}" ${String(val) === String(c) ? 'selected' : ''}>${escapeHtml(String(c))}</option>`
      ).join('');
      control = `<select class="settings-select" id="${id}">${opts}</select>`;
    } else if (f.type === 'toggle') {
      control = `<label class="settings-toggle"><input type="checkbox" id="${id}" ${val ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>`;
    } else {
      const t = f.type === 'number' ? 'text' : 'text';
      control = `<input type="${t}" class="settings-input" id="${id}" value="${escapeHtml(val == null ? '' : String(val))}">`;
    }
    return `
      <div class="settings-field settings-field-wide">
        <div class="settings-field-info"><span class="settings-label">${escapeHtml(f.label || f.id)}</span></div>
        <div class="settings-field-control">${control}</div>
      </div>`;
  }).join('');

  dialog.innerHTML = `
    <h3>New ${escapeHtml(backend.label)} Session — ${escapeHtml(project.projectPath.split(/[\\/]/).filter(Boolean).slice(-2).join('/'))}</h3>
    ${body || '<div class="settings-description">This backend has no launch options.</div>'}
    <div class="new-session-actions">
      <button class="new-session-cancel-btn">Cancel</button>
      <button class="new-session-start-btn">Start</button>
    </div>
  `;
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }
  function start() {
    const options = { backendId: backend.id };
    fields.forEach((f, i) => {
      const el = dialog.querySelector(`#gcd-${i}`);
      if (!el) return;
      const v = f.type === 'toggle' ? el.checked : el.value.trim();
      if (v === '' || v === false) return;
      options[f.id] = v;
    });
    close();
    launchNewSession(project, options, undefined, groupId);
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
    else if (e.key === 'Enter') start();
  }
  dialog.querySelector('.new-session-cancel-btn').onclick = close;
  dialog.querySelector('.new-session-start-btn').onclick = start;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  document.addEventListener('keydown', onKey);
}

async function showNewSessionDialog(project, groupId, backendId) {
  // An Axis-B binary has its own option schema -> generated dialog. Claude and Axis-A profiles share
  // the claude binary (and therefore Claude's options) -> the purpose-built form below.
  const backend = (backendId && window.getBackend) ? window.getBackend(backendId) : null;
  if (backend && backend.axis === 'B') {
    return showGeneratedConfigDialog(project, groupId, backend);
  }

  const effective = await window.api.getEffectiveSettings(project.projectPath);

  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'new-session-dialog';

  const modePicker = createPermissionModePicker(effective);

  dialog.innerHTML = `
    <h3>New Session — ${escapeHtml(project.projectPath.split('/').filter(Boolean).slice(-2).join('/'))}</h3>
    <div class="settings-field">
      <div class="settings-label">Permission Mode</div>
      <div class="permission-grid" id="nsd-mode-grid">${modePicker.html()}</div>
    </div>
    <div class="settings-field">
      <div class="settings-field-info">
        <span class="settings-label">Worktree</span>
        <div class="settings-description">Run session in an isolated git worktree</div>
      </div>
      <div class="settings-field-control">
        <input type="text" class="settings-input" id="nsd-worktree-name" placeholder="name (optional)" value="${escapeHtml(effective.worktreeName || '')}" style="width:140px">
        <label class="settings-toggle"><input type="checkbox" id="nsd-worktree" ${effective.worktree ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
      </div>
    </div>
    <div class="settings-field">
      <div class="settings-field-info">
        <span class="settings-label">Chrome</span>
        <div class="settings-description">Enable Chrome browser automation</div>
      </div>
      <div class="settings-field-control">
        <label class="settings-toggle"><input type="checkbox" id="nsd-chrome" ${effective.chrome ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
      </div>
    </div>
    <div class="settings-field settings-field-wide">
      <div class="settings-field-info">
        <span class="settings-label">Pre-launch Command</span>
        <div class="settings-description">Prepended to the claude command</div>
      </div>
      <div class="settings-field-control">
        <input type="text" class="settings-input" id="nsd-pre-launch" placeholder="e.g. aws-vault exec profile --" value="${escapeHtml(effective.preLaunchCmd || '')}">
      </div>
    </div>
    <div class="settings-field settings-field-wide">
      <div class="settings-field-info">
        <span class="settings-label">Additional Directories</span>
        <div class="settings-description">Extra directories to include (comma-separated)</div>
      </div>
      <div class="settings-field-control">
        <input type="text" class="settings-input" id="nsd-add-dirs" placeholder="/path/to/dir1, /path/to/dir2" value="${escapeHtml(effective.addDirs || '')}">
      </div>
    </div>
    <div class="settings-field settings-field-wide">
      <div class="settings-field-info">
        <span class="settings-label">AskUserQuestion timeout (seconds)</span>
        <div class="settings-description">Empty = inherit (project/global, Claude default 60). <code>0</code> = never auto-continue.</div>
      </div>
      <div class="settings-field-control">
        <input type="text" class="settings-input" id="nsd-afk-timeout" placeholder="inherit" value="" style="width:140px">
      </div>
    </div>
    <div class="new-session-actions">
      <button class="new-session-cancel-btn">Cancel</button>
      <button class="new-session-start-btn">Start</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  modePicker.bind(dialog.querySelector('#nsd-mode-grid'));

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  function start() {
    const options = {};
    modePicker.applyTo(options);
    if (dialog.querySelector('#nsd-worktree').checked) {
      options.worktree = true;
      options.worktreeName = dialog.querySelector('#nsd-worktree-name').value.trim();
    }
    if (dialog.querySelector('#nsd-chrome').checked) {
      options.chrome = true;
    }
    const preLaunch = dialog.querySelector('#nsd-pre-launch').value.trim();
    if (preLaunch) options.preLaunchCmd = preLaunch;
    options.addDirs = dialog.querySelector('#nsd-add-dirs').value.trim();
    {
      // Per-session AFK-timeout override; empty/negative/invalid → inherit (not set).
      // 0 is a valid value (= off / never).
      const raw = dialog.querySelector('#nsd-afk-timeout').value.trim();
      const n = Number(raw);
      if (raw !== '' && Number.isFinite(n) && n >= 0) options.afkTimeoutSec = String(Math.floor(n));
    }
    if (effective.mcpEmulation === false) options.mcpEmulation = false;
    // Route the spawn to the chosen backend. Claude is the default; an Axis-A profile is just a
    // backendId that also carries an env bundle, so record it as the profile too (§5.7).
    if (backendId) {
      options.backendId = backendId;
      if (backend && backend.isProfile) options.profileId = backendId;
    }
    close();
    launchNewSession(project, options, undefined, groupId);
  }

  dialog.querySelector('.new-session-cancel-btn').onclick = close;
  dialog.querySelector('.new-session-start-btn').onclick = start;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // Keyboard support
  // close() removes this listener for every dismissal path (cancel, overlay,
  // start, Esc, Enter) — never leak it, or a later stray Enter fires start()
  // on the detached dialog and launches a ghost session (issue #75).
  function onKey(e) {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && !e.target.matches('input')) start();
  }
  document.addEventListener('keydown', onKey);
}

async function showResumeSessionDialog(session) {
  const effective = await window.api.getEffectiveSettings(session.projectPath);

  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'new-session-dialog';

  const modePicker = createPermissionModePicker(effective);

  const sessionName = session.name || session.aiTitle || session.summary || session.sessionId.slice(0, 8);

  dialog.innerHTML = `
    <h3>Resume Session — ${escapeHtml(sessionName)}</h3>
    <div class="settings-field">
      <div class="settings-label">Permission Mode</div>
      <div class="permission-grid" id="rsd-mode-grid">${modePicker.html()}</div>
    </div>
    <div class="settings-field">
      <div class="settings-field-info">
        <span class="settings-label">Chrome</span>
        <div class="settings-description">Enable Chrome browser automation</div>
      </div>
      <div class="settings-field-control">
        <label class="settings-toggle"><input type="checkbox" id="rsd-chrome" ${effective.chrome ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
      </div>
    </div>
    <div class="settings-field settings-field-wide">
      <div class="settings-field-info">
        <span class="settings-label">Pre-launch Command</span>
        <div class="settings-description">Prepended to the claude command</div>
      </div>
      <div class="settings-field-control">
        <input type="text" class="settings-input" id="rsd-pre-launch" placeholder="e.g. aws-vault exec profile --" value="${escapeHtml(effective.preLaunchCmd || '')}">
      </div>
    </div>
    <div class="settings-field settings-field-wide">
      <div class="settings-field-info">
        <span class="settings-label">Additional Directories</span>
        <div class="settings-description">Extra directories to include (comma-separated)</div>
      </div>
      <div class="settings-field-control">
        <input type="text" class="settings-input" id="rsd-add-dirs" placeholder="/path/to/dir1, /path/to/dir2" value="${escapeHtml(effective.addDirs || '')}">
      </div>
    </div>
    <div class="new-session-actions">
      <button class="new-session-cancel-btn">Cancel</button>
      <button class="new-session-start-btn">Resume</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  modePicker.bind(dialog.querySelector('#rsd-mode-grid'));

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  function resume() {
    const options = {};
    modePicker.applyTo(options);
    if (dialog.querySelector('#rsd-chrome').checked) {
      options.chrome = true;
    }
    const preLaunch = dialog.querySelector('#rsd-pre-launch').value.trim();
    if (preLaunch) options.preLaunchCmd = preLaunch;
    options.addDirs = dialog.querySelector('#rsd-add-dirs').value.trim();
    if (effective.mcpEmulation === false) options.mcpEmulation = false;
    close();
    openSession(session, options);
  }

  dialog.querySelector('.new-session-cancel-btn').onclick = close;
  dialog.querySelector('.new-session-start-btn').onclick = resume;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // See showNewSessionDialog: close() owns listener removal for all paths.
  function onKey(e) {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && !e.target.matches('input')) resume();
  }
  document.addEventListener('keydown', onKey);
}

// Settings viewer is in settings-panel.js (openSettingsViewer / closeSettingsViewer)
// Global settings button & add project button bindings are in app.js (need DOM refs)

function showAddProjectDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'add-project-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'add-project-dialog';

  dialog.innerHTML = `
    <h3>Add Project</h3>
    <div class="add-project-hint">Select a folder to create a new project. To start a session in an existing project, use the + on its project header.</div>
    <div class="folder-input-row">
      <input type="text" id="add-project-path" placeholder="/path/to/project" autocomplete="off" spellcheck="false">
      <button class="add-project-browse-btn">Browse</button>
    </div>
    <div class="add-project-error" id="add-project-error"></div>
    <div class="add-project-actions">
      <button class="add-project-cancel-btn">Cancel</button>
      <button class="add-project-add-btn">Add</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const pathInput = dialog.querySelector('#add-project-path');
  const errorEl = dialog.querySelector('#add-project-error');
  pathInput.focus();

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  async function addProject() {
    const projectPath = pathInput.value.trim();
    if (!projectPath) {
      errorEl.textContent = 'Please enter a folder path.';
      errorEl.style.display = 'block';
      return;
    }
    errorEl.style.display = 'none';
    const result = await window.api.addProject(projectPath);
    if (result.error) {
      errorEl.textContent = result.error;
      errorEl.style.display = 'block';
      return;
    }
    close();

    await loadProjects();
  }

  dialog.querySelector('.add-project-browse-btn').onclick = async () => {
    const folder = await window.api.browseFolder();
    if (folder) pathInput.value = folder;
  };

  dialog.querySelector('.add-project-cancel-btn').onclick = close;
  dialog.querySelector('.add-project-add-btn').onclick = addProject;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  function onKey(e) {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter') addProject();
  }
  document.addEventListener('keydown', onKey);
}
