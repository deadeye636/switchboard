// hermes/terminal-identity.js — the identity of ONE tab's terminal, as Hermes reads it for its per-terminal
// breadcrumb (#869, `hermes_cli/terminal_breadcrumbs.py`).
//
// With no tty (Windows, ConPTY) Hermes takes the first set variable of ZELLIJ_PANE_ID, TMUX_PANE, KITTY_WINDOW_ID,
// WEZTERM_PANE, TERM_SESSION_ID, WT_SESSION and writes `<home>/terminal-sessions/<lower-case name>-<sanitized value>`.
// The spawn sets TERM_SESSION_ID from the terminal's tag, which outlives every re-key, and blanks the four ahead of it
// (an empty value counts as unset there), so a Switchboard started from inside one of those multiplexers does not hand
// its pane to every tab. Where a tty exists (Linux, macOS) Hermes names the breadcrumb after the tty and this identity
// is not used: there a tab does not follow `/new` (spec 09).
//
// A `hermes` the agent itself starts from its terminal tool inherits the variable and writes the same breadcrumb.
// The store checks in `reader.followNewSession` (the old row ended as `new_session` or is gone, the new row is
// parentless and started after the old one ended) keep that from moving the tab, short of a narrow race.
'use strict';

const TERMINAL_ENV_AHEAD = ['ZELLIJ_PANE_ID', 'TMUX_PANE', 'KITTY_WINDOW_ID', 'WEZTERM_PANE'];
const terminalValue = (tag) => `switchboard-${String(tag)}`;

// Hermes' `_sanitize`: strip, strip slashes, every character outside [A-Za-z0-9._-] to a dash, 120 characters.
// None where the spawn set no identity (a tty platform), so nothing is looked for there.
function terminalIdFor(tag, platform = process.platform) {
  if (!tag || platform !== 'win32') return null;
  return 'term_session_id-' + terminalValue(tag).trim().replace(/^\/+|\/+$/g, '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120);
}

function terminalEnv(tag, platform = process.platform) {
  if (!tag || platform !== 'win32') return {};
  const env = { TERM_SESSION_ID: terminalValue(tag) };
  for (const name of TERMINAL_ENV_AHEAD) env[name] = '';
  return env;
}

module.exports = { terminalIdFor, terminalEnv, TERMINAL_ENV_AHEAD };
