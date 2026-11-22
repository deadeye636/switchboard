'use strict';
// task-runner.js — one agent hands a WRITING task to another backend (#804, spec 41).
//
// The TASK policy over the shared child runner (`child-runner.js`). What is the task's own:
//   - It works in a git worktree of its own (`task-worktree.js`, E5 and E6): created before the spawn, kept when the task
//     ends (E8), removed only if the start is refused. Nothing is merged back; the caller is told the branch. A folder
//     that is not a repository refuses the task.
//   - Trust is inherited (O16): a target that declares `trustBeforeStart` is started only when it already trusts the
//     caller's project, and the app then grants the worktree that trust; `task-worktree.js` takes it back on removal.
//   - Its asks are the user's (E3, E18-E23): each one is drawn as a card on the task's session and raises attention; the
//     caller polls `needs-input` while one is open; an ask nobody answers within ASK_BOUND_MS is refused and the task
//     ends `failed`. The approval memory never answers one and no answer is remembered (`answersFromMemory: false`).
//     The bound applies to every kind of ask: a tool approval, a question, a plan approval.
//   - Its own caps (E12, E22): 30 minutes, three running in the app.
//   - A task that ends `failed` or `stopped` still reports the text it wrote and its branch: it may have changed files.
//
// Electron-free and db-free, and it names no backend. Beside the child runner's `ctx` it takes `checkouts` (the worktree service: `create`,
// `remove`), `projectTrust(backendId)` -> `{ get, set } | null` and `trustRequired(backendId)` -> boolean.

const { createChildRunner, MAX_TEXT, MAX_PROMPT, POLL_AFTER_SECONDS } = require('./child-runner');

const MAX_MS = 30 * 60 * 1000;          // E22: from the moment a start is accepted
const ASK_BOUND_MS = 10 * 60 * 1000;    // E19: per open ask
const APP_CAP = 3;                      // running tasks over all callers (E12)

const SENTENCES = {
  unknownId: 'There is no task with that id for this session.',
  noTarget: 'That backend is not available for a task. Ask tools/list for the ones that are.',
  emptyPrompt: 'The prompt is empty.',
  longPrompt: `The prompt is longer than ${MAX_PROMPT} characters.`,
  callerIsChild: 'A session another session started cannot start a task.',
  quitting: 'The app is quitting.',
  appCap: `${APP_CAP} tasks are already running in Switchboard. Wait for one of them to finish.`,
  noWindow: 'No Switchboard window is open, so no task can start.',
  untrusted: 'The target backend does not trust this project yet. Trust it for that backend in Switchboard first.',
  noWorktree: 'The task\'s worktree could not be created.',
  trustNotGranted: 'The task\'s worktree could not be trusted for the target backend.',
  notStarted: 'The task session could not start.',
  notSent: 'The task session started but did not take the prompt.',
  noReply: 'The task turn ended without a reply.',
  timeout: 'The task took longer than 30 minutes and was stopped.',
  askUnanswered: 'The task asked the user for an answer and none came within 10 minutes, so the question was refused and the task stopped.',
  sessionStopped: 'The task session was stopped.',
  callerEnded: 'The calling session ended.',
  appQuitting: 'The app is quitting.',
  running: `Still working; do not call again for ${POLL_AFTER_SECONDS} seconds.`,
  needsInput: `The task is waiting for the user to answer a question in Switchboard; do not call again for ${POLL_AFTER_SECONDS} seconds.`,
  stopReason: 'Stopped: the task ended.',
};

// Tasks running anywhere in the app, for the cap. Only ids; each runner keeps its own records.
const runningEverywhere = new Set();

function preambleFor(rec) {
  const branch = rec.worktree && rec.worktree.branch ? ` on the branch ${rec.worktree.branch}` : '';
  return `You are doing a task for another agent. You work in a git worktree of your own${branch}; nothing you change `
    + 'there reaches the project until that agent merges it. Commit your changes on that branch before you finish, and '
    + 'end with a short summary of what you changed. The summary is cut at about 32 KB.\n\n';
}

