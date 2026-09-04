#!/usr/bin/env node
// scripts/heap-summary.js — what is in a heap snapshot, and what grew between two of them.
//
//   node --max-old-space-size=8192 scripts/heap-summary.js <snapshot>              one snapshot
//   node --max-old-space-size=8192 scripts/heap-summary.js <a> <b>                  what grew
//   node --max-old-space-size=8192 scripts/heap-summary.js <a> [b] --field=_glyphs  size of a named array
//
// The snapshot format is flat typed arrays: `nodes` is a run of records whose layout is `meta.node_fields`,
// and every name is an index into `strings`. Aggregating by (type, name) answers "which KIND of object is
// being retained", which is where a leak hunt starts. It does NOT answer "who holds it" — that is
// `heap-retainers.js`, and the answer usually surprises.
//
// `--field=<edge name>` is the follow-up question once you suspect a specific container: it finds every
// edge with that name and reports how many elements the array behind it holds. Two snapshots plus a field
// give the growth of one data structure rather than of the heap.
//
// The files are large; without `--max-old-space-size` node dies parsing them.
'use strict';
const fs = require('fs');

const argv = process.argv.slice(2);
const files = argv.filter(a => !a.startsWith('--'));
const fieldArg = argv.find(a => a.startsWith('--field='));
const field = fieldArg ? fieldArg.slice(8) : null;

function load(file) {
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  const meta = snap.snapshot.meta;
  const nf = meta.node_fields, ef = meta.edge_fields;
  return {
    snap, meta, nf, ef,
    nStride: nf.length, eStride: ef.length,
    iNType: nf.indexOf('type'), iNName: nf.indexOf('name'),
    iNSize: nf.indexOf('self_size'), iNEdges: nf.indexOf('edge_count'),
    iEName: ef.indexOf('name_or_index'), iETo: ef.indexOf('to_node'),
    typeNames: meta.node_types[nf.indexOf('type')],
  };
}

function summarise(file) {
  const s = load(file);
  const { snap, nStride, iNType, iNName, iNSize, typeNames } = s;
  const nodes = snap.nodes, strings = snap.strings;
  const agg = new Map();
  for (let i = 0; i < nodes.length; i += nStride) {
    const key = `${typeNames[nodes[i + iNType]] || '?'}|${strings[nodes[i + iNName]] || ''}`;
    let e = agg.get(key);
    if (!e) { e = { count: 0, size: 0 }; agg.set(key, e); }
    e.count++;
    e.size += nodes[i + iNSize];
  }
  return { agg, total: [...agg.values()].reduce((t, e) => t + e.size, 0), nodeCount: nodes.length / nStride, s };
}

// Every array reached by an edge of this name, and how many elements it holds.
function fieldSizes(file, name) {
  const s = load(file);
  const { snap, nStride, eStride, iNEdges, iEName, iETo } = s;
  const nodes = snap.nodes, edges = snap.edges, strings = snap.strings;
  const nodeCount = nodes.length / nStride;
  const edgeStart = new Int32Array(nodeCount + 1);
  for (let i = 0, off = 0; i < nodeCount; i++) { edgeStart[i] = off; off += nodes[i * nStride + iNEdges]; }
  let instances = 0, elements = 0, e = 0;
  for (let n = 0; n < nodeCount; n++) {
    for (const end = edgeStart[n + 1]; e < end; e++) {
      if (strings[edges[e * eStride + iEName]] !== name) continue;
      instances++;
      elements += nodes[(edges[e * eStride + iETo] / nStride) * nStride + iNEdges];
    }
  }
  return { instances, elements };
}

const mb = (b) => (b / 1048576).toFixed(1);

if (!files.length) {
  console.error('usage: heap-summary.js <snapshot> [<snapshot-b>] [--field=<edge name>]');
  process.exit(1);
}

if (field) {
  for (const f of files) {
    const r = fieldSizes(f, field);
    console.log(`${f}: ${field} — ${r.instances} instance(s), ${r.elements} entries`);
  }
  if (files.length === 2) {
    const a = fieldSizes(files[0], field), b = fieldSizes(files[1], field);
    console.log(`delta: ${b.elements - a.elements} entries`);
  }
  process.exit(0);
}

const A = summarise(files[0]);
if (files.length === 1) {
  console.log(`${files[0]}: ${A.nodeCount} objects, ${mb(A.total)} MB retained\n`);
  console.log('largest by retained self size:');
  for (const [k, e] of [...A.agg.entries()].sort((x, y) => y[1].size - x[1].size).slice(0, 20)) {
    console.log(`  ${mb(e.size).padStart(8)} MB  ${String(e.count).padStart(8)}x  ${k.replace('|', '  ')}`);
  }
} else {
  const B = summarise(files[1]);
  console.log(`A: ${A.nodeCount} objects / ${mb(A.total)} MB     B: ${B.nodeCount} objects / ${mb(B.total)} MB`);
  console.log(`delta: ${B.nodeCount - A.nodeCount} objects, ${mb(B.total - A.total)} MB\n`);
  const rows = [];
  for (const [k, b] of B.agg) {
    const a = A.agg.get(k) || { count: 0, size: 0 };
    rows.push({ k, dCount: b.count - a.count, dSize: b.size - a.size, aCount: a.count, bCount: b.count });
  }
  console.log('grew the most (by size):');
  for (const r of rows.sort((x, y) => y.dSize - x.dSize).slice(0, 15)) {
    console.log(`  +${mb(r.dSize).padStart(7)} MB  ${String(r.aCount).padStart(7)} -> ${String(r.bCount).padEnd(7)}  ${r.k.replace('|', '  ')}`);
  }
  console.log('\ngrew the most (by count):');
  for (const r of rows.sort((x, y) => y.dCount - x.dCount).slice(0, 12)) {
    console.log(`  +${String(r.dCount).padStart(7)}  ${String(r.aCount).padStart(7)} -> ${String(r.bCount).padEnd(7)}  ${r.k.replace('|', '  ')}`);
  }
}
