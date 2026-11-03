// settings-plugins.js — the Plugins group of the settings screen (#803 T10, spec 40 D7, E1, E7, E8, E9).
//
// One "Plugins" head in the nav with five items — Plugins, Apps, MCPs, Skills, Marketplace — in both windows (E1: a
// group in the existing Settings window; E7: nav items, not a tab strip). This file holds the group's nav markup, the
// sections the views draw into, and the wiring; the views themselves are panels/plugins-views.js (Plugins, Apps,
// Skills) and panels/settings-external-mcp.js (MCPs, Marketplace).
//
//   - Plugins, Apps, Skills read on their category's first `settings-cat-shown` (`pluginsViews.bindLazy`), never at
//     bind; their nav badge is the row count, written once the view has read (`data-count-own`).
//   - MCPs: in a project window the existing project MCP category (`mcp`, staged until Save); in the global window
//     there is no machine-wide list (spec 36 D-B4), so the view explains that and offers a project picker that
//     opens that project's Settings on its MCPs (E8).
//   - Marketplace: the catalog and registry search (`mcp-addons`). In a project window "Add to this project" opens
//     this window's own Add form prefilled, staged (E9); in the global window the picker hands it to a project.
//
// `leave()` asks every mounted view whether it may go back to its list (a skill page with unsaved text refuses), so
// Cancel, Save, Apply and the settings search can stop before work is dropped. It names no backend. Loaded in
// settings.html only, before settings-panel.js; `window.settingsPlugins`.
(function () {
  'use strict';

  // The category ids of the group, in nav order. `mcp` is the project window's MCP category (settings-external-mcp.js),
  // `plugins-mcps` the global window's explanation; `mcp-addons` the Marketplace in both.
  const CATS = {
    plugins: 'plugins-plugins',
    apps: 'plugins-apps',
    skills: 'plugins-skills',
    globalMcps: 'plugins-mcps',
    projectMcps: 'mcp',
    marketplace: 'mcp-addons',
  };
  // The categories a deep link may land on (`openSettingsWindow(scope, path, { cat })`); main validates the same list.
  const SEED_CATS = [CATS.plugins, CATS.apps, CATS.skills, CATS.globalMcps, CATS.projectMcps, CATS.marketplace];

  function navHtml(scope) {
    const mcps = scope === 'project' ? CATS.projectMcps : CATS.globalMcps;
    const item = (cat, label) => `<button class="settings-nav-item" data-cat="${cat}" data-count-own="1">${label} <span class="settings-nav-count" hidden></span></button>`;
    return `
          <div class="settings-nav-sep"></div>
          <div class="settings-nav-head">Plugins</div>
          ${item(CATS.plugins, 'Plugins')}
          ${item(CATS.apps, 'Apps')}
          ${item(mcps, 'MCPs')}
          ${item(CATS.skills, 'Skills')}
          ${item(CATS.marketplace, 'Marketplace')}`;
  }

  function section(cat, title, subtitle, inner) {
    return `
        <section class="settings-cat" data-cat="${cat}">
          <div class="settings-cat-head"><h2>${title}</h2><p>${subtitle}</p></div>
          ${inner}
        </section>`;
  }

  /** The sections of the group this window does not already have (the project MCP section and the global Marketplace exist). */
  function sectionsHtml(scope) {
    const where = scope === 'project' ? 'for this project' : 'on this machine';
    let html = section(CATS.plugins, 'Plugins', `What each CLI has installed ${where}, and whether it is switched on.`, '<div class="sv-plugins-host" data-view="plugins"></div>')
      + section(CATS.apps, 'Apps', 'Apps a CLI reports.', '<div class="sv-plugins-host" data-view="apps"></div>')
      + section(CATS.skills, 'Skills', `Every skill file ${where}, what each CLI makes of it, and its editor.`, '<div class="sv-plugins-host" data-view="skills"></div>');
    if (scope === 'project') {
      html += section(CATS.marketplace, 'Marketplace', 'A short, reviewed list of external MCP servers and the official registry. Add one to this project; it is stored when you press Save.', '<div id="sv-mcp-addons"></div>');
    } else {
      html += section(CATS.globalMcps, 'MCPs', 'MCP servers are set per project.', `
          <div class="settings-section">
            <div class="settings-field settings-field-wide">
              <div class="settings-field-info">
                <span class="settings-label">Open a project's MCP servers</span>
                <div class="settings-description">There is no machine-wide MCP list: each project keeps its own, and every session of that project gets it. Pick a project to open its settings on its MCP servers.</div>
              </div>
              <div class="settings-field-control"><div class="sv-mcp-row" id="sv-plugins-mcps-pick"></div></div>
            </div>
            <div class="settings-hint sv-mcp-form-msg" id="sv-plugins-mcps-msg"></div>
          </div>`);
    }
    return html;
  }

  /** The badge of one nav item, from a number (empty for zero). */
  function setCount(body, cat, n) {
    const badge = body.querySelector(`.settings-nav-item[data-cat="${cat}"] .settings-nav-count`);
    if (!badge) return;
    badge.textContent = n ? String(n) : '';
    badge.hidden = !n;
  }

  function rowCount(host) {
    return host ? host.querySelectorAll('.plugins-list-page .plugins-row').length : 0;
  }

  /** The global window's MCPs view (E8): a project picker that opens that project's Settings on its MCPs. */
  function bindGlobalMcps(body, signal, mayLeave) {
    const host = body.querySelector('#sv-plugins-mcps-pick');
    const msg = body.querySelector('#sv-plugins-mcps-msg');
    const ext = window.settingsExternalMcp;
    if (!host || !ext || typeof ext.fillPicker !== 'function') return;
    const picker = document.createElement('select');
    picker.className = 'settings-select';
    picker.setAttribute('aria-label', 'Project whose MCP servers to open');
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'settings-action-btn';
    go.textContent = 'Open its MCP servers';
    host.append(picker, go);
    ext.fillPicker(picker, go, null);
    go.addEventListener('click', async () => {
      if (!picker.value) { msg.textContent = 'Choose a project first.'; return; }
      // The window is replaced: a skill page with unsaved text is asked first, before any warning (it says why itself).
      if (mayLeave && !mayLeave()) return;
      const option = picker.selectedOptions && picker.selectedOptions[0];
      const ok = typeof showControlDialog === 'function' ? await showControlDialog({
        title: 'Open the project\'s settings',
        message: 'This window switches to the project\'s settings. Changes here that you have not saved are lost.',
        confirmLabel: 'Open project settings',
        tone: 'warning',
        details: { Project: option ? option.textContent : picker.value },
      }) : true;
      if (!ok || !window.api || typeof window.api.openSettingsWindow !== 'function') return;
      msg.textContent = '';
      window.api.openSettingsWindow('project', picker.value, { cat: CATS.projectMcps });
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

  /**
   * Wire the group into a rendered settings body. -> { leave() }
   * `restoreCat(cat)` is the panel's own way to switch to a category (used for the E9 hand-off).
   */
  function bind(body, signal, { scope, projectPath, restoreCat }) {
    const ctx = { projectPath: scope === 'project' ? projectPath : null };
    const lazy = (cat, mount) => {
      const sectionEl = body.querySelector(`.settings-cat[data-cat="${cat}"]`);
      const host = sectionEl && sectionEl.querySelector('.sv-plugins-host');
      if (!sectionEl || !host || !window.pluginsViews) return;
      window.pluginsViews.bindLazy(sectionEl, async () => {
        await mount(host, ctx);
        if (signal.aborted) return;
        setCount(body, cat, rowCount(host));
      });
    };
    if (window.pluginsViews) {
      lazy(CATS.plugins, window.pluginsViews.mountPlugins);
      lazy(CATS.apps, window.pluginsViews.mountApps);
      lazy(CATS.skills, window.pluginsViews.mountSkills);
    }

    // Marketplace: the catalog is drawn at once; its badge is the catalog's rows (registry hits are not counted).
    const ext = window.settingsExternalMcp;
    if (ext && scope === 'project') {
      ext.bindAddons(body, signal, {
        projectAdd: (item) => {
          if (restoreCat) restoreCat(CATS.projectMcps);
          ext.openSeeded(body, signal, item.id);
        },
      });
    }
    setCount(body, CATS.marketplace, body.querySelectorAll('.sv-addon-catalog .plugins-row').length);

    const ctl = {
      /**
       * Every mounted view on this body — the lazy ones, the project MCP list, the Marketplace catalog and its registry
       * results — back to its list, without moving focus (the user may be typing into the settings search). A view
       * that refuses (a skill page with unsaved text) stops it: the answer is false, and the screen switches to that
       * view's category so the refusal is seen rather than a button that silently does nothing. Every view is asked
       * before any of them moves, so a refused action leaves the other pages and their filters as they were.
       * `clearFilter`: also drop each view's own filter text, for the settings search, which runs over every row.
       */
      leave(opts) {
        const kit = window.pluginsKit;
        if (!kit || typeof kit.viewsIn !== 'function') return true;
        const views = kit.viewsIn(body);
        const refusing = views.find(v => v.canLeave() === false);
        if (refusing) {
          const sectionEl = refusing.root.closest('.settings-cat');
          if (restoreCat && sectionEl) restoreCat(sectionEl.dataset.cat);
          return false;
        }
        for (const v of views) {
          v.showList({ focus: false });
          if (opts && opts.clearFilter) v.clearFilter();
        }
        return true;
      },
    };

    if (scope !== 'project') {
      const loadProjects = bindGlobalMcps(body, signal, () => ctl.leave());
      const sectionEl = body.querySelector(`.settings-cat[data-cat="${CATS.globalMcps}"]`);
      if (sectionEl && loadProjects && window.pluginsViews) window.pluginsViews.bindLazy(sectionEl, loadProjects);
    }
    return ctl;
  }

  window.settingsPlugins = { CATS, SEED_CATS, navHtml, sectionsHtml, bind };
})();
