'use strict';

const fs = require('fs');
const path = require('path');

// Shared with the Plans and Agent Files tabs, which write and delete the same files this module reads.
// Why a thrown error is translated rather than forwarded: `src/app/readable-error.js`.
const { readableError: toReadable } = require('./readable-error');
const { writeTextFile } = require('./safe-write');
const { validateContent } = require('./format-validate');

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
// Case-insensitively on win32, because `C:\Users\x` and `c:\users\X` are one path there and a
// case-sensitive compare would refuse a path the user legitimately typed.
function isInside(parent, child) {
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const lexical = path.relative(path.resolve(parent), path.resolve(child));
  if (!lexical || path.isAbsolute(lexical) || norm(lexical).split(path.sep)[0] === '..') return false;
  let realParent;
  let realChild;
  try {
    realParent = fs.realpathSync(parent);
    realChild = fs.realpathSync(child);
  } catch {
    return false;      // a path we cannot resolve is not a path we hand over
  }
  const real = path.relative(realParent, realChild);
  return !!real && !path.isAbsolute(real) && norm(real).split(path.sep)[0] !== '..';
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
  return { ok: true, content: result.content, mtimeMs: result.mtimeMs };
}

function registerIpc(ipc) {
  ipc.handle('backend-list-resources', (_event, backendId, projectPath) => listResources(backendId, projectPath));
  ipc.handle('backend-open-resource', (_event, backendId, resourcePath, projectPath) => openResource(backendId, resourcePath, projectPath));
  ipc.handle('backend-expand-resource', (_event, backendId, resourcePath, projectPath) => expandResource(backendId, resourcePath, projectPath));
  ipc.handle('backend-read-resource', (_event, backendId, resourcePath, projectPath) => readResource(backendId, resourcePath, projectPath));
  ipc.handle('backend-write-resource', (_event, backendId, resourcePath, content, projectPath, baseline) =>
    writeResource(backendId, resourcePath, content, projectPath, baseline ?? null));
}

module.exports = { init, registerIpc, listResources, openResource, expandResource, readResource, writeResource, _isInside: isInside, _editableHere: editableHere, _readableError: readableError };
