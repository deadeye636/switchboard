// Measure which `entrypoint` a Claude fork carries on the lines it copies from its parent (#670). It runs two
// one-line `claude -p` turns: a parent with the entrypoint claude-native sets (`CLAUDE_CODE_ENTRYPOINT=
// sdk-switchboard`), then a fork of it (`--resume <parent> --fork-session`) started the plain way. It prints,
// for each transcript, how many lines carry which type and entrypoint. Counts only: nothing it prints names a
// path or the conversation. It costs two short model turns.
//
// Usage: node scripts/measure-claude-fork-marker.js <cwd> [<model>]
//   <cwd>    a scratch directory the sessions run in (created if missing), e.g. a demo project.
//   <model>  defaults to `haiku`.
// The transcripts are read from `$CLAUDE_CONFIG_DIR/projects` when that is set, else `~/.claude/projects`. Run it
// against the demo home (`CLAUDE_CONFIG_DIR=<demo>/stores/claude`) unless the real one is what you mean to measure.
// The last measurement is in `docs/specs/32-claude-native.md` ("Who owns a row", point 6).
'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cwd = process.argv[2];
if (!cwd) {
  console.error('usage: node scripts/measure-claude-fork-marker.js <cwd> [<model>]');
  process.exit(2);
}
const model = process.argv[3] || 'haiku';
fs.mkdirSync(cwd, { recursive: true });
const projectsRoot = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');

// A CLI started from inside a Claude session inherits its markers and then writes no transcript
// (docs/ai/driving-the-app.md, "Measuring a CLI outside the app").
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE' && !k.startsWith('CLAUDE_CODE_')));

function turn(args, extraEnv) {
  execFileSync('claude', ['-p', ...args, '--model', model], {
    cwd, env: { ...baseEnv, ...extraEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000,
  });
}

function transcriptOf(id) {
  for (const dir of fs.readdirSync(projectsRoot)) {
    const file = path.join(projectsRoot, dir, `${id}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function countLines(file) {
  const counts = {};
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    let e;
    try { e = JSON.parse(raw); } catch { continue; }
    const key = `${e.type || '?'} entrypoint=${e.entrypoint || '-'}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

const parent = crypto.randomUUID();
turn(['Reply with the single word: parent', '--session-id', parent], { CLAUDE_CODE_ENTRYPOINT: 'sdk-switchboard' });
const fork = crypto.randomUUID();
turn(['Reply with the single word: fork', '--resume', parent, '--fork-session', '--session-id', fork], {});

const parentFile = transcriptOf(parent);
const forkFile = transcriptOf(fork);
console.log(JSON.stringify({ parent: parentFile ? countLines(parentFile) : 'no transcript' }));
console.log(JSON.stringify({ fork: forkFile ? countLines(forkFile) : 'no transcript' }));
console.log(`Session ids, to delete the two transcripts afterwards: ${parent} ${fork}`);
