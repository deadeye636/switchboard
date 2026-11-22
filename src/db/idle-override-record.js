// The shape of a session's stored idle-maintenance override (`session_meta.idleOverride`, spec 45). Pure and outside the store,
// because no test loads a module that opens the database (.claude/rules/db.md).
'use strict';

const MAX_STRING = 32;

/**
 * Only `idleMaintenance*` keys with a plain value survive: a string up to `MAX_STRING`, a finite number or a boolean. What the
 * value means is `src/app/idle-maintenance.js`'s `planFor`, which bounds every field again. Null when nothing is left.
 */
function cleanIdleOverride(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  for (const [key, value] of Object.entries(v)) {
    if (!key.startsWith('idleMaintenance') || key.length > 64) continue;
    if (typeof value === 'string' && value.length <= MAX_STRING) out[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

module.exports = { cleanIdleOverride };
