// scripts/demo-settings.js — seed the DEMO instance's settings so the demo shows what it advertises.
//
// A fresh install enables **Claude only**: `isEnabled()` falls back to `descriptor.id === 'claude'`
// for anything not explicitly stored, because a backend the user never asked for should not appear
// (#162). That default is right for a real install and wrong for the demo, whose whole point is a
// multi-backend sidebar: the seeded Codex and Pi sessions parse fine and are simply never scanned, so
// `demo-beta` sat empty and `demo-mixed` showed one row of three (#244).
//
// This runs UNDER ELECTRON-AS-NODE, because `better-sqlite3` is built against Electron's ABI:
//
//   ELECTRON_RUN_AS_NODE=1 <electron> scripts/demo-settings.js
//
// `scripts/demo-start.js` does that before launching. Idempotent, and it refuses to touch anything but
// a demo database — see the guard below.
'use strict';

const path = require('path');

const dataDir = process.env.SWITCHBOARD_DATA_DIR || '';
const demoDir = (process.env.SWITCHBOARD_DEMO_DIR || 'C:/temp/switchboard').replace(/\\/g, '/');

// GUARD: this writes settings, so it must never run against a real install. The data dir has to be
// inside the demo tree — not merely set, because `SWITCHBOARD_DATA_DIR` alone is also how a sandbox
// (or a user) points at real data.
const normalized = dataDir.replace(/\\/g, '/');
if (!normalized || !normalized.toLowerCase().startsWith(demoDir.toLowerCase())) {
  console.error(`[demo-settings] refusing: SWITCHBOARD_DATA_DIR (${dataDir || 'unset'}) is not inside ${demoDir}`);
  process.exit(1);
}

// Required AFTER the guard, and only ever here: db.js resolves DATA_DIR at module load.
const db = require('../src/db/db');
const backends = require('../src/backends');

// The registry only needs to LIST what is registered here; nothing in this script asks it what is
// enabled (that is exactly what we are about to write), so a stub global-settings reader is enough.
backends.init({ getGlobalSettings: () => ({}) });

const global = db.getSetting('global') || {};
const enabled = { ...(global.backendEnabled || {}) };

const ready = backends.list().filter(b => b.status === 'ready' && !b.isProfile);
const turnedOn = [];
for (const b of ready) {
  if (enabled[b.id] === true) continue;      // already on — say nothing
  enabled[b.id] = true;
  turnedOn.push(b.id);
}

if (!turnedOn.length) {
  console.log('[demo-settings] all ready backends already enabled');
  process.exit(0);
}

db.setSetting('global', { ...global, backendEnabled: enabled });
console.log(`[demo-settings] enabled: ${turnedOn.join(', ')}`);
