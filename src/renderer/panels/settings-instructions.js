// settings-instructions.js — the Instructions category of the settings screen (#823 T6, spec 44, plan P1 and P9).
//
// Its own nav item in both windows, beside the Plugins group and not in it: instruction, memory and settings files are
// what a CLI already reads, not something added to it. The page is `pluginsViews.mountItemView` (panels/plugins-views.js,
// loaded before this file) with another door, so the list with its per-CLI chips, the detail page, the editor, the
// conflict handling and the read-only viewer exist once.
//
//   - Rows come from main's neutral inventory (`getInstructionInventory(scope)`): `{ id, name, kind, section, scope, ext,
//     cli, clis, sourceLabel, editable }` and `declines`. The window sees no path and no backend id. `scope` is `'global'`
//     in the global window and the project's path in a project window: each window shows its own scope (P9) and points
//     to the other with a line above the list.
//   - Read, save and the content filter go through the id-based doors (`readInstruction`, `saveInstruction`,
//     `matchInstructionContent`). There is no New and no Delete: instruction files are not created or removed here.
//   - A row that is not `editable` opens in a read-only viewer. The syntax verdict of a JSON/TOML/YAML save is main's
//     reason, shown where the editor shows any refusal.
//   - Read on the category's first `settings-cat-shown` (`pluginsViews.bindLazy`), never at bind; the nav badge is the row
//     count (`data-count-own`). Unsaved text in an open page stops anything that drops the screen through the kit
//     (`settingsPlugins.bind`'s `leave()`, which asks every kit view).
//
// Every string goes in with textContent. Loaded in settings.html only; `window.settingsInstructions`.
(function () {
  'use strict';

  const CAT = 'instructions';
  const api = () => window.api || {};

  // The sections in the order main groups them; `section` on a row is already the name shown. One without rows is left out.
  const SECTIONS = ['Instructions', 'Memory', 'Settings files', 'Output styles', 'Resources'];

  function navHtml() {
    return `
          <div class="settings-nav-sep"></div>
          <button class="settings-nav-item" data-cat="${CAT}" data-count-own="1">Instructions <span class="settings-nav-count" hidden></span></button>`;
  }

  function sectionHtml(scope) {
    const where = scope === 'project' ? 'for this project' : 'on this machine';
    return `
        <section class="settings-cat" data-cat="${CAT}">
          <div class="settings-cat-head"><h2>Instructions</h2><p>The instruction, memory and settings files each CLI reads ${where}, with an editor.</p></div>
          <div class="sv-instr-pointer"></div>
          <div class="sv-plugins-host" data-view="instructions"></div>
        </section>`;
  }

  /** -> mount(host, ctx) for the Instructions page. */
  function mountInstructions(host, ctx) {
    const views = window.pluginsViews;
    const scope = ctx.projectPath || 'global';
    return views.mountItemView(host, ctx, {
      io: {
        noun: 'file',
        nounTitle: 'File',
        // Only the extension main sends, so the editor picks the syntax.
        fileHint: (r) => `item${r && r.ext ? r.ext : '.md'}`,
        read: (id) => api().readInstruction(id, scope),
        save: (id, text, baseline) => api().saveInstruction(id, scope, text, baseline),
      },
      reading: 'Reading the instruction files…',
      readError: 'The instruction files could not be read.',
      filterPlaceholder: 'Filter instruction files',
      filterKey: 'instructions',
      matchContent: async (q) => {
        const res = await api().matchInstructionContent(scope, q);
        return res && res.ok && Array.isArray(res.ids) ? res.ids : [];
      },
      emptyText: 'No instruction files found for any CLI here.',
      read: async () => {
        let res = null;
        try { res = await api().getInstructionInventory(scope); } catch { res = null; }
        if (!res || res.ok === false || !Array.isArray(res.rows)) return null;
        return { rows: res.rows, declines: Array.isArray(res.declines) ? res.declines : [] };
      },
      // Nothing is created here: the kit offers no New.
      probeCreate: async () => false,
      sections: (list) => {
        const out = SECTIONS.map(title => ({ title, rows: list.filter(r => r.section === title) }));
        // A section this build does not know still shows its rows.
        const other = list.filter(r => !SECTIONS.includes(r.section));
        if (other.length) out.push({ title: 'Other', rows: other });
        return out.filter(s => s.rows.length);
      },
      renderFacts: (r, c) => {
        c.appendChild(views.line('Source', r.sourceLabel));
        if (r.kind) c.appendChild(views.line('Kind', r.kind));
      },
      readOnlyText: () => 'This file is read-only here: Switchboard does not edit this kind of file.',
      deleteDetails: () => ({}),
    });
  }

  /**
   * The line above the list that points to the other scope (P9). The global window offers a project to open; a project
   * window offers the global list. Either replaces this window, so a page with unsaved text is asked first.
   */
  function bindPointer(body, signal, { scope, mayLeave }) {
    const box = body.querySelector(`.settings-cat[data-cat="${CAT}"] .sv-instr-pointer`);
    if (!box) return null;
    const make = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text) n.textContent = text;
      return n;
    };
    const go = make('button', 'settings-action-btn');
    go.type = 'button';
    const open = async (target, path, message, confirmLabel, details) => {
      if (mayLeave && !mayLeave()) return;
      const ok = typeof showControlDialog === 'function' ? await showControlDialog({
        title: confirmLabel, message, confirmLabel, tone: 'warning', ...(details ? { details } : {}),
      }) : true;
      if (!ok || !window.api || typeof window.api.openSettingsWindow !== 'function') return;
      window.api.openSettingsWindow(target, path, { cat: CAT });
    };
    if (scope === 'project') {
      box.appendChild(make('span', 'settings-hint', 'This project\'s files. The files that apply to every project are in the global settings.'));
      go.textContent = 'Open the global instructions';
      go.addEventListener('click', () => open('global', null,
        'This window switches to the global settings. Changes here that you have not saved are lost.', 'Open global settings'), { signal });
      box.appendChild(go);
      return null;
    }
    const ext = window.settingsExternalMcp;
    box.appendChild(make('span', 'settings-hint', 'The files that apply to every project. A project\'s own files are in its settings.'));
    if (!ext || typeof ext.fillPicker !== 'function') return null;
    const picker = make('select', 'settings-select');
    picker.setAttribute('aria-label', 'Project whose instruction files to open');
    go.textContent = 'Open its instructions';
    box.append(picker, go);
    ext.fillPicker(picker, go, null);
    const msg = make('div', 'settings-hint sv-mcp-form-msg');
    box.appendChild(msg);
    go.addEventListener('click', () => {
      if (!picker.value) { msg.textContent = 'Choose a project first.'; return; }
      msg.textContent = '';
      const option = picker.selectedOptions && picker.selectedOptions[0];
      open('project', picker.value,
        'This window switches to the project\'s settings. Changes here that you have not saved are lost.', 'Open project settings',
        { Project: option ? option.textContent : picker.value });
    }, { signal });
    return async () => {
      let res = null;
      try { res = await window.api.getProjectsAdmin(); } catch { res = null; }
      if (signal.aborted) return;
      const projects = ext.pickableProjects(res);
      ext.fillPicker(picker, go, projects === null ? 'The project list could not be read.'
        : projects.length ? projects : 'No project on the list yet.');
    };
  }

  /** Wire the category into a rendered settings body. `setCount(cat, n)` writes the nav badge. */
  function bind(body, signal, { scope, projectPath, setCount, mayLeave }) {
    const sectionEl = body.querySelector(`.settings-cat[data-cat="${CAT}"]`);
    const host = sectionEl && sectionEl.querySelector('.sv-plugins-host');
    if (!sectionEl || !host || !window.pluginsViews) return;
    const loadProjects = bindPointer(body, signal, { scope, mayLeave });
    const ctx = { projectPath: scope === 'project' ? projectPath : null };
    window.pluginsViews.bindLazy(sectionEl, async () => {
      if (loadProjects) loadProjects();
      await mountInstructions(host, { ...ctx, onCount: (n) => { if (!signal.aborted) setCount(CAT, n); } });
      if (signal.aborted) return;
      setCount(CAT, host.querySelectorAll('.plugins-list-page .plugins-row').length);
    });
  }

  window.settingsInstructions = { CAT, SECTIONS, navHtml, sectionHtml, mountInstructions, bind };
})();
