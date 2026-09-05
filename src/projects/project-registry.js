// project-registry.js — the project list is a LIST (#167).
//
// It used to be a derivation: the sidebar's projects were read out of the transcripts on disk, every
// render. Three things followed from that, and all three were bugs:
//
//   - A project with no transcript could not exist. Add it by hand and nothing happened — `addProject`
//     ticked a box on a filter, and the filter could only ever REMOVE from what discovery had found.
//   - "Remove" could not be implemented, so it was faked as a permanent hide: the next scan would have
//     derived the project straight back off the sessions still sitting on disk.
//   - Hiding and deleting were therefore the same operation, and neither was what the other should be.
//
// This module holds the decisions, and nothing else: no database, no filesystem. Given what is known
// about a project — is it on the list, was it removed and when — and what just happened to it, it says
// whether the list changes. That is the whole feature, and it is the part that has to be right.
//
// THE THREE INVISIBLE STATES, kept apart (they were one list before):
//
//   auto-hidden  on the list, hidden because it went stale (#57). Activity brings it back by itself.
//   hidden       on the list, hidden because the user said so. New sessions do NOT bring it back —
//                that is the entire point of saying "hide".
//   removed      NOT on the list, and a tombstone remembers when. The sessions stay on disk.
//
// Precedence: removed > hidden > auto-hidden.
'use strict';

/**
 * How long a tombstone outlives its last session.
 *
 * The sweep's real criterion is "no session for this path remains in ANY backend store" — with none
 * left, the tombstone guards nothing, and a genuinely NEW session there should register the project
 * again. The age is a safety belt, not the criterion: an unmounted network drive looks exactly like a
 * deleted one, so without it every tombstone on `Z:\` would be swept the moment the drive went offline,
 * and every project on it would resurrect the moment it came back.
 */
const TOMBSTONE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days

/** The empty state — a project nothing is known about is simply not on the list. */
const UNKNOWN = { registered: 0, hidden: 0, autoHidden: 0, removedAt: null };

const ms = (iso) => {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
};

/**
 * Should this project go on the list?
 *
 * @param {object} meta            the project's row: { registered, removedAt }
 * @param {object} event
 *   @param {'scan'|'user'} event.source  who is asking. `user` = an explicit act (added by hand, or a
 *                                        session launched there). `scan` = discovery found a session.
 *   @param {boolean} event.autoAdd       the "add projects automatically" setting.
 *   @param {string}  [event.sessionStartedAt]  ISO timestamp of when the newest session discovery found
 *                                        BEGAN — the only time the tombstone is judged on (#575). Null
 *                                        when the store cannot say; never a recency standing in for one.
 * @returns {boolean}
 */
function shouldRegister(meta, event) {
  const m = { ...UNKNOWN, ...(meta || {}) };
  const { source, autoAdd, sessionStartedAt } = event || {};

  // An explicit act always registers, in BOTH modes — and it buries the tombstone. Manual mode means
  // "nobody but me writes to the list", not "I cannot start a session anywhere".
  if (source === 'user') return true;

  // Discovery. In manual mode it may not write to the list at all.
  if (!autoAdd) return false;
  if (m.registered) return false;              // already on it — nothing to do

  // The tombstone. Only a session that STARTED after the removal brings the project back; the ones that
  // were already on disk when it was removed are exactly what the tombstone exists to ignore. Without
  // this, "remove" would be undone by the very next scan — which is why it was never implemented.
  //
  // A session that was already RUNNING is one of those, however recently it wrote (#575). This used to
  // compare against the newest RECENCY the scan reported, and a CLI live in the project at the moment of
  // removal appends within seconds — so its recency moved past the tombstone and "remove" was a no-op for
  // exactly the project the user was working in. The recency is deliberately not consulted here at all.
  //
  // NO START TIME IS A REFUSAL, NOT A FALLBACK. A store with no timestamps (agy) reports null, and so
  // does a Claude folder whose transcripts are still header-only. Falling back to the recency would
  // restore the bug above for precisely those cases, and the two failure modes are not symmetrical: a
  // refusal costs a project the user can put back at any time — adding it by hand or launching a session
  // in it is `source: 'user'`, which registers in both modes and buries the tombstone — while a fallback
  // costs a removal that silently never happens and that the user has no way to make stick.
  //
  // Equal timestamps do NOT bring it back: a start that is not NEWER than the removal is not a session
  // that began after it, and at the same instant the removal is the later act. A start that does not
  // parse is the same answer by the same route — `ms()` reads it as 0, older than any removal.
  if (m.removedAt) {
    if (!sessionStartedAt) return false;
    if (ms(sessionStartedAt) <= ms(m.removedAt)) return false;
  }

  return true;
}

/**
 * May this tombstone be forgotten? (The sweep.)
 *
 * @param {object} meta                 { removedAt }
 * @param {object} opts
 *   @param {boolean} opts.hasSessions  does ANY backend store still hold a session for this path?
 *   @param {number}  opts.now          ms
 *   @param {number}  [opts.graceMs]
 */
function shouldDropTombstone(meta, { hasSessions, now, graceMs = TOMBSTONE_GRACE_MS } = {}) {
  const m = { ...UNKNOWN, ...(meta || {}) };
  if (!m.removedAt) return false;
  // Drop it while its sessions still exist and the project resurrects itself on the next scan — the
  // cleanup would quietly undo the deletion. This is the criterion; the age below is only the belt.
  if (hasSessions) return false;
  return (now - ms(m.removedAt)) >= graceMs;
}

/** Is this project shown in the sidebar? */
function isVisible(meta) {
  const m = { ...UNKNOWN, ...(meta || {}) };
  return !!m.registered && !m.hidden && !m.autoHidden;
}

/**
 * The state a REMOVAL leaves behind.
 *
 * `hidden` is a property of a LISTED project ("on the list, not shown"), so a removal has nothing left
 * for it to qualify and clears it. The project therefore comes back VISIBLE — the only answer that does
 * not silently swallow something the user just re-added. Same for the auto-hide and its timer.
 */
function removalState(nowIso) {
  return { registered: 0, hidden: 0, autoHidden: 0, autoHideResetAt: null, removedAt: nowIso };
}

/** The state a REGISTRATION leaves behind. It buries the tombstone, and it comes back visible. */
function registrationState(nowIso) {
  return { registered: 1, hidden: 0, autoHidden: 0, autoHideResetAt: nowIso, registeredAt: nowIso, removedAt: null };
}

module.exports = {
  TOMBSTONE_GRACE_MS,
  shouldRegister,
  shouldDropTombstone,
  isVisible,
  removalState,
  registrationState,
};
