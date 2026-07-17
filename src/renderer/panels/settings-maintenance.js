// --- Settings: the Maintenance section — export, import, rebuild the session cache (#218, #145) ---
//
// Three buttons that talk to main and — on import alone — back to the panel's opener. They carry no field
// on the settings blob: export and import move the whole blob past the form, and the rebuild drops an
// index. That is why the save path in settings-panel.js never mentions this file.
//
// It came out of `openSettingsViewer` — the same ~2000-line function settings-tags.js is the first cut of,
// and it takes a ctx because every declaration in there closes over that function's locals, so moving one
// means handing it what it used to close over. Read settings-tags.js's header for the why; this file is
// the second confirmation of that pattern, not a new one.
//
// The FACTORY shape is symmetry with settings-tags.js, not necessity — this ctx is two constants that
// outlive an open, so an `init(ctx)` called once would do. settings-tags.js has to be a factory: its
// click-away listener hangs off THIS open's AbortSignal. Do not read a per-open requirement into this
// file that it does not have.
//
// ctx: { body: Element, reopen(scope, projectPath) -> Promise }
//
// `body` is settings-panel.js's `settingsViewerBody` — an IIFE-level const, NOT a global. Leaving it out
// is how the first draft of settings-tags.js died with a ReferenceError the moment the panel opened, with
// all 1488 tests green: no test loads this file, no test opens this panel.
//
// `reopen` is `openSettingsViewer` itself. It is passed rather than read off `window` because the import
// path needs THIS panel's opener, and because a module that reaches back through `window` for its caller
// hides the dependency from the one place anybody looks — this header.
//
// `showControlDialog` / `showControlMessage` are NOT in the ctx: dialogs/control-dialogs.js is a UMD file
// that assigns them onto `window`, so they resolve at call time from any script. Only what closed over
// `openSettingsViewer`'s locals had to be handed over.
//
// Maintenance is global-only, so `init` is a no-op on a project panel: the section is not in the markup
// and every lookup below misses.

(function () {
  'use strict';

  function create(ctx) {
    const settingsViewerBody = ctx.body;
    const reopen = ctx.reopen;

    // Export / import the global settings (#145). Both live in Maintenance, so they exist in the
    // global scope only — the file carries the global blob and nothing else.
    function initMaintenanceSection() {
      const exportBtn = settingsViewerBody.querySelector('#sv-export-settings');
      if (exportBtn) {
        exportBtn.addEventListener('click', async () => {
          const res = await window.api.exportSettings();
          if (!res || res.canceled) return;
          if (res.ok) {
            await showControlMessage({
              title: 'Settings exported',
              message: `${res.keys} setting${res.keys === 1 ? '' : 's'} written.`,
              details: { File: res.filePath },
              tone: 'success',
            });
          } else {
            await showControlMessage({
              title: 'Export failed',
              message: res.error || 'The settings could not be written.',
              tone: 'danger',
            });
          }
        });
      }

      const importBtn = settingsViewerBody.querySelector('#sv-import-settings');
      if (importBtn) {
        importBtn.addEventListener('click', async () => {
          const confirmed = await showControlDialog({
            title: 'Import settings?',
            message: 'Pick a settings file. Every setting it names overwrites yours; the rest are kept. This is applied at once and cannot be undone — export your current settings first if you want a way back.',
            confirmLabel: 'Choose file…',
            cancelLabel: 'Cancel',
            tone: 'warning',
          });
          if (!confirmed) return;
          const res = await window.api.importSettings();
          if (!res || res.canceled) return;
          if (!res.ok) {
            await showControlMessage({
              title: 'Import failed',
              message: res.error || 'The settings could not be imported.',
              tone: 'danger',
            });
            return;
          }
          // Main has persisted and re-armed, and told every window to re-apply. What is still
          // stale is THIS form — it was rendered from the old blob. Re-open it on the imported one.
          await showControlMessage({
            title: 'Settings imported',
            message: `${res.keys} setting${res.keys === 1 ? '' : 's'} applied.`,
            tone: 'success',
          });
          await reopen('global');
        });
      }

      // Rebuild session cache (T-2.7) — the existing rebuild-cache IPC, behind a confirm.
      const rebuildBtn = settingsViewerBody.querySelector('#sv-rebuild-cache');
      if (rebuildBtn) {
        rebuildBtn.addEventListener('click', async () => {
          const confirmed = typeof showControlDialog === 'function'
            ? await showControlDialog({
                title: 'Rebuild session cache?',
                message: 'The session index is dropped and re-scanned from disk. Full re-scan, may take a while. Your session files are not touched.',
                confirmLabel: 'Rebuild',
                cancelLabel: 'Cancel',
                tone: 'warning',
              })
            : window.confirm('Rebuild the session cache? Full re-scan, may take a while.');
          if (!confirmed) return;
          const label = rebuildBtn.textContent;
          rebuildBtn.disabled = true;
          rebuildBtn.textContent = 'Rebuilding…';
          try {
            await window.api.rebuildCache();
            rebuildBtn.textContent = '✓ Rebuilt';
          } catch {
            rebuildBtn.textContent = 'Rebuild failed';
          }
          setTimeout(() => { rebuildBtn.textContent = label; rebuildBtn.disabled = false; }, 2500);
        });
      }
    }

    return { initMaintenanceSection };
  }

  window.settingsMaintenance = { create };
})();
