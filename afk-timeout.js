// Pure helpers for the per-session AskUserQuestion timeout (#51).
// UMD-wrapped so main.js can require it and node --test can exercise the logic.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // Convert a stored value (seconds) to the CLAUDE_AFK_TIMEOUT_MS env string, or
  // null when the timeout must be left at Claude's default (env unset).
  //   '' / undefined / null            → null  (inherit / Claude default 60s)
  //   0                                → '2147483647'  (off — never auto-continue)
  //   positive number of seconds       → String(sec * 1000)
  //   negative / non-numeric           → null  (invalid → default)
  function afkTimeoutToEnvMs(raw) {
    if (raw === undefined || raw === null) return null;
    const s = String(raw).trim().toLowerCase();
    if (s === '') return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return null;
    if (n === 0) return '2147483647'; // 0 = off / never
    return String(Math.round(n * 1000));
  }

  // Cascade: first non-empty of session > project > global wins; '' / undefined /
  // null means "inherit" at that scope. Returns '' when nothing is set (default).
  function resolveAfkTimeoutSec(sessionVal, projectVal, globalVal) {
    for (const v of [sessionVal, projectVal, globalVal]) {
      if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    }
    return '';
  }

  // Normalize a raw UI input into the stored form ('' | non-negative int seconds).
  // 0 is kept (means off / never); empty / negative / non-numeric → '' (inherit).
  function normalizeAfkInput(raw) {
    if (raw === undefined || raw === null) return '';
    const s = String(raw).trim().toLowerCase();
    if (s === '') return '';
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return '';
    return String(Math.floor(n));
  }

  return { afkTimeoutToEnvMs, resolveAfkTimeoutSec, normalizeAfkInput };
});
