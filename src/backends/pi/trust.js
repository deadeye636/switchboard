// backends/pi/trust.js — Pi's per-project trust store adapter (#406).
//
// Pi keeps project trust in its AGENT config dir, not in the sessions dir:
//   (PI_CODING_AGENT_DIR || ~/.pi/agent)/trust.json
// The JSON object maps canonical project paths to true/false; lookup walks parents, so trusting a
// parent folder trusts its children unless a child records its own false.
//
// This module deliberately reimplements the tiny file contract instead of importing Pi's ESM internals:
// Switchboard is CommonJS, the package location is not part of Pi's public interface, and the backend
// owns its format knowledge here like Codex' TOML trust adapter does.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeTextFile } = require('../../app/safe-write');

function expandTilde(p) {
  const s = String(p || '');
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || (process.platform === 'win32' && s.startsWith('~\\'))) {
    return path.join(os.homedir(), s.slice(2));
  }
  return s;
}

function resolvePath(p) {
  return path.resolve(expandTilde(p));
}

function canonicalize(p) {
  const resolved = resolvePath(p);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

// When Switchboard isolates Pi's sessions with SWITCHBOARD_STORE_PI, isolate Pi's config/trust store too.
// The store variable names the sessions dir directly (`.../stores/pi` in the demo). Pi's own config dir is
// separate, so put it beside the isolated sessions root rather than touching the user's real ~/.pi/agent.
function agentDirFromStore(store) {
  if (!store) return null;
  const sessions = resolvePath(store);
  const parent = path.dirname(sessions);
  const base = path.basename(sessions).toLowerCase();
  const parentBase = path.basename(parent).toLowerCase();
  // If somebody points SWITCHBOARD_STORE_PI at an actual Pi agent sessions dir, use its parent as the
  // agent dir. Otherwise create a sibling config dir next to the isolated sessions store.
  if (base === 'sessions' && parentBase === 'agent') return parent;
  return path.join(parent, 'pi-agent');
}

function agentDir() {
  return agentDirFromStore(process.env.SWITCHBOARD_STORE_PI)
    || (process.env.PI_CODING_AGENT_DIR ? resolvePath(process.env.PI_CODING_AGENT_DIR) : path.join(os.homedir(), '.pi', 'agent'));
}

/**
 * The SHARED skills directory (`~/.agents/skills`), which is a convention several CLIs read rather than
 * anything Pi owns — and which is therefore easy to forget when isolating (#241).
 *
 * It has to move with the isolated store like everything else: an isolated instance listing the user's
 * real skills is the same leak as listing their real settings, and `openResource` hands those paths to
 * the OS. Anchored beside the isolated agent dir, so a demo run reads its own `.agents` or nothing at all.
 */
function agentsSharedSkillsDir() {
  const store = process.env.SWITCHBOARD_STORE_PI;
  if (store) return path.join(path.dirname(resolvePath(store)), '.agents', 'skills');
  return path.join(os.homedir(), '.agents', 'skills');
}

function trustPath() {
  return path.join(agentDir(), 'trust.json');
}

/**
 * The file's text and what it parses to, in one read.
 *
 * `set` needs both: the object to change, and the exact bytes it changed — that text is the baseline the
 * write is refused against (#542), and re-reading the file to get it would be a second answer that can
 * disagree with the first.
 */
function readTrustSource(file = trustPath()) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (err) {
    if (err && err.code === 'ENOENT') return { raw: null, data: {} };
    // This escapes to callers and can reach a dialog; the errno names the file (#457).
    throw authored(`Failed to read Pi trust store (${err && err.code ? err.code : 'unknown error'}).`);
  }
  return { raw, data: parseTrustText(raw) };
}

/**
 * An error whose text this module WROTE, and which may therefore be shown.
 *
 * The marker is the point: `set` catches everything, and a thrown filesystem or parser message names the
 * file under the user's home (#457). Only a sentence written here travels; anything else is answered with
 * one that says what happened and nothing about where.
 */
