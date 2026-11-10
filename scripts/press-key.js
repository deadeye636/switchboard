#!/usr/bin/env node
// scripts/press-key.js — a REAL key press in the running app (dev only).
//
// `el.dispatchEvent(new KeyboardEvent(...))` reaches the listener the script picked and nothing else; it never goes
// through the browser's key pipeline (docs/ai/driving-the-app.md, "A key press has to be a real key press"). This
// focuses an element and sends CDP's `Input.dispatchKeyEvent` (rawKeyDown + keyUp), so every listener sees what a
// keyboard would give it. Written for #829's Alt+ArrowUp / Alt+ArrowDown on the session sidebar's grip.
//
//   node scripts/press-key.js [--target=<substring>] "<selector>" <key> [modifiers]
//
//   <key>        a DOM key name: the arrows, PageUp, PageDown, Home, End, Enter, Tab, Escape, Backspace, Delete,
//                " " (Space) or a letter; any other name is sent without a key code
//   [modifiers]  CDP's bit mask: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift; add them up (default 0)
//   --target     matches a window by title or URL, as drive-app.js's flag does; without it, the first page
//
// Prints whether the element took the focus, and what has the focus after the press. Port from SWITCHBOARD_DEBUG_PORT.
// No dependency: Node 22 ships a global WebSocket.
'use strict';

const PORT = process.env.SWITCHBOARD_DEBUG_PORT || 9222;
const ENDPOINT = `http://127.0.0.1:${PORT}`;
const KEY_CODES = {
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, PageUp: 33, PageDown: 34, Home: 36, End: 35,
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ' ': 32,
  // The two keys that open a context menu (#835): Shift+F10 (modifier 8) and the context-menu key.
  F10: 121, ContextMenu: 93,
};

function keyCodeOf(key) {
  if (KEY_CODES[key] != null) return KEY_CODES[key];
  return key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0;
}

async function main() {
  const args = process.argv.slice(2);
  const targetArg = args.find((a) => a.startsWith('--target='));
  const [selector, key, mods = '0'] = args.filter((a) => a !== targetArg);
  if (!selector || !key) {
    console.error('usage: node scripts/press-key.js [--target=<substring>] "<selector>" <key> [modifiers]');
    process.exit(2);
  }
  const needle = targetArg ? targetArg.slice('--target='.length).toLowerCase() : '';

  let list;
  try {
    list = await (await fetch(`${ENDPOINT}/json/list`)).json();
  } catch {
    throw new Error(`no debugger on ${ENDPOINT} — start the app with: npm run start:debug`);
  }
  const pages = list.filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'));
  const page = needle ? pages.find((t) => `${t.title} ${t.url}`.toLowerCase().includes(needle)) : pages[0];
  if (!page) throw new Error(needle ? `no window matches "${needle}"` : 'the app is running, but it has no page target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const send = (method, params) => new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.result.value;

  try {
    const focus = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'NOT FOUND';
      el.focus();
      return document.activeElement === el ? 'focused' : 'NOT FOCUSABLE';
    })()`);
    console.log(`focus: ${focus}`);
    if (focus !== 'focused') process.exitCode = 1;
    else {
      const base = { key, code: key, windowsVirtualKeyCode: keyCodeOf(key), modifiers: Number(mods) || 0 };
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      const after = await evaluate(`(() => {
        const a = document.activeElement;
        if (!a) return 'nothing';
        const label = a.getAttribute('aria-label') || a.id || a.className || '';
        return a.tagName.toLowerCase() + (label ? ' (' + String(label).slice(0, 60) + ')' : '');
      })()`);
      console.log(`focus after: ${after}`);
    }
  } finally {
    ws.close();
  }
}

main().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
