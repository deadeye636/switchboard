// backends/claude/model-windows.js — which context window the Claude CLI gives a model spec (#620).
//
// A Claude transcript names the model a turn ran on (`message.model`) and never the window. Whether that
// model ran at 200 000 or 1 000 000 tokens can depend on a `[1m]` suffix the transcript does not carry —
// so the window is looked up here, from the model plus whatever spec says `[1m]`.
//
// EVERY NUMBER BELOW WAS MEASURED, not read from documentation: `claude -p --model <spec> --output-format
// json` against an isolated home, CLI 2.1.270, reading `modelUsage.<model>.contextWindow`. A catalog is no
// substitute — Pi's lists `claude-sonnet-4-5` and `claude-opus-4-6` at 1 000 000, which is their `[1m]`
// value, not what the CLI applies to the bare spec. The measurements are on issue #620.
//
// Two decisions that are the owner's, not this file's:
//   - A `claude-*` model that is NOT in the table counts as 1 000 000. Every model released since the 4.7
//     line measured 1M; if a new one does not, the fill reads too low and the badge comes late — it can
//     never raise a false "handoff recommended", which is what #620 was filed about.
//   - Anything that is not a `claude-*` id (a template pointing the CLI at another provider) has no window
//     here at all, and so no fill.
'use strict';

const ONE_M = 1000000;
const BASE_200K = 200000;

// canonical model -> { base: window of the bare spec, oneM: window with `[1m]`, or null when the variant
// is not offered for it }. `oneM` equal to `base` means the suffix changes nothing for that model.
const WINDOWS = {
  'claude-opus-5': { base: ONE_M, oneM: ONE_M },
  'claude-sonnet-5': { base: ONE_M, oneM: ONE_M },   // `sonnet[1m]` measured as claude-sonnet-5[1m] at 1M
  'claude-fable-5': { base: ONE_M, oneM: null },
  'claude-fable-5-1': { base: ONE_M, oneM: null },
  'claude-opus-4-8': { base: ONE_M, oneM: null },
  'claude-opus-4-7': { base: ONE_M, oneM: null },
  'claude-opus-4-6': { base: BASE_200K, oneM: ONE_M },
  // `[1m]` was refused on the measuring account (429 "Usage credits required for 1M context"); the CLI
  // names the variant 1M itself, so a session that did run as `[1m]` had 1M.
  'claude-sonnet-4-6': { base: BASE_200K, oneM: ONE_M },
  'claude-sonnet-4-5': { base: BASE_200K, oneM: ONE_M },
  'claude-opus-4-5': { base: BASE_200K, oneM: null },
  'claude-haiku-4-5': { base: BASE_200K, oneM: null },
};

// What the CLI's aliases resolved to, measured the same way. They move with CLI releases — and a user can
// point one elsewhere (`ANTHROPIC_DEFAULT_OPUS_MODEL`) — so an alias only NAMES A FAMILY once a turn has
// run: within that family, the canonical id the turn reports wins over what the alias would mean today.
const ALIASES = {
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
  fable: 'claude-fable-5-1',
};

// Specs that name no model at all: the CLI's own default. They say nothing about a window.
const NO_MODEL = new Set(['default']);

/** The family a canonical id belongs to (`claude-opus-4-6` -> `opus`), or null. */
function familyOf(model) {
  const m = /^claude-(opus|sonnet|haiku|fable)(?:-|$)/.exec(String(model || ''));
  return m ? m[1] : null;
}

/**
 * A model spec or id taken apart: `{ model, oneM, family }`, or null when it names no model.
 * Case and whitespace are ignored; a trailing `-YYYYMMDD` or `@<version>` is dropped (stored ids carry
 * dates: `claude-opus-4-5-20251101`); an alias becomes the canonical id it resolved to, and `family` is
 * set only for an alias — it is what lets a turn's own id win inside that family.
 */
function parseSpec(spec) {
  let s = String(spec == null ? '' : spec).trim().toLowerCase();
  if (!s) return null;
  const oneM = /\[1m\]$/.test(s);
  s = s.replace(/\[1m\]$/, '').trim();
  s = s.replace(/@[^@]*$/, '').replace(/-\d{8}$/, '');
  if (!s || NO_MODEL.has(s)) return null;
  if (ALIASES[s]) return { model: ALIASES[s], oneM, family: s };
  return { model: s, oneM, family: null };
}

/** Does this spec name the model the turn ran on — by id, or as the alias of its family? */
function namesModel(spec, ranOn) {
  if (!spec || !ranOn) return false;
  if (spec.model === ranOn.model) return true;
  return !!spec.family && spec.family === familyOf(ranOn.model);
}

