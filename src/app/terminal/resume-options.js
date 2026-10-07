'use strict';
// What a RESUME launches with (#754). The launch options a resume arrives with are resolved from settings by
// the renderer, so a model chosen for one session only (`/model`, a one-off override) is gone the next time
// it is opened. The backend knows what its session last ran on and says so through the descriptor hook
// `resumeLaunchOptions(row, ctx)` → `{ options: { <key>: value }, label } | null`; this module merges the
// answer into the options handed to `buildLaunch`. It names no backend and no option key.
//
// PRECEDENCE: an explicit per-launch override (the renderer marks it with `resumeOverride`, #754 T4) > what
// the hook says the session last ran on > the backend/project setting the renderer sent. Without the mark the
// options are "settings", so the hook's answer replaces them; with it, a non-empty key of the caller's stays
// and an empty one is filled from the hook.
//
// PERFORMANCE (binding): the hook is asked once, on the resume of one session, from the spawn path only —
// never in a scan, the index or a list. It is awaited with a short timeout, so a slow or hung backend delays
// a launch by that much at most, and a throw, a timeout or `null` launches exactly as it did before. Nothing
// here touches the filesystem; whatever the backend reads is its own bounded, asynchronous read.

const RESUME_HOOK_TIMEOUT_MS = 500;
const TIMED_OUT = Symbol('resume hook timed out');

const isEmpty = (v) => v === undefined || v === null || v === '';

/** The options without the renderer's `resumeOverride` mark, which belongs to this module and nobody else. */
function withoutResumeMark(sessionOptions) {
  const { resumeOverride, ...rest } = sessionOptions || {};
  return rest;
}

/**
 * @param {object} p
 * @param {object} p.backend          the descriptor that opens the session
 * @param {boolean} p.resume          true only for a resume that is not a fork
 * @param {object|null} p.row         the cached session row, or null
 * @param {string|null} p.projectPath
 * @param {object} p.sessionOptions   what the caller sent
 * @param {object} [p.env]            environment the hook may consult
 * @param {{debug?:Function}} [p.log]
 * @returns {Promise<{ options: object, label: string|null, applied: string[] }>}
 *   `options` never carries `resumeOverride`, whatever happened.
 */
async function resolveResumeOptions({ backend, resume, row, projectPath, sessionOptions, env, log, timeoutMs }) {
  const { resumeOverride, ...sent } = sessionOptions || {};
  const none = { options: sent, label: null, applied: [] };
  if (!resume || !backend || typeof backend.resumeLaunchOptions !== 'function') return none;

  let answer = null;
  let timer = null;
  try {
    const asked = Promise.resolve().then(() => backend.resumeLaunchOptions(row || null, {
      projectPath: projectPath || null,
      env: env || {},
      launchOptions: sent,
    }));
    const limit = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs || RESUME_HOOK_TIMEOUT_MS);
    });
    answer = await Promise.race([asked, limit]);
    if (answer === TIMED_OUT) {
      answer = null;
      if (log && log.debug) log.debug(`[resume-options] backend=${backend.id} hook timed out`);
    }
    // A hook that lost the race and rejects later must not become an unhandled rejection.
    asked.catch(() => {});
  } catch (err) {
    if (log && log.debug) log.debug(`[resume-options] backend=${backend.id} hook failed: ${err && err.message}`);
    return none;
  } finally {
    if (timer) clearTimeout(timer);
  }

  const patch = answer && typeof answer === 'object' && answer.options && typeof answer.options === 'object' && !Array.isArray(answer.options)
    ? answer.options : null;
  if (!patch) return none;

  const options = { ...sent };
  const applied = [];
  for (const key of Object.keys(patch)) {
    if (isEmpty(patch[key])) continue;
    if (resumeOverride && !isEmpty(sent[key])) continue;   // the user's explicit choice for this launch wins
    options[key] = patch[key];
    applied.push(key);
  }
  if (!applied.length) return none;
  const label = typeof answer.label === 'string' && answer.label ? answer.label : null;
  if (log && log.debug) log.debug(`[resume-options] backend=${backend.id} resumes with ${applied.join(', ')}${label ? ` (${label})` : ''}`);
  return { options, label, applied };
}

module.exports = { resolveResumeOptions, withoutResumeMark, RESUME_HOOK_TIMEOUT_MS };
