// app/skills.js — what a running session can be asked to run: its backend's skills, plus the app's own
// (#462).
//
// Two sources, and they are not the same kind of thing.
//
// A BACKEND SKILL belongs to the CLI in the terminal. Every backend that has skills already reports the
// directory holding them (`listResources`) and reads one level into it (`expandResource` in `skillTree`
// mode, which descends until a folder holds SKILL.md and reports that folder as one skill). So this file
// asks the descriptor rather than knowing where anything lives — the same seam the Plans and Agent Files
// tabs use. Both scopes are asked for: the CLI's own home and the project's.
//
// A SWITCHBOARD SKILL belongs to nobody's CLI. It is a document in a directory the user picks, offered in
// every session whatever is running there, and it is always handed over as text — there is no CLI to ask
// for an invocation. Same SKILL.md shape as the CLIs use, read with the same expander, so a document can
// be moved either way without being rewritten.
//
// WHAT THE PICKER INSERTS is decided HERE, in main, not in the renderer: `invocation` is the string to
// type when the backend can run a skill from its prompt, and null when it cannot. The renderer never
// learns which backend it is talking to — the rule the whole `src/renderer/**` layer is held to.
//
// The invocation itself comes off the descriptor (`skillInvocation`), because how a CLI is asked to run
// a skill is that CLI's business: a slash command for one, something else for the next, and nothing at
// all for a CLI whose skills are a launch flag. A backend that declares no hook gets the text fallback,
// which is the honest answer rather than a guessed prefix.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { _expandSkillTree } = require('../backends/resource-expand');
const { isAtOrInside } = require('./path-containment');
const resourceSources = require('./resource-sources');
const skillDelivery = require('./skill-delivery');

let ctx = null;

function init(context) {
  ctx = context;
}

/** The backends a session can actually be running. Same filter the other resource readers use. */
function backendById(backendId) {
  if (!backendId) return null;
  try { return ctx.backends.get(backendId) || null; } catch { return null; }
}

/**
 * Where the app's own skills live.
 *
 * Unset means the app's own directory beside the database, which is the case that needs no decision from
 * anyone. A value set in the cascade is a path: absolute as given, relative resolved against the project
 * when there is one, and against the data directory otherwise — so a project may keep its skills in the
 * repository (`docs/skills`) without every other project inheriting a path that means nothing there.
 */
function switchboardSkillsDir(projectPath) {
  let configured = '';
  try {
    const settings = ctx.effectiveSettings ? ctx.effectiveSettings(projectPath || null) : null;
    configured = (settings && typeof settings.skillsDir === 'string') ? settings.skillsDir.trim() : '';
  } catch { configured = ''; }
  if (!configured) return path.join(ctx.dataDir, 'skills');
  if (path.isAbsolute(configured)) return path.resolve(configured);
  return path.resolve(projectPath || ctx.dataDir, configured);
}

/**
 * One skill row, in the shape the picker renders — plus `source`, the listing's own word for where the
 * skill came from. That one stays in main: the picker never had it, and what it means is the backend's
 * (spec 40, F2 — the delivery answer of #803 matches on it).
 */
function skillRow({ name, filePath, origin, scope, backendId, invocation, source }) {
  return {
    name, filePath, origin, scope, backendId: backendId || null, invocation: invocation || null,
    source: source || null,
  };
}

/** The picker's row: everything but `source`. */
function pickerRow({ source: _source, ...row }) {
  return row;
}

/**
 * The skills a backend reports, for one scope.
 *
 * `listResources` answers with directories; only the ones it marks as skills are read, and only through
 * the backend's own expander — a directory this file walked itself would be this file deciding what a
 * skill looks like for a CLI it knows nothing about.
 */
function backendSkills(descriptor, projectPath, scope) {
  if (!descriptor || typeof descriptor.listResources !== 'function'
      || typeof descriptor.expandResource !== 'function') return [];
  let listed = null;
  try { listed = descriptor.listResources({ projectPath: scope === 'project' ? projectPath : null }); }
  catch { return []; }
  if (!listed || listed.ok === false || !Array.isArray(listed.resources)) return [];

  const out = [];
  for (const entry of listed.resources) {
    if (!entry || entry.kind !== 'skill') continue;
    if ((entry.scope || 'global') !== scope) continue;
    let expanded = null;
    try {
      expanded = descriptor.expandResource({
        path: entry.path, source: entry.source, scope: entry.scope, projectPath: projectPath || null,
      });
    } catch { expanded = null; }
    if (!expanded || expanded.ok === false || !Array.isArray(expanded.entries)) continue;

    for (const child of expanded.entries) {
      if (!child || !child.path || !child.name) continue;
      let invocation = null;
      if (typeof descriptor.skillInvocation === 'function') {
        try {
          const answer = descriptor.skillInvocation({
            name: child.name, filePath: child.path, scope, source: child.source || entry.source || null,
          });
          invocation = (typeof answer === 'string' && answer.trim()) ? answer.trim() : null;
        } catch { invocation = null; }
      }
      out.push(skillRow({
        name: child.name,
        filePath: child.path,
        // A listing entry may say what it should be CALLED when its path does not say it — a plugin's
        // skills are cached in a folder named after the marketplace, so "Claude Code · global" would be
        // true and useless (#463). The core does not know what makes a label special, only to prefer one.
        origin: entry.originLabel
          ? `${descriptor.label || descriptor.id} · ${entry.originLabel}`
          : `${descriptor.label || descriptor.id} · ${scope}`,
        scope,
        backendId: descriptor.id,
        invocation,
        source: child.source || entry.source || null,
      }));
    }
  }
  return out;
}

