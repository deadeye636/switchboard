// backends/codex/trust.js — Codex' per-project trust, in its own config (#171).
//
// Codex asks "Do you trust this directory?" the first time it runs somewhere, and remembers the answer
// in (CODEX_HOME|~/.codex)/config.toml:
//
//   [projects.'d:\projekte\example']
//   trust_level = "trusted"
//
// Ticking "Trusted" in the project manager used to write Claude's config and nothing else — so the
// column said "trusted" and Codex asked anyway. This is the other half.
//
// We do NOT parse or rewrite the whole TOML. That file is Codex' own, it holds settings we do not
// understand, and a round-trip through a serializer would reformat all of it. We touch exactly the one
// `[projects.'<path>']` table, the way claude-config touches exactly one field of ~/.claude.json.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function configPath() {
  return path.join(codexHome(), 'config.toml');
}

// A TOML table header for a project path. Codex writes it single-quoted (a literal string), which is
// what makes a Windows path with backslashes safe to store verbatim.
function tableHeader(projectPath) {
  return `[projects.'${projectPath}']`;
}

/**
 * Every project's trust level, as written in the file: Map<projectPath, 'trusted' | string>.
 *
 * Paths are returned VERBATIM. A real config carries the same directory twice, in different case
 * (`d:\projekte\x` and `D:\Projekte\x`) — Codex writes whatever cwd it was started with, so the caller
 * has to compare case-insensitively on Windows.
 */
function parseTrust(toml) {
  const out = new Map();
  const re = /^\s*\[projects\.(?:'([^']*)'|"([^"]*)")\]\s*$/;
  const lines = String(toml || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const project = m[1] != null ? m[1] : m[2];
    // Read the table's body until the next table header.
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*\[/.test(lines[j])) break;
      const t = lines[j].match(/^\s*trust_level\s*=\s*["']([^"']*)["']/);
      if (t) { out.set(project, t[1]); break; }
    }
  }
  return out;
}

/**
 * Set (or clear) a project's trust in a TOML string, returning the new string.
 *
 * `trusted: false` removes the `trust_level` line rather than writing `"untrusted"` — the absence of a
 * level is what Codex reads as "ask me", and inventing a value it may not know is worse than saying
 * nothing. An empty table is left behind, which is harmless and preserves any other keys the user put
 * there.
 */
function setTrust(toml, projectPath, trusted) {
  const src = String(toml || '');
  const lines = src.split(/\r?\n/);
  const header = tableHeader(projectPath);
  const headerRe = new RegExp(`^\\s*\\[projects\\.(?:'${escapeRe(projectPath)}'|"${escapeRe(projectPath)}")\\]\\s*$`);

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i])) { start = i; break; }
  }

  // No table yet: append one (only when there is something to say).
  if (start === -1) {
    if (!trusted) return src;
    const body = src.replace(/\s*$/, '');
    return `${body}${body ? '\n\n' : ''}${header}\ntrust_level = "trusted"\n`;
  }

  // Table exists: find its body and replace/remove the trust_level line.
  let end = lines.length;
  for (let j = start + 1; j < lines.length; j++) {
    if (/^\s*\[/.test(lines[j])) { end = j; break; }
  }
  const body = lines.slice(start + 1, end).filter(l => !/^\s*trust_level\s*=/.test(l));
  if (trusted) body.unshift('trust_level = "trusted"');

  return [...lines.slice(0, start + 1), ...body, ...lines.slice(end)].join('\n');
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- file access ---

/** The trust level Codex has recorded for this project, or null when it has never been asked. */
function get(projectPath) {
  if (!projectPath) return null;
  let toml;
  try { toml = fs.readFileSync(configPath(), 'utf8'); } catch { return null; }
  const map = parseTrust(toml);
  const wanted = norm(projectPath);
  for (const [p, level] of map) {
    if (norm(p) === wanted) return level === 'trusted';
  }
  return null;
}

/**
 * Write the trust level. Atomic (temp + rename) with a .bak, exactly like claude-config: this is
 * somebody else's config file, and half a write would take their settings with it.
 */
function set(projectPath, trusted) {
  if (!projectPath) return { ok: false, error: 'No project path' };
  const file = configPath();
  let toml = '';
  try { toml = fs.readFileSync(file, 'utf8'); } catch {
    // No config yet — Codex writes one on first run. Creating it just for a trust entry is honest
    // enough (the table is all it would contain), but only if the directory is there.
    if (!fs.existsSync(codexHome())) return { ok: false, error: 'Codex is not installed here' };
  }

  // Update EVERY spelling of the path the file already carries (a real config holds `d:\x` and `D:\X`
  // as separate tables), so trusting a project does not leave a stale untrusted twin behind.
  let next = toml;
  const existing = [...parseTrust(toml).keys()].filter(p => norm(p) === norm(projectPath));
  for (const spelling of existing) next = setTrust(next, spelling, trusted);
  if (!existing.length) next = setTrust(next, projectPath, trusted);

  try {
    if (toml) fs.writeFileSync(file + '.bak', toml);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function norm(p) {
  const t = String(p || '').replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? t.toLowerCase() : t;
}

module.exports = { get, set, parseTrust, setTrust, configPath };
