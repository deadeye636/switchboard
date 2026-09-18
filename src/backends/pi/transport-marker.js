// backends/pi/transport-marker.js — how a Pi transcript says it was driven over Pi's RPC mode (#568).
//
// Two Switchboard backends run Pi: the terminal one in this folder and the runtime-driven one in
// `../pi-native/`. They share one binary and one session store, and a session id can belong to only one
// row — so the row stays THIS backend's (`backendId: 'pi'`) and says HOW it was driven in a field of
// its own. The registry's `openerFor` turns that field into the backend that opens the row. The marker is
// written once and never removed, so it says "was driven over RPC at least once" — the last word is the
// runtime-driven backend's for as long as it is switched on (spec 30).
//
// Why the row does not simply carry the other backend's id: the scan reconciles per backend, and its
// delete-diff is `cachedRowsOfBackend('pi')`. A row stamped with the sibling's id would drop out of that
// input, and a transcript deleted from disk would leave its row behind for good.
//
// The marker is a Pi `custom` entry — Pi's own mechanism for extension state that never reaches the model
// (`pi.appendEntry(customType, data)`). The runtime-driven backend's per-spawn extension writes it; this
// file is the one place both sides spell it, so the writer and the reader cannot drift apart. Measured on
// Pi 0.84.4: the entry is persisted with the first message, not at `session_start` — a session nobody wrote
// to has no transcript, so there is nothing for a marker to be missing from.
'use strict';

const TRANSPORT_MARKER_TYPE = 'switchboard-transport';

// The value a marker carries, or null when this entry is not one. A marker naming something that is not a
// plain token is ignored rather than stored: the value ends up in a column and is compared against
// descriptors, and a transcript is text anybody can edit.
function transportFromEntry(entry) {
  if (!entry || entry.type !== 'custom' || entry.customType !== TRANSPORT_MARKER_TYPE) return null;
  const value = entry.data && entry.data.transport;
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value) ? value : null;
}

module.exports = { TRANSPORT_MARKER_TYPE, transportFromEntry };
