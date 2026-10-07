/**
 * documents.js — opening a document an agent read, without the renderer naming a path to an open-anything
 * IPC (#755).
 *
 * A backend stamps a neutral `document` element (`src/backends/document-ref.js`) into the tool result of a
 * `Read` that names a file. The core sees that element go by in `src/app/agent-rpc.js` and keeps its path in
 * a registry that belongs to the SESSION (it lives on the session's state, so a re-key keeps it and the end
 * of the session drops it). `openDocument` then accepts a path only if THIS session's backend reported it,
 * and checks the file again at the moment of the click:
 *
 *   - absolute and local — a `\\host\share` or `//host/share` path AS SPELLED is refused before any stat,
 *     because a stat of one reaches out to that host (and hands it a Windows login). A local link that
 *     resolves to a share is refused after resolving it, which touches the link's target once — the
 *     agent's own Read had reached it already;
 *   - no NTFS alternate data stream (`file.exe:x.pdf`);
 *   - the REAL path (links and junctions resolved) is checked as well, for the same network test, for the
 *     extension and for a sensitive path — a link named `a.pdf` that points at a key file, an executable or
 *     a share is not a document;
 *   - a regular file, with an extension that has a document kind (`shell.openPath` runs an executable, so a
 *     registered `.exe` or `.lnk` is refused all the same);
 *   - not a sensitive path (`isSensitivePath` lives in main.js and arrives through ctx).
 *
 * There is NO project containment root: an agent legitimately reads documents from a downloads folder.
 * The registry is what stands in for it.
 *
 * `how` says what the click means: 'default' opens the file in the system's default program, 'tab' says the
 * renderer may open its own file view, 'click' follows the user's `fileClickTarget` setting with the same
 * Ctrl/Cmd inversion a terminal file link has. With `external`, a PDF, an image or an HTML file goes to the
 * default program and Markdown to the configured editor — `externalEditorCommand` means a code editor, and
 * a PDF belongs in a viewer. The answer names the action taken or left to the renderer
 * (`default` | `tab` | `editor`), and carries the path for the two the renderer finishes.
 *
 * `document-read` (#764) answers the TEXT of a Markdown or HTML document for the card's viewer, through the
 * same checks (`checkDocument`), only when the card is clicked, and only up to `READ_MAX_BYTES`.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { isDocumentElement, kindOfPath } = require('../backends/document-ref');
const { realPathish } = require('./path-containment');
const { readableError } = require('./readable-error');

let ctx = null;

// A session that reads thousands of distinct documents must not grow the registry without bound; the oldest
// paths are dropped first (a Set keeps insertion order).
const REGISTRY_CAP = 500;

const HOWS = ['default', 'tab', 'click'];

// What the viewer reads as text (#764), and how much of it: a document past this is opened in a tab instead,
// whose editor is built for large files.
const TEXT_KINDS = ['markdown', 'html'];
const READ_MAX_BYTES = 2 * 1024 * 1024;

/**
 * @param {object} context
 * @param {{ openPath: (p: string) => Promise<string> }} context.shell  Electron's `shell`, through ctx
 * @param {(p: string) => boolean} context.isSensitivePath  main.js's check, through ctx (it stays there)
 * @param {(sessionId: string) => ({ has: (p: string) => boolean }|null)} context.registryFor
 *   the registry of a running session, or null
 * @param {() => object} [context.getGlobalSettings]
 * @param {object} [context.log]
 */
function init(context) {
  ctx = context;
}

/**
 * The paths of the document elements one entry carries. The element rides inside the tool result's content
 * array (`message.content[i].content[j]`), the one place the renderer's pairing keeps; a shallow walk of
 * exactly those arrays, so a large entry costs nothing.
 */
function documentPathsOf(entry) {
  const out = [];
  const blocks = entry && entry.message && Array.isArray(entry.message.content) ? entry.message.content : [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (isDocumentElement(block)) out.push(block.path);
    for (const inner of [block.content, block.output]) {
      if (!Array.isArray(inner)) continue;
      for (const el of inner) if (isDocumentElement(el)) out.push(el.path);
    }
  }
  return out;
}

/** A per-session set of document paths the core saw come out of that session's backend. */
function createRegistry() {
  const paths = new Set();
  return {
    note(entry) {
      for (const p of documentPathsOf(entry)) {
        paths.delete(p);
        paths.add(p);
        if (paths.size > REGISTRY_CAP) paths.delete(paths.values().next().value);
      }
    },
    noteAll(entries) {
      if (Array.isArray(entries)) for (const e of entries) this.note(e);
    },
    has: (p) => typeof p === 'string' && paths.has(p),
    clear: () => paths.clear(),
    get size() { return paths.size; },
  };
}

// A network path, in either spelling and on every host: `\\host\share`, `//host/share`, `\\?\UNC\…`.
const NETWORK_PATH = /^[\\/]{2}/;
// A `:` after the drive prefix names an NTFS alternate data stream (`evil.exe:x.pdf` reads as a PDF to every
// extension check, and is a stream of an executable). No document has one in its path.
const hasStream = (p) => p.replace(/^[A-Za-z]:/, '').includes(':');

const refuse = (error) => ({ ok: false, error });

/**
 * Every check above, for one path a renderer named. Answers the real path, the kind and the file's size, or
 * the refusal. Shared by the open and the read, so the two cannot accept different paths. `kind` is the spelled
 * path's, `realKind` the resolved one's — a link named `a.md` may lead to a picture.
 * @returns {Promise<{ok: true, real: string, kind: string, realKind: string, size: number}|{ok: false, error: string}>}
 */