function authored(message) {
  const err = new Error(message);
  err.trustReason = message;
  return err;
}

function readTrustFile(file = trustPath()) {
  return readTrustSource(file).data;
}

function parseTrustText(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (err) {
    throw authored('Invalid Pi trust store: it is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw authored('Invalid Pi trust store: expected an object');
  }
  const out = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value === true || value === false || value === null) out[key] = value;
    else throw authored(`Invalid Pi trust store: value for ${JSON.stringify(key)} must be true, false, or null`);
  }
  return out;
}

/** The text this store is written as: its keys sorted, one value per line, a trailing newline. */
function trustText(data) {
  const sorted = {};
  for (const key of Object.keys(data || {}).sort()) {
    const value = data[key];
    if (value === true || value === false || value === null) sorted[key] = value;
  }
  return JSON.stringify(sorted, null, 2) + '\n';
}

/**
 * Write the store, through `safe-write.js` like every other write into a file a CLI owns (#542).
 *
 * `expectPrevious` is the text the caller changed — `null` when there was no file. Pi rewrites this file
 * itself whenever it is asked to trust something, and the whole object goes back here, so without the
 * compare an answer Pi recorded between our read and our write is not overwritten by a conflicting value:
 * it is absent from what we hand back.
 */
function writeTrustFile(data, file = trustPath(), { expectPrevious = null } = {}) {
  const res = writeTextFile(file, trustText(data), { expectPrevious, mustExist: false });
  if (!res.ok) {
    if (res.code === 'stale') return { ok: false, stale: true };
    // The cause names a file under the user's home, so only its errno travels (#457).
    throw authored(`Failed to write Pi trust store (${res.cause && res.cause.code ? res.cause.code : 'unknown error'}).`);
  }
  return { ok: true };
}

function nearest(data, projectPath) {
  let current = canonicalize(projectPath);
  while (true) {
    const value = data[current];
    if (value === true || value === false) return { path: current, decision: value };
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function get(projectPath) {
  if (!projectPath) return null;
  return (nearest(readTrustFile(), projectPath) || {}).decision ?? null;
}

function getMany(projectPaths) {
  const out = new Map();
  const data = readTrustFile();
  for (const p of projectPaths || []) out.set(p, p ? ((nearest(data, p) || {}).decision ?? null) : null);
  return out;
}

// How many times the read-modify-write is re-derived before giving up (#542), the same three the Claude
// and Codex writers take: a refused write means the file moved, and the answer is to look again.
const WRITE_ATTEMPTS = 3;

function set(projectPath, trusted) {
  if (!projectPath) return { ok: false, error: 'No project path' };
  try {
    for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        // A short pause, so three attempts are three tries rather than three collisions with one burst.
        const until = Date.now() + 5 + Math.floor(Math.random() * 15);
        while (Date.now() < until) { /* wait */ }
      }
      const { raw, data } = readTrustSource();
      const key = canonicalize(projectPath);
      if (trusted === null) delete data[key];
      else data[key] = trusted === true;
      const res = writeTrustFile(data, trustPath(), { expectPrevious: raw });
      if (res.ok) return { ok: true };
    }
    return { ok: false, error: "Pi's trust file could not be written: another program kept changing it. Try again." };
  } catch (err) {
    // Same reasoning as Codex': a raw message names a file under the user's home (#457). A reason this
    // module wrote is marked as such and travels; anything else is answered without it.
    return { ok: false, error: (err && err.trustReason) || "Pi's trust file could not be written." };
  }
}

function cliEnvForStore(store = process.env.SWITCHBOARD_STORE_PI) {
  const dir = agentDirFromStore(store);
  return dir ? { PI_CODING_AGENT_DIR: dir } : null;
}

module.exports = {
  get,
  getMany,
  set,
  readTrustFile,
  readTrustSource,
  writeTrustFile,
  trustPath,
  agentDir,
  agentDirFromStore,
  agentsSharedSkillsDir,
  cliEnvForStore,
  _canonicalize: canonicalize,
};
