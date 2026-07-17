// --- Settings: the project tag chip editor (#218, #98, #134) ---
//
// Project-panel only. Type a tag and press Enter (or comma) and it becomes a chip; × removes it;
// Backspace on an empty input eats the last one; clicking a chip opens the colour picker. The suggestion
// list is an in-app combobox rather than a native <datalist>: the native one ignored the app's styling,
// and picking an entry only filled the input, leaving the user to guess that Enter was still needed to
// turn it into a chip (#134).
//
// NOTHING HERE IS SAVED BY THIS FILE, and that is the thing to know before changing it: the chips ARE the
// state. `persistSettings` reads them straight back out of the DOM — it re-queries `#sv-project-tags-chips`
// itself and collects `.settings-tag-chip` (settings-panel.js, "Everything Save writes"). So a chip that
// is in the box is a tag that will be saved, and the colour lives on the chip's `data-color`. Change the
// markup these produce and you change what Save writes, with nothing in between to catch it.
//
// It came out of `openSettingsViewer` in settings-panel.js — see settings-tags.js's header for why a cut
// out of that function hands a module what it used to close over. This is the fourth.
//
// ctx: { body, allProjectTags, tagColor(tag) -> hex, renderTagChip(tag, color) -> html,
//        buildColorPopover(anchor, initialColor, onPick) -> Element, signal: AbortSignal }
//
// `create(ctx)` is a FACTORY and here that is a necessity, not symmetry (unlike settings-maintenance.js):
// the palette's dismiss-on-outside-click listener at the bottom hangs off `signal`, and openSettingsViewer
// aborts its controller and makes a new one on EVERY open. A listener bound to a stale signal never fires,
// so the picker would never dismiss.
//
// `buildColorPopover` comes from panels/settings-tags.js — this ctx member is the seam between two modules
// that were both cut out of the same function. The picker is shared on purpose: the chips here and the tag
// definition lists there must offer the same colours, and two copies would drift.
//
// `escapeHtml` is NOT in the ctx: lib/utils.js declares it at the top level of a classic script, so it
// resolves at call time from the shared global lexical scope, like every other renderer file's use of it.

