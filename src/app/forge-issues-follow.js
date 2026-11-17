// app/forge-issues-follow.js — keeps an OPEN, VISIBLE issues list fresh (#882, spec 42 "Choices worth keeping").
//
// Only a window that follows triggers a read. A session sidebar follows while its Tasks & notes group is open and
// shown, and says how closely it is watched: `focused` (the window has focus and this session's sidebar is shown) or
// `visible` (shown, but the window is unfocused or another session is active). A closed group, a hidden sidebar, a
// background tab or a closed sidebar unfollows, so nothing runs for it. The owner fixed the cadence:
//   - 5 minutes for a `focused` follower, 15 for a `visible` one; the fastest live follower of a project and query wins;
//   - after a failed read the interval doubles, capped at 30 minutes, and a good read starts over;
//   - the user being away (presence) pauses the reads: the timer only looks again once a minute, it starts no CLI;
//   - ONE timer per project and query, however many sidebars follow it. It reads once and tells every follower with
//     `forge-issues-updated`; each window then asks the list as it always does and is answered from that one read.
//     A tick costs one list read (GitHub: one `gh`; GitLab: one `glab`, plus the user-name lookup only when the query
//     filters by "opened by me" and the name is not cached).
// Any real read of a followed list, the Reload button's included, restarts the clock (`noteRead`).
// The timer's read is NOT forced: an answer under 30 s old, or a read still in flight, serves it, so a tick and a window's
// own re-read never start two CLIs.
//
// Same shape as `session-changes.js` follow/unfollow: the subscription belongs to the window and ends on unfollow, on
// the window's `destroyed` and on a main-frame navigation. This module holds no process and no state of the list; the
// timers are unref'd and `stop()` ends them before the database closes.
'use strict';

const FOCUSED_MS = 5 * 60 * 1000;
const VISIBLE_MS = 15 * 60 * 1000;
const MAX_MS = 30 * 60 * 1000;
const AWAY_RECHECK_MS = 60 * 1000;
const CHANNEL = 'forge-issues-updated';
const TIER_MS = { focused: FOCUSED_MS, visible: VISIBLE_MS };

/**
 * `read(projectPath, query)` is the forced list read and answers its `{ ok }`; `normalizeQuery` is the list's own.
 * Clock, timers and the away and quitting questions arrive as arguments so a test can drive them.
 */
