// external-mcp-form.js — the pure mapping between the MCP server form and one `externalMcpServers` entry (#789 slice B, spec 36).
//
// A classic <script> in settings.html (its functions land on `window`) AND require()d by the node tests, like
// external-mcp-validate.js, which it follows in the script list. Pure value work: no fs, no DOM, no settings read.
// It does NOT validate (spec 36, D-B7): `validateExternalMcpServers` stays the only check, and the caller runs it
// over the entry this file builds. It names no backend; `backends` is an opaque list of ids.
//
// formState: { name, transport, command, args, envRows, passthrough, cwd, url, headerRows, enabled, backends, extra }
//   args        one argument per line in a single string, never shell-split
//   envRows     [{ name, value }]  stdio environment variables
//   passthrough [name]             stdio rows stored as `NAME: "${NAME}"` in `env`
//   headerRows  [{ name, value }]  http headers
//   enabled     boolean | undefined (undefined = the entry had no `enabled` key; it stays absent)
//   backends    [id]               empty = the key is omitted
//   extra       keys the form does not know, carried through unchanged so an Edit never loses a field
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) Object.assign(root, api);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const KNOWN_KEYS = new Set(['name', 'transport', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'enabled', 'backends']);

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function str(v) {
    return typeof v === 'string' ? v : '';
  }

  function rowsOf(map) {
    return isPlainObject(map) ? Object.entries(map).map(([name, value]) => ({ name, value: String(value) })) : [];
  }

  function mapOf(rows) {
    const out = {};
    for (const row of rows || []) {
      const name = str(row && row.name).trim();
      if (name === '') continue;
      out[name] = str(row.value);
    }
    return out;
  }

  /** One raw entry -> form state. A row of `env` whose value is exactly its own `${NAME}` becomes a passthrough name. */
  function entryToForm(raw) {
    const entry = isPlainObject(raw) ? raw : {};
    const envRows = [];
    const passthrough = [];
    for (const row of rowsOf(entry.env)) {
      if (row.value === '${' + row.name + '}') passthrough.push(row.name);
      else envRows.push(row);
    }
    const extra = {};
    for (const [k, v] of Object.entries(entry)) {
      if (!KNOWN_KEYS.has(k)) extra[k] = v;
    }
    return {
      name: str(entry.name),
      transport: entry.transport === 'http' ? 'http' : 'stdio',
      command: str(entry.command),
      args: Array.isArray(entry.args) ? entry.args.filter(a => typeof a === 'string').join('\n') : '',
      envRows,
      passthrough,
      cwd: str(entry.cwd),
      url: str(entry.url),
      headerRows: rowsOf(entry.headers),
      enabled: typeof entry.enabled === 'boolean' ? entry.enabled : undefined,
      backends: Array.isArray(entry.backends) ? entry.backends.filter(b => typeof b === 'string') : [],
      extra,
    };
  }

  /** Form state -> one raw entry. Only the chosen transport's fields are written; empty rows and blank lines drop out. */
  function formToEntry(form) {
    const f = form || {};
    const entry = { ...(isPlainObject(f.extra) ? f.extra : {}) };
    entry.name = str(f.name).trim();
    entry.transport = f.transport === 'http' ? 'http' : 'stdio';
    if (entry.transport === 'stdio') {
      entry.command = str(f.command).trim();
      const args = str(f.args).split(/\r?\n/).filter(line => line.trim() !== '');
      if (args.length) entry.args = args;
      const env = mapOf(f.envRows);
      for (const raw of f.passthrough || []) {
        const name = str(raw).trim();
        if (name !== '') env[name] = '${' + name + '}';
      }
      if (Object.keys(env).length) entry.env = env;
      const cwd = str(f.cwd).trim();
      if (cwd !== '') entry.cwd = cwd;
    } else {
      entry.url = str(f.url).trim();
      const headers = mapOf(f.headerRows);
      if (Object.keys(headers).length) entry.headers = headers;
    }
    if (typeof f.enabled === 'boolean') entry.enabled = f.enabled;
    if (Array.isArray(f.backends) && f.backends.length) entry.backends = f.backends.slice();
    return entry;
  }

  return { entryToForm, formToEntry };
});
