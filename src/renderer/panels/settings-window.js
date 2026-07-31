// Bootstrap for the standalone settings window (settings.html).
// Must be an external script: the app's CSP (script-src 'self') blocks inline
// <script>, so the marker + open call live here. Loaded AFTER settings-panel.js,
// so window.openSettingsViewer is defined and the #settings-viewer DOM exists.
//
// WHICH settings comes from the URL (#365). Since the overlay was dropped this window serves the
// project scope too, and the window is kept warm and re-loaded rather than rebuilt — so the request
// has to be part of the load itself. A message would have to be re-sent on every re-seed, and a
// missed one would show the previous project's settings under the new project's name.
window.__SETTINGS_WINDOW__ = true;
if (typeof window.openSettingsViewer === 'function') {
  let scope = 'global';
  let projectPath = null;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('scope') === 'project' && params.get('path')) {
      scope = 'project';
      projectPath = params.get('path');
    }
  } catch { /* no query: the global settings are the sane default */ }
  window.openSettingsViewer(scope, projectPath);
}