(function () {
  'use strict';

  function create(ctx) {
    const settingsViewerBody = ctx.body;
    const allProjectTags = ctx.allProjectTags;
    const tagColor = ctx.tagColor;
    const renderTagChip = ctx.renderTagChip;
    const buildColorPopover = ctx.buildColorPopover;
    const listenerSignal = ctx.signal;

    function initProjectTagsEditor() {
      const tagsInput = settingsViewerBody.querySelector('#sv-project-tags-input');
      const chipsBox = settingsViewerBody.querySelector('#sv-project-tags-chips');
      const suggestBox = settingsViewerBody.querySelector('#sv-project-tags-suggest');
      const currentTags = () => Array.from(chipsBox.querySelectorAll('.settings-tag-chip')).map(c => c.dataset.tag);
      const addTag = (raw, color) => {
        const tag = String(raw || '').trim();
        if (!tag || currentTags().includes(tag)) return;
        chipsBox.insertAdjacentHTML('beforeend', renderTagChip(tag, color));
      };

      if (tagsInput && suggestBox) {
        let matches = [];       // [{ tag, color }] currently listed
        let activeIndex = -1;   // highlighted row, -1 = none
        let createRow = false;  // is the trailing "create" row shown?

        const closeSuggest = () => {
          suggestBox.hidden = true;
          suggestBox.innerHTML = '';
          tagsInput.setAttribute('aria-expanded', 'false');
          matches = [];
          activeIndex = -1;
          createRow = false;
        };

        // Total rows = matches + the optional create row, so the highlight can walk
        // onto "create" as the last entry.
        const rowCount = () => matches.length + (createRow ? 1 : 0);

        const paintActive = () => {
          const rows = suggestBox.querySelectorAll('.settings-tag-suggest-row');
          rows.forEach((row, i) => {
            const on = i === activeIndex;
            row.classList.toggle('active', on);
            row.setAttribute('aria-selected', on ? 'true' : 'false');
          });
          if (activeIndex >= 0 && rows[activeIndex]) rows[activeIndex].scrollIntoView({ block: 'nearest' });
        };

        const openSuggest = () => {
          const query = tagsInput.value.trim().toLowerCase();
          const taken = new Set(currentTags());
          matches = allProjectTags
            .filter(t => !taken.has(t.tag))
            .filter(t => !query || t.tag.toLowerCase().includes(query))
            .slice(0, 8);
          // Offer creation only for a genuinely new tag.
          const typed = tagsInput.value.trim();
          createRow = !!typed && !taken.has(typed) && !allProjectTags.some(t => t.tag === typed);

          if (rowCount() === 0) { closeSuggest(); return; }

          const rows = matches.map((t, i) => {
            const c = t.color || tagColor(t.tag);
            return `<div class="settings-tag-suggest-row" role="option" aria-selected="false" data-index="${i}" data-tag="${escapeHtml(t.tag)}" data-color="${escapeHtml(c)}"><span class="settings-tag-suggest-dot" style="background:${c}"></span><span>${escapeHtml(t.tag)}</span></div>`;
          });
          if (createRow) {
            rows.push(`<div class="settings-tag-suggest-row settings-tag-suggest-create" role="option" aria-selected="false" data-index="${matches.length}" data-create="1"><span class="settings-tag-suggest-plus">+</span><span>Create “${escapeHtml(typed)}”</span></div>`);
          }
          suggestBox.innerHTML = rows.join('');
          suggestBox.hidden = false;
          tagsInput.setAttribute('aria-expanded', 'true');
          // Preselect the first row so Enter always has an obvious target.
          activeIndex = 0;
          paintActive();
        };

        const commitRow = (index) => {
          if (index < 0 || index >= rowCount()) return false;
          if (createRow && index === matches.length) addTag(tagsInput.value);
          else addTag(matches[index].tag, matches[index].color);
          tagsInput.value = '';
          closeSuggest();
          return true;
        };

        tagsInput.addEventListener('input', openSuggest);
        tagsInput.addEventListener('focus', openSuggest);

        tagsInput.addEventListener('keydown', (e) => {
          const open = !suggestBox.hidden;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            if (!open) { openSuggest(); return; }
            e.preventDefault();
            const step = e.key === 'ArrowDown' ? 1 : -1;
            activeIndex = (activeIndex + step + rowCount()) % rowCount();
            paintActive();
          } else if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            // A highlighted row wins; otherwise take whatever was typed.
            if (!(open && commitRow(activeIndex))) {
              addTag(tagsInput.value);
              tagsInput.value = '';
              closeSuggest();
            }
          } else if (e.key === 'Escape' && open) {
            e.preventDefault();
            e.stopPropagation(); // don't let the settings viewer close too
            closeSuggest();
          } else if (e.key === 'Backspace' && tagsInput.value === '') {
            const chips = chipsBox.querySelectorAll('.settings-tag-chip');
            if (chips.length) chips[chips.length - 1].remove();
            closeSuggest();
          }
        });

        // mousedown, not click: the input's blur would tear the list down first.
        suggestBox.addEventListener('mousedown', (e) => {
          const row = e.target.closest('.settings-tag-suggest-row');
          if (!row) return;
          e.preventDefault(); // keep focus in the input for the next tag
          commitRow(Number(row.dataset.index));
        });

        tagsInput.addEventListener('blur', () => {
          addTag(tagsInput.value);
          tagsInput.value = '';
          closeSuggest();
        });
      }

      if (!chipsBox) return;
      let paletteEl = null;
      const closePalette = () => { if (paletteEl) { paletteEl.remove(); paletteEl = null; } };
      chipsBox.addEventListener('click', (e) => {
        // The palette lives inside the chip, so a click on the picker would
        // otherwise be read as "chip clicked again" and close it (#134).
        if (e.target.closest('.settings-tag-palette')) return;
        const rm = e.target.closest('.settings-tag-remove');
        if (rm) { rm.closest('.settings-tag-chip').remove(); closePalette(); return; }
        const chip = e.target.closest('.settings-tag-chip');
        if (!chip) return;
        // Toggle a small palette popover to recolor this chip (#98).
        const reopenSame = paletteEl && paletteEl._chip === chip;
        closePalette();
        if (reopenSame) return;
        const applyColor = (col) => {
          chip.dataset.color = col;
          chip.style.background = col + '1a';
          chip.style.borderColor = col;
          chip.style.color = col;
        };
        // Shared HSV picker (#134/#138). Live-applies to the chip; the value is
        // persisted when the settings pane is saved.
        paletteEl = buildColorPopover(chip, chip.dataset.color, applyColor);
        paletteEl._chip = chip;
        paletteEl.addEventListener('click', (ev) => {
          if (ev.target.closest('.settings-tag-swatch')) closePalette();
        });
      });
      // Dismiss the palette on an outside click.
      document.addEventListener('click', (e) => {
        if (paletteEl && !e.target.closest('.settings-tag-chip')) closePalette();
      }, { signal: listenerSignal });
    }

    return { initProjectTagsEditor };
  }

  window.settingsProjectTags = { create };
})();
