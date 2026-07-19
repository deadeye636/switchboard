// backends/codex/thread-names.js — the names a user gave their Codex threads (#153).
//
// Codex keeps them OUTSIDE the rollout, in `(CODEX_HOME|~/.codex)/session_index.jsonl`, one JSON object
// per line:
//
//   {"id":"019daeed-…","thread_name":"Rework the permission system","updated_at":"2026-04-21T07:25:57Z"}
//
// So a session's title cannot be read from its own transcript, which is why the parser never had it.
//
// THE INDEX IS NOT A TITLE SOURCE, IT IS AN OVERLAY. Measured on a real install: FOUR entries against
// NINE rollout files, last written three months ago. A `thread_name` exists only for a thread the user
// bothered to name, and Codex does not backfill the others — so a session with no entry is the common
// case, not the exception. The first real user prompt stays the title; this only overrides it where the
// user has actually said what the thread is.
//
// Read once and memoised on the file's mtime: the scan asks for every session it parses, and the answer
// is the same file every time.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Same resolution order as trust.js (#241): the isolated store's parent, then the CLI's own variable, then
// the real home. Read on every Codex session parse, so without it an isolated run reads the user's real
// index on every scan tick.
function indexPath() {
  const store = process.env.SWITCHBOARD_STORE_CODEX;
  const home = store ? path.dirname(store) : (process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  return path.join(home, 'session_index.jsonl');
}

let cache = { key: null, names: new Map() };

/** sessionId -> thread_name, for every named thread. Empty when the file is absent — which is normal. */
function threadNames() {
  const file = indexPath();

  let key;
  try {
    const st = fs.statSync(file);
    key = `${st.mtimeMs}:${st.size}`;
  } catch {
    // No index at all: a fresh install, or a user who has never named a thread.
    cache = { key: null, names: new Map() };
    return cache.names;
  }
  if (key === cache.key) return cache.names;

  const names = new Map();
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return cache.names; }

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    // A half-written last line is a normal thing to meet in an append-only file. Skip it; the next read
    // gets it whole.
    try { entry = JSON.parse(line); } catch { continue; }
    const id = entry && entry.id;
    const name = entry && entry.thread_name;
    if (typeof id === 'string' && id && typeof name === 'string' && name.trim()) {
      names.set(id, name.trim());
    }
  }

  cache = { key, names };
  return names;
}

/** The name the user gave this thread, or null — which is the usual answer. */
function threadName(sessionId) {
  if (!sessionId) return null;
  return threadNames().get(sessionId) || null;
}

/** Tests only: forget the memo so a rewritten fixture is read again within the same mtime granularity. */
function _resetCache() {
  cache = { key: null, names: new Map() };
}

module.exports = { threadName, threadNames, indexPath, _resetCache };
