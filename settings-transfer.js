// settings-transfer.js — export/import of the GLOBAL settings blob to a JSON file (#145).
//
// Scope is the `global` blob only. Project blobs (`project:<path>`) are deliberately out:
// they are keyed on an absolute local path and would land on the target machine as dead
// entries. Secrets never ride along either — a backend PROFILE's env bundle (the one place
// that can carry an API key) lives in its own store, not in this blob. The single secret-
// bearing surface that *is* in the blob, `customLaunchers[].env`, is scrubbed by the caller
// on the way in (main.js `stripLauncherSecrets`, at the same trust boundary a normal save
// crosses) — an import must not be a back door around that guard.
//
// The blob still carries machine-local values by design (absolute project paths in
// `hiddenProjects`/`addedProjects`, a `preLaunchCmd`, a launcher's `cwd`). Those are the
// point of the export — a restore that dropped them would arrive with broken launchers —
// so they are exported as-is, and the UI says so. Only values that could not mean anything
// on another machine are stripped; see NON_PORTABLE_KEYS.
'use strict';

const EXPORT_VERSION = 1;
const APP_MARKER = 'switchboard';

// Dropped on export AND ignored on import. `windowBounds` are screen coordinates for a
// monitor layout the target machine does not have. `db_version` is the schema marker and
// lives in its own settings row — it has no business in the blob, but a hand-edited file
// could put it there, and importing it would lie to the migration runner.
const NON_PORTABLE_KEYS = ['windowBounds', 'db_version'];

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Strip the keys that cannot survive the trip to another machine. Returns a new object. */
function stripNonPortable(blob) {
  const out = {};
  for (const [key, value] of Object.entries(isPlainObject(blob) ? blob : {})) {
    if (NON_PORTABLE_KEYS.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * The file we write. `exportedAt` is passed in rather than read from the clock so the
 * payload is a pure function of its inputs (and the test can assert on it).
 */
function buildExportPayload(globalBlob, exportedAt) {
  return {
    app: APP_MARKER,
    version: EXPORT_VERSION,
    exportedAt: String(exportedAt || ''),
    global: stripNonPortable(globalBlob),
  };
}

/**
 * Validate a parsed export file. -> { ok: true, global } | { ok: false, error }
 * Strict about the envelope (so a random JSON cannot be merged into someone's settings),
 * permissive about the contents (unknown/future KEYS are preserved — a file written by a
 * newer Switchboard that only added settings must still import into an older one).
 */
function validateImportPayload(parsed) {
  if (!isPlainObject(parsed)) {
    return { ok: false, error: 'Not a settings file: the JSON root is not an object.' };
  }
  if (parsed.app !== APP_MARKER) {
    return { ok: false, error: 'Not a Switchboard settings export.' };
  }
  const version = Number(parsed.version);
  if (!Number.isInteger(version) || version < 1) {
    return { ok: false, error: 'The file has no valid format version.' };
  }
  // A NEWER format may have moved or reinterpreted keys — merging it blind could corrupt
  // settings in ways no per-key check would catch. Refuse rather than guess.
  if (version > EXPORT_VERSION) {
    return { ok: false, error: `The file was written by a newer version of Switchboard (format ${version}). Update Switchboard to import it.` };
  }
  if (!isPlainObject(parsed.global)) {
    return { ok: false, error: 'The file contains no global settings.' };
  }
  return { ok: true, global: stripNonPortable(parsed.global) };
}

/**
 * Merge an import onto the current blob: read-merge-write, the file wins per key. Keys the
 * file does not mention are KEPT — an export from a machine that never touched a setting
 * must not reset that setting here.
 */
function mergeImport(currentBlob, incoming) {
  const base = isPlainObject(currentBlob) ? currentBlob : {};
  return { ...base, ...stripNonPortable(incoming) };
}

module.exports = {
  EXPORT_VERSION,
  APP_MARKER,
  NON_PORTABLE_KEYS,
  buildExportPayload,
  validateImportPayload,
  mergeImport,
};
