#!/usr/bin/env node
// scripts/measure-format-validate.js — what the save-time format check costs, per format and size (#610).
//
// `validateContent` (src/app/format-validate.js) parses on the MAIN process, so its cost is time the whole
// app stands still. The size ceilings there come from this script's output: the largest ordinary document
// each parser checks inside the budget, on the machine that set them. Re-run it when a parser is upgraded
// or the ceilings are questioned, and update the numbers in that file's comment.
//
// The documents are ordinary config-shaped text, not pathological input, in several shapes per format:
// tables of a few keys, dense keys, one-character keys and (TOML) arrays of tables. The shapes with the most
// entries per byte set the ceiling: smol-toml's cost grows with the square of the entry count (doubling such
// a document costs three to four times the time), so bytes alone understate what a file of many small
// entries costs.
//
// A save parses once, cold, so each cell reports the FIRST run when that is slower than the median.
//
//   node scripts/measure-format-validate.js [--runs=<n>]
'use strict';

const fs = require('fs');
const path = require('path');
const toml = require('smol-toml');
const yaml = require('js-yaml');

const runsArg = process.argv.find(a => a.startsWith('--runs='));
const RUNS = runsArg ? Math.max(1, Number(runsArg.slice(7)) || 5) : 5;
const SIZES_KB = [16, 32, 64, 128, 256, 512, 1024, 2048];

function grow(unit, bytes) {
  let out = '';
  for (let i = 0; out.length < bytes; i++) out += unit(i);
  return out;
}

function jsonDoc(bytes) {
  const entries = [];
  let len = 2;
  for (let i = 0; len < bytes; i++) {
    const e = JSON.stringify({ name: `entry-${i}`, enabled: i % 2 === 0, weight: i * 1.5, tags: ['a', 'b', 'c'] });
    entries.push(e);
    len += e.length + 1;
  }
  return '[' + entries.join(',') + ']';
}

const CASES = [
  ['json', jsonDoc, (t) => JSON.parse(t)],
  ['toml', (b) => grow(i => `[section${i}]\nname = "entry-${i}"\nenabled = ${i % 2 === 0}\ntags = ["a", "b", "c"]\n\n`, b), (t) => toml.parse(t)],
  ['toml-dense', (b) => grow(i => `key${i} = ${i}\n`, b), (t) => toml.parse(t)],
  ['toml-short', (b) => grow(i => `k${i}=1\n`, b), (t) => toml.parse(t)],
  ['toml-aot', (b) => grow(i => `[[t]]\nk = ${i}\n`, b), (t) => toml.parse(t)],
  ['yaml', (b) => grow(i => `section${i}:\n  name: entry-${i}\n  enabled: ${i % 2 === 0}\n  tags: [a, b, c]\n`, b), (t) => yaml.load(t)],
  ['yaml-dense', (b) => grow(i => `key${i}: ${i}\n`, b), (t) => yaml.load(t)],
  ['yaml-short', (b) => grow(i => `k${i}: 1\n`, b), (t) => yaml.load(t)],
];

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// Read off disk: smol-toml's `exports` map does not expose its package.json to require().
function versionOf(pkg) {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'node_modules', pkg, 'package.json'), 'utf8')).version; }
  catch { return '?'; }
}

console.log(`smol-toml ${versionOf('smol-toml')} · js-yaml ${versionOf('js-yaml')} · node ${process.version} · ${RUNS} runs`);
for (const [name, make, parse] of CASES) {
  const row = [];
  for (const kb of SIZES_KB) {
    const doc = make(kb * 1024);
    const times = [];
    for (let r = 0; r < RUNS; r++) {
      const t0 = process.hrtime.bigint();
      parse(doc);
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const ms = Math.max(times[0], median(times));
    row.push(`${kb} KB ${ms.toFixed(0)} ms`);
    if (ms > 1500) break;   // past any sensible ceiling; the rest only costs time
  }
  console.log(`${name.padEnd(10)} ${row.join(' · ')}`);
}
