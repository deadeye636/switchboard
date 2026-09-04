// backends/resource-expand.js — one directory, one level, as resource entries (#440).
//
// WHY THIS IS SHARED AND NOT A HOOK PER BACKEND. Reading a customization directory is the same work
// everywhere: list it, decide what counts as an entry, name each one. What differs is only the RULE —
// a skills directory is a tree that stops at whatever folder holds `SKILL.md`, a commands directory is
// flat `.md` files, a plugins directory is its subfolders. Five copies of the walk with five different
// filters would be the "fix a backend, check its siblings" trap by construction, so the mechanics live
// here and each backend declares which rule its directories follow.
//
// A backend still owns the DECLARATION (`createExpandResource` below takes its map), so a backend with a
// layout none of these rules describes writes its own `expandResource` and does not bend a rule to fit.
'use strict';

const fs = require('fs');
const path = require('path');

// A directory listing can be a lot; a UI list cannot. The cap belongs to the CONTRACT rather than to
// one backend's walk — hermes caps its own at 500 internally, which protected hermes and nobody else.
const MAX_ENTRIES = 500;

function statOf(p) {
  try { return fs.statSync(p); } catch { return null; }
}

// `Dirent.isDirectory()` is false for a Windows junction, which is how a junctioned skills directory
// became invisible with no error to see (#440). Ask the filesystem rather than the directory entry:
// `statSync` follows the reparse point. Containment is enforced by the caller against realpath, so
// following a link cannot widen what is reachable.
function isDirFollowingLinks(p) {
  const st = statOf(p);
  return !!(st && st.isDirectory());
}

function isFileFollowingLinks(p) {
  const st = statOf(p);
  return !!(st && st.isFile());
}

function readDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
}

function entry(out, { kind, name, filePath, source, scope }) {
  out.push({
    kind,
    scope: scope || 'global',
    name,
    path: filePath,
    source: source || null,
    description: null,
  });
}

// A skills tree: descend until a folder holds SKILL.md, and report THAT folder as one skill. Optionally
// also report bare `.md` files sitting directly in the root, which is how pi allows a single-file skill.
function expandSkillTree(dir, rule, out) {
  const stack = [dir];
  let truncated = false;
  while (stack.length) {
    if (out.length >= MAX_ENTRIES) { truncated = true; break; }
    const current = stack.pop();
    const skillFile = path.join(current, 'SKILL.md');
    if (isFileFollowingLinks(skillFile)) {
      entry(out, { kind: rule.kind, name: path.basename(current), filePath: skillFile, source: rule.source, scope: rule.scope });
      continue;
    }
    const entries = readDir(current);
    if (!entries) continue;      // unreadable: skip this branch, never fail the whole expansion
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const p = path.join(current, ent.name);
      if (isDirFollowingLinks(p)) { stack.push(p); continue; }
      if (rule.rootMarkdown && current === dir && /\.md$/i.test(ent.name)) {
        entry(out, { kind: rule.kind, name: ent.name.replace(/\.md$/i, ''), filePath: p, source: rule.source, scope: rule.scope });
      }
    }
  }
  return truncated || stack.length > 0;
}

// Flat files in one directory, optionally filtered by extension. `dirWithIndex` covers pi's extensions,
// where a folder counts when it holds that file.
function expandFlatFiles(dir, rule, out) {
  const entries = readDir(dir);
  if (!entries) return false;
  for (const ent of entries) {
    if (out.length >= MAX_ENTRIES) return true;
    if (ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (isDirFollowingLinks(p)) {
      if (!rule.dirWithIndex) continue;
      const indexFile = path.join(p, rule.dirWithIndex);
      if (isFileFollowingLinks(indexFile)) {
        entry(out, { kind: rule.kind, name: ent.name, filePath: indexFile, source: rule.source, scope: rule.scope });
      }
      continue;
    }
    if (!isFileFollowingLinks(p)) continue;
    if (rule.exts && !rule.exts.some(ext => ent.name.toLowerCase().endsWith(ext))) continue;
    const name = rule.keepExtension ? ent.name : ent.name.replace(/\.[^.]+$/, '');
    entry(out, { kind: rule.kind, name, filePath: p, source: rule.source, scope: rule.scope });
  }
  return false;
}

// Subdirectories as entries — a plugin or a package is its folder, not a file inside it.
function expandDirs(dir, rule, out) {
  const entries = readDir(dir);
  if (!entries) return false;
  for (const ent of entries) {
    if (out.length >= MAX_ENTRIES) return true;
    if (ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (!isDirFollowingLinks(p)) continue;
    entry(out, { kind: rule.kind, name: ent.name, filePath: p, source: rule.source, scope: rule.scope });
  }
  return false;
}

const MODES = {
  skillTree: expandSkillTree,
  flatFiles: expandFlatFiles,
  dirs: expandDirs,
};

/**
 * Expand ONE directory, one level (a skills tree counts as one level: it stops at the skill).
 *
 * `rules` maps a listed directory's `source` to its rule, because `source` is what a listing entry
 * carries and what makes `commands` different from `agents` when both are flat markdown.
 *
 * Returns `{ ok, entries, truncated }`, or `{ ok: false, reason }` when this backend does not know how
 * to expand that directory — which is an answer, not an error.
 */
/**
 * `rules` is a map from `source` to rule — or a FUNCTION from source to rule, for a backend whose
 * sources are not all known in advance. Plugin skills are the case — Claude's (#463) and Codex' (#536)
 * alike: each installed plugin has a
 * skills directory of its own, so the source carries the plugin's name (#463) and no static map can
 * spell every key. A resolver keeps that knowledge in the backend, which is where a plugin layout
 * belongs, without giving it a second copy of this walk.
 */
function createExpandResource(rules) {
  const ruleFor = typeof rules === 'function' ? rules : (source) => (source ? rules[source] : null);

  // Which listed directories this backend can read into. `app/backend-resources.js` asks before it lets
  // a CHILD path through: a directory the backend cannot enumerate is one whose layout it does not
  // claim to know, and trusting an arbitrary child of it would make the read path wider than the
  // listing that is supposed to bound it.
  expandResource.knowsSource = (source) => !!(source && ruleFor(source));

  function expandResource({ path: dirPath, source, scope } = {}) {
    if (!dirPath) return { ok: false, reason: 'No directory given.' };
    const rule = source ? ruleFor(source) : null;
    if (!rule) return { ok: false, reason: 'This is not a directory Switchboard knows how to list.' };
    if (!isDirFollowingLinks(dirPath)) return { ok: false, reason: 'That directory is no longer there.' };

    const out = [];
    const truncated = MODES[rule.mode](dirPath, { ...rule, scope: scope || 'global' }, out);
    out.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, entries: out, truncated: !!truncated };
  }

  return expandResource;
}

module.exports = {
  createExpandResource,
  MAX_ENTRIES,
  // exported for the tests and for a backend that needs one rule outside a full map
  _expandSkillTree: expandSkillTree,
  _expandFlatFiles: expandFlatFiles,
  _expandDirs: expandDirs,
  _isDirFollowingLinks: isDirFollowingLinks,
};
