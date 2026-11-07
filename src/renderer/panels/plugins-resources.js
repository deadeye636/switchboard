// plugins-resources.js — the Agents, Commands and Rules views of the Plugins manager (#823 T3, spec 40, spec 44).
//
// Three pages over one builder. Each is the Skills page with another door: the list, the detail page, the editor with
// its conflict handling, "New" and "Delete" are `pluginsViews.mountItemView` (panels/plugins-views.js, loaded before
// this file); this file only says which door and which sentences.
//
//   - Rows come from main's neutral inventory (`getResourceInventory(view, projectPath)`): `{ id, name, kind, scope,
//     sourceLabel, originLabel, cli, clis, editable, deletable, fromPlugin, creatable }` and `declines`, a sentence
//     per CLI that keeps nothing of this kind here. A file named by several CLIs sits under each CLI's chip.
//   - Read, save, delete and New go through the id-based doors (`readResourceItem`, `saveResourceItem`,
//     `deleteResourceItem`, `getResourcePlaces` / `createResourceItem`); the window sees no path. Edit is offered where
//     the row is `editable`, Delete where it is `deletable` (never a plugin's item, never a hook), New where main
//     offers a place for one.
//   - Read on the category's first `settings-cat-shown` (the caller binds it with `pluginsViews.bindLazy`), never at bind.
//
// It names no backend and no backend format: every label and sentence is served by main. Every string goes in with
// textContent. Loaded in settings.html only; `window.pluginsResources`.
(function () {
  'use strict';

  const api = () => window.api || {};

  // Per view: the noun the page speaks in and the sentences that differ. The ids are the view names main knows.
  const VIEWS = {
    agents: { noun: 'agent', nounTitle: 'Agent', plural: 'agents', label: 'Agents' },
    commands: { noun: 'command', nounTitle: 'Command', plural: 'commands', label: 'Commands' },
    rules: { noun: 'rule', nounTitle: 'Rule', plural: 'rules', label: 'Rules' },
  };

  /** -> mount(host, ctx) for one view of `agents`, `commands` or `rules`. */
  function mountResourceView(view) {
    const v = VIEWS[view];
    if (!v) throw new Error('Unknown resource view');
    return function mount(host, ctx) {
      const views = window.pluginsViews;
      const pp = ctx.projectPath || null;
      return views.mountItemView(host, ctx, {
        io: {
          noun: v.noun,
          nounTitle: v.nounTitle,
          // Only the extension main sends, so the editor picks the syntax.
          fileHint: (r) => `item${r && r.ext ? r.ext : '.md'}`,
          read: (id) => api().readResourceItem(id, pp, view),
          save: (id, text, baseline) => api().saveResourceItem(id, pp, text, baseline, view),
          places: () => api().getResourcePlaces(view, pp),
          create: (place, name) => api().createResourceItem(view, place, name, pp),
          del: (id) => api().deleteResourceItem(id, pp, view),
          noPlaces: `No CLI here has a folder to put a new ${v.noun} in.`,
          deleteMessage: `The ${v.noun} file is deleted from disk. This cannot be undone.`,
        },
        reading: `Reading the ${v.plural}…`,
        readError: `The ${v.plural} could not be read.`,
        filterPlaceholder: `Filter ${v.plural}`,
        filterKey: `resources-${view}`,
        contentView: view,
        emptyText: `No ${v.plural} found for any CLI here.`,
        read: async () => {
          let res = null;
          try { res = await api().getResourceInventory(view, pp); } catch { res = null; }
          if (!res || res.ok === false || !Array.isArray(res.rows)) return null;
          return { rows: res.rows, declines: Array.isArray(res.declines) ? res.declines : [] };
        },
        probeCreate: async () => {
          let res = null;
          try { res = await api().getResourcePlaces(view, pp); } catch { res = null; }
          return !!(res && res.ok && Array.isArray(res.places) && res.places.length);
        },
        sections: (list) => [
          { title: 'This project', rows: list.filter(r => r.scope === 'project') },
          { title: 'Global', rows: list.filter(r => r.scope !== 'project') },
        ],
        renderFacts: (r, c) => {
          c.appendChild(views.line('Source', r.sourceLabel));
          if (r.originLabel && r.originLabel !== r.sourceLabel) c.appendChild(views.line('From', r.originLabel));
          if (r.kind) c.appendChild(views.line('Kind', r.kind));
        },
        readOnlyText: (r) => (r.fromPlugin
          ? `This ${v.noun} came with a plugin. Change or remove it there.`
          : `This ${v.noun} is read-only here: Switchboard does not edit this kind of file, or the CLI it belongs to does not allow it.`),
        deleteDetails: (r) => ({ Source: r.sourceLabel }),
      });
    };
  }

  window.pluginsResources = { VIEWS, mountResourceView };
})();
