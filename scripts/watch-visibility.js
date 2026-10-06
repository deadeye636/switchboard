#!/usr/bin/env node
'use strict';
// Prints the running instance's `document.visibilityState` about once a second, read from OUTSIDE the page
// (#723). An in-page loop would be throttled in exactly the state it is meant to watch.
//
//   node scripts/watch-visibility.js [--seconds=25]
//
// Use it beside `scripts/cover-window.ps1` to see when a covered window turns `hidden` (measured: about six
// seconds after it is covered — `docs/ai/driving-the-app.md`).
const path = require('path');
const { execFileSync } = require('child_process');

const arg = process.argv.slice(2).find(a => a.startsWith('--seconds='));
const seconds = arg ? Number(arg.slice('--seconds='.length)) : 25;
const t0 = Date.now();
const drive = path.join(__dirname, 'drive-app.js');

function sample() {
  let state;
  try {
    state = execFileSync(process.execPath, [drive, 'eval', 'document.visibilityState'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    state = `error: ${String(err.message).split('\n')[0]}`;
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s ${state}`);
  if (Date.now() - t0 < seconds * 1000) setTimeout(sample, 700);
}
sample();
