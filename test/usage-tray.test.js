// shell/usage-tray.js — whose usage the tray icon shows, and what number it shows (#113).
//
// The drawing and the wiring are not testable here (canvas, a live tray). This is the decision, which is
// the part that can be wrong in a way nobody sees: the wrong backend, or a number that is not the one the
// user is about to hit.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { trayFace, pickTrayFace, msUntilNextFace } = require('../src/renderer/shell/usage-tray');

const usage = (over = {}) => ({ backendId: 'claude', label: 'Claude', ...over });

test('the face is the WORST bar, not the first one', () => {
  // A backend reports several windows. The icon has room for one number, and the only useful one is the
  // wall the user is closest to — the 7 d here, although the 5 h is listed first.
  const face = trayFace(usage(), [
    { key: 'session', label: '5h', percent: 12, level: 'ok' },
    { key: 'week', label: '7d', percent: 91, level: 'crit' },
  ]);
  assert.equal(face.percent, 91);
  assert.equal(face.level, 'crit');
  assert.equal(face.barLabel, '7d');
});

test('a backend with nothing to report keeps its name and has no number', () => {
  // Rate limited, errored, or never reported a limit. `percent: null` is what lets the caller draw the
  // badge and say so, rather than skipping the backend and showing another one's number under its name.
  const face = trayFace(usage({ label: 'Codex', backendId: 'codex' }), []);
  assert.equal(face.percent, null);
  assert.equal(face.label, 'Codex');
  assert.equal(face.level, 'ok');
});

test('the icon key follows the descriptor slug, then the id', () => {
  assert.equal(trayFace(usage({ icon: 'anthropic' }), []).iconKey, 'anthropic');
  assert.equal(trayFace(usage(), []).iconKey, 'claude');
});

test('a percentage out of range is clamped, and a non-number is not a bar', () => {
  const face = trayFace(usage(), [
    { label: 'a', percent: 140, level: 'crit' },
    { label: 'b', percent: 'nonsense', level: 'ok' },
  ]);
  assert.equal(face.percent, 100);
});

// --- which face -------------------------------------------------------------------------------------

const faces = [
  { backendId: 'claude', label: 'Claude', percent: 10 },
  { backendId: 'codex', label: 'Codex', percent: 20 },
  { backendId: 'agy', label: 'Antigravity', percent: 30 },
];

test('fixed mode shows the backend that was named', () => {
  assert.equal(pickTrayFace(faces, { mode: 'fixed', backendId: 'codex' }).backendId, 'codex');
});

test('fixed mode falls back to the first when the named backend is not there', () => {
  // The setting outlives the backend: switched off, uninstalled, or a settings blob carried to another
  // machine. An icon that disappears because of that is indistinguishable from a broken feature.
  assert.equal(pickTrayFace(faces, { mode: 'fixed', backendId: 'hermes' }).backendId, 'claude');
  assert.equal(pickTrayFace(faces, { mode: 'fixed' }).backendId, 'claude');
});

test('nothing selected means no icon at all', () => {
  assert.equal(pickTrayFace([], { mode: 'fixed' }), null);
  assert.equal(pickTrayFace(null, { mode: 'rotate' }), null);
});

test('rotate steps on the WALL CLOCK, so every asker agrees on what is showing', () => {
  // Not a counter: a repaint triggered by something else, a second window, or a settings re-apply must
  // not advance the rotation or restart it. Same instant in, same backend out.
  const at = (nowMs) => pickTrayFace(faces, { mode: 'rotate', rotateSeconds: 10, nowMs }).backendId;
  assert.equal(at(0), 'claude');
  assert.equal(at(9_999), 'claude', 'still inside the first slot');
  assert.equal(at(10_000), 'codex');
  assert.equal(at(20_000), 'agy');
  assert.equal(at(30_000), 'claude', 'and it wraps');
  assert.equal(at(12_345), at(12_345), 'the same moment always answers the same');
});

