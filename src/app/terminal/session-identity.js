'use strict';

/**
 * Who a late exit belongs to (#854). Stop is synchronous but the process's exit lands later, and the
 * renderer may reopen the same id in between: the old exit then meets either a different session object
 * under the id, or no entry at all while the reopen is still working through its awaits (close-terminal
 * drops an exited entry before openTerminal registers the replacement). Either way the id is no longer
 * the exiting process's to announce or clean up after.
 */

// Ids an openTerminal is working on right now, with a count because a retry calls it again.
const opening = new Map();

/** Mark an open of `id` as in flight; call the returned function when it is over, on every path. */
function beginOpen(id) {
  opening.set(id, (opening.get(id) || 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (opening.get(id) || 1) - 1;
    if (n > 0) opening.set(id, n); else opening.delete(id);
  };
}

function isOpening(id) {
  return opening.has(id);
}

/**
 * Does `session` still own `id`? Yes when it is the registered one. An entry that is gone is still its own
 * to clean up after, unless an open of the id is in flight: then the id already belongs to the process
 * about to be registered. A different session object under the id is never its own.
 */
function ownsId(activeSessions, id, session) {
  const held = activeSessions.get(id);
  if (held === session) return true;
  if (held === undefined) return !isOpening(id);
  return false;
}

/** Drop `id` only when `session` is the one registered there (or nothing is). Returns true when it ran. */
function deleteIfOwner(activeSessions, id, session) {
  const held = activeSessions.get(id);
  if (held !== undefined && held !== session) return false;
  activeSessions.delete(id);
  return true;
}

module.exports = { ownsId, deleteIfOwner, beginOpen, isOpening };
