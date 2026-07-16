// --- Saved variables: session quick-pick + shared secret-safe insertion ---
//
// The terminal-header key button opens a compact quick-pick popover anchored to
// the icon (no CRUD — that lives in the Variables admin tab, see
// variables-admin.js). Each row can Insert (no newline), Send (with newline) or
// Copy an applicable variable (global + the active session's project).
//
// SECURITY: a secret's plaintext must never be typed into the terminal. For
// insert/send we ask main to resolve the variable's insert-template
// (resolveVariableInsert) — it may inline the raw value, a temp-file path, or a
// shell reference that reads the file at exec time. Shells that can't do inline
// refs (cmd/unknown/WSL) fall back to clipboard copy.
//
// window.variablesInsert exposes applyVariable so the terminal context-menu
// (terminal-context-menu.js) shares the exact same secret-safe path.

(function () {
  let popover = null;

  function html(value) {
    return escapeHtml(String(value ?? ''));
  }

  function toast(message) {
    if (typeof showControlToast === 'function') showControlToast({ message, timeoutMs: 3000 });
  }

  async function copyToClipboard(text) {
    try { await window.api.writeClipboard(String(text ?? '')); return true; }
    catch { return false; }
  }

  async function fetchValue(id) {
    const res = await window.api.getSavedVariable(id);
    if (!res || !res.ok || !res.variable) throw new Error(res?.error || 'Variable not found');
    return res.variable.value || '';
  }

  // Apply a variable to a session. mode: 'insert' | 'send' | 'copy'.
  // ctx: { sessionId, projectPath, running }. Returns true on success.
  async function applyVariable(variable, mode, ctx = {}) {
    const id = variable.id;
    if (mode === 'copy') {
      const ok = await copyToClipboard(await fetchValue(id));
      toast(ok ? 'Copied' : 'Copy failed');
      return ok;
    }
    if (!ctx.running || !ctx.sessionId) { toast('No running terminal'); return false; }

    // Main resolves the insert-template (raw value, temp-file path, or shell ref)
    // so a secret's plaintext only leaves main when the template says so. It reads the shell family off the
    // session itself — the renderer used to pass it, which meant main was TOLD the one thing the {ref}
    // decision turns on, and told it from the project's CLI shell profile even for a plain terminal.
    const res = await window.api.resolveVariableInsert(id, ctx.sessionId);
    let text;
    if (res && res.ok && typeof res.text === 'string') {
      text = res.text;
    } else if (res && res.fallback === 'copy') {
      await copyToClipboard(res.value ?? await fetchValue(id));
      toast("Secret copied — paste manually (shell doesn't support inline refs)");
      return false;
    } else {
      toast(res?.error || 'Could not resolve variable');
      return false;
    }

    window.api.sendInput(ctx.sessionId, text + (mode === 'send' ? '\n' : ''));
    try { window._openSessions?.get(ctx.sessionId)?.terminal?.focus(); } catch {}
    return true;
  }

  window.variablesInsert = { applyVariable };

  // --- Quick-pick popover ---

  function closeQuickPick() {
    if (!popover) return;
    document.removeEventListener('mousedown', onOutsideClick, true);
    document.removeEventListener('keydown', onKey, true);
    popover.remove();
    popover = null;
  }

  function onOutsideClick(event) {
    if (popover && !popover.contains(event.target)) closeQuickPick();
  }
  function onKey(event) {
    if (event.key === 'Escape') closeQuickPick();
  }

  function rowHtml(variable, running) {
    const disabled = running ? '' : 'disabled';
    return `
      <div class="vqp-row" data-id="${html(variable.id)}" data-secret="${variable.secret ? '1' : '0'}">
        <div class="vqp-row-name">
          <span class="vqp-name">${html(variable.name)}</span>
          ${variable.secret ? '<span class="vqp-secret-pill">Secret</span>' : ''}
        </div>
        <div class="vqp-row-actions">
          <button type="button" data-vqp-action="insert" ${disabled} title="Insert (no newline)">Insert</button>
          <button type="button" data-vqp-action="send" ${disabled} title="Send (with newline)">Send</button>
          <button type="button" data-vqp-action="copy" title="Copy value">Copy</button>
        </div>
      </div>`;
  }

  function groupHtml(label, variables, running) {
    if (!variables.length) return '';
    return `
      <div class="vqp-group-label">${html(label)}</div>
      ${variables.map(v => rowHtml(v, running)).join('')}`;
  }

  function position(anchor) {
    const rect = anchor.getBoundingClientRect();
    popover.style.position = 'fixed';
    const pw = popover.offsetWidth;
    let left = rect.right - pw;
    if (left < 8) left = 8;
    let top = rect.bottom + 6;
    const ph = popover.offsetHeight;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, rect.top - ph - 6);
    popover.style.left = left + 'px';
    popover.style.top = top + 'px';
  }

  async function showVariablesQuickPick(context = {}) {
    closeQuickPick();
    const projectPath = context.projectPath || null;
    const sessionId = context.sessionId || null;
    const running = !!context.running;

    popover = document.createElement('div');
    popover.className = 'popover variables-quickpick';
    popover.innerHTML = `
      <div class="vqp-header">
        <span class="vqp-title">Variables</span>
        <button type="button" class="vqp-manage" data-vqp-manage>Manage…</button>
      </div>
      <div class="vqp-body"><div class="vqp-loading">Loading…</div></div>`;
    document.body.appendChild(popover);
    if (context.anchor) position(context.anchor);

    popover.querySelector('[data-vqp-manage]').addEventListener('click', () => {
      closeQuickPick();
      window.openVariablesTab?.();
    });

    const rows = await window.api.listSavedVariables(projectPath).catch(() => []);
    if (!popover) return; // closed while awaiting

    const list = Array.isArray(rows) ? rows : [];
    const global = list.filter(v => v.scope !== 'project');
    const project = list.filter(v => v.scope === 'project');

    const body = popover.querySelector('.vqp-body');
    if (!list.length) {
      body.innerHTML = '<div class="vqp-empty">No variables. Use Manage… to add some.</div>';
    } else {
      body.innerHTML = groupHtml('Global', global, running) + groupHtml('Project', project, running);
    }
    if (context.anchor) position(context.anchor);

    body.addEventListener('click', async (event) => {
      const btn = event.target.closest('[data-vqp-action]');
      if (!btn) return;
      const row = btn.closest('.vqp-row');
      if (!row) return;
      const id = row.dataset.id;
      const secret = row.dataset.secret === '1';
      const mode = btn.dataset.vqpAction;
      try {
        await applyVariable({ id, secret }, mode, { sessionId, projectPath, running });
      } catch (err) {
        toast(err.message);
      }
      if (mode !== 'copy') closeQuickPick();
    });

    setTimeout(() => {
      document.addEventListener('mousedown', onOutsideClick, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
  }

  window.showVariablesQuickPick = showVariablesQuickPick;
})();