test('rotate with one backend selected is a fixed icon, and arms no timer', () => {
  const one = [faces[0]];
  assert.equal(pickTrayFace(one, { mode: 'rotate', rotateSeconds: 10, nowMs: 55_000 }).backendId, 'claude');
  assert.equal(msUntilNextFace(one, { mode: 'rotate', rotateSeconds: 10, nowMs: 55_000 }), null,
    'nothing to rotate to — a timer here would be a repaint nobody asked for');
});

test('the next-change delay lands exactly on the slot boundary', () => {
  const opts = (nowMs) => ({ mode: 'rotate', rotateSeconds: 10, nowMs });
  assert.equal(msUntilNextFace(faces, opts(0)), 10_000);
  assert.equal(msUntilNextFace(faces, opts(2_500)), 7_500);
  assert.equal(msUntilNextFace(faces, opts(9_999)), 1);
  assert.equal(msUntilNextFace(faces, { mode: 'fixed', nowMs: 0 }), null, 'a fixed icon never re-renders on a clock');
});

test('a rotate interval that makes no sense falls back to the default rather than spinning', () => {
  // A zero or a negative would be a modulo by zero — NaN in, and every asker disagreeing about what is
  // showing. The default is what a settings blob with a stale or hand-edited value gets.
  for (const bad of [0, -5, 'soon', null]) {
    const picked = pickTrayFace(faces, { mode: 'rotate', rotateSeconds: bad, nowMs: 0 });
    assert.ok(picked && picked.backendId, `rotateSeconds=${String(bad)} still picks a backend`);
    const delay = msUntilNextFace(faces, { mode: 'rotate', rotateSeconds: bad, nowMs: 0 });
    assert.ok(delay > 0, 'and still names a finite delay');
  }
});

// --- the drawing (#113) -----------------------------------------------------------------------------
//
// `usage-tray-icon.js` needs a canvas, which `node --test` has no business providing — so what is pinned
// here is everything AROUND the pixels: the two representations, the macOS split, and the styles. The
// stub records the calls rather than rasterising, so a drawing that throws still fails loudly.

const { trayImageFor, drawFace, LEVEL_COLOURS } = require('../src/renderer/shell/usage-tray-icon');

function stubCanvas() {
  const calls = [];
  const ctx = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'font' || prop === 'fillStyle' || prop === 'strokeStyle' || prop === 'lineWidth'
        || prop === 'globalAlpha' || prop === 'textAlign' || prop === 'textBaseline' || prop === 'lineCap') {
        return undefined;
      }
      return (...args) => calls.push([String(prop), ...args]);
    },
    set(_t, prop, value) { calls.push(['set:' + String(prop), value]); return true; },
  });
  const created = [];
  global.document = {
    createElement: () => {
      const canvas = {
        width: 0, height: 0,
        getContext: () => ctx,
        toDataURL: () => `data:image/png;base64,stub:${canvas.width}`,
      };
      created.push(canvas);
      return canvas;
    },
  };
  return { calls, created, restore: () => { delete global.document; } };
}

test('both resolutions are drawn, and the second is twice the first', () => {
  const stub = stubCanvas();
  try {
    const img = trayImageFor({ percent: 42, level: 'ok', iconKey: 'claude' }, { platform: 'win32' });
    assert.equal(stub.created.length, 2, 'a menu bar draws at the display scale — one bitmap is a blurry one');
    assert.deepEqual(stub.created.map(c => c.width), [16, 32]);
    assert.ok(img.dataURL && img.dataURL2x);
  } finally { stub.restore(); }
});