/** The app's own skills. Always text, so no descriptor is consulted and none could answer. */
function ownSkills(projectPath) {
  const dir = switchboardSkillsDir(projectPath);
  try { if (!fs.statSync(dir).isDirectory()) return []; } catch { return []; }
  const entries = [];
  // `rootMarkdown`, so a one-file skill sitting directly in the directory counts. Somebody writing their
  // first skill should not have to learn a folder convention before it shows up.
  _expandSkillTree(dir, { kind: 'skill', source: 'switchboard-skills', scope: 'global', rootMarkdown: true }, entries);
  return entries.map(e => skillRow({
    name: e.name, filePath: e.path, origin: 'Switchboard', scope: 'global', backendId: null, invocation: null,
    source: 'switchboard-skills',
  }));
}

/** Rows with one key per file, the first listing kept: a directory listed under two sources is one skill. */
function dedupeByPath(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = row.filePath.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function byNameThenOrigin(a, b) {
  return a.name.localeCompare(b.name) || a.origin.localeCompare(b.origin);
}

/**
 * Everything one terminal may be offered, sorted by skill name.
 *
 * By NAME and not by source: the name is what the user is looking for, and a list ordered by where a
 * skill happens to live makes them read three groups to find out whether it exists at all. Where the
 * same name exists twice, both rows stay and each says where it came from — dropping one would hide the
 * fact that two answers exist, which is the thing worth knowing.
 */
function getSkills({ projectPath = null, backendId = null } = {}) {
  const descriptor = backendById(backendId);
  const rows = [
    ...backendSkills(descriptor, projectPath, 'global'),
    ...(projectPath ? backendSkills(descriptor, projectPath, 'project') : []),
    ...ownSkills(projectPath),
  ];
  const skills = dedupeByPath(rows).sort(byNameThenOrigin).map(pickerRow);
  return { skills, skillsDir: switchboardSkillsDir(projectPath) };
}

/**
 * The backends the inventory asks: ready, not a profile, one per CLI. The Agent Files rule
 * (`memoryBackends` in plans-memory.js), so the two lists cannot name a CLI differently.
 */
function inventoryBackends() {
  try {
    if (!ctx.backends || typeof ctx.backends.list !== 'function') return [];
    const ready = (ctx.backends.list() || []).filter(b => b && !b.isProfile && b.status === 'ready');
    return typeof ctx.backends.oneAskerPerCli === 'function' ? ctx.backends.oneAskerPerCli(ready) : ready;
  } catch { return []; }
}

/** A stable id for one skill file, decided here so the renderer never builds one from a path. */
function skillId(filePath) {
  return crypto.createHash('sha1').update(filePath.toLowerCase()).digest('hex').slice(0, 16);
}

/**
 * Every skill on this machine for one project, across backends — one row per FILE (spec 40, E4), with
 * the owner kept beside it for the delivery answer that follows (#803 T3). Not for the renderer: that
 * one gets `getSkillInventory`.
 *
 * A Switchboard skill's scope is answered here rather than taken from `ownSkills`, which says `global`
 * for the picker whatever the directory: a `skillsDir` that resolves inside the project is the
 * project's (premise 2 of spec 40), decided on real paths.
 *
 * One file can be reported by more than one backend (a CLI whose settings point at another CLI's skills
 * directory). The first listing still names the row, but `owners` keeps every backend that reported the
 * file with its listing source — "is this the target's own skill" must not depend on registry order.
 */
function collectSkillInventory({ projectPath = null } = {}) {
  const rows = [];
  for (const b of inventoryBackends()) {
    const descriptor = backendById(b.id);
    rows.push(...backendSkills(descriptor, projectPath, 'global'));
    if (projectPath) rows.push(...backendSkills(descriptor, projectPath, 'project'));
  }
  const ownDir = switchboardSkillsDir(projectPath);
  const ownScope = projectPath && isAtOrInside(ownDir, projectPath) ? 'project' : 'global';
  rows.push(...ownSkills(projectPath).map(r => ({ ...r, scope: ownScope })));

  const byKey = new Map();
  for (const row of rows) {
    const key = row.filePath.toLowerCase();
    const owner = row.backendId ? { backendId: row.backendId, source: row.source } : null;
    const kept = byKey.get(key);
    if (!kept) {
      byKey.set(key, { ...row, owners: owner ? [owner] : [] });
    } else if (owner && !kept.owners.some(o => o.backendId === owner.backendId)) {
      kept.owners.push(owner);
    }
  }
  return [...byKey.values()].sort(byNameThenOrigin);
}

/**
 * The neutral skill inventory the Plugins manager lists (#803, spec 40 D4): one row per skill file, its
 * source label and scope, and every OTHER file of the same name (`alsoNamed`, one entry per file — two
 * files under one label are two places, not one). No backend id, no invocation and no listing source
 * leave this function — what a backend makes of a skill is answered per target in main, never derived
 * in the renderer.
 */
function getSkillInventory({ projectPath = null } = {}) {
  const rows = collectSkillInventory({ projectPath });
  const byName = new Map();
  for (const r of rows) {
    const key = r.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(r);
  }
  const skills = rows.map(r => ({
    id: skillId(r.filePath),
    name: r.name,
    scope: r.scope,
    sourceLabel: r.origin,
    filePath: r.filePath,
    alsoNamed: byName.get(r.name.toLowerCase())
      .filter(o => o !== r)
      .map(o => ({ sourceLabel: o.origin, filePath: o.filePath })),
  }));
  return { skills, skillsDir: switchboardSkillsDir(projectPath) };
}

/** The CLI a descriptor belongs to — a driver of a CLI counts as that CLI. The registry's rule. */
function cliOwnerIdOf(b) {
  try {
    if (typeof ctx.backends.cliOwnerOf === 'function') return (ctx.backends.cliOwnerOf(b) || b).id;
  } catch { /* fall through to the descriptor's own word */ }
  return b.transcriptsOf || b.id;
}

/**
 * One skill's detail page (#803 T3, spec 40 F2): the inventory row and, per launchable backend, what
 * that backend makes of the skill in this project — `{ targetLabel, state, sentence, invocation }`,
 * decided by `skill-delivery.js` from the target's effective options and `resource-sources.resolve`.
 *
 * Every ready, non-profile backend is a target, a driver included: a native GUI backend launches with
 * options of its own, so its answer can differ from its CLI's. `projectPath` is in the answer because
 * "effective" is per project; on the global page it is null and only global options count.
 */
async function getSkillDetail({ id, projectPath = null } = {}) {
  const row = collectSkillInventory({ projectPath }).find(r => skillId(r.filePath) === id);
  if (!row) return { ok: false, reason: 'That skill is no longer listed.' };
  let defaults = {};
  try {
    const settings = ctx.effectiveSettings ? ctx.effectiveSettings(projectPath || null) : null;
    defaults = (settings && settings.backendDefaults) || {};
  } catch { defaults = {}; }
  const labelOf = (backendId) => { const d = backendById(backendId); return d ? (d.label || d.id) : null; };
  // Ready AND switched on: a backend the user turned off launches nothing, so what it would make of the
  // skill answers no question anybody has. `status` is 'ready' for every installed built-in either way.
  const ready = (() => {
    try { return (ctx.backends.list() || []).filter(b => b && !b.isProfile && b.status === 'ready' && b.enabled !== false); }
    catch { return []; }
  })();
  // One `resolve` per target, not shared between targets on one source: the answer depends on the TARGET
  // (its trust question, what it declines), so a cache keyed without it would hand one target another's.
  const targets = [];
  for (const b of ready) {
    const target = backendById(b.id);
    if (!target) continue;
    const answer = await skillDelivery.deliveryFor({
      row, target, ownerOf: cliOwnerIdOf, labelOf, projectPath,
      options: defaults[target.id] || {},
      resolve: resourceSources.resolve,
    });
    targets.push({ targetLabel: target.label || target.id, ...answer });
  }
  return {
    ok: true, id, name: row.name, scope: row.scope, sourceLabel: row.origin, filePath: row.filePath,
    projectPath: projectPath || null, targets,
  };
}

/** Wire the IPC surface. main.js hands in ipcMain; this file never requires electron. */
function registerIpc(ipcMain) {
  ipcMain.handle('get-skills', (_e, projectPath, backendId) => getSkills({ projectPath, backendId }));
  ipcMain.handle('get-skill-inventory', (_e, projectPath) => getSkillInventory({ projectPath }));
  ipcMain.handle('get-skill-detail', (_e, id, projectPath) => getSkillDetail({
    id: typeof id === 'string' ? id : '', projectPath: typeof projectPath === 'string' && projectPath ? projectPath : null,
  }));
}

module.exports = {
  init, registerIpc, getSkills, getSkillInventory, getSkillDetail,
  _collectSkillInventory: collectSkillInventory, _switchboardSkillsDir: switchboardSkillsDir,
};
