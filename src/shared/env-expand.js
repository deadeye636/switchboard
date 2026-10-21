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
 * Expand `${VAR}` and `${VAR:-default}` in a string against `env`. A non-string is returned as it came.
 * A variable with no value and no default expands to '' and its name is added to `missing`.
 */
function expand(value, env, missing) {
  if (typeof value !== 'string') return value;
  return value.replace(VAR, (_all, name, fallback) => {
    const v = env[name];
    // Shell semantics: `:-` also replaces an EMPTY value; a bare reference to a set-but-empty one is empty.
    if (fallback !== undefined) return v !== undefined && v !== '' ? v : fallback;
    if (v !== undefined) return v;
    missing.add(name);
    return '';
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { expand };
}
