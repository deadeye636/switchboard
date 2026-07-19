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

// Files that legitimately compose a path inside Claude's home. Each must resolve it against the override.
const MUST_FOLLOW_OVERRIDE = [
  'src/backends/claude/config.js',
  'src/servers/schedule-runner.js',
  'src/servers/schedule-ipc.js',
  'src/servers/mcp-bridge.js',
  'src/app/hooks.js',
  'src/main.js',
];

// Composing Claude's home out of the real user home: `os.homedir()` in the same expression as '.claude'.
const HOMEDIR_CLAUDE = /homedir\(\)[^;\n]*['"]\.claude/;

test('every place that composes Claude\'s home follows the store override (#241)', () => {
  for (const rel of MUST_FOLLOW_OVERRIDE) {
    const src = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    assert.match(src, HOMEDIR_CLAUDE, `${rel}: expected it to still compose ~/.claude — update this list if that moved`);
    assert.ok(
      src.includes('SWITCHBOARD_STORE_CLAUDE'),
      `${rel} builds a path under ~/.claude but never consults SWITCHBOARD_STORE_CLAUDE — an isolated ` +
      `(demo/sandbox) run would read or WRITE the user's real Claude home from there`,
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
