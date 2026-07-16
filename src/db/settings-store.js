// Settings and saved variables — the two key/value stores (#217 step 5).
//
// Settings is one table of JSON blobs keyed by string: the global blob, one `project:<path>` blob per
// project, and a handful of scalars like `db_version`. Saved variables are the named, reusable values
// (spec 12) the Variables panel edits; a secret's plaintext lives in `value` and is deliberately absent
// from the list statements, which is why there are separate list/get shapes.
//
// THE STATEMENTS ARE EXPORTED, and that is a deliberate seam, not laziness. The cross-domain transactions
// in project-refs.js rename and delete a project's whole footprint — meta, tags, handoffs AND its settings
// blob — in ONE transaction. They cannot call the functions below, because those wrap themselves in
// runWithBusyRetry, and retrying inside an open transaction is a different behaviour, not a tidier one.
// So a sibling inside src/db/ takes the raw statement; nothing outside src/db/ ever sees them.
'use strict';

const { db } = require('./connection');
const { runWithBusyRetry } = require('./sqlite-busy-retry');

const stmts = {
  settingsGet: db.prepare('SELECT value FROM settings WHERE key = ?'),
  settingsUpsert: db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),
  settingsDelete: db.prepare('DELETE FROM settings WHERE key = ?'),
  // Remap moves the `project:<path>` blob to the new key (#55).
  settingsRename: db.prepare('UPDATE settings SET key = ? WHERE key = ?'),
  // Saved variables (Saved Variables panel)
  // insertTemplate is NOT a secret (it only describes how to insert, not the
  // value) so it is safe to carry in the list statements; `value` stays excluded.
  savedVariablesList: db.prepare(`
    SELECT id, name, secret, scope, projectPath, tags, insertTemplate, createdAt, updatedAt, lastUsedAt
    FROM saved_variables
    WHERE scope = 'global' OR (scope = 'project' AND projectPath = ?)
    ORDER BY LOWER(name), updatedAt DESC
  `),
  // Every variable regardless of scope/project — used by the Variables admin tab
  // which needs the full CRUD list (not just the ones applicable to one project).
  savedVariablesListAll: db.prepare(`
    SELECT id, name, secret, scope, projectPath, tags, insertTemplate, createdAt, updatedAt, lastUsedAt
    FROM saved_variables
    ORDER BY LOWER(name), updatedAt DESC
  `),
  savedVariableGet: db.prepare('SELECT * FROM saved_variables WHERE id = ?'),
  savedVariableUpsert: db.prepare(`
    INSERT INTO saved_variables
      (id, name, value, valueEncoding, secret, scope, projectPath, tags, insertTemplate, createdAt, updatedAt, lastUsedAt)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      value = excluded.value,
      valueEncoding = excluded.valueEncoding,
      secret = excluded.secret,
      scope = excluded.scope,
      projectPath = excluded.projectPath,
      tags = excluded.tags,
      insertTemplate = excluded.insertTemplate,
      updatedAt = excluded.updatedAt
  `),
  savedVariableDelete: db.prepare('DELETE FROM saved_variables WHERE id = ?'),
  savedVariableTouch: db.prepare('UPDATE saved_variables SET lastUsedAt = ? WHERE id = ?'),
  settingsByPrefix: db.prepare('SELECT key, value FROM settings WHERE key LIKE ?'),
};


function getSetting(key) {
  const row = stmts.settingsGet.get(key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function setSetting(key, value) {
  runWithBusyRetry(() => stmts.settingsUpsert.run(key, JSON.stringify(value)));
}

function deleteSetting(key) {
  runWithBusyRetry(() => stmts.settingsDelete.run(key));
}

/** Every settings blob whose key starts with `prefix` (e.g. 'project:'), parsed. */
function listSettings(prefix) {
  return stmts.settingsByPrefix.all(prefix + '%').map(row => {
    let value;
    try { value = JSON.parse(row.value); } catch { value = null; }
    return { key: row.key, value };
  });
}

// --- Saved variable functions ---

function parseSavedVariableTags(tags) {
  if (Array.isArray(tags)) return tags;
  if (!tags) return [];
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeSavedVariableRow(row) {
  if (!row) return null;
  return {
    ...row,
    secret: !!row.secret,
    tags: parseSavedVariableTags(row.tags),
    insertTemplate: row.insertTemplate || '',
  };
}

function listSavedVariables(projectPath = null) {
  return stmts.savedVariablesList.all(projectPath || '').map(normalizeSavedVariableRow);
}

function listAllSavedVariables() {
  return stmts.savedVariablesListAll.all().map(normalizeSavedVariableRow);
}

function getSavedVariable(id) {
  return normalizeSavedVariableRow(stmts.savedVariableGet.get(id));
}

function saveSavedVariable(variable) {
  const now = variable.updatedAt || new Date().toISOString();
  const existing = variable.id ? stmts.savedVariableGet.get(variable.id) : null;
  const createdAt = variable.createdAt || existing?.createdAt || now;
  const row = {
    id: variable.id,
    name: variable.name,
    value: variable.value,
    valueEncoding: variable.valueEncoding || 'plain',
    secret: variable.secret ? 1 : 0,
    scope: variable.scope || 'global',
    projectPath: variable.scope === 'project' ? (variable.projectPath || null) : null,
    tags: JSON.stringify(Array.isArray(variable.tags) ? variable.tags : []),
    insertTemplate: typeof variable.insertTemplate === 'string' ? variable.insertTemplate : '',
    createdAt,
    updatedAt: now,
    lastUsedAt: existing?.lastUsedAt || null,
  };
  runWithBusyRetry(() => stmts.savedVariableUpsert.run(
    row.id, row.name, row.value, row.valueEncoding, row.secret, row.scope,
    row.projectPath, row.tags, row.insertTemplate, row.createdAt, row.updatedAt, row.lastUsedAt
  ));
  return getSavedVariable(row.id);
}

function deleteSavedVariable(id) {
  runWithBusyRetry(() => stmts.savedVariableDelete.run(id));
}

function touchSavedVariable(id) {
  runWithBusyRetry(() => stmts.savedVariableTouch.run(new Date().toISOString(), id));
}

module.exports = {
  getSetting, setSetting, deleteSetting, listSettings,
  listSavedVariables, listAllSavedVariables, getSavedVariable, saveSavedVariable, deleteSavedVariable,
  touchSavedVariable,
  // For project-refs.js's cross-domain transactions only — see the header.
  stmts,
};
