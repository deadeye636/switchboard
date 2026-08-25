'use strict';

const fs = require('fs');
const path = require('path');

// Shared with the Plans and Agent Files tabs, which write and delete the same files this module reads.
// Why a thrown error is translated rather than forwarded: `src/app/readable-error.js`.
const { readableError: toReadable } = require('./readable-error');
const { writeTextFile } = require('./safe-write');
const { validateContent } = require('./format-validate');
const { isInside: isReallyInside } = require('./path-containment');

let backends = null;
let shell = null;
let log = null;
let invalidateFts = null;

function init(ctx) {
  backends = ctx && ctx.backends;
  shell = ctx && ctx.shell;
  // Optional: the detail dropped from a user-facing reason is written here instead, so an error whose
  // code we cannot translate is still diagnosable from the log rather than nowhere at all.
  log = (ctx && ctx.log) || null;
  // A written resource is a searchable document (#440 put skills in the index), so the tab's search has
  // to be told the same way a saved instruction file tells it.
  invalidateFts = (ctx && typeof ctx.invalidateFts === 'function') ? ctx.invalidateFts : null;
}

const readableError = (err, fallback) => toReadable(err, fallback, log);

async function listResources(backendId, projectPath) {
  const backend = backends && backends.get && backends.get(backendId);
  if (!backend || typeof backend.listResources !== 'function') {
    return { ok: false, reason: 'This backend does not expose resources.' };
  }
  try {
    return await backend.listResources({ projectPath: projectPath || null });
  } catch (err) {
    return { ok: false, reason: readableError(err, 'Could not list backend resources.') };
  }
}

// Is `child` really inside `parent`?
//
// `path.resolve` alone is LEXICAL, and a customization directory is exactly where symlinks live: a link
// inside a skills folder pointing at a private key resolves "underneath the parent" and would pass. So
// the check is done twice — once on the written paths, to catch `..` and a separator swap, and once on
// what the filesystem says they really are.
//
// The second half is `path-containment.js` (#474), which is the app's one answer to that question. What
// stays here is the argument order this file was written with, the lexical pre-check, and the ONE thing
// that differs: a resource has to EXIST to be handed over, so a path that cannot be resolved is refused.
// The shared check answers about the nearest existing ancestor instead, because its callers name files
// that are not there yet.
function isInside(parent, child) {
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const lexical = path.relative(path.resolve(parent), path.resolve(child));
  if (!lexical || path.isAbsolute(lexical) || norm(lexical).split(path.sep)[0] === '..') return false;
  try {
    fs.realpathSync(parent);
    fs.realpathSync(child);
  } catch {
    return false;      // a path we cannot resolve is not a path we hand over
  }
  return isReallyInside(child, parent);
}

/** The listing entry for `resourcePath`, or null. This is the allow-list: nothing else is reachable. */
async function listedResource(backendId, resourcePath, projectPath) {
  const listed = await listResources(backendId, projectPath || null);
  if (!listed || listed.ok === false || !Array.isArray(listed.resources)) return null;
  return listed.resources.find(r => r && r.path === resourcePath) || null;
}

/**
 * Is `resourcePath` reachable at all — either listed itself, or inside a listed directory the backend
 * can actually READ INTO?
 *
 * The second half is the narrow part, and it was wider than it should have been: a listing can name a
 * whole project folder (`.claude`, `.codex`, `.gemini`), and accepting any child of it would let the
 * read path reach files the backend never claimed to understand. So a child is accepted only under a
 * directory whose layout the backend declares a rule for — the same rule `expandResource` uses to
 * enumerate it. Whatever else lives in that folder stays behind the OS Open button, where it was.
 */
function reachable(backend, resources, resourcePath) {
  if (resources.some(r => r && r.path === resourcePath)) return true;
  const knows = backend && typeof backend.expandResource === 'function'
    ? backend.expandResource.knowsSource
    : null;
  return resources.some(r => {
    if (!r || !r.path || !isInside(r.path, resourcePath)) return false;
    // A backend whose walker predates `knowsSource` keeps the old behaviour rather than losing its
    // children entirely — declining is a decision, and an absent function is not one.
    return typeof knows === 'function' ? knows(r.source) : true;
  });
}

