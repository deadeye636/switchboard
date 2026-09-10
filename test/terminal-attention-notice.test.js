'use strict';
// The terminal's own attention caption (#615) — "this session is asking you something", said where the
// user is typing.
//
// WHY THIS EXISTS: the renderer has no behavioural test for most of itself, and every part of this
// feature is the kind that ships green and is wrong on the first click. So the real sources are loaded
// into one jsdom vm — the way the renderer's classic scripts actually share a scope — and driven end to
// end: a signal goes in through `applyAttention`, and a keystroke goes out through `sendSessionInput`,
// the renderer's one way into a session's stdin. Nothing here stubs the module under test.
//
// THREE CLAIMS THAT NEEDED PINNING, and none of them is visible to any other test:
//   * the caption COSTS NO LAYOUT. It is the container's own `::after`, so no border, no padding and no
//     extra child reach the box FitAddon measures. A later hand tidying that into something with a box
//     would break every terminal fit and no terminal test would say a word, so the stylesheet is read
//     here and held to exactly one block;
//   * it goes on the first WRITE, not on a focus change and not on a status change. Focusing a session
//     settles the inbox (`settleAttentionState`), so a caption that read `attentionSessions` would vanish
//     precisely when the user arrives to look at it;
//   * it never swallows input. The byte reaches `sendInput` in the same test that watches the caption go.
//
// WHAT THIS HARNESS CANNOT SHOW: whether the caption is legible, and what it lands on over a running
// TUI. Those are the click. What it can show is that the wiring exists, that the state has the life it
// was decided to have, and that the stylesheet still makes the layout claim this file's comments make.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { stripComments } = require('./helpers/strip-comments');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// The wiring check below is the ONLY guard for three of the five call sites — the harness calls those
// three itself rather than running `createTerminalEntry` / `destroySession` / `rekeySessionState` — so it
// reads the source with the prose dropped (CLAUDE.md reflex 14). Every name it looks for is also written
// in a comment beside it, and a pass over the raw text would count the comment as the wire.
const code = (rel) => stripComments(read(rel));

const SID = 'session-a';

/**
 * Build the shared scope these classic scripts run in.
 *
 * The four real sources, in the order `index.html` loads them, plus the app.js state the attention engine
 * mutates at call time. `openSessions` is the map that answers "does this window hold a terminal for that
 * session" — the test mounts into it the way `createTerminalEntry` does.
 */
function setup({ active = null } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only',
  });
  const { window } = dom;
  const ctx = dom.getInternalVMContext();
  const sent = [];

  // app.js state the engine reads and mutates.
  window.attentionSessions = new Set();
  window.attentionReason = new Map();
  window.responseReadySessions = new Set();
  window.sessionBusyState = new Map();
  window.activeSessionId = active;
  window.sessionRowEls = () => [];
  window.refreshSessionStatusViews = () => {};
  window.appGlobalSettings = { notifications: {} };
  // The mounted terminals of THIS window — app.js state (`app.js`, not terminal-manager.js, which only
  // works on it), and the map the notice asks whether there is an element to paint.
  window.openSessions = new Map();
  window.api = { sendInput: (id, data) => { sent.push({ id, data }); } };

  const run = (rel) => vm.runInContext(read(rel), ctx, { filename: rel });
  run('src/shared/attention-source.js');
  run('src/renderer/shell/attention-engine.js');
  run('src/renderer/terminal/terminal-attention-notice.js');
  run('src/renderer/shell/prompt-queue.js');
  run('src/renderer/shell/prompt-staging.js');

  /**
   * Mount a terminal for a session, the way `createTerminalEntry` does: put the entry in `openSessions`
   * and nothing else. There is no paint at mount any more — a notice can only exist for a session this
   * window already holds, so there was never anything for a fresh element to inherit.
   */
  const mount = (sessionId = SID) => {
    const el = window.document.createElement('div');
    el.className = 'terminal-container';
    window.document.body.appendChild(el);
    window.openSessions.set(sessionId, { session: { sessionId }, element: el });
    return el;
  };

  // A top-level `const` in a classic script is lexical, not a property of the global object — it is
  // reachable from the shared scope and NOT as `ctx.NAME`. This is how the renderer's own files read each
  // other's constants, so it is how the test reads them too.
  const constant = (name) => vm.runInContext(name, ctx);

  const captioned = (el) => el.classList.contains('terminal-attention');
  const caption = (el) => el.dataset.attentionCaption;
  return { window, ctx, sent, mount, captioned, caption, constant, destroy: () => window.close() };
}

