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

function readTrustFile(file = trustPath()) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw new Error(`Failed to read Pi trust store: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid Pi trust store: expected an object');
  }
  const out = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value === true || value === false || value === null) out[key] = value;
    else throw new Error(`Invalid Pi trust store: value for ${JSON.stringify(key)} must be true, false, or null`);
  }
  return out;
}

function writeTrustFile(data, file = trustPath()) {
  const sorted = {};
  for (const key of Object.keys(data || {}).sort()) {
    const value = data[key];
    if (value === true || value === false || value === null) sorted[key] = value;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
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

function set(projectPath, trusted) {
  if (!projectPath) return { ok: false, error: 'No project path' };
  try {
    const data = readTrustFile();
    const key = canonicalize(projectPath);
    if (trusted === null) delete data[key];
    else data[key] = trusted === true;
    writeTrustFile(data);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
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
  writeTrustFile,
  trustPath,
  agentDir,
  agentDirFromStore,
  agentsSharedSkillsDir,
  cliEnvForStore,
  _canonicalize: canonicalize,
};
