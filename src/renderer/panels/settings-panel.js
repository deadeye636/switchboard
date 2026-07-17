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
      // The form itself — the nav and all twelve category panes — is panels/settings-global-html.js
      // (#218). It is pure string building, so it moved out whole and unchanged; what stays here is the
      // values it renders and the wiring below. The names are passed as one object and destructured
      // there, so the template text never had to be rewritten — see that file's header for why that
      // mattered: a mistyped read renders an empty field rather than throwing.
      settingsViewerBody.innerHTML = window.settingsGlobalHtml({
        DEFAULT_TERMINAL_FONT, TERMINAL_FONT_PRESETS, advChev, attentionSoundValue, autoHideDaysValue,
        collapseDefaultValue, confirmQuitValue, conptyBackendValue, displayModeValue,
        externalEditorValue, favoritesOwnListValue, gpuAccelValue, handoffPromptValue,
        handoffReadPromptValue, help, isMacPlatform, isWinPlatform, logLevelValue, maxAgeValue,
        mouseModeValue, nextAttentionShortcutLabel, notifyEnabledValue, notifyOnReadyValue,
        projectAutoAddValue, projectSortValue, restoreSessionsValue, rightClickValue,
        runningInboxMinutesValue, runningInboxModeValue, scIsMac, scShortcuts, secretRefCleanupValue,
        secretRefSweepValue, settingsOpenModeValue, shellProfileValue, shellProfiles,
        stickyAttentionInboxValue, subagentLiveStatusValue, tabAutoCloseDelayValue, tabAutoCloseModeValue,
        tabCloseValue, tabDragValue, tabMiddleClickValue, tabPositionValue, tabsLiveRenderValue,
        terminalCloseValue, terminalFontCustomValue, terminalFontSelectValue, terminalFontSizeValue,
        terminalShellProfileValue, themeValue, usage5hCritValue, usage5hWarnValue, usage7dCritValue,
        usage7dWarnValue, usageBackendRowsHtml, visCountValue,
      });

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
