// external-mcp-validate.js — the pure validator for a project's `externalMcpServers` list (#789, spec 36).
//
// Split out of src/app/external-mcp.js so the settings screen can run the SAME check while somebody types:
// this file is a classic <script> in settings.html (its function lands on `window`) AND require()d by
// `src/app/external-mcp.js` and the node tests. Pure value work — no fs, no settings read, no DOM, no
// `${VAR}` expansion (the injection source does that against the session's environment).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) Object.assign(root, api);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const NAME_RE = /^[A-Za-z0-9_-]+$/;
  const RESERVED_NAMES = new Set(['switchboard']);   // the own server's name (spec 34)
  const TRANSPORTS = ['stdio', 'http'];

  // An env/header value that looks like a literal credential rather than a `${VAR}` reference. A warning only:
  // a literal may be intentional, and the validator cannot tell a secret from a path.
  const SECRET_KEY_RE = /(token|secret|password|passwd|api[_-]?key|authorization|bearer)/i;
  const SECRET_VALUE_RE = /^(sk-|ghp_|gho_|github_pat_|xox[bap]-|AKIA|Bearer\s+\S)/;

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function isStringArray(v) {
    return Array.isArray(v) && v.every(x => typeof x === 'string');
  }

  function isStringMap(v) {
    return isPlainObject(v) && Object.values(v).every(x => typeof x === 'string');
  }

  function nonEmptyString(v) {
    return typeof v === 'string' && v.trim() !== '';
  }

  function looksLikeLiteralSecret(key, value) {
    if (/\$\{[^}]+\}/.test(value) || value === '') return false;
    return SECRET_VALUE_RE.test(value) || (SECRET_KEY_RE.test(key) && value.length >= 8);
  }

  /** One entry -> { entry } | { reason }, plus `warnings` for the entry. */
  function checkEntry(raw) {
    if (!isPlainObject(raw)) return { reason: 'entry is not an object' };
    if (!nonEmptyString(raw.name)) return { reason: 'name is missing or not a non-empty string' };
    const name = raw.name.trim();
    if (!NAME_RE.test(name)) return { reason: `name "${name}" may only use letters, digits, "_" and "-"` };
    if (RESERVED_NAMES.has(name.toLowerCase())) return { reason: `name "${name}" is reserved for Switchboard's own server` };
    if (!TRANSPORTS.includes(raw.transport)) return { reason: `transport must be "stdio" or "http"` };
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') return { reason: 'enabled must be a boolean' };
    if (raw.backends !== undefined && !isStringArray(raw.backends)) return { reason: 'backends must be an array of strings' };

    const out = { name, transport: raw.transport, enabled: raw.enabled !== false };
    if (raw.backends !== undefined) out.backends = raw.backends.slice();
    const warnings = [];
    const scanSecrets = (map, what) => {
      for (const [k, v] of Object.entries(map)) {
        if (looksLikeLiteralSecret(k, v)) warnings.push(`${what} "${k}" looks like a literal secret; use a \${VAR} reference`);
      }
    };

    if (raw.transport === 'stdio') {
      if (!nonEmptyString(raw.command)) return { reason: 'a stdio entry needs a non-empty command' };
      if (raw.url !== undefined || raw.headers !== undefined) return { reason: 'a stdio entry cannot carry url or headers' };
      if (raw.args !== undefined && !isStringArray(raw.args)) return { reason: 'args must be an array of strings' };
      if (raw.env !== undefined && !isStringMap(raw.env)) return { reason: 'env must be an object of string values' };
      if (raw.cwd !== undefined && !nonEmptyString(raw.cwd)) return { reason: 'cwd must be a non-empty string' };
      out.command = raw.command;
      out.args = raw.args ? raw.args.slice() : [];
      out.env = raw.env ? { ...raw.env } : {};
      if (raw.cwd !== undefined) out.cwd = raw.cwd;
      scanSecrets(out.env, 'env value');
    } else {
      if (!nonEmptyString(raw.url)) return { reason: 'an http entry needs a non-empty url' };
      if (raw.command !== undefined || raw.args !== undefined || raw.env !== undefined || raw.cwd !== undefined) {
        return { reason: 'an http entry cannot carry command, args, env or cwd' };
      }
      if (raw.headers !== undefined && !isStringMap(raw.headers)) return { reason: 'headers must be an object of string values' };
      out.url = raw.url;
      out.headers = raw.headers ? { ...raw.headers } : {};
      scanSecrets(out.headers, 'header value');
    }
    return { entry: out, warnings };
  }

  /**
   * Validate the stored list. Never throws. A bad entry is dropped with a reason, not fatal to the others.
   * -> { servers: normalized[], rejected: [{ index, name, reason }], warnings: [{ index, name, message }] }
   */
  function validateExternalMcpServers(list) {
    const servers = [];
    const rejected = [];
    const warnings = [];
    if (list === undefined || list === null) return { servers, rejected, warnings };
    if (!Array.isArray(list)) {
      rejected.push({ index: -1, name: '', reason: 'externalMcpServers must be an array' });
      return { servers, rejected, warnings };
    }
    const seen = new Set();
    list.forEach((raw, index) => {
      const res = checkEntry(raw);
      const name = isPlainObject(raw) && typeof raw.name === 'string' ? raw.name : '';
      if (res.reason) { rejected.push({ index, name, reason: res.reason }); return; }
      if (seen.has(res.entry.name)) { rejected.push({ index, name: res.entry.name, reason: 'duplicate name' }); return; }
      seen.add(res.entry.name);
      servers.push(res.entry);
      for (const message of res.warnings) warnings.push({ index, name: res.entry.name, message });
    });
    return { servers, rejected, warnings };
  }

  return { validateExternalMcpServers };
});
