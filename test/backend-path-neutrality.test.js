'use strict';
// #227 — a hardcoded per-backend PATH is a backend id the id-hunt cannot see.
//
// test/backend-integrations.test.js hunts backend *ids* (`backendId === 'codex'`, `|| 'claude'`, tables
// keyed by id). A hardcoded `~/.claude` — or `~/.codex`, `~/.pi`, `~/.gemini` — is none of those: it is the
// same "the core knows one backend's shape" defect wearing something the id-hunt does not look at, which is
// exactly how the Plans/Memory tabs stayed pinned to Claude's home through #161, #212 and #225.
//
// So this guard is the id-hunt's twin for paths: each backend's own store tokens (its dot-dir, its config
// file, its store env var) may appear ONLY under that backend's own folder (src/backends/<id>/**). Anywhere
// else in src/ is a hole unless it is on the allow-list below WITH a reason. The list is checked BOTH ways —
// an allow-list entry whose file no longer contains the token is stale and fails, so the list shrinks as the
// code gets cleaner, the same discipline as main-no-new-ipc's GRANDFATHERED.
//
// The tree is walked at test time (not a fixed file map): a NEW file is covered by default, because a path
// hides in any file — the opposite trade-off from ALLOWED_BINDINGS, and the right one for paths.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

// Strip block comments AND line/trailing comments — a path token in a comment (this file's neighbours are
// full of "~/.claude" prose) is not a hardcoded path, only a mention. A real violation sits in code before
// any `//`, so removing everything from `//` to EOL keeps it while dropping the prose.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
}

// Each backend's OWN store tokens: its dot-dir / config file (as a quoted or slash-bounded path segment)
// and its store env var. These are legal only under src/backends/<id>/**.
const TOKENS = {
  // `subagents` is Claude's on-disk LAYOUT (<folder>/<parent>/subagents/agent-<id>.jsonl), not its store
  // root — and it hid from this guard for exactly that reason while the core walked it directly (#235).
  // Since the subagent seam (listSubagents / subagentMeta / subagentSessionId) the layout is Claude's
  // alone, so the literal belongs in its folder like any other store token.
  claude: [/['"`\\/]\.claude(\.json)?['"`\\/]/, /\bCLAUDE_CONFIG_DIR\b/, /['"`\\/]subagents['"`\\/]/],
  codex:  [/['"`\\/]\.codex['"`\\/]/, /\bCODEX_HOME\b/],
  pi:     [/['"`\\/]\.pi['"`\\/]/, /\bPI_CODING_AGENT_SESSION_DIR\b/],
  hermes: [/['"`\\/]\.hermes['"`\\/]/, /\bHERMES_HOME\b/],
  agy:    [/['"`\\/]\.gemini['"`\\/]/, /['"`]antigravity-cli['"`]/],
};

// file (repo-relative, forward slash) -> reason it may name a backend's path outside that backend's folder.
// Checked both ways: a file here that no longer trips a token is stale and fails. Shrinking it is the goal.
const ALLOWLIST = {
  // Claude's projects store root, injected into session-cache / the index worker / spawn / transitions since
  // Phase 1. Retiring it in favour of a descriptor watchTargets() is its own issue, not #227's.
  'src/main.js': 'PROJECTS_DIR = ~/.claude/projects, the injected Claude store root (retire is its own issue)',
  // The Claude CLI's on-disk worktree layout, parsed out of paths the CLI itself created. (Only the files
  // that spell it as a string segment trip the token; derive-project-path.js writes it as a regex the
  // token deliberately does not match, so it is not listed — a real '.claude' store literal there would
  // still trip and need adding.)
  'src/renderer/shell/sidebar.js': "parses the CLI's own .claude/worktrees on-disk layout",
  'src/renderer/session/session-card-details.js': "parses the CLI's own .claude/worktrees on-disk layout",
  // The MCP IDE bridge emulates Claude's own ~/.claude/ide discovery protocol.
  'src/servers/mcp-bridge.js': "emulates Claude's ~/.claude/ide IDE-discovery protocol",
  // The attention hook is Claude's own declared integration; it patches ~/.claude/settings.json.
  'src/app/hooks.js': "patches Claude's own ~/.claude/settings.json (Claude's declared integration)",
  // Switchboard's OWN legacy data locations under ~/.claude (its old DB home, and the pre-multi-LLM store
  // path a shipped migration reads) — not a live Claude store access, and append-only migration history.
  'src/db/connection.js': "one-time migration of Switchboard's own legacy ~/.claude/browser DB location",
  'src/db/migrations.js': 'a shipped (append-only) migration that reads the pre-multi-LLM ~/.claude/projects store',
  // Project-path derivation reads a transcript to learn its cwd, and a subagent file is the only one it
  // can find for a session whose parent it has not seen. It walks the STORE it was handed, not a path it
  // composed from a backend id — the layout knowledge is the last of it, and retiring it means teaching
  // discovery to hand back the file, which is #211's territory, not #235's.
  'src/session/derive-project-path.js': "walks Claude's subagents/ layout to find any transcript in a folder",
};

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.isFile() && e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const rel = (abs) => path.relative(ROOT, abs).replace(/\\/g, '/');

// Is `relPath` inside src/backends/<id>/ (where that backend's own tokens are legal)?
const underBackend = (relPath, id) => relPath.startsWith(`src/backends/${id}/`);

test('no backend keeps a hardcoded store path outside its own folder', () => {
  const offenders = [];
  const tripped = new Set(); // allow-list files that actually tripped a token (for the stale check)

  for (const abs of walk(SRC)) {
    const relPath = rel(abs);
    const code = stripComments(fs.readFileSync(abs, 'utf8'));
    for (const [id, patterns] of Object.entries(TOKENS)) {
      if (underBackend(relPath, id)) continue;        // its own folder — legal
      if (!patterns.some(p => p.test(code))) continue;
      if (ALLOWLIST[relPath]) { tripped.add(relPath); continue; }
      offenders.push(`${relPath} names ${id}'s store path`);
    }
  }

  assert.deepEqual(offenders, [],
    `hardcoded per-backend path(s) outside a backend's own folder:\n  ${offenders.join('\n  ')}\n\n` +
    'Where a backend keeps its store/plans/memory is a DECLARED capability (plansDir/memorySources/root),\n' +
    'not a ~/.claude literal in the core. Move it behind the descriptor, or — if it is genuinely that\n' +
    "backend's own concern living elsewhere — add the file to ALLOWLIST in this test WITH a reason.");

  const stale = Object.keys(ALLOWLIST).filter(f => !tripped.has(f)).sort();
  assert.deepEqual(stale, [],
    `these files are on this test's ALLOWLIST but no longer contain a backend path token: ${stale.join(', ')}\n` +
    'Delete those lines — a stale entry would let a hardcoded path be written back into that file and pass.');
});
