'use strict';
// What a RESUME launches with (#754). The launch options a resume arrives with are resolved from settings by
// the renderer, so a model chosen for one session only (`/model`, a one-off override) is gone the next time
// it is opened. The backend knows what its session last ran on and says so through the descriptor hook
// `resumeLaunchOptions(row, ctx)` → `{ options: { <key>: value }, label, notice? } | null`; this module merges the
// answer into the options handed to `buildLaunch`. It names no backend and no option key.
//
// PRECEDENCE: an explicit per-launch override (the renderer marks it with `resumeOverride`, #754 T4) > what
// the hook says the session last ran on > the backend/project setting the renderer sent. Without the mark the
// options are "settings", so every key of the hook's answer replaces them; with it, a caller that set ANY key of
// the answer to a non-empty value keeps its options entirely and the whole answer is dropped (a model and its
// provider are one choice), otherwise the whole answer applies. A `null` value clears that key.
// The mark may be a LIST of option keys (#760): the Resume-with-config dialog sends every field, so only the
// fields the user actually changed count as chosen there; a field left as the dialog showed it does not.
//
// PERFORMANCE (binding): the hook is asked once, on the resume of one session, from the spawn path only —
// never in a scan, the index or a list. It is awaited with a short timeout, so a slow or hung backend delays
// a launch by that much at most, and a throw, a timeout or `null` launches exactly as it did before. Nothing
// here touches the filesystem; whatever the backend reads is its own bounded, asynchronous read.
//
// NOTICE: an answer may carry `notice: string`, the one line the session says about it. The backend words it and
// leaves it out when the launch would have been the same without its answer; this module composes no text.

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
 * @returns {Promise<{ options: object, label: string|null, applied: string[], notice: string|null }>}
 *   `options` never carries `resumeOverride`, whatever happened.
 */
async function resolveResumeOptions({ backend, resume, row, projectPath, sessionOptions, env, log, timeoutMs }) {
  const { resumeOverride, ...sent } = sessionOptions || {};
  const none = { options: sent, label: null, applied: [], notice: null };
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

  // The patch is ONE answer (a model and its provider belong together), so it is applied whole or not at all.
  // `null` clears the key; `undefined` and '' leave it alone.
  const keys = Object.keys(patch).filter((key) => patch[key] !== undefined && patch[key] !== '');
  // The user's explicit choice for this launch wins, whole. A list names the keys that were chosen; `true` means
  // every key the caller sent.
  const chosen = (key) => (Array.isArray(resumeOverride) ? resumeOverride.includes(key) : !!resumeOverride);
  if (Object.keys(patch).some((key) => chosen(key) && !isEmpty(sent[key]))) return none;
  const options = { ...sent };
  const applied = [];
  for (const key of keys) {
    if (patch[key] === null) {
      if (!(key in options)) continue;
      delete options[key];
    } else {
      options[key] = patch[key];
    }
    applied.push(key);
  }
  if (!applied.length) return none;
  const label = typeof answer.label === 'string' && answer.label ? answer.label : null;
  if (log && log.debug) log.debug(`[resume-options] backend=${backend.id} resumes with ${applied.join(', ')}${label ? ` (${label})` : ''}`);
  // The backend words the notice and decides whether there is one (it knows what the launch would have done
  // without its answer); the core only relays it, and only for a patch that was applied.
  const notice = typeof answer.notice === 'string' && answer.notice.trim() ? answer.notice.trim() : null;
  return { options, label, applied, notice };
}

/**
 * What a resume of one session would carry from its backend, for the Resume-with-config dialog to show (#760):
 * the same answer `resolveResumeOptions` applies to a PLAIN resume, so it is asked with the options a plain resume
 * sends (the settings the renderer resolved, never a mark) — a backend may answer differently for them (Claude
 * keeps a `[1m]` variant the setting names). A key the answer clears comes back as `null`. Same bounds as a
 * resume — one session, a timeout, nothing read here.
 * @returns {Promise<{ options: object, label: string|null } | null>}  `null` when the backend cannot say.
 */
async function previewResumeOptions({ backend, row, projectPath, sessionOptions, env, log, timeoutMs }) {
  const sent = sessionOptions && typeof sessionOptions === 'object' && !Array.isArray(sessionOptions)
    ? withoutResumeMark(sessionOptions) : {};
  const resumed = await resolveResumeOptions({ backend, resume: true, row, projectPath, sessionOptions: sent, env, log, timeoutMs });
  if (!resumed.applied.length) return null;
  const options = {};
  for (const key of resumed.applied) options[key] = key in resumed.options ? resumed.options[key] : null;
  return { options, label: resumed.label };
}

module.exports = { resolveResumeOptions, previewResumeOptions, withoutResumeMark, RESUME_HOOK_TIMEOUT_MS };
