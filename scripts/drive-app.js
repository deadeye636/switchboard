#!/usr/bin/env node
// scripts/drive-app.js — drive the running app from the command line (dev only).
//
// Electron speaks the same DevTools protocol Chrome does. Started with a debugging port, its renderer can
// be scripted from outside: click something, read what is on screen, take a picture. That is the missing
// half of "run it and look" — tests cannot see a sidebar, and an agent cannot click one.
//
//   1. Start the app with the port open:   npm run start:debug
//   2. Drive it:
//        node scripts/drive-app.js shot out.png            a screenshot of the window
//        node scripts/drive-app.js eval "<js>"             run JS in the renderer, print the result
//        node scripts/drive-app.js text "<selector>"       the text content of the first match
//        node scripts/drive-app.js click "<selector>"      click the first match
//        node scripts/drive-app.js clicktext "<sel>" "<s>" click the first match whose text contains <s>
//        node scripts/drive-app.js count "<selector>"      how many match
//        node scripts/drive-app.js console [seconds]       what the renderer logged, incl. failed loads
//
// No dependency: Node 22 ships a global WebSocket, and CDP is JSON over one.
'use strict';

const fs = require('fs');

const PORT = process.env.SWITCHBOARD_DEBUG_PORT || 9222;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

async function pageTarget() {
  let list;
  try {
    list = await (await fetch(`${ENDPOINT}/json/list`)).json();
  } catch {
    throw new Error(`no debugger on ${ENDPOINT} — start the app with: npm run start:debug`);
  }
  // The renderer, not a devtools window or a worker.
  const page = list.find(t => t.type === 'page' && !String(t.url).startsWith('devtools://'));
  if (!page) throw new Error('the app is running, but it has no page target (still starting up?)');
  return page;
}

// One CDP session: send commands, await their replies, subscribe to events, close.
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const listeners = new Map();               // CDP method -> handlers
  let nextId = 1;

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('could not attach to the renderer')));
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id === undefined) {               // an event, not a reply to anything we asked
      for (const fn of listeners.get(msg.method) || []) fn(msg.params || {});
      return;
    }
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else waiter.resolve(msg.result);
  });

  return {
    ready,
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(fn);
    },
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { try { ws.close(); } catch { /* already gone */ } },
  };
}

// Evaluate an expression in the renderer and return its value. `await`-able expressions are awaited.
async function evaluate(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,          // some handlers refuse to run without one
  });
  if (res.exceptionDetails) {
    const e = res.exceptionDetails;
    throw new Error(`the renderer threw: ${e.exception?.description || e.text}`);
  }
  return res.result?.value;
}

// A selector, as a JS string literal — so a quote in it cannot break out.
const lit = (s) => JSON.stringify(String(s));

const COMMANDS = {
  async shot(cdp, [file = 'app.png']) {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return `wrote ${file}`;
  },

  async eval(cdp, [expression]) {
    if (!expression) throw new Error('eval needs an expression');
    return evaluate(cdp, expression);
  },

  async text(cdp, [selector]) {
    if (!selector) throw new Error('text needs a selector');
    return evaluate(cdp, `(() => {
      const el = document.querySelector(${lit(selector)});
      return el ? el.innerText : null;
    })()`);
  },

  async count(cdp, [selector]) {
    if (!selector) throw new Error('count needs a selector');
    return evaluate(cdp, `document.querySelectorAll(${lit(selector)}).length`);
  },

  async click(cdp, [selector]) {
    if (!selector) throw new Error('click needs a selector');
    return evaluate(cdp, `(() => {
      const el = document.querySelector(${lit(selector)});
      if (!el) return 'NOT FOUND: ' + ${lit(selector)};
      el.scrollIntoView({ block: 'center' });
      el.click();
      return 'clicked: ' + (el.innerText || el.title || el.className || el.tagName).slice(0, 60);
    })()`);
  },

  // What the renderer logged — including the loads that failed.
  //
  // `shot` shows you a blank window; this shows you WHY it is blank. The renderer has no modules and no
  // bundler, so a mistyped `<script src>` is not an error anyone sees: the page just quietly lacks a
  // global, and the first thing to touch it throws somewhere else entirely. `Log.entryAdded` carries the
  // 404 itself ("Failed to load resource: net::ERR_FILE_NOT_FOUND file:///…/xterm.js") — the one line
  // that names the actual culprit.
  //
  // Both domains are needed, and each replays its own half. Measured against a running app rather than
  // read off the protocol docs, because the docs only promise the buffering for `Log`:
  //
  //   fire console.error, wait 1s, then attach fresh with ONE domain:
  //     Runtime.enable only  ->  Runtime.consoleAPICalled  (the error arrives)
  //     Log.enable only      ->  nothing
  //
  // So `Runtime` carries console + exceptions and DOES replay them, while `Log` carries the failed loads
  // (net::ERR_FILE_NOT_FOUND). Attaching seconds after the window opened still sees startup errors.
  async console(cdp, [seconds = '2']) {
    const out = [];

    cdp.on('Runtime.consoleAPICalled', ({ type, args = [] }) => {
      const text = args.map(a => a.value ?? a.description ?? a.unserializableValue ?? a.type).join(' ');
      out.push(`${String(type).toUpperCase()}  ${text}`);
    });
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails = {} }) => {
      out.push(`THROWN  ${exceptionDetails.exception?.description || exceptionDetails.text}`);
    });
    cdp.on('Log.entryAdded', ({ entry = {} }) => {
      const where = entry.url ? `  <- ${entry.url}` : '';
      out.push(`${String(entry.level).toUpperCase()}  ${entry.text}${where}`);
    });

    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await new Promise(r => setTimeout(r, Math.max(0, Number(seconds) || 2) * 1000));

    // Silence is the pass condition, so say so out loud rather than printing nothing.
    return out.length ? out.join('\n') : '(no console output, no failed loads)';
  },

  // The one that matters in a list: "the row that says X, and the button in it".
  async clicktext(cdp, [selector, needle]) {
    if (!selector || !needle) throw new Error('clicktext needs a selector and a string');
    return evaluate(cdp, `(() => {
      const all = [...document.querySelectorAll(${lit(selector)})];
      const el = all.find(e => (e.innerText || '').includes(${lit(needle)}));
      if (!el) return 'NOT FOUND: ' + all.length + ' candidates, none containing ' + ${lit(needle)};
      el.scrollIntoView({ block: 'center' });
      el.click();
      return 'clicked: ' + (el.innerText || el.className).slice(0, 60);
    })()`);
  },
};

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const run = COMMANDS[command];
  if (!run) {
    console.error(`usage: node scripts/drive-app.js <${Object.keys(COMMANDS).join('|')}> [args]`);
    process.exit(2);
  }

  const target = await pageTarget();
  const cdp = connect(target.webSocketDebuggerUrl);
  await cdp.ready;
  try {
    const out = await run(cdp, args);
    console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
  } finally {
    cdp.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
