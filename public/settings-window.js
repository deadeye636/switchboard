// Bootstrap for the standalone settings window (settings.html).
// Must be an external script: the app's CSP (script-src 'self') blocks inline
// <script>, so the marker + open call live here. Loaded AFTER settings-panel.js,
// so window.openSettingsViewer is defined and the #settings-viewer DOM exists.
window.__SETTINGS_WINDOW__ = true;
if (typeof window.openSettingsViewer === 'function') {
  window.openSettingsViewer('global');
}