/** A hook-shaped attention signal, normalized the way `session-ipc.js` hands one over. */
const hookSignal = (reason) => ({ kind: 'needs-attention', reason, source: 'hook' });

test('a mounted terminal carries no caption until its session asks for something', () => {
  const h = setup();
  const el = h.mount();
  assert.equal(h.captioned(el), false);
  assert.equal(h.caption(el), undefined);
  h.destroy();
});

test('an attention signal captions the terminal with the reason', () => {
  const h = setup();
  const el = h.mount();
  h.ctx.applyAttention(SID, hookSignal('Claude needs permission to use Bash'));
  assert.equal(h.captioned(el), true);
  assert.equal(h.caption(el), 'Claude needs permission to use Bash');
  h.destroy();
});

test('the caption is the SAME reason the inbox kept, never a second derivation', () => {
  const h = setup();
  const el = h.mount();
  h.ctx.applyAttention(SID, hookSignal('Claude needs your approval for the plan'));
  // `applyAttention` reduces hook-over-osc9 before it stores; the caption has to be the reduced winner,
  // or the caption and the inbox row would name two different things after a second signal.
  h.ctx.applyAttention(SID, { kind: 'needs-attention', reason: 'a spinner frame', source: 'osc9' });
  assert.equal(h.window.attentionReason.get(SID).reason, 'Claude needs your approval for the plan');
  assert.equal(h.caption(el), 'Claude needs your approval for the plan',
    'the osc9 heuristic loses to the hook in both places or in neither');
  h.destroy();
});

test('a session the user is ALREADY looking at is captioned too, and still gets no inbox flag', () => {
  const h = setup({ active: SID });
  const el = h.mount();
  h.ctx.applyAttention(SID, hookSignal('Claude needs permission'));
  assert.equal(h.captioned(el), true, 'the terminal is the surface they type into, focused or not');
  assert.equal(h.window.attentionSessions.size, 0,
    'a focused session still needs no inbox flag — the caption does not change that rule');
  h.destroy();
});

test('the first write through the input seam takes the caption down, and the byte still goes out', () => {
  const h = setup();
  const el = h.mount();
  h.ctx.applyAttention(SID, hookSignal('Claude needs permission'));
  h.ctx.sendSessionInput(SID, 'h');
  assert.equal(h.captioned(el), false);
  assert.equal(h.caption(el), undefined);
  assert.deepEqual(h.sent, [{ id: SID, data: 'h' }],
    'nothing about the notice may block, buffer or reorder what the user sent');
  h.destroy();
});

test('a paste through the seam takes it down as readily as a key — every writer is a write', () => {
  const h = setup();
  const el = h.mount();
  h.ctx.applyAttention(SID, hookSignal('Claude needs permission'));
  h.ctx.sendSessionInput(SID, '\x1b[200~pasted text\x1b[201~');
  assert.equal(h.captioned(el), false);
  h.destroy();
});

test('a write into ANOTHER session leaves this one captioned', () => {
  const h = setup();
  const el = h.mount();
  h.mount('session-b');
  h.ctx.applyAttention(SID, hookSignal('Claude needs permission'));
  h.ctx.sendSessionInput('session-b', 'x');
  assert.equal(h.captioned(el), true);
  h.destroy();
});

