// --- ${VAR} / ${VAR:-default} expansion for an MCP server's command, arguments and env (#789) ---
//
// One rule for every source of neutral MCP rows: Claude's lister (`src/backends/claude/mcp-servers.js`) and the
// app's own external-server source expand a reference the way Claude does at start, so a server reads the same
// whichever place it came from. A `src/app/` module may not import a backend folder, hence this home.
//
// Only main uses it today, so it is require()-d and has no renderer <script> tag; the export guard is the
// same one the dual-load modules in this directory use.

const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * The value of `name` in `env`, exact spelling first. With `foldCase` a key that differs only in case answers when the
 * exact one is absent: on Windows a variable name is case-insensitive (#794), so `${PATH}` finds `Path`, as it would
 * through `process.env` and in the child process. A plain copy of the environment loses that, hence the fold here.
 */
function lookupVar(env, name, foldCase) {
  if (env[name] !== undefined) return env[name];
  if (!foldCase) return undefined;
  const upper = name.toUpperCase();
  const key = Object.keys(env).find((k) => k.toUpperCase() === upper);
  return key === undefined ? undefined : env[key];
}

/**
 * Expand `${VAR}` and `${VAR:-default}` in a string against `env`. A non-string is returned as it came.
 * A variable with no value and no default expands to '' and its name is added to `missing`.
 * opts: { foldCase } — look names up case-insensitively (pass `true` on win32), see `lookupVar`.
 */
function expand(value, env, missing, opts) {
  if (typeof value !== 'string') return value;
  const foldCase = !!(opts && opts.foldCase);
  return value.replace(VAR, (_all, name, fallback) => {
    const v = lookupVar(env, name, foldCase);
    // Shell semantics: `:-` also replaces an EMPTY value; a bare reference to a set-but-empty one is empty.
    if (fallback !== undefined) return v !== undefined && v !== '' ? v : fallback;
    if (v !== undefined) return v;
    missing.add(name);
    return '';
  });
}

/**
 * Every `${VAR}` / `${VAR:-default}` in a string, as `{ name, hasDefault }`, in order. Same pattern as `expand`,
 * so the two cannot disagree about what a reference is. A non-string has none.
 */
function references(value) {
  if (typeof value !== 'string') return [];
  return [...value.matchAll(VAR)].map((m) => ({ name: m[1], hasDefault: m[2] !== undefined }));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { expand, references, lookupVar };
}
