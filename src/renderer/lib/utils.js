// --- Utility functions (shared across renderer modules) ---

// Mirror Claude CLI's project-folder naming. Must stay in sync with
// encode-project-path.js (main process). Reverse-engineered from claude CLI 2.1.126.
function encodeProjectPath(projectPath) {
  const sanitized = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= 200) return sanitized;
  let h = 0;
  for (let i = 0; i < projectPath.length; i++) {
    h = (h << 5) - h + projectPath.charCodeAt(i) | 0;
  }
  return sanitized.slice(0, 200) + '-' + Math.abs(h).toString(36);
}

function cleanDisplayName(name) {
  if (!name) return name;
  const prefix = 'Implement the following plan:';
  if (name.startsWith(prefix)) name = name.slice(prefix.length).trim();
  // Strip XML/HTML-like tags (e.g. <command>, </message>, <system-reminder>)
  name = name.replace(/<\/?[a-zA-Z][a-zA-Z0-9_-]*(?:\s[^>]*)?\/?>/g, ' ');
  // Collapse multiple spaces and trim
  name = name.replace(/\s+/g, ' ').trim();
  return name;
}

// Clamp a usage warn/crit threshold pair (%): warn 1..99, crit warn+1..100,
// non-numeric inputs fall back to the given defaults. Shared by the status-bar
// usage colouring (app.js) and the settings-panel save path (#79).
function clampUsageThreshold(warn, crit, defWarn, defCrit) {
  let w = Number(warn), c = Number(crit);
  if (!Number.isFinite(w)) w = defWarn;
  if (!Number.isFinite(c)) c = defCrit;
  w = Math.max(1, Math.min(99, w));
  c = Math.max(w + 1, Math.min(100, c));
  return { warn: w, crit: c };
}

function formatDate(date) {
  const now = new Date();
  const diff = now - date;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const ESCAPE_HTML_RE = /[&<>"']/g;
const ESCAPE_HTML_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(str) {
  // Regex replace instead of a throwaway <div> per call — this runs ~10× per
  // table row in the admin views (#80).
  return String(str ?? '').replace(ESCAPE_HTML_RE, (ch) => ESCAPE_HTML_MAP[ch]);
}

// Memoized localStorage JSON parse: re-parses only when the raw string changed.
// The sidebar getters (collapse/expand state) run per group/project per render
// pass — parsing the same blob dozens of times per render is pure waste (#80).
const _lsJsonCache = new Map(); // key -> { raw, value }
function readLsJson(key, fallbackJson) {
  let raw;
  try { raw = localStorage.getItem(key); } catch { raw = null; }
  if (raw == null) raw = fallbackJson;
  const hit = _lsJsonCache.get(key);
  if (hit && hit.raw === raw) return hit.value;
  let value;
  try { value = JSON.parse(raw); } catch { value = JSON.parse(fallbackJson); }
  _lsJsonCache.set(key, { raw, value });
  return value;
}

function shellEscape(path) {
  return "'" + path.replace(/'/g, "'\\''") + "'";
}