async function openResource(backendId, resourcePath, projectPath) {
  if (!resourcePath || !shell || typeof shell.openPath !== 'function') return { ok: false, reason: 'Cannot open resource paths here.' };
  const listed = await listResources(backendId, projectPath || null);
  if (!listed || listed.ok === false || !Array.isArray(listed.resources)) return { ok: false, reason: listed && listed.reason || 'Could not list backend resources.' };
  // A child of a listed directory is openable too (#440) — otherwise expanding a directory would show
  // entries that the OS button then refuses.
  const backend = backends && backends.get && backends.get(backendId);
  if (!reachable(backend, listed.resources, resourcePath)) {
    return { ok: false, reason: 'That path is not a discovered resource for this backend.' };
  }
  // `shell.openPath` answers with the OS's own words, localized and with the path quoted into them.
  // Same problem as an errno and no code to translate, so what is reported is that the system refused.
  const err = await shell.openPath(resourcePath);
  return err ? { ok: false, reason: 'Your system would not open that path.' } : { ok: true };
}

/**
 * One level into a listed directory (#440).
 *
 * The directory must be in the backend's CURRENT listing — re-derived here rather than trusted from the
 * renderer, so a store override that changed since the listing was drawn fails closed rather than
 * reading somewhere else. The entries the backend hands back are checked against that directory before
 * they are returned: a backend is trusted to know its own layout, not to keep a walk inside it.
 */
async function expandResource(backendId, resourcePath, projectPath) {
  const backend = backends && backends.get && backends.get(backendId);
  if (!backend || typeof backend.expandResource !== 'function') {
    return { ok: false, reason: 'This backend cannot list what is inside its directories.' };
  }
  if (!resourcePath) return { ok: false, reason: 'No directory given.' };

  const parent = await listedResource(backendId, resourcePath, projectPath);
  if (!parent) return { ok: false, reason: 'That directory is not a discovered resource for this backend.' };

  let result;
  try {
    result = await backend.expandResource({ path: resourcePath, source: parent.source, scope: parent.scope, projectPath: projectPath || null });
  } catch (err) {
    return { ok: false, reason: readableError(err, 'Could not read that directory.') };
  }
  if (!result || result.ok === false) return result || { ok: false, reason: 'Could not read that directory.' };

  const entries = (Array.isArray(result.entries) ? result.entries : [])
    .filter(e => e && e.path && isInside(resourcePath, e.path));
  return { ok: true, entries, truncated: !!result.truncated };
}

// What a resource file may be, for reading it in the app. The resource kinds are a closed set, so an
// extension allow-list is decidable here in a way "is this text?" is not in general — and a NUL byte
// still settles the case of a `.md` that is really a binary someone renamed.
const READABLE_EXT = new Set([
  '.md', '.markdown', '.txt', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.js', '.mjs', '.cjs', '.ts', '.sh', '.bash', '.ps1', '.py', '.rb', '.xml', '.csv', '.env.example',
]);
const MAX_READ_BYTES = 2 * 1024 * 1024;

/**
 * Read one resource as text (#440).
 *
 * Reachable only through the allow-list: the path is either listed itself, or lies inside a listed
 * directory. The mtime rides along because an editor needs it to notice that the file moved underneath
 * it — #441 refuses a stale write with it, and the viewer uses it to offer the choice rather than
 * silently reloading.
 */
