// session/branch-tree-dialog.js — a session's branch tree, and the move to another point of it (#646).
//
// A session driven over a runtime protocol can keep its conversation as a TREE: an edited prompt or a switch
// starts a branch beside the old one, and nothing is ever deleted. `/tree` in such a session asks main for
// the tree; main answers with rows the BACKEND built (`branchTree` op — `id`, `depth`, `kind`, `text`,
// `label`, `onPath`, `current`), and this dialog draws them. It knows no backend and reads no format: a
// row's `kind` is the app's word (user / assistant / tool / summary / setting / other), and the indentation
// is the backend's `depth`, the number of forks above the row.
//
// A modal and not a card in the conversation (owner decision T1): a tree can be long, and a card in the
// log would be stale the moment the next turn arrived. It holds nothing the user cannot get back, so a
// backdrop click and Escape close it like any question.
//
// Free globals read at call time: trapControlDialogFocus, controlDialogId (dialogs/control-dialogs.js).

// The three views of the tree (owner decision T2). The runtime's own tree view has more; these are the ones
// that answer "where do I want to go back to".
const BRANCH_TREE_FILTERS = [
  { key: 'default', label: 'Conversation', title: 'Messages, tool results and summaries — settings changes are left out', test: r => r.kind !== 'setting' },
  { key: 'user', label: 'Your messages', title: 'Only what you wrote — the points you would rewrite', test: r => r.kind === 'user' },
  { key: 'all', label: 'Everything', title: 'Every entry, settings changes included', test: () => true },
];

const BRANCH_TREE_KIND_LABELS = { user: 'You', assistant: 'Agent', tool: 'Tool', summary: 'Summary', setting: 'Setting', other: 'Entry' };

// Past a dozen forks the indentation stops growing: the text has to stay readable in a 720 px dialog.
const BRANCH_TREE_INDENT_PX = 14;
const BRANCH_TREE_MAX_INDENT = 12;

/**
 * @param {{ rows: object[], truncated?: boolean, onSwitch: (id: string, summarize: boolean) => void }} options
 */