test('a NEW attention event after the keystroke brings the caption back', () => {
  const h = setup();
  const el = h.mount();
  h.ctx.applyAttention(SID, hookSignal('Claude needs permission'));
  h.ctx.sendSessionInput(SID, '\r');
  assert.equal(h.captioned(el), false);
  h.ctx.applyAttention(SID, hookSignal('Claude needs input'));
  assert.equal(h.captioned(el), true);
  assert.equal(h.caption(el), 'Claude needs input');
  h.destroy();
});

test('a signal that carries no reason captions the neutral sentence rather than saying nothing', () => {
  const h = setup();
  const el = h.mount();
  h.ctx.applyAttention(SID, { kind: 'needs-attention', reason: '', source: 'osc9' });
  assert.equal(h.captioned(el), true, 'an unmeasured reason is a wording question, never a missing caption');
  assert.equal(h.caption(el), h.constant('TERMINAL_ATTENTION_NEUTRAL'));
  assert.match(h.caption(el), /asking you something/);
  h.destroy();
});

test('a terminal-binding reason is carried the same way — no backend is named anywhere in this', () => {
  const h = setup();
  const el = h.mount();
  // The `bind` source is a backend-neutral vocabulary (#529): the route that receives it does not know
  // which CLI sent it, and neither does the caption.
  const signal = h.ctx.classifyAttentionSignal({ source: 'bind', payload: { kind: 'waiting', prompt_kind: 'confirm' } });
  h.ctx.applyAttention(SID, signal);
  assert.equal(h.caption(el), 'Waiting for you to confirm');
  h.destroy();
});

test('a long reason is collapsed to one line and cut — the caption is a corner, not a transcript', () => {
  const h = setup();
  const el = h.mount();
  h.ctx.applyAttention(SID, hookSignal('word '.repeat(200) + '\n\nand more'));
  const text = h.caption(el);
  assert.ok(text.length <= h.constant('TERMINAL_ATTENTION_CAPTION_MAX'), `caption is ${text.length} chars`);
  assert.ok(text.endsWith('…'));
  assert.equal(text.includes('\n'), false);
  h.destroy();
});

test('a session this window does not hold is not remembered at all', () => {
  // `src/app/hooks.js` sends every attention signal to the MAIN window, holder or not. Keeping one for a
  // terminal this window cannot paint is how a caption came back for a question answered somewhere else:
  // the other window clears on its own keystroke, and this one never sees that keystroke.
  const h = setup();
  h.ctx.applyAttention(SID, hookSignal('Claude needs permission'));
  assert.equal(h.ctx.terminalAttentionNoticeFor(SID), null, 'nothing kept for a terminal we do not hold');
  const el = h.mount();
  assert.equal(h.captioned(el), false,
    'and mounting one later must not resurrect it — only a NEW signal captions a terminal');
  h.destroy();
});

test('the map is bounded by the terminals on screen, not by everything this window has heard', () => {
  const h = setup();
  for (let i = 0; i < 50; i++) h.ctx.applyAttention(`ghost-${i}`, hookSignal('Claude needs permission'));
  const el = h.mount();
  h.ctx.applyAttention(SID, hookSignal('Claude needs permission'));
  assert.equal(h.captioned(el), true, 'the held one is still captioned');
  for (let i = 0; i < 50; i++) {
    assert.equal(h.ctx.terminalAttentionNoticeFor(`ghost-${i}`), null, 'and no unheld session is retained');
  }
  h.destroy();
});

test('the notice adds NO child node — the caption is an attribute the stylesheet prints', () => {
  const h = setup();
  const el = h.mount();
  h.ctx.applyAttention(SID, hookSignal('<img src=x onerror=alert(1)>'));
  assert.equal(el.children.length, 0, 'a child inside .terminal-container is a child FitAddon can find');
  assert.equal(el.textContent, '', 'and a reason is arbitrary text from a CLI — it never becomes markup');
  assert.equal(h.caption(el), '<img src=x onerror=alert(1)>');
  h.destroy();
});

