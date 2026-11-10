// session/shell-line-status.js — what the conversation view says about a `!` shell line that runs (#836).
//
// Pure functions, no DOM, so a test can pin them: the elapsed text, a line's ending, the session line's
// wording, the Background list's rows (the runtime's tasks and the view's own running lines merged FOR DISPLAY
// ONLY — `view.tasks` is never written), and the one decision the view's 1 s timer makes. Read by
// `conversation-view.js`; it reads nothing from the page.

// "m:ss", or "h:mm:ss" from an hour on. The one formatting of elapsed time in the view (#691).
function formatElapsedMs(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

// How a finished line is worded in its head. The exit code is what the app's own runner reports; a runtime's
// line (Pi) reports a status only, so the words fall back to it. `bad` is a non-zero ending.
function shellLineEnding(status, exitCode) {
  if (status === 'cancelled') return { text: 'stopped', bad: true };
  if (Number.isInteger(exitCode)) return { text: `exit ${exitCode}`, bad: exitCode !== 0 };
  if (status === 'error') return { text: 'failed', bad: true };
  return { text: 'exit 0', bad: false };
}

// The session line's wording while lines run: "1 shell line running", "2 shell lines running".
function shellLinesRunningText(n) {
  return `${n} shell line${n === 1 ? '' : 's'} running`;
}

// The last `n` non-empty lines of a running line's output, for the strip.
function shellLineTail(output, n) {
  return String(output || '').split('\n').map(l => l.replace(/\s+$/, '')).filter(Boolean).slice(-n).join('\n');
}

const SHELL_ROW_COMMAND_MAX = 80;

// The Background list's rows: the runtime's tasks as they are, plus one `shell` row per running line.
// `lines` is the view's `localCommands` (id -> { command, startedAt }). A new array; `tasks` is untouched.
function mergeBackgroundRows(tasks, lines) {
  const rows = (tasks || []).map(t => ({ ...t, shellLineId: null }));
  for (const [id, line] of (lines || [])) {
    const cmd = String(line.command || '').replace(/\s+/g, ' ').trim();
    rows.push({
      id: `shell-line:${id}`,
      kind: 'shell',
      shellLineId: String(id),
      description: cmd.length > SHELL_ROW_COMMAND_MAX ? `${cmd.slice(0, SHELL_ROW_COMMAND_MAX - 1)}…` : cmd,
      detail: 'shell line',
      startedAt: line.startedAt || 0,
    });
  }
  return rows;
}

// Whether the view's 1 s timer should be armed: something counts up, the view is on screen and attached,
// and the session has not ended.
function elapsedTimerNeeded({ counting, shown, connected, exited }) {
  return counting > 0 && !!shown && !!connected && !exited;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { formatElapsedMs, shellLineEnding, shellLinesRunningText, shellLineTail, mergeBackgroundRows, elapsedTimerNeeded };
}
