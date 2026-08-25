#!/usr/bin/env node
'use strict';
// Every path a rule or a spec names in backticks must still exist.
//
// This exists because three counters and a claim went stale at once and nothing failed: renderer.md
// said the backend-id guard ran over "eleven renderer files" while ALLOWED_BINDINGS held 45, the
// src/app enumerations omitted two modules for as long as those modules existed, and spec 09 called
// #211 open in one paragraph and closed in another. A prose claim is not a guard — so guard the half
// of it a machine can check: the paths.
//
// Run it on its own (`node scripts/check-doc-refs.js`) or through `test/doc-refs.test.js`.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Where a stale path costs the most: the files an agent is told to trust.
const SCANNED = [
  'CLAUDE.md',
  'README.md',
  '.claude/rules',
  'docs',
];

// A backticked token is a candidate only when it starts here. Anything else is a CLI flag, an env
// var, a symbol name or another project's tree (VS Code's `vs/base/...`), and guessing at those is
// how a guard starts reporting noise nobody reads.
const REPO_ROOTS = ['src/', 'test/', 'scripts/', 'docs/', 'build/', '.claude/'];

// Generated, built or deliberately local — absent from a fresh clone, so their absence is not drift.
// This list is what tells a CI checkout apart from a working one: every entry below exists here after
// a build or a first run and in no fresh clone, so leaving one out fails only on the runner, where the
// author never looks. That is exactly how the three at the bottom got in.
const NOT_ON_DISK = [
  'docs/BACKLOG.md',
  'docs/BACKLOG.jsonl',
  'docs/plans/',
  '.claude/scratchpad',   // written with and without its trailing slash; the prefix match needs the shorter one
  '.claude/worktrees',
  'build/Release',
  'src/renderer/codemirror-bundle.js',  // esbuild writes it on every start; gitignored
  '.claude/settings.local.json',        // a checkout's own harness settings, never committed
];

// `docs/plans/**` is gitignored planning scaffolding: it is written against a tree that does not
// exist yet, so a path it names being absent is what it is FOR.
const SKIP_DIRS = ['docs/plans'];

// A doc may name a path that is gone ON PURPOSE — a removal record, a plan option that was not taken,
// another tool's file. The opt-out is keyed by the DOC that makes the claim, not by the path, so the
// same dead path named anywhere else still fails. Every entry states its reason: a list without one
// is how a guard turns into a place to silence findings.
const DELIBERATE = {
  'CLAUDE.md': {
    'docs/ROADMAP.md': 'the pre-migration backlog, named as history — the board is GitHub Issues now',
  },
  'docs/specs/02-next-attention-hotkey.md': {
    'src/renderer/sounds/attention.mp3': 'a plan option ("or synthesize a tone") — the tone won, no asset shipped',
  },
  'docs/specs/04-one-click-handoff.md': {
    'test/handoff-flow.test.js': 'conditional on a pure module that was not added; the shipped tests are test/handoff-{actions,extract,prompt,submit}.test.js',
  },
  // Same for the rule and the lesson that explain why the core does not spell that directory: the string
  // is a path inside somebody else's project, named in order to say it does NOT belong here.
  '.claude/rules/backends.md': {
    '.claude/handoffs': "a directory inside a USER's project, where Claude's handoff skills write",
  },
  'docs/ai/lessons.md': {
    '.claude/handoffs': 'ditto — the literal the neutrality guard refused in the core',
  },
  // The handoff convention names directories in the USER's project, not paths in this repo. They read as
  // repo paths to this guard because their prefixes exist here; the trailing slash is the tell that they
  // are directories somebody else keeps.
  'docs/handoffs-convention.md': {
    'docs/handoffs/': "a directory name in the reader's own project, not a path in this repo",
    '.claude/handoffs/': "ditto — where Claude's handoff skills write inside a user's project",
  },
  'docs/specs/25-handoffs.md': {
    'docs/handoffs/': "a directory name in the reader's own project, not a path in this repo",
    '.claude/handoffs/': "ditto — where Claude's handoff skills write inside a user's project",
  },
  'docs/specs/05-hook-attention-detection.md': {
    'src/servers/schedule-runner.js': 'named as removed with the scheduler (#246) — spec 14 is the record',
  },
  'docs/specs/07-session-groups.md': {
    'test/groups-model.test.js': 'the plan of a feature removed in #185; tags replaced it',
  },
  'docs/specs/14-scheduled-tasks.md': {
    'src/servers/schedule-runner.js': 'this spec IS the removal record (#246)',
    'src/servers/schedule-ipc.js': 'ditto',
    'test/schedule-injection.test.js': 'ditto — its shell-quoting tests moved, the file did not survive',
  },
};

function listMarkdown(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  if (SKIP_DIRS.includes(rel)) return [];
  if (fs.statSync(abs).isFile()) return rel.endsWith('.md') ? [rel] : [];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listMarkdown(child));
    else if (entry.name.endsWith('.md')) out.push(child);
  }
  return out;
}

function isCandidate(token) {
  if (!REPO_ROOTS.some((r) => token.startsWith(r))) return false;
  if (!/^[A-Za-z0-9_.\-/]+$/.test(token)) return false;  // a glob, a $VAR, a sentence
  if (token.includes('..')) return false;
  if (NOT_ON_DISK.some((p) => token === p || token.startsWith(p))) return false;
  return true;
}

// A directory reference may be written with or without its trailing slash.
function exists(token) {
  const abs = path.join(ROOT, token);
  if (fs.existsSync(abs)) return true;
  return token.endsWith('/') && fs.existsSync(abs.slice(0, -1));
}

function collect() {
  const misses = [];
  const files = SCANNED.flatMap(listMarkdown);
  for (const rel of files) {
    const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/`([^`\n]+)`/g)) {
        const token = m[1].trim();
        if (!isCandidate(token) || exists(token)) continue;
        if (DELIBERATE[rel] && DELIBERATE[rel][token]) continue;
        misses.push({ file: rel, line: i + 1, token });
      }
    });
  }
  // An exemption whose path came BACK is the list rotting: it would silence a real finding the next
  // time that path is deleted. Report it rather than letting it sit.
  const staleExemptions = [];
  for (const [file, tokens] of Object.entries(DELIBERATE)) {
    for (const token of Object.keys(tokens)) {
      if (exists(token)) staleExemptions.push({ file, token });
    }
  }

  return { misses, staleExemptions, scanned: files.length };
}

module.exports = { collect };

if (require.main === module) {
  const { misses, staleExemptions, scanned } = collect();
  for (const m of misses) console.error(`${m.file}:${m.line}  ${m.token}`);
  for (const s of staleExemptions) {
    console.error(`${s.file}: exemption for ${s.token} is unnecessary — the path exists again`);
  }
  const label = `${scanned} markdown files`;
  if (misses.length || staleExemptions.length) {
    console.error(`\n${misses.length + staleExemptions.length} problem(s) across ${label}.`);
    process.exit(1);
  }
  console.log(`Every path named in ${label} exists.`);
}
