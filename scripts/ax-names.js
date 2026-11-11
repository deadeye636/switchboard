#!/usr/bin/env node
// What a screen reader is told: the accessible names Chromium computes for the elements a selector matches, read
// from the accessibility tree over CDP (`Accessibility.getPartialAXTree`). A jsdom test can only check the markup;
// this reads the name the running app actually exposes (#842).
//
//   node scripts/ax-names.js "<selector>" [--target=<title or url part>]
//
// Needs a dev run with DevTools on (`npm run start:debug`, `npm run demo:start -- --debug`). The port is
// SWITCHBOARD_DEBUG_PORT (default 9222), as in scripts/drive-app.js. Without --target the first page is used.
'use strict';

const WebSocket = require('ws');

const PORT = process.env.SWITCHBOARD_DEBUG_PORT || 9222;
const selector = process.argv[2];
const targetArg = process.argv.slice(3).find((a) => a.startsWith('--target='));
const target = targetArg ? targetArg.slice('--target='.length) : null;

if (!selector) {
  console.error('usage: node scripts/ax-names.js "<selector>" [--target=<title or url part>]');
  process.exit(2);
}

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const pages = list.filter((p) => p.type === 'page');
  const page = target ? pages.find((p) => p.title.includes(target) || p.url.includes(target)) : pages[0];
  if (!page) throw new Error(`no page${target ? ` matching "${target}"` : ''} on port ${PORT}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.on('message', (m) => {
    const d = JSON.parse(m);
    if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  const call = (method, params = {}) => new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await call('DOM.enable');
  await call('Accessibility.enable');
  const doc = await call('DOM.getDocument', { depth: -1 });
  const found = await call('DOM.querySelectorAll', { nodeId: doc.result.root.nodeId, selector });
  const nodeIds = (found.result && found.result.nodeIds) || [];
  for (const nodeId of nodeIds) {
    const ax = await call('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
    const node = ((ax.result && ax.result.nodes) || [])[0];
    const role = node && node.role ? node.role.value : '?';
    const name = node && node.name ? node.name.value : '';
    console.log(`${role}\t${JSON.stringify(name)}`);
  }
  if (!nodeIds.length) console.log(`(nothing matches ${selector})`);
  ws.close();
})().catch((err) => { console.error(err.message); process.exit(1); });
