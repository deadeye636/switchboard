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

const fs = require('fs');
const path = require('path');

const { _expandSkillTree } = require('../backends/resource-expand');

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

/** One skill row, in the shape the picker renders. */
function skillRow({ name, filePath, origin, scope, backendId, invocation }) {
  return { name, filePath, origin, scope, backendId: backendId || null, invocation: invocation || null };
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
  }));
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
  const seen = new Set();
  const skills = [];
  for (const row of rows) {
    const key = row.filePath.toLowerCase();
    if (seen.has(key)) continue;   // a directory listed under two sources is still one skill
    seen.add(key);
    skills.push(row);
  }
  skills.sort((a, b) => a.name.localeCompare(b.name) || a.origin.localeCompare(b.origin));
  return { skills, skillsDir: switchboardSkillsDir(projectPath) };
}

/** Wire the IPC surface. main.js hands in ipcMain; this file never requires electron. */
function registerIpc(ipcMain) {
  ipcMain.handle('get-skills', (_e, projectPath, backendId) => getSkills({ projectPath, backendId }));
}

module.exports = { init, registerIpc, getSkills, _switchboardSkillsDir: switchboardSkillsDir };
