#!/usr/bin/env node
// scripts/io-sample.js — what the app asks of the disk, per process, over time. Windows only.
//
//   node scripts/io-sample.js --minutes=15                    sample every 30 s
//   node scripts/io-sample.js report <file.jsonl>             rates per process, and the totals
//
// Windows keeps per-process I/O counters, and the interesting one is neither read nor write: METADATA
// calls — a statSync, an opendir, and also a named-pipe control operation — land in the OTHER bucket.
// A directory walk shows up there and nowhere else, which is why a scan storm can be invisible in
// throughput and obvious here.
//
// Two things this measurement taught, both easy to get wrong:
//
//   - **A syscall is not an operation.** One `statSync` on NTFS is a CreateFile plus a query plus a
//     CloseHandle: measured at 4.1 kernel operations per syscall on a real store walk. Converting a
//     syscall count into expected I/O without that factor lands five times too low.
//   - **Other-ops are not proof of filesystem work.** A terminal relaying PTY output through a conpty pipe
//     produces them at the same rate a directory walk does. An idle instance sitting at 1383 ops/s looked
//     like a scan storm and was terminal traffic — the app doing its job. Confirm with a process that has
//     no terminals before blaming the filesystem.
//
// Options: --interval=<seconds> (default 30), --minutes=<n> (default: until killed), --out=<file>
// (default .claude/scratchpad/io-<timestamp>.jsonl, gitignored), --name=<process image>
// (default Switchboard.exe; use electron.exe for a dev run).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const mode = args[0] === 'report' ? 'report' : 'sample';
const imageName = flag('name', 'Switchboard.exe');
const intervalMs = Number(flag('interval', 30)) * 1000;
const minutes = Number(flag('minutes', 0));
const outFile = flag('out', path.join('.claude', 'scratchpad',
  `io-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`));

// One query per tick. The process TYPE comes from the Chromium `--type=` switch, so a renderer can be told
// from the main process without guessing by pid order.
const QUERY = (name) => `Get-CimInstance Win32_Process -Filter "Name='${name}'" | ForEach-Object { $t='main'; if ($_.CommandLine -match '--type=([a-z-]+)') { $t=$Matches[1] }; '{0},{1},{2},{3},{4},{5},{6}' -f $_.ProcessId,$t,$_.ReadOperationCount,$_.ReadTransferCount,$_.WriteOperationCount,$_.WriteTransferCount,$_.OtherOperationCount }`;

function sample() {
  const text = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', QUERY(imageName)], { encoding: 'utf8' });
  const procs = [];
  for (const line of text.trim().split('\n')) {
    const p = line.trim().split(',');
    if (p.length !== 7) continue;
    procs.push({
      pid: Number(p[0]), type: p[1],
      readOps: Number(p[2]), readBytes: Number(p[3]),
      writeOps: Number(p[4]), writeBytes: Number(p[5]),
      otherOps: Number(p[6]),
    });
  }
  return procs;
}

function report(file) {
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse).filter(r => r.procs && r.procs.length);
  if (rows.length < 2) { console.log(`${file}: ${rows.length} sample(s) — nothing to compare yet`); return; }
  const first = rows[0], last = rows[rows.length - 1];
  const seconds = (Date.parse(last.at) - Date.parse(first.at)) / 1000;
  const before = new Map(first.procs.map(p => [p.pid, p]));
  const kb = (b) => (b / 1024).toFixed(0);
  console.log(`${rows.length} samples over ${(seconds / 60).toFixed(1)} min`);
  let totalOther = 0;
  for (const p of last.procs) {
    const a = before.get(p.pid);
    if (!a) continue;
    const rate = (k) => (p[k] - a[k]) / seconds;
    totalOther += rate('otherOps');
    console.log(`  ${p.type.padEnd(12)} other ${rate('otherOps').toFixed(0).padStart(6)}/s   `
      + `read ${rate('readOps').toFixed(0).padStart(5)}/s ${kb(rate('readBytes')).padStart(6)} KB/s   `
      + `write ${rate('writeOps').toFixed(0).padStart(5)}/s ${kb(rate('writeBytes')).padStart(6)} KB/s`);
  }
  console.log(`  metadata operations across the tree: ${totalOther.toFixed(0)}/s = ${(totalOther * 60).toFixed(0)}/min`);
  console.log('  read the BYTES next to them: high ops with low bytes is cache-served metadata, not disk load');
}

if (mode === 'report') {
  const file = args[1];
  if (!file) { console.error('usage: io-sample.js report <file.jsonl>'); process.exit(1); }
  report(file);
} else {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const deadline = minutes ? Date.now() + minutes * 60000 : Infinity;
  const tick = () => {
    try {
      fs.appendFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), procs: sample() }) + '\n');
    } catch (err) {
      fs.appendFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), error: String(err.message).slice(0, 200) }) + '\n');
    }
    if (Date.now() >= deadline) { console.log('done'); process.exit(0); }
  };
  console.log(`sampling ${imageName} every ${intervalMs / 1000}s${minutes ? ` for ${minutes} min` : ''} into ${outFile}`);
  tick();
  setInterval(tick, intervalMs);
}
