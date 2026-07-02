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

    const titleName = isProject && typeof current.displayName === 'string' && current.displayName.trim()
      ? current.displayName.trim()
      : shortName;
    settingsViewerTitle.textContent = (isProject ? 'Project Settings — ' : 'Global Settings — ') + titleName;

    // Show settings viewer, hide others. Null-safe: the standalone settings
    // window (settings.html) has none of these main-app elements.
    ['placeholder', 'terminal-area', 'plan-viewer', 'stats-viewer', 'memory-viewer', 'jsonl-viewer'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
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

    const displayNameValue = isProject && typeof current.displayName === 'string' ? current.displayName : '';
    const permModeValue = fieldValue('permissionMode', '');
    const worktreeValue = fieldValue('worktree', false);
    const worktreeNameValue = fieldValue('worktreeName', '');
    const chromeValue = fieldValue('chrome', false);
    const preLaunchValue = fieldValue('preLaunchCmd', '');
    const addDirsValue = fieldValue('addDirs', '');
    const visCountValue = fieldValue('visibleSessionCount', 10);
    const maxAgeValue = fieldValue('sessionMaxAgeDays', 3);
    const usage5hWarnValue = fieldValue('usage5hWarn', 60);
    const usage5hCritValue = fieldValue('usage5hCrit', 80);
    const usage7dWarnValue = fieldValue('usage7dWarn', 75);
    const usage7dCritValue = fieldValue('usage7dCrit', 90);
    const themeValue = fieldValue('terminalTheme', 'switchboard');
    // Terminal font (size + family). Family presets carry a monospace fallback;
    // a value not in the list is treated as a custom family.
    const DEFAULT_TERMINAL_FONT = "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace";
    const TERMINAL_FONT_PRESETS = [
      { label: 'Default (SF Mono / Fira / Cascadia)', value: DEFAULT_TERMINAL_FONT },
      { label: 'Cascadia Code', value: "'Cascadia Code', 'Cascadia Mono', monospace" },
      { label: 'Consolas', value: 'Consolas, monospace' },
      { label: 'Fira Code', value: "'Fira Code', monospace" },
      { label: 'JetBrains Mono', value: "'JetBrains Mono', monospace" },
      { label: 'Source Code Pro', value: "'Source Code Pro', monospace" },
      { label: 'Menlo / SF Mono', value: "'SF Mono', Menlo, monospace" },
    ];
    const terminalFontSizeValue = fieldValue('terminalFontSize', 12);
    const terminalFontFamilyValue = fieldValue('terminalFontFamily', DEFAULT_TERMINAL_FONT);
    const terminalFontIsPreset = TERMINAL_FONT_PRESETS.some(f => f.value === terminalFontFamilyValue);
    const terminalFontSelectValue = terminalFontIsPreset ? terminalFontFamilyValue : 'custom';
    const terminalFontCustomValue = terminalFontIsPreset ? '' : terminalFontFamilyValue;
    const rightClickValue = fieldValue('terminalRightClick', 'menu');
    const mouseReportingValue = fieldValue('terminalMouseReporting', 'on');
    const terminalWebglValue = fieldValue('terminalWebgl', false);
    const terminalCloseValue = fieldValue('terminalCloseBehavior', 'kill');
    const displayModeValue = fieldValue('sessionDisplayMode', 'grid');
    const settingsOpenModeValue = fieldValue('settingsOpenMode', 'overlay');
    const collapseDefaultValue = fieldValue('sidebarCollapseDefault', 'remember');
    const tabPositionValue = fieldValue('tabPosition', 'top');
    const tabCloseValue = fieldValue('tabCloseBehavior', 'closeView');
    const tabMiddleClickValue = fieldValue('tabMiddleClickCloses', true);
    const tabDragValue = fieldValue('tabDragReorder', true);
    const tabAutoCloseModeValue = fieldValue('tabAutoCloseMode', 'always');
    const tabAutoCloseDelayValue = fieldValue('tabAutoCloseDelaySec', 5);
    const tabsLiveRenderValue = fieldValue('tabsLiveRender', true);
    const mcpEmulationValue = fieldValue('mcpEmulation', true);
    const restoreSessionsValue = fieldValue('restoreSessionsOnLaunch', true);
    const attentionHooksValue = fieldValue('attentionHooks', false);
    const shellProfileValue = fieldValue('shellProfile', 'auto');
    // #17 project list (global only): sort mode + favorites presentation.
    const projectSortValue = !isProject ? (current.projectSortMode || 'activity') : 'activity';
    const favoritesOwnListValue = !isProject ? !!current.favoritesOwnList : false;
    // Handoff library (global only): toggle + editable request prompt.
    const defaultHandoffPrompt = (typeof window !== 'undefined' && window.DEFAULT_HANDOFF_PROMPT) || '';
    const handoffLibraryValue = !isProject ? !!current.handoffLibrary : false;
    const handoffPromptValue = !isProject
      ? ((typeof current.handoffPrompt === 'string' && current.handoffPrompt.length) ? current.handoffPrompt : defaultHandoffPrompt)
      : '';
    // Notifications (global only) — alert sound on attention + read-only hotkey hint.
    const attentionSoundValue = !!((current.notifications || {}).sound);
    const isMacPlatform = !!(window.api && window.api.platform === 'darwin');
    const nextAttentionShortcutLabel = isMacPlatform ? '\u2318\u21e7A' : 'Ctrl+Shift+A';

    // Notifications live in the global blob under `notifications`.
    const notificationsValue = (!isProject && current.notifications) || {};
    const notifyEnabledValue = notificationsValue.enabled !== false; // default on
    const notifyOnReadyValue = !!notificationsValue.notifyOnReady; // default off

    // Running-in-inbox (global only): how live-but-idle sessions appear in the attention inbox.
    const runningInboxValue = (!isProject && current.runningInbox) || {};
    const runningInboxModeValue = ['always', 'never', 'after-finish', 'until-read', 'timed'].includes(runningInboxValue.mode)
      ? runningInboxValue.mode : 'until-read';
    const runningInboxMinutesValue = runningInboxValue.minutes > 0 ? runningInboxValue.minutes : 5;

    // Working copy of the (global-only) re-bindable keyboard shortcuts.
    let scShortcuts = normalizeShortcuts(isProject ? null : current.shortcuts);
    const scIsMac = typeof isMac !== 'undefined' ? isMac : /Mac|iPhone|iPad/.test(navigator.platform);

    // Discover available shell profiles
    let shellProfiles = [];
    try { shellProfiles = await window.api.getShellProfiles(); } catch {};

    settingsViewerBody.innerHTML = `
    <div class="settings-form">
      ${isProject ? `
      <div class="settings-section">
        <div class="settings-section-title">Project</div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Display name</span>
            <div class="settings-description">Shown instead of the folder name in the sidebar. Leave empty to use the directory (<code>${escapeHtml(shortName)}</code>).</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-display-name" placeholder="${escapeHtml(shortName)}" value="${escapeHtml(displayNameValue)}">
          </div>
        </div>
      </div>` : ''}
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
            <span class="settings-label">Terminal Font</span>
            <div class="settings-description">Font family for terminal sessions. Use a monospace font &mdash; proportional fonts break column alignment. The font must be installed; an unknown name falls back silently. Pick <b>Custom</b> to enter your own family. Also adjustable live with ${isMacPlatform ? '⌘' : 'Ctrl'} + / - / 0.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-terminal-font-family">
              ${TERMINAL_FONT_PRESETS.map(f =>
                `<option value="${escapeHtml(f.value)}" ${terminalFontSelectValue === f.value ? 'selected' : ''}>${escapeHtml(f.label)}</option>`
              ).join('')}
              <option value="custom" ${terminalFontSelectValue === 'custom' ? 'selected' : ''}>Custom&hellip;</option>
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Custom font family</span>
            <div class="settings-description">Used only when <b>Custom</b> is selected above, e.g. <code>'IBM Plex Mono', monospace</code>.</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-terminal-font-custom" placeholder="${escapeHtml(DEFAULT_TERMINAL_FONT)}" value="${escapeHtml(terminalFontCustomValue)}">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Terminal Font Size</span>
            <div class="settings-description">Font size in pixels for terminal sessions (8&ndash;28).</div>
          </div>
          <div class="settings-field-control">
            <input type="number" class="settings-input settings-input-compact" id="sv-terminal-font-size" min="8" max="28" value="${terminalFontSizeValue}">
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
            <span class="settings-label">GPU rendering (WebGL)</span>
            <div class="settings-description">Render terminals with the GPU (WebGL) instead of the default DOM renderer. Faster for heavy full-screen output, but the terminal text may briefly flicker/"staircase" when switching tabs or resizing, and only ~16 terminals can hold a GPU context at once. Leave off unless you have very output-heavy sessions.</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-terminal-webgl" ${terminalWebglValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Terminal close behavior</span>
            <div class="settings-description">What closing a plain terminal tab does — independent of the Claude session close behavior. Kill on close = end the shell process. Keep running = close the view only; the shell keeps running and can be reopened.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-terminal-close-behavior">
              <option value="kill" ${terminalCloseValue !== 'keep' ? 'selected' : ''}>Kill on close</option>
              <option value="keep" ${terminalCloseValue === 'keep' ? 'selected' : ''}>Keep running</option>
            </select>
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
            <span class="settings-label">Usage colours — 5h (%)</span>
            <div class="settings-description">The 5-hour usage bar turns green below the first value, orange from there, and red at or above the second. Defaults 60 / 80.</div>
          </div>
          <div class="settings-field-control">
            <input type="number" class="settings-input settings-input-compact" id="sv-usage-5h-warn" min="1" max="99" value="${usage5hWarnValue}" title="Orange from this %">
            <input type="number" class="settings-input settings-input-compact" id="sv-usage-5h-crit" min="2" max="100" value="${usage5hCritValue}" title="Red at/above this %">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Usage colours — 7d (%)</span>
            <div class="settings-description">Thresholds for the 7-day usage bar (and the Quota bar). Same green / orange / red scale. Defaults 75 / 90.</div>
          </div>
          <div class="settings-field-control">
            <input type="number" class="settings-input settings-input-compact" id="sv-usage-7d-warn" min="1" max="99" value="${usage7dWarnValue}" title="Orange from this %">
            <input type="number" class="settings-input settings-input-compact" id="sv-usage-7d-crit" min="2" max="100" value="${usage7dCritValue}" title="Red at/above this %">
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
        <div class="settings-section-title">Session Display</div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Sidebar on startup</span>
            <div class="settings-description">Collapse state of project/group sections when the app starts: all expanded, all collapsed, or remember the last state.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-collapse-default">
              <option value="expanded" ${collapseDefaultValue === 'expanded' ? 'selected' : ''}>All expanded</option>
              <option value="collapsed" ${collapseDefaultValue === 'collapsed' ? 'selected' : ''}>All collapsed</option>
              <option value="remember" ${collapseDefaultValue === 'remember' ? 'selected' : ''}>Last state</option>
            </select>
          </div>
        </div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Open settings as</span>
            <div class="settings-description">Clicking the gear opens settings as an overlay in the main window or as a separate window.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-settings-open-mode">
              <option value="overlay" ${settingsOpenModeValue === 'overlay' ? 'selected' : ''}>Overlay</option>
              <option value="window" ${settingsOpenModeValue === 'window' ? 'selected' : ''}>Separate window</option>
            </select>
          </div>
        </div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Display mode</span>
            <div class="settings-description">Grid = default behavior (sidebar + grid overview / single view). Tabs = a tab bar above the terminal to switch between open sessions; the grid mosaic stays reachable via the overview button.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-display-mode">
              <option value="grid" ${displayModeValue !== 'tabs' ? 'selected' : ''}>Grid</option>
              <option value="tabs" ${displayModeValue === 'tabs' ? 'selected' : ''}>Tabs</option>
            </select>
          </div>
        </div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Tab position</span>
            <div class="settings-description">Tab bar above or below the terminal (tabs mode only).</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-tab-position">
              <option value="top" ${tabPositionValue === 'top' ? 'selected' : ''}>Top</option>
              <option value="bottom" ${tabPositionValue === 'bottom' ? 'selected' : ''}>Bottom</option>
            </select>
          </div>
        </div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Close tab (×)</span>
            <div class="settings-description">Close view = the session keeps running in the background, reopenable any time. Stop session = ends the process.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-tab-close">
              <option value="closeView" ${tabCloseValue === 'closeView' ? 'selected' : ''}>Close view</option>
              <option value="stopSession" ${tabCloseValue === 'stopSession' ? 'selected' : ''}>Stop session</option>
            </select>
          </div>
        </div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Middle-click closes tab</span>
            <div class="settings-description">Middle mouse button on a tab closes it (follows the × action above).</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-tab-middle-click" ${tabMiddleClickValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Reorder tabs by drag</span>
            <div class="settings-description">Drag tabs into a different order with the mouse. The order is remembered.</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-tab-drag" ${tabDragValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Auto-close tab after exit</span>
            <div class="settings-description">When a session's process exits, close its tab automatically. Never = keep it open (re-click to relaunch, or click another tab). On success and error = close after any exit. On success only = keep failed sessions (non-zero exit) open so you can read the error.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-tab-autoclose-mode">
              <option value="never" ${tabAutoCloseModeValue === 'never' ? 'selected' : ''}>Never</option>
              <option value="onSuccess" ${tabAutoCloseModeValue === 'onSuccess' ? 'selected' : ''}>On success only</option>
              <option value="always" ${tabAutoCloseModeValue === 'always' ? 'selected' : ''}>On success and error</option>
            </select>
          </div>
        </div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Auto-close delay (seconds)</span>
            <div class="settings-description">How long the exit banner stays before the tab closes. 0 = close immediately. Ignored when auto-close is Never.</div>
          </div>
          <div class="settings-field-control">
            <input type="number" class="settings-input settings-input-compact" id="sv-tab-autoclose-delay" min="0" max="120" value="${tabAutoCloseDelayValue}">
          </div>
        </div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Live-render background tabs</span>
            <div class="settings-description">Render terminal output in background tabs immediately instead of buffering it until you switch. Removes the flicker when returning to a tab that produced output, at some CPU/GPU cost for busy background sessions. Off = buffer and replay on switch.</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-tabs-live-render" ${tabsLiveRenderValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>
      </div>` : ''}

      ${!isProject ? `<div class="settings-section">
        <div class="settings-section-title">Project list</div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Project sorting</span>
            <div class="settings-description">Order of projects in the sidebar. Manual lets you drag projects into place (a grip handle appears on each project header).</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-project-sort">
              <option value="activity" ${projectSortValue === 'activity' ? 'selected' : ''}>Activity (most recent first)</option>
              <option value="alpha" ${projectSortValue === 'alpha' ? 'selected' : ''}>Alphabetical</option>
              <option value="manual" ${projectSortValue === 'manual' ? 'selected' : ''}>Manual (drag to reorder)</option>
            </select>
          </div>
        </div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Favorites as separate list</span>
            <div class="settings-description">On: favorites are not shown in the main list — only via the star filter in the toolbar. Off: favorites are pinned on top of the list (with a divider) and the star filter is hidden.</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-favorites-own-list" ${favoritesOwnListValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>
      </div>` : ''}

      ${!isProject ? `<div class="settings-section">
        <div class="settings-section-title">Handoff</div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Integrated Handoff System</span>
            <div class="settings-description">When on, a handoff can be saved to the project (instead of starting a fresh session right away) and later resumed from the new-session menu ("Claude Handoff resume"). The guided flow needs a running session.</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-handoff-library" ${handoffLibraryValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Handoff prompt</span>
            <div class="settings-description">Sent to the running agent to produce the handoff. Use placeholders {goal} {project} {sessionId} {metrics}. Set it to a skill command like <code>/handoff</code> to run a skill instead. Clear the field to restore the default.</div>
          </div>
          <div class="settings-field-control">
            <textarea class="settings-input" id="sv-handoff-prompt" spellcheck="false" style="width:100%;min-height:200px;font-family:monospace;font-size:12px;line-height:1.5;resize:vertical;box-sizing:border-box;">${escapeHtml(handoffPromptValue)}</textarea>
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

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Running sessions in attention inbox</span>
            <div class="settings-description">When a live session is idle (not working, not awaiting you), whether it shows in the attention list. <b>Until opened</b>: stays until you open it. <b>Until opened, or after a few minutes</b>: whichever comes first. <b>For a few minutes (even after opening)</b>: stays the full time below regardless of opening it. <b>Always</b>/<b>Never</b>: unconditional. Sessions that never ran are never shown.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-running-inbox-mode">
              <option value="until-read" ${runningInboxModeValue === 'until-read' ? 'selected' : ''}>Until opened</option>
              <option value="after-finish" ${runningInboxModeValue === 'after-finish' ? 'selected' : ''}>Until opened, or after a few minutes</option>
              <option value="timed" ${runningInboxModeValue === 'timed' ? 'selected' : ''}>For a few minutes (even after opening)</option>
              <option value="always" ${runningInboxModeValue === 'always' ? 'selected' : ''}>Always</option>
              <option value="never" ${runningInboxModeValue === 'never' ? 'selected' : ''}>Never</option>
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Keep finished sessions for</span>
            <div class="settings-description">Minutes a finished session stays in the inbox &mdash; used only by &ldquo;For a few minutes after finishing&rdquo;.</div>
          </div>
          <div class="settings-field-control">
            <input type="number" class="settings-input settings-input-compact" id="sv-running-inbox-minutes" min="1" max="120" value="${runningInboxMinutesValue}">
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
        // Project-only field (no "use global"): custom display name, '' = use directory.
        const dnInput = settingsViewerBody.querySelector('#sv-display-name');
        if (dnInput) settings.displayName = dnInput.value.trim();
      } else {
        settings.permissionMode = settingsViewerBody.querySelector('#sv-perm-mode').value || null;
        settings.worktree = settingsViewerBody.querySelector('#sv-worktree').checked;
        settings.worktreeName = settingsViewerBody.querySelector('#sv-worktree-name').value.trim();
        settings.chrome = settingsViewerBody.querySelector('#sv-chrome').checked;
        settings.preLaunchCmd = settingsViewerBody.querySelector('#sv-pre-launch').value.trim();
        settings.addDirs = settingsViewerBody.querySelector('#sv-add-dirs').value.trim();
        settings.visibleSessionCount = parseInt(settingsViewerBody.querySelector('#sv-visible-count').value) || 10;
        settings.sessionMaxAgeDays = parseInt(settingsViewerBody.querySelector('#sv-max-age').value) || 3;
        {
          const clampPair = (warnSel, critSel, dWarn, dCrit) => {
            const warn = Math.max(1, Math.min(99, parseInt(settingsViewerBody.querySelector(warnSel).value, 10) || dWarn));
            const crit = Math.max(warn + 1, Math.min(100, parseInt(settingsViewerBody.querySelector(critSel).value, 10) || dCrit));
            return { warn, crit };
          };
          const five = clampPair('#sv-usage-5h-warn', '#sv-usage-5h-crit', 60, 80);
          const seven = clampPair('#sv-usage-7d-warn', '#sv-usage-7d-crit', 75, 90);
          settings.usage5hWarn = five.warn;
          settings.usage5hCrit = five.crit;
          settings.usage7dWarn = seven.warn;
          settings.usage7dCrit = seven.crit;
        }
        settings.terminalTheme = settingsViewerBody.querySelector('#sv-terminal-theme').value || 'switchboard';
        {
          const famSel = settingsViewerBody.querySelector('#sv-terminal-font-family').value;
          const famCustom = settingsViewerBody.querySelector('#sv-terminal-font-custom').value.trim();
          settings.terminalFontFamily = famSel === 'custom' ? (famCustom || DEFAULT_TERMINAL_FONT) : famSel;
          const size = parseInt(settingsViewerBody.querySelector('#sv-terminal-font-size').value, 10);
          settings.terminalFontSize = Math.max(8, Math.min(28, Number.isFinite(size) ? size : 12));
        }
        settings.terminalRightClick = settingsViewerBody.querySelector('#sv-right-click').value || 'menu';
        settings.terminalMouseReporting = settingsViewerBody.querySelector('#sv-mouse-reporting').checked ? 'on' : 'off';
        settings.terminalWebgl = settingsViewerBody.querySelector('#sv-terminal-webgl').checked;
        settings.terminalCloseBehavior = settingsViewerBody.querySelector('#sv-terminal-close-behavior').value || 'kill';
        settings.settingsOpenMode = settingsViewerBody.querySelector('#sv-settings-open-mode').value || 'overlay';
        settings.sidebarCollapseDefault = settingsViewerBody.querySelector('#sv-collapse-default').value || 'remember';
        settings.sessionDisplayMode = settingsViewerBody.querySelector('#sv-display-mode').value || 'grid';
        settings.projectSortMode = settingsViewerBody.querySelector('#sv-project-sort')?.value || 'activity';
        settings.favoritesOwnList = !!settingsViewerBody.querySelector('#sv-favorites-own-list')?.checked;
        settings.handoffLibrary = !!settingsViewerBody.querySelector('#sv-handoff-library')?.checked;
        {
          const hp = settingsViewerBody.querySelector('#sv-handoff-prompt')?.value || '';
          // Empty or unchanged-from-default ⇒ store '' so the runtime default is used (no lock).
          settings.handoffPrompt = (hp.trim() && hp.trim() !== defaultHandoffPrompt.trim()) ? hp : '';
        }
        settings.tabPosition = settingsViewerBody.querySelector('#sv-tab-position').value || 'top';
        settings.tabCloseBehavior = settingsViewerBody.querySelector('#sv-tab-close').value || 'closeView';
        settings.tabMiddleClickCloses = settingsViewerBody.querySelector('#sv-tab-middle-click').checked;
        settings.tabDragReorder = settingsViewerBody.querySelector('#sv-tab-drag').checked;
        settings.tabAutoCloseMode = settingsViewerBody.querySelector('#sv-tab-autoclose-mode').value || 'always';
        {
          const d = parseInt(settingsViewerBody.querySelector('#sv-tab-autoclose-delay').value, 10);
          settings.tabAutoCloseDelaySec = Math.max(0, Math.min(120, Number.isFinite(d) ? d : 5));
        }
        settings.tabsLiveRender = settingsViewerBody.querySelector('#sv-tabs-live-render').checked;
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
        settings.runningInbox = {
          mode: settingsViewerBody.querySelector('#sv-running-inbox-mode')?.value || 'until-read',
          minutes: Math.max(1, Math.min(120, parseInt(settingsViewerBody.querySelector('#sv-running-inbox-minutes')?.value, 10) || 5)),
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
        if (settings.terminalFontFamily && typeof window._setTerminalFontFamily === 'function') {
          window._setTerminalFontFamily(settings.terminalFontFamily);
        }
        if (settings.terminalFontSize && typeof window._setTerminalFontSize === 'function') {
          window._setTerminalFontSize(settings.terminalFontSize);
        }
        if (settings.notifications && typeof window._setNotificationSettings === 'function') {
          window._setNotificationSettings(settings.notifications);
        }
        if (settings.runningInbox && typeof window._setRunningInboxSetting === 'function') {
          window._setRunningInboxSetting(settings.runningInbox);
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
        if (typeof window._setTerminalWebgl === 'function') {
          window._setTerminalWebgl(settings.terminalWebgl === true);
        }
        if (typeof window._setUsageThresholds === 'function') {
          window._setUsageThresholds({ fiveHWarn: settings.usage5hWarn, fiveHCrit: settings.usage5hCrit, sevenDWarn: settings.usage7dWarn, sevenDCrit: settings.usage7dCrit });
        }
        if (settings.shortcuts && typeof window._applyShortcuts === 'function') {
          window._applyShortcuts(settings.shortcuts);
        }
        // #17: apply project sort mode + favorites presentation from the saved blob.
        if (typeof window._applyProjectSortSettings === 'function') {
          window._applyProjectSortSettings(settings);
        }
        if (typeof refreshSidebar === 'function') refreshSidebar();
      }

      // Project scope: reload projects so a changed display name is re-derived
      // (buildProjectsFromCache reads the per-project settings blob main-side).
      if (isProject && typeof loadProjects === 'function') loadProjects();

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
