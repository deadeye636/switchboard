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
const os = require('os');
const path = require('path');

const { _expandSkillTree } = require('../backends/resource-expand');
const { isAtOrInside, samePath, realPathish } = require('./path-containment');
const backendResources = require('./backend-resources');
const { readableError } = require('./readable-error');
const { writeTextFile } = require('./safe-write');
const { worktreeRootOf } = require('../shared/worktree-path');
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
  // Not a directory nobody should walk (#803 T5): a root, the home directory or a network path set as
  // `skillsDir` meant a synchronous walk of everything below it, on the main process, for the picker too.
  if (unsafeToWalk(dir)) return [];
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

/**
 * Why the app's skills directory must not be read, or null when it may be (#803 T5, owner decisions E11, E14).
 *
 * The skill editor saves what this admits, and a `skillsDir` is a setting anyone can point anywhere — and the
 * expander walks it with `rootMarkdown`, so a wide directory is both a write permission over every loose `.md`
 * in it and a synchronous walk of everything below it on the main process. Refused, each on the REAL path
 * (reflex 13; a junction to `C:\` is spelled like an ordinary folder):
 *   - a network path, before anything touches it (a stat of `\\host\share` is a connection to that host);
 *   - a filesystem root;
 *   - the home directory or any directory above it;
 *   - a directory at, inside or above one of a backend's own directories (E14): those files belong to that
 *     CLI, and its own door decides whether they are writable — a backend that declares nothing is read-only.
 */
function unusableSkillsDir(dir, projectPath) {
  const unsafe = unsafeToWalk(dir);
  if (unsafe) return unsafe;
  const real = realPathish(path.resolve(dir));
  for (const root of backendRoots(projectPath)) {
    if (isAtOrInside(real, root) || isAtOrInside(root, real)) return 'a backend\'s own directory';
  }
  return null;
}

/**
 * The half of the refusal that also guards the picker's walk: network path, filesystem root, home and above.
 * The network test is asked of the spelled path AND the real one: a junction or a mapped drive can resolve
 * to a share while being spelled like a local folder.
 */
function unsafeToWalk(dir) {
  const isNetwork = (p) => /^[\\/]{2}/.test(String(p));
  if (isNetwork(dir)) return 'a network path';
  const real = realPathish(path.resolve(dir));
  if (isNetwork(real)) return 'a network path';
  if (path.parse(real).root === real) return 'a drive root';
  if (isAtOrInside(os.homedir(), real)) return 'the home directory or a directory above it';
  return null;
}

/**
 * The directories the backends list as their own, for one scope — what a `skillsDir` must stay clear of.
 *
 * Listed directories, and the folder of a GLOBAL listed file. A project file says nothing about who owns the
 * folder it sits in: Claude and Codex list a project's `CLAUDE.md` / `AGENTS.md`, and taking their parent would
 * make the project root "a backend's" and refuse every project-relative `skillsDir` (`docs/skills`). For the
 * same reason a root that is the project, the home directory or above either is skipped — it is not a CLI's own.
 */
function backendRoots(projectPath) {
  const roots = [];
  for (const b of inventoryBackends()) {
    const d = backendById(b.id);
    if (!d || typeof d.listResources !== 'function') continue;
    let listed = null;
    try { listed = d.listResources({ projectPath: projectPath || null }); } catch { continue; }
    for (const entry of (listed && Array.isArray(listed.resources) ? listed.resources : [])) {
      if (!entry || !entry.path) continue;
      let root = null;
      try {
        if (fs.statSync(entry.path).isDirectory()) root = entry.path;
        // A GLOBAL file (a CLI's own CLAUDE.md, settings.json) does name its home: a fresh install lists no
        // directory at all, and its home must still be the CLI's. A project file names only the project,
        // which the two skips below leave out.
        else if ((entry.scope || 'global') === 'global') root = path.dirname(entry.path);
      } catch { continue; }
      if (!root) continue;
      if (isAtOrInside(os.homedir(), root)) continue;
      if (projectPath && isAtOrInside(projectPath, root)) continue;
      roots.push(root);
    }
  }
  return roots;
}

