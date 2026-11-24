// Renderer for the standalone changes window (#277). Self-contained — uses only window.api (preload), diff-render.js and
// lib/file-tree.js (the List / Tree layout of each status group, #894).
// Loaded as an external script because the app enforces a `script-src 'self'` CSP that blocks inline.
(function () {
  'use strict';
  const params = new URLSearchParams(location.search);
  const cwd = params.get('cwd') || '';
  const label = params.get('label') || cwd;
  document.title = 'Changes — ' + label;

  const el = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const splitPath = (p) => {
    const i = p.lastIndexOf('/');
    return i >= 0 ? '<span class="dir">' + esc(p.slice(0, i + 1)) + '</span>' + esc(p.slice(i + 1)) : esc(p);
  };
  const abs = (rel) => cwd.replace(/\/+$/, '') + '/' + rel;

  const GROUPS = [
    { kind: 'conflicted', title: 'Conflicted', color: 'var(--red)' },
    { kind: 'staged', title: 'Staged', color: 'var(--green)' },
    { kind: 'unstaged', title: 'Unstaged', color: 'var(--amber)' },
    { kind: 'untracked', title: 'Untracked', color: 'var(--faint)' },
  ];
  const LETTER = { staged: 'M', unstaged: 'M', untracked: '?', conflicted: 'U' };

  const store = (() => { try { return window.localStorage; } catch { return null; } })();
  let layout = readFileListLayout(store);
  const folded = new Set();     // `<group kind>|<folder path>` of every folded folder in Tree; this window only
  let last = null;              // the status last drawn, so a layout or fold change redraws without a poll

  // `at` is the row's place in Tree ({ name, depth }); without it the row is the List row with its whole path.
  function fileRow(f, at) {
    const name = at ? esc(at.name) : splitPath(f.path);
    const path = f.origPath ? '<span class="ren">' + esc(f.origPath) + ' → </span>' + name : name;
    const letter = (f.x && f.x !== '.') ? f.x : (f.y && f.y !== '.') ? f.y : LETTER[f.kind] || '•';
    return '<div class="file' + (at ? ' in-tree' : '') + '" data-path="' + esc(f.path) + '" data-kind="' + esc(f.kind) + '"'
      + (at ? ' style="--depth:' + at.depth + '" title="' + esc(f.path) + '"' : '') + '>'
      + '<span class="st ' + f.kind + '">' + esc(letter) + '</span>'
      + '<span class="fpath">' + path + '</span>'
      + '<span class="actions"><button data-act="open">Open</button><button data-act="reveal">Reveal</button></span>'
      + '</div>';
  }

  // A folder row of Tree: a click folds or unfolds what is under it.
  function dirRow(group, row) {
    return '<div class="tree-dir' + (row.collapsed ? ' collapsed' : '') + '" data-dir="' + esc(group + '|' + row.path) + '" style="--depth:' + row.depth + '"'
      + ' role="button" tabindex="0" aria-expanded="' + (row.collapsed ? 'false' : 'true') + '" title="' + esc(row.path) + '">'
      + '<span class="caret">' + (row.collapsed ? '▸' : '▾') + '</span><span class="fpath">' + esc(row.name) + '/</span>'
      + '<span class="n">' + row.count + '</span></div>';
  }

  function groupRows(rows, kind) {
    if (layout !== 'tree') return rows.map((f) => fileRow(f)).join('');
    return fileTreeRows(rows, (f) => f.path, (path) => folded.has(kind + '|' + path))
      .map((row) => (row.kind === 'dir' ? dirRow(kind, row) : fileRow(row.item, row))).join('');
  }

  function drawLayout() {
    const host = el('layout');
    if (!host.children.length) {
      host.innerHTML = FILE_LIST_LAYOUTS.map(([value, text]) => '<button type="button" class="btn" data-layout="' + esc(value) + '" aria-pressed="false">' + esc(text) + '</button>').join('');
    }
    for (const b of host.querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.layout === layout ? 'true' : 'false');
  }

  function render(s) {
    last = s;
    drawLayout();
    if (!s) {
      el('body').innerHTML = '<div class="empty">No status yet — this may not be a repository, or the first poll is pending.</div>';
      el('branch').textContent = ''; el('state').style.display = 'none'; el('foot').textContent = '';
      return;
    }
    el('repo').textContent = label;
    el('repo').title = cwd;
    const inProgress = s.state && s.state !== 'detached';
    el('branch').textContent = inProgress ? '' : (s.branch || (s.state === 'detached' ? 'detached' : ''));
    if (inProgress) { el('state').style.display = ''; el('state').textContent = s.state; }
    else el('state').style.display = 'none';

    const files = Array.isArray(s.files) ? s.files : [];
    let html = '';
    for (const g of GROUPS) {
      const rows = files.filter((f) => f.kind === g.kind);
      if (!rows.length) continue;
      html += '<div class="grp"><div class="grp-head"><span class="bar" style="background:' + g.color + '"></span>'
        + g.title + ' <span class="n">' + rows.length + '</span></div>' + groupRows(rows, g.kind) + '</div>';
    }
    el('body').innerHTML = html || '<div class="empty">Working tree clean.</div>';

    const seg = [];
    if (s.staged) seg.push(s.staged + ' staged');
    if (s.unstaged) seg.push(s.unstaged + ' unstaged');
    if (typeof s.untracked === 'number' && s.untracked) seg.push(s.untracked + ' untracked');
    if (s.conflicted) seg.push(s.conflicted + ' conflicted');
    el('foot').innerHTML = (seg.join(' · ') || 'clean') + (s.truncated ? ' <span class="truncated">(list truncated)</span>' : '');
  }

  let lastAt = 0;
  function stampUpdated() { lastAt = Date.now(); el('updated').textContent = 'updated just now'; }
  setInterval(() => {
    if (!lastAt) return;
    const secs = Math.round((Date.now() - lastAt) / 1000);
    el('updated').textContent = 'updated ' + (secs < 60 ? secs + 's' : Math.round(secs / 60) + 'm') + ' ago';
  }, 5000);

  el('body').addEventListener('click', (e) => {
    // "Open in window" lives in a diff pane, which is a SIBLING of its file row (not inside it), so it is
    // handled before the row-scoped logic below. Its row is the pane's previous sibling (#287).
    const expandBtn = e.target.closest('button.diff-expand');
    if (expandBtn) {
      const pane = expandBtn.closest('.diff-pane');
      const row = pane && pane.previousElementSibling;
      if (row && row.classList.contains('file')) {
        const kind = row.dataset.kind;
        window.api.openDiffWindow({ cwd, path: row.dataset.path, kind, staged: kind === 'staged', label });
      }
      return;
    }
    const btn = e.target.closest('button[data-act]');
    if (btn) {
      const rel = btn.closest('.file').dataset.path;
      if (btn.dataset.act === 'open') window.api.openPath(abs(rel));
      // The working directory travels with the path (#477): main decides whether it is inside the
      // repository before it hands anything to the file manager, and it cannot do that from a path alone.
      else window.api.vcsReveal({ cwd, path: rel });
      return;
    }
    // A click inside the diff pane (selecting text, etc.) must not collapse the row.
    if (e.target.closest('.diff-pane')) return;
    const dir = e.target.closest('[data-dir]');
    if (dir) { toggleFolder(dir.dataset.dir); return; }
    const row = e.target.closest('.file');
    if (row) toggleDiff(row);
  });

  // A fold or a layout change redraws the last status. An open diff is closed by the redraw, as a poll's redraw does.
  function toggleFolder(key) {
    if (folded.has(key)) folded.delete(key); else folded.add(key);
    if (last) render(last);
  }

  el('body').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const dir = e.target.closest('[data-dir]');
    if (!dir) return;
    e.preventDefault();
    const key = dir.dataset.dir;
    toggleFolder(key);
    const again = [...document.querySelectorAll('[data-dir]')].find((d) => d.dataset.dir === key);
    if (again) again.focus();          // the row was drawn anew: the caret stays on it
  });

  el('layout').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-layout]');
    if (!b || b.dataset.layout === layout) return;
    layout = b.dataset.layout === 'tree' ? 'tree' : 'list';
    writeFileListLayout(store, layout);
    if (last) render(last); else drawLayout();
  });

  // Click a row to expand/collapse its diff underneath (#285).
  async function toggleDiff(row) {
    const next = row.nextElementSibling;
    if (next && next.classList.contains('diff-pane')) { next.remove(); row.classList.remove('expanded'); return; }
    const pane = document.createElement('div');
    pane.className = 'diff-pane';
    pane.innerHTML = '<div class="diff-empty">Loading diff…</div>';
    row.after(pane);
    row.classList.add('expanded');
    try {
      const kind = row.dataset.kind;
      const res = await window.api.vcsDiff({ cwd, path: row.dataset.path, kind, staged: kind === 'staged' });
      if (!res || !res.ok) { pane.innerHTML = '<div class="diff-empty">' + esc((res && res.error) || 'Diff failed.') + '</div>'; return; }
      if (res.note) { pane.innerHTML = '<div class="diff-empty">' + esc(res.note) + '</div>'; return; }
      pane.innerHTML = diffBarHtml(res.text) + renderDiff(res.text);
    } catch (err) {
      pane.innerHTML = '<div class="diff-empty">Diff failed.</div>';
    }
  }

  el('refresh').addEventListener('click', async () => {
    const s = await window.api.vcsRefresh(cwd);
    if (s) { render(s); stampUpdated(); }
  });

  if (window.api.onVcsStatusChanged) {
    window.api.onVcsStatusChanged((payload) => {
      if (payload && payload.cwd === cwd) { render(payload.summary); stampUpdated(); }
    });
  }

  (async () => {
    try {
      const cached = await window.api.vcsStatus(cwd);
      if (cached) { render(cached); stampUpdated(); }
      const fresh = await window.api.vcsRefresh(cwd);
      if (fresh) { render(fresh); stampUpdated(); }
    } catch (e) { render(null); }
  })();
})();
