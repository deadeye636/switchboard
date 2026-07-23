// Renderer for the standalone diff window (#287). Opened from the changes window when an inline diff is
// large. Self-contained — uses only window.api (preload) and window.createMergeViewer (the CodeMirror
// bundle). External script because the app enforces `script-src 'self'`, which blocks inline.
(function () {
  'use strict';
  const params = new URLSearchParams(location.search);
  const cwd = params.get('cwd') || '';
  const rel = params.get('path') || '';
  const kind = params.get('kind') || '';
  const staged = params.get('staged') === '1';
  const label = params.get('label') || '';
  document.title = 'Diff — ' + rel;

  const el = (id) => document.getElementById(id);
  const filename = rel.split('/').pop() || rel;
  el('path').textContent = rel;
  el('sub').textContent = [label, kind + (staged ? ' (staged)' : '')].filter(Boolean).join(' · ');

  function showMsg(m) {
    const host = el('diff');
    host.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'msg';
    d.textContent = m;
    host.appendChild(d);
  }

  // Inject the CodeMirror bundle on demand (external src, allowed by `script-src 'self'`), the same way
  // the main window's viewer panel does — the standalone window can't share that loader.
  let _bundlePromise = null;
  function loadBundle() {
    if (_bundlePromise) return _bundlePromise;
    _bundlePromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'codemirror-bundle.js';
      s.onload = () => resolve();
      s.onerror = (err) => { _bundlePromise = null; reject(err); };
      document.head.appendChild(s);
    });
    return _bundlePromise;
  }

  (async () => {
    try {
      const res = await window.api.vcsFileVersions({ cwd, path: rel, kind, staged });
      if (!res || !res.ok) { showMsg((res && res.error) || 'Could not load diff.'); return; }
      if (res.note) { showMsg(res.note); return; }
      await loadBundle();
      if (typeof window.createMergeViewer !== 'function') { showMsg('Diff viewer unavailable.'); return; }
      const host = el('diff');
      host.innerHTML = '';
      // a = original (old, read-only left), b = modified (new, right).
      window.createMergeViewer(host, res.old || '', res.new || '', filename);
    } catch (e) {
      showMsg('Could not load diff.');
    }
  })();
})();
