// scripts/pick-font.js — resolve a font family that @napi-rs/canvas can actually draw with.
//
// The asset scripts used to ask for `-apple-system, "Helvetica Neue", sans-serif`, the CSS stack a
// browser understands. @napi-rs/canvas 1.x does not: none of those three resolve, and the text comes
// out as one fallback box per glyph. It is silent — `fillText` succeeds, the PNG is written, and only
// looking at the image shows it. Measured on the 1.0.2 bump: "Drag to install" at 13px reported a
// 301px advance through that stack and 79px through Arial.
//
// So the family is picked from what the process actually has registered, in platform preference
// order. `GlobalFonts.families` is the authority — asking for a name it does not list is how the
// silent break happened in the first place.
'use strict';

const { GlobalFonts } = require('@napi-rs/canvas');

// Order matters: the first that exists wins. macOS first, then Windows, then the common Linux
// packages, then anything at all.
const PREFERRED = [
  'Helvetica Neue', 'Helvetica', 'SF Pro Text', 'SF Pro Display',   // macOS
  'Segoe UI', 'Arial', 'Tahoma',                                    // Windows
  'DejaVu Sans', 'Liberation Sans', 'Noto Sans', 'Ubuntu',          // Linux
];

let cached = null;

/** The family name to draw with. Throws if the process has no usable font at all. */
function pickFamily() {
  if (cached) return cached;
  const available = new Set(GlobalFonts.families.map(f => f.family));
  cached = PREFERRED.find(name => available.has(name))
    || GlobalFonts.families.map(f => f.family).find(Boolean);
  if (!cached) throw new Error('no font families registered — cannot render text');
  return cached;
}

/**
 * A canvas font string with a family this process can render.
 * `pxSize` is a number; `weight` is optional ('bold', '600', …).
 */
function fontString(pxSize, weight) {
  const family = pickFamily();
  const quoted = /\s/.test(family) ? `"${family}"` : family;
  return `${weight ? weight + ' ' : ''}${pxSize}px ${quoted}`;
}

module.exports = { pickFamily, fontString };