test('the record-only path captions the terminal of a window that does not own the inbox', () => {
  const h = setup();
  const el = h.mount();
  h.ctx.recordAttentionSignal(SID, hookSignal('Claude needs permission'));
  assert.equal(h.captioned(el), true, 'a detached terminal is exactly where somebody is typing');
  assert.equal(h.window.attentionSessions.size, 0, 'and it still raises nothing (#390/#395)');
  h.destroy();
});

test('a fork moves the caption onto the new session id, so the keystroke can still reach it', () => {
  const h = setup();
  const el = h.mount();
  h.ctx.applyAttention(SID, hookSignal('Claude needs permission'));
  // What `rekeySessionState` does to the terminal entry, then to this belief.
  const entry = h.window.openSessions.get(SID);
  h.window.openSessions.delete(SID);
  h.window.openSessions.set('session-new', entry);
  h.ctx.rekeyTerminalAttentionNotice(SID, 'session-new');
  assert.equal(h.captioned(el), true, 'the caption follows the element');
  h.ctx.sendSessionInput('session-new', 'y');
  assert.equal(h.captioned(el), false, 'and the new id is what takes it down');
  h.destroy();
});

test('the teardown forgets the notice, so a re-opened terminal is not re-captioned', () => {
  const h = setup();
  const el = h.mount();
  h.ctx.applyAttention(SID, hookSignal('Claude needs permission'));
  h.ctx.clearTerminalAttentionNotice(SID); // what destroySession calls
  assert.equal(h.ctx.terminalAttentionNoticeFor(SID), null);
  const fresh = h.mount();
  assert.equal(h.captioned(fresh), false);
  assert.equal(h.captioned(el), false);
  h.destroy();
});

// --- The layout claim, held against the stylesheet ---
//
// Everything above would still pass if the caption sat in a real box on `.terminal-container` itself — and
// that version clips the bottom row of every terminal in the app (#59/#81 are what that costs). jsdom
// applies no stylesheet, so the only way to hold the claim is to read it.

