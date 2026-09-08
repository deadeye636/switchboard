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

/**
 * Ask at all? Not when nothing is running, and not when the user said they do not want to be asked.
 *
 * IT ASKS ABOUT THE SESSIONS THE QUIT STOPS, and a session that will keep running is deliberately not
 * one of them (#608) — decided by the owner, not assumed. The dialog exists to prevent a LOSS, and a
 * session nothing is about to stop has none to prevent; opening one for it would be an interruption
 * with nothing at stake, on an app that otherwise closes silently. The cost is stated rather than
 * hidden: the case that produced #606-#608 — quit with nothing of ours running, an agent outliving the
 * app, a resume conflict the next day — stays silent here. It is answered at the other end instead, by
 * the conflict dialog naming the process and offering to stop it.
 */
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
 * The sessions that will still be running AFTER the app is gone (#608).
 *
 * The list above is what closing STOPS. This is its opposite, and the dialog had no idea it existed: a CLI
 * that put itself under a daemon of its own is not one of our PTY children, so the teardown cannot reach
 * it — measured, one was still holding its session the next day, which is what produced the resume
 * conflict on the next launch.
 *
 * Fed from `app/live-owners.js`, which has already dropped everything `activeSessions` holds. So every
 * entry it publishes is by definition NOT ours, and there is nothing further to filter — the one thing
 * this must not do is name a session the quit is about to kill, and that is settled upstream.
 *
 * A cold or missing list answers an empty array. Saying nothing is right there: the alternative is
 * telling somebody a session survived when the truth is that nobody asked.
 */
function survivingSessions(liveOwners) {
  return (liveOwners || []).filter(o => o && o.sessionId);
}

/**
 * The question, in the shape the app's own dialog takes (title / message / detail rows) — and, as `detail`,
 * the same thing as plain text for the native box main.js falls back to when the renderer cannot answer.
 *
 * `surviving` is the second group (#608) and it is worded apart from the first for one reason: the
 * sentence "Closing Switchboard stops them" is FALSE about it. Rolling the two together would have been
 * the smaller diff and would have made the dialog lie about exactly the sessions it had just learned to
 * see.
 */
function closeWarning(running, surviving = []) {
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

  // The second group. Named rather than counted per project: these are sessions somebody else's process is
  // running, and their own name is what the user can go and find them by — the path would say where they
  // started, which is the less useful half here.
  const outlive = survivingSessions(surviving);
  const survivingRows = outlive.slice(0, MAX_ROWS).map(o => ({
    label: 'keeps running',
    value: o.name || o.sessionId,
  }));
  if (outlive.length > MAX_ROWS) {
    survivingRows.push({ label: '', value: `…and ${outlive.length - MAX_ROWS} more` });
  }
  const allRows = [...details, ...survivingRows];

  const survivingNote = outlive.length
    ? ` ${describeCounts(outlive.length, 0)} will KEEP running afterwards — Switchboard did not start `
      + 'the process holding them and cannot stop it.'
    : '';

  return {
    title: 'Sessions are still running',
    message: `${describeCounts(agents, terminals)} still running. Closing Switchboard stops them — a CLI in `
      + `the middle of a turn loses what it was doing.${survivingNote}`,
    // The button says what the click does, and with a surviving session on the list "stop them" is the
    // same false claim the message above stopped making. The wording lives here rather than in the
    // renderer for the reason the rest of it does: this is the half that can be tested.
    confirmLabel: outlive.length ? 'Close anyway' : 'Close and stop them',
    details: allRows,
    // The native fallback has no detail rows, only a block of text.
    detail: allRows.map(d => (d.label ? `• ${d.value} — ${d.label}` : `• ${d.value}`)).join('\n')
      + '\n\nSettings → Sessions turns this warning off.',
  };
}

module.exports = { runningSessions, survivingSessions, shouldAskBeforeClose, closeWarning };
