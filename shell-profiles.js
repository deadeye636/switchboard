const path = require('path');
const fs = require('fs');

// --- Cross-platform shell resolution ---
const isWindows = process.platform === 'win32';

// WSL distro discovery must never block: `wsl.exe --list --quiet` can take
// seconds (VM cold start) and used to stall the first discoverShellProfiles()
// call for up to its 5 s timeout. Instead, an async warm-up probe (execFile)
// fills this cache; until it lands, discovery simply omits WSL profiles —
// they appear on the next getShellProfiles() call after the probe completes.
let _wslDistros = null; // null = probe not finished; [] = none / WSL unavailable
let _wslProbeStarted = false;
function startWslProbe() {
  if (_wslProbeStarted || !isWindows) return;
  _wslProbeStarted = true;
  const { execFile } = require('child_process');
  execFile('wsl.exe', ['--list', '--quiet'], { timeout: 5000, encoding: 'utf8', windowsHide: true }, (err, stdout) => {
    _wslDistros = err
      ? []
      : String(stdout || '').replace(/\0/g, '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    // Drop the memoized profile list so the next getShellProfiles() re-discovers
    // and picks up the WSL entries.
    if (_wslDistros.length > 0) _shellProfiles = null;
  });
}

// Discover available shell profiles on this system.
// Returns an array of { id, name, path, args? } objects.
function discoverShellProfiles() {
  const profiles = [];

  if (isWindows) {
    // CMD
    const comspec = process.env.COMSPEC || 'C:\\WINDOWS\\system32\\cmd.exe';
    if (fs.existsSync(comspec)) {
      profiles.push({ id: 'cmd', name: 'Command Prompt', path: comspec });
    }

    // PowerShell 7+ (pwsh)
    const pwshCandidates = [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7-preview', 'pwsh.exe'),
    ];
    for (const p of pwshCandidates) {
      if (fs.existsSync(p)) {
        profiles.push({ id: 'pwsh', name: 'PowerShell 7', path: p });
        break;
      }
    }

    // Windows PowerShell 5.x
    const ps5 = path.join(process.env.SystemRoot || 'C:\\WINDOWS', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (fs.existsSync(ps5)) {
      profiles.push({ id: 'powershell', name: 'Windows PowerShell', path: ps5 });
    }

    // Git Bash
    const gitBashCandidates = [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
    ];
    for (const p of gitBashCandidates) {
      if (p && fs.existsSync(p)) {
        profiles.push({ id: 'git-bash', name: 'Git Bash', path: p });
        break;
      }
    }

    // MSYS2
    if (fs.existsSync('C:\\msys64\\usr\\bin\\bash.exe')) {
      profiles.push({ id: 'msys2', name: 'MSYS2', path: 'C:\\msys64\\usr\\bin\\bash.exe' });
    }

    // WSL distributions — served from the async probe's cache; never blocks.
    if (_wslDistros === null) {
      startWslProbe();
    } else {
      for (const distro of _wslDistros) {
        profiles.push({ id: 'wsl:' + distro, name: 'WSL — ' + distro, path: 'wsl.exe', args: ['-d', distro] });
      }
    }
  } else {
    // macOS / Linux: read /etc/shells for the canonical list
    const seen = new Set();
    const shellNames = {
      'zsh': 'Zsh', 'bash': 'Bash', 'sh': 'POSIX Shell',
      'fish': 'Fish', 'nu': 'Nushell', 'pwsh': 'PowerShell',
      'dash': 'Dash', 'ksh': 'Korn Shell', 'tcsh': 'tcsh', 'csh': 'C Shell',
    };
    try {
      const lines = fs.readFileSync('/etc/shells', 'utf8').split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));
      for (const shellPath of lines) {
        if (!fs.existsSync(shellPath)) continue;
        const base = path.basename(shellPath);
        // Deduplicate by basename (e.g. /bin/bash and /usr/bin/bash)
        if (seen.has(base)) continue;
        seen.add(base);
        const name = shellNames[base] || base;
        profiles.push({ id: base, name, path: shellPath });
      }
    } catch {
      // Fallback if /etc/shells is unreadable
      for (const [id, name, p] of [
        ['zsh', 'Zsh', '/bin/zsh'],
        ['bash', 'Bash', '/bin/bash'],
        ['sh', 'POSIX Shell', '/bin/sh'],
      ]) {
        if (fs.existsSync(p)) {
          profiles.push({ id, name, path: p });
        }
      }
    }
  }

  return profiles;
}

// Cache profiles (discovered once on startup, refreshed via IPC if needed)
let _shellProfiles = null;
function getShellProfiles() {
  if (!_shellProfiles) _shellProfiles = discoverShellProfiles();
  return _shellProfiles;
}

// Drop the cached profiles so the next getShellProfiles() rediscovers — call
// after a shell may have been installed/removed. The cache is module-private,
// so an assignment from another module can't reach it (issue #76).
function invalidateShellProfiles() {
  _shellProfiles = null;
}

// Warm up the WSL cache at module load so the distros are usually known by the
// time the first profile consumer asks (no-op off Windows).
startWslProbe();