/** The declarations of a top-level rule, by its exact head. Plain CSS, so the first `}` ends the block. */
function ruleBlock(css, head) {
  const at = css.indexOf('\n' + head + ' {');
  assert.notEqual(at, -1, `no rule "${head} {" in style.css`);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

/**
 * The comments taken out of a stylesheet, by scanning rather than by pattern.
 *
 * `test/helpers/strip-comments.js` is the shared answer for JAVASCRIPT and is the wrong tool here: it
 * decides whether a `/` opens a regular expression, and CSS writes `font: 12px/1.5` and `url(https://…)`
 * where JS would not — so it would swallow live declarations. A pair of regexes is refused outright
 * (CLAUDE.md reflex 14, `test/strip-comments-shape.test.js`), and rightly. What is left is this walk.
 *
 * **It knows about STRINGS, and that is not a nicety.** An earlier version scanned for `/*` alone and
 * described the gap as costing "a false positive rather than a miss". Measured, it is the opposite and
 * therefore the dangerous direction: `.a { content: "/*"; }` opens a comment that runs to the next real
 * `*\/` and takes every rule in between with it, silently — which is the exact failure `strip-comments.js`
 * exists to prevent, one language over. So the walk takes whichever comes first, a comment opener or a
 * quote, and copies a string through untouched. Backslash escapes inside a string are stepped over; an
 * unterminated one is copied to the end rather than swallowing the rest of the file.
 */
function withoutCssComments(text) {
  let out = '';
  let at = 0;
  for (;;) {
    const candidates = [text.indexOf('/*', at), text.indexOf('"', at), text.indexOf("'", at)]
      .filter(i => i !== -1);
    if (!candidates.length) return out + text.slice(at);
    const next = Math.min(...candidates);
    if (text.startsWith('/*', next)) {
      out += text.slice(at, next);
      const close = text.indexOf('*/', next + 2);
      if (close === -1) return out;           // unterminated comment: the rest is prose
      at = close + 2;
      continue;
    }
    // A string. Copy it through verbatim, so nothing inside it can open a comment.
    const quote = text[next];
    let i = next + 1;
    while (i < text.length && text[i] !== quote) i += (text[i] === '\\' ? 2 : 1);
    out += text.slice(at, Math.min(i + 1, text.length));
    at = i + 1;
  }
}

/**
 * Every SELECTOR in a stylesheet that names this state, however it is spelled.
 *
 * Reads the whole PRELUDE of each rule — everything between the previous rule and its `{` — and keeps it
 * if the state is named anywhere in it. The first version of this guard matched a token and required `{`
 * or `,` right after it, which meant it only ever saw the state as the LAST compound of a selector; the
 * rule a later hand would actually write is `.terminal-container.terminal-attention .xterm { padding-top:
 * 18px }`, to make room for the caption, and that one walked straight past. It is also the most expensive
 * rule possible here: `terminalVerticalPadding` adds `.xterm`'s own padding into the number `safeFit`
 * clamps rows against, so it re-fits every captioned terminal.
 *
 * `paint` sets a class AND a data attribute, so both spellings are matched. Comments are removed first,
 * so prose naming the state is not a rule.
 *
 * **A block that HOLDS BLOCKS is descended into, not stepped over**, and this walk has had that hole
 * twice. First for at-rules: it jumped past the `{` to the first `}` inside, which is the end of the
 * first NESTED rule, so everything in a `@media` block was skipped. Then, once that was answered by
 * testing the prelude for a leading `@`, the same hole stayed open for CSS NESTING — Chromium supports
 * `.terminal-container { .terminal-attention .xterm { padding-top: … } }`, which carries no `@` and is
 * the very rule this header calls the most expensive one possible. So the test is structural instead:
 * descend whenever the next `{` arrives before the next `}`. That covers both, needs no list of at-rules
 * to keep current, and keeps the walk's depth honest past the first `@keyframes`, which is what makes
 * every prelude after it a real selector.
 *
 * One limit remains, and it is stated rather than guessed at: a rule that reaches the state some third
 * way — a parent class toggled elsewhere, an attribute nothing here knows about — is not seen at all.
 * Where a prelude is imprecise (the text after a nested block's closing brace joins the next selector)
 * it errs towards catching, which is the direction a duplication guard is supposed to err in.
 */
const STATE_TOKEN = /terminal-attention|attention-caption/;
function stateHeads(css) {
  const text = withoutCssComments(css);
  const out = [];
  let at = 0;
  for (;;) {
    const open = text.indexOf('{', at);
    if (open === -1) return out;
    // The `}` that closed a nested block is still in front of the next selector, because the descent
    // below steps INTO an at-rule and never consumes its closing brace. Detection does not care, but the
    // exact-list assertion downstream does: without this a legitimate rule that happens to be the first
    // one after an `@media` block reports its head as `"} .terminal-container…"` and fails with a message
    // about a rule nobody wrote.
    const prelude = text.slice(at, open).replace(/^[\s}]+/, '').trim();
    if (STATE_TOKEN.test(prelude)) out.push(prelude);
    // Does this block hold blocks? Step inside it if so, so its nested rules are read like every other
    // one. Structural rather than a list of at-rules: `@media` and a nested `.a { .b { } }` are the same
    // shape, and only this test sees both. A block of plain declarations has its `}` first and is
    // stepped over, which is what keeps `@font-face` and a keyframe step from producing noise.
    const close = text.indexOf('}', open + 1);
    if (close === -1) return out;
    const nested = text.indexOf('{', open + 1);
    if (nested !== -1 && nested < close) { at = open + 1; continue; }
    at = close + 1;
  }
}