async function readResource(backendId, resourcePath, projectPath) {
  if (!resourcePath) return { ok: false, reason: 'No file given.' };
  const listed = await listResources(backendId, projectPath || null);
  if (!listed || listed.ok === false || !Array.isArray(listed.resources)) {
    return { ok: false, reason: (listed && listed.reason) || 'Could not list backend resources.' };
  }
  if (!reachable(backends && backends.get && backends.get(backendId), listed.resources, resourcePath)) {
    return { ok: false, reason: 'That path is not a discovered resource for this backend.' };
  }

  // What it IS comes before what it is called: asking the extension first answered a directory with
  // "Switchboard does not show this kind of files", which is true of no directory anywhere.
  let stat;
  try { stat = fs.statSync(resourcePath); } catch { return { ok: false, reason: 'That file is no longer there.' }; }
  if (stat.isDirectory()) return { ok: false, reason: 'That is a directory. Open it to see what is inside.' };
  if (!stat.isFile()) return { ok: false, reason: 'That is not a file.' };
  const ext = path.extname(resourcePath).toLowerCase();
  if (!READABLE_EXT.has(ext)) {
    return { ok: false, reason: `Switchboard does not show ${ext || 'this kind of'} files here. Use Open to hand it to your system.` };
  }
  if (stat.size > MAX_READ_BYTES) {
    return { ok: false, reason: `Too large to show here (${Math.round(stat.size / 1024)} KB, limit ${MAX_READ_BYTES / 1024} KB).` };
  }
  let buf;
  try { buf = fs.readFileSync(resourcePath); } catch (err) { return { ok: false, reason: readableError(err, 'Could not read that file.') }; }
  if (buf.includes(0)) return { ok: false, reason: 'That file is not text.' };

  return { ok: true, content: buf.toString('utf8'), mtimeMs: stat.mtimeMs, size: stat.size };
}

/**
 * May this backend's file be written from the app at all (#441)?
 *
 * The answer is the BACKEND's, not this module's: pi keeps skills as markdown but extensions as `.ts`,
 * hermes hooks are arbitrary executables, and a list here naming which is which would be backend
 * knowledge in the one place the rules forbid it. Each descriptor declares the extensions it will let
 * the app edit; a backend that declares nothing is read-only, which is the honest default rather than a
 * guess about what is safe to overwrite.
 *
 * So "nothing executable" holds mechanically: no descriptor lists `.sh`, `.ps1`, `.ts` or `.js`, and if
 * one ever did it would be that backend saying so in its own file.
 */
function editableHere(backend, resourcePath) {
  const declared = backend && backend.resourceEditing;
  const exts = declared && Array.isArray(declared.extensions) ? declared.extensions : null;
  if (!exts || exts.length === 0) return false;
  return exts.includes(path.extname(String(resourcePath || '')).toLowerCase());
}

/**
 * Write one resource (#441).
 *
 * Every guard is re-derived here, per call, and none of it is trusted from the renderer: the listing
 * (so a store override that changed since the list was drawn fails closed), the containment check, the
 * backend's own editable-extension declaration, and the format check. Only then do the bytes go through
 * the shared write core, which refuses a file that no longer holds what the editor last saw.
 *
 * `baseline` is that text. A caller with none passes null and gets an unconditional write — which is
 * what a create is, and nothing else should be.
 */
async function writeResource(backendId, resourcePath, content, projectPath, baseline = null) {
  if (!resourcePath) return { ok: false, reason: 'No file given.' };
  if (typeof content !== 'string') return { ok: false, reason: 'Nothing to write.' };

  const backend = backends && backends.get && backends.get(backendId);
  const listed = await listResources(backendId, projectPath || null);
  if (!listed || listed.ok === false || !Array.isArray(listed.resources)) {
    return { ok: false, reason: (listed && listed.reason) || 'Could not list backend resources.' };
  }
  if (!reachable(backend, listed.resources, resourcePath)) {
    return { ok: false, reason: 'That path is not a discovered resource for this backend.' };
  }
  if (!editableHere(backend, resourcePath)) {
    return { ok: false, reason: 'Switchboard does not edit this kind of file for this backend.' };
  }

  const result = writeTextFile(resourcePath, content, {
    expectPrevious: baseline,
    mustExist: true,
    validate: (text) => validateContent(resourcePath, text),
  });
  if (!result.ok) {
    if (result.code === 'stale') {
      // Not an error: the caller raises the same conflict view an external change raises, and it needs
      // the file's current text to do it.
      return { ok: false, conflict: true, diskContent: result.diskContent, reason: result.error, error: result.error };
    }
    if (result.code === 'failed') {
      const reason = readableError(result.cause, 'That file could not be saved.');
      return { ok: false, reason, error: reason };
    }
    return { ok: false, reason: result.error, error: result.error };
  }
  if (invalidateFts) { try { invalidateFts('memory'); } catch { /* the index heals on its next scan */ } }
  // Whether the format could be checked at all travels with the answer: a backend may declare an
  // extension this app has no parser for, and "saved without a check" is a different promise from
  // "checked and fine". The panel says which one happened.
  const checked = validateContent(resourcePath, content);
  return { ok: true, content: result.content, mtimeMs: result.mtimeMs, unchecked: !!checked.unchecked };
}