/**
 * The app's own skill FILES the skill editor may open and save (#803 T5): `{ dir, files, refused }`.
 *
 * Exactly the files the expander named, and of those only the ones whose REAL path is still inside the
 * directory — a skill folder that is a junction to somewhere else is listed by the expander (it follows
 * links) and is left out here, because what is saved through it would land outside the directory the
 * setting names. The answer is a list of files: a caller admits a path by equality, never by directory.
 */
function switchboardSkillFiles(projectPath = null) {
  const dir = switchboardSkillsDir(projectPath);
  const refused = unusableSkillsDir(dir, projectPath);
  if (refused) return { dir, files: [], refused };
  const files = ownSkills(projectPath)
    .filter(r => isAtOrInside(r.filePath, dir))
    .map(r => ({ name: r.name, filePath: r.filePath }));
  return { dir, files, refused: null };
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
  const editable = editableCheck(projectPath);
  const skills = rows.map(r => ({
    id: skillId(r.filePath),
    name: r.name,
    scope: r.scope,
    sourceLabel: r.origin,
    filePath: r.filePath,
    alsoNamed: byName.get(r.name.toLowerCase())
      .filter(o => o !== r)
      .map(o => ({ sourceLabel: o.origin, filePath: o.filePath })),
    editable: editable(r),
  }));
  return { skills, skillsDir: switchboardSkillsDir(projectPath) };
}

// --- The skill editor's door (#803 T5, owner decisions E11, E13, E14) ------------------------------------
//
// A skill is edited on its own detail page in Settings → Plugins, not in the sidebar's Agent Files (E11). The
// window names a skill by its inventory ID, never by a path: the path, the door and the guards are decided
// here on every call. Two doors, and `editable` on an inventory row is the same predicate, so nothing is
// offered an Edit that the save then refuses:
//   - the app's own skill: a file the expander named in a `skillsDir` that `unusableSkillsDir` admits, whose
//     REAL path is still inside that directory (a skill folder linked out of it is listed, never editable),
//     markdown only, written through `safe-write.js`;
//   - a backend's skill: through the backend's own resource reader and writer (`backend-resources.js`), for
//     the first owner whose `resourceEditing` takes the extension AND whose listing reaches the file — the two
//     checks that module's writer makes, asked here the same way so `editable` does not promise a refused save.

const OWN_SKILL_EXTENSIONS = new Set(['.md']);
const MAX_SKILL_BYTES = 1024 * 1024;

/**
 * The door for one listing pass: `door(row)` → `{ kind: 'own', dir } | { kind: 'backend', backendId } | null`.
 * The app's directory is judged once and each backend listed once per pass, not once per row.
 */
function doorCheck(projectPath) {
  let own = null;
  const listings = new Map();
  const listingOf = (d) => {
    if (!listings.has(d.id)) {
      let resources = [];
      try {
        const listed = d.listResources({ projectPath: projectPath || null });
        resources = listed && Array.isArray(listed.resources) ? listed.resources : [];
      } catch { resources = []; }
      listings.set(d.id, resources);
    }
    return listings.get(d.id);
  };
  return (row) => {
    if (row.source === 'switchboard-skills') {
      if (!OWN_SKILL_EXTENSIONS.has(path.extname(row.filePath).toLowerCase())) return null;
      if (!own) {
        const dir = switchboardSkillsDir(projectPath);
        own = { dir, refused: unusableSkillsDir(dir, projectPath) };
      }
      if (own.refused || !isAtOrInside(row.filePath, own.dir)) return null;
      return { kind: 'own', dir: own.dir };
    }
    for (const o of row.owners || []) {
      const d = backendById(o.backendId);
      if (!d || typeof d.listResources !== 'function') continue;
      if (!backendResources._editableHere(d, row.filePath)) continue;
      if (!backendResources._reachable(d, listingOf(d), row.filePath)) continue;
      return { kind: 'backend', backendId: o.backendId };
    }
    return null;
  };
}

/** `editable` on a listing pass: the same door the read and the save use. */
function editableCheck(projectPath) {
  const door = doorCheck(projectPath);
  return (row) => !!door(row);
}

/**
 * A project the request may speak for: none (the global scope) or one the register holds — a worktree
 * through the project it belongs to (reflex 17). The project decides where a relative `skillsDir` resolves,
 * so an arbitrary path from a window would choose the directory the editor writes into.
 */
