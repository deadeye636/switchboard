// scripts/demo-auth.js — copy the CLI credentials you already have into the DEMO home, once (#241).
//
// Why this exists. `npm run demo:start` points each CLI at an isolated home (CLAUDE_CONFIG_DIR,
// CODEX_HOME, …) so a session launched from the demo writes its transcript into the demo store instead
// of the user's real one. The credentials live in that same home — so an isolated CLI starts out logged
// OUT, and a live demo session dies at the login prompt.
//
// Two ways round that. Log in once inside the demo home (works, costs a browser round-trip per backend
// and again after every demo reset), or copy the token you already have. This script is the second one,
// and it is a SEPARATE, explicit command on purpose: `demo:start` must never reach into the user's real
// credential files on its own.
//
//   npm run demo:auth          # copy what is there, report what is not
//   npm run demo:auth -- --force   # overwrite an existing demo credential file
//
// The copy is a snapshot. A refreshed/rotated token in the real home does not propagate, and an expired
// demo copy shows up as "please log in" — run this again. Nothing is ever copied the other way: the demo
// home is downstream of the real one, always.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveDemoDir } = require('./seed-demo');

const FORCE = process.argv.slice(2).includes('--force');

// What each backend keeps its credentials in, and where that file lives in a demo home.
//
// Only backends whose CLI home is actually relocated by the demo appear here:
//   - Pi's env var (PI_CODING_AGENT_SESSION_DIR) moves the SESSIONS dir alone — its config and login
//     stay in the real ~/.pi, so a demo run is authenticated already and there is nothing to copy.
//   - agy has no env var for its store at all, so the demo cannot isolate its writes (see its
//     descriptor's cliHomeEnv) and this script has nothing to do for it either.
// Both are listed as `nothing` so the report says so out loud rather than staying silent about them.
const BACKENDS = [
  {
    id: 'claude',
    // The demo's Claude home is the PARENT of its projects store (the same derivation the descriptor uses).
    demoHome: (demoDir) => path.join(demoDir, 'stores', 'claude'),
    realHome: () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    // `.credentials.json` is the token. `.claude.json` is deliberately NOT copied: it carries the user's
    // entire real project history, which would defeat the point of a clean demo — the CLI recreates it.
    files: ['.credentials.json'],
    // …but a config dir the CLI has never seen puts it in the FIRST-RUN WIZARD (theme, tips), so the
    // session sits on a prompt that is not Claude's prompt and never writes a transcript. Measured, not
    // assumed: that is exactly what the first live demo launch did. So mark onboarding done — three keys
    // read off a real install, written into the demo's OWN .claude.json, nothing else carried over.
    prime: primeClaudeConfig,
  },
  {
    id: 'codex',
    demoHome: (demoDir) => path.join(demoDir, 'stores', 'codex'),
    realHome: () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    files: ['auth.json'],
  },
  {
    id: 'hermes',
    demoHome: (demoDir) => path.join(demoDir, 'stores', 'hermes'),
    realHome: () => null,   // its credential file is not confirmed against a real install — do not guess
    files: [],
    nothing: 'no confirmed credential file — log in inside the demo home if it asks',
  },
  {
    id: 'pi',
    files: [],
    nothing: 'only its sessions dir is relocated, so it keeps the real login',
  },
  {
    id: 'agy',
    files: [],
    nothing: 'no store env var, so the demo cannot isolate it at all',
  },
];

// Mark Claude's first-run wizard as done in the DEMO config, so a live demo session lands on the real
// prompt. Merges into whatever is there (the CLI writes this file itself on first start) and never
// touches the user's own .claude.json.
function primeClaudeConfig(demoHome) {
  const file = path.join(demoHome, '.claude.json');
  let config = {};
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* absent or unreadable — start fresh */ }

  if (config.hasCompletedOnboarding === true) return null;   // already primed, or the CLI onboarded itself

  config.hasCompletedOnboarding = true;
  config.theme = config.theme || 'dark';
  fs.mkdirSync(demoHome, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return 'onboarding marked done in the demo .claude.json';
}

function copyCredentials(demoDir) {
  const report = [];

  for (const b of BACKENDS) {
    if (!b.files.length) {
      report.push({ id: b.id, state: 'skip', detail: b.nothing });
      continue;
    }
    const realHome = b.realHome();
    const demoHome = b.demoHome(demoDir);

    for (const name of b.files) {
      const src = realHome ? path.join(realHome, name) : null;
      const dest = path.join(demoHome, name);

      if (!src || !fs.existsSync(src)) {
        report.push({ id: b.id, state: 'missing', detail: `${name} not found in the real home — log in there first, or inside the demo home` });
        continue;
      }
      if (fs.existsSync(dest) && !FORCE) {
        report.push({ id: b.id, state: 'kept', detail: `${name} already in the demo home (--force to overwrite)` });
        continue;
      }
      fs.mkdirSync(demoHome, { recursive: true });
      fs.copyFileSync(src, dest);
      // Best-effort owner-only on the platforms that honour it. Windows ignores the mode; the demo dir
      // is a local scratch tree either way.
      try { fs.chmodSync(dest, 0o600); } catch { /* not supported here */ }
      report.push({ id: b.id, state: 'copied', detail: `${name} → demo home` });
    }

    if (typeof b.prime === 'function') {
      const primed = b.prime(demoHome);
      if (primed) report.push({ id: b.id, state: 'copied', detail: primed });
    }
  }
  return report;
}

function main() {
  const demoDir = resolveDemoDir();
  console.log(`\nSwitchboard DEMO — credentials into ${demoDir}\n`);

  const report = copyCredentials(demoDir);
  const mark = { copied: '  +', kept: '  =', missing: '  !', skip: '  -' };
  for (const r of report) console.log(`${mark[r.state] || '  ?'} ${r.id.padEnd(8)} ${r.detail}`);

  const copied = report.filter(r => r.state === 'copied').length;
  console.log(`\n  ${copied} file(s) copied. A copy is a snapshot — re-run this when a demo session says it is logged out.\n`);
}

if (require.main === module) main();

module.exports = { copyCredentials, BACKENDS };
