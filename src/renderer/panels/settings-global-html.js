// --- Settings: the global settings form's markup (#218) ---
//
// One function, one template literal: the whole two-pane global settings form — the nav and all twelve
// category panes. It is the largest single thing that was inside `openSettingsViewer`, and the only part
// of this file's #218 split that is pure string building: it reads values, it touches no DOM and binds no
// listener. settings-panel.js assigns the result to `settingsViewerBody.innerHTML` and then wires the
// controls the usual way.
//
// WHY IT TAKES ONE OBJECT AND DESTRUCTURES IT
//
//   Every name below used to be a local of `openSettingsViewer`, read directly by the template. Rewriting
//   ~57 reads to `v.thing` would have been ~57 chances to typo one — and a typo does not throw. It renders
//   the literal text `undefined` where a value was interpolated, or an empty control where a ternary read
//   it, silently, in a form nothing tests and nothing loads. So the template text moved unchanged (bar one
//   dropped leading newline — a whitespace text node before a block element); the destructure below is what
//   makes the old names resolve again. The diff is a move, not a rewrite, which is the only reason it can
//   be checked by reading it.
//
//   The list was computed, not hand-written: walk the template for identifiers, keep the ones declared as
//   locals of `openSettingsViewer`. Two of them (handoffPromptValue, handoffReadPromptValue) appear only in
//   the last ninety lines — a hand-picked list would plausibly have missed exactly those, and the result
//   would have been two blank textareas and a green suite. The walk is not infallible either: its first
//   version matched identifiers in the template's TEXT, so it also "found" `current` in the prose "the
//   current projects stay" and passed a value nothing reads. Match `${...}` expressions, not words.
//
// A NAME DROPPED FROM THE DESTRUCTURE THROWS rather than rendering blank — it becomes a free identifier
// with no global to catch it. That is worth knowing and worth not over-trusting: it holds only as long as
// no top-level declaration anywhere in the shared scope happens to share the name (nothing guards that),
// and it does NOT cover the other direction — drop a key from the CALL SITE while it stays in the
// destructure and you get `undefined`, silently.
//
// EVERY VALUE IS A SNAPSHOT, AND THAT IS CORRECT: the form is rendered once per open, before any of the
// sections wire themselves. `scShortcuts` is a `let` that the shortcut section later rebinds — this
// renders the bindings as they are at open time, which is exactly what the old inline template did.
//
// NOT passed, because they are not locals — this is the file's silent-capture register, and it is complete:
//   escapeHtml                                        lib/utils.js
//   SHORTCUT_DEFS, SHORTCUT_GROUPS,
//   shortcutDefsByGroup, formatBinding                shell/shortcuts.js
//   TERMINAL_THEMES                                   terminal/terminal-themes.js
// All six are top-level declarations of classic scripts, so they resolve at call time from the shared
// global scope, and both index.html and settings.html load all three defining files. Keep this list
// honest: it is the only place that records what this file reaches for outside its own arguments.