/** The same question for a raw spec and the raw model a transcript reports — what the reader asks (#622). */
function specNamesModel(spec, model) {
  return namesModel(parseSpec(spec), parseSpec(model));
}

/** The window for a canonical model, with or without the `[1m]` variant; null for a non-Claude model. */
function windowFor(model, oneM) {
  if (typeof model !== 'string' || !model.startsWith('claude-')) return null;
  const entry = WINDOWS[model];
  if (!entry) return ONE_M;
  return oneM && entry.oneM ? entry.oneM : entry.base;
}

/**
 * The window a session's last turn ran against.
 *
 *   row.lastModelSpec   the last `/model <spec>` in the transcript, unless a later turn ran on a model it does
 *                       not name (the reader drops it then, #622). It decides the MODEL at once, even over
 *                       the model the last turn ran on, because the CLI applies a switch at once (#620, E9).
 *                       Two limits: an ALIAS only names a family, so a turn inside that family keeps its own
 *                       id; and a spec that yields no window (an alias the table does not know) falls back to
 *                       the turn's model rather than taking the fill away.
 *   row.lastModel       the model of the last turn with input
 *   configuredSpecs     every other spec that could carry `[1m]`, in the CLI's precedence (the stored launch
 *                       `--model`, the session's ANTHROPIC_MODEL, then the settings cascade)
 *
 * The VARIANT is not decided by precedence: of every spec naming that model — the transcript spec and each
 * configured one — the LARGEST window wins (#620, E12). The app reads configuration as it is now, not as it
 * was at launch, so a bare spec may be a stale one: a `/model <id>` typed before a later `[1m]` launch, an
 * alias higher in the cascade, a switch another session wrote into the global user settings. Taking the
 * larger window can make a badge late, never false — the same trade as an unknown model counting as 1M.
 * Precedence only breaks a tie, which is what `source` reports.
 *
 * Floor: a turn that sent more than 200 000 tokens cannot have run in a 200 000 window — but only where the
 * variant was inferred (a configured spec, the bare model, or a transcript alias matched by family). A
 * transcript spec naming a model by id is the CLI's own switch, and after `/model` to a 200 000 window the
 * fill may exceed it, which is what the CLI's status line shows too (it compacts on the next turn).
 * Returns `{ windowTokens, source }` or null.
 */
function resolveClaudeWindow(row, configuredSpecs = []) {
  if (!row) return null;
  const input = Number(row.lastInputTokens) || 0;
  const ranOn = parseSpec(row.lastModel);
  // A turn on another provider's model (a template that remaps an alias) has no Claude window, whatever a
  // `/model` alias in the transcript would mean for Claude.
  if (ranOn && !ranOn.model.startsWith('claude-')) return null;

  const spec = parseSpec(row.lastModelSpec);
  // By FAMILY only (an alias whose family the turn's model belongs to): the model is the turn's, so the
  // variant is inferred like a configured spec's — and the floor below still applies to it.
  const byFamily = !!(spec && ranOn && spec.model !== ranOn.model && namesModel(spec, ranOn));
  // Otherwise a spec with a window is the CLI's own switch and names the model (E9).
  const switched = !!(spec && !byFamily && windowFor(spec.model, false) != null);
  const model = switched ? spec.model : ranOn && ranOn.model;
  if (!model) return null;

  // Every spec naming that model, highest precedence first. `inferred` is false only for the switch itself.
  const candidates = [];
  if (switched || byFamily) candidates.push({ oneM: spec.oneM, source: 'transcript-spec', inferred: byFamily });
  for (const raw of configuredSpecs) {
    const configured = parseSpec(raw);
    if (namesModel(configured, { model })) candidates.push({ oneM: configured.oneM, source: 'configured-spec', inferred: true });
  }
  let best = null;
  for (const candidate of candidates) {
    const windowTokens = windowFor(model, candidate.oneM);
    if (!best || windowTokens > best.windowTokens) best = { windowTokens, source: candidate.source, inferred: candidate.inferred };
  }
  if (!best) best = { windowTokens: windowFor(model, false), source: 'model', inferred: true };
  if (best.windowTokens == null) return null;

  if (best.inferred && input > BASE_200K && best.windowTokens < ONE_M) return { windowTokens: ONE_M, source: 'floor' };
  return { windowTokens: best.windowTokens, source: best.source };
}

module.exports = { WINDOWS, ALIASES, parseSpec, familyOf, specNamesModel, windowFor, resolveClaudeWindow };