async function checkDocument(sessionId, filePath) {
  const registry = ctx.registryFor ? ctx.registryFor(sessionId) : null;
  if (!registry) return refuse('This session is not running.');
  if (!registry.has(filePath)) return refuse('This session did not read that document.');

  // Everything below is judged on the path as it is spelled AND on what it resolves to. The lexical half
  // comes first and touches no disk.
  if (NETWORK_PATH.test(filePath) || !path.isAbsolute(filePath)) return refuse('Only local files can be opened.');
  if (hasStream(filePath)) return refuse('That kind of file is not opened from here.');
  const kind = kindOfPath(filePath);
  if (!kind) return refuse('That kind of file is not opened from here.');
  if (ctx.isSensitivePath(filePath)) return refuse('Access to that path is denied.');

  const real = realPathish(filePath);
  if (NETWORK_PATH.test(real)) return refuse('Only local files can be opened.');
  const realKind = kindOfPath(real);
  if (hasStream(real) || !realKind) return refuse('That kind of file is not opened from here.');
  if (ctx.isSensitivePath(real)) return refuse('Access to that path is denied.');

  let stat;
  try {
    stat = await fs.promises.stat(real);
  } catch (err) {
    return refuse(readableError(err, 'The document could not be opened.', ctx.log));
  }
  if (!stat.isFile()) return refuse('That is not a file.');
  return { ok: true, real, kind, realKind, size: stat.size };
}

/**
 * @param {string} sessionId
 * @param {string} filePath  the path the element carried, exactly as stamped
 * @param {'default'|'tab'|'click'} how
 * @param {boolean} [invert]  Ctrl/Cmd held — only read for 'click'
 * @returns {Promise<{ok: true, action: 'default'|'tab'|'editor', path?: string}|{ok: false, error: string}>}
 */
async function openDocument(sessionId, filePath, how, invert) {
  if (!ctx) return refuse('Documents are not available yet.');
  if (typeof sessionId !== 'string' || !sessionId || typeof filePath !== 'string' || !filePath) {
    return refuse('No document was named.');
  }
  if (!HOWS.includes(how)) return refuse('That is not a way to open a document.');

  const checked = await checkDocument(sessionId, filePath);
  if (!checked.ok) return checked;
  const { real, kind } = checked;

  let action = how;
  if (how === 'click') {
    const settings = (ctx.getGlobalSettings && ctx.getGlobalSettings()) || {};
    const external = (settings.fileClickTarget === 'external') !== !!invert;
    if (!external) action = 'tab';
    else action = kind === 'markdown' ? 'editor' : 'default';
  }

  if (action === 'tab' || action === 'editor') return { ok: true, action, path: filePath };

  // `shell.openPath` answers an error STRING, empty on success; a thrown error is worded the same way.
  try {
    const failure = await ctx.shell.openPath(real);
    if (failure) {
      if (ctx.log && typeof ctx.log.debug === 'function') ctx.log.debug(`[documents] openPath: ${failure}`);
      return refuse('The system could not open that document.');
    }
  } catch (err) {
    return refuse(readableError(err, 'The system could not open that document.', ctx.log));
  }
  return { ok: true, action: 'default' };
}

/**
 * The text of a Markdown or HTML document, for the card's viewer (#764). Read only when the user clicks the
 * card, through the same checks as the open. Other kinds are refused: their pages are already in the result.
 * @returns {Promise<{ok: true, kind: 'markdown'|'html', text: string}|{ok: false, error: string}>}
 */
async function readDocument(sessionId, filePath) {
  if (!ctx) return refuse('Documents are not available yet.');
  if (typeof sessionId !== 'string' || !sessionId || typeof filePath !== 'string' || !filePath) {
    return refuse('No document was named.');
  }
  const checked = await checkDocument(sessionId, filePath);
  if (!checked.ok) return checked;
  // Text on both sides of a link, and the same text: a link `a.md` to `b.png` is not Markdown.
  if (!TEXT_KINDS.includes(checked.kind) || checked.realKind !== checked.kind) return refuse('That kind of file is not shown here.');
  const tooLarge = refuse('This document is too large to show here. Open it in a tab instead.');
  if (checked.size > READ_MAX_BYTES) return tooLarge;
  // Bounded by the read itself, not only by the stat before it: an agent may still be writing the file.
  let handle = null;
  try {
    handle = await fs.promises.open(checked.real, 'r');
    // Sized by the stat, plus one byte that catches a file grown since; never past the bound plus one.
    const buf = Buffer.alloc(Math.min(checked.size, READ_MAX_BYTES) + 1);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    if (bytesRead > READ_MAX_BYTES) return tooLarge;
    return { ok: true, kind: checked.kind, text: buf.toString('utf8', 0, bytesRead) };
  } catch (err) {
    return refuse(readableError(err, 'The document could not be read.', ctx.log));
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/** @param {Electron.IpcMain} ipc */
function registerIpc(ipc) {
  ipc.handle('document-open', (_event, sessionId, filePath, how, invert) => openDocument(sessionId, filePath, how, invert));
  ipc.handle('document-read', (_event, sessionId, filePath) => readDocument(sessionId, filePath));
}

module.exports = { init, registerIpc, createRegistry, openDocument, readDocument, documentPathsOf, READ_MAX_BYTES };
