// Which ways of starting a program run a repository's own executable? Windows only.
//
//   node_modules/electron/dist/electron scripts/measure-planted-exe.js   (with ELECTRON_RUN_AS_NODE=1)
//
// Windows looks a bare name up in the child's working directory before PATH, unless
// NoDefaultCurrentDirectoryInExePath is set, which an agent harness's shell may do, so it is unset here. The planted
// file is a copy of whoami.exe in a temp repository: it prints a name and refuses arguments, so a real git, whose
// --version exits 0 with its version, cannot be mistaken for it.
'use strict';
const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
delete process.env.NoDefaultCurrentDirectoryInExePath;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-planted-'));
execFileSync('git', ['init', '-q', dir]);
const whoami = path.join(process.env.SystemRoot, 'System32', 'whoami.exe');
for (const name of ['git.exe', 'probe.exe']) fs.copyFileSync(whoami, path.join(dir, name));

const run = (file, args) => new Promise((resolve) => {
  execFile(file, args, { cwd: dir, windowsHide: true, timeout: 8000 }, (err, stdout) => {
    if (!err) resolve(/^git version/.test(stdout) ? 'the real git' : 'the planted file');
    else resolve(err.code === 'ENOENT' ? 'nothing (not found)' : 'the planted file (it refused the argument)');
  });
});

(async () => {
  console.log('execFile, a bare name found nowhere else:', await run('probe', []));
  console.log('execFile, bare git:', await run('git', ['--version']));
  const provider = require(path.join(root, 'src', 'vcs', 'git.js'));
  console.log('execFile, provider.bin:', await run(provider.bin, ['--version']));
  const pty = require(path.join(root, 'node_modules', 'node-pty'));
  try {
    pty.spawn('probe.exe', [], { cwd: dir, cols: 80, rows: 10 }).kill();
    console.log('node-pty, a bare name: started something');
  } catch {
    console.log('node-pty, a bare name: refused, it does not search the working directory');
  }
  setTimeout(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the OS cleans temp */ }
    process.exit(0);
  }, 500);
})();
