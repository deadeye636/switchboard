'use strict';
// What the welcome tour's Documents figure DRAWS for a directory name the app will not use (#630).
//
// WHY THIS EXISTS:
//   The Documents pane promises "where the next plan and the next handoff will be written, as you type
//   the names". `planDir`/`handoffDir` are not free paths — a name that climbs out of the project, or one
//   that resolves to the project itself, is replaced by the default — so a figure that draws what was
//   typed makes a promise the app does not keep. Two live defects came out of exactly that, and neither
//   was visible to a test:
//     - an ABSOLUTE name was drawn as a child of the invented `my-project/`, which is a claim the tour
//       cannot make: it has no project, so it genuinely cannot say where such a path lands;
//     - `docs/..` was captioned "outside the project" when it is the project root, because the wording
//       came from a local test for `..` instead of from the shared rule.
//   The whole surface was guarded by source regexes, which is why both shipped. This file asserts on the
//   RENDERED SVG instead: the name in the tree and the caption under it, for each shape of value.
//
//   Asserting the drawn NAME is the half that matters most. A test that checked only the caption would
//   still pass with the typed value in the tree — that was the original defect, under a correct caption.
//
// HOW THE TOUR IS LOADED:
//   `index.html` is the page that carries the tour, and its full script list cannot be run here — it
//   pulls the whole renderer. Two of its scripts are loaded instead, in the order that page names them:
//   `../shared/convention-dir-name.js` (the rule) and `dialogs/welcome-tour.js` (the figure). Both paths
//   are READ OUT of index.html rather than written down, so a tour that stops loading the shared rule
//   fails here by name instead of quietly growing a second copy of it (CLAUDE.md reflex 12).
//   The tour is then really opened, the Documents pane really clicked, and each value really typed into
//   the pane's own input with an `input` event — so this is the click-time surface, not the source.
//
// WHAT IT STILL DOES NOT SEE:
//   Styling and colour. The caption turns amber for a replaced name (`fill="#d8a657"`); that it reads as
//   a warning rather than as prose is style.css and a human eye.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const REN = path.join(__dirname, '..', 'src', 'renderer');

// The defaults the figure falls back to. They are the `fallback` of the two controls in welcome-tour.js
// and the shipped default of the two settings; spelled here because the whole point is that a replaced
// name is drawn as THIS and not as what was typed.
const PLAN_DEFAULT = '.plans';
const HANDOFF_DEFAULT = '.handoffs';

// The three captions, as the pane words them. A copy of `DIR_PROBLEM_WORDS`, on purpose: the wording is
// what the user reads, so a change to it should have to be made twice and looked at once.
const CAP_NEUTRAL = 'both inside the project, both plain Markdown';
const CAP_ESCAPES = 'outside the project — the default is used instead';
const CAP_ROOT = 'the project itself — the default is used instead';
const CAP_ABSOLUTE = 'an absolute path is resolved against each project, so this figure cannot show it';

// The two scripts, read out of index.html so the list cannot drift away from the page. `endsWith` rather
// than an index: the page's order is asserted separately, and only these two are loaded.
function tourScripts() {
  const html = fs.readFileSync(path.join(REN, 'index.html'), 'utf8');
  const srcs = [...html.matchAll(/<script\s+src="([^"]+)"><\/script>/g)].map(m => m[1]);
  const rule = srcs.findIndex(s => s.endsWith('shared/convention-dir-name.js'));
  const tour = srcs.findIndex(s => s.endsWith('dialogs/welcome-tour.js'));
  assert.ok(rule >= 0, 'index.html must load src/shared/convention-dir-name.js — the tour asks it what a name means');
  assert.ok(tour >= 0, 'index.html must load dialogs/welcome-tour.js');
  assert.ok(rule < tour, 'the shared rule loads before the tour that calls it');
  return [srcs[rule], srcs[tour]];
}

// Everything the tour asks main for. `getSetting` is the only answer the open path consumes; the rest
// fall through to a callable proxy so an unrelated call cannot fail this file for the wrong reason.
// Nothing here is written: the tests dispatch `input`, which redraws the figure, never `change`.
function makeApi() {
  const anyCall = () => new Proxy(function () {}, {
    get: (t, p) => (p === 'then' ? undefined : anyCall()),
    apply: () => Promise.resolve({ ok: true }),
  });
  const target = {
    getSetting: async () => ({}),
    mergeSetting: async () => ({ ok: true }),
    setSetting: async () => ({ ok: true }),
    onSettingsChanged: () => {},
  };
  return new Proxy(target, {
    get: (t, p) => (p in t ? t[p] : (p === 'then' ? undefined : anyCall())),
  });
}

let session = null;

async function tour() {
  if (session) return session;
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;
  window.api = makeApi();

  const ctx = dom.getInternalVMContext();
  for (const rel of tourScripts()) {
    vm.runInContext(fs.readFileSync(path.join(REN, rel), 'utf8'), ctx, { filename: rel });
  }
  assert.equal(typeof window.welcomeTour?.open, 'function', 'welcome-tour.js registers window.welcomeTour');

  await window.welcomeTour.open();

  // Straight to the pane by its rail label. The index is not stable: a pane whose control no backend
  // declares is left out of the dialog, and this window has no backend registry at all.
  const rail = [...window.document.querySelectorAll('.wt-rail-item')]
    .find(el => el.textContent.includes('Documents'));
  assert.ok(rail, 'the tour must offer the Documents pane');
  rail.click();

  const inputs = [...window.document.querySelectorAll('.wt-rows input.wt-input-path')];
  assert.equal(inputs.length, 2, 'the Documents pane has a plans input and a handoffs input');
  session = { window, planInput: inputs[0], handoffInput: inputs[1] };
  return session;
}