// Resolves once the session's process has exited, or after EXIT_WAIT_MS. Real timers on purpose, unref'd: this waits on a
// process, not on the runner's own clock.
const EXIT_WAIT_MS = 10 * 1000;
const EXIT_POLL_MS = 200;
function exited(session) {
  return new Promise((resolve) => {
    const until = Date.now() + EXIT_WAIT_MS;
    const look = () => {
      if (!session || session.exited || Date.now() >= until) { resolve(); return; }
      const t = setTimeout(look, EXIT_POLL_MS);
      if (t && typeof t.unref === 'function') t.unref();
    };
    look();
  });
}

function worktreeFacts(rec) {
  return rec.worktree
    ? { branch: rec.worktree.branch, worktreePath: rec.worktree.worktreePath, baseCommit: rec.worktree.baseCommit }
    : {};
}

function createPolicy(ctx) {
  const trustOf = (backendId) => {
    try { return typeof ctx.projectTrust === 'function' ? ctx.projectTrust(backendId) : null; } catch { return null; }
  };
  const trustRequired = (backendId) => {
    try { return typeof ctx.trustRequired === 'function' && ctx.trustRequired(backendId) === true; } catch { return true; }
  };

  // An ask nobody answered in time is refused, and the task ends: a refused ask does not end the turn by itself.
  function onBound(rec, requestId, api) {
    if (!rec.openAsks.has(requestId)) return;
    rec.openAsks.delete(requestId);
    if (rec.state !== 'running') return;
    if (api.quitting()) { api.finish(rec, 'stopped', SENTENCES.appQuitting); return; }
    const answered = api.answerAsk(rec, requestId, { cancelled: true });
    // Not open any more: the user (or the runtime) got to it first, and the task goes on.
    if (answered && answered.notOpen === true) return;
    // Refused, or the refusal could not be written (the question is gone from the open set either way): the task ends.
    if (answered && answered.ok === true) rec.refusedActions += 1;
    api.finish(rec, 'failed', SENTENCES.askUnanswered);
  }

  return {
    name: 'task',
    maxMs: MAX_MS,
    appCap: APP_CAP,
    running: runningEverywhere,
    linkKind: 'task',
    sentences: {
      ...SENTENCES,
      alreadyRunning: (id) => `A task is already running for this session: ${id}. Poll it with taskResult.`,
      timeoutAfter: (s) => `The task took longer than ${s} second${s === 1 ? '' : 's'} and was stopped.`,
    },
    preamble: preambleFor,
    // `spawnKind: 'task'` keeps the session audible (its asks raise attention) and marks the row for what it is.
    launchOptions: () => ({ spawnKind: 'task', reviewTools: false }),

    async prepare(rec, { target, projectPath }) {
      rec.openAsks = new Map();
      const needsTrust = trustRequired(target.id);
      const trust = trustOf(target.id);
      if (needsTrust) {
        let trusted = null;
        try { trusted = trust && typeof trust.get === 'function' ? trust.get(projectPath) : null; } catch { trusted = null; }
        if (trusted !== true) return { ok: false, error: SENTENCES.untrusted };
      }
      // The worktree is named by the task (E25): the first eight characters of its id, which the sidebar shows as the
      // worktree's name and git as `switchboard/task-<that>`. Taken already (the same eight characters, by chance): the
      // whole id, which cannot be.
      let made = null;
      try {
        made = await ctx.checkouts.create({ projectPath, taskId: rec.id.slice(0, 8) });
        if (made && made.ok !== true && made.reason === 'exists') made = await ctx.checkouts.create({ projectPath, taskId: rec.id });
      } catch { made = null; }
      if (!made || made.ok !== true) return { ok: false, error: (made && made.message) || SENTENCES.noWorktree };
      rec.worktree = { worktreePath: made.worktreePath, repoPath: made.repoPath, branch: made.branch, baseCommit: made.baseCommit };
      if (needsTrust) {
        // Asked first: a CLI may already answer yes for the checkout (it keys a worktree by its repository root, or a
        // folder above it is trusted). Then nothing is written, and nothing of the caller's is changed.
        let already = null;
        try { already = trust && typeof trust.get === 'function' ? trust.get(made.worktreePath) : null; } catch { already = null; }
        if (already !== true) {
          let granted = false;
          try {
            const answer = trust && typeof trust.set === 'function' ? trust.set(made.worktreePath, true) : null;
            granted = !!(answer && answer.ok === true);
          } catch { granted = false; }
          if (!granted) return { ok: false, error: SENTENCES.trustNotGranted };
        }
      }
      return { ok: true, cwd: made.worktreePath };
    },

    // A refused start leaves nothing behind: the worktree it made is removed, which also takes back the trust. A
    // session that did start is stopped by then but may still have the folder as its working directory, and git cannot
    // remove a folder a running process holds on Windows: the removal waits for the exit, a bounded while.
    async discard(rec) {
      if (!rec.worktree) return;
      const path = rec.worktree.worktreePath;
      rec.worktree = null;
      if (rec.session) await exited(rec.session);
      let gone = null;
      try { gone = await ctx.checkouts.remove({ worktreePath: path }); } catch { gone = null; }
      if (!gone || gone.ok !== true) {
        const log = ctx.log || { warn() {} };
        log.warn(`[task] the worktree of a refused start was not removed (${(gone && gone.reason) || 'no answer'}): ${path}`);
      }
    },

    observer: (rec, api) => ({
      answersFromMemory: false,
      onAsk(request) {
        // Drawn as a card on the task's session and raised as attention (the core does both for a null answer).
        if (request && request.id != null && rec.state === 'running' && !rec.openAsks.has(String(request.id))) {
          const id = String(request.id);
          rec.openAsks.set(id, api.setTimer(() => onBound(rec, id, api), ASK_BOUND_MS));
        }
        return null;
      },
      onAskSettled(requestId) {
        const id = String(requestId);
        const t = rec.openAsks.get(id);
        if (t) api.clearTimer(t);
        rec.openAsks.delete(id);
      },
    }),

    onFinish(rec) {
      if (rec.openAsks) {
        for (const t of rec.openAsks.values()) (ctx && typeof ctx.clearTimer === 'function' ? ctx.clearTimer(t) : clearTimeout(t));
        rec.openAsks.clear();
      }
    },

    keepText: (state) => state === 'failed' || state === 'stopped',

    accepted: (rec, accepted) => ({ ...accepted, ...worktreeFacts(rec) }),

    project(rec, base) {
      const out = { ...base, ...worktreeFacts(rec) };
      if (rec.state === 'running' && rec.openAsks && rec.openAsks.size) {
        out.state = 'needs-input';
        out.note = SENTENCES.needsInput;
        out.openQuestions = rec.openAsks.size;
      }
      return out;
    },
  };
}

/**
 * deps: { projectPath, callerTag, callerIsChild, maxMs, ctx }. `maxMs` shortens the 30-minute cap for a measurement.
 * -> { targets(), start({ backend, prompt }), result(id), release() }
 */
function createTaskRunner({ projectPath, callerTag, callerIsChild = false, maxMs, ctx } = {}) {
  return createChildRunner(createPolicy(ctx || {}), { projectPath, callerTag, callerIsChild, maxMs, ctx });
}

// For the tests: the app-wide count starts empty in each file.
function forgetRunning() { runningEverywhere.clear(); }

module.exports = { createTaskRunner, forgetRunning, SENTENCES, MAX_MS, ASK_BOUND_MS, APP_CAP, MAX_TEXT, MAX_PROMPT };