function projectAllowed(projectPath) {
  if (!projectPath) return true;
  const owner = worktreeRootOf(projectPath) || projectPath;
  try {
    for (const [p, state] of (ctx.projectStates ? ctx.projectStates() : [])) {
      if (state && state.registered && samePath(p, owner)) return true;
    }
  } catch {}
  return false;
}

function doorFor(id, projectPath) {
  if (!projectAllowed(projectPath)) return { error: 'That project is not on the list.' };
  const row = collectSkillInventory({ projectPath }).find(r => skillId(r.filePath) === id);
  if (!row) return { error: 'That skill is no longer listed.' };
  const door = doorCheck(projectPath)(row);
  if (!door) return { error: 'This skill cannot be edited here.' };
  return { row, door };
}

/** The text of one skill for its editor: `{ ok, content }` or `{ ok: false, reason }`. */
async function readSkill({ id, projectPath = null } = {}) {
  const found = doorFor(id, projectPath);
  if (found.error) return { ok: false, reason: found.error };
  const { row, door } = found;
  if (door.kind === 'backend') return backendResources.readResource(door.backendId, row.filePath, projectPath);
  try {
    const stat = fs.statSync(row.filePath);
    if (!stat.isFile()) return { ok: false, reason: 'That is not a file.' };
    if (stat.size > MAX_SKILL_BYTES) return { ok: false, reason: 'Too large to edit here.' };
    return { ok: true, content: fs.readFileSync(row.filePath, 'utf8') };
  } catch (err) {
    return { ok: false, reason: readableError(err, 'Could not read that skill.', ctx.log) };
  }
}

/**
 * Save one skill: `{ ok, content }`, `{ ok: false, conflict: true, diskContent, reason }` when the file moved
 * under the editor (the baseline compare of `safe-write.js`), or `{ ok: false, reason }`.
 *
 * A baseline is required: the editor only ever saves a file it read, and a save without one would overwrite
 * whatever is on disk unchecked. The door is judged on this call, so a skill folder that became a link out of
 * the directory since the page was drawn is refused; a swap in the instant between that check and the write
 * is the race every memory and plan save in this app carries, and it is not narrowed here.
 */
async function saveSkill({ id, projectPath = null, content, baseline = null } = {}) {
  if (typeof content !== 'string') return { ok: false, reason: 'Nothing to save.' };
  if (typeof baseline !== 'string') return { ok: false, reason: 'Open the skill again before saving it.' };
  const found = doorFor(id, projectPath);
  if (found.error) return { ok: false, reason: found.error };
  const { row, door } = found;
  if (door.kind === 'backend') {
    return backendResources.writeResource(door.backendId, row.filePath, content, projectPath, baseline);
  }
  try {
    const result = writeTextFile(row.filePath, content, { expectPrevious: baseline, mustExist: true });
    if (result.ok) return { ok: true, content: result.content };
    if (result.code === 'stale') return { ok: false, conflict: true, diskContent: result.diskContent, reason: result.error };
    if (result.code === 'failed') return { ok: false, reason: readableError(result.cause, 'Could not save that skill.', ctx.log) };
    return { ok: false, reason: result.error || 'Could not save that skill.' };
  } catch (err) {
    return { ok: false, reason: readableError(err, 'Could not save that skill.', ctx.log) };
  }
}

// --- A new skill (#803 T12a, owner decision E15) -----------------------------------------------------------
//
// Where a new skill may go is the backends' answer, the same one the sidebar's "New" used (#441): a directory the
// current listing names as skills, under a source the backend's own `skill` scaffold claims, that exists. The window
// gets an opaque place id and a label, never a backend id or a path to send back; the file is written by
// `backend-resources.createResource`, which checks the directory against the listing again. The app's own skills
// directory is not a place: no scaffold is declared for it, and the sidebar never offered one either.

