'use strict';

// The asset scripts (build/icon.png placeholder, the DMG background) draw text with
// @napi-rs/canvas. Getting the font wrong there does NOT throw: fillText succeeds, the PNG is
// written, and the only symptom is one fallback box per glyph in the image nobody looks at until it
// ships on a DMG.
//
// That is exactly what the 1.0.2 bump did. The scripts asked for the CSS stack a browser
// understands — `-apple-system, "Helvetica Neue", sans-serif` — and canvas 1.x resolves none of the
// three. Measured: "Drag to install" at 13px reported a 301px advance through that stack against
// 79px through a real family.
//
// So two guards: the picker must return something the process actually has, and neither script may
// go back to naming a family that is not one.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPTS = ['generate-icons.js', 'generate-dmg-background.js'];
const scriptPath = (name) => path.join(__dirname, '..', 'scripts', name);

// CSS generic families and keywords: legal in a browser, not font names canvas can resolve.
const NOT_A_FAMILY = /-apple-system|BlinkMacSystemFont|\bsans-serif\b|\bserif\b|\bmonospace\b|system-ui/;

test('the asset scripts do not name CSS generic families', () => {
  for (const name of SCRIPTS) {
    const src = fs.readFileSync(scriptPath(name), 'utf8');
    // Only the lines that actually set a font matter; the comments explain the trap on purpose.
    const fontLines = src.split('\n')
      .filter(l => /\.font\s*=/.test(l))
      .filter(l => !l.trim().startsWith('//'));
    assert.ok(fontLines.length > 0, `${name} sets no font at all — did the assignment move?`);
    for (const line of fontLines) {
      assert.ok(!NOT_A_FAMILY.test(line),
        `${name} names a CSS generic family, which canvas cannot resolve: ${line.trim()}`);
    }
  }
});

test('the asset scripts resolve their font through pick-font', () => {
  for (const name of SCRIPTS) {
    const src = fs.readFileSync(scriptPath(name), 'utf8');
    assert.match(src, /require\('\.\/pick-font'\)/,
      `${name} must take its font from pick-font.js, not from a literal`);
  }
});

// @napi-rs/canvas is a native module and present as a devDependency; if it cannot load in this
// environment the picker cannot be exercised, and a red test there would say nothing about the code.
test('pick-font returns a family the process actually has', (t) => {
  let GlobalFonts;
  try {
    ({ GlobalFonts } = require('@napi-rs/canvas'));
  } catch {
    t.skip('@napi-rs/canvas not loadable here');
    return;
  }
  const { pickFamily, fontString } = require('../scripts/pick-font');
  const available = new Set(GlobalFonts.families.map(f => f.family));
  const picked = pickFamily();
  assert.ok(available.has(picked), `picked "${picked}", which is not among the registered families`);

  // A family with a space has to reach canvas quoted, or it parses as two names.
  const s = fontString(13);
  assert.match(s, /^13px /);
  if (/\s/.test(picked)) assert.ok(s.includes(`"${picked}"`), `family with a space must be quoted: ${s}`);
});
