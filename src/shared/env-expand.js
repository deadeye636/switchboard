// --- ${VAR} / ${VAR:-default} expansion for an MCP server's command, arguments and env (#789) ---
//
// One rule for every source of neutral MCP rows: Claude's lister (`src/backends/claude/mcp-servers.js`) and the
// app's own external-server source expand a reference the way Claude does at start, so a server reads the same
// whichever place it came from. A `src/app/` module may not import a backend folder, hence this home.
//
// Only main uses it today, so it is require()-d and has no renderer <script> tag; the export guard is the
// same one the dual-load modules in this directory use.

const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

// References use ASCII names; leave other keys untouched rather than approximate Windows Unicode folding.
function foldEnvName(name) {
  return /^[\x00-\x7f]*$/.test(name) ? name.toUpperCase() : name;
}

// Later layers replace earlier names, including differently cased names on Windows.
function mergeEnv(platform, ...layers) {
  if (platform !== 'win32') return layers.reduce((result, layer) => ({ ...result, ...layer }), {});
  const result = {};
  const names = new Map();
  for (const layer of layers) for (const [key, value] of Object.entries(layer || {})) {
    const folded = foldEnvName(key);
    const previous = names.get(folded);
    if (previous !== undefined) delete result[previous];
    Object.defineProperty(result, key, { value, enumerable: true, configurable: true, writable: true });
    names.set(folded, key);
  }
  return result;
}

function lookup(env, name, platform = process.platform) {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((k) => foldEnvName(k) === foldEnvName(name));
  return key === undefined ? undefined : env[key];
}

/**
 * Expand `${VAR}` and `${VAR:-default}` in a string against `env`. A non-string is returned as it came.
 * A variable with no value and no default expands to '' and its name is added to `missing`.
 */
function expand(value, env, missing, platform = process.platform) {
  if (typeof value !== 'string') return value;
  return value.replace(VAR, (_all, name, fallback) => {
    const v = lookup(env, name, platform);
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
  module.exports = { expand, references, lookup, mergeEnv, foldEnvName };
}
