// backends/pi/resume-model.js — the model a Pi RESUME launches on (#754).
//
// Pi restores the last model on a plain resume, but the app passes its own `--model` / `--provider` settings, which
// outrank it — so the session's own pair is read out of its transcript and handed back.
//
// Source, decided by FILE ORDER across both kinds of entry: a `model_change` (`provider`, `modelId`) and an
// assistant message (`provider`, `model`). A resume with `--model` appends NO `model_change` (measured, T1): the
// stale one stays in the file and the next assistant line carries the new model, so only the order tells which
// is later. An assistant entry with `stopReason: error` or zero usage never ran (an expired login or an
// unsupported model is still written with the requested pair, O8): it is skipped, and it also voids a
// `model_change` that preceded it with no successful turn in between, because that switch never took effect.
//
// PERFORMANCE (binding): asked once, on one session's resume. One asynchronous tail read of at most
// MAX_TAIL_BYTES; the row's cached `lastModel` / `lastProvider` answer only where the tail names none. No
// synchronous fs.
'use strict';

const { readFileTailAsync, MAX_TAIL_BYTES } = require('../file-store');

// What may reach `--model` / `--provider` (it becomes argv): no leading dash, no whitespace, no `$`, no quote.
// A Pi model id may carry `:` and `/` (router catalogs), so those are allowed inside.
const LAUNCH_ARG = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]*$/;

const nonEmpty = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

const ranTokens = (u) => !!u && typeof u === 'object'
  && (Number(u.input || 0) + Number(u.output || 0) + Number(u.cacheRead || 0) + Number(u.cacheWrite || 0) + Number(u.totalTokens || 0)) > 0;

/** `{ model, provider }` the tail names last in file order, or null. Pure. */
function lastModelInTail(text) {
  let proven = null;    // the last turn that really ran
  let changed = null;   // a `model_change` after it, not yet tried by a turn
  for (const line of String(text || '').split('\n')) {
    const isChange = line.includes('"model_change"');
    const isMessage = !isChange && line.includes('"assistant"');
    if (!isChange && !isMessage) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }   // a cut or damaged line
    if (!entry) continue;
    if (entry.type === 'model_change') {
      const model = nonEmpty(entry.modelId);
      if (model) changed = { model, provider: nonEmpty(entry.provider) };
    } else if (entry.type === 'message' && entry.message && entry.message.role === 'assistant') {
      const m = entry.message;
      if (m.stopReason === 'error' || !ranTokens(m.usage)) { changed = null; continue; }
      const model = nonEmpty(m.model);
      if (!model) continue;
      proven = { model, provider: nonEmpty(m.provider) || (changed && changed.model === model ? changed.provider : null) };
      changed = null;
    }
  }
  return changed || proven;
}

async function resumeLaunchOptions(row) {
  if (!row || typeof row !== 'object') return null;
  let seen = null;
  if (row.filePath) {
    try { seen = lastModelInTail((await readFileTailAsync(row.filePath, MAX_TAIL_BYTES)).text); } catch { /* unreadable: the row answers */ }
  }
  if (!seen) {
    const model = nonEmpty(row.lastModel);
    if (model) seen = { model, provider: nonEmpty(row.lastProvider) };
  }
  if (!seen || !LAUNCH_ARG.test(seen.model)) return null;
  // Model and provider are one pair, so both keys are always answered: an unknown provider (or one that would
  // not be safe argv) is `null`, which clears a settings provider instead of pairing it with this model.
  const options = { model: seen.model, provider: seen.provider && LAUNCH_ARG.test(seen.provider) ? seen.provider : null };
  return { options, label: options.provider ? `${options.provider}/${seen.model}` : seen.model };
}

module.exports = { resumeLaunchOptions, lastModelInTail, LAUNCH_ARG };
