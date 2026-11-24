// Renderer for a session's Details window (#870, spec 47 section 7). Self-contained: window.api (preload), the row helpers
// of lib/session-changes-rows.js (ranges, views, the state notes), lib/file-tree.js (the List / Tree layout of the file
// rows, #894) and diff-render.js (the diff colouring and its bar).
// An external script because the app enforces `script-src 'self'`.
//
// The page holds a SESSION ID and row ids main gave out, never a path or a SHA of its own. Everything somebody else wrote
// (a path, a commit subject and body, a diff line) goes through `esc` or `renderDiff`. The review log is the Clear ticks
// of the strip (V2): picking the range between two of them is how a review is read again (T13 adds the read-only mark).
(function () {
  'use strict';
  const params = new URLSearchParams(location.search);
  const sessionId = params.get('session') || '';
  const label = params.get('label') || '';
  let startAt = {};
  try { startAt = JSON.parse(params.get('at') || '{}') || {}; } catch { startAt = {}; }
  document.title = 'Changes — ' + (label || 'session');

  const el = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const NOW_TICK = '__now__';

  const pad = (n) => String(n).padStart(2, '0');
  const clock = (d) => pad(d.getHours()) + ':' + pad(d.getMinutes());
  // A time of today reads as a clock; an earlier one carries its weekday.
  function when(at) {
    if (!isNum(at)) return '';
    const d = new Date(at);
    return d.toDateString() === new Date().toDateString() ? clock(d) : d.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + clock(d);
  }

  const state = {
    request: { range: 'since-review', view: 'all', pickFrom: null, pickTo: null },
    view: null,
    picking: null,          // { from: tickId | null } while the user chooses a range on the strip
    expanded: new Set(),    // row ids whose diff is open
    diffs: new Map(),       // row id -> markup of its last read (drawn at once, read again after each refresh)
    selected: null,
    at: startAt,
    atStamp: 0,             // the read counter when `at` was set: only a read STARTED after it may land on it
    seq: 0,
    layout: 'list',         // 'list' | 'tree' (#894), the choice both changed-file windows share
    folded: new Set(),      // `<group>|<folder path>` of every folded folder in Tree; this window only
  };
  const store = (() => { try { return window.localStorage; } catch { return null; } })();
  state.layout = readFileListLayout(store);

  const splitPath = (p) => {
    const i = p.lastIndexOf('/');
    return i >= 0 ? '<span class="dir">' + esc(p.slice(0, i + 1)) + '</span>' + esc(p.slice(i + 1)) : esc(p);
  };

  // --- the rows ---

  // `at` is the row's place in Tree ({ name, depth }); without it the row is the List row with its whole path.
  function fileRowHtml(f, at) {
    const tags = [];
    if (f.outside) tags.push('<span class="tag">outside this checkout</span>');
    else if (f.isNew) tags.push('<span class="tag new">new</span>');
    if (f.otherSessions > 0) tags.push('<span class="tag shared" title="Its diff mixes both">also edited by ' + esc(plural(f.otherSessions, 'other session')) + '</span>');
    let lines = '';
    if (f.binary) lines = '<span class="edits">binary</span>';
    else if (isNum(f.added)) lines = '<span class="add">+' + f.added + '</span><span class="del">−' + (f.deleted || 0) + '</span>';
    const edits = isNum(f.count) ? plural(f.count, 'edit') : f.unknown ? 'edits unknown' : '';
    const open = state.expanded.has(f.id);
    return '<div class="file' + (at ? ' in-tree' : '') + (open ? ' expanded' : '') + (state.selected === f.id ? ' selected' : '') + '" data-id="' + esc(f.id) + '" data-kind="file"'
      + (at ? ' style="--depth:' + at.depth + '" title="' + esc(f.key) + '"' : '') + '>'
      + '<span class="fpath">' + (at ? esc(at.name) : splitPath(f.key)) + '</span><span class="cnt">' + tags.join('') + lines
      + '<span class="edits">' + esc(edits) + '</span></span></div>' + (open ? paneHtml(f.id) : '');
  }

  // A folder row of Tree: a click folds or unfolds what is under it.
  function dirRowHtml(group, row) {
    return '<div class="tree-dir' + (row.collapsed ? ' collapsed' : '') + '" data-dir="' + esc(group + '|' + row.path) + '" style="--depth:' + row.depth + '"'
      + ' role="button" tabindex="0" aria-expanded="' + (row.collapsed ? 'false' : 'true') + '" title="' + esc(row.path) + '">'
      + '<span class="caret">' + (row.collapsed ? '▸' : '▾') + '</span><span class="fpath">' + esc(row.name) + '/</span>'
      + '<span class="cnt"><span class="edits">' + esc(plural(row.count, 'file')) + '</span></span></div>';
  }

  // One group's file rows (a split block, or the one list), in the chosen layout.
  function filesHtml(files, group) {
    if (state.layout !== 'tree') return files.map((f) => fileRowHtml(f)).join('');
    return fileTreeRows(files, (f) => f.key, (path) => state.folded.has(group + '|' + path))
      .map((row) => (row.kind === 'dir' ? dirRowHtml(group, row) : fileRowHtml(row.item, row))).join('');
  }

  function commitRowHtml(c) {
    let mark = '<span class="m local">not pushed</span>';
    if (c.rewritten) mark = '<span class="m rewritten" title="No longer in this repository’s history">rewritten</span>';
    else if (c.pushed) mark = '<span class="m pushed">pushed' + (isNum(c.pushedAt) ? ' ' + esc(when(c.pushedAt)) : '') + '</span>';
    const open = state.expanded.has(c.id);
    return '<div class="commit' + (open ? ' expanded' : '') + (state.selected === c.id ? ' selected' : '') + '" data-id="' + esc(c.id) + '" data-kind="commit">'
      + '<span class="sha">' + esc(c.sha || '') + '</span><span class="subj">' + esc(c.subject || '(no subject)') + '</span>'
      + '<span class="cnt"><span class="edits">' + esc(when(c.at)) + '</span>' + mark + '</span></div>' + (open ? paneHtml(c.id) : '');
  }

  function paneHtml(id) {
    return '<div class="diff-pane" data-for="' + esc(id) + '">' + (state.diffs.get(id) || '<div class="diff-empty">Loading diff…</div>') + '</div>';
  }

  function totalsText(t) {
    if (!t) return '';
    const parts = [plural(t.files || 0, 'file'), plural(t.commits || 0, 'commit')];
    if (isNum(t.added)) parts.push('+' + t.added + ' −' + (t.deleted || 0));
    return parts.join(' · ');
  }

  function sectionHtml(head, commits, files, group) {
    return head + commits.map(commitRowHtml).join('') + filesHtml(files, group)
      + (!commits.length && !files.length ? '<div class="empty">Nothing in this block.</div>' : '');
  }

  function rangeLabel(request) {
    const found = CHANGES_RANGES.find((r) => r[0] === request.range);
    const review = state.view && state.view.review;
    if (review && request.range === 'pick') return 'Review ' + review.n;
    return request.range === 'pick' ? 'Picked entries' : found ? found[1] : '';
  }

  function tickSha(v, id) {
    const t = (v.ticks || []).find((x) => x.id === id);
    return t && t.sha ? t.sha : '';
  }

  function bodyHtml(v, st) {
    let html = '';
    for (const n of st.notes) html += '<div class="note' + (n.tone === 'warn' ? ' warn' : '') + '">' + esc(n.text) + '</div>';
    if (!st.controls) return html || '<div class="empty big">Nothing to show.</div>';
    // V2: a picked range from one Clear to the next is a past review, read-only. The way back is the current view.
    if (v.review) {
      html = '<div class="note review"><span class="tag clear">Review ' + v.review.n + ' · read-only</span> '
        + esc((isNum(v.review.fromAt) ? 'from ' + when(v.review.fromAt) + ' ' : '') + 'to ' + when(v.review.at))
        + ' <button type="button" class="btn" data-act="back-current" title="Go back to what is new since the last review">Back to the current view</button></div>' + html;
    }
    const t = v.totals || {};
    const sub = ['Changes by this session', '<b>' + esc(rangeLabel(state.request)) + '</b>', plural(t.files || 0, 'file'), plural(t.commits || 0, 'commit')];
    if (t.notPushed > 0) sub.push(t.notPushed + ' not pushed');
    let line = sub.join(' · ');
    if (isNum(t.otherCommits) && t.otherCommits > 0) line += ' · + ' + plural(t.otherCommits, 'other commit') + ' in this range, not made by this session';
    html += '<div class="sub">' + line + '</div>';
    const base = v.footer && v.footer.baseSha ? v.footer.baseSha : '';
    if (v.view === 'split' && (v.blocks || []).length) {
      for (const b of v.blocks) {
        const title = b.kind === 'open' ? 'Not pushed yet' : b.kind === 'pushed' ? 'Push ' + when(b.push && b.push.at) : 'Earlier';
        const tags = (b.marks || []).map((m) => '<span class="tag ' + (m.kind === 'cli-clear' ? 'cli' : 'clear') + '">contains '
          + (m.kind === 'cli-clear' ? '/clear' : 'Clear') + ' ' + esc(when(m.at)) + '</span>').join('')
          + (b.kind === 'pushed' ? '<span class="tag push">pushed</span>' : '');
        const range = (b.fromSha || '?') + ' → ' + (b.kind === 'open' ? 'working tree' : b.toSha || '?');
        html += sectionHtml('<div class="seg-head" data-block="' + esc(b.id) + '"><span class="t">' + esc(title.trim()) + '</span><span class="range">' + esc(range)
          + '</span>' + tags + '<span class="tot">' + esc(totalsText(b.totals)) + '</span></div>', b.commits || [], b.files || [], 'block:' + b.id);
      }
    } else if ((v.files || []).length || (v.commits || []).length) {
      const toSha = v.range && v.range.toId ? tickSha(v, v.range.toId) : '';
      const range = base ? base + ' → ' + (v.range && v.range.toId ? toSha || 'selected entry' : 'working tree') : '';
      html += sectionHtml('<div class="seg-head"><span class="t">' + esc(rangeLabel(state.request)) + '</span><span class="range">' + esc(range)
        + '</span><span class="tot">' + esc(totalsText(t)) + '</span></div>', v.commits || [], v.files || [], 'all');
    }
    // E7: what changed in the working tree without this session, and commits by others, are here and nowhere else; no diff.
    if (isNum(v.otherChanged) && v.otherChanged > 0) {
      html += '<div class="empty">' + esc(plural(v.otherChanged, 'other file') + ' changed in this working tree, not by this session (no diff shown).') + '</div>';
    }
    return html;
  }

  function footHtml(v, st) {
    if (!st.controls) return '';
    const t = v.totals || {};
    const parts = [esc(rangeLabel(state.request).toLowerCase()), esc(plural(t.files || 0, 'file'))];
    if (isNum(t.added)) parts.push('+' + t.added + ' −' + (t.deleted || 0));
    parts.push(esc(plural(t.edits || 0, 'edit')));
    const base = v.footer && v.footer.baseSha ? v.footer.baseSha : '';
    if (v.review) return '<span>' + parts.join(' · ') + '</span><span class="hint">A past review: read-only, nothing here can be cleared.</span>';
    const hint = base ? '<span class="hint">Pushed blocks are exact commit ranges. The open block is against ' + esc(base)
      + ' and may include earlier uncommitted work in a file edited again.</span>' : '';
    return '<span>' + parts.join(' · ') + '</span>' + hint;
  }

  // --- the strip ---

  function stripHtml(v) {
    const ticks = (v.ticks || []).slice();
    if (!ticks.length) return '';
    const fromAt = v.range ? ticks.findIndex((t) => t.id === v.range.fromId) : -1;
    const toAt = v.range && v.range.toId ? ticks.findIndex((t) => t.id === v.range.toId) : -1;
    const empty = !!(v.range && v.range.empty);
    const last = toAt >= 0 ? toAt : ticks.length;     // the "now" tick counts as one past the end
    const dotKind = { push: 'push', clear: 'clear', 'cli-clear': 'cli' };
    const word = { start: 'start', push: 'push', clear: 'Clear', 'cli-clear': '/clear' };
    const picked = state.picking && state.picking.from;
    // "Today" is derived, never stored: a marker where the first activity of today falls, not something to pick (V3).
    const todayAt = v.range && v.range.kind === 'today' && isNum(v.range.todayAt) ? v.range.todayAt : null;
    let markerDrawn = todayAt === null;
    // The marker sits between two ticks and carries the range's line through when both of its neighbours are inside it.
    const marker = (before) => '<span class="tick marker' + (!empty && fromAt >= 0 && before - 1 >= fromAt && before <= last ? ' in' : '') + '" title="The first activity of today: not an entry, so it cannot be picked">'
      + '<span class="dot"></span><span class="lbl">today</span><span class="tm">' + esc(when(todayAt)) + '</span></span>';
    const cells = [];
    ticks.forEach((t, i) => {
      if (!markerDrawn && isNum(t.at) && t.at > todayAt) { cells.push(marker(i)); markerDrawn = true; }
      const cls = ['tick'];
      if (!empty && fromAt >= 0) { if (i === fromAt) cls.push('in-l'); else if (i > fromAt && i <= last) cls.push('in'); }
      if (picked === t.id) cls.push('picked');
      cells.push('<button type="button" class="' + cls.join(' ') + '" data-tick="' + esc(t.id) + '" title="' + esc(t.sha ? 'at ' + t.sha : 'Pick this entry') + '">'
        + '<span class="dot ' + (dotKind[t.kind] || '') + '"></span><span class="lbl">' + esc(word[t.kind] || t.kind) + '</span><span class="tm">' + esc(when(t.at)) + '</span></button>');
    });
    if (!markerDrawn) cells.push(marker(ticks.length));
    const nowCls = ['tick'];
    if (!empty && fromAt >= 0 && toAt < 0) nowCls.push('in');
    if (picked === NOW_TICK) nowCls.push('picked');
    cells.push('<button type="button" class="' + nowCls.join(' ') + '" data-tick="' + NOW_TICK + '" title="The present: the range runs to the working tree">'
      + '<span class="dot now"></span><span class="lbl">now</span><span class="tm">' + esc(clock(new Date())) + '</span></button>');
    const note = state.picking
      ? '<div class="strip-note picking">' + (picked ? 'Now click the other end of the range.' : 'Pick entries: click the first and then the last entry of the range.')
        + ' <button type="button" class="btn" data-act="cancel-pick">Cancel</button></div>'
      : '<div class="strip-note">Click two entries to pick a range. Each Clear entry is a review: pick the range between two of them to read it again.'
        + (v.range && v.range.approxStart ? ' Today starts inside a block: its counts include earlier work.' : '') + '</div>';
    return '<div class="strip">' + cells.join('') + '</div>' + note;
  }

  // --- drawing ---

  function drawControls(v, st) {
    const select = el('range');
    if (!select.options.length) {
      select.innerHTML = CHANGES_RANGES.map(([value, text]) => '<option value="' + esc(value) + '">' + esc(text) + '</option>').join('');
      el('views').innerHTML = CHANGES_VIEWS.map(([value, text]) => '<button type="button" class="btn" data-view="' + esc(value) + '" aria-pressed="false">' + esc(text) + '</button>').join('');
      el('layout').innerHTML = FILE_LIST_LAYOUTS.map(([value, text]) => '<button type="button" class="btn" data-layout="' + esc(value) + '" aria-pressed="false">' + esc(text) + '</button>').join('');
    }
    select.value = state.picking ? 'pick' : state.request.range;
    for (const b of el('views').querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.view === state.request.view ? 'true' : 'false');
    for (const b of el('layout').querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.layout === state.layout ? 'true' : 'false');
    const showControls = !!(st && st.controls);
    select.hidden = !showControls;
    el('views').hidden = !showControls;
    el('layout').hidden = !showControls;
    const clear = el('clear');
    clear.hidden = !(st && (st.clear || st.setReviewPoint));
    clear.textContent = st && st.setReviewPoint ? 'Set review point to now' : 'Clear';
    clear.dataset.missing = st && st.setReviewPoint ? '1' : '';
  }

  // `readSeq` is given by a render that shows a finished read; any other render (a pick, a row toggle) never consumes `at`.
  function render(readSeq) {
    const v = state.view;
    const st = changesStateOf(v);
    drawControls(v, st);
    el('repo').textContent = label || 'Changes';
    el('repo').title = label;
    el('strip-host').innerHTML = v && v.ok !== false && st.controls ? stripHtml(v) : '';
    el('body').innerHTML = !v ? '<div class="empty big">Loading…</div>' : bodyHtml(v, st);
    el('foot').innerHTML = v && v.ok !== false ? footHtml(v, st) : '';
    for (const id of state.expanded) paintPane(id);
    landOnSelection(readSeq);
  }

  function paintPane(id) {
    const pane = [...document.querySelectorAll('.diff-pane')].find((p) => p.dataset.for === id);
    if (pane && state.diffs.has(id)) pane.innerHTML = state.diffs.get(id);
  }

  function diffMarkup(res) {
    if (!res || !res.ok) return '<div class="diff-empty">' + esc((res && res.error) || 'Diff failed.') + '</div>';
    if (res.kind === 'commit') {
      const c = res.commit || {};
      return '<div class="diff-empty"><b>' + esc(c.subject || '(no subject)') + '</b><br>' + esc((c.sha || '') + (isNum(c.time) ? ' · ' + when(c.time) : '')) + '</div>'
        + (c.body ? '<pre class="diff-pre">' + esc(c.body) + '</pre>' : '');
    }
    if (res.note) return '<div class="diff-empty">' + esc(res.note) + '</div>';
    return diffBarHtml(res.text) + renderDiff(res.text);
  }

  async function loadDiff(id) {
    let res = null;
    try { res = await window.api.sessionChangesDiff(sessionId, id); } catch { res = null; }
    if (!state.expanded.has(id)) return;
    state.diffs.set(id, diffMarkup(res));
    paintPane(id);
  }

  function toggleRow(id) {
    if (state.expanded.has(id)) { state.expanded.delete(id); state.diffs.delete(id); render(); return; }
    state.expanded.add(id);
    render();
    loadDiff(id);
  }

  // Opened at an item (`at.id`) or in pick mode (`at.pick`): the row is selected, opened and scrolled into view.
  function landOnSelection(readSeq) {
    const at = state.at;
    if (!at) return;
    // A read that was already out when `at` arrived may not list the item yet: it must not use `at` up.
    if (!isNum(readSeq) || readSeq <= state.atStamp) return;
    if (!state.view) return;     // nothing read yet: keep it for the first answer
    // Whatever the first completed read cannot land on is dropped, so it does not fire again on a later refresh.
    state.at = null;
    if (at.pick) {
      if (changesStateOf(state.view).controls) { state.picking = { from: null }; render(); }   // no strip to pick on otherwise
      return;
    }
    if (typeof at.id !== 'string') return;
    if (unfoldTo(at.id)) render();     // a row in a folded folder is not drawn
    const row = [...document.querySelectorAll('[data-id]')].find((r) => r.dataset.id === at.id);
    if (!row) return;          // not listed in this range: nothing to land on
    state.selected = at.id;
    state.expanded.add(at.id);
    render();           // `refresh` reads every open row's diff right after this
    const target = [...document.querySelectorAll('[data-id]')].find((r) => r.dataset.id === at.id);
    if (target && typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center' });
  }

  // Unfolds the folders the file with this row id sits in, in the section it is drawn in (the same keys `filesHtml`
  // folds by); a fold in another block stays. True when something was folded.
  function unfoldTo(id) {
    const v = state.view;
    if (!v || state.layout !== 'tree' || !state.folded.size) return false;
    const sections = v.view === 'split' && (v.blocks || []).length
      ? v.blocks.map((b) => ['block:' + b.id, b.files || []])
      : [['all', v.files || []]];
    let changed = false;
    for (const [group, files] of sections) {
      const f = files.find((x) => x.id === id);
      if (!f) continue;
      for (const path of fileTreeAncestors(f.key)) if (state.folded.delete(group + '|' + path)) changed = true;
    }
    return changed;
  }

  function toggleFolder(key) {
    if (state.folded.has(key)) state.folded.delete(key); else state.folded.add(key);
    render();
  }

  // --- reading ---

  async function keptView() {
    let kept = null;
    try { kept = await window.api.sessionChangesView(sessionId); } catch { kept = null; }
    if (kept && typeof kept === 'object') state.request = { range: kept.range, view: kept.view, pickFrom: kept.pickFrom || null, pickTo: kept.pickTo || null };
  }

  let inFlight = false;
  let again = false;
  async function refresh(fresh) {
    if (inFlight) { again = true; return; }
    inFlight = true;
    const my = ++state.seq;
    try {
      await keptView();
      let v = null;
      try { v = await window.api.sessionChangesDetails(sessionId, { ...state.request, fresh: fresh === true }); } catch { v = null; }
      if (my !== state.seq) return;
      state.view = v;
      if (v && v.ok !== false && v.request) state.request = v.request;
      // What was open is read again: the row ids are content-derived, so an id that is still listed is the same item.
      if (v && v.ok !== false) {
        const listed = new Set([...(v.files || []), ...(v.commits || []), ...(v.blocks || []).flatMap((b) => [...(b.files || []), ...(b.commits || [])])].map((r) => r.id));
        for (const id of [...state.expanded]) if (!listed.has(id)) { state.expanded.delete(id); state.diffs.delete(id); }
      }
      el('updated').textContent = 'updated ' + pad(new Date().getHours()) + ':' + pad(new Date().getMinutes()) + ':' + pad(new Date().getSeconds());
      render(my);
      for (const id of state.expanded) loadDiff(id);
    } finally {
      inFlight = false;
      if (again) { again = false; refresh(false); }
    }
  }

  async function keep(patch) {
    state.request = { ...state.request, ...patch };
    try { await window.api.sessionChangesView(sessionId, state.request); } catch { /* the next read uses what main kept */ }
    await refresh(false);
  }

  // --- the strip's two clicks make a range ("Pick entries") ---

  function pickTick(domId) {
    const v = state.view;
    if (!v) return;
    const ticks = v.ticks || [];
    // A stored entry's id is a NUMBER, and `dataset` hands it back as text: the id kept for the pick must be the tick's own,
    // or main's cleaning drops it and the range falls back to "from the start".
    const found = domId === NOW_TICK ? null : ticks.find((t) => String(t.id) === domId);
    if (domId !== NOW_TICK && !found) return;
    const id = found ? found.id : NOW_TICK;
    if (!state.picking || !state.picking.from) { state.picking = { from: id }; render(); return; }
    if (state.picking.from === id) { state.picking = null; render(); return; }
    const order = (x) => (x === NOW_TICK ? ticks.length : ticks.findIndex((t) => t.id === x));
    const [a, b] = order(state.picking.from) <= order(id) ? [state.picking.from, id] : [id, state.picking.from];
    state.picking = null;
    keep({ range: 'pick', pickFrom: a === NOW_TICK ? null : a, pickTo: b === NOW_TICK ? null : b });
  }

  // --- events ---

  el('strip-host').addEventListener('click', (e) => {
    if (e.target.closest('[data-act="cancel-pick"]')) { state.picking = null; render(); return; }
    const tick = e.target.closest('[data-tick]');
    if (tick) pickTick(tick.dataset.tick);
  });

  el('body').addEventListener('click', (e) => {
    if (e.target.closest('[data-act="back-current"]')) { state.picking = null; keep({ range: 'since-review', pickFrom: null, pickTo: null }); return; }
    const expand = e.target.closest('button.diff-expand');
    if (expand) {
      const pane = expand.closest('.diff-pane');
      if (pane && pane.dataset.for) {
        Promise.resolve(window.api.sessionChangesOpenDiffWindow(sessionId, pane.dataset.for)).catch(() => null).then((res) => {
          if (res && res.ok === false) el('updated').textContent = res.error || 'The diff could not be opened.';
        });
      }
      return;
    }
    if (e.target.closest('.diff-pane')) return;        // selecting text in a diff must not fold its row
    const dir = e.target.closest('[data-dir]');
    if (dir) { toggleFolder(dir.dataset.dir); return; }
    const row = e.target.closest('[data-id]');
    if (row) { state.selected = row.dataset.id; toggleRow(row.dataset.id); }
  });

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
    if (!b || b.dataset.layout === state.layout) return;
    state.layout = b.dataset.layout === 'tree' ? 'tree' : 'list';
    writeFileListLayout(store, state.layout);
    render();
  });

  el('range').addEventListener('change', () => {
    const value = el('range').value;
    if (value === 'pick') { state.picking = { from: null }; render(); return; }
    state.picking = null;
    keep({ range: value, pickFrom: null, pickTo: null });
  });

  el('views').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (b) keep({ view: b.dataset.view });
  });

  el('refresh').addEventListener('click', () => refresh(true));

  el('clear').addEventListener('click', async () => {
    let res = null;
    try { res = await window.api.sessionChangesClear(sessionId, { missing: el('clear').dataset.missing === '1' }); } catch { res = null; }
    if (!res || !res.ok) el('updated').textContent = 'It could not be marked as reviewed.';
    await refresh(true);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.picking) { state.picking = null; render(); }
  });

  // A window that is already open is pointed at another item or into pick mode (main sends the new `at`).
  if (typeof window.api.onSessionChangesDetailsAt === 'function') {
    window.api.onSessionChangesDetailsAt((at) => {
      state.at = at && typeof at === 'object' ? at : {};
      state.atStamp = state.seq;     // a read already out started before this: it may not land on it
      if (state.at.pick || state.at.id) refresh(false);
    });
  }

  // The window follows its session while it is open: main answers a checkout or scan change with one notice.
  let offUpdates = null;
  let following = false;
  async function follow() {
    if (typeof window.api.sessionChangesFollow !== 'function') return;
    if (typeof window.api.onSessionChangesUpdated === 'function') {
      offUpdates = window.api.onSessionChangesUpdated((payload) => { if (payload && payload.sessionId === sessionId) refresh(false); });
    }
    let res = null;
    try { res = await window.api.sessionChangesFollow(sessionId); } catch { res = null; }
    following = !!(res && res.ok === true);
  }
  function release() {
    if (typeof offUpdates === 'function') { offUpdates(); offUpdates = null; }
    if (following && typeof window.api.sessionChangesUnfollow === 'function') window.api.sessionChangesUnfollow(sessionId);
    following = false;
  }
  window.addEventListener('pagehide', release);

  follow();
  refresh(false);
})();
