// --- Drawing the usage tray icon (#113) ---
//
// A ring around a number, in the backend's own colour, as a data URL the main process hands to `Tray`.
//
// WHY THE RENDERER DRAWS IT. The main process has no canvas — `@napi-rs/canvas` is a devDependency here,
// used by `scripts/generate-icons.js` at build time, and promoting it to a runtime dependency would make
// it this app's THIRD native module for a job that is one arc and one number. The renderer has a canvas
// already, and the objection that would settle it the other way does not apply: this app has no
// close-to-tray. Closing the main window tears down its sessions and quits (`src/app/windows.js`), so
// there is never a tray without a renderer behind it. If that ever changes, this is the file to revisit
// and the trade flips.
//
// TWO RESOLUTIONS, ALWAYS. A menu bar or taskbar is drawn at the display's scale factor, and a 16 px
// bitmap on a Retina Mac is a blurry 16 px bitmap. Both are rendered and handed over as separate
// representations, which is what `nativeImage` wants.
//
// THE NUMBER IS PLATFORM-DEPENDENT, and that is the macOS half of this file. On macOS the percentage is
// NOT drawn into the icon: `tray.setTitle()` puts it beside the icon in the menu bar's own font, and it
// follows the light/dark menu bar automatically — which a baked-in number cannot. Windows and Linux have
// no such API, so there the number goes into the image, and the ring stays a ring on macOS.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.UsageTrayIcon = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // The three states, taken from the status bar's own `usage-level-*` VALUE colours (style.css) so the
  // icon and the segment cannot disagree about what "warn" looks like. Copied rather than read, because a
  // canvas takes a colour and not a class — so this is a second copy of three values and it says so: if
  // those rules move, these move. Only the thresholds are genuinely shared, and they arrive as `level`.
  const LEVEL_COLOURS = { ok: '#7ed99b', warn: '#ffb070', crit: '#ff8a8a' };

  // The base size in CSS pixels. 16 is what Windows asks for; macOS and Linux take the same and scale.
  const BASE_SIZE = 16;

  function ringColour(level) {
    return LEVEL_COLOURS[level] || LEVEL_COLOURS.ok;
  }

  /** A rounded rectangle, because `roundRect` is not in every Chromium this app has shipped against. */
  function roundedRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  /**
   * One representation, at `scale`. Returns a data URL, or null when there is no canvas to draw on —
   * which is not an error worth throwing: the caller simply leaves the tray icon as it was.
   *
   * Two styles, both named by the requirement. The RING spends the pixels on the reading — the arc says
   * how full the bucket is before the number is legible at all, which is what makes it readable at 16 px
   * on a low-DPI screen. The BADGE spends them on the number: a filled square in the level colour with
   * the figure knocked out of it, which is easier to read at a glance and says nothing about the shape of
   * the reading. Neither is better; that is why it is a setting.
   */
  function drawFace(face, { scale = 1, withNumber = true, colourFor = null, style = 'ring' } = {}) {
    if (typeof document === 'undefined' || !document.createElement) return null;
    const size = BASE_SIZE * scale;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext && canvas.getContext('2d');
    if (!g) return null;

    const centre = size / 2;
    const stroke = Math.max(2, Math.round(size * 0.14));
    const radius = centre - stroke / 2 - Math.max(1, Math.round(size * 0.03));
    // `Number(null)` is 0 and `Number.isFinite(0)` is true, so a face with NO reading used to be drawn as
    // "0" — which is not an absence, it is the claim that nothing has been used. Rule the empties out
    // first.
    const raw = face ? face.percent : null;
    const percent = (raw === null || raw === undefined || raw === '' || !Number.isFinite(Number(raw)))
      ? null
      : Number(raw);

    // The backend's own badge colour — the same one its sessions wear in the sidebar. In the ring it is
    // the faint track behind the arc, which is what says WHICH backend this is at a glance and, on a
    // rotating icon, the only thing telling one frame from the next when both read 40 %. In the badge it
    // is a thin border, for the same job in the space a filled square leaves.
    const backendColour = (typeof colourFor === 'function' && face && colourFor(face.iconKey)) || '#64748b';

    if (style === 'badge') {
      const pad = Math.max(1, Math.round(size * 0.06));
      const box = size - pad * 2;
      roundedRect(g, pad, pad, box, box, Math.round(size * 0.22));
      g.fillStyle = ringColour(face && face.level);
      g.fill();
      g.strokeStyle = backendColour;
      g.lineWidth = Math.max(1, Math.round(size * 0.08));
      g.stroke();
      if (withNumber) {
        const text = percent === null ? '·' : String(Math.min(100, percent));
        // Knocked out of the fill rather than drawn in the level colour: the square already carries that,
        // and a same-colour number on it would be invisible.
        g.fillStyle = '#12161c';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.font = `700 ${Math.round(size * (text.length > 2 ? 0.44 : 0.58))}px system-ui, -apple-system, "Segoe UI", sans-serif`;
        g.fillText(text, centre, centre + Math.round(size * 0.03));
      }
      return canvas.toDataURL('image/png');
    }

    g.beginPath();
    g.arc(centre, centre, radius, 0, Math.PI * 2);
    g.strokeStyle = backendColour;
    g.globalAlpha = 0.35;
    g.lineWidth = stroke;
    g.stroke();
    g.globalAlpha = 1;

    // The arc: from twelve o'clock, clockwise, proportional to the worst window.
    if (percent !== null && percent > 0) {
      const start = -Math.PI / 2;
      g.beginPath();
      g.arc(centre, centre, radius, start, start + (Math.PI * 2 * Math.min(100, percent)) / 100);
      g.strokeStyle = ringColour(face && face.level);
      g.lineWidth = stroke;
      g.lineCap = 'butt';
      g.stroke();
    }

    if (withNumber) {
      // 100 never fits legibly in the middle of a 16 px ring, and it is also the one value the ring
      // itself already states unambiguously (a full circle). So it draws no digits and lets the closed
      // ring say it.
      const text = percent === null ? '·' : (percent >= 100 ? '' : String(percent));
      if (text) {
        // The NUMBER takes the level colour, not the backend's. Drawn in the backend's colour it read as
        // a healthy icon at 97 %: the ring went red and a blue "97" sat inside it, so the two halves of
        // one icon said different things. Which backend this is stays legible in the track behind the
        // ring — and it is legible exactly when there is room for it, at the low readings where the
        // question "whose?" is the interesting one. At 97 % it is not.
        //
        // The no-reading placeholder is the exception, and it takes the BACKEND's colour: a green dot
        // where the level defaults to 'ok' would say the bucket is comfortable, about a backend that has
        // reported nothing at all.
        g.fillStyle = percent === null ? backendColour : ringColour(face && face.level);
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        const weight = 700;
        const fontSize = Math.round(size * (text.length > 2 ? 0.42 : 0.52));
        g.font = `${weight} ${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
        g.fillText(text, centre, centre + Math.round(size * 0.02));
      }
    }

    return canvas.toDataURL('image/png');
  }

  /**
   * The image for one face, as the two representations `nativeImage` needs.
   *
   * `platform` decides whether the number is drawn: on darwin it is not, because the main process puts
   * it beside the icon with `setTitle` instead. Passed in rather than read here — this file is loaded in
   * a renderer, and the platform question belongs to whoever knows the answer.
   */
  function trayImageFor(face, { platform = '', colourFor = null, style = 'ring' } = {}) {
    const withNumber = platform !== 'darwin';
    const at1 = drawFace(face, { scale: 1, withNumber, colourFor, style });
    if (!at1) return null;
    return {
      dataURL: at1,
      dataURL2x: drawFace(face, { scale: 2, withNumber, colourFor, style }),
      // What macOS shows next to the icon; ignored everywhere else. Empty rather than absent when there
      // is no reading, so a stale title from the previous face is always cleared.
      title: platform === 'darwin' && Number.isFinite(Number(face && face.percent)) ? `${face.percent}%` : '',
    };
  }

  return { trayImageFor, drawFace, ringColour, LEVEL_COLOURS, BASE_SIZE };
});
