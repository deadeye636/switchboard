// The one rule for renumbering the saved variables' manual order (#676), kept out of settings-store.js
// so a test can reach it: nothing under test/ loads a module that opens the database (see db.md).
//
// The renderer sends the order it is showing. That list can be stale — another window may have created
// or deleted a variable since — so it is a request about the rows it NAMES, not a claim about the table:
//   - an id that no longer exists is ignored;
//   - an id named twice counts once, at its first place;
//   - a row the list does not name keeps its place relative to the other unnamed rows, AFTER the named ones.
// The result is every current id exactly once, which the store then numbers 1..n.
'use strict';

/**
 * @param {string[]} currentIds  every id in the table, in today's order
 * @param {unknown[]} requestedIds  the order the caller wants, possibly stale
 * @returns {string[]}
 */
function mergeVariableOrder(currentIds, requestedIds) {
  const current = Array.isArray(currentIds) ? currentIds : [];
  const exists = new Set(current);
  const seen = new Set();
  const out = [];
  for (const id of Array.isArray(requestedIds) ? requestedIds : []) {
    if (typeof id !== 'string' || !exists.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  for (const id of current) {
    if (!seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

module.exports = { mergeVariableOrder };
