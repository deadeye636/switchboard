#!/usr/bin/env node
'use strict';
// Replays a synthetic stream of ops into a conversation view of a running instance and times each `apply()`
// (#723). No model turn is taken: the ops go straight into the view, so every run gets the same input and two
// runs can be compared — visible against covered window, shown against hidden tab, before against after a change.
//
//   node scripts/conversation-replay.js [--session=<id>] [--seed=2000] [--turns=60] [--gap=8] [--hide-tab]
//
// The view is reset to `--seed` entries first, then `--turns` turns of 28 ops each are sent `--gap` ms apart
// (a prompt, 20 partials, the answer with a tool call, its result, busy edges). `--hide-tab` takes `.visible`
// off the container for the run, the way a background tab is hidden. Without `--session` it uses the active
// session if that is a conversation, else the first conversation open in the window. The view's entries are
// replaced; use a throwaway session in the demo instance (`docs/ai/driving-the-app.md` has how to launch one).
//
// Prints one JSON line: the sum, median, p95 and max of `apply()` per op kind, and the long tasks of the run.
// A covered window counts as hidden only about six seconds after it is covered — wait that long before
// starting a covered run (`scripts/cover-window.ps1`, `scripts/watch-visibility.js`).
const path = require('path');
const { execFileSync } = require('child_process');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const opts = {
  session: typeof args.session === 'string' ? args.session : '',
  seed: args.seed !== undefined ? Number(args.seed) : 2000,
  turns: args.turns !== undefined ? Number(args.turns) : 60,
  gapMs: args.gap !== undefined ? Number(args.gap) : 8,
  hideTab: !!args['hide-tab'],
};

// Runs in the renderer. Kept as a function so it is checked as code here; sent as its source text.
async function probe(o) {
  let id = o.session;
  if (!id) {
    const active = typeof activeSessionId !== 'undefined' ? openSessions.get(activeSessionId) : null;
    if (active && active.conversation) id = activeSessionId;
    else for (const [k, e] of openSessions) if (e.conversation) { id = k; break; }
  }
  const entry = id && openSessions.get(id);
  if (!entry || !entry.conversation) return JSON.stringify({ error: 'no conversation view open' });
  const conv = entry.conversation;
  const para = (i) => `Paragraph ${i}: the quick brown fox jumps over the lazy dog, **bold** and \`code\` and a [link](https://example.com).\n\n- item one\n- item two\n\n\`\`\`js\nconst x${i} = ${i};\nconsole.log(x${i});\n\`\`\`\n`;
  let tid = 0;
  const turn = (i) => {
    const tool = `toolu_${++tid}`;
    return [
      { type: 'user', prompt: true, message: { role: 'user', content: `Prompt ${i}: please look at file ${i}.` } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: para(i) + para(i + 1) }, { type: 'tool_use', id: tool, name: 'Bash', input: { command: `ls -la dir${i}` } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool, content: Array.from({ length: 30 }, (_, k) => `line ${k} of output ${i}`).join('\n') }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: para(i + 2) }] } },
    ];
  };
  const seed = [];
  for (let i = 0; seed.length < o.seed; i++) seed.push(...turn(i));
  conv.apply({ op: 'reset', entries: seed });
  const c = conv.element;
  // Put back only what this run took away, whatever happens: a view that was a background tab stays one.
  const tookClass = o.hideTab && c.classList.contains('visible');
  if (tookClass) c.classList.remove('visible');
  try {
    await new Promise(r => setTimeout(r, 1500));
    const ops = [];
    for (let t = 0; t < o.turns; t++) {
      const [p, a, r, a2] = turn(100000 + t);
      ops.push({ op: 'busy', busy: true }, { op: 'append', entry: p });
      let text = '';
      for (let k = 0; k < 20; k++) {
        text += para(k).slice(0, 60) + ' ';
        ops.push({ op: 'partial', entry: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } } });
      }
      ops.push({ op: 'partial', entry: null }, { op: 'append', entry: a }, { op: 'tool', id: a.message.content[1].id, status: 'running' },
        { op: 'append', entry: r }, { op: 'append', entry: a2 }, { op: 'busy', busy: false });
    }
    const times = [];
    const kinds = {};
    let longTasks = 0, longMs = 0;
    const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) { longTasks++; longMs += e.duration; } });
    try { po.observe({ type: 'longtask' }); } catch { /* no long-task timing in this build */ }
    // Paced over a MessageChannel: a timer is throttled in a hidden window, a posted message is not.
    const ch = new MessageChannel();
    window.__conversationReplay = ch;
    const t0 = performance.now();
    await new Promise((done) => {
      let i = 0;
      const next = () => {
        if (i >= ops.length) return done();
        const op = ops[i++];
        const s = performance.now();
        conv.apply(op);
        const d = performance.now() - s;
        times.push(d);
        (kinds[op.op] = kinds[op.op] || []).push(d);
        const wait = performance.now() + o.gapMs;
        ch.port1.onmessage = () => { if (performance.now() >= wait) next(); else ch.port2.postMessage(0); };
        ch.port2.postMessage(0);
      };
      next();
    });
    const wall = performance.now() - t0;
    delete window.__conversationReplay;
    po.disconnect();
    const st = (a) => {
      if (!a.length) return { n: 0 };
      const s = a.slice().sort((x, y) => x - y);
      const sum = s.reduce((x, y) => x + y, 0);
      return { n: s.length, sum: Math.round(sum), med: +s[s.length >> 1].toFixed(2), p95: +s[Math.floor(s.length * 0.95)].toFixed(1), max: +s[s.length - 1].toFixed(1) };
    };
    const per = {};
    for (const k of Object.keys(kinds)) per[k] = st(kinds[k]);
    return JSON.stringify({ visibility: document.visibilityState, hideTab: o.hideTab, seedEntries: seed.length, ops: ops.length,
      wallMs: Math.round(wall), all: st(times), per, longTasks, longTaskMs: Math.round(longMs) });
  } finally {
    if (tookClass) c.classList.add('visible');
  }
}

// The run is started, not awaited: a CDP evaluate that awaits a promise for a minute was answered with "Promise
// was collected" in a hidden-tab run. The page keeps the result on `window`, and it is fetched from outside,
// once every two seconds — an in-page wait would be throttled in a hidden window anyway.
const drive = (js) => execFileSync(process.execPath, [path.join(__dirname, 'drive-app.js'), 'eval', js],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const start = `window.__conversationReplayResult = null; (${probe.toString()})(${JSON.stringify(opts)})`
  + `.then((r) => { window.__conversationReplayResult = r; }, (e) => { window.__conversationReplayResult = JSON.stringify({ error: String(e && e.stack || e) }); }); 'started'`;
// A run that never reports (the page reloaded, the view closed) is given up after ten minutes.
const deadline = Date.now() + 10 * 60 * 1000;
try {
  drive(start);
  const poll = () => {
    const r = drive('window.__conversationReplayResult || ""');
    if (r) { process.stdout.write(r + '\n'); return; }
    if (Date.now() > deadline) { console.error('No result after ten minutes.'); process.exit(1); }
    setTimeout(poll, 2000);
  };
  setTimeout(poll, 2000);
} catch (err) {
  // drive-app.js has printed why on stderr already; the command line would only repeat the probe's source.
  process.exit(err.status || 1);
}