test('macOS gets the number BESIDE the icon, not inside it', () => {
  // setTitle exists only there, and it follows the menu bar's own light/dark theme — which a number baked
  // into a bitmap cannot. So the icon stays a ring and the figure travels as text.
  const stub = stubCanvas();
  try {
    const mac = trayImageFor({ percent: 42, level: 'ok' }, { platform: 'darwin' });
    assert.equal(mac.title, '42%');
    assert.equal(stub.calls.some(c => c[0] === 'fillText'), false, 'nothing was written into the image');
  } finally { stub.restore(); }

  const stub2 = stubCanvas();
  try {
    const win = trayImageFor({ percent: 42, level: 'ok' }, { platform: 'win32' });
    assert.equal(win.title, '', 'no stale title travels to a platform that cannot show one');
    assert.deepEqual(stub2.calls.filter(c => c[0] === 'fillText').map(c => c[1]), ['42', '42']);
  } finally { stub2.restore(); }
});

test('a reading of 100 draws no digits — the closed ring already says it', () => {
  const stub = stubCanvas();
  try {
    drawFace({ percent: 100, level: 'crit' }, { scale: 1 });
    assert.equal(stub.calls.some(c => c[0] === 'fillText'), false);
  } finally { stub.restore(); }
});

test('a backend with no reading draws a placeholder, not a zero', () => {
  // A "0" would be a claim: nothing used yet. The dot says the app has no figure for this backend.
  const stub = stubCanvas();
  try {
    drawFace({ percent: null, level: 'ok' }, { scale: 1 });
    assert.deepEqual(stub.calls.filter(c => c[0] === 'fillText').map(c => c[1]), ['·']);
  } finally { stub.restore(); }
});

test('the badge style fills a rounded square; the ring style strokes arcs', () => {
  const ring = stubCanvas();
  try {
    drawFace({ percent: 60, level: 'warn' }, { scale: 1, style: 'ring' });
    assert.ok(ring.calls.some(c => c[0] === 'arc'), 'the ring is arcs');
    assert.equal(ring.calls.some(c => c[0] === 'fill'), false, 'and it fills nothing');
  } finally { ring.restore(); }

  const badge = stubCanvas();
  try {
    drawFace({ percent: 60, level: 'warn' }, { scale: 1, style: 'badge' });
    assert.ok(badge.calls.some(c => c[0] === 'fill'), 'the badge is a filled square');
    assert.equal(badge.calls.some(c => c[0] === 'arc'), false, 'no ring arcs in a badge');
    assert.deepEqual(badge.calls.filter(c => c[0] === 'fillText').map(c => c[1]), ['60']);
  } finally { badge.restore(); }
});

test('an unknown style is the ring, not a blank icon', () => {
  const stub = stubCanvas();
  try {
    drawFace({ percent: 60, level: 'warn' }, { scale: 1, style: 'nonsense' });
    assert.ok(stub.calls.some(c => c[0] === 'arc'));
  } finally { stub.restore(); }
});

test('no canvas is not an error — the tray simply keeps the icon it has', () => {
  assert.equal(drawFace({ percent: 10, level: 'ok' }, {}), null);
  assert.equal(trayImageFor({ percent: 10, level: 'ok' }, {}), null);
});

test('the level colours are the status bar\'s own value colours', () => {
  // style.css `.status-bar-usage-bar.usage-level-* .status-bar-usage-value`. A canvas takes a colour and
  // not a class, so this is a second copy — and this assertion is what says so out loud.
  assert.deepEqual(LEVEL_COLOURS, { ok: '#7ed99b', warn: '#ffb070', crit: '#ff8a8a' });
});

test('the no-reading placeholder is NOT painted in the healthy colour', () => {
  // `level` defaults to 'ok', so a placeholder drawn in the level colour is a green dot about a backend
  // that has reported nothing — a claim, in the one case where the app has no figure at all.
  const stub = stubCanvas();
  try {
    drawFace({ percent: null, level: 'ok', iconKey: 'pi' }, { scale: 1, colourFor: () => '#f59e0b' });
    const fills = stub.calls.filter(c => c[0] === 'set:fillStyle').map(c => c[1]);
    assert.ok(fills.includes('#f59e0b'), 'it takes the backend colour instead');
    assert.equal(fills.includes(LEVEL_COLOURS.ok), false);
  } finally { stub.restore(); }
});
