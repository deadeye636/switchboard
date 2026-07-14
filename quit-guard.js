// quit-guard.js — what to ask before the window closes, and what to say.
//
// Closing the main window kills every PTY the app owns: a Claude in the middle of a turn, a build running
// in a terminal, all of it. It used to do that without a word, and an accidental Alt+F4 was enough.
//
// main.js cannot be tested (nothing requires it), so the decision and the wording live here and the window
// handler is left with the two things only it can do: put the question on screen and cancel the close.
'use strict';

/**
 * The live sessions a close would take down.
 * @param {Iterable<[any, {exited?: boolean}]>|Map} activeSessions  main.js's session map
 */
function runningSessions(activeSessions) {
  const out = [];
  for (const [, s] of (activeSessions || [])) {
    if (s && !s.exited) out.push(s);
  }
  return out;
}

/** Ask at all? Not when nothing is running, and not when the user said they do not want to be asked. */
function shouldAskBeforeClose(running, settings) {
  if (!running || running.length === 0) return false;
  // The default is to ask: only an explicit `false` switches it off, so a settings blob that predates the
  // option (everyone's, right now) still gets the warning.
  return (settings || {}).confirmQuitWithRunningSessions !== false;
}

// A CLI session and a plain terminal are both a live process and both die here — but they are not the same
// loss, so they are counted apart wherever they are named.
function describeCounts(agents, terminals) {
  const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return [agents ? count(agents, 'session') : '', terminals ? count(terminals, 'terminal') : '']
    .filter(Boolean).join(' and ');
}

const MAX_ROWS = 6;

/**
 * The question, in the shape the app's own dialog takes (title / message / detail rows) — and, as `detail`,
 * the same thing as plain text for the native box main.js falls back to when the renderer cannot answer.
 */
function closeWarning(running) {
  const list = (running || []).filter(Boolean);
  const agents = list.filter(s => !s.isPlainTerminal).length;
  const terminals = list.length - agents;

  // Where they are running, and how many in each place: a bare list of paths does not say what is at stake.
  const byProject = new Map();
  for (const s of list) {
    const key = s.projectPath || '(unknown)';
    if (!byProject.has(key)) byProject.set(key, { agents: 0, terminals: 0 });
    const c = byProject.get(key);
    if (s.isPlainTerminal) c.terminals++; else c.agents++;
  }

  // The dialog's detail row is a narrow LABEL and a wide VALUE (it ellipsises the value, not the label) —
  // so the count is the label and the path is the value. The other way round, a long path runs straight
  // through the count.
  const entries = [...byProject.entries()];
  const details = entries.slice(0, MAX_ROWS).map(([projectPath, c]) => ({
    label: describeCounts(c.agents, c.terminals),
    value: projectPath,
  }));
  if (entries.length > MAX_ROWS) {
    details.push({ label: '', value: `…and ${entries.length - MAX_ROWS} more` });
  }

  return {
    title: 'Sessions are still running',
    message: `${describeCounts(agents, terminals)} still running. Closing Switchboard stops them — a CLI in `
      + 'the middle of a turn loses what it was doing.',
    details,
    // The native fallback has no detail rows, only a block of text.
    detail: details.map(d => (d.label ? `• ${d.value} — ${d.label}` : `• ${d.value}`)).join('\n')
      + '\n\nSettings → Sessions & CLI turns this warning off.',
  };
}

module.exports = { runningSessions, shouldAskBeforeClose, closeWarning };