(function () {
  'use strict';

  function settingsGlobalHtml(v) {
    const {
      DEFAULT_TERMINAL_FONT, TERMINAL_FONT_PRESETS, advChev, attentionSoundValue, autoHideDaysValue,
      collapseDefaultValue, vcsChipEnabledValue, vcsShowBadgeValue, vcsPollSecondsValue, vcsCountUntrackedValue,
      confirmQuitValue, conptyBackendValue, displayModeValue,
      externalEditorValue, fileClickTargetValue, markdownDefaultViewValue, favoritesOwnListValue, gpuAccelValue, handoffPromptValue,
      handoffReadPromptValue, help, isMacPlatform, isWinPlatform, logLevelValue, maxAgeValue,
      mouseModeValue, nextAttentionShortcutLabel, notifyEnabledValue, notifyOnReadyValue,
      projectAutoAddValue, projectSortValue, restoreSessionsValue, rightClickValue,
      runningInboxMinutesValue, runningInboxModeValue, scIsMac, scShortcuts, secretRefCleanupValue,
      secretRefSweepValue, settingsOpenModeValue, shellProfileValue, shellProfiles,
      stickyAttentionInboxValue, subagentLiveStatusValue, showSubagentsValue, subagentLayoutValue, hasSubagentsValue,
      orphanSubagentMaxAgeDaysValue,
      tabAutoCloseDelayValue, tabAutoCloseModeValue,
      tabCloseValue, tabDragValue, tabMiddleClickValue, tabPositionValue, tabsLiveRenderValue,
      terminalCloseValue, terminalFontCustomValue, terminalFontSelectValue, terminalFontSizeValue,
      terminalShellProfileValue, themeValue, usage5hCritValue, usage5hWarnValue, usage7dCritValue,
      usage7dWarnValue, usageBackendRowsHtml, visCountValue,
    } = v;

    return `      <div class="settings-shell">
        <nav class="settings-nav">
          <div class="settings-search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#7a7a90" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
            <input id="sv-search" type="text" placeholder="Search settings…" autocomplete="off">
          </div>
          <button class="settings-nav-item active" data-cat="sessions">Sessions &amp; CLI <span class="settings-nav-count">6</span></button>
          <button class="settings-nav-item" data-cat="terminal">Terminal <span class="settings-nav-count">10</span></button>
          <button class="settings-nav-item settings-nav-sub" data-cat="tools">Terminal tools</button>
          <button class="settings-nav-item" data-cat="layout">Layout &amp; Tabs <span class="settings-nav-count">10</span></button>
          <button class="settings-nav-item" data-cat="projects">Projects &amp; Sidebar <span class="settings-nav-count">11</span></button>
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

              <div class="settings-subhead">Appearance</div>
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

              <div class="settings-subhead">Input &amp; behaviour</div>
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
                    <div class="settings-field-header"><span class="settings-label">Clicking a file link opens</span>${help}</div>
                    <div class="settings-description">What a plain click on a terminal file link does. Ctrl/Cmd+click always opens the other one.</div>
                    <div class="settings-more"><b>Internal panel</b>: the built-in file viewer/editor. <b>External editor</b>: the configured external editor (or your OS default). Either way, holding Ctrl/Cmd while clicking opens the opposite target.</div>
                  </div>
                  <div class="settings-field-control">
                    <select class="settings-select" id="sv-file-click-target">
                      <option value="internal" ${fileClickTargetValue !== 'external' ? 'selected' : ''}>Internal panel</option>
                      <option value="external" ${fileClickTargetValue === 'external' ? 'selected' : ''}>External editor</option>
                    </select>
                  </div>
                </div>
                <div class="settings-field">
                  <div class="settings-field-info">
                    <div class="settings-field-header"><span class="settings-label">Markdown files open as</span>${help}</div>
                    <div class="settings-description">How a Markdown file first opens in the internal editor. The preview toggle in the viewer still overrides this per file.</div>
                    <div class="settings-more"><b>Code</b>: the source editor. <b>Rendered preview</b>: the read-only rendered view. This only sets the initial mode; switching in the viewer is remembered per viewer as before.</div>
                  </div>
                  <div class="settings-field-control">
                    <select class="settings-select" id="sv-markdown-default-view">
                      <option value="code" ${markdownDefaultViewValue !== 'preview' ? 'selected' : ''}>Code</option>
                      <option value="preview" ${markdownDefaultViewValue === 'preview' ? 'selected' : ''}>Rendered preview</option>
                    </select>
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

              <div class="settings-subhead">Layout</div>
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

              <div class="settings-subhead">Tabs</div>
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

              <div class="settings-subhead">Projects</div>
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
                    <div class="settings-more">On: every project a session is discovered in appears automatically, from any backend. Off: the current projects stay and new ones no longer appear on their own — add them with the + button (starting a session from Switchboard also adds its project). Switching back on restores full auto-discovery.</div>
                  </div>
                  <div class="settings-field-control">
                    <label class="settings-toggle"><input type="checkbox" id="sv-project-auto-add" ${projectAutoAddValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
                  </div>
                </div>
              </div>

              ${hasSubagentsValue ? `
              <div class="settings-subhead">Version control</div>
              <div class="settings-section">
                <div class="settings-field">
                  <div class="settings-field-info">
                    <span class="settings-label">Show version-control status</span>
                    <div class="settings-description">Branch and change counts on project/worktree headers and cards, with a click-through to the changed files.</div>
                  </div>
                  <div class="settings-field-control">
                    <label class="settings-toggle"><input type="checkbox" id="sv-vcs-enabled" ${vcsChipEnabledValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
                  </div>
                </div>
                <div class="settings-field">
                  <div class="settings-field-info">
                    <span class="settings-label">Show branch &amp; change counts</span>
                    <div class="settings-description">Off shows only the git button (opens the changes window); on adds the branch and file-count badge.</div>
                  </div>
                  <div class="settings-field-control">
                    <label class="settings-toggle"><input type="checkbox" id="sv-vcs-badge" ${vcsShowBadgeValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
                  </div>
                </div>
                <div class="settings-field">
                  <div class="settings-field-info">
                    <span class="settings-label">Version-control poll interval</span>
                    <div class="settings-description">How often live working trees are checked, in seconds (minimum 5).</div>
                  </div>
                  <div class="settings-field-control">
                    <input type="number" class="settings-input settings-input-compact" id="sv-vcs-poll" min="5" max="600" value="${vcsPollSecondsValue}">
                  </div>
                </div>
                <div class="settings-field">
                  <div class="settings-field-info">
                    <span class="settings-label">Count untracked files</span>
                    <div class="settings-description">Off skips untracked scanning (git <code>-uno</code>) — faster and quieter in large repositories.</div>
                  </div>
                  <div class="settings-field-control">
                    <label class="settings-toggle"><input type="checkbox" id="sv-vcs-count-untracked" ${vcsCountUntrackedValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
                  </div>
                </div>
              </div>

              <div class="settings-subhead">Subagents</div>
              <div class="settings-section">
                <div class="settings-field">
                  <div class="settings-field-info">
                    <div class="settings-field-header"><span class="settings-label">Show subagents</span>${help}</div>
                    <div class="settings-description">Show a session's Task subagents as nested rows in the sidebar.</div>
                    <div class="settings-more">Off hides the subagent caret and its nested rows entirely — the parent session still shows normally.</div>
                  </div>
                  <div class="settings-field-control">
                    <label class="settings-toggle"><input type="checkbox" id="sv-show-subagents" ${showSubagentsValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
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
                    <div class="settings-field-header"><span class="settings-label">Subagent row layout</span>${help}</div>
                    <div class="settings-description">How each subagent row is laid out. The per-type colour is kept in every option.</div>
                    <div class="settings-more"><b>Title first, type demoted</b>: title on its own line, the type small in the meta line (calmest). <b>Three lines</b>: title, then a small type badge, then the stats. <b>Badge only when non-default</b>: a badge only when the type differs from general-purpose.</div>
                  </div>
                  <div class="settings-field-control">
                    <select class="settings-select" id="sv-subagent-layout">
                      <option value="a" ${subagentLayoutValue === 'a' ? 'selected' : ''}>Title first, type demoted</option>
                      <option value="b" ${subagentLayoutValue === 'b' ? 'selected' : ''}>Three lines</option>
                      <option value="c" ${subagentLayoutValue === 'c' ? 'selected' : ''}>Badge only when non-default</option>
                    </select>
                  </div>
                </div>
                <div class="settings-field">
                  <div class="settings-field-info">
                    <div class="settings-field-header"><span class="settings-label">Hide orphan subagents older than (days)</span>${help}</div>
                    <div class="settings-description">Drop stale entries from the "Orphan subagents" group in the sidebar. 0 = never hide.</div>
                    <div class="settings-more">An orphan is a subagent whose parent session no longer exists — its transcript outlives the session that spawned it, and those pile up over months. This only hides rows; nothing is deleted, and lowering the value brings them back. Subagents nested under a visible parent are never affected.</div>
                  </div>
                  <div class="settings-field-control">
                    <input type="number" class="settings-input settings-input-compact" id="sv-orphan-subagent-max-age" min="0" max="365" value="${orphanSubagentMaxAgeDaysValue}">
                  </div>
                </div>
              </div>
              ` : ''}

              <div class="settings-subhead">Session list</div>
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
              <details class="settings-adv settings-explainer">
                <summary>${advChev}How a handoff works</summary>
                <div class="settings-explainer-body">A handoff is a packet that summarises the state of the work, written by an agent. You choose who writes it: <b>this session's agent</b> (it summarises what it is holding — it is resumed for one turn if it is not running), or <b>a new session</b> (a fresh agent reads this session's transcript and writes the packet itself). Each has its own prompt below, and each can be overridden per backend on its page under <b>Backends</b>.</div>
              </details>

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
              <div class="settings-section">
                <div class="about-app">
                  <div class="about-name">Switchboard</div>
                  <div class="about-version">Version <span id="sv-about-version">…</span> · <code>deadeye</code> · <code id="sv-about-build">…</code></div>
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
  }

  window.settingsGlobalHtml = settingsGlobalHtml;
})();
