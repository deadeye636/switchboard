#!/usr/bin/env node
// scripts/heap-snapshot.js — take a V8 heap snapshot of a running renderer, over the debugging port.
//
// `perf-sample.js` says a counter is growing. This says WHAT is growing. The snapshot forces a full GC
// first, so everything in it survived collection — which is the only interesting question once a heap
// floor climbs: an allocation that GC reclaims is not a leak, and the mean of a sample cannot tell the
// two apart.
//
//   1. Start an instance with the port open (npm run start:debug, or the installed build with
//      --remote-debugging-port=9222).
//   2. Take one now and one later. An hour apart is usually enough to see a slope:
//        node scripts/heap-snapshot.js --out=heap-a.heapsnapshot
//        node scripts/heap-snapshot.js --out=heap-b.heapsnapshot
//   3. Compare them — `heap-summary.js` aggregates and diffs, `heap-retainers.js` names the container.
//
// Options: --port=<n> (default SWITCHBOARD_DEBUG_PORT or 9222), --match=<substring of the page url>
// (default index.html — use settings.html for the settings window), --out=<file> (default
// .claude/scratchpad/heap-<timestamp>.heapsnapshot, which is gitignored).
//
// Two things to know before reading the numbers. The file is large — a 50 MB heap writes ~130 MB of JSON,
// so the readers below want `--max-old-space-size`. And the snapshot PAUSES the renderer for a second or
// two while it serialises; on a live instance that is a visible freeze, not a silent measurement.
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const port = Number(flag('port', process.env.SWITCHBOARD_DEBUG_PORT || 9222));
const match = flag('match', 'index.html');
const outFile = flag('out', path.join('.claude', 'scratchpad',
  `heap-${new Date().toISOString().replace(/[:.]/g, '-')}.heapsnapshot`));

(async () => {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) });
  const list = await res.json();
  const target = list.find(t => t.type === 'page' && String(t.url).includes(match));
  if (!target) {
    console.error(`no page whose url contains "${match}" on port ${port}`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const out = fs.createWriteStream(outFile);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  let chunks = 0;
  let bytes = 0;
  const send = (method, params) => ws.send(JSON.stringify({ id: ++id, method, params: params || {} }));

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => {
      console.log(`attached to ${target.title} — taking snapshot`);
      send('HeapProfiler.enable');
      send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false });
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === 'HeapProfiler.addHeapSnapshotChunk') {
        chunks++;
        bytes += msg.params.chunk.length;
        out.write(msg.params.chunk);
        return;
      }
      // The reply to takeHeapSnapshot arrives only after the last chunk has been sent.
      if (msg.id === 2) {
        out.end(() => {
          console.log(`${outFile}: ${(bytes / 1048576).toFixed(1)} MB in ${chunks} chunks`);
          ws.close();
          resolve();
        });
      }
    });
  });
})().catch((err) => {
  console.error(String((err && err.message) || err));
  process.exit(1);
});
