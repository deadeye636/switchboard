// store-record-notice.js — "this backend has no record of this session" as a STATE, not an event (#460).
//
// #151 established the fact and the wording (`app/terminal/live-record-notice.js` decides both, and
// still does). What it got wrong was the shelf life: the sentence went out as a toast that faded after
// eight seconds, while the condition it explains lasts as long as the session does. Look away and the
// explanation is gone, leaving a tab that never says working or idle and no way to find out why — the
// state #151 set out to remove.
//
// So the fact is held here and published as a LIST, the way live-owners.js publishes its own:
//
//   - a window that opens or reloads asks for it (`store-record-notice:get`) rather than having to have
//     been listening at the right second,
//   - every window gets the broadcast, so a detached session carries the same explanation as the main
//     window's row,
//   - and it is dropped the moment it stops being true: the record turns up, or the session exits.
//
// It stays deliberately quiet. Nothing here reaches the badge, the tray or the chime, and the renderer
// draws it as a muted dot plus a line in the tab's tooltip. The user is not being waited on — this
// reports the ABSENCE of a state, and it must never start inventing one from PTY output (see the D21
// note in live-record-notice.js for why that is the trap).
'use strict';

let ctx = null;

// sessionId -> the sentence to show. The id is the LIVE one (`realSessionId` once a backend has named
// its own session), because that is the id the renderer draws a row for.
const unpaired = new Map();

function init(context) {
  ctx = context;
  unpaired.clear();
}

function snapshot() {
  return [...unpaired].map(([sessionId, message]) => ({ sessionId, message }));
}

function targetWindows() {
  if (!ctx) return [];
  const main = ctx.getMainWindow ? ctx.getMainWindow() : null;
  const wins = [];
  if (main && !main.isDestroyed()) wins.push(main);
  for (const w of (ctx.getDetachedWindows ? ctx.getDetachedWindows() : []) || []) {
    if (w && w !== main && !w.isDestroyed()) wins.push(w);
  }
  return wins;
}

// The whole list every time, not a delta: a window that missed one message would otherwise carry a
// marker for a session that paired minutes ago, and there is no tick here to correct it.
function broadcast() {
  const list = snapshot();
  for (const w of targetWindows()) {
    try { w.webContents.send('store-record-notice', list); } catch { /* a window on its way out */ }
  }
}

/** Say that this session has no record. A repeat of what is already published is not re-sent. */
function notice(sessionId, message) {
  if (!sessionId || !message) return;
  if (unpaired.get(sessionId) === message) return;
  unpaired.set(sessionId, message);
  broadcast();
}

/** It stopped being true — the record turned up, or the session is gone. */
function clear(sessionId) {
  if (!sessionId) return;
  if (!unpaired.delete(sessionId)) return;
  broadcast();
}

function registerIpc(ipc) {
  // What a window asks for when it opens or reloads. Reading the published list, never re-deciding:
  // the decision costs a walk of the backend's whole store (see `hasUnclaimedStoreSession`), and a
  // reload must not be able to trigger one.
  ipc.handle('store-record-notice:get', () => snapshot());
}

module.exports = {
  init,
  registerIpc,
  notice,
  clear,
  current: snapshot,
};