/**
 * A name someone may give a new resource.
 *
 * Deliberately narrow: this becomes a directory or a file name that a CLI then looks up, and the two
 * things that must not get through are a separator (which would place the file somewhere else) and a
 * leading dot (which would hide it from the very listing that has to find it again).
 */
function validResourceName(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name) && !name.includes('..');
}

/** The scaffold this backend declares for `kind`, or null. */
function scaffoldFor(backend, kind) {
  const declared = backend && Array.isArray(backend.resourceScaffolds) ? backend.resourceScaffolds : [];
  return declared.find(s => s && s.kind === kind && typeof s.template === 'function') || null;
}

/**
 * Create one resource from its backend's scaffold (#441).
 *
 * The target directory must be one the CURRENT listing names, under a source the scaffold itself claims
 * — so "where a skill goes" is the backend's answer twice over: which directories hold skills, and which
 * of them this kind may be created in. The file is written with `wx`, so an existing one is never
 * clobbered by a create; overwriting is what the write path is for, with its baseline.
 */
async function createResource(backendId, { kind, name, parentDir, projectPath = null } = {}) {
  const backend = backends && backends.get && backends.get(backendId);
  const scaffold = scaffoldFor(backend, kind);
  if (!scaffold) return { ok: false, reason: 'This backend does not create that kind of file.' };
  if (!validResourceName(name)) {
    return { ok: false, reason: 'Use letters, numbers, dashes, dots or underscores — no slashes.' };
  }
  if (!parentDir) return { ok: false, reason: 'No directory given.' };

  const parent = await listedResource(backendId, parentDir, projectPath);
  if (!parent) return { ok: false, reason: 'That directory is not a discovered resource for this backend.' };
  const sources = Array.isArray(scaffold.sources) ? scaffold.sources : [];
  if (!sources.includes(parent.source)) {
    return { ok: false, reason: `A ${kind} does not belong in that directory.` };
  }

  // The REAL directory, not the one that was named: everything else in this file checks containment
  // against what the filesystem says a path is, and a create that only checked the spelling would be
  // the one guard here that a link could walk past.
  let realParent;
  try { realParent = fs.realpathSync(parentDir); } catch { return { ok: false, reason: 'That directory is no longer there.' }; }

  const target = scaffold.layout === 'dir'
    ? path.join(realParent, name, scaffold.entryFile || 'SKILL.md')
    : path.join(realParent, name + (scaffold.ext || '.md'));
  // Belt and braces over the name check: whatever the name did, the result has to be inside the
  // directory that was approved. The holder is what is about to be created, which is exactly the case the
  // shared check answers about its nearest existing ancestor — so it is asked here rather than repeated.
  const holder = scaffold.layout === 'dir' ? path.join(realParent, name) : target;
  if (!isReallyInside(holder, realParent)) {
    return { ok: false, reason: 'That name would put the file outside the directory.' };
  }

  let body;
  try { body = String(scaffold.template(name) ?? ''); }
  catch { return { ok: false, reason: 'That template could not be built.' }; }

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if (err && err.code === 'EEXIST') return { ok: false, reason: 'There is already one with that name.' };
    return { ok: false, reason: readableError(err, 'That file could not be created.') };
  }
  if (invalidateFts) { try { invalidateFts('memory'); } catch { /* the index heals on its next scan */ } }
  return { ok: true, path: target };
}

// What may be DELETED, which is narrower than what may be written (#441).
//
// The containment check answers "is this under a directory whose layout the backend declares", and that
// is right for reading and writing — but it also admits a settings file, a helper file inside a skill
// folder, and anything else that happens to sit there. Deletion needs the stricter question: is this
// path one the EXPANSION itself names, and is its kind one of the four with a lifecycle. A settings file
// is a listed FILE, never an expansion entry, so it is unreachable here by construction rather than by a
// deny-list somebody has to remember to extend.
const DELETABLE_KINDS = new Set(['skill', 'rule', 'command', 'agent', 'prompt-template']);

