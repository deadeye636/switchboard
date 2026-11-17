// The session sidebar's Changes group, as data and markup (#870, spec 47 section 6). Electron-free (UMD), no DOM, no IPC.
//
// `session/session-sidebar.js` asks main for the view model (`sessionChanges`, `sessionChangesSummary`) and hands the
// answer here: the head figure, the state the group is in, the rows, the split blocks and the markup. Every text that
// somebody else wrote (a path, a commit subject) goes through `esc`. A row carries no backend and no format: the model
// is neutral, and what a backend cannot report arrives as a state (`not-reported`), never as a branch here.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const CHANGES_RANGES = Object.freeze([
    ['since-review', 'Since last review'],
    ['today', 'Today'],
    ['since-push', 'Since last push'],
    ['whole', 'Whole session'],
    ['pick', 'Pick entries…'],
  ]);
  const CHANGES_VIEWS = Object.freeze([['all', 'All'], ['split', 'Split']]);
  // A list longer than this is cut; Details has the rest.
  const CHANGES_LIST_CAP = 30;

  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

  function defaultTime(at) {
    if (!isNum(at)) return '';
    const d = new Date(at);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  // The collapsed header's figure (V1): what the database says is new since the last review. Nothing, not "0".
  function changesHeadFigure(summary) {
    const f = summary && summary.ok && summary.reports !== false ? summary.figure : null;
    if (!f) return '';
    const parts = [];
    if (f.files > 0) parts.push(count(f.files, 'file'));
    if (f.commits > 0) parts.push(count(f.commits, 'commit'));
    return parts.join(' · ');
  }

  // One sentence per note code of the model (spec 47, "States the group must draw"). A git error's own text never gets here.
  const NOTE_TEXT = {
    'not-reported': { tone: '', text: () => 'This CLI does not report which files it changed.' },
    'no-repo': { tone: 'warn', text: () => 'No repository: diffs are not available.' },
    'baseline-gone': { tone: 'warn', text: () => 'The review point is no longer in this repository’s history. Diffs are not available.' },
    'range-start-gone': { tone: 'warn', text: () => 'The start of this range is no longer in this repository’s history.' },
    'vcs-failed': { tone: 'warn', text: () => 'Version control could not be read. Showing the last good view.' },
    'counts-unavailable': { tone: '', text: () => 'Line counts are not shown for every file.' },
    truncated: { tone: '', text: (n) => `Only the first ${n.limit} files are listed.` },
    'nothing-since-review': { tone: '', text: () => 'Nothing since the last review.' },
  };

  // The state the group is in and the notes it says: pure, so a test can pin every row of the states table.
  function changesStateOf(view) {
    if (!view || view.ok === false) {
      return { kind: 'error', controls: false, lists: false, details: false, clear: false, setReviewPoint: false, notes: [{ tone: 'warn', text: 'The changes could not be read.' }] };
    }
    if (view.reports === false) {
      return { kind: 'not-reported', controls: false, lists: false, details: false, clear: false, setReviewPoint: false, notes: [{ tone: '', text: NOTE_TEXT['not-reported'].text() }] };
    }
    const lists = (view.files || []).length > 0 || (view.commits || []).length > 0 || (view.blocks || []).some((b) => !b.empty);
    const notes = [];
    const codes = Array.isArray(view.notes) ? view.notes : [];
    const known = codes.filter((n) => n && NOTE_TEXT[n.code]);
    // The sentence that names the state comes first.
    for (const n of known.filter((k) => k.code === 'nothing-since-review')) notes.push({ tone: NOTE_TEXT[n.code].tone, text: NOTE_TEXT[n.code].text(n) });
    if (view.state === 'nothing-in-range' && !notes.length) notes.push({ tone: '', text: 'Nothing in this range.' });
    for (const n of known.filter((k) => k.code !== 'nothing-since-review')) notes.push({ tone: NOTE_TEXT[n.code].tone, text: NOTE_TEXT[n.code].text(n) });
    if (view.range && view.range.approxStart) notes.push({ tone: '', text: 'Today starts inside a block: its counts include earlier work.' });
    const actions = view.actions || {};
    return {
      kind: view.state || 'nothing-in-range', controls: true, lists, details: true,
      clear: actions.clear === true, setReviewPoint: actions.setReviewPointNow === true, notes,
    };
  }

  function splitPath(key) {
    const s = String(key || '');
    const at = s.lastIndexOf('/');
    return at < 0 ? { dir: '', name: s } : { dir: s.slice(0, at + 1), name: s.slice(at + 1) };
  }

  function fileRow(f) {
    const { dir, name } = splitPath(f.key);
    const meta = [];
    if (f.outside) meta.push('outside this checkout');
    else if (f.isNew) meta.push('new');
    if (f.otherSessions > 0) meta.push(`+${count(f.otherSessions, 'session')}`);
    if (isNum(f.count)) meta.push(count(f.count, 'edit'));
    else if (f.unknown) meta.push('edits unknown');
    return {
      kind: 'file', key: `file:${f.id}`, id: f.id, path: f.key, dir, name, meta: meta.join(' · '), mark: null,
      tip: f.otherSessions > 0 ? `${f.key}: also edited by another session; its diff mixes both` : f.key,
      // An outside path is listed, never opened from here.
      actions: f.outside ? ['copy'] : ['open', 'copy'], insert: f.key, copy: f.key,
    };
  }

  function commitRow(c) {
    let mark = { tone: 'local', text: 'not pushed' };
    if (c.rewritten) mark = { tone: 'rewritten', text: 'rewritten' };
    else if (c.pushed) mark = { tone: 'pushed', text: 'pushed' };
    return {
      kind: 'commit', key: `commit:${c.id}`, id: c.id, path: '', dir: '', name: c.subject || '(no subject)', meta: c.sha || '', mark,
      tip: c.rewritten ? 'This commit is no longer in the repository’s history' : (c.subject || ''),
      actions: ['copy'], insert: c.sha || '', copy: c.sha || '',
    };
  }

  function listOf(items, build, head) {
    if (!items || !items.length) return null;
    const rows = items.slice(0, CHANGES_LIST_CAP).map(build);
    return { head: `${head} · ${items.length}`, rows, more: Math.max(0, items.length - rows.length) };
  }

  function blockModel(b, index, ui, fmt) {
    const seen = ui.seen instanceof Set ? ui.seen : new Set();
    const openNow = ui.open instanceof Set ? ui.open : new Set();
    const title = b.kind === 'open' ? 'Not pushed yet' : b.kind === 'pushed' ? `Push ${fmt(b.push && b.push.at)}`.trim() : 'Earlier';
    const edges = (b.marks || []).map((m) => ({ kind: m.kind, text: `${m.kind === 'cli-clear' ? '/clear' : 'Clear'} ${fmt(m.at)}`.trim() }));
    const t = b.totals || {};
    const fig = [t.files > 0 ? count(t.files, 'file') : '', t.commits > 0 ? count(t.commits, 'commit') : ''].filter(Boolean).join(' · ');
    return {
      id: b.id, title, edges, fig, empty: b.empty === true,
      open: seen.has(b.id) ? openNow.has(b.id) : index === 0,
      files: listOf(b.files, fileRow, 'Files'), commits: listOf(b.commits, commitRow, 'Commits'),
    };
  }

  // What the group draws, as data. `ui`: `fmt(at)` for a time of day, `open` / `seen` the split blocks the user has open
  // and the ones drawn before (a block never drawn opens when it is the newest).
  function changesRowModel(view, ui = {}) {
    const fmt = typeof ui.fmt === 'function' ? ui.fmt : defaultTime;
    const state = changesStateOf(view);
    const model = {
      state, request: view && view.request ? view.request : null, context: '', files: null, commits: null, blocks: [], footer: '',
    };
    if (!state.controls) return model;
    const kind = view.request && view.request.range;
    const review = view.lastReview;
    if (state.lists) {
      if (kind === 'since-review') model.context = review && review.at ? `Since Clear ${fmt(review.at)}${review.sha ? ` · ${review.sha}` : ''}` : 'Since the session started';
      else model.context = { today: 'Today', 'since-push': 'Since the last push', whole: 'Whole session', pick: 'Picked entries' }[kind] || '';
    } else if (kind === 'since-review' && review && review.at) {
      const now = isNum(ui.now) ? ui.now : Date.now();
      const day = (at) => new Date(at).toDateString();
      model.context = day(review.at) === day(now) ? `Reviewed today ${fmt(review.at)}` : `Reviewed ${day(review.at)} ${fmt(review.at)}`;
    }
    if (view.view === 'split') {
      model.blocks = (view.blocks || []).map((b, i) => blockModel(b, i, ui, fmt));
    } else {
      model.files = listOf(view.files, fileRow, 'Files');
      model.commits = listOf(view.commits, commitRow, 'Commits');
      if (view.lastPush && view.lastPush.at && (view.commits || []).length) {
        const open = (view.totals && view.totals.notPushed) || 0;
        model.footer = `Last push ${fmt(view.lastPush.at)}${open > 0 ? ` · ${count(open, 'commit')} not pushed` : ''}`;
      }
    }
    return model;
  }

  // The rows by key, so a click finds the object without the markup carrying it.
  function changesRowIndex(model) {
    const out = new Map();
    const add = (list) => { if (list) for (const r of list.rows) out.set(r.key, r); };
    add(model.files);
    add(model.commits);
    for (const b of model.blocks) { add(b.files); add(b.commits); }
    return out;
  }

  const ACT_FACE = { open: ['↗', 'Open'], copy: ['⧉', 'Copy'] };

  function changesRowHtml(row) {
    const label = row.kind === 'commit' ? 'Copy SHA' : null;
    const buttons = row.actions.map((a) => {
      const [glyph, name] = ACT_FACE[a];
      const text = a === 'copy' && label ? label : name;
      return `<button type="button" class="ssb-head-btn ssb-act" data-ssb="chg-act" data-act="${a}" data-key="${esc(row.key)}" `
        + `title="${esc(text)}" aria-label="${esc(`${text} ${row.name}`)}">${glyph}</button>`;
    }).join('');
    const main = `${row.dir ? `<span class="ssb-dir">${esc(row.dir)}</span>` : ''}${esc(row.name)}`;
    const mark = row.mark ? `<span class="ssb-mark" data-tone="${esc(row.mark.tone)}">${esc(row.mark.text)}</span> ` : '';
    const meta = mark || row.meta ? `<span class="ssb-row-meta">${mark}${esc(row.meta)}</span>` : '';
    return `<div class="ssb-item"><button type="button" class="ssb-row" data-ssb="chg-row" data-key="${esc(row.key)}" title="${esc(row.tip)}">`
      + `<span class="ssb-row-main">${main}</span>${meta}</button><span class="ssb-acts">${buttons}</span></div>`;
  }

  function listHtml(list) {
    if (!list) return '';
    return `<div class="ssb-subhead">${esc(list.head)}</div>${list.rows.map(changesRowHtml).join('')}`
      + (list.more ? `<div class="ssb-note">${esc(`${list.more} more in Details`)}</div>` : '');
  }

  const noteHtml = (n) => `<div class="ssb-note${n.tone === 'warn' ? ' warn' : ''}">${esc(n.text)}</div>`;

  function controlsHtml(request) {
    const r = request || {};
    const options = CHANGES_RANGES.map(([v, l]) => `<option value="${v}"${v === r.range ? ' selected' : ''}>${esc(l)}</option>`).join('');
    const seg = CHANGES_VIEWS.map(([v, l]) => `<button type="button" class="ssb-head-btn ssb-issue-toggle" data-ssb="changes-view" data-view="${v}" `
      + `data-ssb-focus="changes-${v}" aria-pressed="${v === (r.view || 'all') ? 'true' : 'false'}">${esc(l)}</button>`).join('');
    return `<div class="ssb-ctl"><select class="ssb-sort ssb-changes-range" data-ssb-focus="changes-range" aria-label="Range" title="What the list covers">${options}</select>`
      + `<span class="ssb-seg">${seg}</span></div>`;
  }

  function blockHtml(b) {
    const edges = b.edges.map((e) => `<span class="ssb-edge" data-kind="${esc(e.kind)}">${esc(e.text)}</span>`).join('');
    const body = b.empty && !b.files && !b.commits ? '<div class="ssb-note">Nothing in this block.</div>' : listHtml(b.files) + listHtml(b.commits);
    return `<details class="ssb-sublist ssb-block" data-block="${esc(b.id)}"${b.open ? ' open' : ''}><summary><span class="ssb-row-main">${esc(b.title)}</span>`
      + `${edges}<span class="ssb-row-meta">${esc(b.fig)}</span></summary>${body}</details>`;
  }

  // The whole group's body. Details and Clear sit under the lists; a state with nothing to review has no Clear.
  function changesModelHtml(model) {
    const s = model.state;
    let html = s.controls ? controlsHtml(model.request) : '';
    html += s.notes.map(noteHtml).join('');
    if (model.context) html += `<div class="ssb-note">${esc(model.context)}</div>`;
    html += listHtml(model.files) + listHtml(model.commits) + model.blocks.map(blockHtml).join('');
    if (model.footer) html += `<div class="ssb-note">${esc(model.footer)}</div>`;
    if (s.details) {
      html += '<div class="ssb-actions"><button type="button" class="ssb-head-btn ssb-issue-toggle" data-ssb="changes-details" title="Open the changes window">Details</button>'
        + '<span class="ssb-spacer"></span>'
        + (s.setReviewPoint
          ? '<button type="button" class="ssb-head-btn ssb-issue-toggle" data-ssb="changes-clear" data-missing="1" title="The old review point is gone: start a new one here">Set review point to now</button>'
          : s.clear ? '<button type="button" class="ssb-head-btn ssb-issue-toggle" data-ssb="changes-clear" title="Mark as reviewed: sets an entry, hides nothing">Clear</button>' : '')
        + '</div>';
    }
    return html;
  }

  // What Clear says in the toast: what was marked as reviewed.
  function changesClearedText(view) {
    const f = view && view.figure;
    const parts = f ? [f.files > 0 ? count(f.files, 'file') : '', f.commits > 0 ? count(f.commits, 'commit') : ''].filter(Boolean) : [];
    return parts.length ? `Marked as reviewed: ${parts.join(', ')}.` : 'Marked as reviewed.';
  }

  return {
    CHANGES_RANGES, CHANGES_VIEWS, CHANGES_LIST_CAP,
    changesHeadFigure, changesStateOf, changesRowModel, changesRowIndex, changesRowHtml, changesModelHtml, changesClearedText,
  };
});
