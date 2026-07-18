// scripts/demo-start.js — launch Switchboard against a permanent, ISOLATED demo environment.
//
// Everything the demo run touches lives under SWITCHBOARD_DEMO_DIR (default C:/temp/switchboard):
//   - its own switchboard.db          (SWITCHBOARD_DATA_DIR)
//   - its own Electron userData/cache  (SWITCHBOARD_USER_DATA)  -> its OWN single-instance lock, so the
//     demo coexists with a normal `npm start` dev run instead of being refused by it (#216/#220).
//   - all five backend store roots     (SWITCHBOARD_STORE_{CLAUDE,CODEX,PI,HERMES,AGY})
//
// So the demo never reads or writes ~/.claude, ~/.codex, ~/.pi, or the real ~/.switchboard / ~/.switchboard-dev.
//
// Pipeline mirrors `npm start`: gen-build-info → bundle CodeMirror → electron '.'. `--debug` mirrors
// `npm run start:debug` (checks the debug port first, then adds --remote-debugging-port=9222).
'use strict';

const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { seedDemo, resolveDemoDir } = require('./seed-demo');

const DEBUG = process.argv.slice(2).includes('--debug');
const DEBUG_PORT = 9222;

function main() {
  const demoDir = resolveDemoDir();

  // ── Resolve and set the seven isolation env vars (before anything requires db.js / boots Electron) ──
  const env = {
    SWITCHBOARD_DATA_DIR: path.join(demoDir, 'data'),
    SWITCHBOARD_USER_DATA: path.join(demoDir, 'userData'),
    SWITCHBOARD_STORE_CLAUDE: path.join(demoDir, 'stores', 'claude', 'projects'),
    SWITCHBOARD_STORE_CODEX: path.join(demoDir, 'stores', 'codex', 'sessions'),
    SWITCHBOARD_STORE_PI: path.join(demoDir, 'stores', 'pi'),
    SWITCHBOARD_STORE_HERMES: path.join(demoDir, 'stores', 'hermes'),
    SWITCHBOARD_STORE_AGY: path.join(demoDir, 'stores', 'agy'),
  };
  Object.assign(process.env, env);

  console.log(`\nSwitchboard DEMO — isolated environment under ${demoDir}`);
  console.log('  (no real data is touched — dedicated DB, userData, and all 5 store roots)\n');
  for (const [k, v] of Object.entries(env)) console.log(`  ${k.padEnd(24)} = ${v}`);
  console.log('');

  // ── Seed the demo stores (idempotent — never overwrites existing demo files) ──
  const { created, skipped } = seedDemo(demoDir);
  console.log(`  seed: ${created.length} file(s) created, ${skipped.length} kept\n`);

  // ── The start pipeline (same as `npm start`) ──
  if (DEBUG) {
    // Mirror start:debug — refuse if the debug port is already held (a leftover dev run answers there).
    try {
      execFileSync('node', [path.join(ROOT, 'scripts', 'check-debug-port.js')], { stdio: 'inherit', cwd: ROOT });
    } catch {
      process.exit(1); // check-debug-port already explained why
    }
  }

  execFileSync('node', [path.join(ROOT, 'scripts', 'gen-build-info.js')], { stdio: 'inherit', cwd: ROOT });

  // Bundle CodeMirror via esbuild's JS API — same flags as the `bundle:codemirror` npm script, without
  // shelling out to npm (no shell string interpolation).
  require('esbuild').buildSync({
    entryPoints: [path.join(ROOT, 'src', 'renderer', 'jsonl', 'codemirror-setup.js')],
    outfile: path.join(ROOT, 'src', 'renderer', 'codemirror-bundle.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    minify: true,
  });

  // ── Launch Electron. `require('electron')` resolves to the electron binary path. ──
  const electron = require('electron');
  const args = DEBUG ? [`--remote-debugging-port=${DEBUG_PORT}`, '.'] : ['.'];
  const child = spawn(electron, args, { stdio: 'inherit', cwd: ROOT, env: process.env });

  const forward = (sig) => { try { child.kill(sig); } catch { /* already gone */ } };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code == null ? 0 : code);
  });
}

main();
