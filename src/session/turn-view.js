'use strict';
// #507 step T1: the turn view, a pure function of neutral messages.
//
// No I/O, no Electron, no db, no model call. A backend's `readTurnDigest` hook (T2+) turns its own transcript
// grammar into the neutral shape below; THIS module groups it into turns and applies every cap, so the bounds are
// identical across backends (plan D9). A summary is deterministic head-and-tail truncation, never a model (D10).
//
// Input message: `{ role: 'user' | 'assistant', text: string, at?: string|number, tools?: Array<string | { name }> }`.
// Any other role is ignored. `tools` lists the tool calls an assistant message made; they collapse to a
// name-to-count map and are never expanded (O5).
//
// Grouping: a user message opens a turn; the assistant messages after it, up to the next user message, belong to it.
// Assistant messages before any user message (the read window cut the prompt) form turn 0. User turns count from 1.
//
// Bounds, all clamped to the maxima below. Order: each text is cut per turn first, then the newest `turns` turns
// are kept, then the oldest turns are dropped until the serialized view fits the ceiling. The NEWEST turns win.

// Starting values (plan D13). PROVISIONAL: design values, checked against a real session at gate G2.
const DEFAULTS = Object.freeze({ turns: 8, maxCharsPerTurn: 1200, ceilingChars: 24000 });
const MAXIMA = Object.freeze({ turns: 30, maxCharsPerTurn: 4000, ceilingChars: 24000 });
const MIN_CEILING = 1000;

function clamp(value, def, max, min = 1) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// Head 2/3 and tail 1/3 of the cap, counted in code points so an emoji or surrogate pair is never split.
// The marker names how many code points were left out; it sits outside the cap.
function cutText(text, cap) {
  const cps = Array.from(typeof text === 'string' ? text : '');
  if (cps.length <= cap) return cps.join('');
  const head = Math.ceil((cap * 2) / 3);
  const tail = cap - head;
  const omitted = cps.length - cap;
  return `${cps.slice(0, head).join('')}\n[... ${omitted} characters omitted ...]\n${tail > 0 ? cps.slice(cps.length - tail).join('') : ''}`;
}

function addTools(map, tools) {
  if (!Array.isArray(tools)) return;
  for (const t of tools) {
    const name = typeof t === 'string' ? t : t && typeof t.name === 'string' ? t.name : '';
    if (name) map[name] = (map[name] || 0) + 1;
  }
}

function group(messages) {
  const groups = [];
  let cur = null;
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    if (m.role === 'user') {
      cur = { n: groups.filter((g) => g.n > 0).length + 1, at: m.at ?? null, user: [m.text], assistant: [], tools: {} };
      groups.push(cur);
      continue;
    }
    if (!cur) {
      cur = { n: 0, at: m.at ?? null, user: [], assistant: [], tools: {} };
      groups.push(cur);
    }
    cur.assistant.push(m.text);
    addTools(cur.tools, m.tools);
  }
  return groups;
}

function join(parts) {
  return parts.filter((p) => typeof p === 'string' && p).join('\n\n');
}

/**
 * @param {Array} messages neutral messages, oldest first
 * @param {{ turns?: number, roles?: 'both'|'user', maxCharsPerTurn?: number, ceilingChars?: number, partial?: boolean }} [opts]
 * @returns {{ turns: Array<{ n: number, at: string|number|null, user: string, assistant: string, tools: Object<string, number> }>,
 *             returned: number, omitted: number, partial: boolean }}
 *   `partial` is the reader's flag, passed through unchanged; `omitted` counts turns dropped by the turn cap or the ceiling.
 */
function buildTurnView(messages, opts = {}) {
  const o = opts || {};
  const maxTurns = clamp(o.turns, DEFAULTS.turns, MAXIMA.turns);
  const cap = clamp(o.maxCharsPerTurn, DEFAULTS.maxCharsPerTurn, MAXIMA.maxCharsPerTurn);
  const ceiling = clamp(o.ceilingChars, DEFAULTS.ceilingChars, MAXIMA.ceilingChars, MIN_CEILING);
  const userOnly = o.roles === 'user';
  const partial = o.partial === true;

  const all = group(messages).map((g) => ({
    n: g.n,
    at: g.at,
    user: cutText(join(g.user), cap),
    assistant: userOnly ? '' : cutText(join(g.assistant), cap),
    tools: g.tools,
  }));

  let kept = all.slice(Math.max(0, all.length - maxTurns));
  const build = () => ({ turns: kept, returned: kept.length, omitted: all.length - kept.length, partial });
  let view = build();
  while (kept.length > 0 && JSON.stringify(view).length > ceiling) {
    kept = kept.slice(1);
    view = build();
  }
  return view;
}

module.exports = { buildTurnView, DEFAULTS, MAXIMA };
