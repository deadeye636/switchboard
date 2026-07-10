// --- Colour conversions for the tag picker (#134) ---
// A hex string is the storage format everywhere (chips, DB, CSS), while an HSV
// triple is what a saturation/value field plus a hue slider actually manipulate.
//
// Loaded as a classic <script> in the renderer (exposes globals) AND require()-d
// by node tests (module.exports). Keep this file free of DOM/browser APIs.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

  // Accepts '#rgb', '#rrggbb', with or without the hash, any case. Returns a
  // canonical '#rrggbb', or null when the input is not a colour at all.
  function normalizeHex(input) {
    if (typeof input !== 'string') return null;
    let s = input.trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$/.test(s)) s = s.split('').map(c => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
    return '#' + s.toLowerCase();
  }

  function hexToRgb(hex) {
    const norm = normalizeHex(hex);
    if (!norm) return null;
    return {
      r: parseInt(norm.slice(1, 3), 16),
      g: parseInt(norm.slice(3, 5), 16),
      b: parseInt(norm.slice(5, 7), 16),
    };
  }

  function rgbToHex({ r, g, b } = {}) {
    const byte = (n) => clamp(Math.round(Number(n) || 0), 0, 255).toString(16).padStart(2, '0');
    return '#' + byte(r) + byte(g) + byte(b);
  }

  // h in [0,360), s and v in [0,1].
  function rgbToHsv({ r, g, b } = {}) {
    const rn = clamp(Number(r) || 0, 0, 255) / 255;
    const gn = clamp(Number(g) || 0, 0, 255) / 255;
    const bn = clamp(Number(b) || 0, 0, 255) / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const d = max - min;

    let h = 0;
    if (d !== 0) {
      if (max === rn) h = ((gn - bn) / d) % 6;
      else if (max === gn) h = (bn - rn) / d + 2;
      else h = (rn - gn) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h, s: max === 0 ? 0 : d / max, v: max };
  }

  function hsvToRgb({ h, s, v } = {}) {
    const hh = ((Number(h) || 0) % 360 + 360) % 360;
    const ss = clamp(Number(s) || 0, 0, 1);
    const vv = clamp(Number(v) || 0, 0, 1);

    const c = vv * ss;
    const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
    const m = vv - c;

    let rgb;
    if (hh < 60) rgb = [c, x, 0];
    else if (hh < 120) rgb = [x, c, 0];
    else if (hh < 180) rgb = [0, c, x];
    else if (hh < 240) rgb = [0, x, c];
    else if (hh < 300) rgb = [x, 0, c];
    else rgb = [c, 0, x];

    return {
      r: Math.round((rgb[0] + m) * 255),
      g: Math.round((rgb[1] + m) * 255),
      b: Math.round((rgb[2] + m) * 255),
    };
  }

  function hexToHsv(hex) {
    const rgb = hexToRgb(hex);
    return rgb ? rgbToHsv(rgb) : null;
  }

  function hsvToHex(hsv) {
    return rgbToHex(hsvToRgb(hsv));
  }

  return { normalizeHex, hexToRgb, rgbToHex, rgbToHsv, hsvToRgb, hexToHsv, hsvToHex };
});
