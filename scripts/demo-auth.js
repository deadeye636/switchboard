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
// Only backends whose CLI home is actually relocated by the demo appear here. agy has no env var for its
// store at all, so the demo cannot isolate its writes (see its descriptor's cliHomeEnv) and this script
// has nothing to do for it. It is listed as `nothing` so the report says so out loud rather than staying
// silent about it.
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
    // Hermes' home IS its install directory — `%LOCALAPPDATA%\hermes` holds `hermes-agent/venv` right
    // beside `state.db` — so an isolated home is emptier for it than for anyone else (#427).
    realHome: () => process.env.HERMES_HOME || (process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'hermes')
      : path.join(os.homedir(), '.hermes')),
    // MEASURED against a real install, keys only, never values: `auth.json` carries `version`,
    // `providers`, `credential_pool`, `updated_at` and `active_provider`.
    files: ['auth.json'],
    // …and Hermes WRITES that file itself on first start, minus `active_provider` — a shape that looks
    // like a credential and names nobody to talk to. Without this the copy would report "already there"
    // and leave the demo exactly as stuck as before (#427).
    supersedes: isUnusableHermesAuth,
    // What is deliberately left behind, stated where the next reader will look: `.env` is not
    // credentials (eleven tool-tuning assignments — TERMINAL_*, BROWSER_*, *_DEBUG), and `config.yaml`
    // is the user's own 64-key configuration, which is the same thing `.claude.json` is for Claude.
  },
  {
    id: 'pi',
    demoHome: (demoDir) => path.join(demoDir, 'stores', 'pi-agent'),
    realHome: () => process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'),
    files: ['auth.json'],
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

/**
 * Is the `auth.json` sitting in the demo home the one Hermes wrote for itself rather than a credential?
 *
 * Hermes creates the file on first start with the right shape and no `active_provider` — nothing is
 * chosen, so the session has nobody to talk to. Keyed on that field rather than on size or mtime,
 * because it is the one that decides, and unreadable-or-absent counts as unusable: the copy is the
 * safe answer either way.
 */
function isUnusableHermesAuth(destFile) {
  try {
    const auth = JSON.parse(fs.readFileSync(destFile, 'utf8'));
    return !auth || typeof auth.active_provider !== 'string' || !auth.active_provider;
  } catch {
    return true;
  }
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
      // A file that is already there is kept — unless the backend can tell that what is there is not a
      // credential at all. Without that, a CLI that writes its own empty one on first start makes this
      // script report success about a demo it left exactly as stuck as before (#427).
      const superseded = fs.existsSync(dest) && typeof b.supersedes === 'function' && b.supersedes(dest);
      if (fs.existsSync(dest) && !FORCE && !superseded) {
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