test('the guard sees each shape a rule for this state would take', () => {
  // Written before the tree needed them (.claude/rules/guards-and-scripts.md): a pattern checked only
  // against a clean tree pins nothing, and this list is where the previous version was found to have a
  // hole. Every one of these costs layout — the last two through `.xterm`'s padding, which is the one
  // FitAddon subtracts.
  for (const shape of [
    '.terminal-container.terminal-attention { border: 2px solid red; }',
    '.terminal-attention { padding: 2px; }',
    '.terminal-container[data-attention-caption] { width: 50%; }',
    '.terminal-container.terminal-attention .xterm { padding-top: 18px; }',
    'body.x .terminal-attention .foo { margin: 4px; }',
    '@media (prefers-reduced-motion: reduce) { .terminal-attention { padding: 2px; } }',
    '@supports (display: grid) { .terminal-container.terminal-attention .xterm { padding-top: 18px; } }',
    '.terminal-container { .terminal-attention .xterm { padding-top: 18px; } }',
    '.terminal-container.terminal-attention { .xterm { padding-top: 18px; } }',
  ]) {
    assert.equal(stateHeads(shape).length, 1, `the scan misses ${shape}`);
  }
  // …and the head it reports is the SELECTOR, with no brace left over from a block that closed in front
  // of it. Only detection needs the walk to be loose; the exact list below needs it to be exact.
  assert.deepEqual(
    stateHeads('@media (min-width: 1px) { .a { color: red; } } .terminal-attention { padding: 1px; }'),
    ['.terminal-attention'],
    'a rule sitting after an at-rule block must report its own selector, not the brace before it');
  for (const prose of [
    '/* terminal-attention is described here, in prose */',
    '/* see .terminal-container.terminal-attention, and .drag-over */',
    ['/* terminal-attention */', '.unrelated { color: red; }'].join(String.fromCharCode(10)),
  ]) {
    assert.deepEqual(stateHeads(prose), [], `a comment is not a rule: ${prose}`);
  }
});

const CAPTION_RULE = '.terminal-container.terminal-attention::after';

test('the attention state has exactly one rule, and it is a pseudo-element', () => {
  const css = read('src/renderer/style.css');
  assert.deepEqual(stateHeads(css), [CAPTION_RULE],
    'a SECOND rule for this state — a rule on the CONTAINER above all — is how an overlay grows a layout '
   + 'box. A second one is not forbidden, it is just not silent: add it to this list with what it '
   + 'declares. It must set no border, padding, width, height, margin or inset, and it must not reach '
   + '`.xterm`, whose padding FitAddon subtracts. An `outline` with a negative `outline-offset` is none '
   + 'of those and is what `.terminal-container.drag-over` already uses, so that route is open. '
   + '(This list held two until the frame around the terminal was dropped — see the module header.)');
});

test('the attention rule cannot take a click or a key from the terminal', () => {
  const css = read('src/renderer/style.css');
  const block = ruleBlock(css, CAPTION_RULE);
  assert.match(block, /position:\s*absolute/, `${CAPTION_RULE} must not participate in layout`);
  assert.match(block, /pointer-events:\s*none/, `${CAPTION_RULE} must never swallow input — that is #614's line`);
});

