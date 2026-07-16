// fs.watch on Claude's projects directory.
//
// Claude-shaped on purpose: it watches PROJECTS_DIR and speaks in folders + per-file refreshes. Every
// other backend has its own store and its own shape — that is `stores.js`.
//
// The watcher owns the debounce, and the debounce is where the bodies are: a busy multi-agent session
// appends to its transcript continuously, and a plain trailing debounce would keep resetting its timer
// and never flush at all.
'use strict';

const fs = require('fs');
const path = require('path');

let ctx = null;
let projectsWatcher = null;

/**
 * @param {object} context
 * @param {string} context.projectsDir
 * @param {() => boolean} context.getAppQuitting  a GETTER: it flips during quit, and a captured false
 *   would let a late flush touch the DB after closeDb() — "The database connection is not open" (#90).
 * @param {object} context.indexWorker  postFile / postReconcile
 * @param {(folder: string) => void} context.detectSessionTransitions
 * @param {object} context.log
 */
function init(context) {
  ctx = context;
}

function startProjectsWatcher() {
  if (!fs.existsSync(ctx.projectsDir)) return;

  const pendingFolders = new Set();      // top-level folder add/remove → full refresh
  const pendingFiles = new Map();         // folder → Set<relFilename> → per-file refresh (#1)
  let debounceTimer = null;
  let burstStartedAt = 0;
  // Trailing debounce for calm periods, capped by a max-wait so a *continuous*
  // storm of JSONL appends (busy multi-agent session) can't keep resetting the
  // timer forever and starve the flush. Guarantees a flush at least every
  // MAX_WAIT_MS while events keep coming.
  const DEBOUNCE_MS = 500;
  const MAX_WAIT_MS = 2500;

  function flushChanges() {
    debounceTimer = null;
    if (ctx.getAppQuitting()) return; // DB may already be closed (#90)
    const folders = new Set(pendingFolders);
    pendingFolders.clear();
    const files = new Map(pendingFiles);
    pendingFiles.clear();

    // Per-file refreshes (perf #1): update just the changed transcript(s) instead of re-scanning the
    // whole folder on every append. The projects-changed push rides on each worker reply's apply
    // (afterReconcile / the file-lane rename notify), so main does not fire it here — it would
    // double-paint before the apply.
    // NOTE on the vanished-folder branches below: the worker walks the folder and reports the vanish, and
    // the reply-apply does a Claude-SCOPED delete — a project folder key is shared across backends (same
    // cwd -> same project), so an unscoped wipe would also delete the Codex rows for that project.
    for (const [folder, relSet] of files) {
      if (folders.has(folder)) continue; // a full folder refresh below covers it
      const folderPath = path.join(ctx.projectsDir, folder);
      if (!fs.existsSync(folderPath)) {
        // Vanished folder: a reconcile routes the scoped delete (the worker walks it and reports the vanish).
        ctx.indexWorker.postReconcile();
        continue;
      }
      ctx.detectSessionTransitions(folder);
      // Each changed transcript is parsed off-thread (postFile does the DB pre-work on main).
      for (const rel of relSet) ctx.indexWorker.postFile(folder, rel);
    }

    // Folder-level events (top-level add/remove) → full folder refresh. A reconcile covers both the
    // present-folder refresh and the scoped delete-when-gone.
    for (const folder of folders) {
      const folderPath = path.join(ctx.projectsDir, folder);
      if (fs.existsSync(folderPath)) ctx.detectSessionTransitions(folder);
      ctx.indexWorker.postReconcile();
    }
  }

  try {
    projectsWatcher = fs.watch(ctx.projectsDir, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;

      // filename is relative, e.g. "folder-name/sessions-index.json" or "folder-name/abc.jsonl"
      const parts = filename.split(path.sep);
      const folder = parts[0];
      if (!folder || folder === '.git') return;

      // Only care about .jsonl changes or top-level folder add/remove
      const basename = parts[parts.length - 1];
      if (parts.length === 1) {
        pendingFolders.add(folder); // folder created/removed → full refresh
      } else if (basename.endsWith('.jsonl')) {
        // Per-file: record the specific changed transcript (relative path incl. folder).
        if (!pendingFiles.has(folder)) pendingFiles.set(folder, new Set());
        pendingFiles.get(folder).add(filename);
      } else {
        return;
      }

      const now = Date.now();
      if (!debounceTimer) burstStartedAt = now; // first event of a new burst
      const waited = now - burstStartedAt;
      const delay = Math.min(DEBOUNCE_MS, Math.max(0, MAX_WAIT_MS - waited));
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flushChanges, delay);
    });

    projectsWatcher.on('error', (err) => {
      console.error('Projects watcher error:', err);
    });
  } catch (err) {
    console.error('Failed to start projects watcher:', err);
  }
}

/** Called on quit. */
function stopProjectsWatcher() {
  if (projectsWatcher) {
    projectsWatcher.close();
    projectsWatcher = null;
  }
}

module.exports = { init, startProjectsWatcher, stopProjectsWatcher };
