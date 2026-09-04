#!/usr/bin/env node
// scripts/heap-retainers.js — who is holding on to it?
//
//   node --max-old-space-size=8192 scripts/heap-retainers.js <snapshot> <node name> [sample] [depth]
//
// `heap-summary.js` says which KIND of object grew. That is rarely the answer: "297 820 more plain
// Objects" names no code. This walks the snapshot's edges BACKWARDS from a sample of those objects and
// prints the chain of edge names towards a root, aggregated — the container that never lets go usually
// appears in the first two hops, and it is often not the one the issue suspects.
//
// `<node name>` is a node's own name: "Object" for a plain object, a class name, or a string's content.
// The walk takes the first unvisited retainer at each hop rather than the shortest path to a root, so read
// the output as "a path", not "the path". When several samples agree hop for hop, that is the finding.
'use strict';
const fs = require('fs');

const file = process.argv[2];
const wantName = process.argv[3];
const sampleSize = Number(process.argv[4] || 150);
const maxDepth = Number(process.argv[5] || 7);

if (!file || !wantName) {
  console.error('usage: heap-retainers.js <snapshot> <node name> [sample] [depth]');
  process.exit(1);
}

const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
const meta = snap.snapshot.meta;
const nf = meta.node_fields, ef = meta.edge_fields;
const nStride = nf.length, eStride = ef.length;
const iNType = nf.indexOf('type'), iNName = nf.indexOf('name'), iNEdges = nf.indexOf('edge_count');
const iEType = ef.indexOf('type'), iEName = ef.indexOf('name_or_index'), iETo = ef.indexOf('to_node');
const nodeTypes = meta.node_types[iNType];
const edgeTypes = meta.edge_types[iEType];
const nodes = snap.nodes, edges = snap.edges, strings = snap.strings;
const nodeCount = nodes.length / nStride;
const edgeCount = edges.length / eStride;

// Where each node's outgoing edges start, in edge-record units.
const edgeStart = new Int32Array(nodeCount + 1);
for (let i = 0, off = 0; i < nodeCount; i++) { edgeStart[i] = off; off += nodes[i * nStride + iNEdges]; }
edgeStart[nodeCount] = edgeCount;

// The reverse index: for every node, the edges pointing AT it. Counting sort, two passes, typed arrays —
// a Map of arrays here is what makes this script run out of memory on a real snapshot.
const inCount = new Int32Array(nodeCount + 1);
for (let e = 0; e < edgeCount; e++) inCount[edges[e * eStride + iETo] / nStride]++;
const inStart = new Int32Array(nodeCount + 1);
for (let i = 0, off = 0; i < nodeCount; i++) { inStart[i] = off; off += inCount[i]; }
inStart[nodeCount] = edgeCount;
const cursor = Int32Array.from(inStart);
const inEdge = new Int32Array(edgeCount);
const inFrom = new Int32Array(edgeCount);
{
  let e = 0;
  for (let n = 0; n < nodeCount; n++) {
    for (const end = edgeStart[n + 1]; e < end; e++) {
      const to = edges[e * eStride + iETo] / nStride;
      const slot = cursor[to]++;
      inEdge[slot] = e;
      inFrom[slot] = n;
    }
  }
}

const nodeName = (n) => strings[nodes[n * nStride + iNName]] || '';
const nodeType = (n) => nodeTypes[nodes[n * nStride + iNType]] || '?';
function edgeLabel(e) {
  const t = edgeTypes[edges[e * eStride + iEType]];
  const v = edges[e * eStride + iEName];
  return (t === 'element' || t === 'hidden') ? `[${v}]` : (strings[v] || '?');
}

const targets = [];
for (let n = 0; n < nodeCount && targets.length < sampleSize * 40; n++) {
  if (nodeName(n) === wantName) targets.push(n);
}
const step = Math.max(1, Math.floor(targets.length / sampleSize));
const sample = targets.filter((_, i) => i % step === 0).slice(0, sampleSize);
console.log(`${file}\n${targets.length} nodes named "${wantName}" (capped), sampling ${sample.length}, depth ${maxDepth}\n`);

const paths = new Map();
for (const start of sample) {
  const chain = [];
  let cur = start;
  const seen = new Set([cur]);
  for (let d = 0; d < maxDepth; d++) {
    const from = inStart[cur], to = inStart[cur + 1];
    if (from === to) { chain.push('(root)'); break; }
    let pick = -1;
    for (let s = from; s < to; s++) { if (!seen.has(inFrom[s])) { pick = s; break; } }
    if (pick < 0) break;
    const parent = inFrom[pick];
    seen.add(parent);
    chain.push(`${edgeLabel(inEdge[pick])} in ${nodeType(parent)} ${nodeName(parent) || '(anon)'}`);
    cur = parent;
  }
  const key = chain.join('  <-  ');
  paths.set(key, (paths.get(key) || 0) + 1);
}

for (const [k, v] of [...paths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${String(v).padStart(4)}x  ${k}`);
}