after(() => { session?.window.close(); session = null; });

/**
 * Type both values into the pane's own inputs and read back what the figure now draws.
 *
 * Returns the two directory names as they appear in the tree plus the caption under it — read out of the
 * rendered SVG, which is the only place either of them exists.
 */
async function draw(planDir, handoffDir) {
  const t = await tour();
  const fire = (el, value) => {
    el.value = value;
    el.dispatchEvent(new t.window.Event('input', { bubbles: true }));
  };
  fire(t.planInput, planDir);
  fire(t.handoffInput, handoffDir);

  const svg = t.window.document.querySelector('.wt-figure-slot svg');
  assert.ok(svg, 'the Documents pane draws a figure');
  const lines = [...svg.querySelectorAll('text')].map(el => el.textContent);
  // The two directory rows are the only ones that open with a branch and end in a slash; the plan's own
  // file sits under a `│` and the handoff's under padding, so neither can be mistaken for one.
  const branch = (prefix) => {
    const hit = lines.find(l => l.startsWith(prefix) && l.endsWith('/'));
    assert.ok(hit, `the tree must draw a ${prefix} row`);
    return hit.slice(prefix.length, -1);
  };
  return { plan: branch('├─ '), handoff: branch('└─ '), caption: lines[lines.length - 1] };
}

test('an ordinary relative name is drawn as typed, with nothing to warn about', async () => {
  const fig = await draw('docs/plans', 'docs/handoffs');
  assert.equal(fig.plan, 'docs/plans');
  assert.equal(fig.handoff, 'docs/handoffs');
  assert.equal(fig.caption, CAP_NEUTRAL);
});

test('surrounding whitespace is not part of the name the figure draws', async () => {
  const fig = await draw('  docs/plans  ', '  docs/handoffs  ');
  assert.equal(fig.plan, 'docs/plans', 'the app trims the value, so the tree shows the trimmed name');
  assert.equal(fig.handoff, 'docs/handoffs');
  assert.equal(fig.caption, CAP_NEUTRAL);
});

test('a name that climbs out of the project is drawn as the default it will be replaced by', async () => {
  for (const typed of ['../plans', '..', '../../elsewhere']) {
    const fig = await draw(typed, HANDOFF_DEFAULT);
    assert.equal(fig.plan, PLAN_DEFAULT, `${typed} names something beside the project, so the app uses the default`);
    assert.equal(fig.caption, CAP_ESCAPES);
  }
});

test('a name that resolves to the project root says so — including one that climbs back in', async () => {
  for (const typed of ['.', './', 'docs/..', 'a/b/../..']) {
    const fig = await draw(typed, HANDOFF_DEFAULT);
    assert.equal(fig.plan, PLAN_DEFAULT, `${typed} is the project itself, which is neither feature's directory`);
    assert.equal(fig.caption, CAP_ROOT,
      `${typed} must not be captioned as escaping — that wording came from a second copy of the rule`);
  }
});

test('an absolute path is not drawn inside the invented project at all', async () => {
  for (const typed of ['/var/example/plans', '\\\\server\\share\\plans', 'Q:\\example\\plans']) {
    const fig = await draw(typed, HANDOFF_DEFAULT);
    assert.equal(fig.plan, PLAN_DEFAULT,
      `${typed} must not be drawn as a child of my-project/ — the tour has no project and cannot resolve it`);
    assert.equal(fig.caption, CAP_ABSOLUTE);
  }
});

test('a blank value is the default, and that is not a mistake', async () => {
  for (const typed of ['', '   ']) {
    const fig = await draw(typed, '');
    assert.equal(fig.plan, PLAN_DEFAULT, 'an empty setting simply means the default');
    assert.equal(fig.handoff, HANDOFF_DEFAULT);
    assert.equal(fig.caption, CAP_NEUTRAL, 'nothing is wrong with leaving it empty, so nothing is warned about');
  }
});

test('the handoffs input is judged too, and a good plans name stays as typed beside it', async () => {
  const escaping = await draw('docs/plans', '../packets');
  assert.equal(escaping.plan, 'docs/plans', 'the usable half is still drawn as the user typed it');
  assert.equal(escaping.handoff, HANDOFF_DEFAULT);
  assert.equal(escaping.caption, CAP_ESCAPES, 'a problem on the second input has to reach the caption');

  const root = await draw('docs/plans', 'packets/..');
  assert.equal(root.handoff, HANDOFF_DEFAULT);
  assert.equal(root.caption, CAP_ROOT);

  const absolute = await draw('docs/plans', '/var/example/packets');
  assert.equal(absolute.handoff, HANDOFF_DEFAULT);
  assert.equal(absolute.caption, CAP_ABSOLUTE);
});

test('both sides unusable: both rows fall back, and the caption names a problem', async () => {
  const fig = await draw('../plans', '../packets');
  assert.equal(fig.plan, PLAN_DEFAULT);
  assert.equal(fig.handoff, HANDOFF_DEFAULT);
  assert.equal(fig.caption, CAP_ESCAPES);
});
