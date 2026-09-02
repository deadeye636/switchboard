#!/usr/bin/env node
// scripts/perf-trace.js — where a frame goes, and whether an animation is on the compositor.
//
// `perf-sample.js` watches an instance over hours and answers "is anything growing". This answers the
// other half: for the twenty seconds you are looking at, WHAT is the renderer doing, and WHO caused it.
// It is the tool that found #519 and #520, and it exists because the two instruments people reach for
// first both lie about this app:
//
//   - A CPU profile blames `(program)`. Style recalculation, layout and paint are not JS frames, so a
//     profile of a renderer whose cost is rendering shows 70 % idle and a busiest frame at 0.5 %.
//   - A duration compared across two runs of a LIVE instance reads noise. Three runs of one identical
//     configuration measured 592, 748 and 879 ms — a spread of nearly 50 %. Anything smaller than that
//     is not a finding, which is why every run prints what was animating while it ran: two runs that
//     do not name the same state cannot be compared at all.
//
//   node scripts/perf-trace.js [seconds]                 what the frame cost, and who invalidated it
//   node scripts/perf-trace.js composited "<selector>"   does that element's animation run on the compositor
//
// The port comes from SWITCHBOARD_DEBUG_PORT (default 9222) — see `docs/ai/driving-the-app.md` for
// getting a debugging port onto an instance that is already running.
//
// No dependency: Node 22 ships a global WebSocket, and CDP is JSON over one.
'use strict';

const PORT = Number(process.env.SWITCHBOARD_DEBUG_PORT) || 9222;

// Invalidation records and the frames that scheduled them; `.stack` is what turns "something dirtied
// the styles" into a file and a line.
const TRACE_CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.invalidationTracking',
  'disabled-by-default-devtools.timeline.stack',
];

// `compositeFailed` and the properties Blink could not accelerate ride on the Animation events, and only
// under these two categories — a trace without them cannot answer the compositing question at all.
const ANIMATION_CATEGORIES = ['devtools.timeline', 'blink.animations'];

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const listeners = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('could not attach to the renderer')));
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id === undefined) {
      for (const fn of listeners.get(msg.method) || []) fn(msg.params || {});
      return;
    }
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message || 'CDP error'));
    else waiter.resolve(msg.result);
  });
  return {
    ready,
    on(method, fn) { if (!listeners.has(method)) listeners.set(method, []); listeners.get(method).push(fn); },
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 10000);
        pending.set(id, {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { try { ws.close(); } catch { /* already gone */ } },
  };
}

async function attach() {
  let list;
  try {
    list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  } catch {
    throw new Error(`no debugger on 127.0.0.1:${PORT} — start the app with a debugging port (npm run start:debug)`);
  }
  const page = list.find(t => t.type === 'page' && !String(t.url).startsWith('devtools://'));
  if (!page) throw new Error('the app is running, but it has no page target');
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  return { cdp, page };
}

const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);
const top = (map, n = 12) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
const frameLabel = (f) => `${f.functionName || '(anonymous)'} @ ${String(f.url || '').split('/').pop()}:${f.lineNumber}`;

// Collect a trace of `seconds` and hand back the raw events.
async function record(cdp, seconds, categories) {
  const events = [];
  cdp.on('Tracing.dataCollected', (p) => { for (const e of p.value || []) events.push(e); });
  const complete = new Promise((resolve) => cdp.on('Tracing.tracingComplete', () => resolve()));
  await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: categories } });
  await new Promise(r => setTimeout(r, seconds * 1000));
  await cdp.send('Tracing.end');
  await complete;
  return events;
}

// ---------------------------------------------------------------------------- the frame

