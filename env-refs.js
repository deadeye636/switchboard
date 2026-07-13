// env-refs.js — resolve an env bundle's `$VAR` references against the host environment.
//
// A backend/profile stores its env bundle as `{ KEY: value }`. A value is either:
//   - a LITERAL — kept verbatim, INCLUDING the empty string "" (a deliberate literal
//     used to CLEAR/blank a stale inherited var, e.g. ANTHROPIC_API_KEY="").
//   - a REFERENCE — `$VAR` or `${VAR}` — resolved from the host env at spawn time.
//
// Secret hygiene (invariant §5.2): a reference resolves to the host value only when that
// value is a non-empty string; an unresolved/empty reference is DROPPED, never emitted as
// the literal string "$VAR" (which would leak the ref text into the child and, worse, mask
// a missing credential). Resolution happens at spawn; raw secrets are never written to disk.
'use strict';

// Whole-value reference: `$VAR` or `${VAR}`. The name follows POSIX env-var rules
// ([A-Za-z_][A-Za-z0-9_]*). Only a value that is ENTIRELY a reference counts — a value
// with surrounding text (e.g. "prefix-$VAR") is treated as a literal, matching the
// ivandobsky model (a bundle value is either a whole ref or a literal).
// Matched forms only: `$VAR` or `${VAR}`. A mismatched brace (`${VAR` / `$VAR}`) is NOT a ref — it
// falls through to a literal (harmless: it never leaks, and a malformed ref is not a valid var name).
const REF_RE = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/;

// Is this value a whole-string `$VAR` / `${VAR}` reference? Non-strings are never refs.
function isEnvRef(value) {
  return typeof value === 'string' && REF_RE.test(value);
}

// The referenced variable name, or null if `value` is not a reference.
function refVarName(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(REF_RE);
  return m ? (m[1] || m[2]) : null;
}

/**
 * Resolve an env bundle against a host env (defaults to process.env) — AND SAY WHAT WAS DROPPED (#169).
 *
 * Returns a NEW object; the input is not mutated.
 *   - literal (incl. "")         -> kept verbatim
 *   - `$VAR` with host value set  -> host value
 *   - `$VAR` unset/empty in host  -> KEY dropped entirely (no leak), and reported in `missing`
 *
 * The drop itself is right and stays: emitting the literal `"$VAR"` would leak the ref text into the
 * child and, worse, mask a missing credential behind a value that looks like one. What was wrong is that
 * it happened in SILENCE. A template pointed at another provider whose `$OPENAI_API_KEY` is not set
 * launched happily, the key simply absent, and the user was left with a provider auth error that named
 * nothing. The app could always explain it — it just did so in the editor, where nothing is at stake,
 * and said nothing at the spawn, where it costs a session.
 *
 * Non-string values are coerced to string literals (defensive; bundles should be strings).
 *
 * @returns {{env: object, missing: Array<{key: string, varName: string}>}}
 */
function resolveEnvRefs(bundle, hostEnv) {
  const host = hostEnv || process.env;
  const env = {};
  const missing = [];
  if (!bundle || typeof bundle !== 'object') return { env, missing };

  for (const [key, value] of Object.entries(bundle)) {
    if (isEnvRef(value)) {
      const varName = refVarName(value);
      const resolved = host[varName];
      if (typeof resolved === 'string' && resolved !== '') {
        env[key] = resolved;
      } else {
        missing.push({ key, varName });
      }
      continue;
    }
    // Literal (including "" to clear a var). Coerce non-strings defensively.
    env[key] = typeof value === 'string' ? value : String(value);
  }
  return { env, missing };
}

/** The env alone, for callers that have nothing to say about what was dropped. */
function resolveEnv(bundle, hostEnv) {
  return resolveEnvRefs(bundle, hostEnv).env;
}

/**
 * What to tell the user, in one line. `source` names the thing that carries the bundle — the template,
 * the backend, the launcher — because "OPENAI_API_KEY is not set" without it is a riddle when three
 * templates reference three different keys.
 */
function missingRefsMessage(missing, source) {
  if (!missing || !missing.length) return null;
  const vars = [...new Set(missing.map(m => '$' + m.varName))].join(', ');
  const what = missing.length === 1 ? 'is not set' : 'are not set';
  return `${source ? source + ': ' : ''}${vars} ${what} in the environment — `
    + `${missing.length === 1 ? 'that variable was' : 'those variables were'} left out of the session. `
    + 'If the CLI needs it, it will fail to authenticate.';
}

module.exports = { resolveEnv, resolveEnvRefs, missingRefsMessage, isEnvRef, refVarName };
