'use strict';
// #241 — an isolated run must isolate every path, not just the ones the scan uses.
//
// `SWITCHBOARD_STORE_CLAUDE` moved where Switchboard LOOKS. Four other places composed Claude's home
// from `os.homedir()` and therefore kept reading and WRITING the user's real one from an instance that
// promises it touches nothing real:
//
//   - the Projects admin's config reader/writer   (~/.claude.json — it listed the user's real projects
//     inside a demo window, and Remove-entry would have edited their real file)
//   - the MCP IDE bridge                           (drops lock files into ~/.claude/ide)
//   - the attention hook                           (patches ~/.claude/settings.json)
//   - the scheduler (scanned ~/.claude/projects every 60 s on EVERY boot and pre-seeded real session
//     files there) — since removed entirely, #246
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

// The stripper is shared, and its ORDER is load-bearing — `test/helpers/strip-comments.js` says why. This
// guard is one of the two that was silently blinded by having it the other way round.
const { stripComments } = require('./helpers/strip-comments');

// Files that legitimately compose a path inside a CLI's home. Each must resolve it against that backend's
// store override. Codex is here because it repeated the defect one backend over: its trust module WRITES
// `config.toml` from the Projects admin, and its thread-name overlay is read on every session parse.
const MUST_FOLLOW_OVERRIDE = [
  ['src/backends/claude/config.js', 'SWITCHBOARD_STORE_CLAUDE', /homedir\(\)[^;\n]*['"]\.claude/],
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

// --- The same guard, DERIVED instead of listed -------------------------------
//
// The list above is the four places #241 found. It cannot see a fifth: a file added later composes a CLI
// home, nobody adds it here, and the guard reports success about a file it never opened. That is exactly
// what happened — the resource readers added in one evening read the user's real `~/.codex` and
// `~/.agents/skills` from an isolated instance, with this test green, because they were not on the list.
//
// So the question is asked of EVERY file under `src/`: if you compose a CLI's home from `os.homedir()`,
// you must consult that backend's store override. A file that legitimately does not needs an entry in
// EXEMPT with a reason — the point is not that exceptions are forbidden, it is that they are deliberate
// and readable, and that the default for anything new is "flagged".

const HOME_COMPOSERS = [
  ['SWITCHBOARD_STORE_CLAUDE', /homedir\(\)[^;\n]*['"`]\.claude/],
  ['SWITCHBOARD_STORE_CODEX', /homedir\(\)[^;\n]*['"`]\.codex/],
  ['SWITCHBOARD_STORE_PI', /homedir\(\)[^;\n]*['"`]\.(pi|agents)/],
  ['SWITCHBOARD_STORE_HERMES', /homedir\(\)[^;\n]*['"`]\.?hermes/],
  ['SWITCHBOARD_STORE_AGY', /homedir\(\)[^;\n]*['"`]\.(agy|gemini)/],
];

// Each entry says WHY the path may stay on the real home. Anything not here has to follow its override.
const EXEMPT = new Map([
  ['src/db/connection.js',
    'the ~/.claude/browser paths are LEGACY Switchboard databases it adopts from, not a CLI home it reads; '
    + 'its own isolation is SWITCHBOARD_DATA_DIR'],
  ['src/db/migrations.js',
    'a shipped migration back-fills the pre-override default; rewriting it would change what already ran '
    + 'on every existing database'],
  ['src/backends/claude/usage.js',
    'reads the account limits the CLI cached, which are a property of the ACCOUNT rather than of the store, '
    + 'and follows CLAUDE_CONFIG_DIR when the CLI was pointed elsewhere'],
  ['src/backends/agy/usage.js',
    'has an override of its own, SWITCHBOARD_AGY_CREDS — the credentials file is not under the sessions store'],
]);

function walkJs(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJs(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * The block that composes the home, not the whole file.
 *
 * Asking "does this FILE mention the override" is too coarse, and measurably so: the codex descriptor
 * mentioned `SWITCHBOARD_STORE_CODEX` in its sessions-root helper while the home helper right above it
 * ignored it — a file-level check called that compliant, and an isolated run read the real `~/.codex`.
 * So the answer has to come from the same function that builds the path.
 */
function enclosingBlock(src, index) {
  const before = src.slice(0, index);
  const start = Math.max(
    before.lastIndexOf('\nfunction '),
    before.lastIndexOf('\nconst '),
    before.lastIndexOf('\n  function '),
  );
  const from = start === -1 ? 0 : start;
  const end = src.indexOf('\n}', index);
  return src.slice(from, end === -1 ? src.length : end);
}

test('NO file composes a CLI home without following that store override (#241, derived)', () => {
  const offenders = [];
  for (const file of walkJs(path.join(ROOT, 'src'))) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    if (EXEMPT.has(rel)) continue;
    for (const [envVar, pattern] of HOME_COMPOSERS) {
      const re = new RegExp(pattern.source, 'g');
      let match;
      while ((match = re.exec(src)) !== null) {
        if (enclosingBlock(src, match.index).includes(envVar)) continue;
        offenders.push(`${rel} composes a CLI home but never consults ${envVar}`);
        break;
      }
    }
  }
  assert.deepEqual(offenders, [],
    'an isolated (demo/sandbox) run would read the user\'s real store from these files. Follow the '
    + 'override, or add the file to EXEMPT with the reason it may not.');
});

test('the EXEMPT list does not outlive the files it excuses (#241)', () => {
  for (const rel of EXEMPT.keys()) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)),
      `${rel} is exempted from the isolation guard but no longer exists — drop the entry`);
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
