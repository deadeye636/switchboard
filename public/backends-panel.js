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
  const ICON_KEYS = ['anthropic', 'claude', 'deepseek', 'glm', 'openrouter', 'codex', 'gemini', 'hermes', 'pi'];

  // One-line blurb per built-in backend (the descriptor carries no description).
  const BACKEND_BLURB = {
    claude: 'Anthropic — the default backend, always available.',
    codex: "OpenAI's terminal coding agent.",
    hermes: 'General AI agent with its own session store.',
    pi: 'Terminal coding agent.',
    gemini: "Google's terminal coding agent.",
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
      return `<select class="settings-select backend-default-input" data-backend="${esc(backendId)}" data-opt="${esc(field.id)}" data-type="select" id="${esc(name)}" ${dis}>
        ${choices.map(c => `<option value="${esc(c)}" ${String(value) === String(c) ? 'selected' : ''}>${esc(c)}</option>`).join('')}
      </select>`;
    }
    const type = field.type === 'number' ? 'number' : 'text';
    const cls = field.type === 'number' ? 'settings-input settings-input-compact' : 'settings-input';
    return `<input type="${type}" class="${cls} backend-default-input" data-backend="${esc(backendId)}" data-opt="${esc(field.id)}" data-type="${esc(field.type || 'text')}" id="${esc(name)}" value="${esc(value == null ? '' : value)}" ${dis}>`;
  }

  // One collapsible panel per ready backend. `disabled` = the project scope is inheriting the
  // global defaults (the "use global default" checkbox is checked).
  function launchDefaultsPanel(backend, defaults, disabled) {
    const fields = Array.isArray(backend.configFields) ? backend.configFields : [];
    if (!fields.length) return '';
    // Claude (and every Axis-A profile, which runs the same binary with the same options) already has
    // a long-standing home for these settings: Sessions & CLI. Rendering them a SECOND time here
    // would create two controls for one setting with invisible precedence — a user sets "plan" in one
    // place and the other silently wins. So this generated panel is for backends that have no legacy
    // home of their own (Axis-B: Codex, later Gemini). Sessions & CLI stays the single Claude source.
    if (backend.axis !== 'B') return '';
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
      <details class="settings-adv backend-defaults" data-backend="${esc(backend.id)}">
        <summary><svg class="settings-adv-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 6l6 6-6 6"/></svg><span class="backend-icon-slot" data-icon="${esc(backend.icon || backend.colour || backend.id)}" data-size="16" ${backend.monogram ? `data-monogram="${esc(backend.monogram)}"` : ''}></span>${esc(backend.label)} — Launch defaults</summary>
        <div class="settings-section">${rows}</div>
      </details>`;
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
    const backendDefaults = ctx.fieldValue('backendDefaults', {}) || {};

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
      const own = (ctx.settings || {}).backendDefaults;
      const inherit = own === undefined || own === null;
      box.innerHTML = `
        <div class="settings-section">
          <div class="settings-section-title backend-defaults-head">
            <span>Launch defaults</span>
            ${ctx.useGlobalCheckbox('backendDefaults')}
          </div>
          <div class="settings-hint">Per-backend launch options for this project. Enabling a backend and the default launch target stay global.</div>
        </div>
        ${readyBackends.map(b => launchDefaultsPanel(b, backendDefaults, inherit)).join('')}`;
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
            </div>
            <div class="settings-description">${esc(BACKEND_BLURB[b.id] || '')}</div>
          </div>
          <div class="settings-field-control">
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

      <div class="settings-subhead">Launch defaults</div>
      ${readyBackends.map(b => launchDefaultsPanel(b, backendDefaults, false)).join('')}
      <div class="settings-hint">Each backend's own launch options, saved as <code>backendDefaults.&lt;backend&gt;.&lt;option&gt;</code> and overridable per project.</div>`;

    root.replaceChildren(box);
    paintIcons(box);

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

    const refresh = () => mount(root, ctx);

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
    };
  }

  // backendDefaults.<backendId>.<optionId> from the generated panels.
  function readDefaults(root) {
    const out = {};
    if (!root) return out;
    root.querySelectorAll('.backend-default-input').forEach(el => {
      const bid = el.dataset.backend;
      const opt = el.dataset.opt;
      if (!bid || !opt) return;
      let value;
      if (el.dataset.type === 'toggle') value = !!el.checked;
      else if (el.dataset.type === 'number') value = el.value.trim() === '' ? '' : Number(el.value);
      else value = el.value;
      if (!out[bid]) out[bid] = {};
      out[bid][opt] = value;
    });
    return out;
  }

  window.backendsPanel = { mount, readGlobal, readProjectDefaults: readDefaults, openEditor };
})();
