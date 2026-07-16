// --- Session tags: pure picker logic (#99) ---
// The list the tag picker shows and the toggle it performs, free of DOM/browser
// APIs so the renderer (bookmarks-tags.js) and node tests share one implementation.
//
// Loaded as a classic <script> in the renderer (exposes globals) AND require()-d
// by node tests (module.exports). Keep this file free of DOM references.

// The name of an entry, whether it comes as a plain string or as a { tag } row
// (sessionTagsGet returns rows, the picker's own selection is names).
function sessionTagName(entry) {
  if (typeof entry === 'string') return entry;
  return (entry && entry.tag) || '';
}

// The rows the picker offers: the session-tag CATALOGUE (tag_defs), minus the
// disabled ones — a disabled tag renders no chip anywhere (#138), so offering it
// would assign something the user can never see. Each row carries whether this
// session already has it. `hidden` tags stay: they still render chips, they only
// drop out of a filter bar.
function sessionTagOptions(defs, assigned) {
  const on = new Set((Array.isArray(assigned) ? assigned : []).map(sessionTagName).filter(Boolean));
  return (Array.isArray(defs) ? defs : [])
    .filter((d) => d && d.name && !d.disabled)
    .map((d) => ({ name: d.name, color: d.color || null, assigned: on.has(d.name) }));
}

// Toggle one tag in a selection, returning the full new list of names. Every
// toggle writes the WHOLE set back (session-tags-set replaces it), so a tag the
// picker does not show — a disabled one still assigned to this session — must
// survive here rather than being dropped on the next click.
function toggleSessionTag(assigned, tag) {
  const names = (Array.isArray(assigned) ? assigned : []).map(sessionTagName).filter(Boolean);
  const name = String(tag || '').trim();
  if (!name) return names;
  const i = names.indexOf(name);
  if (i === -1) names.push(name);
  else names.splice(i, 1);
  return names;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    sessionTagName,
    sessionTagOptions,
    toggleSessionTag,
  };
}