test('the caption sits at the TOP of the terminal, never over the middle', () => {
  // The middle is where the CLI draws the dialog this caption describes, so "centred" is horizontal
  // only. Pinned because `top` and `transform` are one edit away from each other and the wrong one
  // covers exactly what the user has to read.
  const block = ruleBlock(read('src/renderer/style.css'), CAPTION_RULE);
  assert.match(block, /top:\s*\d/, 'anchored to the top edge');
  assert.doesNotMatch(block, /(^|[;{])\s*bottom\s*:/, 'not floated off the bottom either');
  assert.match(block, /left:\s*50%/, 'centred horizontally');
  assert.match(block, /transform:\s*translateX\(-50%\)/,
    'centred by moving the painted box, not by a margin — a margin would want a layout box');
});

test('the terminal container itself still declares no border and zero padding', () => {
  const css = read('src/renderer/style.css');
  const block = ruleBlock(css, '.terminal-container');
  assert.doesNotMatch(block, /border/, 'a border on the container is a row FitAddon proposes and cannot draw');
  assert.match(block, /padding:\s*0/, 'padding lives on .xterm — see the block itself');
  assert.doesNotMatch(block, /(^|[;{])\s*width\s*:/, 'the container is sized by its inset, not by a width');
});

// --- The wiring, read as text ---
//
// The harness above proves the LOGIC of each seam; it cannot prove the app reaches them, because it calls
// them itself. This is the other half, in the shape `test/prompt-staging-wiring.test.js` uses.

const MODULE = 'src/renderer/terminal/terminal-attention-notice.js';

// Every name the module puts into the shared scope. The reverse scan below refuses all of them outside
// the sites listed in WIRED, which is what turns the header's "and nothing else does" from a claim into
// a check — `test/prompt-staging-wiring.test.js` holds its own seam the same way.
const NOTICE_NAMES = [
  'noteTerminalAttention',
  'clearTerminalAttentionNotice',
  'paintTerminalAttentionNotice',
  'rekeyTerminalAttentionNotice',
  'terminalAttentionNoticeFor',
];

const WIRED = [
  ['src/renderer/shell/attention-engine.js', 'noteTerminalAttention', 'the signal has to reach the terminal'],
  ['src/renderer/shell/prompt-staging.js', 'clearTerminalAttentionNotice', 'the caption goes on the first write, through the one input seam'],
  ['src/renderer/terminal/terminal-manager.js', 'clearTerminalAttentionNotice', 'the teardown has to forget it'],
  ['src/renderer/shell/session-ipc.js', 'clearTerminalAttentionNotice', 'a dead pty is asking nothing — the sentence goes with the process'],
  ['src/renderer/shell/session-ipc.js', 'rekeyTerminalAttentionNotice', 'a fork moves the caption with the entry'],
  ['src/renderer/app.js', 'clearTerminalAttentionNotice', 'a dismissal is the user answering “gone”'],
];

test('every caller the notice depends on is still there', () => {
  for (const [rel, call, why] of WIRED) {
    assert.ok(code(rel).includes(call + '('), `${rel} no longer calls ${call} — ${why}`);
  }
});

/** Every renderer script, so the scan below covers a file nobody has written yet. */
function rendererSources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) rendererSources(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('nothing outside the wired sites calls into the notice', () => {
  const root = path.join(ROOT, 'src', 'renderer');
  const allowed = new Set(WIRED.map(([rel, call]) => `${rel}::${call}`));
  for (const full of rendererSources(root)) {
    const rel = path.relative(ROOT, full).split(path.sep).join('/');
    if (rel === MODULE) continue;
    const raw = fs.readFileSync(full, 'utf8');
    // A generated bundle is not source: the three under src/ have longest lines in the hundreds of
    // thousands of characters, against 3835 for the longest hand-written one. Told apart by that
    // property rather than by name, so the next bundle is covered the day it is built.
    if (raw.split('\n').some(line => line.length > 20000)) continue;
    const src = stripComments(raw);
    for (const name of NOTICE_NAMES) {
      if (!src.includes(name + '(')) continue;
      assert.ok(allowed.has(`${rel}::${name}`),
        `${rel} calls ${name}() and is not one of the notice's wired sites. The module header names a `
      + `closed list of callers (#615) and this is what holds it: add the call to WIRED here with the `
      + `reason it belongs, or reach the notice through one of the seams that already exists.`);
    }
  }
});

test('the notice module taps no input of its own', () => {
  const src = code('src/renderer/terminal/terminal-attention-notice.js');
  assert.doesNotMatch(src, /addEventListener|onData|sendInput/,
    'the keystroke reaches this file through sendSessionInput (shell/prompt-staging.js) and no other way — '
  + 'a second input tap is the defect that seam exists to prevent');
});

test('the notice is registered as a renderer script the way every other one is', () => {
  const order = JSON.parse(read('test/fixtures/script-order.json'));
  assert.ok(order['index.html'].includes('terminal-attention-notice.js'),
    'adding a renderer file is a three-file change — the tag, this fixture, and ALLOWED_BINDINGS');
  assert.ok(read('src/renderer/index.html').includes('terminal/terminal-attention-notice.js'));
});
