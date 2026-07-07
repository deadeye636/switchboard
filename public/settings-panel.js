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
    const dangerousSkipValue = fieldValue('dangerouslySkipPermissions', false);
    const worktreeValue = fieldValue('worktree', false);
    const worktreeNameValue = fieldValue('worktreeName', '');
    const chromeValue = fieldValue('chrome', false);
    const preLaunchValue = fieldValue('preLaunchCmd', '');
    const addDirsValue = fieldValue('addDirs', '');
    const afkTimeoutValue = fieldValue('afkTimeoutSec', '');
    // Normalize an AFK-timeout input into stored form ('' | non-negative int).
    // 0 is kept (means off / never); empty / negative / non-numeric → '' (inherit).
    const normalizeAfk = (raw) => {
      const s = String(raw == null ? '' : raw).trim();
      if (s === '') return '';
      const n = Number(s);
      return (Number.isFinite(n) && n >= 0) ? String(Math.floor(n)) : '';
    };
    const visCountValue = fieldValue('visibleSessionCount', 10);
    const maxAgeValue = fieldValue('sessionMaxAgeDays', 3);
    const autoHideDaysValue = fieldValue('autoHideDays', 0);
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
    const mouseReportingRaw = fieldValue('terminalMouseReporting', 'select');
    const mouseModeValue = mouseReportingRaw === 'on' ? 'native' : mouseReportingRaw; // legacy 'on' → native
    const externalEditorValue = fieldValue('externalEditorCommand', '');
    const terminalWebglValue = fieldValue('terminalWebgl', true); // default on (#81)
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
    const secretRefCleanupValue = fieldValue('secretRefCleanupOnSessionStop', true);
    const secretRefSweepValue = fieldValue('secretRefSweepMinutes', 0);
    const shellProfileValue = fieldValue('shellProfile', 'auto');
    // #17 project list (global only): sort mode + favorites presentation.
    const projectSortValue = !isProject ? (current.projectSortMode || 'activity') : 'activity';
    const favoritesOwnListValue = !isProject ? !!current.favoritesOwnList : false;
    const projectAutoAddValue = !isProject ? (current.projectAutoAdd !== false) : true;
    // Handoff library (global only): toggle + editable request prompt.
    const defaultHandoffPrompt = (typeof window !== 'undefined' && window.DEFAULT_HANDOFF_PROMPT) || '';
    const handoffLibraryValue = !isProject ? !!current.handoffLibrary : false;
    const handoffPromptValue = !isProject
      ? ((typeof current.handoffPrompt === 'string' && current.handoffPrompt.length) ? current.handoffPrompt : defaultHandoffPrompt)
      : '';
    // Notifications (global only) — alert sound on attention + read-only hotkey hint.
    const attentionSoundValue = !!((current.notifications || {}).sound);
    const isMacPlatform = !!(window.api && window.api.platform === 'darwin');
    const nextAttentionShortcutLabel = isMacPlatform ? '⌘⇧A' : 'Ctrl+Shift+A';

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

    // Shared button row (both scopes).
    const btnRow = `
      <div class="settings-btn-row">
        <button class="settings-cancel-btn" id="sv-cancel-btn">Cancel</button>
        <button class="settings-save-btn" id="sv-save-btn">Save Settings</button>
        ${isProject ? '<button class="settings-remove-btn" id="sv-remove-btn">Hide Project</button>' : ''}
      </div>`;

    // Small building blocks for the global two-pane layout.
    const help = `<button type="button" class="settings-help" aria-expanded="false" aria-label="More info">?</button>`;
    const advChev = `<svg class="settings-adv-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 6l6 6-6 6"/></svg>`;

    if (isProject) {
      // ---- Project scope: single-column form (unchanged behaviour) ----
      settingsViewerBody.classList.remove('sv-two-pane');
      settingsViewerBody.innerHTML = `
      <div class="settings-form">
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
        </div>
        <div class="settings-section">
          <div class="settings-section-title">Claude CLI Options</div>

          <div class="settings-field">
            <div class="settings-field-info">
              <div class="settings-field-header">
                <span class="settings-label">Permission Mode</span>
                ${useGlobalCheckbox('permissionMode')}
              </div>
              <div class="settings-description">Permission mode passed to the <code>claude</code> command.</div>
            </div>
            <div class="settings-field-control">
              <select class="settings-select" id="sv-perm-mode" ${fieldDisabled('permissionMode')}>
                <option value="">Default — ask each time</option>
                <option value="acceptEdits" ${permModeValue === 'acceptEdits' ? 'selected' : ''}>Accept Edits — auto file edits</option>
                <option value="plan" ${permModeValue === 'plan' ? 'selected' : ''}>Plan — read-only</option>
                <option value="auto" ${permModeValue === 'auto' ? 'selected' : ''}>Auto — auto-approve (preview)</option>
                <option value="dontAsk" ${permModeValue === 'dontAsk' ? 'selected' : ''}>Don't Ask — auto-deny unless allowed</option>
                <option value="bypassPermissions" ${permModeValue === 'bypassPermissions' ? 'selected' : ''}>Bypass — skip all prompts</option>
              </select>
            </div>
          </div>

          <div class="settings-field">
            <div class="settings-field-info">
              <div class="settings-field-header">
                <span class="settings-label">Dangerous Skip</span>
                ${useGlobalCheckbox('dangerouslySkipPermissions')}
              </div>
              <div class="settings-description">Start every new session with <code>--dangerously-skip-permissions</code> — skips all permission prompts (same effect as Bypass) and overrides Permission Mode. Use with extreme caution.</div>
            </div>
            <div class="settings-field-control">
              <label class="settings-toggle"><input type="checkbox" id="sv-dangerous-skip" ${dangerousSkipValue ? 'checked' : ''} ${fieldDisabled('dangerouslySkipPermissions')}><span class="settings-toggle-slider"></span></label>
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

          <div class="settings-field settings-field-wide">
            <div class="settings-field-info">
              <div class="settings-field-header">
                <span class="settings-label">AskUserQuestion timeout (seconds)</span>
                ${useGlobalCheckbox('afkTimeoutSec')}
              </div>
              <div class="settings-description">Seconds before Claude auto-continues an unanswered AskUserQuestion. Empty = Claude default (60). <code>0</code> = never auto-continue. Applies only to Switchboard-started sessions.</div>
            </div>
            <div class="settings-field-control">
              <input type="text" class="settings-input" id="sv-afk-timeout" placeholder="inherit / default (60)" value="${escapeHtml(afkTimeoutValue)}" ${fieldDisabled('afkTimeoutSec')} style="width:140px">
            </div>
          </div>
        </div>
        ${btnRow}
      </div>`;
    } else {
      // ---- Global scope: two-pane layout (nav + category panes) ----
      settingsViewerBody.classList.add('sv-two-pane');
      settingsViewerBody.innerHTML = `
      <div class="settings-shell">
        <nav class="settings-nav">
          <div class="settings-search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#7a7a90" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
            <input id="sv-search" type="text" placeholder="Search settings…" autocomplete="off">
          </div>
          <button class="settings-nav-item active" data-cat="sessions">Sessions &amp; CLI <span class="settings-nav-count">11</span></button>
          <button class="settings-nav-item" data-cat="terminal">Terminal <span class="settings-nav-count">8</span></button>
          <button class="settings-nav-item" data-cat="layout">Layout &amp; Tabs <span class="settings-nav-count">10</span></button>
          <button class="settings-nav-item" data-cat="projects">Projects &amp; Sidebar <span class="settings-nav-count">6</span></button>
          <button class="settings-nav-item" data-cat="usage">Usage &amp; Notifications <span class="settings-nav-count">7</span></button>
          <div class="settings-nav-sep"></div>
          <button class="settings-nav-item" data-cat="shortcuts">Keyboard Shortcuts <span class="settings-nav-count">${SHORTCUT_DEFS.length}</span></button>
          <button class="settings-nav-item" data-cat="handoff">Handoff <span class="settings-nav-count">2</span></button>
          <div class="settings-nav-sep"></div>
          <button class="settings-nav-item" data-cat="about">About</button>
        </nav>

        <div class="settings-main">
          <div class="settings-form">
            <div class="settings-no-results" id="sv-no-results">No settings match your search.</div>

            <!-- ===== Sessions & CLI ===== -->
            <section class="settings-cat active" data-cat="sessions">
              <div class="settings-cat-head"><h2>Sessions &amp; CLI</h2><p>How Claude launches and what it may touch.</p></div>

              <div class="settings-section">
                <div class="settings-field">
                  <div class="settings-field-info">
                    <div class="settings-field-header"><span class="settings-label">Permission Mode</span>${help}</div>
                    <div class="settings-description">How much Claude asks before acting. "Accept Edits" takes file edits automatically — risky commands still prompt.</div>
                    <div class="settings-more">Passed to the <code>claude</code> command. <b>Default</b>: asks before each action. <b>Accept Edits</b>: auto-accepts file edits and common filesystem commands. <b>Plan</b>: read-only, proposes a plan first. <b>Auto</b>: auto-approves tool calls with background safety checks (research preview). <b>Don't Ask</b>: auto-denies tools unless pre-approved. <b>Bypass</b>: skips all prompts except explicit ask rules and root/home removals — use with care.</div>
                  </div>
                  <div class="settings-field-control">
                    <select class="settings-select" id="sv-perm-mode">
                      <option value="">Default — ask each time</option>
                      <option value="acceptEdits" ${permModeValue === 'acceptEdits' ? 'selected' : ''}>Accept Edits — auto file edits</option>
                      <option value="plan" ${permModeValue === 'plan' ? 'selected' : ''}>Plan — read-only</option>
                      <option value="auto" ${permModeValue === 'auto' ? 'selected' : ''}>Auto — auto-approve (preview)</option>
                      <option value="dontAsk" ${permModeValue === 'dontAsk' ? 'selected' : ''}>Don't Ask — auto-deny unless allowed</option>
                      <option value="bypassPermissions" ${permModeValue === 'bypassPermissions' ? 'selected' : ''}>Bypass — skip all prompts</option>
                    </select>
                  </div>
                </div>
                <div class="settings-field">
                  <div class="settings-field-info">
                    <div class="settings-field-header"><span class="settings-label">Dangerous Skip</span>${help}</div>
                    <div class="settings-description">Start every new session with <code>--dangerously-skip-permissions</code> — skips all permission prompts (same effect as Bypass) and overrides Permission Mode. Use with extreme caution.</div>
                  </div>
                  <div class="settings-field-control">
                    <label class="settings-toggle"><input type="checkbox" id="sv-dangerous-skip" ${dangerousSkipValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
                  </div>
                </div>
                <div class="settings-field">
                  <div class="settings-field-info">
                    <div class="settings-field-header"><span class="settings-label">IDE emulation</span>${help}</div>
                    <div class="settings-description">Let Claude open files and diffs in a side panel. Off = use your own editor.</div>
                    <div class="settings-more">Emulates an IDE so Claude can open files and diffs in a side panel. Disable to use your own IDE instead. Changes take effect for new sessions only.</div>
                  </div>
                  <div class="settings-field-control">
                    <label class="settings-toggle"><input type="checkbox" id="sv-mcp-emulation" ${mcpEmulationValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
                  </div>
                </div>
                <div class="settings-field">
                  <div class="settings-field-info">
                    <div class="settings-field-header"><span class="settings-label">Restore sessions on launch</span>${help}</div>
                    <div class="settings-description">Reopen the sessions you had open when you last quit.</div>
                    <div class="settings-more">Restores the active session and grid view too. Sessions are resumed, not kept running in the background.</div>
                  </div>
                  <div class="settings-field-control">
                    <label class="settings-toggle"><input type="checkbox" id="sv-restore-sessions" ${restoreSessionsValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
                  </div>
                </div>
                <div class="settings-field">
                  <div class="settings-field-info">
                    <span class="settings-label">Shell profile</span>
                    <div class="settings-description">Shell for new terminal and Claude sessions. New sessions only.</div>
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
              </div>

              <div class="settings-section">
                <div class="settings-field">
                  <div class="settings-field-info">
                    <span class="settings-label">Worktree</span>
                    <div class="settings-description">Run new sessions in a separate git worktree.</div>
                  </div>
                  <div class="settings-field-control">
                    <label class="settings-toggle"><input type="checkbox" id="sv-worktree" ${worktreeValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
                  </div>
                </div>
                <div class="settings-field">
                  <div class="settings-field-info">
                    <span class="settings-label">Worktree branch name</span>
                    <div class="settings-description">Blank = generated automatically.</div>
                  </div>
                  <div class="settings-field-control">
                    <input type="text" class="settings-input" id="sv-worktree-name" placeholder="auto" value="${escapeHtml(worktreeNameValue)}" style="width:140px">
                  </div>
                </div>
                <div class="settings-field">
                  <div class="settings-field-info">
                    <span class="settings-label">Chrome automation</span>
                    <div class="settings-description">Allow Claude to drive a Chrome browser.</div>
                  </div>
                  <div class="settings-field-control">
                    <label class="settings-toggle"><input type="checkbox" id="sv-chrome" ${chromeValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
                  </div>
                </div>
                <div class="settings-field settings-field-wide">
                  <div class="settings-field-info">
                    <span class="settings-label">Additional directories</span>
                    <div class="settings-description">Extra folders Claude may read outside the project.</div>
                  </div>
                  <div class="settings-field-control">
                    <input type="text" class="settings-input" id="sv-add-dirs" placeholder="/path/to/dir1, /path/to/dir2" value="${escapeHtml(addDirsValue)}">
                  </div>
                </div>
                <div class="settings-field settings-field-wide">
                  <div class="settings-field-info">
                    <span class="settings-label">Pre-launch command</span>
                    <div class="settings-description">Runs before <code>claude</code>, e.g. <code>aws-vault exec profile --</code>.</div>
                  </div>
                  <div class="settings-field-control">
                    <input type="text" class="settings-input" id="sv-pre-launch" placeholder="e.g. aws-vault exec profile --" value="${escapeHtml(preLaunchValue)}">
                  </div>
                </div>
                <div class="settings-field settings-field-wide">
                  <div class="settings-field-info">
                    <span class="settings-label">AskUserQuestion timeout (seconds)</span>
                    <div class="settings-description">Seconds before Claude auto-continues an unanswered AskUserQuestion. Empty = default (60). <code>0</code> = never auto-continue. Applies only to Switchboard-started sessions.</div>
                  </div>
                  <div class="settings-field-control">
                    <input type="text" class="settings-input" id="sv-afk-timeout" placeholder="default (60)" value="${escapeHtml(afkTimeoutValue)}" style="width:140px">
                  </div>
                </div>
              </div>

              <details class="settings-adv">
                <summary>${advChev}Advanced</summary>
                <div class="settings-section">
                  <div class="settings-field">
                    <div class="settings-field-info">
                      <div class="settings-field-header"><span class="settings-label">Claude Code hooks for attention</span>${help}</div>
                      <div class="settings-description">More reliable attention detection than the terminal check alone.</div>
                      <div class="settings-more">Catches permission and tool prompts the terminal heuristic can miss. Adds a reversible HTTP hook to <code>~/.claude/settings.json</code>; turning this off removes it again. OSC-9 detection keeps working either way.</div>
                    </div>
                    <div class="settings-field-control">
                      <label class="settings-toggle"><input type="checkbox" id="sv-attention-hooks" ${attentionHooksValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
                    </div>
                  </div>
                </div>
              </details>
            </section>

            <!-- ===== Terminal ===== -->
            <section class="settings-cat" data-cat="terminal">
              <div class="settings-cat-head"><h2>Terminal</h2><p>Appearance and input for terminal sessions.</p></div>

              <div class="settings-section">
                <div class="settings-field">
                  <div class="settings-field-info">
                    <span class="settings-label">Theme</span>
                    <div class="settings-description">Color theme for terminal sessions.</div>
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
                    <div class="settings-field-header"><span class="settings-label">Font</span>${help}</div>
                    <div class="settings-description">Use a monospace font. Live-adjust the size with ${isMacPlatform ? '⌘' : 'Ctrl'} + / − / 0.</div>
                    <div class="settings-more">Proportional fonts break column alignment. The font must be installed; an unknown name falls back silently. Pick <b>Custom</b> to enter your own family below.</div>
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
                    <span class="settings-label">Font size</span>
                    <div class="settings-description">Pixels, 8 to 28.</div>
                  </div>
                  <div class="settings-field-control">
                    <input type="number" class="settings-input settings-input-compact" id="sv-terminal-font-size" min="8" max="28" value="${terminalFontSizeValue}">
                  </div>
                </div>
              </div>

              <div class="settings-section">
                <div class="settings-field">
                  <div class="settings-field-info">
                    <div class="settings-field-header"><span class="settings-label">Right-click action</span>${help}</div>
                    <div class="settings-description">Menu, copy/paste (Windows style), copy only, a selection action bar, or the native xterm default.</div>
                    <div class="settings-more"><b>Menu</b>: context menu with file-link actions, copy &amp; paste. <b>Copy or paste</b>: copy the selection, or paste when nothing is selected. <b>Copy only</b>: copy the selection. <b>Selection bar + paste</b>: selecting text pops a floating action bar (Copy / Create task); right-click pastes, or opens the menu over a link. <b>Native</b>: xterm default. Takes effect on the next right-click.</div>
                  </div>
                  <div class="settings-field-control">
                    <select class="settings-select" id="sv-right-click">
                      <option value="menu" ${rightClickValue === 'menu' ? 'selected' : ''}>Menu</option>
                      <option value="copy-paste" ${rightClickValue === 'copy-paste' ? 'selected' : ''}>Copy or paste</option>
                      <option value="copy" ${rightClickValue === 'copy' ? 'selected' : ''}>Copy only</option>
                      <option value="action-bar" ${rightClickValue === 'action-bar' ? 'selected' : ''}>Selection bar + paste</option>
                      <option value="default" ${rightClickValue === 'default' ? 'selected' : ''}>Native</option>
                    </select>
                  </div>
                </div>
                <div class="settings-field">
                  <div class="settings-field-info">
                    <div class="settings-field-header"><span class="settings-label">Mouse mode</span>${help}</div>
                    <div class="settings-description">Native: apps like Claude's TUI get mouse events — select text with Shift+drag. Select: left-drag selects text locally while the wheel still scrolls the TUI (PowerShell/conhost feel). Off: strip mouse tracking entirely — plain drag selects, the TUI gets no mouse events.</div>
                    <div class="settings-more"><b>Native</b>: xterm default; the program receives clicks, drags and wheel. <b>Select</b>: mouse tracking stays on so the wheel scrolls the TUI content natively, but a left-drag forces a local text selection and the program stops seeing left-clicks — links stay clickable. <b>Off</b>: Switchboard strips the mouse-tracking escape sequences, so left-drag always selects but the TUI receives no mouse events (the wheel won't scroll an alt-screen TUI). Open terminals update immediately.</div>
                  </div>
                  <div class="settings-field-control">
                    <select class="settings-select" id="sv-mouse-reporting">
                      <option value="native" ${mouseModeValue === 'native' ? 'selected' : ''}>Native</option>
                      <option value="select" ${mouseModeValue === 'select' ? 'selected' : ''}>Select (PowerShell-style)</option>
                      <option value="off" ${mouseModeValue === 'off' ? 'selected' : ''}>Off</option>
                    </select>
                  </div>
                </div>
                <div class="settings-field">
                  <div class="settings-field-info">
                    <div class="settings-field-header"><span class="settings-label">External editor</span>${help}</div>
                    <div class="settings-description">Command or path used to open files externally (Ctrl/Cmd+click a terminal file link, the right-click menu, or the file panel's open-external button). Empty = your OS default app.</div>
                    <div class="settings-more">Examples: <code>code</code>, <code>subl</code>, <code>notepad++</code>, or a full path. The file path is passed as the first argument (no shell). Falls back to the OS default when empty or if the command fails.</div>
                  </div>
                  <div class="settings-field-control">
                    <input type="text" class="settings-input" id="sv-external-editor" placeholder="OS default" value="${escapeHtml(externalEditorValue)}">
                  </div>
                </div>
                <div class="settings-field">
                  <div class="settings-field-info">
                    <div class="settings-field-header"><span class="settings-label">Closing a terminal tab</span>${help}</div>
                    <div class="settings-description">Kill the shell, or keep it running to reopen later.</div>
                    <div class="settings-more">Independent of the Claude session close behavior. <b>Kill the shell</b>: end the shell process. <b>Keep running</b>: close the view only; the shell keeps running and can be reopened.</div>
                  </div>
                  <div class="settings-field-control">
                    <select class="settings-select" id="sv-terminal-close-behavior">
                      <option value="kill" ${terminalCloseValue !== 'keep' ? 'selected' : ''}>Kill the shell</option>
                      <option value="keep" ${terminalCloseValue === 'keep' ? 'selected' : ''}>Keep running</option>
                    </select>
                  </div>
                </div>
              </div>

              <details class="settings-adv">
                <summary>${advChev}Advanced</summary>
                <div class="settings-section">
                  <div class="settings-field">
                    <div class="settings-field-info">
                      <div class="settings-field-header"><span class="settings-label">GPU rendering (WebGL)</span>${help}</div>
                      <div class="settings-description">Render terminals via the GPU (default). Substantially lower CPU load for heavy output.</div>
                      <div class="settings-more">Uses WebGL instead of the DOM renderer. Only about 16 terminals can hold a GPU context at once — extra terminals automatically fall back to the DOM renderer. Turn off if you see rendering glitches on your GPU/driver.</div>
                    </div>
                    <div class="settings-field-control">
                      <label class="settings-toggle"><input type="checkbox" id="sv-terminal-webgl" ${terminalWebglValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
                    </div>
                  </div>
                </div>
                <div class="settings-section">
                  <div class="settings-section-title">Saved variables</div>
                  <div class="settings-field">
                    <div class="settings-field-info">
                      <div class="settings-field-header"><span class="settings-label">Delete secret temp files on session stop</span>${help}</div>
                      <div class="settings-description">When a session ends, remove the temp files created for its inserted secret references.</div>
                      <div class="settings-more">Secret variables inserted via <code>{path}</code>/<code>{ref}</code> write the value to a 0600 temp file the shell or tool reads. Leave on to wipe them as soon as the session stops. App quit and startup always wipe them regardless of this setting.</div>
                    </div>
                    <div class="settings-field-control">
                      <label class="settings-toggle"><input type="checkbox" id="sv-secret-ref-cleanup" ${secretRefCleanupValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
                    </div>
                  </div>
                  <div class="settings-field">
                    <div class="settings-field-info">
                      <div class="settings-field-header"><span class="settings-label">Secret temp-file sweep (minutes)</span>${help}</div>
                      <div class="settings-description">Also delete secret temp files older than this many minutes. 0 = off.</div>
                      <div class="settings-more">Extra age-based cleanup on top of session-stop/quit. Keep at 0 unless you want short-lived refs — set too low it can delete a ref before a long-running prompt uses it.</div>
                    </div>
                    <div class="settings-field-control">
                      <input type="number" min="0" class="settings-input settings-input-compact" id="sv-secret-ref-sweep" value="${secretRefSweepValue}">
                    </div>
                  </div>
                </div>
              </details>
            </section>

            <!-- ===== Layout & Tabs ===== -->
            <section class="settings-cat" data-cat="layout">
              <div class="settings-cat-head"><h2>Layout &amp; Tabs</h2><p>How sessions and windows are arranged.</p></div>

              <div class="settings-section">
                <div class="settings-field">
                  <div class="settings-field-info">
                    <div class="settings-field-header"><span class="settings-label">Display mode</span>${help}</div>
                    <div class="settings-description">Grid overview, or a tab bar above the terminal.</div>
                    <div class="settings-more"><b>Grid</b>: sidebar + grid overview / single view. <b>Tabs</b>: a tab bar above the terminal to switch between open sessions; the grid mosaic stays reachable via the overview button.</div>
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
                    <span class="settings-label">Open settings as</span>
                    <div class="settings-description">Overlay in the main window, or a separate window.</div>
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
                    <span class="settings-label">Sidebar on startup</span>
                    <div class="settings-description">Start with project/group sections expanded, collapsed, or in the last state.</div>
                  </div>
                  <div class="settings-field-control">
                    <select class="settings-select" id="sv-collapse-default">
                      <option value="expanded" ${collapseDefaultValue === 'expanded' ? 'selected' : ''}>All expanded</option>
                      <option value="collapsed" ${collapseDefaultValue === 'collapsed' ? 'selected' : ''}>All collapsed</option>
                      <option value="remember" ${collapseDefaultValue === 'remember' ? 'selected' : ''}>Last state</option>
                    </select>
                  </div>
                </div>
              </div>

              <div class="settings-section">
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
                    <div class="settings-field-header"><span class="settings-label">Closing a tab (×)</span>${help}</div>
                    <div class="settings-description">Close view keeps the session running; stop session ends it.</div>
                    <div class="settings-more"><b>Close view</b>: the session keeps running in the background, reopenable any time. <b>Stop session</b>: ends the process.</div>
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
                    <span class="settings-label">Middle-click closes a tab</span>
                    <div class="settings-description">Follows the × action above.</div>
                  </div>
                  <div class="settings-field-control">
                    <label class="settings-toggle"><input type="checkbox" id="sv-tab-middle-click" ${tabMiddleClickValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
                  </div>
                </div>
                <div class="settings-field">
                  <div class="settings-field-info">
                    <span class="settings-label">Reorder tabs by dragging</span>
                    <div class="settings-description">The order is remembered.</div>
                  </div>
                  <div class="settings-field-control">
                    <label class="settings-toggle"><input type="checkbox" id="sv-tab-drag" ${tabDragValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
                  </div>
                </div>
                <div class="settings-field">
                  <div class="settings-field-info">
                    <div class="settings-field-header"><span class="settings-label">Auto-close tab after a session exits</span>${help}</div>
                    <div class="settings-description">On success only keeps failed sessions open so you can read the error.</div>
                    <div class="settings-more"><b>Never</b>: keep the tab open (re-click to relaunch, or click another tab). <b>On success and error</b>: close after any exit. <b>On success only</b>: keep sessions that exited with an error.</div>
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
                    <div class="settings-description">How long the exit banner shows first. 0 = close immediately. Ignored when auto-close is Never.</div>
                  </div>
                  <div class="settings-field-control">
                    <input type="number" class="settings-input settings-input-compact" id="sv-tab-autoclose-delay" min="0" max="120" value="${tabAutoCloseDelayValue}">
                  </div>
                </div>
              </div>

              <details class="settings-adv">
                <summary>${advChev}Advanced</summary>
                <div class="settings-section">
                  <div class="settings-field">
                    <div class="settings-field-info">
                      <div class="settings-field-header"><span class="settings-label">Live-render background tabs</span>${help}</div>
                      <div class="settings-description">Draw output in background tabs right away instead of on switch. No flicker, but more CPU for busy sessions.</div>
                      <div class="settings-more">Removes the flicker when returning to a tab that produced output, at some CPU/GPU cost for busy background sessions. Off = buffer the output and replay it when you switch to the tab.</div>
                    </div>
                    <div class="settings-field-control">
                      <label class="settings-toggle"><input type="checkbox" id="sv-tabs-live-render" ${tabsLiveRenderValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
                    </div>
                  </div>
                </div>
              </details>
            </section>

            <!-- ===== Projects & Sidebar ===== -->
            <section class="settings-cat" data-cat="projects">
              <div class="settings-cat-head"><h2>Projects &amp; Sidebar</h2><p>Which projects appear and how the session list is trimmed.</p></div>

              <div class="settings-section">
                <div class="settings-field">
                  <div class="settings-field-info">
                    <div class="settings-field-header"><span class="settings-label">Project order</span>${help}</div>
                    <div class="settings-description">Order of projects in the sidebar.</div>
                    <div class="settings-more"><b>Manual</b> lets you drag projects into place — a grip handle appears on each project header.</div>
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
                    <div class="settings-field-header"><span class="settings-label">Favorites as a separate list</span>${help}</div>
                    <div class="settings-description">On: reach favorites via the star filter. Off: pin them on top of the list.</div>
                    <div class="settings-more">On: favorites are not shown in the main list — only via the star filter in the toolbar. Off: favorites are pinned on top of the list with a divider, and the star filter is hidden.</div>
                  </div>
                  <div class="settings-field-control">
                    <label class="settings-toggle"><input type="checkbox" id="sv-favorites-own-list" ${favoritesOwnListValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
                  </div>
                </div>
                <div class="settings-field">
                  <div class="settings-field-info">
                    <div class="settings-field-header"><span class="settings-label">Add projects automatically</span>${help}</div>
                    <div class="settings-description">On: every project you use with Claude Code shows up on its own. Off: add them yourself with +.</div>
                    <div class="settings-more">On: all <code>~/.claude/projects</code> folders appear automatically. Off: the current projects stay and new ones no longer appear on their own — add them with the + button (starting a session from Switchboard also adds its project). Switching back on restores full auto-discovery.</div>
                  </div>
                  <div class="settings-field-control">
                    <label class="settings-toggle"><input type="checkbox" id="sv-project-auto-add" ${projectAutoAddValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
                  </div>
                </div>
              </div>

              <div class="settings-section">
                <div class="settings-field">
                  <div class="settings-field-info">
                    <span class="settings-label">Max visible sessions</span>
                    <div class="settings-description">Show this many before collapsing the rest behind "+N older".</div>
                  </div>
                  <div class="settings-field-control">
                    <input type="number" class="settings-input settings-input-compact" id="sv-visible-count" min="1" max="100" value="${visCountValue}">
                  </div>
                </div>
                <div class="settings-field">
                  <div class="settings-field-info">
                    <span class="settings-label">Hide sessions older than (days)</span>
                    <div class="settings-description">Older sessions collapse behind "+N older" even if under the count limit.</div>
                  </div>
                  <div class="settings-field-control">
                    <input type="number" class="settings-input settings-input-compact" id="sv-max-age" min="1" max="365" value="${maxAgeValue}">
                  </div>
                </div>
                <div class="settings-field">
                  <div class="settings-field-info">
                    <span class="settings-label">Auto-hide inactive projects after (days)</span>
                    <div class="settings-description">Projects with no session activity for this many days are moved to Hidden automatically. 0 disables it.</div>
                    <div class="settings-more">The project stays available under "Hidden Projects" (with an <b>auto</b> badge) and can be restored anytime. Restoring or re-adding a project restarts its timer.</div>
                  </div>
                  <div class="settings-field-control">
                    <input type="number" class="settings-input settings-input-compact" id="sv-auto-hide-days" min="0" max="3650" value="${autoHideDaysValue}">
                  </div>
                </div>
              </div>
            </section>

            <!-- ===== Usage & Notifications ===== -->
            <section class="settings-cat" data-cat="usage">
              <div class="settings-cat-head"><h2>Usage &amp; Notifications</h2><p>Usage-bar colours and when Switchboard alerts you.</p></div>

              <div class="settings-section">
                <div class="settings-field">
                  <div class="settings-field-info">
                    <span class="settings-label">Usage colours — 5-hour bar (%)</span>
                    <div class="settings-description"><span class="settings-usage-scale"><i style="background:#3ecf5a"></i><i style="background:#e0a13c"></i><i style="background:#e05a5a"></i></span>Green below the first value, orange from there, red at or above the second. Defaults 60 / 80.</div>
                  </div>
                  <div class="settings-field-control">
                    <input type="number" class="settings-input settings-input-compact" id="sv-usage-5h-warn" min="1" max="99" value="${usage5hWarnValue}" title="Orange from this %">
                    <input type="number" class="settings-input settings-input-compact" id="sv-usage-5h-crit" min="2" max="100" value="${usage5hCritValue}" title="Red at/above this %">
                  </div>
                </div>
                <div class="settings-field">
                  <div class="settings-field-info">
                    <span class="settings-label">Usage colours — 7-day &amp; quota bars (%)</span>
                    <div class="settings-description"><span class="settings-usage-scale"><i style="background:#3ecf5a"></i><i style="background:#e0a13c"></i><i style="background:#e05a5a"></i></span>Same green / orange / red scale for the weekly and quota bars. Defaults 75 / 90.</div>
                  </div>
                  <div class="settings-field-control">
                    <input type="number" class="settings-input settings-input-compact" id="sv-usage-7d-warn" min="1" max="99" value="${usage7dWarnValue}" title="Orange from this %">
                    <input type="number" class="settings-input settings-input-compact" id="sv-usage-7d-crit" min="2" max="100" value="${usage7dCritValue}" title="Red at/above this %">
                  </div>
                </div>
              </div>

              <div class="settings-section">
                <div class="settings-field">
                  <div class="settings-field-info">
                    <span class="settings-label">Enable notifications</span>
                    <div class="settings-description">OS notification and taskbar badge when a session needs you and Switchboard is unfocused.</div>
                  </div>
                  <div class="settings-field-control">
                    <label class="settings-toggle"><input type="checkbox" id="sv-notify-enabled" ${notifyEnabledValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
                  </div>
                </div>
                <div class="settings-field">
                  <div class="settings-field-info">
                    <span class="settings-label">Notify when a session is ready</span>
                    <div class="settings-description">Also alert when an agent finishes and is ready for review, not only when it needs action.</div>
                  </div>
                  <div class="settings-field-control">
                    <label class="settings-toggle"><input type="checkbox" id="sv-notify-ready" ${notifyOnReadyValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
                  </div>
                </div>
                <div class="settings-field">
                  <div class="settings-field-info">
                    <span class="settings-label">Alert sound</span>
                    <div class="settings-description">Play a short chime when a session needs you. Press <code>${escapeHtml(nextAttentionShortcutLabel)}</code> to jump to the next one.</div>
                  </div>
                  <div class="settings-field-control">
                    <label class="settings-toggle"><input type="checkbox" id="sv-attention-sound" ${attentionSoundValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
                  </div>
                </div>
                <div class="settings-field">
                  <div class="settings-field-info">
                    <div class="settings-field-header"><span class="settings-label">Idle running sessions in the inbox</span>${help}</div>
                    <div class="settings-description">When a live but idle session (not working, not awaiting you) shows in the attention list.</div>
                    <div class="settings-more"><b>Until opened</b>: stays until you open it. <b>Until opened, or after a few minutes</b>: whichever comes first. <b>For a few minutes (even after opening)</b>: stays the full time set below regardless. <b>Always</b> / <b>Never</b>: unconditional. Sessions that never ran are never shown.</div>
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
                    <span class="settings-label">Keep finished sessions for (minutes)</span>
                    <div class="settings-description">How long a finished session stays in the inbox — used only by the timed modes above.</div>
                  </div>
                  <div class="settings-field-control">
                    <input type="number" class="settings-input settings-input-compact" id="sv-running-inbox-minutes" min="1" max="120" value="${runningInboxMinutesValue}">
                  </div>
                </div>
              </div>
            </section>

            <!-- ===== Keyboard Shortcuts ===== -->
            <section class="settings-cat" data-cat="shortcuts">
              <div class="settings-cat-head"><h2>Keyboard Shortcuts</h2><p>Click a shortcut, then press the new combination.</p></div>
              <div class="settings-section">
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
              </div>
              <div class="settings-hint">At least one modifier (${scIsMac ? 'Cmd' : 'Ctrl'}, ${scIsMac ? 'Option' : 'Alt'} or Shift) is required. Press Esc to cancel, or click a shortcut again to reset it to defaults.</div>
            </section>

            <!-- ===== Handoff ===== -->
            <section class="settings-cat" data-cat="handoff">
              <div class="settings-cat-head"><h2>Handoff</h2><p>Save a session's context and pick it up later.</p></div>
              <div class="settings-section">
                <div class="settings-field">
                  <div class="settings-field-info">
                    <div class="settings-field-header"><span class="settings-label">Integrated handoff</span>${help}</div>
                    <div class="settings-description">Save a handoff to the project and resume it later from the new-session menu.</div>
                    <div class="settings-more">When on, a handoff can be saved to the project (instead of starting a fresh session right away) and later resumed from the new-session menu ("Claude Handoff resume"). The guided flow needs a running session.</div>
                  </div>
                  <div class="settings-field-control">
                    <label class="settings-toggle"><input type="checkbox" id="sv-handoff-library" ${handoffLibraryValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
                  </div>
                </div>
                <div class="settings-field settings-field-wide">
                  <div class="settings-field-info">
                    <span class="settings-label">Handoff prompt</span>
                    <div class="settings-description">Sent to the running agent to produce the handoff. Placeholders: {goal} {project} {sessionId} {metrics}. Set a skill command like <code>/handoff</code> to run a skill instead. Clear the field to restore the default.</div>
                  </div>
                  <div class="settings-field-control">
                    <textarea class="settings-input" id="sv-handoff-prompt" spellcheck="false" style="width:100%;min-height:200px;font-family:monospace;font-size:12px;line-height:1.5;resize:vertical;box-sizing:border-box;">${escapeHtml(handoffPromptValue)}</textarea>
                  </div>
                </div>
              </div>
            </section>

            <!-- ===== About ===== -->
            <section class="settings-cat" data-cat="about">
              <div class="settings-cat-head"><h2>About</h2><p>Version, build lineage and runtime.</p></div>

              <div class="settings-section">
                <div class="about-app">
                  <div class="about-name">Switchboard</div>
                  <div class="about-version">Version <span id="sv-about-version">…</span> · <code>deadeye</code> · <code id="sv-about-build">…</code></div>
                  <div class="about-tagline">Browse, search, launch and monitor Claude Code sessions across projects.</div>
                </div>
              </div>

              <div class="settings-section">
                <div class="settings-section-title">Fork lineage</div>
                <div class="settings-description">Our own variant (codename <code>deadeye</code>); upstream features are adopted one at a time rather than tracking a single fork.</div>
                <ul class="about-list">
                  <li><b>Base</b> — <code>haydng</code></li>
                  <li><b>Feature source</b> — <code>jbr</code> (JeanBaptisteRenard)</li>
                  <li><b>Original upstream</b> — <code>doctly</code></li>
                  <li><b>Common merge-base</b> — <code>b98c2f8</code></li>
                </ul>
                <div class="settings-description">Repository: <code>github.com/deadeye636/switchboard</code></div>
              </div>

              <div class="settings-section">
                <div class="settings-section-title">License &amp; disclaimer</div>
                <div class="settings-description">
                  MIT License. Private downstream fork — <b>not an official product</b> and
                  <b>not affiliated with, endorsed by, or supported by</b> Anthropic, Doctly, or any
                  upstream author.
                </div>
                <div class="settings-description">
                  Provided <b>"as is", with no warranty, no support and no liability</b>. Used
                  <b>entirely at your own risk</b>. Builds are unsigned — prefer building from source.
                </div>
                <div class="settings-description">
                  Nearly all of the work and credit belongs to the upstream authors
                  (<code>haydng</code>, <code>jbr</code>, <code>doctly</code>); this fork only adds a
                  thin layer on top.
                </div>
              </div>

              <div class="settings-section">
                <div class="settings-section-title">Runtime</div>
                <div class="about-runtime">
                  <div class="about-kv"><span>Electron</span><code id="sv-about-electron">…</code></div>
                  <div class="about-kv"><span>Chromium</span><code id="sv-about-chrome">…</code></div>
                  <div class="about-kv"><span>Node</span><code id="sv-about-node">…</code></div>
                  <div class="about-kv"><span>V8</span><code id="sv-about-v8">…</code></div>
                  <div class="about-kv"><span>Platform</span><code id="sv-about-platform">…</code></div>
                </div>
              </div>

              <div class="settings-hint">Thanks to the upstream fork authors (haydng, JeanBaptisteRenard, doctly) whose work this builds on.</div>
            </section>

            ${btnRow}
          </div>
        </div>
      </div>`;

      // --- Global two-pane wiring: category nav, live search, "?" help toggles ---
      const navItems = Array.from(settingsViewerBody.querySelectorAll('.settings-nav-item'));
      const cats = Array.from(settingsViewerBody.querySelectorAll('.settings-cat'));
      // Fill the About pane's version + runtime fields (async, best-effort).
      if (window.api.getAboutInfo) {
        window.api.getAboutInfo().then(info => {
          const set = (id, v) => { const el = settingsViewerBody.querySelector(id); if (el) el.textContent = v; };
          set('#sv-about-version', info.version);
          if (info.build) set('#sv-about-build', `${info.build.branch} @ ${info.build.commit}${info.build.dirty ? ' (dirty)' : ''}`);
          set('#sv-about-electron', info.electron);
          set('#sv-about-chrome', info.chrome);
          set('#sv-about-node', info.node);
          set('#sv-about-v8', info.v8);
          set('#sv-about-platform', `${info.platform} / ${info.arch}`);
        }).catch(() => {});
      }
      const searchInput = settingsViewerBody.querySelector('#sv-search');
      const noResults = settingsViewerBody.querySelector('#sv-no-results');
      const mainScroll = settingsViewerBody.querySelector('.settings-main');

      function showCat(cat) {
        cats.forEach(c => c.classList.toggle('active', c.dataset.cat === cat));
        navItems.forEach(n => n.classList.toggle('active', n.dataset.cat === cat));
        if (mainScroll) mainScroll.scrollTop = 0;
      }

      function applyGlobalSearch(q) {
        q = (q || '').trim().toLowerCase();
        if (!q) {
          settingsViewerBody.querySelectorAll('.settings-cat .settings-field').forEach(f => { f.style.display = ''; });
          settingsViewerBody.querySelectorAll('.settings-cat-head, .settings-section, .settings-hint, details.settings-adv').forEach(e => { e.style.display = ''; });
          if (noResults) noResults.style.display = 'none';
          const active = navItems.find(n => n.classList.contains('active')) || navItems[0];
          showCat(active ? active.dataset.cat : 'sessions');
          return;
        }
        // Search across all categories at once.
        cats.forEach(c => c.classList.add('active'));
        settingsViewerBody.querySelectorAll('.settings-cat-head').forEach(e => e.style.display = 'none');
        settingsViewerBody.querySelectorAll('details.settings-adv').forEach(d => { d.style.display = ''; d.open = true; });
        let any = false;
        cats.forEach(cat => {
          cat.querySelectorAll('.settings-field').forEach(f => {
            const match = f.textContent.toLowerCase().includes(q);
            f.style.display = match ? '' : 'none';
            if (match) any = true;
          });
          cat.querySelectorAll('.settings-section').forEach(s => {
            const vis = Array.from(s.querySelectorAll('.settings-field')).some(f => f.style.display !== 'none');
            s.style.display = vis ? '' : 'none';
          });
          cat.querySelectorAll('details.settings-adv').forEach(d => {
            const vis = Array.from(d.querySelectorAll('.settings-field')).some(f => f.style.display !== 'none');
            d.style.display = vis ? '' : 'none';
          });
          const hint = cat.querySelector('.settings-hint');
          if (hint) hint.style.display = 'none';
        });
        if (noResults) noResults.style.display = any ? 'none' : 'block';
      }

      navItems.forEach(n => n.addEventListener('click', () => {
        if (searchInput) searchInput.value = '';
        applyGlobalSearch('');
        showCat(n.dataset.cat);
      }));
      if (searchInput) searchInput.addEventListener('input', (e) => applyGlobalSearch(e.target.value));

      settingsViewerBody.querySelectorAll('.settings-help').forEach(btn => {
        btn.addEventListener('click', () => {
          const info = btn.closest('.settings-field-info');
          const more = info && info.querySelector('.settings-more');
          if (!more) return;
          const open = more.classList.toggle('open');
          btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
      });
    }

    // Use-global checkboxes toggle field disabled state
    settingsViewerBody.querySelectorAll('.use-global-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const field = cb.dataset.field;
        const fieldMap = {
          permissionMode: 'sv-perm-mode',
          dangerouslySkipPermissions: 'sv-dangerous-skip',
          worktree: 'sv-worktree',
          worktreeName: 'sv-worktree-name',
          chrome: 'sv-chrome',
          preLaunchCmd: 'sv-pre-launch',
          addDirs: 'sv-add-dirs',
          afkTimeoutSec: 'sv-afk-timeout',
        };
        const input = settingsViewerBody.querySelector('#' + fieldMap[field]);
        if (input) input.disabled = cb.checked;
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
              dangerouslySkipPermissions: () => settingsViewerBody.querySelector('#sv-dangerous-skip').checked,
              worktree: () => settingsViewerBody.querySelector('#sv-worktree').checked,
              worktreeName: () => settingsViewerBody.querySelector('#sv-worktree-name').value.trim(),
              chrome: () => settingsViewerBody.querySelector('#sv-chrome').checked,
              preLaunchCmd: () => settingsViewerBody.querySelector('#sv-pre-launch').value.trim(),
              addDirs: () => settingsViewerBody.querySelector('#sv-add-dirs').value.trim(),
              afkTimeoutSec: () => normalizeAfk(settingsViewerBody.querySelector('#sv-afk-timeout').value),
            };
            if (fieldMap[field]) settings[field] = fieldMap[field]();
          }
        });
        // Project-only field (no "use global"): custom display name, '' = use directory.
        const dnInput = settingsViewerBody.querySelector('#sv-display-name');
        if (dnInput) settings.displayName = dnInput.value.trim();
      } else {
        settings.permissionMode = settingsViewerBody.querySelector('#sv-perm-mode').value || null;
        settings.dangerouslySkipPermissions = settingsViewerBody.querySelector('#sv-dangerous-skip').checked;
        settings.worktree = settingsViewerBody.querySelector('#sv-worktree').checked;
        settings.worktreeName = settingsViewerBody.querySelector('#sv-worktree-name').value.trim();
        settings.chrome = settingsViewerBody.querySelector('#sv-chrome').checked;
        settings.preLaunchCmd = settingsViewerBody.querySelector('#sv-pre-launch').value.trim();
        settings.addDirs = settingsViewerBody.querySelector('#sv-add-dirs').value.trim();
        settings.afkTimeoutSec = normalizeAfk(settingsViewerBody.querySelector('#sv-afk-timeout').value);
        settings.visibleSessionCount = parseInt(settingsViewerBody.querySelector('#sv-visible-count').value) || 10;
        settings.sessionMaxAgeDays = parseInt(settingsViewerBody.querySelector('#sv-max-age').value) || 3;
        settings.autoHideDays = parseInt(settingsViewerBody.querySelector('#sv-auto-hide-days').value) || 0;
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
        settings.terminalMouseReporting = settingsViewerBody.querySelector('#sv-mouse-reporting').value || 'native';
        settings.externalEditorCommand = (settingsViewerBody.querySelector('#sv-external-editor')?.value || '').trim();
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
        const svSecretCleanup = settingsViewerBody.querySelector('#sv-secret-ref-cleanup');
        if (svSecretCleanup) settings.secretRefCleanupOnSessionStop = svSecretCleanup.checked;
        const svSecretSweep = settingsViewerBody.querySelector('#sv-secret-ref-sweep');
        if (svSecretSweep) settings.secretRefSweepMinutes = Math.max(0, parseInt(svSecretSweep.value, 10) || 0);
        settings.shellProfile = settingsViewerBody.querySelector('#sv-shell-profile').value || 'auto';
        // Build only the form-managed keys here; these sub-objects are re-based on
        // the freshly-read global below so a second settings window's changes since
        // this dialog opened aren't clobbered (issue #75) — hence no stale `current`
        // spread as a base.
        settings.notifications = {
          enabled: settingsViewerBody.querySelector('#sv-notify-enabled').checked,
          notifyOnReady: settingsViewerBody.querySelector('#sv-notify-ready').checked,
          sound: settingsViewerBody.querySelector('#sv-attention-sound').checked,
        };
        settings.runningInbox = {
          mode: settingsViewerBody.querySelector('#sv-running-inbox-mode')?.value || 'until-read',
          minutes: Math.max(1, Math.min(120, parseInt(settingsViewerBody.querySelector('#sv-running-inbox-minutes')?.value, 10) || 5)),
        };
        // scShortcuts carries only the session-nav/grid bindings; non-managed keys
        // (e.g. deadeye's nextAttention) are preserved by the re-base below.
        settings.shortcuts = scShortcuts;
      }
      stopShortcutCapture();

      // Merge form values into existing settings to preserve keys not managed by the form
      if (!isProject) {
        const existing = (await window.api.getSetting('global')) || {};
        // Re-base the hand-merged sub-objects on the freshly-read global so keys another
        // settings window changed since this dialog opened aren't clobbered — a rebind of
        // the non-managed nextAttention shortcut, or any future notifications key. The
        // form's own toggles/bindings still win for the keys it manages (issue #75).
        settings.notifications = { ...(existing.notifications || {}), ...settings.notifications };
        settings.shortcuts = { ...(existing.shortcuts || {}), ...settings.shortcuts };
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
          window._setTerminalWebgl(settings.terminalWebgl !== false); // default on (#81)
        }
        if (typeof window._setUsageThresholds === 'function') {
          window._setUsageThresholds({ fiveHWarn: settings.usage5hWarn, fiveHCrit: settings.usage5hCrit, sevenDWarn: settings.usage7dWarn, sevenDCrit: settings.usage7dCrit });
        }
        {
          const autoAddEl = settingsViewerBody.querySelector('#sv-project-auto-add');
          if (autoAddEl && typeof window.api.setProjectAutoAdd === 'function') {
            // Owns projectAutoAdd + the addedProjects seed in main; notifies the
            // renderer to reload the sidebar. Not stored via the generic blob save.
            await window.api.setProjectAutoAdd(autoAddEl.checked);
          }
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
        notice.textContent = 'IDE Emulation setting changed. New sessions will use the updated setting — running sessions are not affected.';
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
