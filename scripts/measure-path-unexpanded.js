#!/usr/bin/env node
// scripts/measure-path-unexpanded.js — does a process search a PATH entry that still holds a `%NAME%`? (#793)
//
// The static MCP check (src/app/path-resolve.js) skips such an entry and reports `unexpanded-path-entry` instead of
// "not found on PATH". Whether a miss there may count as evidence depends on what the LAUNCH does with the entry, and
// this script measures that for a Node spawn (libuv `search_path`, what the Node-based CLIs use). Spec 36 records the
// answer under "#793, decided". Re-run it on a new Node or Electron version, or when that decision is questioned.
//
// Windows only. It builds a temporary folder holding a literal `%ZZPROBE%\bin`, copies the system's hostname.exe
// there as zzprobe.exe, spawns `zzprobe` with PATH set to `%ZZPROBE%\bin` from two working directories, prints
// whether each ran, and removes the folder. It prints no path and no variable value.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

if (process.platform !== 'win32') {
  console.log('Windows only: %NAME% is not a PATH syntax elsewhere.');
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-path793-'));
try {
  const holder = path.join(root, 'holder');
  const literal = path.join(holder, '%ZZPROBE%', 'bin');
  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(literal, { recursive: true });
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'hostname.exe'), path.join(literal, 'zzprobe.exe'));

  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH'));
  env.PATH = '%ZZPROBE%\\bin';
  const run = (label, cwd) => {
    const r = spawnSync('zzprobe', [], { cwd, env, encoding: 'utf8', windowsHide: true });
    console.log(`${label}: ${r.error ? 'not found (' + r.error.code + ')' : 'ran (exit ' + r.status + ')'}`);
  };
  console.log(`node ${process.version}`);
  run('cwd holds the literal %ZZPROBE% folder', holder);
  run('cwd does not', elsewhere);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
