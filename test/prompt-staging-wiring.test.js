// Staged prompts: the wiring the renderer's suite cannot see (#614).
//
// `test/prompt-queue.test.js` covers the rules; nothing there can tell whether they are CONNECTED. The
// feature is four one-line hooks in four files that already existed, and every one of them is the kind
// that survives a refactor as a dangling name: the delivery trigger, the dirty-line signal, the exit
// discard and the fork re-key. A dropped hook is silent — the queue just never drains, or never empties.
//
// A source-reading guard, so it reads the source with the prose dropped (`test/helpers/strip-comments.js`,
// CLAUDE.md reflex 14): every name below is also written in a comment beside it, and a line pass over the
// raw text would count a comment as a wire.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripComments } = require('./helpers/strip-comments');

const ROOT = path.join(__dirname, '..');
const code = rel => stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

// Each hook: where it has to be called, and what it is for. The reason travels with the assertion so a
// failure says what broke rather than which regex missed.
const HOOKS = [
  {
    file: 'src/renderer/app.js',
    call: 'deliverStagedPrompts(',
    why: 'refreshSessionStatusViews is the choke point every status edge funnels through — without the '
      + 'call a staged prompt is never delivered at all',
  },
  {
    file: 'src/renderer/shell/session-ipc.js',
    call: 'discardStagedPromptsOnExit(',
    why: 'a session that exits discards its staged items rather than delivering them into a relaunch',
  },
  {
    file: 'src/renderer/shell/session-ipc.js',
    call: 'rekeyStagedPrompts(',
    why: 'a fork re-keys every per-session map; a queue left on the retired id is unreachable for the '
      + 'life of the window',
  },
  {
    file: 'src/renderer/shell/sidebar-session-row.js',
    call: 'stagedPromptCountFor(',
    why: 'the row is where the user SEES that something is staged',
  },
  {
    file: 'src/renderer/shell/sidebar-session-row.js',
    call: 'stagedPromptHeldByLine(',
    why: 'a delivery blocked by the user\'s own prompt line has to be VISIBLE — a count that never goes '
      + 'down with nothing saying why reads as a broken feature, and the wheel over a full-screen TUI '
      + 'reaches that state without anyone typing',
  },
  {
    file: 'src/renderer/shell/sidebar-session-row.js',
    call: 'reviewStagedPrompts(',
    why: 'the chip is also the way to read and discard what is staged',
  },
  {
    file: 'src/renderer/terminal/terminal-manager.js',
    call: 'clearPromptLineState(',
    why: 'the dirty-line belief describes a line inside a CLI this window is about to stop talking to, '
      + 'and must not outlive it — a re-mount or a relaunch on the same session id would come up already '
      + 'blocked, with no write on the way to clear the flag',
  },
];

for (const { file, call, why } of HOOKS) {
  test(`${file} calls ${call}…) — ${why}`, () => {
    assert.ok(code(file).includes(call), `${file} no longer calls ${call}…): ${why}`);
  });
}

// Derived from HOOKS rather than typed out a second time: a hand-written copy of a list beside the list
// is exactly what drifts (`.claude/rules/guards-and-scripts.md`), and this one would drift SILENTLY —
// a hook added above and forgotten here is simply unchecked.
test('every hooked name is actually declared in shell/prompt-staging.js', () => {
  const staging = code('src/renderer/shell/prompt-staging.js');
  for (const name of [...new Set(HOOKS.map(h => h.call.replace('(', '')))]) {
    assert.ok(new RegExp(`function\\s+${name}\\s*\\(`).test(staging),
      `${name} is called elsewhere but no longer declared here — the renderer shares one lexical scope, `
      + 'so that is a ReferenceError nothing else would catch');
  }
});

// --- The dirty-line signal has ONE seam: `sendSessionInput` ---
//
// Two earlier shapes were measured wrong in a running app, and this guard is what stops a third:
//
//   1. an explicit call from `terminal.onData` — but that is ONE writer of a session's prompt line out of
//      several, and a staged prompt was submitted on top of text another writer had put there;
//   2. a wrapper installed over `window.api.sendInput` — which cannot work at all. The preload publishes
//      that object through `contextBridge.exposeInMainWorld` and every window runs `contextIsolation`, so
//      the assignment is silently ignored: no throw, no warning, and `String(window.api.sendInput)` still
//      reads `function () { [native code] }` in a live window.
//
// So the seam is an ordinary renderer function that every writer calls. That is held together by
// convention, which means it is held together by THIS TEST: a new writer reaching straight for the
// preload compiles, runs, and silently reopens the gap.
//
// `ALLOWED_DIRECT` is an allow-list, so it carries a reason per entry and is checked BOTH ways
// (`.claude/rules/guards-and-scripts.md`): an entry that stops calling the preload fails too, or the list
// only ever grows.
const ALLOWED_DIRECT = {
  'src/renderer/shell/prompt-staging.js':
    'the seam itself forwards to the preload here, and the staged-prompt delivery deliberately goes '
    + 'around the seam so it does not classify its own submit as the user’s line',
};

