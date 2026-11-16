// lib/model-choices.js — the model list and the levels per model in a launch form (#878).
//
// Two forms show a backend's launch options: the backend settings (`panels/backends-panel.js`) and the
// Configure and Resume dialogs (`dialogs/dialogs.js`). Both used to carry their own copy of the model datalist
// loader; this is the one copy, and it adds the second half: a select that declares `choicesPerModel: '<field>'`
// offers only the levels the chosen model takes.
//
// What a form writes, and nothing else:
//   - the model input:  `data-model-discovery="<backendId>" data-model-field="<field id>"` and a `list` attribute
//     naming its datalist (as before);
//   - the narrowed select: `data-choices-per-model="<field id>" data-model-backend="<backendId>"`.
// `bind(root)` wires both by delegation, once per root. The list comes from main (`window.api.backends.listModels`),
// whose rows may carry `effortLevels`: the levels that model takes, `[]` for none. A model without that field, a
// model typed by hand and an empty field narrow nothing — the backend's whole list is offered, as before.
// The empty choice ("the CLI decides") is always offered, and a stored level the model does not list stays
// selected and says so rather than vanishing: the form shows what a launch sends.
//
// Names no backend and reads no format (reflex 5): it reads the rows main sends and the attributes the forms write.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.modelChoices = api;
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  // One request per backend while it is out, and its answer for a while after: the datalist and the select of
  // one form ask together, and a probe behind it can take seconds (Claude's starts the CLI).
  const CACHE_MS = 5 * 60 * 1000;
  const lists = new Map(); // backendId -> { at, models } | { pending: Promise }

  const NOT_OFFERED = ' (not offered by this model)';

  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /** The rows as `{ id, label, effortLevels }`; a bare string is a row with no levels. */
  function normalise(models) {
    return (Array.isArray(models) ? models : []).map((m) => {
      if (typeof m === 'string') return { id: m, label: '' };
      const id = m && (m.id || m.value) ? String(m.id || m.value) : '';
      return { id, label: m && m.label ? String(m.label) : '', effortLevels: Array.isArray(m && m.effortLevels) ? m.effortLevels.map(String) : undefined };
    }).filter((m) => m.id);
  }

  function cached(backendId) {
    const hit = lists.get(backendId);
    return hit && hit.models && Date.now() - hit.at < CACHE_MS ? hit.models : null;
  }

  /** The backend's rows, or null when it has none to give. A failure is not remembered. */
  function load(backendId) {
    const ready = cached(backendId);
    if (ready) return Promise.resolve(ready);
    const hit = lists.get(backendId);
    if (hit && hit.pending) return hit.pending;
    const api = typeof window !== 'undefined' && window.api && window.api.backends;
    if (!backendId || !api || typeof api.listModels !== 'function') return Promise.resolve(null);
    const pending = Promise.resolve()
      .then(() => api.listModels(backendId, ''))
      .then((result) => {
        if (!result || result.ok === false || !Array.isArray(result.models)) { lists.delete(backendId); return null; }
        const models = normalise(result.models);
        lists.set(backendId, { at: Date.now(), models });
        return models;
      })
      .catch(() => { lists.delete(backendId); return null; });
    lists.set(backendId, { pending });
    return pending;
  }

  /** The levels a model takes, or null when the list says nothing about it (narrow nothing). */
  function levelsFor(models, modelValue) {
    const value = String(modelValue == null ? '' : modelValue).trim();
    if (!value || !Array.isArray(models)) return null;
    const row = models.find((m) => m.id === value);
    return row && Array.isArray(row.effortLevels) ? row.effortLevels : null;
  }

  /** Show only the levels in `levels` (all of them for null); the empty choice and the selected one always stay. */
  function narrowSelect(select, levels) {
    for (const option of Array.from(select.options)) {
      if (option.dataset.label == null) option.dataset.label = option.textContent;
      const offered = option.value === '' || levels == null || levels.includes(option.value);
      const keep = offered || option.selected;
      option.hidden = !keep;
      option.textContent = offered ? option.dataset.label : option.dataset.label + NOT_OFFERED;
    }
  }

  function fillDatalist(input, models) {
    const list = input.list || (input.getAttribute('list') && input.ownerDocument
      ? input.ownerDocument.getElementById(input.getAttribute('list')) : null);
    if (!list || list.dataset.loaded === '1') return;
    list.dataset.loaded = '1';
    list.innerHTML = models.map((m) =>
      `<option value="${escapeAttr(m.id)}"${m.label && m.label !== m.id ? ` label="${escapeAttr(m.label)}"` : ''}></option>`).join('');
  }

  function modelInputFor(root, select) {
    const backendId = select.dataset.modelBackend;
    const field = select.dataset.choicesPerModel;
    if (!backendId || !field) return null;
    return root.querySelector(`input[data-model-discovery="${CSS.escape(backendId)}"][data-model-field="${CSS.escape(field)}"]`);
  }

  function selectsFor(root, input) {
    const backendId = input.dataset.modelDiscovery;
    const field = input.dataset.modelField;
    if (!backendId || !field) return [];
    return Array.from(root.querySelectorAll(
      `select[data-model-backend="${CSS.escape(backendId)}"][data-choices-per-model="${CSS.escape(field)}"]`));
  }

  function narrowFrom(root, input, models) {
    for (const select of selectsFor(root, input)) narrowSelect(select, levelsFor(models, input.value));
  }

  /** Narrow every linked select whose backend's list is already here. No request. */
  function refresh(root) {
    root.querySelectorAll('select[data-choices-per-model]').forEach((select) => {
      const models = cached(select.dataset.modelBackend);
      const input = modelInputFor(root, select);
      if (models && input) narrowSelect(select, levelsFor(models, input.value));
    });
  }

  /** Wire a form root once: the datalist on focus, the narrowing on focus and on every change of the model. */
  function bind(root) {
    if (!root || root.dataset.modelChoicesBound === '1') return;
    root.dataset.modelChoicesBound = '1';
    root.addEventListener('focusin', (e) => {
      const t = e.target;
      if (!t || !t.matches) return;
      if (t.matches('input[data-model-discovery]')) {
        load(t.dataset.modelDiscovery).then((models) => {
          if (!models) return;
          fillDatalist(t, models);
          narrowFrom(root, t, models);
        });
      } else if (t.matches('select[data-choices-per-model]')) {
        load(t.dataset.modelBackend).then((models) => {
          const input = modelInputFor(root, t);
          if (models && input) narrowSelect(t, levelsFor(models, input.value));
        });
      }
    });
    const onModel = (e) => {
      const t = e.target;
      if (!t || !t.matches || !t.matches('input[data-model-discovery]')) return;
      const models = cached(t.dataset.modelDiscovery);
      if (models) narrowFrom(root, t, models);
    };
    root.addEventListener('input', onModel);
    root.addEventListener('change', onModel);
    refresh(root);
  }

  /** The attributes a form puts on a select that declares `choicesPerModel`, or '' for any other field. */
  function selectAttrs(field, backendId) {
    return field && field.choicesPerModel
      ? ` data-choices-per-model="${escapeAttr(field.choicesPerModel)}" data-model-backend="${escapeAttr(backendId)}"`
      : '';
  }

  /** The attributes a form puts on a model input: the backend to ask, and the field id a select links to. */
  function inputAttrs(field, backendId, listId) {
    return field && field.modelDiscovery
      ? ` list="${escapeAttr(listId)}" data-model-discovery="${escapeAttr(backendId)}" data-model-field="${escapeAttr(field.id)}"`
      : '';
  }

  function _reset() { lists.clear(); }

  return { bind, refresh, load, levelsFor, narrowSelect, normalise, selectAttrs, inputAttrs, NOT_OFFERED, _reset };
}));