/** Every place a new skill may be created for this project: `[{ id, label, scope, backendId, dir }]`. */
function collectSkillPlaces(projectPath) {
  const places = [];
  for (const b of inventoryBackends()) {
    const d = backendById(b.id);
    // `expandResource` too: a skill the inventory cannot list could be created but never opened (the sidebar's rule).
    if (!d || typeof d.listResources !== 'function' || typeof d.expandResource !== 'function') continue;
    const scaffold = (Array.isArray(d.resourceScaffolds) ? d.resourceScaffolds : [])
      .find(sc => sc && sc.kind === 'skill' && typeof sc.template === 'function');
    if (!scaffold || !Array.isArray(scaffold.sources)) continue;
    for (const scope of projectPath ? ['project', 'global'] : ['global']) {
      let listed = null;
      try { listed = d.listResources({ projectPath: scope === 'project' ? projectPath : null }); } catch { continue; }
      if (!listed || listed.ok === false || !Array.isArray(listed.resources)) continue;
      for (const entry of listed.resources) {
        if (!entry || entry.kind !== 'skill' || !entry.path) continue;
        if ((entry.scope || 'global') !== scope || !scaffold.sources.includes(entry.source)) continue;
        try { if (!fs.statSync(entry.path).isDirectory()) continue; } catch { continue; }
        // One folder listed in both scopes (a project at the home directory) is offered once, as the project's.
        if (places.some(p => p.backendId === d.id && samePath(p.dir, entry.path))) continue;
        places.push({
          id: crypto.createHash('sha1').update(`${d.id}\0${scope}\0${entry.path}`).digest('hex').slice(0, 16),
          label: `${d.label || d.id} · ${scope} — ${entry.path}`,
          scope, backendId: d.id, dir: entry.path,
        });
      }
    }
  }
  return places;
}

/** The places for the window: `{ ok, places: [{ id, label, scope }] }`. */
function getSkillPlaces({ projectPath = null } = {}) {
  if (!projectAllowed(projectPath)) return { ok: false, reason: 'That project is not on the list.' };
  return { ok: true, places: collectSkillPlaces(projectPath).map(({ id, label, scope }) => ({ id, label, scope })) };
}

/**
 * Create one skill from its backend's scaffold: `{ ok, id }` (the new row's inventory id, so the window opens its
 * page) or `{ ok: false, reason }`. The place is looked up again on this call; the name rule, the listing check,
 * the real-path containment and the no-overwrite write are `createResource`'s.
 */
async function createSkill({ placeId, name, projectPath = null } = {}) {
  if (!projectAllowed(projectPath)) return { ok: false, reason: 'That project is not on the list.' };
  const place = collectSkillPlaces(projectPath).find(p => p.id === placeId);
  if (!place) return { ok: false, reason: 'That folder is no longer offered for a new skill.' };
  const created = await backendResources.createResource(place.backendId, {
    kind: 'skill', name: typeof name === 'string' ? name.trim() : '', parentDir: place.dir,
    projectPath: place.scope === 'project' ? projectPath : null,
  });
  if (!created || !created.ok) return { ok: false, reason: (created && created.reason) || 'The skill could not be created.' };
  // The inventory names a skill by its file or by its folder, whichever the backend's expander reports.
  const row = collectSkillInventory({ projectPath })
    .find(r => samePath(r.filePath, created.path) || samePath(r.filePath, path.dirname(created.path)));
  return { ok: true, id: row ? skillId(row.filePath) : null };
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
  const idOf = (id) => (typeof id === 'string' ? id : '');
  const projectOf = (p) => (typeof p === 'string' && p ? p : null);
  ipcMain.handle('read-skill', (_e, id, projectPath) => readSkill({ id: idOf(id), projectPath: projectOf(projectPath) }));
  ipcMain.handle('save-skill', (_e, id, projectPath, content, baseline) => saveSkill({
    id: idOf(id), projectPath: projectOf(projectPath), content,
    baseline: typeof baseline === 'string' ? baseline : null,
  }));
  ipcMain.handle('get-skill-places', (_e, projectPath) => getSkillPlaces({ projectPath: projectOf(projectPath) }));
  ipcMain.handle('create-skill', (_e, placeId, name, projectPath) => createSkill({
    placeId: idOf(placeId), name: typeof name === 'string' ? name : '', projectPath: projectOf(projectPath),
  }));
}

module.exports = {
  init, registerIpc, getSkills, getSkillInventory, getSkillDetail, switchboardSkillFiles, readSkill, saveSkill,
  getSkillPlaces, createSkill,
  _collectSkillInventory: collectSkillInventory, _switchboardSkillsDir: switchboardSkillsDir,
};
