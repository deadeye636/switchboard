// --- Settings: the tag management lists and the colour picker they share (#218, #138) ---
//
// Tags here are ENTITIES, not labels on something else: they exist with no assignment, and every action
// (create, rename, recolour, hide, delete) writes through to the store immediately rather than waiting
// for Save. That is why this file registers no field on the settings blob and the save path below never
// mentions it.
//
// It came out of `openSettingsViewer` in settings-panel.js — a ~2250-line function that this is the
// first cut of. And that is the whole reason this file looks different from the ones #218 produced for
// grid-view.js and sidebar.js: THERE the declarations sat in the shared global scope and could simply be
// moved, which is what let each of those splits be proved line-for-line identical. HERE every
// declaration closed over `openSettingsViewer`'s locals, so moving one means handing it what it used to
// close over. That is a design change, not motion, and it is the pattern #213 established for main.js:
// a module takes a `ctx`.
//
// THE CTX, and why it is a factory rather than an init:
//
//   `create(ctx)` runs once per OPEN, and returns the three functions bound to that open's context. It is
//   a factory because `listenerSignal` is a fresh AbortSignal every time the panel opens
//   (openSettingsViewer aborts the old controller and makes a new one), and the popover's click-away
//   listener has to hang off THIS open's signal — a stale one is already aborted, so the listener would
//   never fire and the picker would never dismiss.
//
//   Inside one open, everything ctx carries is a `const`, so it goes straight through by value. That is
//   the CLAUDE.md rule ("a const goes straight through; a let ONLY as a getter") and here the factory is
//   what makes it true: the values cannot change under the module because a new open builds a new one.
//
// ctx: { body: Element, tagColor(name) -> hex, tagPalette: string[], signal: AbortSignal }
//
// `body` is settings-panel.js's `settingsViewerBody` — an IIFE-level const, NOT a global. Leaving it out
// is how the first draft of this file broke: `initTagDefsSection` looked it up, found nothing, and the
// whole Tags section died with a ReferenceError the moment the panel opened. The suite stayed green
// through all 1488 of it, because no test opens this panel. Only clicking it found it.
//
// That is the difference between this pass and #218's earlier ones in one sentence: there, a moved
// identifier still resolved through the shared global scope, so the move could not break it. Here, every
// identifier the code used was a local of a function or of the IIFE, and NONE of them resolve after the
// move. The ctx is not ceremony — it is the entire mechanism.