function createFollowers({
  read, normalizeQuery, isAway = () => false, quitting = () => false,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log,
}) {
  const groups = new Map();      // key -> { key, projectPath, query, followers: Map<followerKey, { sender, tier }>, lastRead, failures, timer, reading }
  const byFollower = new Map();  // followerKey -> group key
  const wiredSenders = new Set();

  const senderKeyOf = (sender) => (sender && sender.id != null ? sender.id : 'main');
  const followerKeyOf = (sender, id) => `${senderKeyOf(sender)}\0${id}`;
  const groupKeyOf = (projectPath, q) => JSON.stringify([projectPath, q.state, q.assignee, q.author]);

  function intervalOf(g) {
    let base = Infinity;
    for (const f of g.followers.values()) base = Math.min(base, TIER_MS[f.tier] || VISIBLE_MS);
    if (!Number.isFinite(base)) base = VISIBLE_MS;
    return Math.min(MAX_MS, base * 2 ** Math.min(g.failures, 6));
  }

  function arm(g, delay) {
    const timer = setTimer(() => fire(g), Math.max(0, delay));
    if (timer && typeof timer.unref === 'function') timer.unref();
    g.timer = timer;
  }

  function schedule(g) {
    if (g.timer) { clearTimer(g.timer); g.timer = null; }
    if (!g.followers.size || g.reading || quitting()) return;
    arm(g, g.lastRead + intervalOf(g) - now());
  }

  function notify(g) {
    if (quitting()) return;
    const done = new Set();
    for (const [fkey, f] of [...g.followers]) {
      const sk = senderKeyOf(f.sender);
      if (done.has(sk)) continue;
      if (!f.sender || (typeof f.sender.isDestroyed === 'function' && f.sender.isDestroyed())) { dropFollower(fkey); continue; }
      done.add(sk);
      try { f.sender.send(CHANNEL, { projectPath: g.projectPath, query: g.query }); } catch { dropFollower(fkey); }
    }
  }

  function fire(g) {
    g.timer = null;
    if (groups.get(g.key) !== g || quitting() || g.reading) return;
    // The user is away: no request. Look again soon; the window's own return (a follow call) also re-arms it.
    if (isAway()) { arm(g, AWAY_RECHECK_MS); return; }
    g.reading = true;
    g.noted = false;
    g.lastRead = now();
    Promise.resolve().then(() => read(g.projectPath, g.query)).then((answer) => {
      g.reading = false;
      if (answer && answer.ok) notify(g);
      // A read the list really made, failed or not, was counted by `noteRead`; one it did not (off, a throw before it) is counted once here.
      else if (!g.noted) g.failures++;
    }, (err) => {
      g.reading = false;
      if (!g.noted) g.failures++;
      if (log && log.debug) log.debug('[forge-issues-follow]', err && err.code ? err.code : 'read failed');
    }).then(() => { if (groups.get(g.key) === g) schedule(g); });
  }

  function dropFollower(fkey) {
    const gkey = byFollower.get(fkey);
    byFollower.delete(fkey);
    const g = gkey && groups.get(gkey);
    if (!g) return;
    g.followers.delete(fkey);
    if (g.followers.size) { schedule(g); return; }
    if (g.timer) clearTimer(g.timer);
    groups.delete(gkey);
  }

  function dropWindow(skey, { destroyed = false } = {}) {
    for (const fkey of [...byFollower.keys()]) if (fkey.startsWith(`${skey}\0`)) dropFollower(fkey);
    if (destroyed) wiredSenders.delete(skey);
  }

  /** A sidebar follows (or changes its tier, or its project and query). Answers `{ ok }`. */
  function follow(id, sender, projectPath, query, tier) {
    if (typeof id !== 'string' || !id || id.length > 300 || typeof projectPath !== 'string' || !projectPath || !sender || quitting()) return { ok: false };
    const q = normalizeQuery(query);
    const key = groupKeyOf(projectPath, q);
    const fkey = followerKeyOf(sender, id);
    const before = byFollower.get(fkey);
    if (before && before !== key) dropFollower(fkey);
    let g = groups.get(key);
    if (!g) {
      // The window asks right after its own read, so "now" is when the list was last read.
      g = { key, projectPath, query: q, followers: new Map(), lastRead: now(), failures: 0, timer: null, reading: false };
      groups.set(key, g);
    }
    g.followers.set(fkey, { sender, tier: tier === 'focused' ? 'focused' : 'visible' });
    byFollower.set(fkey, key);
    const skey = senderKeyOf(sender);
    if (!wiredSenders.has(skey) && typeof sender.once === 'function') {
      wiredSenders.add(skey);
      sender.once('destroyed', () => dropWindow(skey, { destroyed: true }));
      // A reload builds the sidebars anew, so what the old page followed is stale when the navigation starts.
      if (typeof sender.on === 'function') {
        sender.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) dropWindow(skey); });
      }
    }
    schedule(g);
    return { ok: true };
  }

  function unfollow(id, sender) {
    if (typeof id !== 'string' || !id) return;
    dropFollower(followerKeyOf(sender, id));
  }

  /** The list was really read (a timer, a Reload, a window's own ask past the cache): the clock starts over. */
  function noteRead(projectPath, query, ok) {
    const g = groups.get(groupKeyOf(projectPath, normalizeQuery(query)));
    if (!g) return;
    g.lastRead = now();
    g.noted = true;
    g.failures = ok ? 0 : g.failures + 1;
    if (!g.reading) schedule(g);
  }

  function stop() {
    for (const g of groups.values()) if (g.timer) clearTimer(g.timer);
    groups.clear();
    byFollower.clear();
  }

  return {
    follow, unfollow, noteRead, stop,
    _groups: () => [...groups.values()].map((g) => ({ projectPath: g.projectPath, query: g.query, followers: g.followers.size, failures: g.failures, intervalMs: intervalOf(g), timer: !!g.timer })),
  };
}

module.exports = { createFollowers, FOCUSED_MS, VISIBLE_MS, MAX_MS, AWAY_RECHECK_MS, CHANNEL };
