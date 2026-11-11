// What the system clipboard hands a terminal insert (#491).
//
// `{clipboard}` in a saved variable's template resolves through here. The question "what is on the
// clipboard" has three answers and they are not interchangeable — a screenshot has no path, a copied file
// has nothing but one, and text is text. `insertFromDataTransfer` in the renderer already answers it for
// paste and drop (#307), and this is the same ladder on the other side of the IPC, where a DataTransfer
// does not exist and Electron's clipboard is what there is.
//
// The order differs from the renderer's on purpose. There, a bitmap is checked first because a copied image
// FILE carries no bitmap and falls through by itself. Here the file formats are checked first: where both
// are present, a real path on disk beats a snapshot this app wrote — the snapshot is what we fall back to
// when there is nothing to point at.
//
// Nothing here quotes or cleans. The caller knows the shell family and whether the row is a secret, so
// `shellQuotePath` and `sanitizeClipboardText` (both in shared/variable-insert.js) are applied there.
'use strict';

const fs = require('fs');

let ctx = null;

/**
 * @param {object} context
 * @param {Electron.Clipboard} context.clipboard
 * @param {(items: Electron.ClipboardItem[]) => Promise<(string|null)>} context.saveImageFromItems
 *   app/terminal/images.js — writes the PNG of the items already read to the app's image temp dir and
 *   returns its path. Injected rather than required so this module stays loadable in `node --test`.
 * @param {object} context.log
 */
function init(context) {
  ctx = context;
}

// The main-process clipboard of Electron 44+ has no format list and no sync reads: `clipboard.read()` returns
// ClipboardItems, each with `types` and an async `getType(type)`. Measured on Windows 11 with Electron 45.3.0:
//  - a copied FILE is one item with `text/uri-list` (UTF-8 `file:///C:/...`) and the raw OS format
//    `electron application/osclipboard;format="FileName"` (ANSI path). There is NO `FileNameW`.
//  - a screenshot is one item with `image/png`.
// macOS's `public.file-url` would arrive as `electron application/osclipboard;format="public.file-url"`; that
// is NOT measured, only assumed from the naming rule, and is kept as a cheap fallback.
const MAC_FILE_URL = 'electron application/osclipboard;format="public.file-url"';

async function itemText(item, type) {
  const blob = await item.getType(type);
  return blob.text();
}

// Each reader takes the items and returns a path or null; the list is walked in order and the first answer
// wins, so a clipboard carrying two of them is not read twice.
const FILE_READERS = [
  ['text/uri-list', async (items) => {
    for (const item of items) {
      if (!item.types.includes('text/uri-list')) continue;
      // A uri-list is line-separated and may carry comment lines; the first file:// URL is the answer.
      for (const line of (await itemText(item, 'text/uri-list')).split(/\r?\n/)) {
        const p = fileUrlToPath(line.trim());
        if (p) return p;
      }
    }
    return null;
  }],
  [MAC_FILE_URL, async (items) => {
    for (const item of items) {
      if (item.types.includes(MAC_FILE_URL)) return fileUrlToPath(await itemText(item, MAC_FILE_URL));
    }
    return null;
  }],
];

// file:///C:/x → C:\x, file:///home/x → /home/x, file://host/share/x → \\host\share\x. Anything that is
// not a file URL is not a file.
function fileUrlToPath(url) {
  const s = String(url || '').trim();
  const m = /^file:\/\/([^/]*)(\/.*)$/i.exec(s);
  if (!m) return null;
  const host = m[1];
  try {
    let p = decodeURIComponent(m[2]);
    // A Windows drive arrives as `/C:/x`; the leading slash is part of the URL, not of the path.
    if (/^\/[a-z]:/i.test(p)) return p.slice(1).replace(/\//g, '\\') || null;
    // A host that is not this machine names a share, and a share is only reachable as a UNC path.
    if (host && host.toLowerCase() !== 'localhost') return ('\\\\' + host + p).replace(/\//g, '\\');
    return p || null;
  } catch { return null; }
}

// A path only counts when something is actually there. A stale file-url on the clipboard would otherwise
// insert a path to nothing, which reads as a working insert until the command runs.
function existingPath(p) {
  if (!p) return null;
  try { return fs.existsSync(p) ? p : null; } catch { return null; }
}

/**
 * Read the clipboard as something a terminal can be handed.
 *
 * @returns {Promise<{ kind: 'file'|'image'|'text', path?: string, text?: string }>}
 *   `file` — a path already on disk, `image` — a bitmap this call just wrote to disk, `text` — raw text,
 *   uncleaned. An empty clipboard is `{ kind: 'text', text: '' }`, because "nothing was copied" resolves to
 *   nothing rather than to an error: a template may name {clipboard} beside other tokens that do have an
 *   answer.
 */
async function readClipboardInsert() {
  let items = [];
  try { items = (await ctx.clipboard.read()) || []; } catch { items = []; }

  for (const [format, read] of FILE_READERS) {
    let p = null;
    try { p = existingPath(await read(items)); } catch (err) {
      ctx.log.debug(`[clipboard-insert] ${format} unreadable: ${err.message}`);
    }
    if (p) return { kind: 'file', path: p };
  }

  // A bitmap with nothing behind it — a screenshot, "Copy image" in a browser. Written to disk exactly the
  // way a pasted one is, so both routes leave one kind of file in one place.
  try {
    const saved = await ctx.saveImageFromItems(items);
    if (saved) return { kind: 'image', path: saved };
  } catch (err) {
    ctx.log.debug(`[clipboard-insert] image snapshot failed: ${err.message}`);
  }

  let text = '';
  try { text = (await ctx.clipboard.readText()) || ''; } catch { text = ''; }
  return { kind: 'text', text };
}

module.exports = { init, readClipboardInsert, fileUrlToPath };