function resolveShell(profileId) {
  // If a profile is selected, use it
  if (profileId && profileId !== 'auto') {
    const profiles = getShellProfiles();
    const profile = profiles.find(p => p.id === profileId);
    if (profile && (profile.path === 'wsl.exe' || fs.existsSync(profile.path))) {
      return profile;
    }
  }

  // Auto: original detection logic
  // 1. Respect explicit SHELL env (set by Git Bash, MSYS2, WSL, etc.)
  if (process.env.SHELL && fs.existsSync(process.env.SHELL)) {
    return { id: 'auto', name: 'Auto', path: process.env.SHELL };
  }

  if (isWindows) {
    // 2. Look for Git Bash in common locations
    const candidates = [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
      'C:\\msys64\\usr\\bin\\bash.exe',
    ];
    for (const c of candidates) {
      if (c && fs.existsSync(c)) return { id: 'auto', name: 'Auto', path: c };
    }
    // 3. Fall back to PowerShell / cmd
    return { id: 'auto', name: 'Auto', path: process.env.COMSPEC || 'powershell.exe' };
  }

  // Unix fallback chain
  for (const s of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (fs.existsSync(s)) return { id: 'auto', name: 'Auto', path: s };
  }
  return { id: 'auto', name: 'Auto', path: '/bin/sh' };
}

// Convert a Windows path to a WSL /mnt/ path
function windowsToWslPath(winPath) {
  if (!winPath) return winPath;
  const normalized = winPath.replace(/\\/g, '/');
  // UNC paths (\\server\share) have no /mnt drive-letter mapping — WSL reaches
  // them via the same //server/share form, so pass them through unchanged rather
  // than mangling them into a bogus /mnt path (issue #76).
  if (normalized.startsWith('//')) return normalized;
  // C:\Users\foo → /mnt/c/Users/foo
  const match = normalized.match(/^([A-Za-z]):(\/.*)/);
  if (match) return '/mnt/' + match[1].toLowerCase() + match[2];
  return normalized;
}

function isWslShell(shellPath) {
  const base = path.basename(shellPath).toLowerCase();
  return base === 'wsl.exe' || base === 'wsl';
}

// Shell-quote one argv token per shell family
function quoteArgForShell(shellPath, value) {
  const s = value == null ? '' : String(value);
  const base = path.basename(shellPath).toLowerCase();
  const isBashLike = base.includes('bash') || base.includes('zsh') || base === 'sh' || base === 'dash' || base === 'ksh' || base === 'fish' || base === 'nu' || isWslShell(shellPath);
  const isPowerShell = base.includes('powershell') || base.includes('pwsh');

  if (isBashLike) {
    // POSIX: wrap in single quotes, escape embedded single quotes as '\''
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }
  if (isPowerShell) {
    // PowerShell: single-quoted string, escape ' as ''
    return "'" + s.replace(/'/g, "''") + "'";
  }
  // cmd.exe: quote only when the token needs it. The built command string is
  // passed to pty.spawn as an argv element and node-pty's argsToCommandLine
  // escapes any embedded `"` as `\"` — an escape cmd.exe does NOT understand —
  // so unnecessary quotes around plain tokens (--flags, UUIDs) arrive in the
  // child argv as literal quote characters; the Claude CLI then treats them as
  // a positional prompt instead of flags. Bare-safe tokens skip quoting.
  if (s !== '' && /^[A-Za-z0-9_\-.:\\/+@#~=]+$/.test(s)) return s;
  // Otherwise wrap in double quotes and double any embedded quote ("" is cmd's
  // in-quote escape; \" is NOT). Inside quotes cmd already treats & | < > ^ ( )
  // literally, so do NOT ^-escape them — the old code injected a stray caret
  // (a&b arrived as a^&b). NOTE: cmd still expands %VAR% even inside quotes and
  // there is no reliable command-line escape for %, so a value containing %NAME%
  // for a defined env var can expand — callers must avoid feeding untrusted %
  // to a cmd.exe shell (this path is only hit when the resolved shell is cmd.exe,
  // i.e. the COMSPEC fallback or an explicit cmd config) (issue #76). Values
  // that DO need quotes (embedded spaces) still collide with node-pty's \"
  // escaping — a known residual limitation of the cmd fallback path.
  const escaped = s.replace(/"/g, '""');
  return '"' + escaped + '"';
}

function quoteArgvForShell(shellPath, argv) {
  return argv.map(a => quoteArgForShell(shellPath, a)).join(' ');
}

// Returns spawn args appropriate for the resolved shell
function shellArgs(shellPath, cmd, extraArgs) {
  const base = path.basename(shellPath).toLowerCase();
  const isBashLike = base.includes('bash') || base.includes('zsh') || base === 'sh';
  const isFish = base === 'fish';
  const isNushell = base === 'nu';

  // WSL: pass command via -- to the distribution shell
  // cwd is handled separately via --cd in the spawn call
  if (isWslShell(shellPath)) {
    if (cmd) return [...(extraArgs || []), '--', 'bash', '-l', '-i', '-c', cmd];
    return [...(extraArgs || []), '--', 'bash', '-l', '-i'];
  }

  if (cmd) {
    if (isBashLike) return ['-l', '-i', '-c', cmd];
    if (isFish) return ['-l', '-c', cmd];
    if (isNushell) return ['-l', '-c', cmd];
    if (base.includes('powershell') || base.includes('pwsh')) return ['-NoLogo', '-Command', cmd];
    return ['/C', cmd];
  }
  if (isBashLike) return ['-l', '-i'];
  if (isFish) return ['-l', '-i'];
  if (isNushell) return ['-l', '-i'];
  if (base.includes('powershell') || base.includes('pwsh')) return ['-NoLogo', '-NoExit'];
  return [];
}

module.exports = { discoverShellProfiles, getShellProfiles, invalidateShellProfiles, resolveShell, isWindows, isWslShell, windowsToWslPath, shellArgs, quoteArgForShell, quoteArgvForShell };
