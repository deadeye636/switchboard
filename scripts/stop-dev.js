// Stop THIS checkout's dev Electron run — and nothing else (#220).
//
// A dev run whose launcher was killed (a stopped `npm run start:debug`, a closed terminal, an agent's
// background task) leaves its Electron processes alive with no window. They hold the single-instance lock,
// so your next `npm start` is refused, and they hold `--remote-debugging-port=9222`, so the next
// `scripts/drive-app.js` attaches to THEM and reports on code that is no longer on disk.
//
// THE FILTER IS THE WHOLE POINT. It matches only executables under THIS repo's node_modules, so:
//   - the user's INSTALLED Switchboard is never touched (it lives in Program Files / AppData),
//   - another checkout's dev run is never touched either.
// A blanket `taskkill /IM electron.exe` or `pkill electron` takes the installed app down with it. Do not.
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEV_ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist');

function findWindows() {
  // Try PowerShell 7 first, fall back to Windows PowerShell — one of the two is always there.
  // The root goes in through the environment, not the command string: a path with a space or a quote in it
  // would otherwise be a command-injection waiting to happen.
  const script =
    'Get-CimInstance Win32_Process -Filter "Name=\'electron.exe\'" | ' +
    'Where-Object { $_.ExecutablePath -like ($env:SB_DEV_DIST + "*") } | ' +
    'ForEach-Object { $_.ProcessId }';
  for (const exe of ['pwsh', 'powershell']) {
    try {
      const out = execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        env: { ...process.env, SB_DEV_DIST: DEV_ELECTRON },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(Number).filter(Number.isFinite);
    } catch { /* try the next one */ }
  }
  throw new Error('could not run PowerShell to list processes');
}

function findPosix() {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8' });
  return out.split('\n')
    .map(l => l.trim())
    .filter(l => l.includes(DEV_ELECTRON) || l.includes(path.join('node_modules', 'electron', 'dist')))
    // Only this checkout: the relative-path fallback above could match a sibling clone.
    .filter(l => l.includes(ROOT) || l.includes(DEV_ELECTRON))
    .map(l => Number(l.split(/\s+/)[0]))
    .filter(Number.isFinite);
}

function main() {
  let pids;
  try {
    pids = process.platform === 'win32' ? findWindows() : findPosix();
  } catch (err) {
    console.error(`Could not list processes: ${err.message}`);
    process.exit(1);
  }

  // Never stop ourselves, whatever the filter says.
  pids = pids.filter(pid => pid !== process.pid);

  if (!pids.length) {
    console.log('No dev Electron run from this checkout is alive. Nothing to stop.');
    return;
  }

  let stopped = 0;
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
      stopped++;
    } catch (err) {
      // ESRCH: it exited between listing and killing — that is the outcome we wanted anyway.
      if (err.code !== 'ESRCH') console.error(`  pid ${pid}: ${err.message}`);
    }
  }
  console.log(`Stopped ${stopped} dev Electron process${stopped === 1 ? '' : 'es'} from ${ROOT}.`);
  console.log('The installed Switchboard and any other checkout were not touched.');
}

main();
