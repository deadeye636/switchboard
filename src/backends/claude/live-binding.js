// Tying a Claude `/clear` to the terminal it happened in (#223) — Claude's half of a neutral seam.
//
// WHY THIS FILE EXISTS AT ALL. `/clear` mints a new session id and a new transcript while the PTY keeps
// running, and Claude records NO link between the two: measured over a real store, 0 of 177 transcripts
// carry a parent key and every `leafUuid` points at its own file. So the core cannot read the answer
// anywhere; the CLI has to be asked to say it as it happens.
//
// HOW. At spawn we write a settings file for THIS terminal and pass it as `--settings`. It registers one
// hook — `SessionEnd` with `reason: clear` — whose URL carries this terminal's tag. When the user clears,
// Switchboard receives "terminal <tag> just ended session <id>", which is the binding no heuristic could
// produce.
//
// WHAT WAS MEASURED (three PTY runs against the real CLI, v2.1.215), because each of these decided a
// detail here:
//   - `--settings <file>` DOES install hooks, and the file survives repeated clears in one process.
//   - `SessionEnd` fires with `reason: "clear"` carrying the OLD session id. (Reports that it does not
//     fire on /clear are stale for this version.)
//   - `SessionStart` did NOT fire from a `--settings` file in any run — not as `http`, not as `command`,
//     with matcher `clear` or empty. It does fire from a project-level settings.json. So the child id is
//     NOT available this way, and the core pairs the claim with the new transcript instead.
//   - An empty matcher means "every reason"; `clear` scopes to the one we want.
//
// The file is written per spawn, under the app's own userData — never into the user's shared
// ~/.claude/settings.json, which is what #219 is about and what makes this work with no opt-in.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** A tag identifies the TERMINAL, and must outlive every re-key: the session id changes on each clear. */
function newTerminalTag() {
  return crypto.randomUUID();
}

/**
 * The settings blob handed to `claude --settings`.
 *
 * Only the one hook: this file is passed to a CLI the user did not configure for us, so it declares the
 * minimum that answers the question and nothing else. `http` on purpose — a `command` hook's stdout is
 * injected into the session context, and anything printed there would silently prepend text to every
 * cleared session.
 */
function bindingSettings({ url }) {
  return {
    hooks: {
      SessionEnd: [
        { matcher: 'clear', hooks: [{ type: 'http', url, timeout: 3 }] },
      ],
    },
  };
}

/**
 * Write the per-terminal settings file. Returns its path, or null when anything about it fails — a
 * failure here must never stop a session from launching, it only costs the precise binding.
 *
 * `dir` is the caller's (userData), so this module needs no Electron.
 */
function writeBindingSettings({ dir, tag, url, log } = {}) {
  if (!dir || !tag || !url) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `claude-binding-${tag}.json`);
    fs.writeFileSync(file, JSON.stringify(bindingSettings({ url }), null, 2), { encoding: 'utf8', mode: 0o600 });
    return file;
  } catch (err) {
    if (log) log.warn(`[clear-binding] could not write settings for tag=${tag}: ${err.message}`);
    return null;
  }
}

/** Best-effort removal when the terminal is gone. A leftover file is harmless but pointless. */
function removeBindingSettings(file, log) {
  if (!file) return;
  try { fs.unlinkSync(file); } catch (err) {
    if (err && err.code !== 'ENOENT' && log) log.debug(`[clear-binding] could not remove ${file}: ${err.message}`);
  }
}

module.exports = { newTerminalTag, bindingSettings, writeBindingSettings, removeBindingSettings };
