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

// Resolve an env bundle against a host env (defaults to process.env).
// Returns a NEW object; the input is not mutated.
//   - literal (incl. "")        -> kept verbatim
//   - `$VAR` with host value set -> host value
//   - `$VAR` unset/empty in host -> KEY dropped entirely (no leak)
// Non-string values are coerced to string literals (defensive; bundles should be strings).
function resolveEnv(bundle, hostEnv) {
  const host = hostEnv || process.env;
  const out = {};
  if (!bundle || typeof bundle !== 'object') return out;
  for (const [key, value] of Object.entries(bundle)) {
    if (isEnvRef(value)) {
      const name = refVarName(value);
      const resolved = host[name];
      // Drop when the host var is missing or empty — never leak "$VAR".
      if (typeof resolved === 'string' && resolved !== '') {
        out[key] = resolved;
      }
      continue;
    }
    // Literal (including "" to clear a var). Coerce non-strings defensively.
    out[key] = typeof value === 'string' ? value : String(value);
  }
  return out;
}

module.exports = { resolveEnv, isEnvRef, refVarName };
