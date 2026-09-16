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
const CAP_ABSOLUTE = 'an absolute path is resolved per project, so it cannot be drawn here';

// --- How wide a caption may be -----------------------------------------------------------------------
//
// The caption is centred at x=320 inside the figure's box, which spans 150 to 490 — 340 px. A longer one
// is not clipped; it hangs out of the drawn card on both sides, which reads as a mistake rather than as a
// limit. The absolute wording shipped at 345.7 px and did exactly that, after its CONTENT was already
// green here.
//
// jsdom lays out no text, so `getComputedTextLength` does not exist in this file and the width is summed
// from glyph advances instead. A character count was tried first and is not good enough: it permits
// 340/72 = 4.72 px per character while the captions in use measure 4.20 to 4.57, so an ordinary caption of
// 70 characters that happens to capitalise a word — `Markdown documents — Switchboard makes the missing
// folders when needed`, 349.6 px — passes a count and overflows the box.
//
// The table is Helvetica/Arial advance widths in units of 1/1000 em, which is what `font-family="sans-serif"`
// resolves to on the machine this was measured on. It reproduces every in-app `getComputedTextLength()`
// reading to within 0.1 px, and the calibration test below pins three of those readings so the table
// cannot drift away from the font. **A platform whose `sans-serif` is a wider face — DejaVu Sans is the
// usual Linux default — measures wider than this**, which is why the budget keeps a margin rather than
// using the whole box.
const GLYPH_W = (() => {
  const w = {
    ' ': 278, '!': 278, '"': 355, '#': 556, $: 556, '%': 889, '&': 667, "'": 191, '(': 333, ')': 333,
    '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278, ':': 278, ';': 278, '<': 584, '=': 584,
    '>': 584, '?': 556, '@': 1015, '[': 278, '\\': 278, ']': 278, '^': 469, _: 556, '`': 333, '{': 334,
    '|': 260, '}': 334, '~': 584, '—': 1000, '–': 556,
    A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833,
    N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
    a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833,
    n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  };
  for (const d of '0123456789') w[d] = 556;
  return w;
})();

// The figure's own font size, and its box, read out of the source rather than written down — narrow the
// rect and this guard tightens with it instead of passing over an overflow that now exists.
const TOUR_SRC = fs.readFileSync(path.join(REN, 'dialogs', 'welcome-tour.js'), 'utf8');
const FIGURE_BOX_PX = (() => {
  const fig = TOUR_SRC.slice(TOUR_SRC.indexOf('function figDirs'));
  const rect = /<rect x="(\d+)"[^>]*width="(\d+)"/.exec(fig);
  assert.ok(rect, 'figDirs() no longer draws a <rect> with an x and a width — re-read the box from it');
  return Number(rect[2]);
})();
const CAPTION_FONT_PX = (() => {
  const fig = TOUR_SRC.slice(TOUR_SRC.indexOf('function figDirs'));
  const size = /text-anchor="middle"/.test(fig) && /font-size="(\d+(?:\.\d+)?)"[^>]*text-anchor="middle"/.exec(fig);
  assert.ok(size, 'the caption is no longer a centred <text> with a font-size — re-read it from figDirs()');
  return Number(size[1]);
})();

/** The rendered width of a caption, in the figure's own user units. */
function captionWidth(text) {
  let units = 0;
  for (const ch of text) {
    const w = GLYPH_W[ch];
    assert.ok(w !== undefined, `the width table has no entry for ${JSON.stringify(ch)} — add it, measured, `
      + 'or this guard silently under-measures the caption that introduced it');
    units += w;
  }
  return (units / 1000) * CAPTION_FONT_PX;
}