async function trace(seconds) {
  const { cdp, page } = await attach();
  // What was moving while this ran. Without it two runs cannot be compared, and comparing two runs of a
  // live instance without it is how a whole issue's worth of numbers went wrong.
  const state = await cdp.send('Runtime.evaluate', {
    returnByValue: true,
    expression: `JSON.stringify({
      animations: document.getAnimations().filter(a => a.playState === 'running').length,
      busy: document.querySelectorAll('.status-dot.status-busy').length,
      rows: document.querySelectorAll('.session-item').length,
    })`,
  });
  console.log(`tracing ${page.title} for ${seconds}s — while: ${state.result.value}`);

  const events = await record(cdp, seconds, TRACE_CATEGORIES);
  cdp.close();

  const count = new Map();
  const duration = new Map();
  const reasons = new Map();
  const nodes = new Map();
  const scheduledBy = new Map();
  const parsedBy = new Map();
  let recalcs = 0;
  let recalcUs = 0;
  let elements = 0;

  for (const e of events) {
    bump(count, e.name);
    if (e.dur) bump(duration, e.name, e.dur);
    const data = (e.args && e.args.data) || {};
    const begin = (e.args && e.args.beginData) || {};
    if (e.name === 'UpdateLayoutTree') {
      recalcs += 1;
      recalcUs += e.dur || 0;
      // The field has moved between Chromium versions; take it from wherever it is rather than
      // reporting a confident zero.
      elements += Number(data.elementCount ?? begin.elementCount ?? (e.args && e.args.elementCount) ?? 0);
    }
    if (e.name === 'ParseHTML') {
      const f = (begin.stackTrace && begin.stackTrace[0]) || (data.stackTrace && data.stackTrace[0]);
      bump(parsedBy, f ? frameLabel(f) : '(no stack recorded)');
    }
    if (e.name === 'ScheduleStyleInvalidationTracking' || e.name === 'StyleRecalcInvalidationTracking') {
      if (data.reason) bump(reasons, data.reason);
      if (data.nodeName) bump(nodes, String(data.nodeName).slice(0, 64));
      const f = data.stackTrace && data.stackTrace[0];
      if (f) bump(scheduledBy, frameLabel(f));
    }
  }

  console.log(`\n${events.length} events. UpdateLayoutTree: ${recalcs} (${(recalcs / seconds).toFixed(1)}/s), `
    + `${(recalcUs / 1000).toFixed(0)} ms${elements ? `, ${elements} elements` : ''}`);

  console.log('\nwhere the main thread went:');
  for (const [name, us] of top(duration)) {
    console.log(`  ${(us / 1000).toFixed(0).padStart(6)} ms  ${String(count.get(name)).padStart(6)}x  ${name}`);
  }
  if (reasons.size) {
    console.log('\nwhy the styles were invalidated:');
    for (const [k, v] of top(reasons, 8)) console.log(`  ${String(v).padStart(6)}  ${k}`);
  }
  if (nodes.size) {
    console.log('\nwhat was invalidated:');
    for (const [k, v] of top(nodes, 10)) console.log(`  ${String(v).padStart(6)}  ${k}`);
  }
  if (scheduledBy.size) {
    console.log('\nwho scheduled it:');
    for (const [k, v] of top(scheduledBy, 8)) console.log(`  ${String(v).padStart(6)}  ${k}`);
  }
  if (parsedBy.size) {
    console.log('\nwho parsed HTML:');
    for (const [k, v] of top(parsedBy, 8)) console.log(`  ${String(v).padStart(6)}  ${k}`);
  }
}

// ---------------------------------------------------------------------------- the compositor

// A composited animation owns a layer and the layer says why. Anything else is inference — and inference
// from a duration got this exactly backwards once already: the spinner that looked expensive was the one
// animation Blink WAS accelerating.
async function composited(selector) {
  const { cdp } = await attach();

  const shapes = await cdp.send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const seen = new Map();
      for (const el of document.querySelectorAll(${JSON.stringify(selector)})) {
        const cs = getComputedStyle(el);
        // display matters: a transform animation on an inline box cannot be accelerated at all.
        const key = 'display=' + cs.display + ' animation=' + cs.animationName + ' will-change=' + cs.willChange;
        seen.set(key, (seen.get(key) || 0) + 1);
      }
      return [...seen.entries()].map(([k, n]) => n + ' x ' + k);
    })()`,
  });
  console.log(`matching ${selector}:`);
  for (const line of shapes.result.value || []) console.log(`  ${line}`);
  if (!(shapes.result.value || []).length) console.log('  (nothing on screen matches)');

  const layers = [];
  cdp.on('LayerTree.layerTreeDidChange', (p) => { if (p.layers) layers.push(...p.layers); });
  await cdp.send('DOM.enable');
  await cdp.send('LayerTree.enable');
  await new Promise(r => setTimeout(r, 1500));

  const doc = await cdp.send('DOM.getDocument', { depth: -1 });
  const found = await cdp.send('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector });
  const backendIds = new Set();
  for (const nodeId of found.nodeIds) {
    const described = await cdp.send('DOM.describeNode', { nodeId });
    if (described.node && described.node.backendNodeId) backendIds.add(described.node.backendNodeId);
  }

  const own = layers.filter(l => backendIds.has(l.backendNodeId));
  const reasons = new Set();
  for (const layer of own) {
    const r = await cdp.send('LayerTree.compositingReasons', { layerId: layer.layerId }).catch(() => ({}));
    for (const reason of r.compositingReasonIds || r.compositingReasons || []) reasons.add(reason);
  }
  await cdp.send('LayerTree.disable');

  if (reasons.size) console.log(`\nCOMPOSITED — ${[...reasons].join(', ')}`);
  else console.log('\nNOT COMPOSITED — no match owns a layer, so its animation runs on the main thread');

  // …and Blink's own verdict, which names what it could not take.
  const events = await record(cdp, 6, ANIMATION_CATEGORIES);
  cdp.close();
  const verdicts = new Map();
  for (const e of events) {
    if (e.name !== 'Animation') continue;
    const d = (e.args && (e.args.data || e.args.beginData)) || {};
    if (d.compositeFailed === undefined && !d.displayName) continue;
    bump(verdicts, JSON.stringify({ name: d.displayName, compositeFailed: d.compositeFailed, unsupported: d.unsupportedProperties }));
  }
  console.log('\nwhat Blink recorded:');
  if (!verdicts.size) console.log('  (no Animation records in the window — nothing started or stopped)');
  for (const [k, n] of top(verdicts, 8)) console.log(`  ${String(n).padStart(4)}  ${k}`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'composited') {
    if (!argv[1]) { console.error('usage: node scripts/perf-trace.js composited "<selector>"'); process.exit(2); }
    return composited(argv[1]);
  }
  return trace(Number(argv[0]) || 20);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
