// --- Which live session may claim a store record (#527) ---
//
// `matchLiveSession` correlates by DIRECTORY and a time window, and nothing in a record says which
// process wrote it. With two unpaired sessions of one backend in one project that is not enough: the
// core asks them in the order they were opened, so the older one is offered the record first and takes
// it — including the record the younger one's own turn just produced. Everything downstream then follows
// the wrong identity: busy/idle lands on the other card, `realSessionId` names a conversation that
// session is not in, and the session that actually owns the record can never claim it, because it is
// held by someone else from then on.
//
// What this adds is one question the correlation never asked: could this session have written that
// record? A session cannot have written one before it existed — before its spawn, or before its first
// turn where the backend says its record appears then (#512). A session that has been asked nothing has
// written nothing, and that is what resolves the reported case.
//
// **Among the sessions that could have written it, the OLDEST one takes it**, which is the order the
// store offers records in: `matchLiveSession` hands back the oldest unclaimed record, so pairing the
// oldest eligible session with it walks both lists in the same direction and each session ends up on its
// own record. Awarding it to the NEWEST instead — which a first version did, reasoning that a session
// able to write since earlier would already have paired — swaps two sessions' records outright whenever
// both records are born after both sessions started. The reasoning was circular: a session that HAD
// paired is not a candidate here at all, so the tiebreak is only ever reached in the case where its
// premise is false.
//
// So the rule is subtractive. It can make a session decline a record it could not have written; it never
// re-orders who gets what, and an exact tie is decided the way it was before this existed — the session
// asking first takes it, because a window is a fact that never changes and refusing both would strand
// them for good.
//
// Three answers:
//
//   'claim'   — the asking session is the oldest one that could have written it (ties included).
//   'defer'   — an older session could have written it. It is offered the same record on the same tick,
//               takes it, and the asker is then offered the next one.
//   'unknown' — the backend did not date the record, or nothing could have written it. The caller keeps
//               the behaviour it had before this existed rather than inventing one.
//
// **The grace belongs to the ASKING session alone**, and getting that wrong is what a first version of
// this did: extending it to every candidate widened each of their windows ten seconds backwards, which
// made a younger session a possible writer of the older one's record. Two owners meant nobody paired —
// permanently, since the windows never change — so two sessions started within ten seconds of each other
// both lost busy/idle for their whole life, the unclaimed record was then offered to every later session
// in that project, and when one of the two exited the other adopted its id after all.
//
// One thing it does NOT decide: a session with no window at all (`from === 0` — a first-turn backend
// whose turn was submitted through a path the app does not see) is not held back. It answers 'unknown'
// and the caller pairs it as it always did. Declining there would strand a session for a signal we may
// simply have missed, so the honest limit of this module is that it protects a record only while its
// real writer is live, unpaired and known to us.
//
// Free of Electron and the filesystem so the decision is unit-tested (`test/record-claim.test.js`).
'use strict';


/**
 * The earliest moment this session could have written a store record.
 *
 * 0 means "none yet": a backend that writes its record with the first turn has written nothing for a
 * session nobody has asked anything, so such a session owns no record at all.
 */
function recordWindowStart(session, recordAppearsAt) {
  if (!session) return 0;
  if (recordAppearsAt === 'first-turn') return session._firstTurnAt || 0;
  return session._openedAt || 0;
}

/**
 * May `askingId` claim a record written at `bornMs`?
 *
 *   candidates — every UNPAIRED live session of this backend in this project, as
 *                `{ sessionId, from }`, `from` from `recordWindowStart` above. The asking session is
 *                one of them.
 *   graceMs    — how much earlier than its own start a record may be born and still be the ASKING
 *                session's. The store writes it just after we spawn, and the two clocks are not the same
 *                one. Never extended to the other candidates — see the header.
 */
function claimVerdict({ candidates = [], bornMs = null, askingId = null, graceMs = 0 } = {}) {
  if (!Number.isFinite(bornMs)) return 'unknown';

  const asking = candidates.find(c => c && c.sessionId === askingId) || null;
  const askingCould = !!asking && asking.from > 0 && (asking.from - graceMs) <= bornMs;

  // The asking session has a start, and the record predates it by more than the grace. It is provably
  // not this session's, whoever else's it is.
  if (!askingCould && asking && asking.from > 0) return 'defer';

  // Who genuinely already existed when the record was written. The grace is not part of this: it is an
  // allowance for one session's own clock, and a session that only reaches the record THROUGH it has a
  // weaker claim than one that plainly predates it.
  const others = candidates.filter(c => c && c !== asking && c.from > 0 && c.from <= bornMs);
  const strict = askingCould && asking.from <= bornMs ? [asking, ...others] : others;

  if (strict.length) {
    // The oldest takes it, matching the order the store offers records in. A tie goes to whoever asked,
    // which is what happened before this module existed — refusing both would be permanent.
    const oldest = strict.reduce((a, b) => (b.from < a.from ? b : a));
    return strict.some(c => c.sessionId === askingId && c.from === oldest.from) ? 'claim' : 'defer';
  }

  // Nobody predates it. The asking session's own grace is the only claim left — the ordinary case of a
  // record the store wrote a moment before our clock says we spawned.
  if (askingCould) return 'claim';

  // Nothing could have written it: every window is missing. Answering 'defer' here would strand a
  // session the correlation used to pair for reasons that have nothing to do with this issue, so the
  // caller keeps what it had.
  return 'unknown';
}

module.exports = { recordWindowStart, claimVerdict };