// Nine tenths of the box. The margin is not a hedge about the arithmetic — that is exact — but about the
// face: `sans-serif` is whatever the machine resolves it to, and a wider one eats the difference.
const CAPTION_BUDGET_PX = FIGURE_BOX_PX * 0.9;
// One caption, two answers: when the fields fail for DIFFERENT reasons it stops naming a reason rather
// than naming one of them. "could be drawn" covers both classes — a value that leaves the project is one
// the app will not use, an absolute one may be perfectly good and is simply not placeable here.
const CAP_TWO = 'neither value could be drawn here — the defaults are shown instead';

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
  const caption = lines[lines.length - 1];
  const drawn = { plan: branch('├─ '), handoff: branch('└─ '), caption };
  // Measured LAST, after the structural reads above, so a caption that is merely too wide cannot mask a
  // tree that is wrong — the cosmetic assert would otherwise fail first in every test in this file.
  //
  // Every caption anything here renders is measured, so this costs no list: a wording nobody has written
  // yet is covered on the day a test draws it.
  const width = captionWidth(caption);
  assert.ok(width <= CAPTION_BUDGET_PX,
    `the caption measures ${width.toFixed(1)} px and the budget is ${CAPTION_BUDGET_PX.toFixed(1)}: `
    + `"${caption}". It is centred in the figure's ${FIGURE_BOX_PX} px box, so a longer one hangs out of `
    + 'the drawn card on both sides — not clipped, which is why nothing else notices. Shorten it, or widen '
    + `the rect in figDirs() and this budget follows. The last tenth of the ${FIGURE_BOX_PX} px is not room: `
    + 'it is held back because `sans-serif` is a different face on another machine');
  return drawn;
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

// The caption used to be `plan.why || handoff.why`, so with two DIFFERENT problems it announced the plans
// row's and said nothing at all about the handoffs row — which had been replaced just as silently as the
// value this whole figure was fixed for. Both rows still fall back; only the wording changes.
test('two different problems: the caption stops naming one of them (#630)', async () => {
  // All three unordered pairs, in BOTH orders — six. The ordered half is not decoration: the defect was
  // that one side won, so a table covering each pair once could have kept the bug for whichever side it
  // happened to put first.
  for (const [plan, handoff] of [
    ['../plans', 'packets/..'],             // escapes + root
    ['packets/..', '../plans'],             // …and root + escapes
    ['../plans', '/var/example/packets'],   // escapes + absolute
    ['/var/example/plans', '../packets'],   // …and absolute + escapes
    ['packets/..', '/var/example/packets'], // root + absolute
    ['/var/example/plans', 'packets/..'],   // …and absolute + root
  ]) {
    const fig = await draw(plan, handoff);
    assert.equal(fig.plan, PLAN_DEFAULT, `${plan} + ${handoff}: the plans row falls back`);
    assert.equal(fig.handoff, HANDOFF_DEFAULT, `${plan} + ${handoff}: the handoffs row falls back too`);
    assert.equal(fig.caption, CAP_TWO, `${plan} + ${handoff}: one reason must not stand for both`);
  }
});

// A blank field is not a problem, so it must not turn a single real problem into the two-problem wording.
test('a blank field beside a real problem still names that problem (#630)', async () => {
  // Both sides, because "blank" is the one value that has no problem word and could just as easily have
  // been read as a second problem — which would have turned every half-filled pane into the two-problem
  // wording. This one passes against the old code too; it is here so a future `if (plan.problem)` that
  // forgets the blank case fails by name.
  for (const [plan, handoff, caption] of [
    ['', '../packets', CAP_ESCAPES],
    ['../plans', '', CAP_ESCAPES],
    ['   ', 'packets/..', CAP_ROOT],
  ]) {
    const fig = await draw(plan, handoff);
    assert.equal(fig.plan, PLAN_DEFAULT, `${plan} + ${handoff}`);
    assert.equal(fig.handoff, HANDOFF_DEFAULT, `${plan} + ${handoff}`);
    assert.equal(fig.caption, caption, 'blank is the default, not a second mistake');
  }
});

// The five captions the pane can produce, read OUT of the tour rather than trusted from the constants
// above. Those constants are a deliberate second copy — the wording is what a person reads, so changing it
// should take two edits and one look — and this is what stops the copy from being the only record: a sixth
// caption, or a reworded one, fails here by name instead of going unmeasured.
function captionsInSource() {
  const from = TOUR_SRC.indexOf('const DIR_PROBLEM_WORDS');
  assert.ok(from >= 0, 'DIR_PROBLEM_WORDS was renamed — re-anchor this read');
  // …to the END of figDirs, which is the first closing brace at its own indentation. The first `}` after
  // the function keyword is inside it, and stopping there cuts the neutral caption out of the region —
  // which the count below reported rather than letting it pass as "four is all there is".
  const figDirs = TOUR_SRC.indexOf('function figDirs');
  const endOfFigDirs = TOUR_SRC.indexOf('\n  }', figDirs);
  assert.ok(figDirs > 0 && endOfFigDirs > figDirs, 'figDirs() moved or changed shape — re-anchor this read');
  const region = TOUR_SRC.slice(from, endOfFigDirs);
  // A caption is a quoted sentence: it starts lower-case, runs to at least 25 characters, and carries no
  // code. The exclusions are what keeps an apostrophe in a nearby COMMENT from pairing with the next one
  // and dragging half the module in as a "caption" — which is exactly what the first version of this read
  // did, and the count assertion below is what caught it.
  return [...new Set(
    [...region.matchAll(/'([a-z][^'\n{}();]{24,})'/g)].map(m => m[1]).filter(t => t.includes(' ')),
  )];
}

