'use strict';

// Pure helpers for the Saved Variables insert-template mechanism.
//
// No Electron / fs dependencies live here on purpose: the substitution and
// shell-reference logic is the security-sensitive core (it decides how a
// secret's value reaches the terminal), so it must be unit-testable without
// spinning up the app. main.js requires this module and wires it to the
// `resolve-variable-insert` IPC handler.

// Default template for a variable that has none set. Secrets reference a
// temp file (so the plaintext never enters the prompt/transcript); non-secrets
// inline their raw value — this preserves the pre-template behaviour.
function defaultInsertTemplate(secret) {
  return secret ? '{ref}' : '{value}';
}

// Shell-appropriate substitution that reads a temp file's contents inline at
// exec time. Returns null for shells with no safe inline-read (cmd / unknown /
// WSL — a WSL shell can't cat a Windows path directly); the caller then falls
// back to clipboard copy.
function shellRefFor(shellType, filePath) {
  const p = String(filePath ?? '');
  if (shellType === 'bash' || shellType === 'zsh' || shellType === 'sh') {
    // POSIX single-quote the path (escape embedded single quotes as '\'').
    return `"$(cat '${p.replace(/'/g, "'\\''")}')"`;
  }
  if (shellType === 'pwsh' || shellType === 'powershell') {
    // PowerShell single-quote the path (escape embedded single quotes as '').
    return `(Get-Content -Raw '${p.replace(/'/g, "''")}')`;
  }
  return null;
}

// Replace {path} / {ref} / {value} placeholders in a template. A missing value
// (null/undefined) becomes an empty string. Uses split/join rather than a regex
// replace so special characters in the substituted value (e.g. `$`, `\`, `'`)
// can never be misinterpreted as replacement-pattern syntax.
function substituteInsertTemplate(template, values = {}) {
  const v = values || {};
  const path = v.path == null ? '' : String(v.path);
  const ref = v.ref == null ? '' : String(v.ref);
  const value = v.value == null ? '' : String(v.value);
  return String(template ?? '')
    .split('{path}').join(path)
    .split('{ref}').join(ref)
    .split('{value}').join(value);
}

module.exports = { defaultInsertTemplate, shellRefFor, substituteInsertTemplate };