function showBranchTreeDialog({ rows, truncated, onSwitch } = {}) {
  const all = Array.isArray(rows) ? rows.filter(r => r && typeof r.id === 'string' && r.id) : [];
  const byId = new Map(all.map(r => [r.id, r]));
  let filter = BRANCH_TREE_FILTERS[0];
  const here = all.find(r => r.current);
  let selected = here ? here.id : null;

  const titleId = controlDialogId('branch-tree-title');
  const hintId = controlDialogId('branch-tree-hint');
  const overlay = document.createElement('div');
  overlay.className = 'control-dialog-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'control-dialog branch-tree-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', titleId);
  dialog.setAttribute('aria-describedby', hintId);

  const kicker = document.createElement('div');
  kicker.className = 'control-dialog-kicker';
  kicker.textContent = 'Branch tree';
  const heading = document.createElement('h3');
  heading.id = titleId;
  heading.textContent = 'Switch this session to another point';
  const intro = document.createElement('p');
  intro.textContent = 'Pick a point in the conversation. The session continues from there; nothing is deleted, '
    + 'and the branch you leave stays in the tree.';

  const filters = document.createElement('div');
  filters.className = 'branch-tree-filters';
  const filterButtons = BRANCH_TREE_FILTERS.map((f) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'new-session-secondary-btn branch-tree-filter';
    b.textContent = f.label;
    b.title = f.title;
    b.addEventListener('click', () => { filter = f; render(); list.focus(); });
    filters.appendChild(b);
    return b;
  });

  const list = document.createElement('div');
  list.className = 'branch-tree-list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-labelledby', titleId);
  list.tabIndex = 0;

  const hint = document.createElement('p');
  hint.id = hintId;
  hint.className = 'branch-tree-hint';
  hint.setAttribute('aria-live', 'polite');

  const actions = document.createElement('div');
  actions.className = 'control-dialog-actions';
  const button = (cls, label, title) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    if (title) b.title = title;
    actions.appendChild(b);
    return b;
  };
  const cancelBtn = button('control-dialog-cancel', 'Cancel');
  const summaryBtn = button('control-dialog-secondary', 'Switch with summary',
    'The agent writes a summary of the branch you are leaving and it is put at the new point, so the next turn '
    + 'knows what was tried there. Costs a model call.');
  const switchBtn = button('control-dialog-confirm', 'Switch here');

  dialog.append(kicker, heading, intro, filters, list, hint, actions);
  overlay.appendChild(dialog);

  const visible = () => all.filter(filter.test);

  function describe(row) {
    if (!row) return 'Pick a point to switch to.';
    if (row.current) return 'The session is at this point already.';
    if (row.kind === 'user') {
      return 'The session continues from the point before this message, and the message goes back into the input, '
        + 'to edit and send again.';
    }
    return 'The session continues from this point. The branch you leave stays in the tree.';
  }

  function updateSelection() {
    const row = selected ? byId.get(selected) : null;
    for (const el of list.children) {
      const on = el.dataset.id === selected;
      el.classList.toggle('selected', on);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    const cannot = !row || row.current;
    switchBtn.disabled = cannot;
    summaryBtn.disabled = cannot;
    hint.textContent = describe(row) + (truncated ? ` Only the first ${all.length} entries are shown.` : '');
  }

  function render() {
    filterButtons.forEach((b, i) => {
      const on = BRANCH_TREE_FILTERS[i] === filter;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const shown = visible();
    if (selected && !shown.some(r => r.id === selected)) selected = null;
    list.replaceChildren();
    if (!shown.length) {
      const empty = document.createElement('div');
      empty.className = 'branch-tree-empty';
      empty.textContent = all.length ? 'Nothing in this view.' : 'The session has nothing to switch to yet.';
      list.appendChild(empty);
    }
    for (const row of shown) {
      const el = document.createElement('div');
      el.className = 'branch-tree-row' + (row.onPath ? ' on-path' : '') + (row.current ? ' current' : '');
      el.setAttribute('role', 'option');
      el.dataset.id = row.id;
      el.style.paddingLeft = `${8 + Math.min(Number(row.depth) || 0, BRANCH_TREE_MAX_INDENT) * BRANCH_TREE_INDENT_PX}px`;
      const kind = document.createElement('span');
      kind.className = 'branch-tree-kind branch-tree-kind-' + (BRANCH_TREE_KIND_LABELS[row.kind] ? row.kind : 'other');
      kind.textContent = BRANCH_TREE_KIND_LABELS[row.kind] || BRANCH_TREE_KIND_LABELS.other;
      const text = document.createElement('span');
      text.className = 'branch-tree-text';
      text.textContent = row.text || '—';
      text.title = row.text || '';
      el.append(kind, text);
      if (row.label) {
        const label = document.createElement('span');
        label.className = 'branch-tree-label';
        label.textContent = row.label;
        el.appendChild(label);
      }
      if (row.current) {
        const mark = document.createElement('span');
        mark.className = 'branch-tree-here';
        mark.textContent = 'you are here';
        el.appendChild(mark);
      }
      el.addEventListener('click', () => { selected = row.id; updateSelection(); });
      el.addEventListener('dblclick', () => { selected = row.id; updateSelection(); go(false); });
      list.appendChild(el);
    }
    updateSelection();
    const sel = selected ? list.querySelector(`[data-id="${CSS.escape(selected)}"]`) : null;
    if (sel && typeof sel.scrollIntoView === 'function') sel.scrollIntoView({ block: 'center' });
  }

  function move(delta) {
    const shown = visible();
    if (!shown.length) return;
    const at = shown.findIndex(r => r.id === selected);
    const next = !Number.isFinite(delta) ? (delta > 0 ? shown.length - 1 : 0)
      : at < 0 ? (delta > 0 ? 0 : shown.length - 1)
        : Math.max(0, Math.min(shown.length - 1, at + delta));
    selected = shown[next].id;
    updateSelection();
    const el = list.querySelector(`[data-id="${CSS.escape(selected)}"]`);
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }

  const releaseFocus = trapControlDialogFocus(overlay, dialog);
  function close() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    releaseFocus();
  }

  function go(summarize) {
    const row = selected ? byId.get(selected) : null;
    if (!row || row.current) return;
    close();
    if (typeof onSwitch === 'function') onSwitch(row.id, summarize);
  }

  function onKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.target !== list) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
    else if (event.key === 'Home') { event.preventDefault(); move(-Infinity); }
    else if (event.key === 'End') { event.preventDefault(); move(Infinity); }
    else if (event.key === 'Enter') { event.preventDefault(); go(false); }
  }

  cancelBtn.addEventListener('click', close);
  switchBtn.addEventListener('click', () => go(false));
  summaryBtn.addEventListener('click', () => go(true));
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  document.addEventListener('keydown', onKey);

  document.body.appendChild(overlay);
  render();
  list.focus();
  return { close };
}