/**
 * How many problems the pane has wording for, counted from the KEYS rather than from the sentences.
 *
 * The pattern above wants a lower-case sentence with no punctuation that could be code, so a sixth caption
 * that opens with a capital, or carries a bracket or a semicolon, is not recognised as one — the count
 * stays at five, every constant is still present, and that caption is measured nowhere. The keys cannot
 * hide the same way: a sixth problem adds one, whatever its wording looks like.
 */
function problemKeysInSource() {
  const from = TOUR_SRC.indexOf('const DIR_PROBLEM_WORDS');
  const block = TOUR_SRC.slice(from, TOUR_SRC.indexOf('\n  };', from));
  return [...block.matchAll(/^\s{4}([a-z]\w*):/gm)].map(m => m[1]);
}

// A budget only means something if something has crossed it, and every caption in the tree passes today.
// This is the one that did: the absolute wording as it shipped, which measured 345.7 px in a 340 px box in
// a running instance.
test('the caption budget is one the wording that overflowed would have failed (#630)', () => {
  const overflowed = 'an absolute path is resolved against each project, so this figure cannot show it';
  const width = captionWidth(overflowed);
  assert.ok(width > CAPTION_BUDGET_PX,
    `the retired wording measures ${width.toFixed(1)} px and this budget of ${CAPTION_BUDGET_PX.toFixed(1)} `
    + 'now passes it, so the check no longer catches the caption it was written for. Re-measure in a '
    + 'running instance rather than raising the number until the tree is green');

  // …and the width table has to agree with the font, or every number above is arithmetic about nothing.
  // These three were read with `getComputedTextLength()` in a running instance; the table reproduces them
  // to a tenth of a pixel, and a change to it that stops doing so fails here.
  for (const [text, measured] of [
    ['an absolute path is resolved against each project, so this figure cannot show it', 345.7],
    ['an absolute path is resolved per project, so it cannot be drawn here', 297.9],
    ['neither value could be drawn here — the defaults are shown instead', 301.8],
  ]) {
    const delta = Math.abs(captionWidth(text) - measured);
    assert.ok(delta < 0.5, `the table puts "${text}" at ${captionWidth(text).toFixed(1)} px against `
      + `${measured} px measured in the app — it no longer describes the font the figure draws in`);
  }

  // …and it is not so tight that a caption in use fails it, which would make it a tripwire on wording
  // rather than a guard on overflow. The list is read out of the tour, so a sixth one is included here.
  // Both counts, because each can miss what the other cannot: the sentences catch a reworded caption, the
  // keys catch a sixth problem whose wording this pattern does not recognise as a caption.
  const keys = problemKeysInSource();
  assert.deepEqual(keys.sort(), ['absolute', 'escapes', 'root'],
    `DIR_PROBLEM_WORDS names ${keys.length} problems, not the three this file measures — a new one needs a `
    + 'caption constant here and a case in the tests above, or it goes out unmeasured');
  const captions = captionsInSource();
  assert.equal(captions.length, 5, `expected the pane's five captions, read ${captions.length}: `
    + JSON.stringify(captions));
  for (const cap of [CAP_NEUTRAL, CAP_ESCAPES, CAP_ROOT, CAP_ABSOLUTE, CAP_TWO]) {
    assert.ok(captions.includes(cap), `"${cap}" is no longer one of the captions the tour can draw — the `
      + 'constants in this file have drifted away from DIR_PROBLEM_WORDS');
  }
  for (const cap of captions) {
    const w = captionWidth(cap);
    assert.ok(w <= CAPTION_BUDGET_PX, `"${cap}" measures ${w.toFixed(1)} px, over the budget`);
  }
});
