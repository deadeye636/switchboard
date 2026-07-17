// Settings panel component
// Manages the global and project settings viewer UI.

(function () {
  const settingsViewer = document.getElementById('settings-viewer');
  const settingsViewerTitle = document.getElementById('settings-viewer-title');
  const settingsViewerBody = document.getElementById('settings-viewer-body');

  // Which panel is on screen right now. Anything deferred — Apply's rebuild (#177) — has to
  // check that the panel it was started for is still the one in front of the user before it
  // touches the DOM, or it reopens the settings over whatever came after it.
  let viewerGeneration = 0;
  // Owns the document-level listeners of the panel currently rendered (see openSettingsViewer).
  let viewerListeners = new AbortController();
  const viewerIsOpen = () => (window.__SETTINGS_WINDOW__
    ? !document.hidden                                   // the window is hidden, not closed (#175)
    : settingsViewer.style.display !== 'none');

  function closeSettingsViewer() {
    viewerGeneration++;
    viewerListeners.abort();   // nothing of the closed panel keeps listening (see openSettingsViewer)
    // Standalone settings window: there is no terminal area to restore — put the window
    // away. Hiding rather than closing keeps the renderer warm for the next open (#175);
    // window.close() would destroy it, and main cannot intercept that.
    if (window.__SETTINGS_WINDOW__) {
      if (typeof window.api.hideSettingsWindow === 'function') window.api.hideSettingsWindow();
      else { try { window.close(); } catch {} }
      return;
    }
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
    viewerGeneration++;
    // Every render of the panel binds a few listeners to `document` (the click-away that
    // commits a colour). They outlive the DOM they were bound for — their closures keep the
    // whole replaced settings form alive — and the panel is now re-rendered on every Apply,
    // not just when Settings is opened. One controller per render, aborted by the next, takes
    // them all with it.
    viewerListeners.abort();
    viewerListeners = new AbortController();
    const listenerSignal = viewerListeners.signal;
    const isProject = scope === 'project';
    const settingsKey = isProject ? 'project:' + projectPath : 'global';
    const current = (await window.api.getSetting(settingsKey)) || {};
    const globalSettings = isProject ? ((await window.api.getSetting('global')) || {}) : {};
    // Project tags (#98) live in their own store, not the settings blob. Load the
    // current chips so the editor can seed itself; saved back via projectTagsSet.
    // Existing chips carry their stored color (may differ from the deterministic
    // default when the user recolored them via the picker, #98).
    const projectTagsData = isProject
      ? ((await window.api.projectTagsGet(projectPath).catch(() => [])) || [])
      : [];
    // All tags used across projects, with their stored colour — feeds the suggestion
    // combobox so existing tags are reused rather than retyped (#98 follow-up, #134).
    // Suggestions come from the tag definitions (#138), not from what is currently
    // assigned — a tag created in settings and never used must still be offered.
    // Hidden and disabled tags are withheld: hidden means "keep it, stop showing it",
    // disabled means "not assignable".
    const allTagRows = isProject
      ? ((await window.api.projectTagsListAll().catch(() => [])) || [])
      : [];
    const allProjectTags = allTagRows
      .filter(r => r && r.tag && !r.hidden && !r.disabled)
      .map(r => ({ tag: r.tag, color: r.color || null }));
    // Deterministic tag hue, shared with session-tag chips (bookmarks-tags.js).
    const tagColor = (tag) => (window.bookmarksTags && typeof window.bookmarksTags.pickColor === 'function')
      ? window.bookmarksTags.pickColor(tag)
      : '#61afef';
    // The fixed chip palette for the recolor picker.
    const tagPalette = (window.bookmarksTags && Array.isArray(window.bookmarksTags.palette) && window.bookmarksTags.palette.length)
      ? window.bookmarksTags.palette
      : ['#e06c75', '#e5c07b', '#98c379', '#56b6c2', '#61afef', '#c678dd', '#d19a66'];
    const renderTagChip = (tag, color) => {
      const c = color || tagColor(tag);
      return `<span class="settings-tag-chip" data-tag="${escapeHtml(tag)}" data-color="${escapeHtml(c)}" style="background:${c}1a;border-color:${c};color:${c}" title="Click to change color"><span class="settings-tag-label">${escapeHtml(tag)}</span><button type="button" class="settings-tag-remove" aria-label="Remove tag ${escapeHtml(tag)}">&times;</button></span>`;
    };

    // The tag management lists, their live-update push and the colour picker moved to
    // panels/settings-tags.js (#218). They are built per OPEN because the click-away listener must hang
    // off THIS open's AbortSignal — openSettingsViewer replaces the controller every time, and a stale
    // signal is already aborted, so the picker would never dismiss.
    const { initTagDefsSection, buildColorPopover } =
      window.settingsTags.create({ body: settingsViewerBody, tagColor, tagPalette, signal: listenerSignal });

    // The Maintenance section (export / import / rebuild) moved to panels/settings-maintenance.js
    // (#218). It takes `openSettingsViewer` as `reopen` because a successful import has to re-render
    // this form from the blob it just wrote.
    const { initMaintenanceSection } =
      window.settingsMaintenance.create({ body: settingsViewerBody, reopen: openSettingsViewer });


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
    // `normalizeAfk` lived here and was never called — by anything, anywhere. Deleted with #218's first
    // cut of this function: a 2250-line body is exactly where a dead helper survives being read past.
    const visCountValue = fieldValue('visibleSessionCount', 10);
    const maxAgeValue = fieldValue('sessionMaxAgeDays', 3);
    const autoHideDaysValue = fieldValue('autoHideDays', 0);
    const usage5hWarnValue = fieldValue('usage5hWarn', 60);
    const usage5hCritValue = fieldValue('usage5hCrit', 80);
    const usage7dWarnValue = fieldValue('usage7dWarn', 75);
    const usage7dCritValue = fieldValue('usage7dCrit', 90);

    // The status-bar usage selection (#191). A row exists only for a backend that is ENABLED and DECLARES
    // a usage capability — the list is derived, never a hardcoded set. An ABSENT key means "not decided"
    // and shows the segment; only an explicit false hides it, which is why the stored value is a map.
    // Disabling a backend drops its row but must NOT erase the tick, or turning Codex off for a day
    // silently forgets that its usage was wanted and the bar comes back empty.
    //
    // Asked over IPC rather than read from `window._backendsById`: Settings is its OWN window
    // (settings.html) and does not load backend-registry.js, so that cache is empty here. Reading it
    // would have produced no rows at all, in the one window where the rows live.
    const usageSelection = (globalSettings && globalSettings.usageBackends) || {};
    let usageCapable = [];
    try {
      const res = await window.api.backends.list();
      usageCapable = ((res && res.backends) || [])
        .filter(b => b.usage && b.status === 'ready' && b.enabled)
        .sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id)));
    } catch { /* no list, no rows — the thresholds below still render */ }
    const usageBackendRowsHtml = usageCapable.map(b => `
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label"><span class="settings-usage-backend-icon backend-icon-slot" data-icon="${escapeHtml(b.icon || b.id)}" data-size="16"></span>${escapeHtml(b.label || b.id)}</span>
            <div class="settings-description">${b.usage.live
              ? 'Fetched live, so the bar shows the current figure.'
              : 'Read from its own session files — the figure is as of its last run, and the bar dims it once it is older than an hour.'}</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" class="sv-usage-backend" data-backend="${escapeHtml(b.id)}" ${usageSelection[b.id] === false ? '' : 'checked'}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>`).join('');
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
    // gpuAcceleration ports VSCode's auto|on|off model (#87); migrate the old boolean
    // terminalWebgl (false → off, else auto).
    const gpuAccelRaw = fieldValue('gpuAcceleration', undefined);
    const gpuAccelValue = (gpuAccelRaw === 'on' || gpuAccelRaw === 'off' || gpuAccelRaw === 'auto')
      ? gpuAccelRaw
      : (fieldValue('terminalWebgl', true) === false ? 'off' : 'auto');
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
    const restoreSessionsValue = fieldValue('restoreSessionsOnLaunch', true);
    const confirmQuitValue = fieldValue('confirmQuitWithRunningSessions', true);
    const attentionHooksValue = fieldValue('attentionHooks', false);
    const secretRefCleanupValue = fieldValue('secretRefCleanupOnSessionStop', true);
    const secretRefSweepValue = fieldValue('secretRefSweepMinutes', 0);
    // Two shells, split by intent (T-2.5): `shellProfile` hosts Claude and every backend CLI
    // spawn; `terminalShellProfile` is the plain Terminal / External Terminal bucket. 'inherit'
    // falls back to the CLI shell — the default, so nothing changes until it is set.
    const shellProfileValue = fieldValue('shellProfile', 'auto');
    const terminalShellProfileValue = fieldValue('terminalShellProfile', 'inherit');
    // #17 project list (global only): sort mode + favorites presentation.
    const projectSortValue = !isProject ? (current.projectSortMode || 'activity') : 'activity';
    const favoritesOwnListValue = !isProject ? !!current.favoritesOwnList : false;
    const subagentLiveStatusValue = !isProject ? current.subagentLiveStatus !== false : true;
    const logLevelValue = !isProject ? (current.logLevel || 'info') : 'info';
    const projectAutoAddValue = !isProject ? (current.projectAutoAdd !== false) : true;
    // Handoff library (global only): toggle + editable request prompt.
    const defaultHandoffPrompt = (typeof window !== 'undefined' && window.DEFAULT_HANDOFF_PROMPT) || '';
    const defaultHandoffReadPrompt = (typeof window !== 'undefined' && window.DEFAULT_HANDOFF_READ_PROMPT) || '';
    const handoffReadPromptValue = !isProject
      ? ((typeof current.handoffReadPrompt === 'string' && current.handoffReadPrompt.length) ? current.handoffReadPrompt : defaultHandoffReadPrompt)
      : '';
    const handoffPromptValue = !isProject
      ? ((typeof current.handoffPrompt === 'string' && current.handoffPrompt.length) ? current.handoffPrompt : defaultHandoffPrompt)
      : '';
    // Notifications (global only) — alert sound on attention + read-only hotkey hint.
    const attentionSoundValue = !!((current.notifications || {}).sound);
    const isMacPlatform = !!(window.api && window.api.platform === 'darwin');
    const isWinPlatform = !!(window.api && window.api.platform === 'win32');
    const nextAttentionShortcutLabel = isMacPlatform ? '⌘⇧A' : 'Ctrl+Shift+A';
    // ConPTY backend (#114, Windows only): bundled conpty.dll vs OS pseudo-console.
    const conptyBackendValue = fieldValue('conptyBackend', 'bundled') === 'system' ? 'system' : 'bundled';

    // Notifications live in the global blob under `notifications`.
    const notificationsValue = (!isProject && current.notifications) || {};
    const notifyEnabledValue = notificationsValue.enabled !== false; // default on
    const notifyOnReadyValue = !!notificationsValue.notifyOnReady; // default off

    // Sticky attention inbox (global only): pin the inbox to the top of the sidebar.
    const stickyAttentionInboxValue = !isProject ? current.stickyAttentionInbox !== false : true;

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

    // Shared button row (both scopes), mounted into the pinned footer below.
    // Two groups, pushed apart: what this page can do TO the project on the left, what it
    // does with the EDITS on the right, ending on the one button that commits and closes.
    const btnRow = `
      <div class="settings-btn-row">
        ${isProject ? '<button class="settings-remove-btn" id="sv-remove-btn" title="Keep it on the project list, but stop showing it. New sessions do not bring it back.">Hide Project</button>' : ''}
        ${isProject ? '<button class="settings-remove-btn" id="sv-remove-project-btn" title="Take it off the project list and clear its cached sessions. The transcripts stay on disk; a new session there brings the project back.">Remove Project</button>' : ''}
        <span class="settings-btn-spacer"></span>
        <button class="settings-cancel-btn" id="sv-cancel-btn">Cancel</button>
        <button class="settings-apply-btn" id="sv-apply-btn" title="Save without closing the settings">Apply</button>
        <button class="settings-save-btn" id="sv-save-btn">Save Settings</button>
      </div>`;

    // The actions sit OUTSIDE the scrolling body, on the bottom edge of the viewer:
    // at the end of a long category they were only reachable by scrolling all the way
    // down (#176). Only the settings content scrolls now; Save and Cancel do not move.
    // Rebuilt on every open, so the listeners bound below always belong to the buttons
    // currently on screen.
    let settingsFooter = settingsViewer.querySelector('#settings-viewer-footer');
    if (!settingsFooter) {
      settingsFooter = document.createElement('div');
      settingsFooter.id = 'settings-viewer-footer';
      settingsViewer.appendChild(settingsFooter);
    }
    // The global scope indents its footer past the category nav, so the buttons line
    // up with the settings column rather than with the window.
    settingsFooter.classList.toggle('two-pane', !isProject);
    settingsFooter.innerHTML = btnRow;
    // The buttons no longer live in the body — look them up in the viewer.
    const svBtn = (sel) => settingsViewer.querySelector(sel);

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
          <div class="settings-field settings-field-wide">
            <div class="settings-field-info">
              <span class="settings-label">Tags</span>
              <div class="settings-description">Colored labels for this project. Filter the sidebar by tag using the chips above the project list. Start typing to reuse an existing tag or create a new one; click × to remove.</div>
            </div>
            <div class="settings-field-control">
              <div id="sv-project-tags" class="settings-tag-editor">
                <span id="sv-project-tags-chips" class="settings-tag-chips">${projectTagsData.map(t => renderTagChip(t.tag, t.color)).join('')}</span>
                <input type="text" id="sv-project-tags-input" class="settings-tag-input" placeholder="Add a tag…"
                       autocomplete="off" role="combobox" aria-expanded="false" aria-autocomplete="list"
                       aria-controls="sv-project-tags-suggest">
                <div id="sv-project-tags-suggest" class="settings-tag-suggest" role="listbox" hidden></div>
              </div>
            </div>
          </div>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">Shells</div>

          <div class="settings-field">
            <div class="settings-field-info">
              <div class="settings-field-header">
                <span class="settings-label">CLI shell</span>
                ${useGlobalCheckbox('shellProfile')}
              </div>
              <div class="settings-description">Shell that hosts Claude and every backend CLI in this project. New sessions only.</div>
            </div>
            <div class="settings-field-control">
              <select class="settings-select" id="sv-shell-profile" ${fieldDisabled('shellProfile')}>
                <option value="auto" ${shellProfileValue === 'auto' ? 'selected' : ''}>Auto (detect)</option>
                ${shellProfiles.map(p =>
                  `<option value="${escapeHtml(p.id)}" ${shellProfileValue === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
                ).join('')}
              </select>
            </div>
          </div>

          <div class="settings-field">
            <div class="settings-field-info">
              <div class="settings-field-header">
                <span class="settings-label">Terminal shell</span>
                ${useGlobalCheckbox('terminalShellProfile')}
              </div>
              <div class="settings-description">Shell for the in-app Terminal and External Terminal. Inherit = use the CLI shell above.</div>
            </div>
            <div class="settings-field-control">
              <select class="settings-select" id="sv-terminal-shell-profile" ${fieldDisabled('terminalShellProfile')}>
                <option value="inherit" ${terminalShellProfileValue === 'inherit' ? 'selected' : ''}>Inherit from CLI shell</option>
                <option value="auto" ${terminalShellProfileValue === 'auto' ? 'selected' : ''}>Auto (detect)</option>
                ${shellProfiles.map(p =>
                  `<option value="${escapeHtml(p.id)}" ${terminalShellProfileValue === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
                ).join('')}
              </select>
            </div>
          </div>
        </div>

        <!-- Terminal tools (T-3.10) — the project's own custom launchers, on top of the global ones. -->
        <div id="sv-launchers-root"></div>

        <!-- Per-backend launch defaults (T-2.6) — rendered from each backend's configFields. -->
        <div id="sv-backends-root"></div>
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
          <button class="settings-nav-item active" data-cat="sessions">Sessions &amp; CLI <span class="settings-nav-count">6</span></button>
          <button class="settings-nav-item" data-cat="terminal">Terminal <span class="settings-nav-count">8</span></button>
          <button class="settings-nav-item settings-nav-sub" data-cat="tools">Terminal tools</button>
          <button class="settings-nav-item" data-cat="layout">Layout &amp; Tabs <span class="settings-nav-count">10</span></button>
          <button class="settings-nav-item" data-cat="projects">Projects &amp; Sidebar <span class="settings-nav-count">7</span></button>
          <button class="settings-nav-item" data-cat="tags">Tags</button>
          <button class="settings-nav-item" data-cat="usage">Usage &amp; Notifications <span class="settings-nav-count">7</span></button>
          <button class="settings-nav-item" data-cat="backends">Backends</button>
          <div class="settings-nav-sep"></div>
          <button class="settings-nav-item" data-cat="shortcuts">Keyboard Shortcuts <span class="settings-nav-count">${SHORTCUT_DEFS.length}</span></button>
          <button class="settings-nav-item" data-cat="handoff">Handoff <span class="settings-nav-count">2</span></button>
          <div class="settings-nav-sep"></div>
          <button class="settings-nav-item" data-cat="maintenance">Maintenance</button>
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
                    <div class="settings-field-header"><span class="settings-label">Ask before closing while sessions run</span>${help}</div>
                    <div class="settings-description">Closing Switchboard stops every running session and terminal. Confirm first.</div>
                    <div class="settings-more">The processes are children of the app: when it goes, they go. A CLI in the middle of a turn loses what it was doing, and an accidental Alt+F4 is enough. Switch this off and the window closes without asking.</div>
                  </div>
                  <div class="settings-field-control">
                    <label class="settings-toggle"><input type="checkbox" id="sv-confirm-quit" ${confirmQuitValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
                  </div>
                </div>
                <div class="settings-field">
                  <div class="settings-field-info">
                    <span class="settings-label">CLI shell</span>
                    <div class="settings-description">Shell that hosts Claude and every backend CLI when a session launches. New sessions only.</div>
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
                    <span class="settings-label">Terminal shell</span>
                    <div class="settings-description">Shell for the in-app Terminal and External Terminal. Inherit = use the CLI shell above.</div>
                  </div>
                  <div class="settings-field-control">
                    <select class="settings-select" id="sv-terminal-shell-profile">
                      <option value="inherit" ${terminalShellProfileValue === 'inherit' ? 'selected' : ''}>Inherit from CLI shell</option>
                      <option value="auto" ${terminalShellProfileValue === 'auto' ? 'selected' : ''}>Auto (detect)</option>
                      ${shellProfiles.map(p =>
                        `<option value="${escapeHtml(p.id)}" ${terminalShellProfileValue === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
                      ).join('')}
                    </select>
                  </div>
                </div>
                <div class="settings-field">
                  <div class="settings-field-info">
                    <div class="settings-field-header"><span class="settings-label">Log level</span>${help}</div>
                    <div class="settings-description">Detail written to the app log. Applies immediately, no restart.</div>
                    <div class="settings-more"><b>Normal</b> records status transitions and session lifecycle. <b>Debug</b> adds per-decision detail. <b>Trace</b> also logs every terminal escape sequence — the CLI retitles on each spinner frame, so this writes roughly ten lines per second per busy session. Use Trace only while reproducing a problem.</div>
                  </div>
                  <div class="settings-field-control">
                    <select class="settings-select" id="sv-log-level">
                      <option value="info" ${logLevelValue === 'info' ? 'selected' : ''}>Normal</option>
                      <option value="debug" ${logLevelValue === 'debug' ? 'selected' : ''}>Debug</option>
                      <option value="silly" ${logLevelValue === 'silly' ? 'selected' : ''}>Trace (very verbose)</option>
                    </select>
                  </div>
                </div>
              </div>


            </section>

            <!-- ===== Maintenance ===== -->
            <section class="settings-cat" data-cat="maintenance">
              <div class="settings-cat-head"><h2>Maintenance</h2><p>Repair and move your Switchboard data.</p></div>
              <div class="settings-section">
                <div class="settings-field">
                  <div class="settings-field-info">
                    <div class="settings-field-header"><span class="settings-label">Export settings</span>${help}</div>
                    <div class="settings-description">Write these global settings to a JSON file — a backup, or a way to move your setup to another machine.</div>
                    <div class="settings-more">Project settings are not exported (they are tied to a path on this machine). The file does contain the paths <b>you</b> configured — added and hidden projects, a pre-launch command, a launcher's working directory. It never contains a secret: those live in your environment, and Switchboard only stores <code>$VAR</code> references to them.</div>
                  </div>
                  <div class="settings-field-control">
                    <button type="button" class="settings-action-btn" id="sv-export-settings">Export…</button>
                  </div>
                </div>
                <div class="settings-field">
                  <div class="settings-field-info">
                    <div class="settings-field-header"><span class="settings-label">Import settings</span>${help}</div>
                    <div class="settings-description">Read a settings file back in. Its values replace yours; settings the file does not mention are kept.</div>
                    <div class="settings-more">Applied immediately — no restart. Unsaved edits in this dialog are discarded.</div>
                  </div>
                  <div class="settings-field-control">
                    <button type="button" class="settings-action-btn danger" id="sv-import-settings">Import…</button>
                  </div>
                </div>
                <div class="settings-field">
                  <div class="settings-field-info">
                    <span class="settings-label">Rebuild session cache</span>
                    <div class="settings-description">Drop and re-scan the session index. Use it if sessions look stale or wrong. Full re-scan — may take a while.</div>
                  </div>
                  <div class="settings-field-control">
                    <button type="button" class="settings-action-btn danger" id="sv-rebuild-cache">Rebuild session cache…</button>
                  </div>
                </div>
              </div>
            </section>

            <!-- ===== Backends (Phase 2, T-2.3/T-2.6) ===== -->
            <section class="settings-cat" data-cat="backends">
              <div class="settings-cat-head"><h2>Backends</h2><p>Which coding agents Switchboard can launch.</p></div>
              <div id="sv-backends-root"></div>
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
                      <div class="settings-description">Render terminals via the GPU. Substantially lower CPU load for heavy output.</div>
                      <div class="settings-more">Auto uses WebGL and automatically falls back to the DOM renderer for all terminals once the GPU/driver drops or corrupts a WebGL context. On forces WebGL; Off always uses the DOM renderer. Pick Off if you still see rendering glitches (silent atlas corruption emits no event, so Auto can't catch that case).</div>
                    </div>
                    <div class="settings-field-control">
                      <select class="settings-select" id="sv-gpu-acceleration">
                        <option value="auto" ${gpuAccelValue === 'auto' ? 'selected' : ''}>Auto (WebGL, fall back to DOM)</option>
                        <option value="on" ${gpuAccelValue === 'on' ? 'selected' : ''}>On (force WebGL)</option>
                        <option value="off" ${gpuAccelValue === 'off' ? 'selected' : ''}>Off (DOM renderer)</option>
                      </select>
                    </div>
                  </div>
                </div>
                ${isWinPlatform ? `<div class="settings-section">
                  <div class="settings-field">
                    <div class="settings-field-info">
                      <div class="settings-field-header"><span class="settings-label">Windows ConPTY</span>${help}</div>
                      <div class="settings-description">Pseudo-console backend for terminals. Applies to newly started terminals.</div>
                      <div class="settings-more">Bundled uses the conpty.dll shipped with the app (Windows Terminal codebase) instead of the in-box Windows ConPTY. The system one mis-handles rapid in-place redraws, leaving stale or duplicated rows (e.g. a doubled status line) that only a resize clears. Pick System to fall back to the OS pseudo-console if terminals misbehave.</div>
                    </div>
                    <div class="settings-field-control">
                      <select class="settings-select" id="sv-conpty-backend">
                        <option value="bundled" ${conptyBackendValue === 'bundled' ? 'selected' : ''}>Bundled (recommended)</option>
                        <option value="system" ${conptyBackendValue === 'system' ? 'selected' : ''}>System</option>
                      </select>
                    </div>
                  </div>
                </div>` : ''}
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

            <!-- ===== Terminal tools (T-3.10) =====
                 Its own category under Terminal, not a section at the bottom of it: as
                 a trailing block of the Terminal page it was routinely missed (#178). -->
            <section class="settings-cat" data-cat="tools">
              <div class="settings-cat-head"><h2>Terminal tools</h2><p>Saved commands, offered in every project's launch menu.</p></div>
              <div id="sv-launchers-root"></div>
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
                    <div class="settings-field-header"><span class="settings-label">Subagent live status</span>${help}</div>
                    <div class="settings-description">Show a running indicator on a subagent's nested item while it works.</div>
                    <div class="settings-more">Driven by the subagent spawn/complete signals. Completion is detected by a stable-file heuristic, so the indicator can linger a few seconds after a subagent actually finishes.</div>
                  </div>
                  <div class="settings-field-control">
                    <label class="settings-toggle"><input type="checkbox" id="sv-subagent-live-status" ${subagentLiveStatusValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
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
                    <div class="settings-description">Show this many before collapsing the rest behind "+N older". 0 = no limit.</div>
                  </div>
                  <div class="settings-field-control">
                    <input type="number" class="settings-input settings-input-compact" id="sv-visible-count" min="0" max="100" value="${visCountValue}">
                  </div>
                </div>
                <div class="settings-field">
                  <div class="settings-field-info">
                    <span class="settings-label">Hide sessions older than (days)</span>
                    <div class="settings-description">Older sessions collapse behind "+N older" even if under the count limit. 0 = no limit.</div>
                  </div>
                  <div class="settings-field-control">
                    <input type="number" class="settings-input settings-input-compact" id="sv-max-age" min="0" max="365" value="${maxAgeValue}">
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

            <!-- ===== Tags (#138) ===== -->
            <section class="settings-cat" data-cat="tags">
              <div class="settings-cat-head">
                <h2>Tags</h2>
                <p>Project tags and session tags are separate vocabularies — the same name in both is two independent tags.</p>
              </div>
              <div class="settings-subhead">Project tags</div>
              <div class="settings-section" id="sv-tagdefs-project" data-kind="project">
                <div class="settings-tagdef-list"></div>
                <div class="settings-tagdef-add">
                  <input type="text" class="settings-input settings-tagdef-new" placeholder="New project tag…" autocomplete="off">
                  <button type="button" class="settings-tagdef-add-btn">Add</button>
                </div>
                <div class="settings-tagdef-error" hidden></div>
              </div>
              <div class="settings-subhead">Session tags</div>
              <div class="settings-section" id="sv-tagdefs-session" data-kind="session">
                <div class="settings-tagdef-list"></div>
                <div class="settings-tagdef-add">
                  <input type="text" class="settings-input settings-tagdef-new" placeholder="New session tag…" autocomplete="off">
                  <button type="button" class="settings-tagdef-add-btn">Add</button>
                </div>
                <div class="settings-tagdef-error" hidden></div>
              </div>
              <div class="settings-hint"><b>Hidden</b> keeps the tag on its assignments but drops it from the filter bar and the suggestions. <b>Disabled</b> stops it being assigned and hides its chips everywhere; the assignments survive, so re-enabling restores them. Changes here apply immediately — Save and Cancel do not affect them.</div>
            </section>

            <!-- ===== Usage & Notifications ===== -->
            <section class="settings-cat" data-cat="usage">
              <div class="settings-cat-head"><h2>Usage &amp; Notifications</h2><p>Usage-bar colours and when Switchboard alerts you.</p></div>

              <!-- Which backends the status bar shows (#191). One list, because the choice belongs to the
                   BAR — one widget, several segments — not to each backend. A row appears only for a
                   backend that is enabled AND can report a quota: Hermes and Pi have none, so they never
                   get a control that could never show a value. The whole block is omitted when nothing
                   qualifies, rather than explaining its own emptiness. -->
              <div class="settings-section">
                <div class="settings-section-title">Usage</div>
                ${usageBackendRowsHtml}
                <div class="settings-field">
                  <div class="settings-field-info">
                    <span class="settings-label">Usage colours — short-cycle limits (%)</span>
                    <div class="settings-description"><span class="settings-usage-scale"><i style="background:#3ecf5a"></i><i style="background:#e0a13c"></i><i style="background:#e05a5a"></i></span>Limits that refill within hours — the ones you can run into today (Claude's 5h window). Green below the first value, orange from there, red at or above the second. Defaults 60 / 80.</div>
                  </div>
                  <div class="settings-field-control">
                    <input type="number" class="settings-input settings-input-compact" id="sv-usage-5h-warn" min="1" max="99" value="${usage5hWarnValue}" title="Orange from this %">
                    <input type="number" class="settings-input settings-input-compact" id="sv-usage-5h-crit" min="2" max="100" value="${usage5hCritValue}" title="Red at/above this %">
                  </div>
                </div>
                <div class="settings-field">
                  <div class="settings-field-info">
                    <span class="settings-label">Usage colours — long-cycle limits &amp; quota (%)</span>
                    <div class="settings-description"><span class="settings-usage-scale"><i style="background:#3ecf5a"></i><i style="background:#e0a13c"></i><i style="background:#e05a5a"></i></span>Limits that refill over days, and the credit pool. Same green / orange / red scale. Defaults 75 / 90.</div>
                  </div>
                  <div class="settings-field-control">
                    <input type="number" class="settings-input settings-input-compact" id="sv-usage-7d-warn" min="1" max="99" value="${usage7dWarnValue}" title="Orange from this %">
                    <input type="number" class="settings-input settings-input-compact" id="sv-usage-7d-crit" min="2" max="100" value="${usage7dCritValue}" title="Red at/above this %">
                  </div>
                </div>
              </div>

              <div class="settings-section">
                <div class="settings-section-title">Notifications</div>
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
              </div>

              <div class="settings-section">
                <div class="settings-section-title">Inbox</div>
                <div class="settings-field">
                  <div class="settings-field-info">
                    <span class="settings-label">Keep the attention inbox pinned</span>
                    <div class="settings-description">Stick the Attention list to the top of the sidebar so it stays visible while you scroll the project list.</div>
                  </div>
                  <div class="settings-field-control">
                    <label class="settings-toggle"><input type="checkbox" id="sv-sticky-attention-inbox" ${stickyAttentionInboxValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
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
              ${SHORTCUT_GROUPS.map(group => {
                const defs = shortcutDefsByGroup(group.id);
                if (!defs.length) return '';
                return `
              <div class="settings-subhead">${escapeHtml(group.label)}</div>
              <div class="settings-section">
                ${defs.map(def => `
                <div class="settings-field">
                  <div class="settings-field-info">
                    <span class="settings-label">${escapeHtml(def.label)}</span>
                    <div class="settings-description">${escapeHtml(def.description)}</div>
                  </div>
                  <div class="settings-field-control">
                    <button class="settings-shortcut-btn" id="sv-sc-${def.id}" data-sc-id="${def.id}">${escapeHtml(formatBinding(def.id, scIsMac, scShortcuts))}</button>
                  </div>
                </div>`).join('')}
              </div>`;
              }).join('')}
              <div class="settings-hint">At least one modifier (${scIsMac ? 'Cmd' : 'Ctrl'}, ${scIsMac ? 'Option' : 'Alt'} or Shift) is required. Press Esc to cancel, or click a shortcut again to reset it to defaults.</div>
            </section>

            <!-- ===== Handoff ===== -->
            <section class="settings-cat" data-cat="handoff">
              <div class="settings-cat-head"><h2>Handoff</h2><p>Save a session's context and pick it up later.</p></div>
              <div class="settings-hint">A handoff is a packet that summarises the state of the work, written by an agent. You choose who writes it: <b>this session's agent</b> (it summarises what it is holding — it is resumed for one turn if it is not running), or <b>a new session</b> (a fresh agent reads this session's transcript and writes the packet itself). Each has its own prompt below, and each can be overridden per backend on its page under <b>Backends</b>.</div>

              <div class="settings-section">
                <div class="settings-field settings-field-wide">
                  <div class="settings-field-info">
                    <span class="settings-label">Summarise prompt — asked of this session's agent</span>
                    <div class="settings-description">Sent to the agent that ran this session: it summarises the state it already holds. Placeholders: {goal} {project} {sessionId} {metrics}. Clear the field to restore the default. A slash command (e.g. <code>/handoff</code>) runs that agent's own skill — each CLI has its own, so give a backend its own prompt on its <b>Backends</b> page when it needs a different one.</div>
                  </div>
                  <div class="settings-field-control">
                    <textarea class="settings-input" id="sv-handoff-prompt" spellcheck="false" style="width:100%;min-height:200px;font-family:monospace;font-size:12px;line-height:1.5;resize:vertical;box-sizing:border-box;">${escapeHtml(handoffPromptValue)}</textarea>
                  </div>
                </div>

                <div class="settings-field settings-field-wide">
                  <div class="settings-field-info">
                    <span class="settings-label">Read prompt — given to a new session</span>
                    <div class="settings-description">Sent to a FRESH agent that reads the old session's transcript and writes the handoff itself — nothing is resumed, and the old session spends nothing. <code>{transcript}</code> is the path it can read (a backend whose history lives in a database, like Hermes, has it exported for this). Other placeholders: {goal} {project} {sessionId} {metrics}. Clear the field to restore the default.</div>
                  </div>
                  <div class="settings-field-control">
                    <textarea class="settings-input" id="sv-handoff-read-prompt" spellcheck="false" style="width:100%;min-height:180px;font-family:monospace;font-size:12px;line-height:1.5;resize:vertical;box-sizing:border-box;">${escapeHtml(handoffReadPromptValue)}</textarea>
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
                  Built on upstream work (<code>doctly</code> → <code>haydng</code> → <code>jbr</code>),
                  whose authors deserve the credit for the foundation. It has since been substantially
                  rewritten. New here: multi-LLM backends, the tabbed layout, project and session tags,
                  a rebuilt settings surface. Much of the rest — the attention inbox, handoff,
                  scheduling, the grid overview, usage — was extended rather than replaced. See
                  <code>docs/fork-features.md</code>.
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
          </div>
        </div>
      </div>`;

      // --- Tag management (#138) ---
      // Writes straight through to the tag store rather than waiting for Save: tags
      // live in their own tables, not in the settings blob, and a half-applied
      // rename would be worse than an immediate one. The hint under the lists says so.
      initTagDefsSection('project');
      initTagDefsSection('session');

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

    // --- Backends (T-2.3/T-2.6): backends-panel.js owns the section's DOM. Global scope gets the
    // full manage UI (enable toggles, profiles, templates, default launch target + launch
    // defaults); project scope only gets the launch-defaults block, since activation and the
    // default target are global-only settings.
    const backendsRoot = settingsViewerBody.querySelector('#sv-backends-root');
    if (backendsRoot && window.backendsPanel) {
      window.backendsPanel.mount(backendsRoot, {
        isProject,
        settings: current,
        // The project scope needs BOTH: what it overrides itself (`settings.backendDefaults`) and what
        // it would inherit (`globalDefaults`) — the launch defaults cascade per OPTION, so a row must
        // be able to show the inherited value while the project stores nothing for it (#149).
        globalDefaults: (globalSettings || {}).backendDefaults || {},
        fieldValue,
        useGlobalCheckbox,
      }).catch(() => {
        backendsRoot.innerHTML = '<div class="settings-hint">Could not load the backend list.</div>';
      });
    }

    // The usage rows carry the backend's real badge, not a bare label — the same SVG the sidebar and
    // the status bar draw, so a row is recognisably the thing it switches on (#191). A new control in
    // this renderer inherits no styling; reuse the badge, never hand-roll a second one.
    if (typeof window.renderBackendIcon === 'function') {
      settingsViewerBody.querySelectorAll('.settings-usage-backend-icon').forEach(slot => {
        const size = Number(slot.dataset.size) || 16;
        slot.appendChild(window.renderBackendIcon(slot.dataset.icon, size));
      });
    }

    // Terminal tools (T-3.10) — the custom-launcher list of THIS scope. The panel owns its DOM and
    // hands the edited list back at save time (launchersPanel.read).
    const launchersRoot = settingsViewerBody.querySelector('#sv-launchers-root');
    if (launchersRoot && window.launchersPanel) {
      window.launchersPanel.mount(launchersRoot, {
        isProject,
        settings: current,
        globalSettings: isProject ? globalSettings : current,
        useGlobalCheckbox,
      });
    }

    // Use-global checkboxes toggle field disabled state
    settingsViewerBody.querySelectorAll('.use-global-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const field = cb.dataset.field;
        // Claude's launch options are NOT here any more — they live in Settings → Backends → Claude →
        // Launch defaults, like every other backend's (backendDefaults.<id>, §4a).
        const fieldMap = {
          shellProfile: 'sv-shell-profile',
          terminalShellProfile: 'sv-terminal-shell-profile',
        };
        const input = settingsViewerBody.querySelector('#' + fieldMap[field]);
        if (input) input.disabled = cb.checked;
      });
    });

    // The Maintenance buttons — export, import, rebuild — moved to panels/settings-maintenance.js
    // (#218). Global-only: on a project panel the section is not in the markup and this does nothing.
    initMaintenanceSection();

    // The keyboard shortcut rebinding moved to panels/settings-shortcuts.js (#218). Global-only: on a
    // project panel there are no shortcut buttons and this does nothing.
    //
    // `scShortcuts` stays HERE because both its readers are here — the template above renders the current
    // bindings, and persistSettings writes them — so the module takes ACCESSORS, not the value. Every
    // rebind replaces the object rather than mutating it, so a snapshot would leave this `let`, and
    // therefore the Save, on the bindings from before the user touched anything.
    //
    // Built here and not up with the other modules: `scIsMac` is evaluated at this call, and it is
    // declared further down (with `scShortcuts`) — reading it earlier is a TDZ ReferenceError.
    // `stopShortcutCapture` is kept because two paths below call it — persistSettings and the Cancel
    // button — so leaving the panel by either route ends a capture that is still running. Those two
    // calls are this section's only tie to the rest of this file.
    const { initShortcutSection, stopShortcutCapture } = window.settingsShortcuts.create({
      body: settingsViewerBody,
      isMac: scIsMac,
      getShortcuts: () => scShortcuts,
      setShortcuts: (next) => { scShortcuts = next; },
    });
    initShortcutSection();

    // The project tag chip editor moved to panels/settings-project-tags.js (#218, #98, #134). The chips
    // it produces ARE the state: persistSettings below re-queries the chip box out of the DOM rather than
    // being handed anything from here, so nothing about the save path changes with this.
    if (isProject) {
      window.settingsProjectTags.create({
        body: settingsViewerBody,
        allProjectTags,
        tagColor,
        renderTagChip,
        buildColorPopover,
        signal: listenerSignal,
      }).initProjectTagsEditor();
    }


    // Everything Save writes — the settings blob plus the stores that are not in it
    // (project tags, templates, the profiles default, the attention hook, the log
    // level) — and everything it applies live. Apply runs exactly this and stays
    // open; Save runs it and closes (#177). One body, so the two can never drift.
    async function persistSettings() {
      let settings = {};

      if (isProject) {
        // Only save fields where "use global" is unchecked
        settingsViewerBody.querySelectorAll('.use-global-cb').forEach(cb => {
          if (!cb.checked) {
            const field = cb.dataset.field;
            const fieldMap = {
              // Both shells cascade per project (T-2.5). `terminalShellProfile` is not consumed yet
              // (Phase 3, T-3.7); 'inherit' means "use the CLI shell", so this is a no-op today.
              shellProfile: () => settingsViewerBody.querySelector('#sv-shell-profile').value || 'auto',
              terminalShellProfile: () => settingsViewerBody.querySelector('#sv-terminal-shell-profile').value || 'inherit',
              // Custom launchers (T-3.10): the project stores only its OWN entries. The effective
              // list a launch menu shows is global ⊕ project (project wins by id) — merged at read
              // time in custom-launchers.js, NOT here, so the global list stays a live template.
              customLaunchers: () => (window.launchersPanel
                ? (window.launchersPanel.read(settingsViewerBody.querySelector('#sv-launchers-root')) || [])
                : []),
            };
            if (fieldMap[field]) settings[field] = fieldMap[field]();
          }
        });
        // Project-only field (no "use global"): custom display name, '' = use directory.
        const dnInput = settingsViewerBody.querySelector('#sv-display-name');
        if (dnInput) settings.displayName = dnInput.value.trim();
        // Project tags (#98) persist to their own store, not the settings blob.
        // Per-backend launch options cascade per OPTION (#149): the project stores ONLY what it
        // overrides. There is no "use global" checkbox for the whole blob any more — each option has
        // its own — so this is written unconditionally, and an empty object legitimately means "this
        // project overrides nothing".
        if (window.backendsPanel && settingsViewerBody.querySelector('#sv-backends-root')) {
          settings.backendDefaults = window.backendsPanel.readProjectDefaults(
            settingsViewerBody.querySelector('#sv-backends-root'));
        }

        const chipsBox = settingsViewerBody.querySelector('#sv-project-tags-chips');
        if (chipsBox) {
          const tags = Array.from(chipsBox.querySelectorAll('.settings-tag-chip'))
            .filter(c => c.dataset.tag)
            .map(c => ({ tag: c.dataset.tag, color: c.dataset.color || tagColor(c.dataset.tag) }));
          try { await window.api.projectTagsSet(projectPath, tags); } catch {}
        }
      } else {
        // Claude's launch options are saved by the Backends panel now (backendDefaults.claude), not
        // here — this section keeps only the settings that are NOT a backend's launch option.
        {
          // 0 = no limit — preserve a literal 0; only fall back to the default
          // for blank/garbage/negative input (#144).
          const parseLimit = (sel, def) => {
            const v = parseInt(settingsViewerBody.querySelector(sel).value, 10);
            return Number.isNaN(v) || v < 0 ? def : v;
          };
          settings.visibleSessionCount = parseLimit('#sv-visible-count', 10);
          settings.sessionMaxAgeDays = parseLimit('#sv-max-age', 3);
        }
        settings.autoHideDays = parseInt(settingsViewerBody.querySelector('#sv-auto-hide-days').value) || 0;
        {
          // Clamp semantics shared with the status bar via utils.js (#79).
          const clampPair = (warnSel, critSel, dWarn, dCrit) => clampUsageThreshold(
            parseInt(settingsViewerBody.querySelector(warnSel).value, 10) || dWarn,
            parseInt(settingsViewerBody.querySelector(critSel).value, 10) || dCrit,
            dWarn, dCrit);
          const five = clampPair('#sv-usage-5h-warn', '#sv-usage-5h-crit', 60, 80);
          const seven = clampPair('#sv-usage-7d-warn', '#sv-usage-7d-crit', 75, 90);
          settings.usage5hWarn = five.warn;
          settings.usage5hCrit = five.crit;
          settings.usage7dWarn = seven.warn;
          settings.usage7dCrit = seven.crit;
        }
        {
          // Which backends the status bar shows (#191). Global-only — and it already is: this whole
          // branch is the global one, like backend activation itself.
          //
          // MERGE over the stored map, never replace it: the rows on screen are only the backends that
          // are enabled right now, so writing a fresh object from them would silently drop the tick of a
          // backend the user has temporarily switched off. Turning Codex off for a day must not erase
          // the wish to see its usage when it comes back.
          const stored = { ...((globalSettings || {}).usageBackends || {}) };
          settingsViewerBody.querySelectorAll('.sv-usage-backend').forEach(cb => {
            stored[cb.dataset.backend] = !!cb.checked;
          });
          settings.usageBackends = stored;
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
        settings.gpuAcceleration = settingsViewerBody.querySelector('#sv-gpu-acceleration').value || 'auto';
        // Select only rendered on Windows — keep the stored value elsewhere.
        {
          const conptyEl = settingsViewerBody.querySelector('#sv-conpty-backend');
          if (conptyEl) settings.conptyBackend = conptyEl.value === 'system' ? 'system' : 'bundled';
        }
        settings.terminalCloseBehavior = settingsViewerBody.querySelector('#sv-terminal-close-behavior').value || 'kill';
        settings.settingsOpenMode = settingsViewerBody.querySelector('#sv-settings-open-mode').value || 'overlay';
        settings.sidebarCollapseDefault = settingsViewerBody.querySelector('#sv-collapse-default').value || 'remember';
        settings.sessionDisplayMode = settingsViewerBody.querySelector('#sv-display-mode').value || 'grid';
        settings.projectSortMode = settingsViewerBody.querySelector('#sv-project-sort')?.value || 'activity';
        settings.favoritesOwnList = !!settingsViewerBody.querySelector('#sv-favorites-own-list')?.checked;
        settings.subagentLiveStatus = !!settingsViewerBody.querySelector('#sv-subagent-live-status')?.checked;
        settings.stickyAttentionInbox = !!settingsViewerBody.querySelector('#sv-sticky-attention-inbox')?.checked;
        {
          // The two handoff prompts. Empty, or unchanged from the built-in default ⇒ store '' so the
          // runtime default is used (never freeze a copy of it into the user's settings).
          const hp = settingsViewerBody.querySelector('#sv-handoff-prompt')?.value || '';
          settings.handoffPrompt = (hp.trim() && hp.trim() !== defaultHandoffPrompt.trim()) ? hp : '';
          const rp = settingsViewerBody.querySelector('#sv-handoff-read-prompt')?.value || '';
          settings.handoffReadPrompt = (rp.trim() && rp.trim() !== defaultHandoffReadPrompt.trim()) ? rp : '';
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
        settings.restoreSessionsOnLaunch = settingsViewerBody.querySelector('#sv-restore-sessions').checked;
        settings.confirmQuitWithRunningSessions = settingsViewerBody.querySelector('#sv-confirm-quit').checked;
        // The attention hook now lives on the CLAUDE backend page (it patches Claude's own
        // settings.json, so it belongs to Claude — but it is not a launch option, hence still a plain
        // global setting). That page is only in the DOM while it is open: keep the stored value when
        // it is not, instead of silently switching the hook off.
        {
          const el = settingsViewerBody.querySelector('#sv-attention-hooks');
          settings.attentionHooks = el ? el.checked : attentionHooksValue;
        }
        const svSecretCleanup = settingsViewerBody.querySelector('#sv-secret-ref-cleanup');
        if (svSecretCleanup) settings.secretRefCleanupOnSessionStop = svSecretCleanup.checked;
        const svSecretSweep = settingsViewerBody.querySelector('#sv-secret-ref-sweep');
        if (svSecretSweep) settings.secretRefSweepMinutes = Math.max(0, parseInt(svSecretSweep.value, 10) || 0);
        settings.shellProfile = settingsViewerBody.querySelector('#sv-shell-profile').value || 'auto';
        settings.terminalShellProfile = settingsViewerBody.querySelector('#sv-terminal-shell-profile')?.value || 'inherit';
        settings.logLevel = settingsViewerBody.querySelector('#sv-log-level')?.value || 'info';
        // Backends (T-2.3/T-2.6): backendEnabled.<id> + defaultLaunchTarget (both global-only) and
        // backendDefaults.<id>.<opt>. Null when the section never mounted — then leave the stored
        // values alone rather than clobbering them with an empty object.
        {
          const bs = window.backendsPanel
            ? window.backendsPanel.readGlobal(settingsViewerBody.querySelector('#sv-backends-root'))
            : null;
          if (bs) {
            settings.backendEnabled = bs.backendEnabled;
            settings.defaultLaunchTarget = bs.defaultLaunchTarget;
            settings.backendDefaults = bs.backendDefaults;
            // Per-backend environment variables. Only a template could carry a bundle before, so the
            // only way to give Codex a variable was to wrap it in a whole extra backend.
            settings.backendEnv = bs.backendEnv;
            // Per-backend handoff prompt override (empty = use the global one). NOT a launch option —
            // it is typed into the running agent, not put on its command line.
            settings.handoffPromptByBackend = bs.handoffPromptByBackend;
            settings.handoffReadPromptByBackend = bs.handoffReadPromptByBackend;
          }
        }
        // Templates (profiles.json) are STAGED by their editor and committed here — so this one Save
        // means the same thing everywhere on the screen, and Cancel really cancels. They live in their
        // own store, not in the settings blob, hence the separate call rather than another key above.
        if (window.backendsPanel && typeof window.backendsPanel.commitTemplates === 'function') {
          const res = await window.backendsPanel.commitTemplates();
          if (res && !res.ok && typeof showControlMessage === 'function') {
            await showControlMessage({
              title: 'Some templates were not saved',
              message: res.errors.join('\n'),
              tone: 'danger',
            });
          }
        }
        // Terminal tools (T-3.10): the GLOBAL launcher list — the template every project inherits.
        // Null when the panel never mounted → leave the stored list alone.
        {
          const ls = window.launchersPanel
            ? window.launchersPanel.read(settingsViewerBody.querySelector('#sv-launchers-root'))
            : null;
          if (ls) settings.customLaunchers = ls;
        }
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

      // Keep the profiles store's own default in step with the single default marker: if the
      // default launch target is a user profile, it is also the default profile; otherwise no
      // profile is the default (a plain Claude launch must not pick one up).
      if (!isProject && settings.defaultLaunchTarget && window.api.profiles) {
        try {
          const res = await window.api.profiles.list();
          const isProfile = ((res && res.profiles) || []).some(p => p.id === settings.defaultLaunchTarget);
          await window.api.profiles.setDefault(isProfile ? settings.defaultLaunchTarget : null);
        } catch {}
      }

      // Standalone settings window: tell the main window to re-apply the changes
      // (it owns the live UI). The in-app overlay applies directly below instead.
      if (window.__SETTINGS_WINDOW__ && !isProject && typeof window.api.notifySettingsChanged === 'function') {
        window.api.notifySettingsChanged();
      }

      // Update visibleSessionCount, sessionMaxAgeDays, and theme
      if (!isProject) {
        if (settings.visibleSessionCount != null && typeof window._setVisibleSessionCount === 'function') {
          window._setVisibleSessionCount(settings.visibleSessionCount);
        }
        if (settings.sessionMaxAgeDays != null && typeof window._setSessionMaxAge === 'function') {
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
        if (typeof window._setGpuAcceleration === 'function') {
          window._setGpuAcceleration(settings.gpuAcceleration || 'auto');
        }
        if (typeof window._setUsageThresholds === 'function') {
          window._setUsageThresholds({ fiveHWarn: settings.usage5hWarn, fiveHCrit: settings.usage5hCrit, sevenDWarn: settings.usage7dWarn, sevenDCrit: settings.usage7dCrit });
        }
        if (settings.usageBackends && typeof window._setUsageBackendSelection === 'function') {
          window._setUsageBackendSelection(settings.usageBackends);
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
      // Rebuild the sidebar tag-filter chips so newly added/removed tags show up.
      if (isProject && typeof window._refreshProjectTagFilter === 'function') {
        window._refreshProjectTagFilter();
      }

      // Write/remove the reversible ~/.claude hook when the toggle changes
      if (!isProject && settings.attentionHooks !== attentionHooksValue) {
        try { await window.api.configureAttentionHook(settings.attentionHooks); } catch {}
      }

      // Log level applies live — no restart (#121).
      if (!isProject && settings.logLevel !== logLevelValue) {
        try { await window.api.setLogLevel(settings.logLevel); } catch {}
      }
    }

    // The green "✓ Saved" both buttons show.
    const flashSaved = (btn) => {
      btn.textContent = '✓ Saved';
      btn.classList.add('is-saved');
    };

    // Save button
    svBtn('#sv-save-btn').addEventListener('click', async () => {
      await persistSettings();
      flashSaved(svBtn('#sv-save-btn'));
      setTimeout(() => closeSettingsViewer(), 600);
    });

    // Apply button (#177): save and stay, so several categories can be adjusted and
    // checked one after another. The panel is rebuilt from the SAVED state afterwards
    // — the editors, and the values this closure compares against (the attention hook,
    // the log level, the shortcuts working copy), all have to move on with it, or a
    // second Apply would re-fire changes that are no longer changes, and a Cancel would
    // still be holding the pre-Apply state. Rebuilding is what makes Apply idempotent
    // and leaves Cancel discarding only what was edited since.
    svBtn('#sv-apply-btn').addEventListener('click', async () => {
      await persistSettings();
      flashSaved(svBtn('#sv-apply-btn'));
      // Come back to the category the user was on, not to the top of the nav.
      const activeCat = settingsViewerBody.querySelector('.settings-nav-item.active')?.dataset.cat || null;
      const openedAt = viewerGeneration;
      setTimeout(async () => {
        // The rebuild must not outlive the panel it is rebuilding. Cancel, a click into a
        // session, or a second Apply within the 600 ms would otherwise be undone by this
        // timer — it reopens the settings over whatever the user is now looking at.
        if (viewerGeneration !== openedAt || !viewerIsOpen()) return;
        await openSettingsViewer(scope, projectPath);
        if (activeCat) settingsViewerBody.querySelector(`.settings-nav-item[data-cat="${activeCat}"]`)?.click();
      }, 600);
    });

    // Cancel button
    svBtn('#sv-cancel-btn').addEventListener('click', () => {
      stopShortcutCapture();
      closeSettingsViewer();
    });

    // Hide and Remove are different things (#167), so the project page offers both. It used to have one
    // button that said "Hide" and called removeProject — back when they were the same act.
    const closeAfterProjectAction = () => {
      settingsViewer.style.display = 'none';
      document.getElementById('placeholder').style.display = 'flex';
      if (typeof loadProjects === 'function') loadProjects();
    };

    const hideBtn = svBtn('#sv-remove-btn');
    if (hideBtn) {
      hideBtn.addEventListener('click', async () => {
        const confirmed = await showControlDialog({
          title: 'Hide Project',
          message: 'The project stays on the list, Switchboard just stops showing it. New sessions do not bring it back — restore it from the hidden list. No files are deleted.',
          confirmLabel: 'Hide Project',
          tone: 'warning',
          details: { Project: shortName, Path: projectPath },
        });
        if (!confirmed) return;
        const res = await window.api.hideProject(projectPath);
        if (res && res.error) { if (typeof toast === 'function') toast('Hide: ' + res.error); return; }
        closeAfterProjectAction();
      });
    }

    const removeProjectBtn = svBtn('#sv-remove-project-btn');
    if (removeProjectBtn) {
      removeProjectBtn.addEventListener('click', async () => {
        const confirmed = await showControlDialog({
          title: 'Remove Project',
          message: 'The project comes off the list and its cached sessions are cleared. Your transcripts stay on disk: the old ones will not bring it back, but a NEW session in this folder will. To delete the history itself, use Remove in Settings → Projects.',
          confirmLabel: 'Remove Project',
          tone: 'warning',
          details: { Project: shortName, Path: projectPath },
        });
        if (!confirmed) return;
        const res = await window.api.removeProject(projectPath);
        if (res && res.error) { if (typeof toast === 'function') toast('Remove: ' + res.error); return; }
        closeAfterProjectAction();
      });
    }
  }

  // Expose globally
  window.openSettingsViewer = openSettingsViewer;
  window.closeSettingsViewer = closeSettingsViewer;
})();
