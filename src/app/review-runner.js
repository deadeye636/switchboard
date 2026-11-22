'use strict';
// review-runner.js — one agent asks another backend for a read-only second opinion (#507 slice 2b, spec 39).
//
// The REVIEW policy over the shared child runner (`child-runner.js`, which holds the id table, the caps, the timers,
// the end of the turn and the stop path for reviews and tasks alike). One runner per own-server registration (the
// caller's session). What is the review's own: every ask the review session raises is refused and counted, no card and
// no inbox; a plan the reviewer proposes is its answer unless text follows it; the read-only preamble; a 10-minute cap.
//
// Electron-free and db-free, and it names no backend: see `child-runner.js` for what arrives through `ctx`.

const { createChildRunner, MAX_TEXT, MAX_PROMPT } = require('./child-runner');

const MAX_MS = 10 * 60 * 1000;    // from the moment a start is accepted
const APP_CAP = 3;                // running reviews over all callers (O8)
const POLL_AFTER_SECONDS = 30;

// Sent before the caller's prompt (O14), so the reviewer knows what it is for and what it may not do.
const PREAMBLE = 'You are doing a read-only review for another agent. Do not edit files or run commands that change '
  + 'anything. Answer in your reply, not by planning or calling tools that write. Be concise: the answer is cut at about '
  + '32 KB.\n\n';

const SENTENCES = {
  unknownId: 'There is no review with that id for this session.',
  noTarget: 'That backend is not available for a review. Ask tools/list for the ones that are.',
  emptyPrompt: 'The prompt is empty.',
  longPrompt: `The prompt is longer than ${MAX_PROMPT} characters.`,
  callerIsReview: 'A review session cannot start another review.',
  quitting: 'The app is quitting.',
  appCap: `${APP_CAP} reviews are already running in Switchboard. Wait for one of them to finish.`,
  noWindow: 'No Switchboard window is open, so no review can start.',
  untrusted: 'The target backend does not trust this project yet. Trust it for that backend in Switchboard first.',
  notStarted: 'The review session could not start.',
  notSent: 'The review session started but did not take the prompt.',
  noReply: 'The review turn ended without a reply.',
  timeout: 'The review took longer than 10 minutes and was stopped.',  // the sentence for the cap as shipped
  sessionStopped: 'The review session was stopped.',
  callerEnded: 'The calling session ended.',
  appQuitting: 'The app is quitting.',
  running: `Still reviewing; do not call again for ${POLL_AFTER_SECONDS} seconds.`,
  stopReason: 'Stopped: the review ended.',
};

// Reviews running anywhere in the app, for the cap. Only ids; each runner keeps its own records.
const runningEverywhere = new Set();

const POLICY = {
  name: 'review',
  maxMs: MAX_MS,
  appCap: APP_CAP,
  running: runningEverywhere,
  linkKind: 'review',
  sentences: {
    ...SENTENCES,
    callerIsChild: SENTENCES.callerIsReview,
    alreadyRunning: (id) => `A review is already running for this session: ${id}. Poll it with reviewResult.`,
    timeoutAfter: (s) => `The review took longer than ${s} second${s === 1 ? '' : 's'} and was stopped.`,
  },
  preamble: () => PREAMBLE,
  // `reviewTools: false` keeps the review session from getting a review tool of its own (depth 1).
  launchOptions: () => ({ reviewTools: false }),
  observer: (rec) => ({
    onAsk(request) {
      // Every ask is refused (spec 39, "Read-only"): no card, no inbox, nothing remembered.
      rec.refusedActions += 1;
      if (request && request.kind === 'plan' && typeof request.plan === 'string' && request.plan.trim()) {
        // The plan is the answer unless text FOLLOWS it (O11): narration written before the plan does not beat it.
        rec.planText = request.plan;
        rec.lastText = null;
      }
      return { cancelled: true };
    },
  }),
};

/**
 * deps: { projectPath, callerTag, callerIsReview, maxMs, ctx }. `maxMs` is a test seam for the cap (spec 39, M7): it
 * only shortens it, to one second at the least; anything that is not a number below 10 minutes keeps 10 minutes.
 * -> { targets(), start({ backend, prompt }), result(id), release() }
 */
function createReviewRunner({ projectPath, callerTag, callerIsReview = false, maxMs, ctx } = {}) {
  return createChildRunner(POLICY, { projectPath, callerTag, callerIsChild: callerIsReview, maxMs, ctx });
}

// For the tests: the app-wide count starts empty in each file.
function forgetRunning() { runningEverywhere.clear(); }

module.exports = { createReviewRunner, forgetRunning, PREAMBLE, SENTENCES, MAX_MS, MAX_TEXT, MAX_PROMPT, APP_CAP };
