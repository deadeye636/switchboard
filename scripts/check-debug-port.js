// Refuse to start `start:debug` when the debug port is already taken (#220).
//
// This is the failure that actually misleads. Electron does not fail when it cannot bind
// `--remote-debugging-port`: it starts anyway, without a debug port. So the port keeps belonging to
// whatever bound it first — typically a dev run whose launcher was killed and whose Electron processes are
// still alive. `scripts/drive-app.js` then connects to THAT process and reports on code that is no longer
// on disk. Nothing on screen says so, and the result reads exactly like a passing verification.
//
// The single-instance lock (#220's main half) does not cover this on its own. It makes the leftover run
// WIN — the new launch is refused and quits — so without this check the next drive-app.js still talks to
// the corpse, just more reliably.
//
// Best-effort by design: this only ever refuses when something answers on the port. If the probe itself is
// broken the launch proceeds, because a debug convenience must not be what stops the app from starting.
//
// The default matches the hardcoded `--remote-debugging-port=9222` in package.json's `start:debug` and the
// default in `scripts/drive-app.js`. Changing it in one place means changing it in all three.
const PORT = Number(process.env.SWITCHBOARD_DEBUG_PORT || 9222);
const TIMEOUT_MS = 1500;

async function describeHolder() {
  // A Chromium debug port answers /json/version. Anything else on the port is still a blocker, just not
  // one we can name.
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const info = await res.json();
    return info['User-Agent'] || info.Browser || null;
  } catch {
    return null;
  }
}

async function isBound() {
  const net = require('net');
  return new Promise((resolve) => {
    const socket = net.connect({ port: PORT, host: '127.0.0.1' });
    const done = (bound) => {
      socket.destroy();
      resolve(bound);
    };
    socket.setTimeout(TIMEOUT_MS);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));  // ECONNREFUSED = free, which is the good case
  });
}

async function main() {
  if (!(await isBound())) return;

  const holder = await describeHolder();
  console.error(`\n  Debug port ${PORT} is already in use${holder ? ` by: ${holder}` : ''}.`);
  console.error('');
  console.error('  Electron would start anyway WITHOUT a debug port, and scripts/drive-app.js would then');
  console.error('  attach to whatever is already on that port — reporting on code that may not be the code');
  console.error('  you just changed. That reads as a passing check and is not one, so this refuses instead.');
  console.error('');
  console.error('  Most likely a dev run whose launcher was stopped but whose Electron is still alive.');
  console.error('  Find it — and stop ONLY it. Never kill every electron.exe: the installed app is one too.');
  console.error('');
  console.error('    Windows:  Get-CimInstance Win32_Process -Filter "Name=\'electron.exe\'" |');
  console.error('                Where-Object { $_.ExecutablePath -like "*\\node_modules\\electron\\dist\\*" } |');
  console.error('                ForEach-Object { Stop-Process -Id $_.ProcessId -Force }');
  console.error('    macOS/Linux:  pkill -f "node_modules/electron/dist"');
  console.error('');
  process.exit(1);
}

main().catch(() => { /* never block a launch over a failed probe */ });
