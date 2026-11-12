// --- CLI groups, mode choices and shared launch defaults (#761) ---
//
// The ONE answer to "which backends are the same CLI driven in different ways" (Claude and the GUI that
// drives it over a pipe, Pi and its GUI), "what does the mode select offer", "which launch fields are
// stored once under the owner", "what does a launch read" and "where does the default launch target go
// when the mode changes". It is meant to be read by the launch-option readers in main and the renderer, the
// Backends panel, the welcome tour and the default-target fallback, so none of them derives a group of its
// own (#761 wires them step by step; this file names no caller). `cliOwnerOf` in `src/backends/index.js` answers the same owner for every
// descriptor; `test/backend-modes.test.js` compares the two.
//
// Everything is derived from descriptors handed in as arguments: an owner is a backend with no
// `transcriptsOf`, a driver names its owner in `transcriptsOf` and declares its mode word in `modeLabel`.
// No backend id is named here. A third mode is one more driver descriptor, nothing in this file.
//
// Pure data work: no fs, no DOM, no settings access. Written for both processes: require()d in
// node (`module.exports`), and in a classic <script> it adds ONE global, `backendModes`, carrying the
// exported functions. The helpers stay inside the function so they do not join the renderer's shared scope.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.backendModes = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const OWNER_MODE_LABEL = 'Terminal';
  // Joins the ids of one choice into its value. Opaque to callers: they hand it back, never take it apart.
  const TOKEN_SEP = '|';

  function byIdOf(backendsById) {
    if (backendsById && typeof backendsById.get === 'function') return id => backendsById.get(id) || null;
    return id => (backendsById && Object.prototype.hasOwnProperty.call(backendsById, id) ? backendsById[id] : null);
  }

  function isSet(v) {
    return v !== undefined && v !== null;
  }

  function fieldsOf(b) {
    return b && Array.isArray(b.configFields) ? b.configFields : [];
  }

  function modeOf(b) {
    const label = b.transcriptsOf ? (b.modeLabel || b.label || b.id) : OWNER_MODE_LABEL;
    return { id: b.id, label, kind: b.transcriptsOf ? 'driver' : 'terminal' };
  }

  /**
   * The CLI groups of a backend list: ready, non-template backends only. An owner (no `transcriptsOf`) heads a
   * group, the drivers that name it follow in list order; a driver whose owner is absent or not ready stands
   * alone, as does everything with no twin.
   *
   * @param {Array<object>} backends descriptors, as `backends.list()` returns them
   * @returns {Array<{ owner: object, drivers: object[], modes: {id:string,label:string,kind:string}[], ids: string[] }>}
   */
  function cliGroups(backends) {
    const ready = (Array.isArray(backends) ? backends : []).filter(b => b && b.status === 'ready' && !b.isProfile);
    const ownerIds = new Set(ready.filter(b => !b.transcriptsOf).map(b => b.id));
    const groups = [];
    const byOwner = new Map();
    for (const b of ready) {
      if (b.transcriptsOf && ownerIds.has(b.transcriptsOf)) continue;
      const g = { owner: b, drivers: [], modes: [modeOf(b)], ids: [b.id] };
      groups.push(g);
      byOwner.set(b.id, g);
    }
    for (const b of ready) {
      const g = b.transcriptsOf && byOwner.get(b.transcriptsOf);
      if (!g) continue;
      g.drivers.push(b);
      g.modes.push(modeOf(b));
      g.ids.push(b.id);
    }
    return groups;
  }

  function singleChoice(mode) {
    return { value: mode.id, label: mode.label, ids: [mode.id] };
  }

  /**
   * The select's entries: each single mode, then one entry for all of them ("Both" for two modes, "All" from
   * three). A group with a single mode has no select, so no entries.
   *
   * @returns {{ value: string, label: string, ids: string[] }[]}
   */
  function modeChoices(group) {
    const modes = group && group.modes ? group.modes : [];
    if (modes.length < 2) return [];
    const all = { value: modes.map(m => m.id).join(TOKEN_SEP), label: modes.length === 2 ? 'Both' : 'All', ids: modes.map(m => m.id) };
    return [...modes.map(singleChoice), all];
  }

  /**
   * The entry that matches the enabled set; a synthetic read-only one (`readOnly: true`, label such as
   * "Terminal + GUI") for a subset the select cannot represent; `null` for none enabled.
   */
  function choiceFor(group, enabledMap) {
    const modes = group && group.modes ? group.modes : [];
    const on = modes.filter(m => enabledMap && enabledMap[m.id] === true);
    if (!on.length) return null;
    if (modes.length < 2) return singleChoice(modes[0]);
    const found = modeChoices(group).find(c => c.ids.length === on.length && c.ids.every(id => on.some(m => m.id === id)));
    if (found) return found;
    return { value: on.map(m => m.id).join(TOKEN_SEP), label: on.map(m => m.label).join(' + '), ids: on.map(m => m.id), readOnly: true };
  }

  /**
   * The `backendEnabled` values a choice stands for, one boolean per id of the group. An unknown value, and
   * the empty one, switch every id off.
   *
   * @returns {Object<string, boolean>}
   */
  function enabledForChoice(group, value) {
    const ids = group && group.ids ? group.ids : [];
    const choice = modeChoices(group).find(c => c.value === value) || (value && ids.length === 1 && ids[0] === value ? singleChoice(group.modes[0]) : null);
    const out = {};
    for (const id of ids) out[id] = !!choice && choice.ids.includes(id);
    return out;
  }

  function choiceValues(f) {
    if (!Array.isArray(f.choices)) return null;
    return f.choices.map(c => (c && typeof c === 'object' ? c.value : c)).map(String).sort();
  }

  function sameField(a, b) {
    if (a.type !== b.type) return false;
    if (JSON.stringify(a.default === undefined ? null : a.default) !== JSON.stringify(b.default === undefined ? null : b.default)) return false;
    if (a.choicesFrom !== b.choicesFrom) return false;
    return JSON.stringify(choiceValues(a)) === JSON.stringify(choiceValues(b));
  }

  /**
   * The field ids two descriptors can store once (D10): the same id, the same `type`, the same `default` and,
   * for a select, the same set of choices. Label and description may differ. Computed, never listed.
   *
   * @returns {string[]} in the owner's declaration order
   */
  function sharedFieldIds(owner, driver) {
    const theirs = new Map(fieldsOf(driver).map(f => [f.id, f]));
    return fieldsOf(owner).filter(f => theirs.has(f.id) && sameField(f, theirs.get(f.id))).map(f => f.id);
  }

  /**
   * The field ids stored once under the owner for a whole group: shared between the owner and EVERY driver
   * (D10 applied across the group). The one answer the page (`fieldSplit`), a launch (`launchLayer`) and the
   * migration read, so they cannot disagree. A group with no driver shares nothing.
   *
   * @returns {Set<string>}
   */
  function sharedIdsOfGroup(group) {
    let ids = null;
    for (const d of (group && group.drivers) || []) {
      const pair = new Set(sharedFieldIds(group.owner, d));
      ids = ids ? new Set([...ids].filter(id => pair.has(id))) : pair;
    }
    return ids || new Set();
  }

  /**
   * What the CLI's page shows once and what it shows per mode. Shared fields (`sharedIdsOfGroup`) carry the
   * owner's declaration plus a note for each driver whose description differs (`{ id, label, description }`,
   * data from the descriptor). `own` holds, per id, the fields that id's section shows: its declared fields
   * that are not shared, in declaration order.
   *
   * @returns {{ shared: { field: object, notes: object[] }[], own: Object<string, object[]> }}
   */
  function fieldSplit(group) {
    const owner = group.owner;
    const drivers = group.drivers || [];
    const sharedIds = sharedIdsOfGroup(group);
    const shared = fieldsOf(owner).filter(f => sharedIds.has(f.id)).map(field => {
      const notes = [];
      for (const d of drivers) {
        const theirs = fieldsOf(d).find(f => f.id === field.id);
        if (theirs && (theirs.description || '') !== (field.description || '')) {
          const mode = group.modes.find(m => m.id === d.id);
          notes.push({ id: d.id, label: mode ? mode.label : d.id, description: theirs.description || '' });
        }
      }
      return { field, notes };
    });
    const own = {};
    for (const b of [owner, ...drivers]) own[b.id] = fieldsOf(b).filter(f => !sharedIds.has(f.id));
    return { shared, own };
  }

  /**
   * The options one scope contributes to a launch of `backend` (D17): its own entry, with the owner's value
   * laid over it for every field the whole group shares (`sharedIdsOfGroup`). A template resolves through its `baseId`. `undefined` and
   * `null` mean "not set" (an owner without a value lets the driver's own stand); `''` and `false` are values.
   *
   * @param {Object<string, object>} defaultsById `backendDefaults` of one scope
   * @param {object} backend the descriptor launching
   * @param {Object<string, object>|Map<string, object>} backendsById the FULL registry list by id, NOT filtered
   *   by enabled: the group is built from it, and a driver loses the shared values stored under its owner when
   *   the owner is switched off and left out
   * @returns {object} a new object, free of unset values
   */
  function launchLayer(defaultsById, backend, backendsById) {
    const get = byIdOf(backendsById);
    const defaults = defaultsById || {};
    let eff = backend || null;
    if (eff && eff.baseId) eff = get(eff.baseId) || eff;
    if (!eff) return {};
    const clean = o => {
      const out = {};
      if (o && typeof o === 'object') for (const k of Object.keys(o)) if (isSet(o[k])) out[k] = o[k];
      return out;
    };
    const result = clean(defaults[eff.id]);
    if (eff.transcriptsOf) {
      const all = backendsById instanceof Map ? [...backendsById.values()] : Object.values(backendsById || {});
      const group = cliGroups(all).find(g => g.drivers.some(d => d.id === eff.id));
      if (group) {
        const ownerEntry = clean(defaults[group.owner.id]);
        for (const id of sharedIdsOfGroup(group)) if (id in ownerEntry) result[id] = ownerEntry[id];
      }
    }
    return result;
  }

  /**
   * Where the default launch target goes after the mode changed (D6, D18): a target of the group that is no
   * longer enabled moves to the first enabled mode of the group; otherwise it stays.
   *
   * @param {string} target
   * @param {object} group
   * @param {Object<string, boolean>} enabledAfter
   * @returns {string}
   */
  function targetAfterModeChange(target, group, enabledAfter) {
    if (!group || !group.ids || !group.ids.includes(target)) return target;
    if (enabledAfter && enabledAfter[target] === true) return target;
    const twin = group.modes.find(m => enabledAfter && enabledAfter[m.id] === true);
    return twin ? twin.id : target;
  }

  return {
    cliGroups, modeChoices, choiceFor, enabledForChoice, sharedFieldIds, sharedIdsOfGroup, fieldSplit, launchLayer, targetAfterModeChange,
  };
});
