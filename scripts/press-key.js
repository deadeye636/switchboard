#!/usr/bin/env node
// scripts/press-key.js — a REAL key press in the running app (dev only).
//
// `el.dispatchEvent(new KeyboardEvent(...))` reaches the listener the script picked and nothing else; it never goes
// through the browser's key pipeline (docs/ai/driving-the-app.md, "A key press has to be a real key press"). This
// focuses an element and sends CDP's `Input.dispatchKeyEvent` (rawKeyDown + keyUp), so every listener sees what a
// keyboard would give it. Written for #829's Alt+ArrowUp / Alt+ArrowDown on the session sidebar's grip.
//
//   node scripts/press-key.js [--target=<substring>] "<selector>" <keys> [modifiers]
//
//   <selector>   the element to focus first; "-" keeps the focus where it is (for a sequence continued in a second call)
//   <keys>       one key or a comma-separated sequence pressed in order (#826: End,Enter,Tab). Each is a DOM key name:
//                the arrows, PageUp, PageDown, Home, End, Enter, Tab, Escape, Backspace, Delete, F10, ContextMenu,
//                " " or Space, or one character; any other name is sent without a key code. A key may carry
//                `Shift+`, `Ctrl+`, `Alt+` or `Meta+` in front (Shift+Tab, Alt+ArrowDown, Ctrl++); a letter with
//                Shift (named or in the mask) is sent as the capital. A comma is sendable only alone (","), not inside
//                a sequence. No text is typed: each press is rawKeyDown + keyUp.
//   [modifiers]  CDP's bit mask: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift; add them up (default 0); applies to every key
//   --target     matches a window by title or URL, as drive-app.js's flag does; without it, the first page
//
// Prints whether the element took the focus, and what has the focus after the last press. Port from SWITCHBOARD_DEBUG_PORT.
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

const MODIFIER_BITS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 };

/** One item of <keys> (`Shift+Tab`, `End`, `a`) as `{ key, modifiers }`; throws on a modifier it does not know. */
function parseKey(spec, baseMods) {
  // The key is what follows the last `+`; a trailing `+` is the plus key itself (`+`, `Ctrl++`).
  let key;
  let head;
  if (spec === '+') { key = '+'; head = ''; }
  else if (spec.endsWith('++')) { key = '+'; head = spec.slice(0, -2); }
  else { const i = spec.lastIndexOf('+'); key = i < 0 ? spec : spec.slice(i + 1); head = i < 0 ? '' : spec.slice(0, i); }
  let modifiers = baseMods;
  for (const p of head ? head.split('+') : []) {
    const bit = MODIFIER_BITS[p.toLowerCase()];
    if (!bit) throw new Error(`unknown modifier "${p}" in "${spec}" (Shift, Ctrl, Alt, Meta)`);
    modifiers |= bit;
  }
  if (key === 'Space') key = ' ';
  if (!key) throw new Error(`no key in "${spec}"`);
  if ((modifiers & 8) && key.length === 1) key = key.toUpperCase();   // what a keyboard reports for Shift+a
  return { key, modifiers };
}

/** <keys> split into presses. A lone " " is Space and a lone "," the comma key; a list that names no key is refused. */
function parseKeys(keys, baseMods) {
  if (keys === ' ' || keys === ',') return [parseKey(keys, baseMods)];
  const presses = keys.split(',').map((s) => s.trim()).filter(Boolean).map((s) => parseKey(s, baseMods));
  if (!presses.length) throw new Error(`no key in "${keys}"`);
  return presses;
}

async function main() {
  const args = process.argv.slice(2);
  const targetArg = args.find((a) => a.startsWith('--target='));
  const [selector, keys, mods = '0'] = args.filter((a) => a !== targetArg);
  if (!selector || !keys) {
    console.error('usage: node scripts/press-key.js [--target=<substring>] "<selector>|-" <key>[,<key>...] [modifiers]');
    process.exit(2);
  }
  const needle = targetArg ? targetArg.slice('--target='.length).toLowerCase() : '';
  const presses = parseKeys(keys, Number(mods) || 0);   // before connecting: a typo fails without touching the app

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
    if (pending.has(d.id)) { pending.get(d.id).resolve(d); pending.delete(d.id); }
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  // A key that closes or reloads the window drops the socket: fail what is waiting instead of hanging on it.
  ws.onclose = () => {
    for (const p of pending.values()) p.reject(new Error('the page closed the connection during the key presses'));
    pending.clear();
  };
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.result.value;

  try {
    const focus = selector === '-' ? 'kept' : await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'NOT FOUND';
      el.focus();
      return document.activeElement === el ? 'focused' : 'NOT FOCUSABLE';
    })()`);
    console.log(`focus: ${focus}`);
    if (focus !== 'focused' && focus !== 'kept') process.exitCode = 1;
    else {
      for (const p of presses) {
        const base = { key: p.key, code: p.key, windowsVirtualKeyCode: keyCodeOf(p.key), modifiers: p.modifiers };
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
        if (presses.length > 1) await new Promise((r) => setTimeout(r, 60));   // let the page's handlers run in between
      }
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
