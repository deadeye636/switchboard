// public/backends-panel.js — Settings → Backends: the manage list, the per-backend "Launch
// defaults" panels and the profile editor modal (Phase 2, T-2.3/T-2.4/T-2.6).
//
// Built on the EXISTING settings primitives (.settings-section / .settings-field / .settings-toggle
// / .settings-select) so the section reads like the rest of Settings, not a foreign panel. The
// editor modal reuses .new-session-overlay / .new-session-dialog.
//
// It owns the DOM of the section; settings-panel.js mounts it and reads the values back at save
// time (readGlobal / readProjectDefaults). The settings keys written:
//   backendEnabled.<id>          boolean, GLOBAL-only (a `planned` backend can never be enabled)
//   defaultLaunchTarget          backendId — the ONE "default" marker in the UI
//   backendDefaults.<id>.<opt>   per-backend launch options, generated from that backend's configFields
//
// Profiles (user Axis-A backends) are NOT settings — they live in profiles.json and are written
// through immediately via window.api.profiles.* (like the tag store), never on the Save button.
//
// Secrets: an env value is a `$VAR` reference resolved at spawn. Raw keys are blocked by the main
// process (profiles.save -> {ok:false, secretKeys}); the editor surfaces that and only retries with
// allowSecrets after an explicit confirm.
(function () {
  'use strict';

  const esc = (s) => (typeof escapeHtml === 'function'
    ? escapeHtml(String(s == null ? '' : s))
    : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));

  // Icons offered in the editor's icon grid (drives the badge colour + monogram).
  const ICON_KEYS = ['anthropic', 'claude', 'deepseek', 'glm', 'openrouter', 'codex', 'agy', 'hermes', 'pi'];

  // Launch defaults live on a per-backend page now, so at most one backend's inputs exist in the DOM.
  // `storedDefaults` = what this settings scope has on disk; `pendingDefaults` = what the user changed
  // since the panel mounted, on any page. Save reads stored ⊕ pending — never the DOM alone.
  let storedDefaults = {};      // what THIS scope has on disk
  let inheritedDefaults = {};   // project scope only: what it would inherit from global
  let pendingDefaults = {};     // edited since the panel mounted, on any page
  let clearedDefaults = {};     // project scope: overrides the user handed back to the global default
  let storedHandoffPrompts = {};  // handoffPromptByBackend on disk
  let pendingHandoffPrompts = {}; // ...edited in this settings session

  // One-line blurb per built-in backend (the descriptor carries no description).
  const BACKEND_BLURB = {
    claude: 'Anthropic — the default backend, always available.',
    codex: "OpenAI's terminal coding agent.",
    hermes: 'General AI agent with its own session store.',
    pi: 'Terminal coding agent.',
    agy: "Google's terminal coding agent (Antigravity CLI, the successor to the retired Gemini CLI).",
  };

  const ENV_REF_RE = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;
  const envRefName = (value) => {
    const m = ENV_REF_RE.exec(String(value == null ? '' : value).trim());
    return m ? m[1] : null;
  };

  function iconEl(key, size, opts) {
    if (typeof window.renderBackendIcon === 'function') return window.renderBackendIcon(key, size, opts);
    const span = document.createElement('span');
    span.className = 'backend-icon';
    span.textContent = String(key || '?').slice(0, 2).toUpperCase();
    return span;
  }

  // Fill every <span class="backend-icon-slot" data-icon="…"> under `root` with a real SVG badge.
  // The slot pattern keeps the surrounding markup a plain HTML string while the icon itself is
  // built with createElementNS (XSS-safe for user-supplied profile names/icons).
  function paintIcons(root) {
    root.querySelectorAll('.backend-icon-slot').forEach(slot => {
      if (slot.firstChild) return;
      const size = parseInt(slot.dataset.size, 10) || 20;
      slot.appendChild(iconEl(slot.dataset.icon || 'default', size, {
        monogram: slot.dataset.monogram || undefined,
      }));
    });
  }

  async function confirmDialog(options) {
    if (typeof showControlDialog === 'function') return showControlDialog(options);
    return window.confirm(`${options.title}\n\n${options.message}`);
  }

  // A profile's auth reference, for the row's one-line description.
  function authRefOf(profile) {
    const env = (profile && profile.env) || {};
    for (const k of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
      const ref = envRefName(env[k]);
      if (ref) return '$' + ref;
    }
    return null;
  }

  function slugId(name, taken) {
    let base = String(name || 'profile').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!base) base = 'profile';
    base = base.slice(0, 56);
    let id = base;
    let n = 2;
    while (taken.has(id)) { id = `${base}-${n++}`; }
    return id;
  }

  // ---------------------------------------------------------------------------
  // Launch defaults (T-2.6) — generated from a backend's own `configFields`.
  // ---------------------------------------------------------------------------

  function configFieldControl(backendId, field, value, disabled) {
    const name = `bd-${backendId}-${field.id}`;
    const dis = disabled ? 'disabled' : '';
    if (field.type === 'toggle') {
      return `<label class="settings-toggle"><input type="checkbox" class="backend-default-input" data-backend="${esc(backendId)}" data-opt="${esc(field.id)}" data-type="toggle" id="${esc(name)}" ${value ? 'checked' : ''} ${dis}><span class="settings-toggle-slider"></span></label>`;
    }
    if (field.type === 'select') {
      const choices = Array.isArray(field.choices) ? field.choices : [];
      const labels = field.choiceLabels || {};   // a bare id like "acceptEdits" is not a UI label
      return `<select class="settings-select backend-default-input" data-backend="${esc(backendId)}" data-opt="${esc(field.id)}" data-type="select" id="${esc(name)}" ${dis}>
        ${choices.map(c => `<option value="${esc(c)}" ${String(value) === String(c) ? 'selected' : ''}>${esc(labels[c] || c)}</option>`).join('')}
      </select>`;
    }
    const type = field.type === 'number' ? 'number' : 'text';
    const cls = field.type === 'number' ? 'settings-input settings-input-compact' : 'settings-input';
    return `<input type="${type}" class="${cls} backend-default-input" data-backend="${esc(backendId)}" data-opt="${esc(field.id)}" data-type="${esc(field.type || 'text')}" id="${esc(name)}" value="${esc(value == null ? '' : value)}" ${dis}>`;
  }

  // A backend's launch options live on its OWN page, reached by the gear on its row (`launchDefaultsPage`
  // below). EVERY backend has one, Claude included (`backendDefaults.<id>.<opt>`, 00 §4a).
  //
  // The PROJECT scope has no gear pages — it is one short "what this project overrides" list, so there
  // every backend's options are shown inline under its own heading.
  //
  // Each OPTION carries its own "Use global default" checkbox (#149). The defaults cascade per option:
  // a project stores only what it actually overrides, so overriding one Codex option does not freeze
  // every other backend's defaults at the value they happened to have that day.
  function inlineDefaultsSection(backend, ownDefaults, globalDefaults) {
    const fields = Array.isArray(backend.configFields) ? backend.configFields : [];
    if (!fields.length) return '';
    const own = (ownDefaults && ownDefaults[backend.id]) || {};
    const inherited = (globalDefaults && globalDefaults[backend.id]) || {};

    const rows = fields.map(f => {
      const overridden = own[f.id] !== undefined && own[f.id] !== null;
      const value = overridden ? own[f.id]
        : (inherited[f.id] !== undefined ? inherited[f.id] : f.default);
      return `
        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">${esc(f.label || f.id)}</span>
              <label class="settings-use-global">
                <input type="checkbox" class="backend-inherit-cb" data-backend="${esc(backend.id)}" data-opt="${esc(f.id)}" ${overridden ? '' : 'checked'}>
                Use global default
              </label>
            </div>
            <div class="settings-description">Used when you start a ${esc(backend.label)} session in this project without opening its configure dialog.</div>
          </div>
          <div class="settings-field-control">${configFieldControl(backend.id, f, value, !overridden)}</div>
        </div>`;
    }).join('');

    return `
      <div class="settings-section">
        <div class="settings-section-title backend-inline-title">
          <span class="backend-icon-slot" data-icon="${esc(backend.icon || backend.colour || backend.id)}" data-size="16" ${backend.monogram ? `data-monogram="${esc(backend.monogram)}"` : ''}></span>
          ${esc(backend.label)}
        </div>
        ${rows}
      </div>`;
  }

  function launchDefaultsPage(backend, defaults, disabled, extraHtml) {
    const fields = Array.isArray(backend.configFields) ? backend.configFields : [];
    const stored = (defaults && defaults[backend.id]) || {};
    const rows = fields.map(f => {
      const value = stored[f.id] !== undefined ? stored[f.id] : f.default;
      return `
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">${esc(f.label || f.id)}</span>
            <div class="settings-description">Used when you start a ${esc(backend.label)} session without opening its configure dialog.</div>
          </div>
          <div class="settings-field-control">${configFieldControl(backend.id, f, value, disabled)}</div>
        </div>`;
    }).join('');

    return `
      <div class="backend-page" data-backend-page="${esc(backend.id)}">
        <div class="backend-page-head">
          <button type="button" class="backend-back" data-act="back">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
            Backends
          </button>
          <div class="backend-page-title">
            <span class="backend-icon-slot" data-icon="${esc(backend.icon || backend.colour || backend.id)}" data-size="20" ${backend.monogram ? `data-monogram="${esc(backend.monogram)}"` : ''}></span>
            <h3>${esc(backend.label)}</h3>
          </div>
        </div>
        ${backend.caveat ? `<div class="settings-notice backend-caveat">${esc(backend.caveat)}</div>` : ''}
        ${rows
          ? `<div class="settings-section"><div class="settings-section-title">Launch defaults</div>${rows}</div>`
          : '<div class="settings-hint">This backend declares no launch options.</div>'}
        ${extraHtml || ''}
      </div>`;
  }

  // Claude-only extras that are NOT launch options (they touch no argv and no env), but ARE Claude's:
  // the attention hook patches Claude's OWN ~/.claude/settings.json and applies to every Claude session,
  // including ones Switchboard never started. It belongs to the backend, not to a generic app section —
  // but it is stored as a plain global setting, not under backendDefaults.
  // The handoff prompt, per backend. NOT a launch option (it reaches no argv and no env) — it is what we
  // TYPE INTO the running agent, so it is stored as its own setting: `handoffPromptByBackend.<id>`.
  // Empty = use the global prompt from Sessions & CLI.
  //
  // Why per backend at all: a CLI may want different wording, or have its own skill. And a slash command
  // is a Claude skill — the handoff path refuses to type one into a CLI that has none (it would be read
  // as plain text, the agent would answer nothing useful, and the capture step would then offer its
  // previous message as the "fresh" packet).
  const firstLine = (text) => String(text || '').split('\n')[0].trim();

  function handoffPromptHtml(backend, value, globalPrompt) {
    const hint = backend.slashCommands === true
      ? `Leave empty to use the global handoff prompt. A slash command set HERE is sent to ${esc(backend.label)} as-is — `
        + 'so this is the place to use one of its own commands or skills (a global slash command is only sent to your default agent, '
        + 'because commands do not carry across CLIs).'
      : `Leave empty to use the global handoff prompt. ${esc(backend.label)} has no slash commands, so a `
        + '<code>/command</code> would arrive as plain text and is never sent.';
    return `
      <div class="settings-section">
        <div class="settings-section-title">Handoff</div>
        <div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <span class="settings-label">Handoff prompt</span>
            <div class="settings-description">${hint} Placeholders: {goal} {project} {sessionId} {metrics}.</div>
          </div>
          <div class="settings-field-control">
            <textarea class="settings-input backend-handoff-prompt" rows="4" data-backend="${esc(backend.id)}"
              placeholder="${esc(firstLine(globalPrompt) || 'Use the global prompt')}">${esc(value || '')}</textarea>
          </div>
        </div>
      </div>`;
  }

  function claudeIntegrationsHtml(attentionHooksOn) {
    return `
      <div class="settings-section">
        <div class="settings-section-title">Integrations</div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Claude Code hooks for attention</span>
            <div class="settings-description">More reliable attention detection than the terminal check alone. Catches permission and tool prompts the terminal heuristic can miss. Adds a reversible hook to <code>~/.claude/settings.json</code>; turning this off removes it again.</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-attention-hooks" ${attentionHooksOn ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>
      </div>`;
  }

  // ---------------------------------------------------------------------------
  // The profile editor modal (T-2.3 / T-2.4).
  // ---------------------------------------------------------------------------

  // `seed` = { id?, name, icon, env, model, haikuModel } — an existing profile or a preset.
  // Resolves to true when a profile was saved.
  function openEditor(seed, takenIds) {
    return new Promise((resolve) => {
      const isNew = !seed.id;
      // Working copy: `env` is the source of truth; the Model field writes the whole model var set
      // into it via applyPresetModel (an un-redirected haiku model leaks the host key).
      let env = Object.assign({}, seed.env || {});
      let icon = seed.icon || 'anthropic';

      const overlay = document.createElement('div');
      overlay.className = 'new-session-overlay';
      const dialog = document.createElement('div');
      dialog.className = 'new-session-dialog backend-editor';
      overlay.appendChild(dialog);

      const modelSeed = seed.model !== undefined ? seed.model : (env.ANTHROPIC_MODEL || '');
      const haikuSeed = seed.haikuModel !== undefined ? seed.haikuModel : (env.ANTHROPIC_DEFAULT_HAIKU_MODEL || '');

      dialog.innerHTML = `
        <h3>${isNew ? 'New backend profile' : 'Edit backend profile'}</h3>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Name</span>
            <div class="settings-description">Shown in the launch menu and the session badge.</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="be-name" maxlength="100" value="${esc(seed.name || '')}" placeholder="DeepSeek (my key)">
          </div>
        </div>
        <div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <span class="settings-label">Icon</span>
            <div class="settings-description">Badge shown next to this backend's sessions.</div>
          </div>
          <div class="settings-field-control">
            <div class="backend-icon-grid" id="be-icons">
              ${ICON_KEYS.map(k => `<button type="button" class="backend-icon-choice" data-icon="${esc(k)}" aria-label="${esc(k)}" aria-pressed="false"><span class="backend-icon-slot" data-icon="${esc(k)}" data-size="22"></span></button>`).join('')}
            </div>
          </div>
        </div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Model</span>
            <div class="settings-description">Writes the whole model variable set at once (opus/sonnet/subagent).</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="be-model" value="${esc(modelSeed)}" placeholder="e.g. deepseek-v4-pro">
          </div>
        </div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Fast model</span>
            <div class="settings-description">The small/fast model, redirected to this endpoint. Leave empty to reuse the model above — never leave it pointing at Anthropic, that would send the host key to the wrong endpoint.</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="be-haiku" value="${esc(haikuSeed)}" placeholder="same as Model">
          </div>
        </div>
        <details class="settings-adv backend-env-adv" open>
          <summary><svg class="settings-adv-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 6l6 6-6 6"/></svg>Advanced — environment variables</summary>
          <div class="backend-env-hint">Secrets belong in a <code>$VAR</code> reference (e.g. <code>$DEEPSEEK_API_KEY</code>), resolved from your environment at launch. A literal key is rejected.</div>
          <div class="backend-env-rows" id="be-env-rows"></div>
          <button type="button" class="backend-btn" id="be-env-add">+ Add variable</button>
        </details>
        <div class="backend-editor-error" id="be-error" hidden></div>
        <div class="settings-btn-row">
          <button class="settings-cancel-btn" id="be-cancel">Cancel</button>
          <button class="settings-save-btn" id="be-save">Save profile</button>
        </div>`;

      document.body.appendChild(overlay);
      paintIcons(dialog);

      const nameInput = dialog.querySelector('#be-name');
      const modelInput = dialog.querySelector('#be-model');
      const haikuInput = dialog.querySelector('#be-haiku');
      const rowsBox = dialog.querySelector('#be-env-rows');
      const errorBox = dialog.querySelector('#be-error');

      const showError = (html) => { errorBox.innerHTML = html; errorBox.hidden = false; };
      const clearError = () => { errorBox.hidden = true; errorBox.innerHTML = ''; };

      // --- icon grid
      const paintIconChoice = () => {
        dialog.querySelectorAll('.backend-icon-choice').forEach(b => {
          const on = b.dataset.icon === icon;
          b.classList.toggle('selected', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
      };
      dialog.querySelector('#be-icons').addEventListener('click', (e) => {
        const btn = e.target.closest('.backend-icon-choice');
        if (!btn) return;
        icon = btn.dataset.icon;
        paintIconChoice();
      });
      paintIconChoice();

      // --- env rows (KEY / value) with a live resolve status per $VAR row (UX#3)
      function renderRows() {
        const keys = Object.keys(env);
        rowsBox.innerHTML = keys.length
          ? keys.map(k => `
            <div class="backend-env-row" data-key="${esc(k)}">
              <input type="text" class="settings-input backend-env-key" value="${esc(k)}" spellcheck="false" placeholder="ANTHROPIC_BASE_URL">
              <input type="text" class="settings-input backend-env-value" value="${esc(env[k])}" spellcheck="false" placeholder="$MY_API_KEY">
              <span class="backend-env-status" data-state="literal">literal</span>
              <button type="button" class="backend-btn danger backend-env-remove" aria-label="Remove ${esc(k)}">&times;</button>
            </div>`).join('')
          : '<div class="backend-env-empty">No environment variables yet.</div>';
        refreshResolveStatus();
      }

      // Ask main which host vars are actually set — presence only, never values.
      async function refreshResolveStatus() {
        const rows = Array.from(rowsBox.querySelectorAll('.backend-env-row'));
        const refs = [];
        rows.forEach(row => {
          const ref = envRefName(row.querySelector('.backend-env-value').value);
          if (ref) refs.push(ref);
        });
        let presence = {};
        if (refs.length && window.api && typeof window.api.checkEnvRefs === 'function') {
          try { presence = (await window.api.checkEnvRefs(refs)) || {}; } catch { presence = {}; }
        }
        rows.forEach(row => {
          const status = row.querySelector('.backend-env-status');
          const ref = envRefName(row.querySelector('.backend-env-value').value);
          if (!ref) {
            status.dataset.state = 'literal';
            status.textContent = 'literal';
            status.title = 'A plain value, stored as-is. Never put a secret here.';
            return;
          }
          const ok = !!presence[ref];
          status.dataset.state = ok ? 'ok' : 'missing';
          status.textContent = ok ? 'resolves ✓' : 'not set ✗';
          status.title = ok
            ? `$${ref} is set in your environment.`
            : `$${ref} is not set — it would be dropped at launch and the CLI would fail to authenticate.`;
        });
      }

      // Read the rows back into `env` (rows are the editable surface, env the store).
      function syncEnvFromRows() {
        const next = {};
        rowsBox.querySelectorAll('.backend-env-row').forEach(row => {
          const k = row.querySelector('.backend-env-key').value.trim();
          if (!k) return;
          next[k] = row.querySelector('.backend-env-value').value;
        });
        env = next;
      }

      let statusTimer = null;
      rowsBox.addEventListener('input', (e) => {
        if (!e.target.classList.contains('backend-env-value') && !e.target.classList.contains('backend-env-key')) return;
        clearTimeout(statusTimer);
        statusTimer = setTimeout(refreshResolveStatus, 250);
      });
      rowsBox.addEventListener('click', (e) => {
        const rm = e.target.closest('.backend-env-remove');
        if (!rm) return;
        // Drop the row first, then re-read: the key input may have been renamed since the last sync.
        rm.closest('.backend-env-row').remove();
        syncEnvFromRows();
        renderRows();
      });
      dialog.querySelector('#be-env-add').addEventListener('click', () => {
        syncEnvFromRows();
        let k = 'NEW_VAR';
        let n = 2;
        while (env[k] !== undefined) k = `NEW_VAR_${n++}`;
        env[k] = '';
        renderRows();
      });

      // The structured Model field writes the whole consistent var set (haiku redirected).
      const applyModel = () => {
        syncEnvFromRows();
        const model = modelInput.value.trim();
        if (!model) return;
        env = window.applyPresetModel
          ? window.applyPresetModel(env, model, haikuInput.value.trim())
          : env;
        renderRows();
      };
      modelInput.addEventListener('change', applyModel);
      haikuInput.addEventListener('change', applyModel);

      renderRows();

      // --- save
      const close = (saved) => {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        resolve(saved);
      };
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(false); } };
      document.addEventListener('keydown', onKey);
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(false); });
      dialog.querySelector('#be-cancel').addEventListener('click', () => close(false));

      dialog.querySelector('#be-save').addEventListener('click', async () => {
        clearError();
        applyModel();
        syncEnvFromRows();

        const name = nameInput.value.trim();
        if (!name) { showError('Give the profile a name.'); nameInput.focus(); return; }

        // Warn before saving with an unresolved $VAR: resolveEnv drops it silently at spawn, so the
        // user would only see a cryptic auth error in the terminal on first launch.
        const refs = Object.keys(env).map(k => envRefName(env[k])).filter(Boolean);
        if (refs.length && window.api && typeof window.api.checkEnvRefs === 'function') {
          let presence = {};
          try { presence = (await window.api.checkEnvRefs(refs)) || {}; } catch {}
          const missing = refs.filter(r => !presence[r]);
          if (missing.length) {
            const go = await confirmDialog({
              title: 'Unresolved environment reference',
              message: `${missing.map(m => '$' + m).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set in your environment. `
                + 'The reference is dropped at launch, so the CLI will fail to authenticate. Save anyway?',
              confirmLabel: 'Save anyway',
              cancelLabel: 'Back to editor',
              tone: 'warning',
            });
            if (!go) return;
          }
        }

        const id = seed.id || slugId(name, takenIds || new Set());
        const profile = { id, name, icon, env };

        let res = await window.api.profiles.save(profile, false).catch(e => ({ ok: false, error: String(e && e.message || e) }));
        if (!res || !res.ok) {
          // T-2.4: main blocks a value that looks like a pasted raw key. Name the offending keys and
          // only retry with allowSecrets behind an explicit confirm.
          if (res && Array.isArray(res.secretKeys) && res.secretKeys.length) {
            showError(`<b>Raw secret blocked.</b> ${res.secretKeys.map(k => `<code>${esc(k)}</code>`).join(', ')} `
              + `${res.secretKeys.length === 1 ? 'holds what looks like' : 'hold what look like'} a literal API key. `
              + 'Set the key in your environment and reference it here as <code>$MY_API_KEY</code> — Switchboard never writes a secret to disk.');
            const go = await confirmDialog({
              title: 'Store a literal secret?',
              message: `${res.secretKeys.join(', ')} looks like a raw API key. It would be written to profiles.json in plain text. `
                + 'Use a $VAR reference instead unless you know exactly what you are doing.',
              confirmLabel: 'Store it anyway',
              cancelLabel: 'Cancel',
              tone: 'danger',
            });
            if (!go) return;
            res = await window.api.profiles.save(profile, true).catch(e => ({ ok: false, error: String(e && e.message || e) }));
            if (!res || !res.ok) { showError(esc((res && res.error) || 'Could not save the profile.')); return; }
          } else {
            showError(esc((res && res.error) || 'Could not save the profile.'));
            return;
          }
        }
        close(true);
      });

      nameInput.focus();
    });
  }

  // ---------------------------------------------------------------------------
  // The Backends section (global) / the launch-defaults block (project).
  // ---------------------------------------------------------------------------

  // ctx = { isProject, settings, fieldValue(key, fallback), useGlobalCheckbox(key) }
  async function mount(root, ctx) {
    if (!root) return;
    const isProject = !!ctx.isProject;
    // GLOBAL scope: the stored blob IS the effective one. PROJECT scope: the project stores ONLY the
    // options it overrides (#149), so the panel needs its own blob to know what is overridden, and the
    // global one to show what the rest inherits.
    storedDefaults = isProject
      ? ((ctx.settings || {}).backendDefaults || {})
      : (ctx.fieldValue('backendDefaults', {}) || {});
    inheritedDefaults = isProject ? (ctx.globalDefaults || {}) : {};
    // Edits are remembered across the per-backend pages WITHIN one settings session — but a settings
    // window that is closed without saving must not smuggle its abandoned edits into the next save.
    // `mount` runs when the panel opens (and on a fresh re-render), so that is where they are dropped.
    if (!ctx.keepPending) { pendingDefaults = {}; clearedDefaults = {}; pendingHandoffPrompts = {}; }
    storedHandoffPrompts = ctx.fieldValue('handoffPromptByBackend', {}) || {};
    const backendDefaults = mergedDefaults();

    // Everything is rendered into a FRESH child element and the delegated listeners hang off it —
    // a re-mount (after a profile was saved/deleted) throws the old box away with its listeners
    // instead of stacking another copy on the persistent root.
    const box = document.createElement('div');
    box.className = 'backends-panel';

    let backends = [];
    let defaultLaunchTarget = 'claude';
    let profiles = [];
    try {
      const res = await window.api.backends.list();
      backends = (res && res.backends) || [];
      defaultLaunchTarget = (res && res.defaultLaunchTarget) || 'claude';
    } catch {
      root.innerHTML = '<div class="settings-hint">Could not load the backend list.</div>';
      return;
    }
    try {
      const res = await window.api.profiles.list();
      profiles = (res && res.profiles) || [];
    } catch { profiles = []; }

    const profileById = new Map(profiles.map(p => [p.id, p]));
    const builtins = backends.filter(b => !b.isProfile);
    const profileBackends = backends.filter(b => b.isProfile);
    const readyBackends = backends.filter(b => b.status === 'ready');

    // --- project scope: only the launch defaults cascade down; enable + default target are global.
    if (isProject) {
      // "Use global default" is checked while the project stores no own backendDefaults — then the
      // controls show the inherited values, disabled (same convention as the other project fields).
      box.innerHTML = `
        <div class="settings-section">
          <div class="settings-section-title backend-defaults-head">
            <span>Launch defaults</span>
          </div>
          <div class="settings-hint">Per-backend launch options for this project. Each option falls back to the global default unless you override it here. Enabling a backend and the default launch target stay global.</div>
        </div>
        ${readyBackends.map(b => inlineDefaultsSection(b, mergedOwnDefaults(), inheritedDefaults)).join('')}`;
      box.addEventListener('input', (e) => recordDefault(e.target));
      box.addEventListener('change', (e) => {
        // Un-checking "use global default" starts an override at the value currently shown; re-checking
        // it drops the override, so the option follows the global default again from now on.
        const cb = e.target.closest && e.target.closest('.backend-inherit-cb');
        if (cb) {
          const input = box.querySelector(`.backend-default-input[data-backend="${CSS.escape(cb.dataset.backend)}"][data-opt="${CSS.escape(cb.dataset.opt)}"]`);
          if (input) input.disabled = cb.checked;
          if (cb.checked) clearOverride(cb.dataset.backend, cb.dataset.opt);
          else if (input) recordDefault(input);
          return;
        }
        recordDefault(e.target);
      });
      root.replaceChildren(box);
      paintIcons(box);
      return;
    }

    // --- global scope: the full manage UI.
    const enabledMap = ((ctx.settings || {}).backendEnabled) || {};
    const isEnabled = (b) => {
      if (b.status !== 'ready') return false;
      if (enabledMap[b.id] !== undefined) return !!enabledMap[b.id];
      return !!b.enabled;
    };

    // Same affordance as the launch picker's gear: this icon means "configure this backend".
    const gearBtn = (b) => `
      <button type="button" class="backend-gear" data-act="configure" data-id="${esc(b.id)}"
              title="Launch defaults for ${esc(b.label)}" aria-label="Launch defaults for ${esc(b.label)}">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </button>`;

    const builtinRow = (b) => {
      const ready = b.status === 'ready';
      const locked = b.id === 'claude'; // the default backend is always available (invariant §5.1)
      const on = isEnabled(b);
      return `
        <div class="settings-field backend-row ${ready ? '' : 'backend-row-planned'}" data-backend-row="${esc(b.id)}">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="backend-icon-slot" data-icon="${esc(b.colour || b.id)}" data-size="20" ${b.monogram ? `data-monogram="${esc(b.monogram)}"` : ''}></span>
              <span class="settings-label">${esc(b.label)}</span>
              ${ready ? '<span class="backend-pill">built-in</span>' : '<span class="backend-pill soon">Coming soon</span>'}
              ${ready && b.available === false ? '<span class="backend-pill missing">not installed</span>' : ''}
            </div>
            <div class="settings-description">${esc(BACKEND_BLURB[b.id] || '')}</div>
            ${ready && b.available === false && b.unavailableReason
              ? `<div class="settings-description backend-unavailable">${esc(b.unavailableReason)}</div>`
              : ''}
          </div>
          <div class="settings-field-control">
            ${ready ? gearBtn(b) : ''}
            ${ready
              ? `<label class="settings-toggle" ${locked ? 'title="Built-in — always enabled"' : ''}><input type="checkbox" class="backend-enable" data-id="${esc(b.id)}" ${on ? 'checked' : ''} ${locked ? 'checked disabled' : ''}><span class="settings-toggle-slider"></span></label>`
              : '<span class="backend-planned-note">not built yet</span>'}
          </div>
        </div>`;
    };

    const profileRow = (b) => {
      const p = profileById.get(b.id);
      const auth = authRefOf(p);
      return `
        <div class="settings-field backend-row" data-profile-row="${esc(b.id)}">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="backend-icon-slot" data-icon="${esc(b.icon || b.id)}" data-size="20"></span>
              <span class="settings-label">${esc(b.label)}</span>
              <span class="backend-pill default-pill" data-for="${esc(b.id)}" hidden>default</span>
            </div>
            <div class="settings-description">Claude Code on an alternative endpoint${auth ? ` · <code>${esc(auth)}</code>` : ''}</div>
          </div>
          <div class="settings-field-control">
            ${gearBtn(b)}
            <button type="button" class="backend-btn" data-act="default" data-id="${esc(b.id)}">Set default</button>
            <button type="button" class="backend-btn" data-act="edit" data-id="${esc(b.id)}">Edit</button>
            <button type="button" class="backend-btn danger" data-act="delete" data-id="${esc(b.id)}">Delete</button>
          </div>
        </div>`;
    };

    box.innerHTML = `
      <div class="settings-section">
        <div class="settings-section-title">Built-in</div>
        ${builtins.map(builtinRow).join('')}
      </div>
      <div class="settings-hint">Only enabled backends appear in the launch menu. "Coming soon" backends are not built yet — they can never be enabled. DeepSeek, GLM and OpenRouter are not backends of their own: create a profile from a template below.</div>

      <div class="settings-section">
        <div class="settings-section-title">Profiles</div>
        ${profileBackends.length
          ? profileBackends.map(profileRow).join('')
          : '<div class="settings-field"><div class="settings-field-info"><div class="settings-description">No profiles yet. Add one from a template below to run Claude Code against another endpoint.</div></div></div>'}
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Add from template</div>
        <div class="backend-template-chips" id="sv-backend-templates">
          ${(window.BACKEND_PRESETS || []).map(p => `
            <button type="button" class="backend-chip" data-preset="${esc(p.id)}">
              <span class="backend-icon-slot" data-icon="${esc(p.icon || p.id)}" data-size="18"></span>${esc(p.name)}
            </button>`).join('')}
          <button type="button" class="backend-chip backend-chip-blank" data-preset="">+ New (blank)</button>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Default for new sessions</span>
            <div class="settings-description">What a plain new-session action launches. Only enabled backends and your profiles are listed.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-default-launch-target"></select>
          </div>
        </div>
      </div>

      <div class="settings-hint">Each backend's launch options live on its own page — the gear on its row.</div>`;

    root.replaceChildren(box);
    paintIcons(box);

    // --- the per-backend page (gear) -------------------------------------------------------------
    // Only ONE backend's inputs are in the DOM at a time, so the Save button can no longer read the
    // others off the page. Edits are therefore recorded as they happen (`pendingDefaults`) and merged
    // over the stored blob at save time — otherwise opening Claude's page and saving would wipe Codex's
    // defaults, which is the sort of quiet data loss a settings screen must never do.
    function openBackendPage(backendId) {
      const backend = backends.find(b => b.id === backendId);
      if (!backend) return;
      const handoffByBackend = ctx.fieldValue('handoffPromptByBackend', {}) || {};
      const extras = handoffPromptHtml(backend, handoffByBackend[backend.id], ctx.fieldValue('handoffPrompt', ''))
        + (backend.id === 'claude'
          ? claudeIntegrationsHtml(!!ctx.fieldValue('attentionHooks', false))
          : '');
      const page = document.createElement('div');
      page.className = 'backends-panel';
      page.innerHTML = launchDefaultsPage(backend, mergedDefaults(), false, extras);
      root.replaceChildren(page);
      paintIcons(page);

      page.addEventListener('click', (e) => {
        if (e.target.closest('[data-act="back"]')) mount(root, { ...ctx, keepPending: true });
      });
      page.addEventListener('input', (e) => { recordDefault(e.target); recordHandoffPrompt(e.target); });
      page.addEventListener('change', (e) => { recordDefault(e.target); recordHandoffPrompt(e.target); });
    }

    box.addEventListener('click', (e) => {
      const gear = e.target.closest('.backend-gear');
      if (gear) { e.preventDefault(); openBackendPage(gear.dataset.id); }
    });

    // The one "default" marker: a select over ready && enabled backends/profiles. Rebuilt whenever
    // an enable toggle flips so a disabled backend can never stay the default target.
    const select = box.querySelector('#sv-default-launch-target');
    function rebuildSelect() {
      const eligible = backends.filter(b => b.status === 'ready' && isEnabledLive(b));
      const keep = select.value || defaultLaunchTarget;
      const target = eligible.some(b => b.id === keep) ? keep : 'claude';
      select.innerHTML = eligible.map(b =>
        `<option value="${esc(b.id)}" ${b.id === target ? 'selected' : ''}>${esc(b.label)}${b.isProfile ? '' : ' (built-in)'}</option>`
      ).join('');
      box.querySelectorAll('.default-pill').forEach(pill => {
        pill.hidden = pill.dataset.for !== select.value;
      });
    }
    // Live enabled state = the checkbox in the DOM (a profile has no toggle: always enabled).
    function isEnabledLive(b) {
      const cb = box.querySelector(`.backend-enable[data-id="${CSS.escape(b.id)}"]`);
      if (cb) return cb.checked;
      return b.isProfile ? true : isEnabled(b);
    }
    rebuildSelect();
    select.addEventListener('change', rebuildSelect);
    box.addEventListener('change', (e) => {
      if (e.target.classList && e.target.classList.contains('backend-enable')) rebuildSelect();
    });

    const refresh = () => mount(root, { ...ctx, keepPending: true });

    // Templates → editor (pre-filled name + icon + env bundle).
    box.querySelector('#sv-backend-templates').addEventListener('click', async (e) => {
      const chip = e.target.closest('.backend-chip');
      if (!chip) return;
      const preset = (window.BACKEND_PRESETS || []).find(p => p.id === chip.dataset.preset);
      const taken = new Set(backends.map(b => b.id));
      const seed = preset
        ? { name: preset.name, icon: preset.icon, env: Object.assign({}, preset.env), model: preset.model, haikuModel: preset.haikuModel }
        : { name: '', icon: 'anthropic', env: {}, model: '', haikuModel: '' };
      if (await openEditor(seed, taken)) refresh();
    });

    // Profile actions.
    box.addEventListener('click', async (e) => {
      const btn = e.target.closest('.backend-row [data-act]');
      if (!btn) return;
      const id = btn.dataset.id;
      if (btn.dataset.act === 'edit') {
        const p = profileById.get(id);
        if (!p) return;
        const taken = new Set(backends.map(b => b.id).filter(x => x !== id));
        if (await openEditor({ id: p.id, name: p.name, icon: p.icon, env: p.env }, taken)) refresh();
      } else if (btn.dataset.act === 'delete') {
        const p = profileById.get(id);
        const go = await confirmDialog({
          title: `Delete “${p ? p.name : id}”?`,
          message: 'The profile is removed. Sessions already started with it keep their history.',
          confirmLabel: 'Delete',
          cancelLabel: 'Cancel',
          tone: 'danger',
        });
        if (!go) return;
        await window.api.profiles.delete(id).catch(() => {});
        refresh();
      } else if (btn.dataset.act === 'default') {
        // The select is the single source of truth for the default marker; it is persisted with
        // Save Settings (defaultLaunchTarget) and mirrored into the profiles store there.
        select.value = id;
        rebuildSelect();
      }
    });
  }

  // Read the global-only keys back at save time. Returns null when the section never mounted, so a
  // save can't clobber the stored values with an empty object.
  function readGlobal(root) {
    if (!root || !root.querySelector('#sv-default-launch-target')) return null;
    const backendEnabled = {};
    root.querySelectorAll('.backend-enable').forEach(cb => { backendEnabled[cb.dataset.id] = !!cb.checked; });
    return {
      backendEnabled,
      defaultLaunchTarget: root.querySelector('#sv-default-launch-target').value || 'claude',
      backendDefaults: readDefaults(root),
      handoffPromptByBackend: readHandoffPrompts(root),
    };
  }

  // Per-backend handoff prompts. Same rule as the launch defaults: only ONE backend's page is in the DOM
  // at a time, so the stored blob is the source of truth and the open page is merged over it. An emptied
  // field is REMOVED (= "use the global prompt"), not stored as an empty string.
  function readHandoffPrompts(root) {
    const out = { ...(storedHandoffPrompts || {}), ...(pendingHandoffPrompts || {}) };
    if (root) {
      root.querySelectorAll('.backend-handoff-prompt').forEach(el => {
        const id = el.dataset.backend;
        if (!id) return;
        const v = el.value.trim();
        if (v) out[id] = v; else delete out[id];
      });
    }
    for (const [id, v] of Object.entries(out)) if (!v) delete out[id];
    return out;
  }

  // backendDefaults.<backendId>.<optionId> — the GLOBAL scope's blob.
  //
  // The DOM only ever holds ONE backend's page, so it is not the source of truth: the stored blob is,
  // with the edits made in this settings session merged over it. Reading the DOM alone would drop every
  // backend the user did not happen to have open when they hit Save.
  function readDefaults(root) {
    const merged = mergedDefaults();
    if (root) {
      root.querySelectorAll('.backend-default-input').forEach(el => {
        const bid = el.dataset.backend;
        const opt = el.dataset.opt;
        if (!bid || !opt || el.disabled) return;   // a disabled input is an INHERITED option (project scope)
        if (!merged[bid]) merged[bid] = {};
        merged[bid][opt] = valueOfInput(el);
      });
    }
    return merged;
  }

  // The PROJECT scope's blob: ONLY the options this project overrides (#149). Everything else must stay
  // absent, or the project would freeze a copy of today's global defaults and never see them change again.
  function readProjectDefaults(root) {
    const own = mergedOwnDefaults();
    if (root) {
      root.querySelectorAll('.backend-inherit-cb').forEach(cb => {
        const bid = cb.dataset.backend;
        const opt = cb.dataset.opt;
        if (!bid || !opt) return;
        if (cb.checked) {                              // inherits -> the project stores nothing for it
          if (own[bid]) delete own[bid][opt];
          return;
        }
        const input = root.querySelector(`.backend-default-input[data-backend="${CSS.escape(bid)}"][data-opt="${CSS.escape(opt)}"]`);
        if (!input) return;
        if (!own[bid]) own[bid] = {};
        own[bid][opt] = valueOfInput(input);
      });
    }
    for (const [bid, opts] of Object.entries(own)) {
      if (!opts || !Object.keys(opts).length) delete own[bid];
    }
    return own;
  }

  /** The project's OWN overrides ⊕ what was edited in this settings session. */
  function mergedOwnDefaults() {
    const out = {};
    for (const [bid, opts] of Object.entries(storedDefaults || {})) out[bid] = { ...opts };
    for (const [bid, opts] of Object.entries(pendingDefaults || {})) out[bid] = { ...(out[bid] || {}), ...opts };
    for (const [bid, opts] of Object.entries(clearedDefaults || {})) {
      for (const opt of Object.keys(opts)) if (out[bid]) delete out[bid][opt];
    }
    return out;
  }

  /** Mark an option as "inherit again" — it must be REMOVED from the project's blob, not set to ''. */
  function clearOverride(backendId, opt) {
    if (!backendId || !opt) return;
    if (pendingDefaults[backendId]) delete pendingDefaults[backendId][opt];
    if (!clearedDefaults[backendId]) clearedDefaults[backendId] = {};
    clearedDefaults[backendId][opt] = true;
  }

  function valueOfInput(el) {
    if (el.dataset.type === 'toggle') return !!el.checked;
    if (el.dataset.type === 'number') return el.value.trim() === '' ? '' : Number(el.value);
    return el.value;
  }

  function recordHandoffPrompt(el) {
    if (!el || !el.classList || !el.classList.contains('backend-handoff-prompt')) return;
    const id = el.dataset.backend;
    if (!id) return;
    const v = el.value.trim();
    if (v) pendingHandoffPrompts[id] = v; else pendingHandoffPrompts[id] = '';   // '' -> dropped on read
  }

  function recordDefault(el) {
    if (!el || !el.classList || !el.classList.contains('backend-default-input')) return;
    const bid = el.dataset.backend;
    const opt = el.dataset.opt;
    if (!bid || !opt) return;
    if (clearedDefaults[bid]) delete clearedDefaults[bid][opt];   // editing it overrides it again
    if (!pendingDefaults[bid]) pendingDefaults[bid] = {};
    pendingDefaults[bid][opt] = valueOfInput(el);
  }

  /** stored (this scope) ⊕ everything edited since the panel mounted. */
  function mergedDefaults() {
    const out = {};
    for (const [bid, opts] of Object.entries(storedDefaults || {})) out[bid] = { ...opts };
    for (const [bid, opts] of Object.entries(pendingDefaults || {})) out[bid] = { ...(out[bid] || {}), ...opts };
    return out;
  }

  window.backendsPanel = { mount, readGlobal, readProjectDefaults, openEditor };
})();
