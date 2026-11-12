// backends/pi/cache-warming.js — does the running Pi warm its own prompt cache while idle? (#861, spec 45)
//
// Pi 1.5.1 added `cacheWarming` ("off" | "streaming" | "idle", default "idle" since 1.5.1). With "idle", Pi itself
// refreshes an eligible cache for up to 30 minutes between runs, so a refresh from Switchboard would be paid twice.
// Pi reports nothing about it over its RPC (`get_state` has no such field), so the answer is derived from the two
// facts that decide it, both read from files and never from a child process:
//   - the installed Pi version (the package.json beside the binary): older than 1.5.1 has no warming;
//   - the effective `cacheWarming` in Pi's GLOBAL settings.json (the key is global only; absent = the default "idle").
// Whether a given model is eligible (it declares a cache lifetime, a refresh must save at least $0.05) is Pi's own
// decision per refresh and is not read here. Docs: docs/specs/30-pi-native.md, "Cache warming".
'use strict';

const fs = require('fs');
const path = require('path');
const trust = require('./trust');

const PACKAGE = '@earendil-works/pi-coding-agent';
const FIRST_WARMING_VERSION = [1, 5, 1];
const DEFAULT_MODE = 'idle';
const MODES = ['off', 'streaming', 'idle'];

function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function atLeast(v, floor) {
  for (let i = 0; i < floor.length; i++) {
    if (v[i] !== floor[i]) return v[i] > floor[i];
  }
  return true;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// The package.json of the Pi the binary runs: the npm shim's neighbour, else up from where a symlinked bin really lives.
function packageJsonOf(exe) {
  const candidates = [path.join(path.dirname(exe), 'node_modules', PACKAGE, 'package.json')];
  let real = exe;
  try { real = fs.realpathSync(exe); } catch { /* the shim itself is the answer then */ }
  let dir = path.dirname(real);
  for (let i = 0; i < 6; i++) {
    candidates.push(path.join(dir, 'package.json'));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  for (const file of candidates) {
    const pkg = readJson(file);
    if (pkg && pkg.name === PACKAGE && parseVersion(pkg.version)) return pkg;
  }
  return null;
}

let versionCache = null; // { exe, mtimeMs, version }

/** The installed Pi as `[major, minor, patch]`, or null when the binary or its package cannot be found. */
function installedVersion(exe) {
  if (!exe) return null;
  let st;
  try { st = fs.statSync(exe); } catch { return null; }
  if (versionCache && versionCache.exe === exe && versionCache.mtimeMs === st.mtimeMs) return versionCache.version;
  const pkg = packageJsonOf(exe);
  // An update replaces the package, not necessarily the shim: a null is not kept, so the next question reads again.
  const version = pkg ? parseVersion(pkg.version) : null;
  versionCache = version ? { exe, mtimeMs: st.mtimeMs, version } : null;
  return version;
}

/** The effective `cacheWarming` of Pi's global settings: one of MODES, the default when unset or not a known value. */
function warmingMode(dir = trust.agentDir()) {
  const settings = readJson(path.join(dir, 'settings.json'));
  const value = settings && typeof settings === 'object' ? settings.cacheWarming : undefined;
  return MODES.includes(value) ? value : DEFAULT_MODE;
}

/**
 * True when the Pi that would run warms its own cache between runs. An unreadable version is `false`: nothing is
 * known, so Switchboard's own refresh stays available.
 */
function runtimeWarmsIdle({ exe, dir } = {}) {
  // Asked at every busy/idle edge of every session: the files are read once per MEMO_MS, not once per edge.
  const key = [typeof exe === 'function' ? '*' : exe, dir || ''].join('|');
  const hit = answers.get(key);
  const t = Date.now();
  if (hit && t - hit.at < MEMO_MS) return hit.value;
  const file = typeof exe === 'function' ? exe() : exe;
  const version = installedVersion(file);
  const value = Boolean(version && atLeast(version, FIRST_WARMING_VERSION) && warmingMode(dir) === 'idle');
  answers.set(key, { at: t, value });
  return value;
}

const MEMO_MS = 5000;
const answers = new Map(); // key -> { at, value }

/** Test hook: forget what was read. */
function resetCache() { versionCache = null; answers.clear(); }

module.exports = { FIRST_WARMING_VERSION, parseVersion, atLeast, installedVersion, warmingMode, runtimeWarmsIdle, resetCache };
