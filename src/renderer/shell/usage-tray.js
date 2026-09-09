// --- What the usage tray icon shows, as a pure decision (#113) ---
//
// The tray icon is one square with one number in it, and the status bar since #191 is one segment PER
// backend. So the icon has to answer a question the bar never had to: whose usage is this? The user
// settles it (`usageTray.mode`) — a fixed backend, or a rotation through the ones they already chose to
// see — and this file is that choice applied to a payload. It draws nothing and touches no DOM: the
// drawing is shell/usage-tray-icon.js, the wiring is shell/statusbar-usage.js, and this is the half a
// `node --test` can hold.
//
// The candidates are ALWAYS the status bar's own selection (`selectedUsageBackends`). A tray that could
// show a backend the bar does not would be a second, invisible setting — and the one thing this feature
// promised is that it reuses what the app already has.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.UsageTray = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const DEFAULT_ROTATE_SECONDS = 8;

  function pct(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.max(0, Math.min(100, Math.round(number)));
  }

  /**
   * One backend reduced to what fits in 16 pixels: the WORST of its bars.
   *
   * Not the first bar and not an average. A backend reports several windows (5 h, 7 d, a credit pool),
   * and the only question an icon in the corner of the screen can answer is "how close am I to a wall" —
   * which is the highest of them. The tooltip still carries all of them, unabridged.
   *
   * `bars` is `getUsageBars(usage, thresholds)`, passed in rather than computed here so this file needs
   * no thresholds and no knowledge of tiers.
   *
   * A backend with no bars — rate limited, errored, or one that has never reported a limit — has no
   * number to show. It answers `percent: null` and keeps its label, so the caller can still name it
   * rather than silently skipping to the next one.
   */
  function trayFace(usage, bars) {
    const u = usage || {};
    let worst = null;
    for (const bar of bars || []) {
      const value = pct(bar && bar.percent);
      if (value === null) continue;
      if (!worst || value > worst.percent) worst = { percent: value, level: bar.level || 'ok', label: bar.label || '' };
    }
    return {
      backendId: u.backendId || null,
      // The icon key the badge is drawn from, exactly as the status bar picks it (#212): a declared
      // `icon` slug first, the id second. Colour and monogram follow from it.
      iconKey: u.icon || u.backendId || null,
      monogram: u.monogram || null,
      label: u.label || u.backendId || 'Usage',
      percent: worst ? worst.percent : null,
      level: worst ? worst.level : 'ok',
      barLabel: worst ? worst.label : '',
    };
  }

  /**
   * Which of the faces the icon is showing right now.
   *
   * `fixed` names a backend. If that backend is not among the selected ones — switched off, uninstalled,
   * or a settings blob older than the machine it is read on — this falls back to the first selected one
   * rather than showing nothing: an icon that vanishes because a setting went stale is indistinguishable
   * from a broken feature.
   *
   * `rotate` steps through them on a wall-clock schedule rather than a counter, so it does not matter how
   * often the caller asks or when it started: two windows, a reopen, or a repaint triggered by something
   * else all land on the same backend at the same moment.
   */
  function pickTrayFace(faces, options) {
    const list = Array.isArray(faces) ? faces.filter(Boolean) : [];
    if (list.length === 0) return null;
    const opts = options || {};
    if (opts.mode === 'rotate' && list.length > 1) {
      const seconds = Number(opts.rotateSeconds) > 0 ? Number(opts.rotateSeconds) : DEFAULT_ROTATE_SECONDS;
      const now = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
      return list[Math.floor(now / (seconds * 1000)) % list.length];
    }
    if (opts.backendId) {
      const named = list.find(f => f.backendId === opts.backendId);
      if (named) return named;
    }
    return list[0];
  }

  /**
   * How long until the rotation would show a different backend. `null` when nothing rotates, which is
   * what tells the caller not to arm a timer at all — a fixed icon that re-renders every few seconds
   * would be a timer nobody asked for.
   */
  function msUntilNextFace(faces, options) {
    const list = Array.isArray(faces) ? faces.filter(Boolean) : [];
    const opts = options || {};
    if (opts.mode !== 'rotate' || list.length < 2) return null;
    const seconds = Number(opts.rotateSeconds) > 0 ? Number(opts.rotateSeconds) : DEFAULT_ROTATE_SECONDS;
    const now = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
    const period = seconds * 1000;
    return period - (now % period);
  }

  return { trayFace, pickTrayFace, msUntilNextFace, DEFAULT_ROTATE_SECONDS };
});
