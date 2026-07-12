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
  //
  // The ENDPOINT/provider icons — what a template is usually distinguished by. A backend's own icon is
  // added for the base the template runs on, and only for that one: the grid used to offer `codex`,
  // `hermes` and `pi` to every profile, so you could stick a Codex badge on a session that ran Claude.
  // A badge that names the wrong backend is worse than a dull one (#161).
  const PROVIDER_ICON_KEYS = ['anthropic', 'deepseek', 'glm', 'openrouter'];
  const iconKeysFor = (baseId) => {
    const keys = [...PROVIDER_ICON_KEYS];
    if (baseId && !keys.includes(baseId)) keys.unshift(baseId);
    return keys;
  };

  // Launch defaults live on a per-backend page now, so at most one backend's inputs exist in the DOM.
  // `storedDefaults` = what this settings scope has on disk; `pendingDefaults` = what the user changed
  // since the panel mounted, on any page. Save reads stored ⊕ pending — never the DOM alone.
  let storedDefaults = {};      // what THIS scope has on disk
  let inheritedDefaults = {};   // project scope only: what it would inherit from global
  let pendingDefaults = {};     // edited since the panel mounted, on any page
  let clearedDefaults = {};     // project scope: overrides the user handed back to the global default
  let storedHandoffPrompts = {};  // handoffPromptByBackend on disk
  let pendingHandoffPrompts = {}; // ...edited in this settings session

  // The global scope's two list-level values. They live HERE and not in the DOM, because opening a
  // backend's gear page replaces the list — including the enable toggles and the default-target select.
  // Reading them off the DOM at save time therefore found nothing whenever a gear page was open, and the
  // save silently dropped EVERY backend setting the user had just made on that page (#163).
  let mountedGlobal = false;      // has the global section been rendered in this settings session?
  let liveEnabled = {};           // backendId -> bool, as last shown in the list
  let liveLaunchTarget = 'claude';

  // Per-backend ENVIRONMENT variables (`backendEnv.<id>`). A template could always carry an env bundle;
  // a plain backend could not, which meant the only way to give Codex a var was to wrap it in a template.
  // Same rules as everywhere else: a secret belongs in a `$VAR` reference, resolved at spawn, never
  // written to disk.
  let storedBackendEnv = {};      // what this scope has on disk
  let pendingBackendEnv = {};     // edited since the panel mounted, on any backend's page

  // TEMPLATES ARE STAGED, like every other setting on this screen.
  //
  // The editor used to write straight to the profiles store, and Delete removed a template there and
  // then — so two buttons on one screen meant two different things: "Save template" was final, while
  // "Save Settings" ten pixels below it was the thing that actually saved everything else. Cancel undid
  // one and not the other.
  //
  // Now a create/edit lands in `stagedTemplates` and a delete in `deletedTemplates`; both are applied by
  // `commitTemplates()`, which Save Settings calls. Closing Settings without saving discards them, which
  // is what Cancel has always promised.
  let stagedTemplates = new Map();   // id -> { profile, allowSecrets }
  let deletedTemplates = new Set();  // ids removed in this settings session
  let storedTemplateIds = new Set(); // which templates actually exist ON DISK right now

  function mergedBackendEnv() {
    const out = {};
    for (const [bid, env] of Object.entries(storedBackendEnv || {})) out[bid] = { ...env };
    for (const [bid, env] of Object.entries(pendingBackendEnv || {})) out[bid] = { ...env };
    return out;
  }

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
            <div class="settings-description">${esc(f.description || `Used when you start a ${backend.label} session in this project without opening its configure dialog.`)}</div>
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

  // The GLOBAL scope's page for one backend. Each option carries its own "Use the backend's default"
  // checkbox — the same marker the project scope has had since #149, for the same reason one level up
  // (#163): without it, saving this page pinned EVERY option of this backend at whatever happened to be
  // in the box, including options the user never touched. A better default shipped later then never
  // reached them, and nothing said so, because the frozen value still looked right.
  //
  // Ticked = this backend decides (the option is absent from the blob and follows `configFields.default`).
  // Unticked = YOU decide, and the value is stored — including an empty string or a `false`, which are
  // values, not absences (§ decision 3: an option whose default is ON can only be switched off by
  // storing the `false`).
  function launchDefaultsPage(backend, defaults, disabled, extraHtml) {
    const fields = Array.isArray(backend.configFields) ? backend.configFields : [];
    const stored = (defaults && defaults[backend.id]) || {};
    const rows = fields.map(f => {
      const set = stored[f.id] !== undefined;              // undefined = not set; '' / false ARE set
      const value = set ? stored[f.id] : f.default;
      return `
        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">${esc(f.label || f.id)}</span>
              ${disabled ? '' : `
                <label class="settings-use-global">
                  <input type="checkbox" class="backend-inherit-cb" data-backend="${esc(backend.id)}" data-opt="${esc(f.id)}" ${set ? '' : 'checked'}>
                  Use the backend's default
                </label>`}
            </div>
            <div class="settings-description">${esc(f.description || `Used when you start a ${backend.label} session without opening its configure dialog.`)}</div>
            ${f.more ? `<div class="settings-more">${esc(f.more)}</div>` : ''}
          </div>
          <div class="settings-field-control">${configFieldControl(backend.id, f, value, disabled || !set)}</div>
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
        ${disabled ? '' : backendEnvSection(backend)}
        ${extraHtml || ''}
      </div>`;
  }

  // A backend's own ENVIRONMENT variables. Only a template could carry an env bundle before, so the only
  // way to hand Codex a variable was to wrap it in a template — which is a whole extra backend in the
  // launch menu just to set one var.
  //
  // The rules are the ones that already apply to a template's bundle: a secret belongs in a `$VAR`
  // reference, resolved from your environment at spawn and never written to disk. Main enforces it at the
  // trust boundary; the UI only says so.
  function backendEnvSection(backend) {
    const env = (mergedBackendEnv()[backend.id]) || {};
    const keys = Object.keys(env);
    const rows = keys.length
      ? keys.map(k => `
        <div class="backend-env-row" data-backend="${esc(backend.id)}" data-key="${esc(k)}">
          <input type="text" class="settings-input bde-env-key" value="${esc(k)}" spellcheck="false" placeholder="MY_VAR">
          <input type="text" class="settings-input bde-env-value" value="${esc(env[k])}" spellcheck="false" placeholder="$MY_TOKEN">
          <button type="button" class="backend-btn danger bde-env-remove" aria-label="Remove ${esc(k)}">&times;</button>
        </div>`).join('')
      : '<div class="backend-env-empty">No environment variables.</div>';

    return `
      <details class="settings-adv backend-env-adv">
        <summary><svg class="settings-adv-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 6l6 6-6 6"/></svg>Environment variables</summary>
        <div class="backend-env-hint">Given to every ${esc(backend.label)} session. Secrets belong in a <code>$VAR</code> reference (e.g. <code>$MY_TOKEN</code>), resolved from your environment when the CLI starts — Switchboard never writes a secret to disk.</div>
        <div class="backend-env-rows" data-env-for="${esc(backend.id)}">${rows}</div>
        <button type="button" class="backend-btn bde-env-add" data-backend="${esc(backend.id)}">+ Add variable</button>
      </details>`;
  }

  /** Read the env rows of the page currently in the DOM back into `pendingBackendEnv`. */
  function readBackendEnvFromDom(root) {
    if (!root) return;
    root.querySelectorAll('.backend-env-rows[data-env-for]').forEach(box => {
      const bid = box.dataset.envFor;
      const env = {};
      box.querySelectorAll('.backend-env-row').forEach(row => {
        const key = row.querySelector('.bde-env-key').value.trim();
        const value = row.querySelector('.bde-env-value').value;
        if (key) env[key] = value;
      });
      pendingBackendEnv[bid] = env;
    });
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

  function handoffPromptHtml(backend, values, globals) {
    const row = (kind, id, label, hint, value, placeholder) => `
        <div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <span class="settings-label">${esc(label)}</span>
            <div class="settings-description">${hint}</div>
          </div>
          <div class="settings-field-control">
            <textarea class="settings-input backend-handoff-prompt" rows="4"
              data-backend="${esc(backend.id)}" data-kind="${esc(kind)}"
              placeholder="${esc(firstLine(placeholder) || 'Use the global prompt')}">${esc(value || '')}</textarea>
          </div>
        </div>`;

    return `
      <div class="settings-section">
        <div class="settings-section-title">Handoff</div>
        <div class="settings-hint">A handoff is written either by THIS session's agent (it summarises what it holds) or by a NEW one (it reads this session's transcript). Each has its own prompt; leave a field empty to use the global one.</div>
        ${row('summarise', 'sum', `Summarise prompt — asked of a ${backend.label} session`,
          `Sent to the ${esc(backend.label)} agent that ran the session. A slash command is sent to it exactly as you write it — use ${esc(backend.label)}'s own command or skill here.`,
          (values || {}).summarise, (globals || {}).summarise)}
        ${row('read', 'read', `Read prompt — given to a new ${backend.label} session`,
          `Sent to a fresh ${esc(backend.label)} agent that reads the old session's transcript. <code>{transcript}</code> is the path it can open.`,
          (values || {}).read, (globals || {}).read)}
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

  // `seed` = { id?, name, icon, env, model, haikuModel, backendId } — an existing template or a preset.
  // `bases` = the built-in backends a template may run on. Resolves to true when one was saved.
  //
  // A template is a named set of defaults FOR A BACKEND (#161). Which backend was previously not a
  // question the user could answer — it was always Claude, hardcoded, and this dialog never said so: the
  // word "Claude" did not appear in it once. You picked a name, an icon and some env vars and were left
  // to infer the binding from the ANTHROPIC_* variable names.
  function openEditor(seed, takenIds, bases) {
    return new Promise((resolve) => {
      const isNew = !seed.id;
      // Working copy: `env` is the source of truth; the Model field writes the whole model var set
      // into it via applyPresetModel (an un-redirected haiku model leaks the host key).
      let env = Object.assign({}, seed.env || {});
      // The template's launch options — values for the BASE backend's configFields. They live in the
      // template record, not in the settings blob: a template is one thing, with one save button.
      let options = Object.assign({}, seed.options || {});
      let baseId = seed.backendId || 'claude';
      const baseList = (bases && bases.length ? bases : [{ id: 'claude', label: 'Claude Code', configFields: [] }]);
      const baseOf = (id) => baseList.find(b => b.id === id) || baseList[0];
      const fieldsOf = (id) => (baseOf(id) || {}).configFields || [];
      // The endpoint fields below write ANTHROPIC_* variables. They only mean anything on a Claude base —
      // Codex and Pi have no such variables, and offering them there would be a control that lies.
      const isClaudeBase = () => baseId === 'claude';
      let icon = seed.icon || 'anthropic';

      // The base backend's options, each with the same per-option "is this set?" marker every other scope
      // has (#163). Ticked = this template says nothing and the option falls through to the backend's own
      // cascade. Unticked = the template decides, and the value is stored — `''` and `false` included.
      const optionsHtml = () => {
        const fields = fieldsOf(baseId);
        if (!fields.length) return '<div class="settings-description">This backend has no launch options.</div>';
        return fields.map(f => {
          const set = options[f.id] !== undefined;
          const value = set ? options[f.id] : f.default;
          return `
            <div class="settings-field">
              <div class="settings-field-info">
                <div class="settings-field-header">
                  <span class="settings-label">${esc(f.label || f.id)}</span>
                  <label class="settings-use-global">
                    <input type="checkbox" class="be-opt-inherit" data-opt="${esc(f.id)}" ${set ? '' : 'checked'}>
                    Use the backend's default
                  </label>
                </div>
                ${f.description ? `<div class="settings-description">${esc(f.description)}</div>` : ''}
              </div>
              <div class="settings-field-control">${configFieldControl('be', f, value, !set)}</div>
            </div>`;
        }).join('');
      };

      const overlay = document.createElement('div');
      overlay.className = 'new-session-overlay';
      const dialog = document.createElement('div');
      dialog.className = 'new-session-dialog backend-editor';
      overlay.appendChild(dialog);

      const modelSeed = seed.model !== undefined ? seed.model : (env.ANTHROPIC_MODEL || '');
      const haikuSeed = seed.haikuModel !== undefined ? seed.haikuModel : (env.ANTHROPIC_DEFAULT_HAIKU_MODEL || '');

      dialog.innerHTML = `
        <h3>${isNew ? 'New template' : 'Edit template'}</h3>
        <div class="settings-hint">A template is a named set of defaults for a backend — <em>Codex with this model and sandbox</em>, or <em>Claude Code pointed at another endpoint</em>. It launches that backend's binary; its launch options live on its own page, reachable from the gear on its row.</div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Backend</span>
            <div class="settings-description">Which CLI this template runs. Its launch options and its session store are that backend's.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="be-base" ${isNew ? '' : 'disabled'}>
              ${baseList.map(b => `<option value="${esc(b.id)}" ${b.id === baseId ? 'selected' : ''}>${esc(b.label)}</option>`).join('')}
            </select>
          </div>
        </div>
        ${isNew ? '' : '<div class="settings-hint">A template cannot change backend after it is created — its existing sessions belong to the one it was launched with.</div>'}
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
              ${iconKeysFor(baseId).map(k => `<button type="button" class="backend-icon-choice" data-icon="${esc(k)}" aria-label="${esc(k)}" aria-pressed="false"><span class="backend-icon-slot" data-icon="${esc(k)}" data-size="22"></span></button>`).join('')}
            </div>
          </div>
        </div>
        <!-- The endpoint fields. ANTHROPIC_* only exists on a Claude base, so they are hidden elsewhere:
             on a Codex template they would be two boxes that write variables Codex never reads. -->
        <div id="be-endpoint" ${isClaudeBase() ? '' : 'hidden'}>
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
        </div>
        <div class="settings-section">
          <div class="settings-section-title" id="be-options-title">Launch options</div>
          <div class="settings-hint">What this template starts its backend with. An option you leave on <em>Use the backend's default</em> follows that backend's own settings — now and after you change them.</div>
          <div id="be-options">${optionsHtml()}</div>
        </div>
        <details class="settings-adv backend-env-adv" open>
          <summary><svg class="settings-adv-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 6l6 6-6 6"/></svg>Advanced — environment variables</summary>
          <div class="backend-env-hint">Secrets belong in a <code>$VAR</code> reference (e.g. <code>$DEEPSEEK_API_KEY</code>), resolved from your environment at launch. A literal key is rejected.</div>
          <div class="backend-env-rows" id="be-env-rows"></div>
          <button type="button" class="backend-btn" id="be-env-add">+ Add variable</button>
        </details>
        <div class="backend-editor-error" id="be-error" hidden></div>
        <!-- A template is its own record (profiles.json), not part of the settings blob — so this button
             writes it there and then. Say so: the settings dialog's own Cancel behind this one does NOT
             undo it, and a save button that silently means something different from the one below it is
             a trap. -->
        <div class="settings-hint">Saved straight away, separately from the settings below — closing Settings with <em>Cancel</em> will not undo it.</div>
        <div class="settings-btn-row">
          <button class="settings-cancel-btn" id="be-cancel">Cancel</button>
          <button class="settings-save-btn" id="be-save">Save template</button>
        </div>`;

      // The editor grew with the backends (#160/#161): base, name, icon, endpoint fields, the base's full
      // option set, the env rows. On a short screen it ran past the bottom and took its own Save button
      // with it. Cap the frame, scroll the MIDDLE, and pin the title and the buttons — done here by DOM
      // surgery rather than by threading a wrapper through the template, so the markup above stays
      // readable and no field can be forgotten in the move.
      dialog.classList.add('new-session-dialog-scroll');
      {
        const body = document.createElement('div');
        body.className = 'new-session-dialog-body';
        // Pinned: the title, the ERROR box (an error you have to scroll to find is an error you miss),
        // and the buttons. Everything else scrolls.
        for (const child of [...dialog.children]) {
          if (child.tagName === 'H3') continue;
          if (child.classList.contains('settings-btn-row')) continue;
          if (child.classList.contains('backend-editor-error')) continue;
          body.appendChild(child);
        }
        const errorBoxEl = dialog.querySelector('.backend-editor-error');
        dialog.insertBefore(body, errorBoxEl || dialog.querySelector('.settings-btn-row'));
      }

      document.body.appendChild(overlay);
      paintIcons(dialog);

      const nameInput = dialog.querySelector('#be-name');
      const baseSelect = dialog.querySelector('#be-base');
      const endpointBox = dialog.querySelector('#be-endpoint');
      const optionsBox = dialog.querySelector('#be-options');
      const optionsTitle = dialog.querySelector('#be-options-title');
      const modelInput = dialog.querySelector('#be-model');
      const haikuInput = dialog.querySelector('#be-haiku');
      const rowsBox = dialog.querySelector('#be-env-rows');
      const errorBox = dialog.querySelector('#be-error');

      const showError = (html) => { errorBox.innerHTML = html; errorBox.hidden = false; };
      const clearError = () => { errorBox.hidden = true; errorBox.innerHTML = ''; };

      // --- base backend: it decides what the rest of this dialog even means.
      baseSelect.addEventListener('change', () => {
        baseId = baseSelect.value;
        endpointBox.hidden = !isClaudeBase();
        // A different backend has different options. Keeping the old values would carry, say, a Claude
        // permission mode into a Codex template — a setting that backend has never heard of.
        options = {};
        optionsTitle.textContent = `Launch options — ${baseOf(baseId).label}`;
        optionsBox.innerHTML = optionsHtml();
        // The grid offers the provider icons plus THIS base's own — so a template can never wear another
        // backend's badge. If the current pick just left the grid, fall back to a neutral one.
        const grid = dialog.querySelector('#be-icons');
        const keys = iconKeysFor(baseId);
        if (!keys.includes(icon)) icon = keys[0];
        grid.innerHTML = keys.map(k =>
          `<button type="button" class="backend-icon-choice" data-icon="${esc(k)}" aria-label="${esc(k)}" aria-pressed="false"><span class="backend-icon-slot" data-icon="${esc(k)}" data-size="22"></span></button>`
        ).join('');
        paintIcons(grid);
        paintIconChoice();
        clearError();
      });

      // An option's marker: ticked hands it back to the backend, unticked starts an override at the value
      // currently shown. Same behaviour as the settings pages, so there is one thing to learn.
      optionsBox.addEventListener('change', (e) => {
        const cb = e.target.closest && e.target.closest('.be-opt-inherit');
        if (!cb) { readOptionsFromDom(); return; }
        const input = optionsBox.querySelector(`.backend-default-input[data-opt="${CSS.escape(cb.dataset.opt)}"]`);
        if (input) input.disabled = cb.checked;
        if (cb.checked) delete options[cb.dataset.opt];
        else if (input) options[cb.dataset.opt] = valueOfInput(input);
      });
      optionsBox.addEventListener('input', () => readOptionsFromDom());

      function readOptionsFromDom() {
        optionsBox.querySelectorAll('.be-opt-inherit').forEach(cb => {
          const opt = cb.dataset.opt;
          if (cb.checked) { delete options[opt]; return; }
          const input = optionsBox.querySelector(`.backend-default-input[data-opt="${CSS.escape(opt)}"]`);
          if (input) options[opt] = valueOfInput(input);   // '' and false are values, not absences
        });
      }

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
        if (!name) { showError('Give the template a name.'); nameInput.focus(); return; }

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

        readOptionsFromDom();
        const id = seed.id || slugId(name, takenIds || new Set());
        const profile = { id, name, backendId: baseId, icon, options, env };

        // CHECK, do not write. The template is staged and only committed by Save Settings — but the
        // checks that matter (a pasted raw key, a host-key leak) belong here, while the user is looking
        // at the dialog, not minutes later at a Save button somewhere else.
        let allowSecrets = false;
        let res = await window.api.profiles.validate(profile, false)
          .catch(e => ({ ok: false, error: String(e && e.message || e) }));
        if (!res || !res.ok) {
          // T-2.4: a value that looks like a pasted raw key is blocked. Name the offending keys and only
          // proceed behind an explicit confirm.
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
            allowSecrets = true;
            res = await window.api.profiles.validate(profile, true)
              .catch(e => ({ ok: false, error: String(e && e.message || e) }));
            if (!res || !res.ok) { showError(esc((res && res.error) || 'Could not save the template.')); return; }
          } else {
            showError(esc((res && res.error) || 'Could not save the template.'));
            return;
          }
        }
        close({ profile, allowSecrets });
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
    storedBackendEnv = isProject ? {} : (ctx.fieldValue('backendEnv', {}) || {});
    if (!ctx.keepPending) {
      pendingDefaults = {}; clearedDefaults = {}; pendingHandoffPrompts = {};
      pendingBackendEnv = {}; mountedGlobal = false;
      stagedTemplates = new Map(); deletedTemplates = new Set();
    }
    storedHandoffPrompts = {
      summarise: ctx.fieldValue('handoffPromptByBackend', {}) || {},
      read: ctx.fieldValue('handoffReadPromptByBackend', {}) || {},
    };
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

    const builtins = backends.filter(b => !b.isProfile);

    // What is actually ON DISK. A template staged in this session is not — and deleting one that never
    // got there must not ask the store to remove it (it would answer "not found", which is a true
    // statement about a thing the user never created and a nonsense one to show them).
    storedTemplateIds = new Set(profiles.map(p => p.id));

    // What the list SHOWS: the stored templates, minus the ones staged for deletion, with the staged
    // edits laid over them, plus the staged new ones. The store on disk is untouched until Save Settings
    // calls commitTemplates() — so the screen shows what you will get, and Cancel really cancels.
    profiles = profiles
      .filter(p => !deletedTemplates.has(p.id))
      .map(p => (stagedTemplates.get(p.id) || {}).profile || p)
      .concat(
        [...stagedTemplates.values()]
          .map(s => s.profile)
          .filter(p => !profiles.some(existing => existing.id === p.id))
      );

    const profileById = new Map(profiles.map(p => [p.id, p]));

    /** A staged template has no descriptor from main yet — synthesise the one the rows need. */
    const templateDescriptor = (p) => {
      const base = builtins.find(b => b.id === (p.backendId || 'claude'));
      return {
        id: p.id,
        label: p.name,
        isProfile: true,
        status: base && base.status === 'ready' ? 'ready' : 'planned',
        baseId: p.backendId || 'claude',
        baseLabel: base ? base.label : (p.backendId || 'claude'),
        icon: p.icon || null,
        colour: p.icon || 'default',
        caveat: base ? undefined : `Its backend (${p.backendId}) is not available, so this template cannot start.`,
      };
    };

    const stagedIds = new Set([...stagedTemplates.keys()]);
    const profileBackends = profiles.map(p => {
      const fromMain = backends.find(b => b.id === p.id && b.isProfile);
      // A staged edit must render its NEW name/base, not the one still on disk.
      return (fromMain && !stagedIds.has(p.id)) ? fromMain : templateDescriptor(p);
    });

    // Everything the rest of this function reasons about: built-ins plus the templates AS SHOWN.
    backends = builtins.concat(profileBackends);
    const readyBackends = backends.filter(b => b.status === 'ready');
    const templatesDirty = stagedTemplates.size > 0 || deletedTemplates.size > 0;

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
              ? `<label class="settings-toggle"><input type="checkbox" class="backend-enable" data-id="${esc(b.id)}" ${on ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>`
              : '<span class="backend-planned-note">not built yet</span>'}
          </div>
        </div>`;
    };

    // Say what the template actually runs. It used to read "Claude Code on an alternative endpoint" for
    // every profile, which was true only because Claude was the only base there could be (#161).
    const templateBlurb = (b, p) => {
      if (b.status !== 'ready') return b.caveat || 'This template cannot start.';
      const base = b.baseLabel || 'Claude Code';
      const redirected = p && p.env && p.env.ANTHROPIC_BASE_URL;
      return redirected ? `${base} on an alternative endpoint` : `${base} with your own defaults`;
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
              ${stagedIds.has(b.id) ? '<span class="backend-pill soon">not saved yet</span>' : ''}
            </div>
            <div class="settings-description">${esc(templateBlurb(b, p))}${auth ? ` · <code>${esc(auth)}</code>` : ''}</div>
          </div>
          <div class="settings-field-control">
            <!-- No gear here. A template's launch options live in the template itself, edited in its own
                 dialog — a second page writing them into the settings blob would give one thing two
                 homes and two save buttons, which is exactly what it had. -->
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

      <div class="settings-section">
        <div class="settings-section-title">Templates</div>
        ${templatesDirty ? '<div class="settings-notice backend-caveat">Your template changes are applied when you save your settings.</div>' : ''}
        ${profileBackends.length
          ? profileBackends.map(profileRow).join('')
          : '<div class="settings-field"><div class="settings-field-info"><div class="settings-description">No templates yet. A template is a named set of defaults for a backend — <em>Codex with this model and sandbox</em>, or <em>Claude Code pointed at another endpoint</em>. Start from one below.</div></div></div>'}
      </div>

      <div class="settings-section">
        <div class="settings-section-title">New template</div>
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
            <div class="settings-description">What a plain new-session action launches. Only enabled backends and the templates that run on them are listed.</div>
            <div class="settings-notice backend-caveat" id="sv-no-backend-warning" hidden>No backend is enabled — nothing can be launched until you switch one on. Your existing sessions stay visible and searchable.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-default-launch-target"></select>
          </div>
        </div>
      </div>

      `;

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
      const bySummarise = ctx.fieldValue('handoffPromptByBackend', {}) || {};
      const byRead = ctx.fieldValue('handoffReadPromptByBackend', {}) || {};
      const extras = handoffPromptHtml(
        backend,
        { summarise: bySummarise[backend.id], read: byRead[backend.id] },
        { summarise: ctx.fieldValue('handoffPrompt', ''), read: ctx.fieldValue('handoffReadPrompt', '') },
      )
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
      // Env rows: add / remove / edit. Recorded as they happen, like every other edit on this page, so a
      // Save from anywhere in the settings dialog carries them.
      page.addEventListener('click', (e) => {
        const add = e.target.closest('.bde-env-add');
        if (add) {
          readBackendEnvFromDom(page);
          const bid = add.dataset.backend;
          const env = pendingBackendEnv[bid] || (pendingBackendEnv[bid] = {});
          let n = 1;
          while (env[`NEW_VAR_${n}`] !== undefined) n++;
          env[`NEW_VAR_${n}`] = '';
          const box = page.querySelector(`.backend-env-rows[data-env-for="${CSS.escape(bid)}"]`);
          const backend = backends.find(b => b.id === bid);
          if (box && backend) {
            const section = document.createElement('div');
            section.innerHTML = backendEnvSection(backend);
            box.replaceWith(section.querySelector('.backend-env-rows'));
          }
          return;
        }
        const remove = e.target.closest('.bde-env-remove');
        if (remove) {
          const row = remove.closest('.backend-env-row');
          row.remove();
          readBackendEnvFromDom(page);
        }
      });
      page.addEventListener('input', (e) => {
        recordDefault(e.target);
        recordHandoffPrompt(e.target);
        if (e.target.classList && (e.target.classList.contains('bde-env-key') || e.target.classList.contains('bde-env-value'))) {
          readBackendEnvFromDom(page);
        }
      });
      page.addEventListener('change', (e) => {
        // Same rule as the project scope (#149), one level up (#163): un-ticking "use the backend's
        // default" starts an override at the value currently shown; re-ticking it REMOVES the option
        // from the blob, so it follows the backend's own default again — now and after we change it.
        const cb = e.target.closest && e.target.closest('.backend-inherit-cb');
        if (cb) {
          const input = page.querySelector(`.backend-default-input[data-backend="${CSS.escape(cb.dataset.backend)}"][data-opt="${CSS.escape(cb.dataset.opt)}"]`);
          if (input) input.disabled = cb.checked;
          if (cb.checked) clearOverride(cb.dataset.backend, cb.dataset.opt);
          else if (input) recordDefault(input);
          return;
        }
        recordDefault(e.target);
        recordHandoffPrompt(e.target);
      });
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
      // Fall back to the first LAUNCHABLE backend, not to a hardcoded 'claude' — Claude can be disabled
      // now (#162), and a default that points at a disabled backend is a spawn that gets refused.
      const target = eligible.some(b => b.id === keep) ? keep : (eligible[0] ? eligible[0].id : '');
      select.innerHTML = eligible.length
        ? eligible.map(b =>
          `<option value="${esc(b.id)}" ${b.id === target ? 'selected' : ''}>${esc(b.label)}${b.isProfile ? '' : ' (built-in)'}</option>`
        ).join('')
        : '<option value="">No backend is enabled</option>';
      box.querySelectorAll('.default-pill').forEach(pill => {
        pill.hidden = pill.dataset.for !== select.value;
      });
      // Turning off every backend leaves nothing to launch. Say it here, where the switch was flipped.
      const warn = box.querySelector('#sv-no-backend-warning');
      if (warn) warn.hidden = eligible.length > 0;
    }
    // Live enabled state = the checkbox in the DOM. A TEMPLATE has no toggle of its own: it follows the
    // backend it runs on (#162), so read that backend's checkbox instead of assuming "always enabled".
    function isEnabledLive(b) {
      const cb = box.querySelector(`.backend-enable[data-id="${CSS.escape(b.id)}"]`);
      if (cb) return cb.checked;
      if (b.isProfile) {
        const baseCb = box.querySelector(`.backend-enable[data-id="${CSS.escape(b.baseId || 'claude')}"]`);
        if (baseCb) return baseCb.checked;
        return true;
      }
      return isEnabled(b);
    }
    // Snapshot the list-level values into module state on every change, so a save that happens while a
    // gear page is open (i.e. with this list not in the DOM) still knows them.
    function snapshotList() {
      liveEnabled = {};
      box.querySelectorAll('.backend-enable').forEach(cb => { liveEnabled[cb.dataset.id] = !!cb.checked; });
      liveLaunchTarget = select.value || defaultLaunchTarget || 'claude';
      mountedGlobal = true;
    }

    rebuildSelect();
    snapshotList();
    select.addEventListener('change', () => { rebuildSelect(); snapshotList(); });
    box.addEventListener('change', (e) => {
      if (e.target.classList && e.target.classList.contains('backend-enable')) { rebuildSelect(); snapshotList(); }
    });

    const refresh = () => mount(root, { ...ctx, keepPending: true });

    // The backends a template may RUN ON: the ready built-ins. A template on a template would be a
    // chain to resolve and buys nothing; a `planned` backend cannot run at all.
    const templateBases = builtins
      .filter(b => b.status === 'ready')
      .map(b => ({ id: b.id, label: b.label, configFields: b.configFields || [] }));

    // Templates → editor. The result is STAGED, not written: Save Settings commits it, Cancel drops it.
    box.querySelector('#sv-backend-templates').addEventListener('click', async (e) => {
      const chip = e.target.closest('.backend-chip');
      if (!chip) return;
      const preset = (window.BACKEND_PRESETS || []).find(p => p.id === chip.dataset.preset);
      const taken = new Set(backends.map(b => b.id));
      // A preset is a set of ANTHROPIC_* env vars — it only means anything on a Claude base, and says so
      // (backends/presets.js). A blank template starts on Claude and the user can change it.
      const seed = preset
        ? { name: preset.name, icon: preset.icon, env: Object.assign({}, preset.env), model: preset.model, haikuModel: preset.haikuModel, backendId: preset.backendId || 'claude' }
        : { name: '', icon: 'anthropic', env: {}, model: '', haikuModel: '', backendId: 'claude' };
      const staged = await openEditor(seed, taken, templateBases);
      if (staged) {
        stagedTemplates.set(staged.profile.id, staged);
        deletedTemplates.delete(staged.profile.id);
        refresh();
      }
    });

    // Template actions.
    box.addEventListener('click', async (e) => {
      const btn = e.target.closest('.backend-row [data-act]');
      if (!btn) return;
      const id = btn.dataset.id;
      if (btn.dataset.act === 'edit') {
        const p = profileById.get(id);
        if (!p) return;
        const taken = new Set(backends.map(b => b.id).filter(x => x !== id));
        const seed = {
          id: p.id, name: p.name, icon: p.icon, env: p.env,
          backendId: p.backendId || 'claude', options: p.options || {},
        };
        const staged = await openEditor(seed, taken, templateBases);
        if (staged) {
          stagedTemplates.set(staged.profile.id, staged);
          refresh();
        }
      } else if (btn.dataset.act === 'delete') {
        const p = profileById.get(id);
        const go = await confirmDialog({
          title: `Delete “${p ? p.name : id}”?`,
          message: 'The template is removed when you save your settings. Sessions already started with it keep their history.',
          confirmLabel: 'Delete',
          cancelLabel: 'Cancel',
          tone: 'danger',
        });
        if (!go) return;
        // Staged, like everything else on this screen. It disappears from the list now; it leaves the
        // disk when Save Settings says so.
        //
        // ...unless it was never ON the disk. Creating a template and then deleting it again, both
        // before saving, is a no-op — the two stagings cancel out. Recording a delete for it would send
        // Save Settings looking for a record that was never written, and report "not found" about a thing
        // the user never created.
        stagedTemplates.delete(id);
        if (storedTemplateIds.has(id)) deletedTemplates.add(id);
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
  // Read the global-only keys back at save time. Returns null when the Backends section was never
  // rendered in this settings session, so a save cannot clobber the stored values with an empty object.
  //
  // It used to decide that by looking for the default-target select IN THE DOM — but opening a backend's
  // gear page REPLACES the list, select and all. So hitting Save while a gear page was open returned
  // null, and settings-panel.js skipped every backend key: the option the user had just changed on that
  // page was silently discarded unless they happened to click "Backends" first. The panel's own state is
  // the source of truth now; the DOM is only where the current page's edits are read from (#163).
  function readGlobal(root) {
    if (!mountedGlobal) return null;
    const backendEnabled = {};
    const fromDom = root ? root.querySelectorAll('.backend-enable') : [];
    if (fromDom.length) {
      fromDom.forEach(cb => { backendEnabled[cb.dataset.id] = !!cb.checked; });
    } else {
      Object.assign(backendEnabled, liveEnabled);   // the list is off-screen: use what it last showed
    }
    const select = root && root.querySelector('#sv-default-launch-target');
    readBackendEnvFromDom(root);
    const backendEnv = mergedBackendEnv();
    for (const [bid, env] of Object.entries(backendEnv)) {
      if (!env || !Object.keys(env).length) delete backendEnv[bid];
    }
    return {
      backendEnabled,
      defaultLaunchTarget: (select && select.value) || liveLaunchTarget || 'claude',
      backendDefaults: readDefaults(root),
      backendEnv,
      handoffPromptByBackend: readHandoffPrompts(root, 'summarise'),
      handoffReadPromptByBackend: readHandoffPrompts(root, 'read'),
    };
  }

  // Per-backend handoff prompts. Same rule as the launch defaults: only ONE backend's page is in the DOM
  // at a time, so the stored blob is the source of truth and the open page is merged over it. An emptied
  // field is REMOVED (= "use the global prompt"), not stored as an empty string.
  function readHandoffPrompts(root, kind) {
    const stored = (storedHandoffPrompts[kind] || {});
    const pending = (pendingHandoffPrompts[kind] || {});
    const out = { ...stored, ...pending };
    if (root) {
      root.querySelectorAll(`.backend-handoff-prompt[data-kind="${kind}"]`).forEach(el => {
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
  // Store ONLY what the user actually decided (#163). This used to write every option on the open page,
  // which pinned the shipped defaults into the user's settings the first time they hit Save — after
  // which no improved default could ever reach them again. Now an option with its "use the backend's
  // default" box ticked is REMOVED from the blob and resolved from `configFields.default` at launch.
  //
  // Values already on disk are left alone. They are indistinguishable from deliberate choices, and
  // silently dropping someone's settings is worse than carrying a few redundant ones.
  function readDefaults(root) {
    const merged = mergedDefaults();
    if (root) {
      root.querySelectorAll('.backend-inherit-cb').forEach(cb => {
        const bid = cb.dataset.backend;
        const opt = cb.dataset.opt;
        if (!bid || !opt) return;
        if (cb.checked) {                                  // follows the backend's default -> store nothing
          if (merged[bid]) delete merged[bid][opt];
          return;
        }
        const input = root.querySelector(`.backend-default-input[data-backend="${CSS.escape(bid)}"][data-opt="${CSS.escape(opt)}"]`);
        if (!input) return;
        if (!merged[bid]) merged[bid] = {};
        merged[bid][opt] = valueOfInput(input);            // '' and false are VALUES — stored as such
      });
      // A page rendered without the checkboxes (a read-only/disabled view) must not silently drop the
      // options it is showing.
      root.querySelectorAll('.backend-default-input').forEach(el => {
        const bid = el.dataset.backend;
        const opt = el.dataset.opt;
        if (!bid || !opt || el.disabled) return;
        if (root.querySelector(`.backend-inherit-cb[data-backend="${CSS.escape(bid)}"][data-opt="${CSS.escape(opt)}"]`)) return;
        if (!merged[bid]) merged[bid] = {};
        merged[bid][opt] = valueOfInput(el);
      });
    }
    for (const [bid, opts] of Object.entries(merged)) {
      if (!opts || !Object.keys(opts).length) delete merged[bid];
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
    const kind = el.dataset.kind;
    if (!id || !kind) return;
    if (!pendingHandoffPrompts[kind]) pendingHandoffPrompts[kind] = {};
    pendingHandoffPrompts[kind][id] = el.value.trim();   // '' -> dropped on read
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

  /** stored (this scope) ⊕ everything edited since the panel mounted, MINUS what was handed back. */
  function mergedDefaults() {
    const out = {};
    for (const [bid, opts] of Object.entries(storedDefaults || {})) out[bid] = { ...opts };
    for (const [bid, opts] of Object.entries(pendingDefaults || {})) out[bid] = { ...(out[bid] || {}), ...opts };
    // #163: handing an option back to the backend's default must REMOVE it here too — otherwise a
    // re-ticked box would still be saved from the stored blob, and the option would never come loose.
    for (const [bid, opts] of Object.entries(clearedDefaults || {})) {
      for (const opt of Object.keys(opts)) if (out[bid]) delete out[bid][opt];
    }
    return out;
  }

  /**
   * Apply the staged template changes. Called by Save Settings — and ONLY by it.
   *
   * The editor used to write straight to the profiles store, and Delete removed a template there and
   * then. So one screen had two save buttons that meant different things, and Cancel undid one of them.
   * Now both paths stage, and this is where they land.
   *
   * Deletes go first: a rename that frees an id, followed by a new template claiming it, must not collide
   * with the row that is on its way out.
   *
   * Returns { ok, errors[] }. A failure is reported, not swallowed — a template the user believes they
   * saved and that never reached the disk is the worst outcome of the three.
   */
  async function commitTemplates() {
    const errors = [];
    if (!window.api || !window.api.profiles) return { ok: true, errors };

    for (const id of deletedTemplates) {
      // Only ever ask the store to remove something the store actually has. A template created and
      // deleted again within one settings session never reached it — the staging cancels out, and asking
      // anyway would report "not found" about a record the user never created.
      if (!storedTemplateIds.has(id)) continue;
      try {
        const res = await window.api.profiles.delete(id);
        if (res && res.ok === false) errors.push(`${id}: ${res.error || 'could not be deleted'}`);
      } catch (err) {
        errors.push(`${id}: ${(err && err.message) || err}`);
      }
    }

    for (const { profile, allowSecrets } of stagedTemplates.values()) {
      try {
        const res = await window.api.profiles.save(profile, !!allowSecrets);
        if (!res || res.ok === false) errors.push(`${profile.name}: ${(res && res.error) || 'could not be saved'}`);
      } catch (err) {
        errors.push(`${profile.name}: ${(err && err.message) || err}`);
      }
    }

    stagedTemplates = new Map();
    deletedTemplates = new Set();
    return { ok: errors.length === 0, errors };
  }

  window.backendsPanel = { mount, readGlobal, readProjectDefaults, openEditor, commitTemplates };
})();