/** Is a row of this kind something the app deletes? Asked by the tab, so it offers only what main acts on. */
function isDeletableKind(kind) {
  return DELETABLE_KINDS.has(kind);
}

/**
 * Delete one resource.
 *
 * A skill is a DIRECTORY holding `SKILL.md`, so what goes is the folder — and the three guards on that
 * are: it is strictly inside the listed directory (never the listed directory itself), it really holds
 * the entry file the listing named, and its realpath is still inside after following links. A skill
 * folder that is itself a symlink fails the third and is refused, which is the fail-closed answer.
 */
async function deleteResource(backendId, resourcePath, projectPath = null) {
  if (!resourcePath) return { ok: false, reason: 'No file given.' };
  const backend = backends && backends.get && backends.get(backendId);
  const listed = await listResources(backendId, projectPath || null);
  if (!listed || listed.ok === false || !Array.isArray(listed.resources)) {
    return { ok: false, reason: (listed && listed.reason) || 'Could not list backend resources.' };
  }

  // The listed directory this path claims to live in, and the entry that names it. Both come from the
  // backend, re-derived now — a renderer that remembers an old listing cannot widen this.
  for (const parent of listed.resources) {
    if (!parent || !parent.path || !isInside(parent.path, resourcePath)) continue;
    let expanded = null;
    try {
      expanded = await backend.expandResource({ path: parent.path, source: parent.source, scope: parent.scope, projectPath: projectPath || null });
    } catch { expanded = null; }
    if (!expanded || expanded.ok === false || !Array.isArray(expanded.entries)) continue;
    const entry = expanded.entries.find(e => e && e.path === resourcePath);
    if (!entry) continue;
    if (!DELETABLE_KINDS.has(entry.kind)) {
      return { ok: false, reason: 'Switchboard does not delete that kind of file.' };
    }

    // A skill is its folder; everything else is the file itself.
    const target = path.basename(resourcePath).toLowerCase() === 'skill.md'
      ? path.dirname(resourcePath)
      : resourcePath;
    if (target !== resourcePath) {
      if (!isInside(parent.path, target)) return { ok: false, reason: 'That folder is not inside the directory it was listed in.' };
      let holdsEntry = false;
      try { holdsEntry = fs.statSync(path.join(target, path.basename(resourcePath))).isFile(); } catch { holdsEntry = false; }
      if (!holdsEntry) return { ok: false, reason: 'That folder no longer holds the file it was listed for.' };
    }

    try {
      if (target === resourcePath) fs.unlinkSync(target);
      else fs.rmSync(target, { recursive: true, force: false });
    } catch (err) {
      return { ok: false, reason: readableError(err, 'That could not be deleted.') };
    }
    if (invalidateFts) { try { invalidateFts('memory'); } catch { /* the index heals on its next scan */ } }
    return { ok: true, deleted: target };
  }
  return { ok: false, reason: 'That path is not something this backend lists as deletable.' };
}

function registerIpc(ipc) {
  ipc.handle('backend-list-resources', (_event, backendId, projectPath) => listResources(backendId, projectPath));
  ipc.handle('backend-open-resource', (_event, backendId, resourcePath, projectPath) => openResource(backendId, resourcePath, projectPath));
  ipc.handle('backend-expand-resource', (_event, backendId, resourcePath, projectPath) => expandResource(backendId, resourcePath, projectPath));
  ipc.handle('backend-read-resource', (_event, backendId, resourcePath, projectPath) => readResource(backendId, resourcePath, projectPath));
  ipc.handle('backend-write-resource', (_event, backendId, resourcePath, content, projectPath, baseline) =>
    writeResource(backendId, resourcePath, content, projectPath, baseline ?? null));
  ipc.handle('backend-create-resource', (_event, backendId, options) => createResource(backendId, options || {}));
  ipc.handle('backend-delete-resource', (_event, backendId, resourcePath, projectPath) => deleteResource(backendId, resourcePath, projectPath ?? null));
}

module.exports = { init, registerIpc, listResources, openResource, expandResource, readResource, writeResource, createResource, deleteResource, isDeletableKind, _isInside: isInside, _editableHere: editableHere, _validResourceName: validResourceName, _readableError: readableError };