(function () {
  'use strict';

  function create(ctx) {
    const settingsViewerBody = ctx.body;
    const tagColor = ctx.tagColor;
    const tagPalette = ctx.tagPalette;
    const listenerSignal = ctx.signal;

    // --- Tag management lists (#138) ---
    // One section per kind. Tags here are entities: they may exist with no
    // assignment, and every action writes through immediately.
    function initTagDefsSection(kind) {
      const section = settingsViewerBody.querySelector('#sv-tagdefs-' + kind);
      if (!section) return;
      const listEl = section.querySelector('.settings-tagdef-list');
      const newInput = section.querySelector('.settings-tagdef-new');
      const addBtn = section.querySelector('.settings-tagdef-add-btn');
      const noun = kind === 'project' ? 'project' : 'session';
      let palette = null;

      const closePalette = () => { if (palette) { palette.remove(); palette = null; } };

      const fail = (res) => {
        if (res && res.ok) return false;
        const msg = (res && res.error) || 'Unknown error';
        const err = section.querySelector('.settings-tagdef-error');
        if (err) { err.textContent = msg; err.hidden = false; }
        return true;
      };
      const clearError = () => {
        const err = section.querySelector('.settings-tagdef-error');
        if (err) err.hidden = true;
      };

      const usageLabel = (n) => (n === 0
        ? 'unused'
        : `${n} ${noun}${n === 1 ? '' : 's'}`);

      async function refresh() {
        const res = await window.api.tagDefsList(kind).catch(() => null);
        if (!res || !res.ok) { listEl.innerHTML = '<div class="settings-tagdef-empty">Could not load tags.</div>'; return; }
        if (res.tags.length === 0) {
          listEl.innerHTML = `<div class="settings-tagdef-empty">No ${noun} tags yet.</div>`;
          return;
        }
        listEl.innerHTML = res.tags.map(t => {
          const c = t.color || tagColor(t.name);
          const state = [t.hidden ? 'hidden' : '', t.disabled ? 'disabled' : ''].filter(Boolean).join(' ');
          return `
            <div class="settings-tagdef-row ${state}" data-name="${escapeHtml(t.name)}" data-color="${escapeHtml(c)}">
              <span class="settings-tagdef-color-wrap"><button type="button" class="settings-tagdef-color" style="background:${c}" title="Change color" aria-label="Change color of ${escapeHtml(t.name)}"></button></span>
              <span class="settings-tagdef-name">${escapeHtml(t.name)}</span>
              <span class="settings-tagdef-usage">${usageLabel(t.usageCount)}</span>
              <div class="settings-tagdef-actions">
                <button type="button" class="settings-tagdef-btn" data-act="rename">Rename</button>
                <button type="button" class="settings-tagdef-btn${t.hidden ? ' on' : ''}" data-act="hidden" aria-pressed="${!!t.hidden}">Hidden</button>
                <button type="button" class="settings-tagdef-btn${t.disabled ? ' on' : ''}" data-act="disabled" aria-pressed="${!!t.disabled}">Disabled</button>
                <button type="button" class="settings-tagdef-btn danger" data-act="delete">Delete</button>
              </div>
            </div>`;
        }).join('');
      }

      async function addTagDef() {
        const name = newInput.value.trim();
        if (!name) return;
        clearError();
        const res = await window.api.tagDefCreate(kind, name, null).catch(e => ({ ok: false, error: e.message }));
        if (fail(res)) return;
        newInput.value = '';
        await refresh();
        notifyTagsChanged();
      }

      // Rename in place: an input over the name, Enter commits, Escape cancels.
      function startRename(row, name) {
        const nameEl = row.querySelector('.settings-tagdef-name');
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'settings-input settings-tagdef-rename';
        input.value = name;
        nameEl.replaceWith(input);
        input.focus();
        input.select();

        let done = false;
        const commit = async () => {
          if (done) return;
          done = true;
          const next = input.value.trim();
          clearError();
          if (next && next !== name) {
            const res = await window.api.tagDefRename(kind, name, next).catch(e => ({ ok: false, error: e.message }));
            if (fail(res)) { await refresh(); return; }
            notifyTagsChanged();
          }
          await refresh();
        };
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') { e.preventDefault(); done = true; refresh(); }
        });
        input.addEventListener('blur', commit);
      }

      async function toggleFlag(name, act, row) {
        clearError();
        const flags = act === 'hidden'
          ? { hidden: !row.classList.contains('hidden') }
          : { disabled: !row.classList.contains('disabled') };
        const res = await window.api.tagDefFlags(kind, name, flags).catch(e => ({ ok: false, error: e.message }));
        if (fail(res)) return;
        await refresh();
        notifyTagsChanged();
      }

      async function removeTagDef(name, row) {
        const usage = row.querySelector('.settings-tagdef-usage')?.textContent || '';
        const confirmed = await showControlDialog({
          title: `Delete tag “${name}”?`,
          message: usage === 'unused'
            ? 'This tag is not assigned to anything.'
            : `It will also be removed from ${usage}. This cannot be undone.`,
          confirmLabel: 'Delete',
          cancelLabel: 'Cancel',
          tone: 'danger',
        });
        if (!confirmed) return;
        clearError();
        const res = await window.api.tagDefDelete(kind, name).catch(e => ({ ok: false, error: e.message }));
        if (fail(res)) return;
        await refresh();
        notifyTagsChanged();
      }

      // Colour: live preview on the swatch, persisted when the popover closes.
      // Anchored on the wrapper NEXT TO the swatch, never inside it: the swatch is
      // a <button>, and a popover appended into a button gets no interaction at all
      // — the button is the activation target, so its nested slider, hex input and
      // swatch buttons were dead on arrival (#174). The chips in the project dialog
      // anchor on a <span>, which is why the same picker works there.
      function openColor(row, name) {
        closePalette();
        const btn = row.querySelector('.settings-tagdef-color');
        const anchor = row.querySelector('.settings-tagdef-color-wrap') || btn;
        let picked = row.dataset.color;
        palette = buildColorPopover(anchor, picked, (hex) => {
          picked = hex;
          btn.style.background = hex;
        });
        palette._commit = async () => {
          if (picked === row.dataset.color) return;
          const res = await window.api.tagDefColor(kind, name, picked).catch(e => ({ ok: false, error: e.message }));
          if (fail(res)) return;
          await refresh();
          notifyTagsChanged();
        };
      }

      listEl.addEventListener('click', (e) => {
        if (e.target.closest('.settings-tag-palette')) return; // clicks inside the picker
        const row = e.target.closest('.settings-tagdef-row');
        if (!row) return;
        const name = row.dataset.name;

        if (e.target.closest('.settings-tagdef-color')) {
          const reopen = palette && palette.parentElement === row.querySelector('.settings-tagdef-color-wrap');
          if (reopen) { const p = palette; closePalette(); p._commit?.(); return; }
          openColor(row, name);
          return;
        }
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (!act) return;
        if (act === 'rename') startRename(row, name);
        else if (act === 'hidden' || act === 'disabled') toggleFlag(name, act, row);
        else if (act === 'delete') removeTagDef(name, row);
      });

      // Clicking away commits the colour — same gesture as the chip palette.
      document.addEventListener('click', (e) => {
        if (!palette) return;
        if (e.target.closest('.settings-tag-palette') || e.target.closest('.settings-tagdef-color')) return;
        const p = palette;
        closePalette();
        p._commit?.();
      }, { signal: listenerSignal });

      addBtn.addEventListener('click', addTagDef);
      newInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addTagDef(); }
      });

      refresh();
    }

    // The sidebar's filter chips and the project-tag map are built from the tag
    // store, so any change here has to reach them without a restart.
    function notifyTagsChanged() {
      if (typeof window._refreshProjectTagFilter === 'function') window._refreshProjectTagFilter();
      if (window.bookmarksTags && typeof window.bookmarksTags.reloadTags === 'function') {
        window.bookmarksTags.reloadTags();
      }
      if (typeof refreshSidebar === 'function') refreshSidebar();
      // In the standalone settings window none of the above exists — the chips it
      // recolours live in the main window. A tag edit there is committed on the
      // spot (no Save), so tell the other windows right away (#174).
      if (window.__SETTINGS_WINDOW__ && typeof window.api.notifySettingsChanged === 'function') {
        window.api.notifySettingsChanged();
      }
    }

    // In-app HSV colour picker (#134), shared by the project-tag chips and the tag
    // management lists (#138). The former <input type="color"> handed off to
    // Chromium's OS dialog, which the app cannot position — it opened in the
    // window's top-left corner, detached from what was being recoloured.
    //
    // Appends itself to `anchor` (which must be positioned) and calls onPick(hex)
    // on every change, live. Returns the element so the caller can remove it.
    function buildColorPopover(anchor, initialColor, onPick) {
      let hsv = hexToHsv(normalizeHex(initialColor) || '#61afef');

      const el = document.createElement('div');
      el.className = 'settings-tag-palette';
      el.innerHTML = `
        <div class="settings-tag-swatches">
          ${tagPalette.map(col =>
            `<button type="button" class="settings-tag-swatch" data-col="${col}" style="background:${col}" aria-label="Set color ${col}"></button>`
          ).join('')}
        </div>
        <div class="settings-tag-sv" tabindex="0" role="slider" aria-label="Saturation and brightness">
          <div class="settings-tag-sv-cursor"></div>
        </div>
        <input type="range" class="settings-tag-hue" min="0" max="359" step="1" aria-label="Hue">
        <div class="settings-tag-hex-row">
          <span class="settings-tag-preview"></span>
          <input type="text" class="settings-tag-hex" spellcheck="false" maxlength="7" aria-label="Hex color">
        </div>`;

      const svField = el.querySelector('.settings-tag-sv');
      const svCursor = el.querySelector('.settings-tag-sv-cursor');
      const hueSlider = el.querySelector('.settings-tag-hue');
      const hexInput = el.querySelector('.settings-tag-hex');
      const preview = el.querySelector('.settings-tag-preview');

      // `skipHexField` keeps the caret still while the user types into it.
      const paint = ({ skipHexField = false } = {}) => {
        const hex = hsvToHex(hsv);
        svField.style.setProperty('--hue-color', hsvToHex({ h: hsv.h, s: 1, v: 1 }));
        svCursor.style.left = (hsv.s * 100) + '%';
        svCursor.style.top = ((1 - hsv.v) * 100) + '%';
        svCursor.style.background = hex;
        hueSlider.value = String(Math.round(hsv.h));
        preview.style.background = hex;
        if (!skipHexField) hexInput.value = hex;
        onPick(hex);
      };

      const pickFromEvent = (ev) => {
        const r = svField.getBoundingClientRect();
        hsv.s = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
        hsv.v = 1 - Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
        paint();
      };

      svField.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        svField.setPointerCapture(ev.pointerId);
        pickFromEvent(ev);
      });
      svField.addEventListener('pointermove', (ev) => {
        if (svField.hasPointerCapture(ev.pointerId)) pickFromEvent(ev);
      });
      svField.addEventListener('keydown', (ev) => {
        const step = ev.shiftKey ? 0.1 : 0.02;
        if (ev.key === 'ArrowRight') hsv.s = Math.min(1, hsv.s + step);
        else if (ev.key === 'ArrowLeft') hsv.s = Math.max(0, hsv.s - step);
        else if (ev.key === 'ArrowUp') hsv.v = Math.min(1, hsv.v + step);
        else if (ev.key === 'ArrowDown') hsv.v = Math.max(0, hsv.v - step);
        else return;
        ev.preventDefault();
        paint();
      });

      hueSlider.addEventListener('input', () => { hsv.h = Number(hueSlider.value); paint(); });

      // Accept a typed hex only once it parses; leave partial input alone.
      hexInput.addEventListener('input', () => {
        const norm = normalizeHex(hexInput.value);
        if (!norm) return;
        hsv = hexToHsv(norm);
        paint({ skipHexField: true });
      });
      hexInput.addEventListener('blur', () => { hexInput.value = hsvToHex(hsv); });

      el.addEventListener('click', (ev) => {
        const sw = ev.target.closest('.settings-tag-swatch');
        if (!sw) return;
        hsv = hexToHsv(sw.dataset.col);
        paint();
        el._pickedSwatch = true; // caller may close on swatch pick
      });

      anchor.appendChild(el);
      paint();
      return el;
    }

    return { initTagDefsSection, notifyTagsChanged, buildColorPopover };
  }

  window.settingsTags = { create };
})();
