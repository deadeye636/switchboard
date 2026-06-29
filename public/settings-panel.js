// Settings panel component
// Manages the global and project settings viewer UI.

(function () {
  const settingsViewer = document.getElementById('settings-viewer');
  const settingsViewerTitle = document.getElementById('settings-viewer-title');
  const settingsViewerBody = document.getElementById('settings-viewer-body');

  function closeSettingsViewer() {
    // Standalone settings window: there is no terminal area to restore — just close it.
    if (window.__SETTINGS_WINDOW__) { try { window.close(); } catch {} return; }
    settingsViewer.style.display = 'none';
    const terminalArea = document.getElementById('terminal-area');
    const terminalHeader = document.getElementById('terminal-header');
    const placeholder = document.getElementById('placeholder');
    const gridViewActive = localStorage.getItem('gridViewActive') === '1';
    const activeSessionId = sessionStorage.getItem('activeSessionId') || null;
    // Check if there's an active session with an open terminal
    if (activeSessionId && window._openSessions && window._openSessions.has(activeSessionId)) {
      terminalArea.style.display = '';
      terminalHeader.style.display = '';
    } else if (gridViewActive) {
      terminalArea.style.display = '';
    } else {
      placeholder.style.display = '';
    }
  }

  async function openSettingsViewer(scope, projectPath) {
    const isProject = scope === 'project';
    const settingsKey = isProject ? 'project:' + projectPath : 'global';
    const current = (await window.api.getSetting(settingsKey)) || {};
    const globalSettings = isProject ? ((await window.api.getSetting('global')) || {}) : {};

    const shortName = isProject
      ? projectPath.split('/').filter(Boolean).slice(-2).join('/')
      : 'Global';

    settingsViewerTitle.textContent = (isProject ? 'Project Settings — ' : 'Global Settings — ') + shortName;

    // Show settings viewer, hide others
    document.getElementById('placeholder').style.display = 'none';
    document.getElementById('terminal-area').style.display = 'none';
    document.getElementById('plan-viewer').style.display = 'none';
    document.getElementById('stats-viewer').style.display = 'none';
    document.getElementById('memory-viewer').style.display = 'none';
    document.getElementById('jsonl-viewer').style.display = 'none';
    settingsViewer.style.display = 'flex';

    function useGlobalCheckbox(fieldName) {
      if (!isProject) return '';
      const useGlobal = current[fieldName] === undefined || current[fieldName] === null;
      return `<label class="settings-use-global"><input type="checkbox" data-field="${fieldName}" class="use-global-cb" ${useGlobal ? 'checked' : ''}> Use global default</label>`;
    }

    function fieldValue(fieldName, fallback) {
      if (isProject && (current[fieldName] === undefined || current[fieldName] === null)) {
        return globalSettings[fieldName] !== undefined ? globalSettings[fieldName] : fallback;
      }
      return current[fieldName] !== undefined ? current[fieldName] : fallback;
    }

    function fieldDisabled(fieldName) {
      if (!isProject) return '';
      return (current[fieldName] === undefined || current[fieldName] === null) ? 'disabled' : '';
    }

    const permModeValue = fieldValue('permissionMode', '');
    const worktreeValue = fieldValue('worktree', false);
    const worktreeNameValue = fieldValue('worktreeName', '');
    const chromeValue = fieldValue('chrome', false);
    const preLaunchValue = fieldValue('preLaunchCmd', '');
    const addDirsValue = fieldValue('addDirs', '');
    const visCountValue = fieldValue('visibleSessionCount', 10);
    const maxAgeValue = fieldValue('sessionMaxAgeDays', 3);
    const themeValue = fieldValue('terminalTheme', 'switchboard');
    const rightClickValue = fieldValue('terminalRightClick', 'menu');
    const mouseReportingValue = fieldValue('terminalMouseReporting', 'on');
    const displayModeValue = fieldValue('sessionDisplayMode', 'legacy');
    const settingsOpenModeValue = fieldValue('settingsOpenMode', 'overlay');
    const tabPositionValue = fieldValue('tabPosition', 'top');
    const tabCloseValue = fieldValue('tabCloseBehavior', 'closeView');
    const tabMiddleClickValue = fieldValue('tabMiddleClickCloses', true);
    const tabDragValue = fieldValue('tabDragReorder', true);
    const mcpEmulationValue = fieldValue('mcpEmulation', true);
    const restoreSessionsValue = fieldValue('restoreSessionsOnLaunch', true);
    const attentionHooksValue = fieldValue('attentionHooks', false);
    const shellProfileValue = fieldValue('shellProfile', 'auto');
    // Notifications (global only) — alert sound on attention + read-only hotkey hint.
    const attentionSoundValue = !!((current.notifications || {}).sound);
    const isMacPlatform = !!(window.api && window.api.platform === 'darwin');
    const nextAttentionShortcutLabel = isMacPlatform ? '\u2318\u21e7A' : 'Ctrl+Shift+A';

    // Notifications live in the global blob under `notifications`.
    const notificationsValue = (!isProject && current.notifications) || {};
    const notifyEnabledValue = notificationsValue.enabled !== false; // default on
    const notifyOnReadyValue = !!notificationsValue.notifyOnReady; // default off

    // Working copy of the (global-only) re-bindable keyboard shortcuts.
    let scShortcuts = normalizeShortcuts(isProject ? null : current.shortcuts);
    const scIsMac = typeof isMac !== 'undefined' ? isMac : /Mac|iPhone|iPad/.test(navigator.platform);

    // Discover available shell profiles
    let shellProfiles = [];
    try { shellProfiles = await window.api.getShellProfiles(); } catch {};

    settingsViewerBody.innerHTML = `
    <div class="settings-form">
      <div class="settings-section">
        <div class="settings-section-title">Claude CLI Options</div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Auto mode</span>
            <div class="settings-description">Auto-accept Claude's file edits without prompting (Claude's Shift+Tab "auto-accept edits"). Claude still asks before running risky commands. Shortcut for Permission Mode &rarr; Accept Edits.</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-auto-mode" ${permModeValue === 'acceptEdits' ? 'checked' : ''} ${fieldDisabled('permissionMode')}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Permission Mode</span>
              ${useGlobalCheckbox('permissionMode')}
            </div>
            <div class="settings-description">Permission mode passed to the <code>claude</code> command. "Accept Edits" is the same as Auto mode above.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-perm-mode" ${fieldDisabled('permissionMode')}>
              <option value="">Default — ask before each action</option>
              <option value="acceptEdits" ${permModeValue === 'acceptEdits' ? 'selected' : ''}>Accept Edits — auto mode (auto-accept file edits)</option>
              <option value="plan" ${permModeValue === 'plan' ? 'selected' : ''}>Plan — read-only, propose a plan first</option>
              <option value="dontAsk" ${permModeValue === 'dontAsk' ? 'selected' : ''}>Don't Ask — skip routine confirmations</option>
              <option value="bypassPermissions" ${permModeValue === 'bypassPermissions' ? 'selected' : ''}>Bypass — skip all permission checks</option>
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Worktree</span>
              ${useGlobalCheckbox('worktree')}
            </div>
            <div class="settings-description">Enable worktree for new sessions</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-worktree" ${worktreeValue ? 'checked' : ''} ${fieldDisabled('worktree')}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Worktree Name</span>
              ${useGlobalCheckbox('worktreeName')}
            </div>
            <div class="settings-description">Custom name for worktree branches</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-worktree-name" placeholder="auto" value="${escapeHtml(worktreeNameValue)}" ${fieldDisabled('worktreeName')} style="width:140px">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Chrome</span>
              ${useGlobalCheckbox('chrome')}
            </div>
            <div class="settings-description">Enable Chrome browser automation</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-chrome" ${chromeValue ? 'checked' : ''} ${fieldDisabled('chrome')}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>

        <div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Additional Directories</span>
              ${useGlobalCheckbox('addDirs')}
            </div>
            <div class="settings-description">Extra directories to include in Claude sessions</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-add-dirs" placeholder="/path/to/dir1, /path/to/dir2" value="${escapeHtml(addDirsValue)}" ${fieldDisabled('addDirs')}>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Session Launch</div>

        <div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Pre-launch Command</span>
              ${useGlobalCheckbox('preLaunchCmd')}
            </div>
            <div class="settings-description">Prepended to the claude command (e.g. "aws-vault exec profile --")</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-pre-launch" placeholder="e.g. aws-vault exec profile --" value="${escapeHtml(preLaunchValue)}" ${fieldDisabled('preLaunchCmd')}>
          </div>
        </div>
      </div>

      ${!isProject ? `<div class="settings-section">
        <div class="settings-section-title">Application</div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Terminal Theme</span>
            <div class="settings-description">Color theme for terminal sessions</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-terminal-theme">
              ${Object.entries(TERMINAL_THEMES).map(([key, t]) =>
                `<option value="${key}" ${themeValue === key ? 'selected' : ''}>${escapeHtml(t.label)}</option>`
              ).join('')}
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Terminal Right-Click</span>
            <div class="settings-description">What a right-click in the terminal does. Menu = context menu with file-link actions, copy &amp; paste. Copy or paste = copy the selection, or paste when nothing is selected (Windows/PuTTY style). Copy only = copy the selection. Native = xterm default. Takes effect on the next right-click.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-right-click">
              <option value="menu" ${rightClickValue === 'menu' ? 'selected' : ''}>Menu</option>
              <option value="copy-paste" ${rightClickValue === 'copy-paste' ? 'selected' : ''}>Copy or paste</option>
              <option value="copy" ${rightClickValue === 'copy' ? 'selected' : ''}>Copy only</option>
              <option value="default" ${rightClickValue === 'default' ? 'selected' : ''}>Native</option>
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Terminal Mouse Reporting</span>
            <div class="settings-description">When on, terminal apps (e.g. Claude Code's TUI) can use the mouse for scrolling/clicking; select text with Shift+drag. When off, Switchboard strips the mouse-tracking escape sequences so plain left-click+drag always selects text — but the TUI no longer receives mouse events. Takes full effect on the next session output (open terminals are reset immediately).</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-mouse-reporting" ${mouseReportingValue !== 'off' ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Shell Profile</span>
            <div class="settings-description">Shell used for terminal and Claude sessions. Changes take effect for new sessions only.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-shell-profile">
              <option value="auto" ${shellProfileValue === 'auto' ? 'selected' : ''}>Auto (detect)</option>
              ${shellProfiles.map(p =>
                `<option value="${escapeHtml(p.id)}" ${shellProfileValue === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
              ).join('')}
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Max Visible Sessions</span>
            <div class="settings-description">Show up to this many sessions before collapsing the rest behind "+N older"</div>
          </div>
          <div class="settings-field-control">
            <input type="number" class="settings-input settings-input-compact" id="sv-visible-count" min="1" max="100" value="${visCountValue}">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Session Max Age (days)</span>
            <div class="settings-description">Sessions older than this are hidden behind "+N older" even if under the count limit</div>
          </div>
          <div class="settings-field-control">
            <input type="number" class="settings-input settings-input-compact" id="sv-max-age" min="1" max="365" value="${maxAgeValue}">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Restore open sessions on launch</span>
            <div class="settings-description">Reopen the sessions you had open when Switchboard last quit, restoring the active session and grid view. Sessions are resumed, not kept running in the background.</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-restore-sessions" ${restoreSessionsValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">IDE Emulation</span>
            <div class="settings-description">Emulate an IDE so Claude can open files and diffs in a side panel. Disable to use your own IDE instead. Changes take effect for new sessions only.</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-mcp-emulation" ${mcpEmulationValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Claude Code hooks for attention</span>
            <div class="settings-description">More reliable attention detection via Claude Code hooks (catches permission/tool prompts the terminal heuristic can miss). Adds a reversible HTTP hook to <code>~/.claude/settings.json</code>; turning this off removes it. OSC-9 detection still works either way.</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-attention-hooks" ${attentionHooksValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>
      </div>` : ''}

      ${!isProject ? `<div class="settings-section">
        <div class="settings-section-title">Session-Darstellung</div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Einstellungen öffnen als</span>
            <div class="settings-description">Zahnrad-Klick öffnet die Einstellungen als Overlay im Hauptfenster oder als eigenständiges Fenster.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-settings-open-mode">
              <option value="overlay" ${settingsOpenModeValue === 'overlay' ? 'selected' : ''}>Overlay</option>
              <option value="window" ${settingsOpenModeValue === 'window' ? 'selected' : ''}>Eigenes Fenster</option>
            </select>
          </div>
        </div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Darstellungs-Modus</span>
            <div class="settings-description">Legacy = heutiges Verhalten (Sidebar + Grid-Übersicht). Tabs = Tab-Leiste über dem Terminal zum Wechseln zwischen offenen Sessions; das Mosaik bleibt über den Übersicht-Button (oder Shortcut) erreichbar.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-display-mode">
              <option value="legacy" ${displayModeValue === 'legacy' ? 'selected' : ''}>Legacy</option>
              <option value="tabs" ${displayModeValue === 'tabs' ? 'selected' : ''}>Tabs</option>
            </select>
          </div>
        </div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Tab-Position</span>
            <div class="settings-description">Tab-Leiste über oder unter dem Terminal (nur im Tabs-Modus).</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-tab-position">
              <option value="top" ${tabPositionValue === 'top' ? 'selected' : ''}>Oben</option>
              <option value="bottom" ${tabPositionValue === 'bottom' ? 'selected' : ''}>Unten</option>
            </select>
          </div>
        </div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Tab schließen (×)</span>
            <div class="settings-description">Ansicht schließen = Session läuft im Hintergrund weiter, jederzeit wieder öffenbar. Session stoppen = beendet den Prozess.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-tab-close">
              <option value="closeView" ${tabCloseValue === 'closeView' ? 'selected' : ''}>Ansicht schließen</option>
              <option value="stopSession" ${tabCloseValue === 'stopSession' ? 'selected' : ''}>Session stoppen</option>
            </select>
          </div>
        </div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Mittelklick schließt Tab</span>
            <div class="settings-description">Mittlere Maustaste auf einem Tab schließt ihn (folgt der ×-Aktion oben).</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-tab-middle-click" ${tabMiddleClickValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Tabs per Drag umsortieren</span>
            <div class="settings-description">Tabs mit der Maus in eine andere Reihenfolge ziehen. Reihenfolge wird gemerkt.</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-tab-drag" ${tabDragValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>
      </div>` : ''}

      ${!isProject ? `<div class="settings-section">
        <div class="settings-section-title">Keyboard Shortcuts</div>
        ${SHORTCUT_DEFS.map(def => `
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">${escapeHtml(def.label)}</span>
            <div class="settings-description">${escapeHtml(def.description)}</div>
          </div>
          <div class="settings-field-control">
            <button class="settings-shortcut-btn" id="sv-sc-${def.id}" data-sc-id="${def.id}">${escapeHtml(formatBinding(def.id, scIsMac, scShortcuts))}</button>
          </div>
        </div>`).join('')}
        <div class="settings-hint">Click a shortcut, then press the new combination. At least one modifier (${scIsMac ? 'Cmd' : 'Ctrl'}, ${scIsMac ? 'Option' : 'Alt'} or Shift) is required. Press Esc to cancel, or click again to reset to defaults.</div>
      </div>` : ''}

      ${!isProject ? `<div class="settings-section">
        <div class="settings-section-title">Notifications</div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Enable notifications</span>
            <div class="settings-description">Show a native OS notification and dock/taskbar badge when a session needs you while Switchboard is unfocused</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-notify-enabled" ${notifyEnabledValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Notify when a session is ready</span>
            <div class="settings-description">Also notify when an agent finishes and is ready for review, not just when it needs action</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-notify-ready" ${notifyOnReadyValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Alert sound on attention</span>
            <div class="settings-description">Play a short chime when a session needs your attention. Press <code>${escapeHtml(nextAttentionShortcutLabel)}</code> to jump to the next session needing you.</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-attention-sound" ${attentionSoundValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>
      </div>` : ''}

      <div class="settings-btn-row">
        <button class="settings-cancel-btn" id="sv-cancel-btn">Cancel</button>
        <button class="settings-save-btn" id="sv-save-btn">Save Settings</button>
        ${isProject ? '<button class="settings-remove-btn" id="sv-remove-btn">Hide Project</button>' : ''}
      </div>
    </div>
  `;

    // Auto mode is a friendly shortcut for Permission Mode = Accept Edits.
    // Keep the toggle and the dropdown in sync so there's a single underlying
    // `permissionMode` value (the dropdown is what the save logic reads).
    const autoModeToggle = settingsViewerBody.querySelector('#sv-auto-mode');
    const permModeSelect = settingsViewerBody.querySelector('#sv-perm-mode');
    if (autoModeToggle && permModeSelect) {
      autoModeToggle.addEventListener('change', () => {
        if (autoModeToggle.checked) {
          permModeSelect.value = 'acceptEdits';
        } else if (permModeSelect.value === 'acceptEdits') {
          permModeSelect.value = '';
        }
      });
      permModeSelect.addEventListener('change', () => {
        autoModeToggle.checked = permModeSelect.value === 'acceptEdits';
      });
    }

    // Use-global checkboxes toggle field disabled state
    settingsViewerBody.querySelectorAll('.use-global-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const field = cb.dataset.field;
        const fieldMap = {
          permissionMode: 'sv-perm-mode',
          worktree: 'sv-worktree',
          worktreeName: 'sv-worktree-name',
          chrome: 'sv-chrome',
          preLaunchCmd: 'sv-pre-launch',
          addDirs: 'sv-add-dirs',
        };
        const input = settingsViewerBody.querySelector('#' + fieldMap[field]);
        if (input) input.disabled = cb.checked;
        // Auto mode mirrors the permission-mode dropdown, so it follows the
        // same "use global default" enabled/disabled state.
        if (field === 'permissionMode' && autoModeToggle) {
          autoModeToggle.disabled = cb.checked;
        }
      });
    });

    // --- Keyboard shortcut rebinding (global only) ---
    // Capture listeners live on the button element itself (not on document), so
    // they can never leak app-wide: losing focus (incl. the settings viewer being
    // dismissed by ANY path) fires `blur` → stops capture, and re-opening the
    // viewer replaces settingsViewerBody, discarding the old listeners with it.
    let capturingBtn = null;
    function stopShortcutCapture() {
      if (capturingBtn) {
        capturingBtn.classList.remove('capturing');
        capturingBtn.textContent = formatBinding(capturingBtn.dataset.scId, scIsMac, scShortcuts);
        capturingBtn = null;
      }
    }
    settingsViewerBody.querySelectorAll('.settings-shortcut-btn').forEach(btn => {
      const id = btn.dataset.scId;
      const def = SHORTCUT_DEFS.find(d => d.id === id);
      btn.addEventListener('click', () => {
        // Clicking the button that is already capturing resets it to default.
        if (capturingBtn === btn) {
          scShortcuts = { ...scShortcuts, [id]: normalizeShortcuts(null)[id] };
          stopShortcutCapture();
          btn.blur();
          return;
        }
        stopShortcutCapture();
        capturingBtn = btn;
        btn.classList.add('capturing');
        btn.textContent = 'Press keys…';
        btn.focus();
      });
      // keydown only acts while THIS button is the one capturing.
      btn.addEventListener('keydown', (e) => {
        if (capturingBtn !== btn) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') { stopShortcutCapture(); btn.blur(); return; }
        const binding = captureBinding(e, def, scIsMac);
        if (!binding) return; // chord incomplete — keep listening
        scShortcuts = { ...scShortcuts, [id]: binding };
        stopShortcutCapture();
        btn.blur();
      });
      // Losing focus (click elsewhere, panel dismissed, tab switch) cancels capture.
      btn.addEventListener('blur', () => {
        if (capturingBtn === btn) stopShortcutCapture();
      });
    });

    // Save button
    settingsViewerBody.querySelector('#sv-save-btn').addEventListener('click', async () => {
      let settings = {};

      if (isProject) {
        // Only save fields where "use global" is unchecked
        settingsViewerBody.querySelectorAll('.use-global-cb').forEach(cb => {
          if (!cb.checked) {
            const field = cb.dataset.field;
            const fieldMap = {
              permissionMode: () => settingsViewerBody.querySelector('#sv-perm-mode').value || null,
              worktree: () => settingsViewerBody.querySelector('#sv-worktree').checked,
              worktreeName: () => settingsViewerBody.querySelector('#sv-worktree-name').value.trim(),
              chrome: () => settingsViewerBody.querySelector('#sv-chrome').checked,
              preLaunchCmd: () => settingsViewerBody.querySelector('#sv-pre-launch').value.trim(),
              addDirs: () => settingsViewerBody.querySelector('#sv-add-dirs').value.trim(),
            };
            if (fieldMap[field]) settings[field] = fieldMap[field]();
          }
        });
      } else {
        settings.permissionMode = settingsViewerBody.querySelector('#sv-perm-mode').value || null;
        settings.worktree = settingsViewerBody.querySelector('#sv-worktree').checked;
        settings.worktreeName = settingsViewerBody.querySelector('#sv-worktree-name').value.trim();
        settings.chrome = settingsViewerBody.querySelector('#sv-chrome').checked;
        settings.preLaunchCmd = settingsViewerBody.querySelector('#sv-pre-launch').value.trim();
        settings.addDirs = settingsViewerBody.querySelector('#sv-add-dirs').value.trim();
        settings.visibleSessionCount = parseInt(settingsViewerBody.querySelector('#sv-visible-count').value) || 10;
        settings.sessionMaxAgeDays = parseInt(settingsViewerBody.querySelector('#sv-max-age').value) || 3;
        settings.terminalTheme = settingsViewerBody.querySelector('#sv-terminal-theme').value || 'switchboard';
        settings.terminalRightClick = settingsViewerBody.querySelector('#sv-right-click').value || 'menu';
        settings.terminalMouseReporting = settingsViewerBody.querySelector('#sv-mouse-reporting').checked ? 'on' : 'off';
        settings.settingsOpenMode = settingsViewerBody.querySelector('#sv-settings-open-mode').value || 'overlay';
        settings.sessionDisplayMode = settingsViewerBody.querySelector('#sv-display-mode').value || 'legacy';
        settings.tabPosition = settingsViewerBody.querySelector('#sv-tab-position').value || 'top';
        settings.tabCloseBehavior = settingsViewerBody.querySelector('#sv-tab-close').value || 'closeView';
        settings.tabMiddleClickCloses = settingsViewerBody.querySelector('#sv-tab-middle-click').checked;
        settings.tabDragReorder = settingsViewerBody.querySelector('#sv-tab-drag').checked;
        settings.mcpEmulation = settingsViewerBody.querySelector('#sv-mcp-emulation').checked;
        settings.restoreSessionsOnLaunch = settingsViewerBody.querySelector('#sv-restore-sessions').checked;
        settings.attentionHooks = settingsViewerBody.querySelector('#sv-attention-hooks').checked;
        settings.shellProfile = settingsViewerBody.querySelector('#sv-shell-profile').value || 'auto';
        settings.notifications = {
          ...(current.notifications || {}),
          enabled: settingsViewerBody.querySelector('#sv-notify-enabled').checked,
          notifyOnReady: settingsViewerBody.querySelector('#sv-notify-ready').checked,
          sound: settingsViewerBody.querySelector('#sv-attention-sound').checked,
        };
        // Merge over existing shortcuts so non-managed keys (e.g. <old-codename>'s
        // nextAttention) survive — scShortcuts carries only the session-nav/grid bindings.
        settings.shortcuts = { ...(current.shortcuts || {}), ...scShortcuts };
      }
      stopShortcutCapture();

      // Merge form values into existing settings to preserve keys not managed by the form
      if (!isProject) {
        const existing = (await window.api.getSetting('global')) || {};
        settings = { ...existing, ...settings };
      }

      await window.api.setSetting(settingsKey, settings);

      // Standalone settings window: tell the main window to re-apply the changes
      // (it owns the live UI). The in-app overlay applies directly below instead.
      if (window.__SETTINGS_WINDOW__ && !isProject && typeof window.api.notifySettingsChanged === 'function') {
        window.api.notifySettingsChanged();
      }

      // Update visibleSessionCount, sessionMaxAgeDays, and theme
      if (!isProject) {
        if (settings.visibleSessionCount && typeof window._setVisibleSessionCount === 'function') {
          window._setVisibleSessionCount(settings.visibleSessionCount);
        }
        if (settings.sessionMaxAgeDays && typeof window._setSessionMaxAge === 'function') {
          window._setSessionMaxAge(settings.sessionMaxAgeDays);
        }
        if (settings.terminalTheme && typeof window._applyTerminalTheme === 'function') {
          window._applyTerminalTheme(settings.terminalTheme);
        }
        if (settings.notifications && typeof window._setNotificationSettings === 'function') {
          window._setNotificationSettings(settings.notifications);
        }
        if (typeof window._applyNotificationSettings === 'function') {
          window._applyNotificationSettings(settings);
        }
        if (typeof window._applySessionDisplaySettings === 'function') {
          window._applySessionDisplaySettings(settings);
        }
        if (settings.terminalRightClick && typeof window._applyTerminalRightClick === 'function') {
          window._applyTerminalRightClick(settings.terminalRightClick);
        }
        if (settings.terminalMouseReporting && typeof window._applyTerminalMouseReporting === 'function') {
          window._applyTerminalMouseReporting(settings.terminalMouseReporting);
        }
        if (settings.shortcuts && typeof window._applyShortcuts === 'function') {
          window._applyShortcuts(settings.shortcuts);
        }
        if (typeof refreshSidebar === 'function') refreshSidebar();
      }

      // Write/remove the reversible ~/.claude hook when the toggle changes
      if (!isProject && settings.attentionHooks !== attentionHooksValue) {
        try { await window.api.configureAttentionHook(settings.attentionHooks); } catch {}
      }

      // Notify if IDE Emulation changed
      if (!isProject && settings.mcpEmulation !== mcpEmulationValue) {
        const notice = document.createElement('div');
        notice.className = 'settings-notice';
        notice.textContent = 'IDE Emulation setting changed. New sessions will use the updated setting \u2014 running sessions are not affected.';
        const saveBtn = settingsViewerBody.querySelector('#sv-save-btn');
        saveBtn.parentElement.insertBefore(notice, saveBtn);
        setTimeout(() => notice.remove(), 8000);
      }

      const saveBtn = settingsViewerBody.querySelector('#sv-save-btn');
      saveBtn.textContent = '✓ Saved';
      saveBtn.style.background = '#2ea043';
      saveBtn.style.color = '#fff';
      setTimeout(() => closeSettingsViewer(), 600);
    });

    // Cancel button
    settingsViewerBody.querySelector('#sv-cancel-btn').addEventListener('click', () => {
      stopShortcutCapture();
      closeSettingsViewer();
    });

    // Remove project button
    const removeBtn = settingsViewerBody.querySelector('#sv-remove-btn');
    if (removeBtn) {
      removeBtn.addEventListener('click', async () => {
        const confirmed = await showControlDialog({
          title: 'Hide Project',
          message: 'This hides the project from Switchboard. Your session files are not deleted.',
          confirmLabel: 'Hide Project',
          tone: 'warning',
          details: {
            Project: shortName,
            Path: projectPath,
          },
        });
        if (!confirmed) return;
        await window.api.removeProject(projectPath);
        settingsViewer.style.display = 'none';
        document.getElementById('placeholder').style.display = 'flex';
        if (typeof loadProjects === 'function') loadProjects();
      });
    }
  }

  // Expose globally
  window.openSettingsViewer = openSettingsViewer;
  window.closeSettingsViewer = closeSettingsViewer;
})();
