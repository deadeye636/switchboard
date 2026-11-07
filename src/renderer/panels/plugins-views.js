// plugins-views.js — the Plugins, Apps and Skills views of the Plugins manager (#803 T9, spec 40).
//
// Three view builders over the shared list kit (panels/plugins-kit.js, loaded before this file). Each reads its
// inventory from main once, when its category is first shown (`bindLazy`), never at bind: a filesystem walk per
// backend before anyone looked is what the settings screen's lazy rule exists to prevent.
//
//   - Plugins: installed plugins, packages and extensions (`getPluginInventory`), in labelled sections by kind. A row
//     says its backend and the state that backend reports; read-only (owner decision E6). The page holds the folder,
//     what the plugin brings, and Open — named by the row's id, checked by main through that backend's own door.
//   - Apps: what a backend reports (`getAppInventory`). None does yet, so the view says so (E3).
//   - Skills: one row per skill file (`getSkillInventory`), grouped by scope. The page holds the path, the other
//     files of that name, what each backend makes of the skill (`getSkillDetail`, sentences served by main), and for
//     an editable row the editor (E11): the same CodeMirror editor the file panel uses, read and saved by the row's
//     id (`readSkill` / `saveSkill`), Ctrl+S included. A save over a change on disk is refused and said; the text in
//     the editor stays, and the disk version is loaded only on request. Leaving the page with unsaved text is refused
//     (the kit's `canLeave`). "New skill" creates one in a folder main offers (`getSkillPlaces` / `createSkill`, from
//     the backend's own scaffold) and opens its page.
//
// It names no backend and derives nothing a backend owns: every label, state and sentence is served by main. Every
// string goes in with textContent. Loaded in settings.html only; `window.pluginsViews`.
(function () {
  'use strict';

  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function button(label, onClick, opts) {
    const b = node('button', 'settings-action-btn' + (opts && opts.danger ? ' danger' : ''), label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function line(label, value) {
    const row = node('div', 'plugins-fact');
    row.appendChild(node('span', 'sv-mcp-card-transport', label));
    row.appendChild(node('span', 'plugins-fact-value', value));
    return row;
  }

  const api = () => window.api || {};

  /** Mount `mount()` the first time the category is shown; a later show mounts nothing new. */
  function bindLazy(section, mount) {
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      mount();
    };
    section.addEventListener('settings-cat-shown', run);
    return run;
  }

  // ---- Plugins ----------------------------------------------------------------------------------------------

  const KIND_SECTIONS = [['plugin', 'Plugins'], ['package', 'Packages'], ['extension', 'Extensions']];

  function stateSentence(row) {
    if (row.state === 'enabled') return `Switched on in ${row.backendLabel}'s settings.`;
    if (row.state === 'disabled') return `Installed, switched off in ${row.backendLabel}'s settings.`;
    return `${row.backendLabel} does not report whether it is on.`;
  }

  async function mountPlugins(host, ctx) {
    host.textContent = '';
    host.appendChild(node('div', 'settings-hint', 'Reading the installed plugins…'));
    let res = null;
    try { res = await api().getPluginInventory(ctx.projectPath || null); } catch { res = null; }
    const rows = res && Array.isArray(res.plugins) ? res.plugins : null;
    if (!rows) {
      host.textContent = '';
      host.appendChild(node('div', 'sv-mcp-problem', 'The installed plugins could not be read.'));
      return null;
    }
    return window.pluginsKit.mountView(host, {
      filterPlaceholder: 'Filter plugins',
      filterKey: 'plugins',
      rowGroups: cliGroups,
      emptyText: 'No plugins installed for any CLI here.',
      sections: KIND_SECTIONS.map(([kind, title]) => ({ title, rows: rows.filter(r => r.kind === kind) })),
      rowKey: (r) => r.id,
      rowLabel: (r) => r.name,
      rowMeta: (r) => `${r.backendLabel} · ${r.state === 'not reported' ? 'state not reported' : r.state}`,
      renderDetail: (r, c) => {
        c.appendChild(node('div', 'settings-description', stateSentence(r)));
        c.appendChild(line('Scope', r.scope));
        if (r.path) c.appendChild(line('Folder', r.path));
        if (r.brings && r.brings.length) c.appendChild(line('Brings', r.brings.join(', ')));
        const msg = node('div', 'settings-hint sv-mcp-form-msg');
        msg.setAttribute('aria-live', 'polite');
        if (r.path) {
          const actions = node('div', 'sv-mcp-card-actions');
          actions.appendChild(button('Open folder', async () => {
            msg.textContent = '';
            let out = null;
            try { out = await api().openPlugin(r.id, ctx.projectPath || null); } catch { out = null; }
            if (!out || out.ok === false) msg.textContent = (out && out.reason) || 'The folder could not be opened.';
          }));
          c.appendChild(actions);
        }
        c.appendChild(msg);
      },
    });
  }

  // The chip groups of a plugin or an app row (#824): main stamps `cli: { key, label }` — one chip per CLI.
  function cliGroups(r) {
    return r && r.cli && r.cli.key != null ? [r.cli] : [];
  }

  // ---- Apps -------------------------------------------------------------------------------------------------

  async function mountApps(host, ctx) {
    host.textContent = '';
    let res = null;
    try { res = await api().getAppInventory(ctx.projectPath || null); } catch { res = null; }
    const rows = res && Array.isArray(res.apps) ? res.apps : null;
    if (!rows) {
      host.appendChild(node('div', 'sv-mcp-problem', 'The apps could not be read.'));
      return null;
    }
    return window.pluginsKit.mountView(host, {
      filterPlaceholder: 'Filter apps',
      filterKey: 'apps',
      rowGroups: cliGroups,
      emptyText: 'No installed CLI reports apps yet.',
      sections: [{ title: '', rows }],
      rowKey: (r) => r.id,
      rowLabel: (r) => r.name,
      rowMeta: (r) => `${r.backendLabel} · ${r.state}`,
      renderDetail: (r, c) => c.appendChild(line('Reported by', r.backendLabel)),
    });
  }

  // ---- Skills -----------------------------------------------------------------------------------------------

  // The editor: the file panel's CodeMirror editor, from the bundle loaded at run time (the CSP pattern every page
  // beside index.html uses). A caller (a test) may hand in its own factory with the same small interface.
  let bundlePromise = null;
  function loadEditorBundle() {
    if (typeof window.createEditableViewer === 'function') return Promise.resolve();
    if (bundlePromise) return bundlePromise;
    bundlePromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'codemirror-bundle.js';
      s.onload = () => resolve();
      s.onerror = (err) => { bundlePromise = null; reject(err); };
      document.head.appendChild(s);
    });
    return bundlePromise;
  }

  /** -> { getText(), setText(text), onSave(cb), destroy() } over the shared CodeMirror editor. */
  async function codeMirrorEditor(parent, text) {
    await loadEditorBundle();
    const view = window.createEditableViewer(parent, text, 'SKILL.md', { wrap: true });
    return {
      getText: () => view.state.doc.toString(),
      setText: (t) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t } }),
      onSave: (cb) => view.dom.addEventListener('cm-save', cb),
      destroy: () => view.destroy(),
    };
  }

  function skillEditor(container, row, ctx, state) {
    const box = node('div', 'plugins-skill-edit');
    const head = node('div', 'settings-section-title', 'Edit');
    const area = node('div', 'plugins-skill-editor');
    const msg = node('div', 'settings-hint sv-mcp-form-msg');
    msg.setAttribute('aria-live', 'polite');
    // Its own line: a refused Back must not wipe a conflict's "Load the version on disk" out of `msg`.
    const leaveNote = node('div', 'sv-mcp-warning');
    leaveNote.setAttribute('aria-live', 'polite');
    const actions = node('div', 'sv-mcp-card-actions');
    box.append(head, area, actions, msg, leaveNote);
    container.appendChild(box);
    area.appendChild(node('div', 'settings-hint', 'Opening the skill…'));

    // The disk version a conflicting save met, shown read-only so it can be compared before anything is chosen.
    const conflictBox = node('div', 'plugins-skill-conflict');
    conflictBox.hidden = true;
    box.insertBefore(conflictBox, msg);

    let editor = null;
    let baseline = null;
    let saving = false;
    const dirty = () => !!editor && baseline !== null && editor.getText() !== baseline;
    state.canLeave = () => {
      if (!dirty()) { leaveNote.textContent = ''; return true; }
      leaveNote.textContent = 'This skill has unsaved changes. Save them or press Discard first.';
      return false;
    };

    const clearConflict = () => { conflictBox.hidden = true; conflictBox.textContent = ''; };
    const showConflict = (disk) => {
      conflictBox.textContent = '';
      conflictBox.appendChild(node('div', 'settings-label', 'The version on disk now'));
      conflictBox.appendChild(node('pre', 'plugins-skill-disk', disk));
      const choices = node('div', 'sv-mcp-card-actions');
      choices.appendChild(button('Save mine over it', () => {
        // The user has seen what is on disk and chose their text: the disk text becomes the baseline.
        baseline = disk;
        clearConflict();
        save();
      }));
      choices.appendChild(button('Load the version on disk', () => {
        editor.setText(disk);
        baseline = disk;
        clearConflict();
        msg.textContent = 'Loaded the version on disk.';
        leaveNote.textContent = '';
      }));
      conflictBox.appendChild(choices);
      conflictBox.hidden = false;
    };

    async function save() {
      // One save at a time: a second Ctrl+S would send the same baseline and meet a false conflict.
      if (!editor || baseline === null || saving) return;
      saving = true;
      msg.textContent = 'Saving…';
      let res = null;
      try { res = await api().saveSkill(row.id, ctx.projectPath || null, editor.getText(), baseline); } catch { res = null; }
      saving = false;
      if (state.dead) return;
      if (res && res.ok) {
        baseline = typeof res.content === 'string' ? res.content : editor.getText();
        clearConflict();
        msg.textContent = 'Saved.';
        leaveNote.textContent = '';
        return;
      }
      if (res && res.conflict) {
        msg.textContent = 'The file changed on disk since it was opened. Your text is kept here; nothing was written.';
        showConflict(typeof res.diskContent === 'string' ? res.diskContent : '');
        return;
      }
      msg.textContent = (res && res.reason) || 'The skill could not be saved.';
    }
    const saveBtn = button('Save', save);
    const discardBtn = button('Discard', () => {
      if (!editor || baseline === null) return;
      editor.setText(baseline);
      clearConflict();
      msg.textContent = '';
      leaveNote.textContent = '';
    });
    // Nothing to press until there is an editor to act on.
    saveBtn.disabled = true;
    discardBtn.disabled = true;
    actions.append(saveBtn, discardBtn);

    (async () => {
      let res = null;
      try { res = await api().readSkill(row.id, ctx.projectPath || null); } catch { res = null; }
      if (state.dead) return;
      area.textContent = '';
      if (!res || res.ok === false) {
        msg.textContent = (res && res.reason) || 'The skill could not be read.';
        return;
      }
      let made = null;
      try {
        made = await (ctx.createEditor || codeMirrorEditor)(area, res.content);
      } catch {
        if (!state.dead) msg.textContent = 'The editor could not be loaded.';
        return;
      }
      // The page was left while the editor loaded: release it at once rather than keep it alive unseen.
      if (state.dead) { try { made.destroy(); } catch {} return; }
      editor = made;
      baseline = res.content;
      editor.onSave(save);
      saveBtn.disabled = false;
      discardBtn.disabled = false;
      state.destroy = () => { try { editor.destroy(); } catch {} };
    })();
  }

  async function deliveryTable(container, row, ctx) {
    const box = node('div', 'plugins-delivery');
    box.appendChild(node('div', 'settings-section-title', 'What each CLI makes of it'));
    const list = node('div', 'plugins-delivery-list');
    list.appendChild(node('div', 'settings-hint', 'Asking each CLI…'));
    box.appendChild(list);
    container.appendChild(box);
    let res = null;
    try { res = await api().getSkillDetail(row.id, ctx.projectPath || null); } catch { res = null; }
    list.textContent = '';
    if (!res || res.ok === false || !Array.isArray(res.targets)) {
      list.appendChild(node('div', 'settings-hint', (res && res.reason) || 'This could not be worked out.'));
      return;
    }
    for (const t of res.targets) {
      const r = node('div', 'plugins-delivery-row');
      r.dataset.state = typeof t.state === 'string' ? t.state : '';
      r.appendChild(node('span', 'settings-label', t.targetLabel));
      r.appendChild(node('span', 'settings-description', t.sentence));
      if (t.invocation) r.appendChild(node('code', 'plugins-invocation', t.invocation));
      list.appendChild(r);
    }
  }

  async function readSkillRows(ctx) {
    let res = null;
    try { res = await api().getSkillInventory(ctx.projectPath || null); } catch { res = null; }
    return res && Array.isArray(res.skills) ? res.skills : null;
  }

  // "New skill" (#803 T12a, E15): a small form above the list. The places are main's answer — a label and an opaque
  // id each, read when the form opens; the file comes from the backend's own scaffold, and its page opens after.
  function newSkillForm(anchor, ctx, onCreated) {
    const existing = anchor.parentNode && anchor.parentNode.querySelector(':scope > .plugins-new-skill');
    if (existing) { const input = existing.querySelector('input'); if (input) input.focus(); return; }
    const form = node('div', 'sv-mcp-form plugins-new-skill');
    form.appendChild(node('div', 'settings-section-title', 'New skill'));
    const place = document.createElement('select');
    place.className = 'settings-select';
    place.setAttribute('aria-label', 'Folder for the new skill');
    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'settings-input';
    name.spellcheck = false;
    name.placeholder = 'skill-name';
    name.setAttribute('aria-label', 'Name of the new skill');
    const msg = node('div', 'sv-mcp-problem sv-mcp-form-msg');
    msg.setAttribute('aria-live', 'polite');
    const fieldOf = (label, control) => {
      const f = node('div', 'sv-mcp-form-field');
      f.appendChild(node('span', 'settings-label', label));
      f.appendChild(control);
      return f;
    };
    form.appendChild(fieldOf('Folder', place));
    form.appendChild(fieldOf('Name', name));
    const actions = node('div', 'sv-mcp-form-actions');
    const create = button('Create', async () => {
      msg.textContent = '';
      if (!place.value) { msg.textContent = 'There is no folder to create it in.'; return; }
      create.disabled = true;
      let out = null;
      try { out = await api().createSkill(place.value, name.value, ctx.projectPath || null); } catch { out = null; }
      create.disabled = false;
      if (!out || !out.ok) { msg.textContent = (out && out.reason) || 'The skill could not be created.'; return; }
      // A skill page opened while the create was out closed the form: the user went elsewhere, so the new skill
      // joins the list without pulling them off that page.
      const stillHere = form.isConnected;
      form.remove();
      onCreated(out.id, stillHere);
    });
    actions.appendChild(create);
    actions.appendChild(button('Cancel', () => form.remove()));
    form.appendChild(actions);
    form.appendChild(msg);
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create.click(); } });
    anchor.parentNode.insertBefore(form, anchor);

    create.disabled = true;
    (async () => {
      let res = null;
      try { res = await api().getSkillPlaces(ctx.projectPath || null); } catch { res = null; }
      const places = res && res.ok && Array.isArray(res.places) ? res.places : null;
      if (!places) { msg.textContent = (res && res.reason) || 'The folders could not be read.'; return; }
      if (!places.length) { msg.textContent = 'No CLI here has a skills folder to create a skill in.'; return; }
      for (const p of places) {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = p.label;
        place.appendChild(o);
      }
      create.disabled = false;
      name.focus();
    })();
  }

  async function mountSkills(host, ctx) {
    host.textContent = '';
    host.appendChild(node('div', 'settings-hint', 'Reading the skills…'));
    const rows = await readSkillRows(ctx);
    if (!rows) {
      host.textContent = '';
      host.appendChild(node('div', 'sv-mcp-problem', 'The skills could not be read.'));
      return null;
    }
    // One editor page at a time: what it may refuse (unsaved text) and what it must release (the editor). A page
    // that is left is marked dead, so an editor still loading for it destroys itself on arrival.
    let page = {};
    const releasePage = () => {
      page.dead = true;
      if (page.destroy) page.destroy();
      page = {};
    };
    let view = null;
    // The form belongs to the list: a skill page that opens closes it, so a create never lands on top of a page
    // holding unsaved text. The new skill's page opens only when the list is what is on screen.
    const closeForm = () => {
      const form = host.parentNode && host.parentNode.querySelector(':scope > .plugins-new-skill');
      if (form) form.remove();
    };
    const afterCreate = async (id, navigate) => {
      const next = await readSkillRows(ctx);
      if (!next || !view) return;
      view.refresh(spec(next));
      // From the rows, not the DOM: a refresh under an open page redraws no list until Back.
      if (typeof ctx.onCount === 'function') ctx.onCount(next.length);
      if (id && navigate && view.showList({ focus: false }) !== false) view.openDetail(id);
    };
    const spec = (list) => ({
      filterPlaceholder: 'Filter skills',
      filterKey: 'skills',
      // A skill file can be reported by several CLIs (`clis`), so it sits under each of their chips.
      rowGroups: (r) => (Array.isArray(r.clis) ? r.clis : []),
      emptyText: 'No skills found for any CLI here.',
      actions: [{ label: 'New skill', onClick: () => newSkillForm(host, ctx, afterCreate) }],
      sections: [
        { title: 'This project', rows: list.filter(r => r.scope === 'project') },
        { title: 'Global', rows: list.filter(r => r.scope !== 'project') },
      ],
      rowKey: (r) => r.id,
      rowLabel: (r) => r.name,
      rowMeta: (r) => r.sourceLabel,
      // Asked without moving (the settings screen asks every view before any of them goes back), so it only answers;
      // the editor is released in `onLeave`, once the page really goes.
      canLeave: () => !(page.canLeave && !page.canLeave()),
      onLeave: releasePage,
      renderDetail: (r, c) => {
        releasePage();
        closeForm();
        c.appendChild(line('Source', r.sourceLabel));
        c.appendChild(line('File', r.filePath));
        for (const o of r.alsoNamed || []) c.appendChild(line('Also named in', `${o.sourceLabel} — ${o.filePath}`));
        deliveryTable(c, r, ctx);
        if (r.editable) skillEditor(c, r, ctx, page);
        else c.appendChild(node('div', 'settings-hint', 'This skill is read-only here: the CLI it belongs to does not let Switchboard edit it.'));
        if (r.deletable) deleteControl(c, r);
      },
    });
    // Delete (E16): asked first, then main deletes through the CLI's own listing. The editor's text goes with the
    // skill, so the page is released before the list is redrawn without the row.
    const deleteControl = (c, r) => {
      const msg = node('div', 'settings-hint sv-mcp-form-msg');
      msg.setAttribute('aria-live', 'polite');
      const actions = node('div', 'sv-mcp-card-actions');
      actions.appendChild(button('Delete skill', async () => {
        msg.textContent = '';
        const unsaved = !!(page.canLeave && !page.canLeave());
        const ok = typeof showControlDialog === 'function' ? await showControlDialog({
          title: 'Delete skill',
          message: 'The skill is deleted from disk, with its folder and everything in it. This cannot be undone.'
            + (unsaved ? ' Unsaved changes in the editor are discarded.' : ''),
          confirmLabel: 'Delete skill',
          tone: 'danger',
          details: { Skill: r.name, File: r.filePath },
        }) : false;
        if (!ok) return;
        let out = null;
        try { out = await api().deleteSkill(r.id, ctx.projectPath || null); } catch { out = null; }
        if (!out || !out.ok) { msg.textContent = (out && out.reason) || 'The skill could not be deleted.'; return; }
        // The skill is gone either way: its editor goes now, and the page with it.
        releasePage();
        const next = await readSkillRows(ctx);
        if (!view) return;
        if (!next) { view.showList({ focus: false }); return; }
        view.refresh(spec(next));
        if (typeof ctx.onCount === 'function') ctx.onCount(next.length);
      }, { danger: true }));
      c.appendChild(actions);
      c.appendChild(msg);
    };
    view = window.pluginsKit.mountView(host, spec(rows));
    return view;
  }

  window.pluginsViews = { bindLazy, mountPlugins, mountApps, mountSkills };
})();
