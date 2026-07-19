'use strict';
// #241 — an isolated run must isolate every path, not just the ones the scan uses.
//
// `SWITCHBOARD_STORE_CLAUDE` moved where Switchboard LOOKS. Four other places composed Claude's home
// from `os.homedir()` and therefore kept reading and WRITING the user's real one from an instance that
// promises it touches nothing real:
//
//   - the Projects admin's config reader/writer   (~/.claude.json — it listed the user's real projects
//     inside a demo window, and Remove-entry would have edited their real file)
//   - the scheduler                                (scans ~/.claude/projects every 60 s on EVERY boot and
//     pre-seeds real session files there; also writes ~/.claude/commands/…)
//   - the MCP IDE bridge                           (drops lock files into ~/.claude/ide)
//   - the attention hook                           (patches ~/.claude/settings.json)
//
// test/backend-path-neutrality.test.js allows these files to KNOW Claude's layout — that is a separate
// (and legitimate) thing. What it cannot see is whether they RESOLVE it against the isolated home. This
// guard is that half: a file that composes Claude's home from `os.homedir()` must also consult the store
// override. It is a source check on purpose — three of the four are Electron-bound or fs-bound at load and
// cannot be exercised in `node --test`, which is exactly why the leak survived this long.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
}

// Files that legitimately compose a path inside a CLI's home. Each must resolve it against that backend's
// store override. Codex is here because it repeated the defect one backend over: its trust module WRITES
// `config.toml` from the Projects admin, and its thread-name overlay is read on every session parse.
const MUST_FOLLOW_OVERRIDE = [
  ['src/backends/claude/config.js', 'SWITCHBOARD_STORE_CLAUDE', /homedir\(\)[^;\n]*['"]\.claude/],
  ['src/servers/schedule-runner.js', 'SWITCHBOARD_STORE_CLAUDE', /homedir\(\)[^;\n]*['"]\.claude/],
  ['src/servers/schedule-ipc.js', 'SWITCHBOARD_STORE_CLAUDE', /homedir\(\)[^;\n]*['"]\.claude/],
  ['src/servers/mcp-bridge.js', 'SWITCHBOARD_STORE_CLAUDE', /homedir\(\)[^;\n]*['"]\.claude/],
  ['src/app/hooks.js', 'SWITCHBOARD_STORE_CLAUDE', /homedir\(\)[^;\n]*['"]\.claude/],
  ['src/main.js', 'SWITCHBOARD_STORE_CLAUDE', /homedir\(\)[^;\n]*['"]\.claude/],
  ['src/backends/codex/trust.js', 'SWITCHBOARD_STORE_CODEX', /homedir\(\)[^;\n]*['"]\.codex/],
  ['src/backends/codex/thread-names.js', 'SWITCHBOARD_STORE_CODEX', /homedir\(\)[^;\n]*['"]\.codex/],
];

test('every place that composes a CLI home follows that backend\'s store override (#241)', () => {
  for (const [rel, envVar, homePattern] of MUST_FOLLOW_OVERRIDE) {
    const src = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    assert.match(src, homePattern, `${rel}: expected it to still compose the real home — update this list if that moved`);
    assert.ok(
      src.includes(envVar),
      `${rel} builds a path under the CLI's home but never consults ${envVar} — an isolated ` +
      `(demo/sandbox) run would read or WRITE the user's real store from there`,
    );
  }
});

// The other half: the override must not be resolved ONCE at module load. These modules are required long
// before a path is read, and a test (or a future launcher) may set the variable later; a constant frozen at
// load time answers with the real home for the rest of the process.
test('the override is resolved per call, not frozen at module load (#241)', () => {
  const saved = process.env.SWITCHBOARD_STORE_CLAUDE;
  try {
    delete process.env.SWITCHBOARD_STORE_CLAUDE;
    const config = require('../src/backends/claude/config');
    const before = config.claudeConfigPath();

    process.env.SWITCHBOARD_STORE_CLAUDE = path.join('C:', 'demo', 'stores', 'claude', 'projects');
    const after = config.claudeConfigPath();

    assert.notEqual(after, before, 'setting the override after load must change the resolved path');
    assert.equal(after, path.join('C:', 'demo', 'stores', 'claude', '.claude.json'));
  } finally {
    if (saved === undefined) delete process.env.SWITCHBOARD_STORE_CLAUDE;
    else process.env.SWITCHBOARD_STORE_CLAUDE = saved;
  }
});

// Codex' own admin surface: the same read/write pair, one backend over. `trust.set()` writes config.toml
// from the Projects admin, so an isolated run resolving to the real home edits the user's real Codex config.
test('Codex\'s trust config and thread-name index follow the isolated store (#241)', () => {
  const saved = process.env.SWITCHBOARD_STORE_CODEX;
  const savedHome = process.env.CODEX_HOME;
  try {
    delete process.env.SWITCHBOARD_STORE_CODEX;
    process.env.CODEX_HOME = path.join('C:', 'real', 'codex');
    const trust = require('../src/backends/codex/trust');
    const before = trust.configPath();
    assert.equal(before, path.join('C:', 'real', 'codex', 'config.toml'), 'without the override, the CLI\'s own variable still decides');

    process.env.SWITCHBOARD_STORE_CODEX = path.join('C:', 'demo', 'stores', 'codex', 'sessions');
    const after = trust.configPath();
    assert.equal(after, path.join('C:', 'demo', 'stores', 'codex', 'config.toml'),
      'the store override must win over CODEX_HOME — it is the one that says "this run is isolated"');
  } finally {
    if (saved === undefined) delete process.env.SWITCHBOARD_STORE_CODEX;
    else process.env.SWITCHBOARD_STORE_CODEX = saved;
    if (savedHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedHome;
  }
});
