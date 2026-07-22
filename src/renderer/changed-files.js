// Renderer for the standalone changes window (#277). Self-contained — uses only window.api (preload).
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

  function fileRow(f) {
    const path = f.origPath ? '<span class="ren">' + esc(f.origPath) + ' → </span>' + splitPath(f.path) : splitPath(f.path);
    const letter = (f.x && f.x !== '.') ? f.x : (f.y && f.y !== '.') ? f.y : LETTER[f.kind] || '•';
    return '<div class="file" data-path="' + esc(f.path) + '" data-kind="' + esc(f.kind) + '">'
      + '<span class="st ' + f.kind + '">' + esc(letter) + '</span>'
      + '<span class="fpath">' + path + '</span>'
      + '<span class="actions"><button data-act="open">Open</button><button data-act="reveal">Reveal</button></span>'
      + '</div>';
  }

  function render(s) {
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
        + g.title + ' <span class="n">' + rows.length + '</span></div>' + rows.map(fileRow).join('') + '</div>';
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
    const btn = e.target.closest('button[data-act]');
    if (btn) {
      const rel = btn.closest('.file').dataset.path;
      if (btn.dataset.act === 'open') window.api.openPath(abs(rel));
      else window.api.vcsReveal(abs(rel));
      return;
    }
    const row = e.target.closest('.file');
    if (row) toggleDiff(row);
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
      pane.innerHTML = renderDiff(res.text);
    } catch (err) {
      pane.innerHTML = '<div class="diff-empty">Diff failed.</div>';
    }
  }

  function renderDiff(text) {
    if (!text || !text.trim()) return '<div class="diff-empty">No textual changes.</div>';
    const lines = text.split('\n').slice(0, 4000);
    const html = lines.map((l) => {
      const e = esc(l);
      if (l.startsWith('+++') || l.startsWith('---')) return '<span class="d-meta">' + e + '</span>';
      if (l[0] === '+') return '<span class="d-add">' + e + '</span>';
      if (l[0] === '-') return '<span class="d-del">' + e + '</span>';
      if (l.startsWith('@@')) return '<span class="d-hunk">' + e + '</span>';
      if (/^(diff |index |new file|deleted |rename |similarity |Binary )/.test(l)) return '<span class="d-meta">' + e + '</span>';
      return e;
    }).join('\n');
    return '<pre class="diff-pre">' + html + '</pre>';
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
