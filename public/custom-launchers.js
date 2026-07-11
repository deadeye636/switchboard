// public/custom-launchers.js — Tier-3 custom launchers (T-3.10): the pure data layer.
//
// A launcher is a SAVED, NAMED command the user can start in a project — `npm run dev`, a git
// command, a .bat/.ps1/.sh, a bare exe. It is Tier 3 (00 §2): launch-only. No backend registry
// entry, no session parsing, no badge — the scanner never sees it. It runs in the user's own
// terminal shell (`terminalShellProfile`), exactly as if they had typed it.
//
// Entry shape:
//   { id, name, icon?, command, args?, cwd?, env?, runMode: 'in-app' | 'external' }
//     cwd    — defaults to the launching project (a launch is always in a project).
//     env    — `$VAR` REFERENCES only; resolved at spawn by main's resolveEnv (env-refs.js).
//              A literal secret is never persisted here (same hygiene as backend profiles).
//     runMode— 'in-app'  = a monitored PTY tab (the plain-terminal spawn path)
//              'external'= OS launch-and-forget, unmonitored
//
// Storage is the SETTINGS CASCADE, not a scope enum: the GLOBAL `customLaunchers` list is a
// template for every project; a PROJECT list overrides an entry (matched by `id`) or adds
// project-only ones. Effective list = global ⊕ project, project wins — see mergeCustomLaunchers.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) Object.assign(root, api);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const LAUNCHER_RUN_MODES = ['in-app', 'external'];

  const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

  /**
   * Coerce one stored/edited entry into the canonical shape. Returns null when the entry cannot
   * be a launcher at all (no id, or no command to run) — a half-written entry must never reach the
   * picker, where it would render a row that spawns nothing.
   */
  function normalizeLauncher(entry) {
    if (!isPlainObject(entry)) return null;

    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    // A command line is a single line by definition: a newline would smuggle a second command past
    // the user's review into the PTY / shell (same rule main.js applies to preLaunchCmd).
    const command = typeof entry.command === 'string' ? entry.command.replace(/[\r\n]+/g, ' ').trim() : '';
    if (!id || !command) return null;

    const out = {
      id,
      name: (typeof entry.name === 'string' && entry.name.trim()) ? entry.name.trim() : command,
      command,
      runMode: entry.runMode === 'external' ? 'external' : 'in-app',
    };
    if (typeof entry.icon === 'string' && entry.icon.trim()) out.icon = entry.icon.trim();

    const args = Array.isArray(entry.args)
      ? entry.args.map(a => String(a == null ? '' : a)).filter(a => a !== '')
      : [];
    if (args.length) out.args = args;

    if (typeof entry.cwd === 'string' && entry.cwd.trim()) out.cwd = entry.cwd.trim();

    if (isPlainObject(entry.env)) {
      const env = {};
      for (const [k, v] of Object.entries(entry.env)) {
        const key = String(k).trim();
        if (!key) continue;
        env[key] = String(v == null ? '' : v);
      }
      if (Object.keys(env).length) out.env = env;
    }
    return out;
  }

  /** Normalize a whole stored list, dropping unusable entries and duplicate ids (first wins). */
  function normalizeLauncherList(list) {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(list) ? list : []) {
      const entry = normalizeLauncher(raw);
      if (!entry || seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push(entry);
    }
    return out;
  }

  /**
   * The cascade: effective = global ⊕ project.
   *   - a project entry whose `id` matches a global one REPLACES it, in place (the global list is a
   *     template; the project tunes one row without reordering the menu);
   *   - a project entry with a new `id` is appended (project-only launcher);
   *   - a global entry the project says nothing about is inherited as-is.
   * Same granularity as every other project override — the project value wins for the key it sets.
   */
  function mergeCustomLaunchers(globalList, projectList) {
    const globals = normalizeLauncherList(globalList);
    const projects = normalizeLauncherList(projectList);
    const projectById = new Map(projects.map(p => [p.id, p]));

    const merged = globals.map(g => (projectById.has(g.id) ? projectById.get(g.id) : g));
    const usedIds = new Set(globals.map(g => g.id));
    for (const p of projects) {
      if (!usedIds.has(p.id)) merged.push(p);
    }
    return merged;
  }

  /**
   * Where an effective entry comes from — drives the badge in the project settings panel.
   *   'global'   inherited unchanged
   *   'override' a global entry this project replaced
   *   'project'  a project-only entry
   */
  function launcherOrigin(id, globalList, projectList) {
    const inGlobal = normalizeLauncherList(globalList).some(g => g.id === id);
    const inProject = normalizeLauncherList(projectList).some(p => p.id === id);
    if (inGlobal && inProject) return 'override';
    if (inProject) return 'project';
    return 'global';
  }

  /** A stable, readable id derived from the name (`taken` = ids already in use, both scopes). */
  function launcherId(name, taken) {
    let base = String(name || 'launcher').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!base) base = 'launcher';
    base = base.slice(0, 56);
    let id = base;
    let n = 2;
    const used = taken instanceof Set ? taken : new Set(taken || []);
    while (used.has(id)) id = `${base}-${n++}`;
    return id;
  }

  return {
    LAUNCHER_RUN_MODES,
    normalizeLauncher,
    normalizeLauncherList,
    mergeCustomLaunchers,
    launcherOrigin,
    launcherId,
  };
});