// Every `.js` under src/renderer, comments stripped — a violation can hide in a file that does not exist
// yet, so this walks the tree rather than naming the writers (`.claude/rules/guards-and-scripts.md`).
function rendererSources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const raw = fs.readFileSync(full, 'utf8');
      // A generated bundle is not source, told apart by a property rather than by name.
      if (raw.split(/\r?\n/).some(line => line.length > 20000)) continue;
      out.push({ rel: path.relative(ROOT, full).split(path.sep).join('/'), code: stripComments(raw) });
    }
  };
  walk(path.join(ROOT, 'src', 'renderer'));
  return out;
}

test('the input seam exists and forwards to the preload', () => {
  const staging = code('src/renderer/shell/prompt-staging.js');
  assert.ok(/function\s+sendSessionInput\s*\(/.test(staging),
    'sendSessionInput is the renderer’s one way into a session’s stdin — every writer calls it');
  assert.ok(/window\.api\.sendInput\(/.test(staging), 'and it has to actually reach the preload');
});

test('nothing outside the seam calls window.api.sendInput — a new writer would reopen the gap', () => {
  const offenders = rendererSources()
    .filter(f => f.code.includes('window.api.sendInput('))
    .map(f => f.rel)
    .filter(rel => !Object.prototype.hasOwnProperty.call(ALLOWED_DIRECT, rel));
  assert.deepEqual(offenders, [],
    'call sendSessionInput(sessionId, data) (src/renderer/shell/prompt-staging.js) instead: it forwards '
    + 'to the preload AND records what the write did to that session’s prompt line. Writing straight to '
    + 'window.api.sendInput leaves the prompt line unobserved, and a staged prompt is then delivered on '
    + 'top of whatever this writer just put there — measured twice in a running app');
});

test('every ALLOWED_DIRECT entry still calls the preload directly', () => {
  // The other direction: an exemption whose reason has gone away must fail rather than sit there.
  for (const [rel, why] of Object.entries(ALLOWED_DIRECT)) {
    assert.ok(code(rel).includes('window.api.sendInput('),
      `${rel} is exempt from the seam ("${why}") but no longer calls window.api.sendInput — drop the entry`);
  }
});

test('the writers reach for the seam, not for the preload', () => {
  // Named on purpose, unlike the scan above: these are the files that HAVE a writer today, and one of
  // them quietly losing its call is the regression the scan cannot see (it only refuses the wrong call,
  // it cannot notice a right one disappearing).
  const WRITERS = {
    'src/renderer/app.js': 'the seed insert on a fresh session',
    'src/renderer/terminal/terminal-context-menu.js': 'paste, variable insert, and paste-and-submit',
    'src/renderer/terminal/terminal-manager.js': 'keystrokes, the newline chord and the space key',
  };
  for (const [rel, what] of Object.entries(WRITERS)) {
    assert.ok(code(rel).includes('sendSessionInput('),
      `${rel} writes a session's stdin (${what}) and must go through the seam`);
  }
});

// The delivery goes through the input path that already exists. A new IPC surface or a new preload method
// is explicitly out of scope, and a queue that grew its own channel would be invisible to every guard the
// main process has.
test('delivery uses the existing sendInput path and nothing else', () => {
  const staging = code('src/renderer/shell/prompt-staging.js');
  const apiCalls = staging.match(/window\.api\.[A-Za-z_$][\w$]*/g) || [];
  assert.deepEqual([...new Set(apiCalls)], ['window.api.sendInput']);
  assert.ok(/window\.api\.sendInput\([^)]*'\\r'\)/.test(staging.replace(/\s+/g, ' '))
    || staging.includes("item.text + '\\r'"),
    'the submit has to be a carriage return — 0x0A leaves the prompt sitting in the input unsent');
});

// The gate has ONE source for the status. Re-deriving it from the raw maps is how two surfaces start
// disagreeing about what a session is doing (#254), and it is the specific mistake the issue calls out.
test('the gate reads getSessionStatus rather than re-deriving a status', () => {
  const staging = code('src/renderer/shell/prompt-staging.js');
  assert.ok(staging.includes('getSessionStatus('), 'the status must come from the shared helper');
  for (const raw of ['activePtyIds', 'sessionBusyState', 'attentionSessions', 'responseReadySessions']) {
    assert.ok(!staging.includes(raw),
      `prompt-staging.js reads ${raw} directly — the status model is the one answer to what a session is doing`);
  }
});

// The pure module stays pure: the issue asks for it, and it is the only part of the feature that can be
// tested at all.
test('the queue module holds no timer, no DOM and no IPC', () => {
  const queue = code('src/renderer/shell/prompt-queue.js');
  for (const forbidden of ['setTimeout', 'setInterval', 'document', 'window.api', 'requestAnimationFrame']) {
    assert.ok(!queue.includes(forbidden),
      `prompt-queue.js names ${forbidden} — it is the pure half and the caller passes its answers in`);
  }
});

// A new control inherits no styling (CLAUDE.md reflex 8): the chip is a <button>, so `.session-detail-pill`
// alone would leave it with the browser's own font and no pointer cursor.
test('the staged chip has a rule of its own in style.css', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'style.css'), 'utf8');
  assert.ok(css.includes('.session-staged-chip {'), 'the chip class must be styled, not inherited');
  const rule = css.slice(css.indexOf('.session-staged-chip {'));
  const body = rule.slice(0, rule.indexOf('}'));
  assert.ok(/font:\s*inherit/.test(body), 'a bare <button> keeps the browser font without this');
  assert.ok(/cursor:\s*pointer/.test(body), 'it is clickable, so it has to look clickable');
});
