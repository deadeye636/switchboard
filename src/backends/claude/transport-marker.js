// backends/claude/transport-marker.js — how a Claude transcript says it was driven over the stream pipe (#658).
//
// Two Switchboard backends can run Claude: the terminal one in this folder and a runtime-driven one that
// speaks Claude Code's stream-json protocol over a pipe (#653). They share one binary and one session store,
// and a session id can belong to only one row — so the row stays THIS backend's (`backendId: 'claude'`) and
// says HOW it was driven in a field of its own, which the registry's `openerFor` turns into the backend that
// opens it. The same shape as Pi's (`../pi/transport-marker.js`), and for the same reason: the scan
// reconciles per backend, so a row stamped with the driver's id would outlive its transcript.
//
// Unlike Pi's, this marker is not a line anybody writes into the transcript. Claude Code writes an
// `entrypoint` field on every line, and takes its value from `CLAUDE_CODE_ENTRYPOINT` in its environment
// verbatim — measured on CLI 2.1.283: `sdk-switchboard` in the child's environment came out as
// `"entrypoint":"sdk-switchboard"` on every line, where a terminal session writes `cli` and a plain
// `claude -p` writes `sdk-cli`. So the driver sets the variable and the reader looks for the value; nothing
// of the app's own lands in Claude's store, and a user's own `claude -p` scripts are not mistaken for it.
//
// Any line carrying it marks the row, so the row says "was driven over the pipe at least once", as Pi's
// does (#653 E9). This file is the one place both sides spell it.
'use strict';

const TRANSPORT_ENTRYPOINT_ENV = 'CLAUDE_CODE_ENTRYPOINT';
const TRANSPORT_ENTRYPOINT = 'sdk-switchboard';
// What the row's `transport` says once the marker was seen — the value the driver declares as `transport`.
const TRANSPORT = 'rpc';

// The transport an entry names, or null when it is not one of ours.
function transportFromEntry(entry) {
  return entry && entry.entrypoint === TRANSPORT_ENTRYPOINT ? TRANSPORT : null;
}

module.exports = { TRANSPORT_ENTRYPOINT_ENV, TRANSPORT_ENTRYPOINT, TRANSPORT, transportFromEntry };
