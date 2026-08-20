// --- Plans & Agent Files viewers ---
// Depends on globals: cachedPlans, plansContent, planPanel, planViewer,
// memoryContent, memoryPanel, memoryViewer, workFilesPanel, workFilesViewer,
// placeholder, terminalArea, statsViewer, jsonlViewer, timelineViewer (app.js)
// Depends on: formatDate (utils.js)
//
// Work files have no list of their own since #448 — they arrive with `get-memories` as one group per
// project and are drawn by the Agent Files renderer below. What stayed separate is the VIEWER: a work
// file opens in `workFilesPanel`, which is the panel that can delete. That is not a leftover, it is how
// the delete button stays bound to the one type that has it instead of becoming a property of the list.

let currentPlanContent = "";
let currentPlanFilePath = "";
let currentPlanFilename = "";
let cachedMemoryData = { global: { files: [] }, projects: [] };
let currentMemoryFilePath = null;
let currentMemoryContent = "";
const memoryCollapsedState = new Map();

// --- Plans ---
let plansHasStore = true; // whether any launchable backend declares a plans dir at all (#227)
async function loadPlans() {
  const res = await window.api.getPlans();
  // #227: get-plans returns { plans, hasStore } — plans span every backend's plans dir, not just Claude's.
  cachedPlans = (res && res.plans) || [];
  plansHasStore = !res || res.hasStore !== false;
  renderPlans();
}

function renderPlans(plans) {
  plans = plans || cachedPlans;
  plansContent.innerHTML = '';
  if (plans.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'plans-empty';
    empty.textContent = plansHasStore ? 'No plans found.' : 'No backend provides a plans store.';
    plansContent.appendChild(empty);
    return;
  }
  // Grouped by project (#449). A plan's project comes from the session that wrote it, so the group is a
  // fact about the plan rather than a folder it happens to sit in — every plan still lives in the same
  // flat directory on disk.
  for (const group of window.planGroups(plans)) {
    plansContent.appendChild(buildPlanGroup(group));
  }
}

const planCollapsedState = new Map();

function buildPlanGroup(group) {
  const block = document.createElement('div');
  block.className = 'project-group plan-group';
  const isCollapsed = planCollapsedState.get(group.key) === true;
  if (isCollapsed) block.classList.add('collapsed');

  const header = document.createElement('div');
  header.className = 'project-header';

  const arrow = document.createElement('span');
  arrow.className = 'arrow';
  arrow.innerHTML = '&#9660;';
  header.appendChild(arrow);

  const nameSpan = document.createElement('span');
  nameSpan.className = 'project-name';
  nameSpan.textContent = window.planGroupLabel(group);
  // The plans with no project are not an error state, and the header says why rather than shrugging.
  if (!group.projectPath) {
    nameSpan.classList.add('plan-group-orphans');
    header.title = 'The session that wrote these plans is no longer on disk, so there is nothing left to '
      + 'attribute them to.';
  } else {
    header.title = group.projectPath;
  }
  header.appendChild(nameSpan);

  const count = document.createElement('span');
  count.className = 'memory-file-count';
  count.textContent = group.plans.length;
  header.appendChild(count);

  header.addEventListener('click', () => {
    const nowCollapsed = !block.classList.contains('collapsed');
    block.classList.toggle('collapsed');
    planCollapsedState.set(group.key, nowCollapsed);
  });
  block.appendChild(header);

  const list = document.createElement('div');
  list.className = 'project-sessions';
  for (const plan of group.plans) list.appendChild(buildPlanItem(plan));
  block.appendChild(list);

  return block;
}

function buildPlanItem(plan) {
  const item = document.createElement('div');
  item.className = 'session-item plan-item';
  // Selection key for openPlan's active marking (same data-attribute technique as the memory list — text
  // comparison broke with same-named files, #79). filePath, not filename: plans span every backend's plans
  // dir now (#227), so a bare filename is no longer unique.
  item.dataset.filepath = plan.filePath;

  const row = document.createElement('div');
  row.className = 'session-row';

  const info = document.createElement('div');
  info.className = 'session-info';

  const titleEl = document.createElement('div');
  titleEl.className = 'session-summary';
  titleEl.textContent = plan.title;

  const filenameEl = document.createElement('div');
  filenameEl.className = 'session-id';
  filenameEl.textContent = plan.filename;

  const metaEl = document.createElement('div');
  metaEl.className = 'session-meta';
  metaEl.textContent = formatDate(new Date(plan.modified));

  info.appendChild(titleEl);
  info.appendChild(filenameEl);
  info.appendChild(metaEl);
  row.appendChild(info);
  item.appendChild(row);

  item.addEventListener('click', async () => {
    if (await routeFileToViewWindow('plan', plan, plan.title || plan.filename || 'Plan')) return;
    openPlan(plan);
  });
  return item;
}

/**
 * Which file one of these views is currently showing (#364), as the payload its opener takes.
 *
 * A view moved to another window arrives empty otherwise: the move carries the KIND, and a singleton
 * kind has no ref to carry the file in. So the mover asks here and the file travels with it — the
 * same shape `route-view-file` delivers, so the receiving side has one path, not two.
 *
 * Null when nothing is open, which is a real state: a view can be moved before a file was ever picked.
 */
function currentViewFilePayload(kind) {
  if (kind === 'memory') return currentMemoryFilePath ? { filePath: currentMemoryFilePath } : null;
  if (kind === 'workFiles') return currentWorkFilePath ? { filePath: currentWorkFilePath } : null;
  if (kind === 'plan') {
    return currentPlanFilePath
      ? { filePath: currentPlanFilePath, filename: currentPlanFilename, title: currentPlanFilename }
      : null;
  }
  return null;
}

/**
 * Where does a file picked in the sidebar go (#364)?
 *
 * These three views are steered from the sidebar and a detached window has none, so a view pushed to
 * another window is driven from here. Main answers whether it lives elsewhere; if it does, the file
 * is delivered there and this window says so — a click whose effect happens on another monitor and
 * says nothing reads as a click that did nothing.
 *
 * Answers false when the caller should just do what it always did, which is every case except a view
 * that has actually been moved away. An older main process, a missing binding or a thrown call all
 * land there too: the local path is the one that always works.
 */
async function routeFileToViewWindow(kind, payload, label) {
  if (typeof window.api?.routeViewFile !== 'function') return false;
  let res = null;
  try { res = await window.api.routeViewFile(kind, payload); } catch { return false; }
  if (!res || !res.routed) return false;
  if (typeof showControlToast === 'function') {
    showControlToast({ message: `${label} opened in “${res.windowTitle}”`, timeoutMs: 2500 });
  }
  return true;
}

async function openPlan(plan) {
  // Mark active in sidebar (data attribute, matching openMemory)
  plansContent.querySelectorAll('.plan-item.active').forEach(el => el.classList.remove('active'));
  const target = plansContent.querySelector(`.plan-item[data-filepath="${CSS.escape(plan.filePath)}"]`);
  if (target) target.classList.add('active');

  const result = await window.api.readPlan(plan.filePath);
  currentPlanContent = result.content;
  currentPlanFilePath = result.filePath;
  currentPlanFilename = plan.filename;

  // Hide every other viewer (draining JSONL file-watches) before showing this
  // one — matches the jsonl-viewer opener, so views can't overlap and leftover
  // fs.watchFile polls don't leak (issue #75).
  hideAllViewers();
  placeholder.style.display = 'none';
  terminalArea.style.display = 'none';
  planViewer.style.display = 'flex';

  planPanel.open(plan.title, currentPlanFilePath, currentPlanContent);
  // The file this view shows is part of what main stores about this window (#371), and opening one
  // is not a tab change — so nothing else would say it changed.
  window.panesView?.reportViews?.();
}

function hideAllViewers() {
  planViewer.style.display = 'none';
  statsViewer.style.display = 'none';
  memoryViewer.style.display = 'none';
  workFilesViewer.style.display = 'none';
  if (typeof projectsViewer !== 'undefined' && projectsViewer) projectsViewer.style.display = 'none';
  if (typeof tasksViewer !== 'undefined' && tasksViewer) tasksViewer.style.display = 'none';
  if (typeof bookmarksViewer !== 'undefined' && bookmarksViewer) bookmarksViewer.style.display = 'none';
  jsonlViewer.style.display = 'none';
  timelineViewer.style.display = 'none';
  // The recap overview (#402) is a main-area surface like the rest — left visible it paints over
  // whatever replaced it.
  const awayOverview = document.getElementById('away-overview-viewer');
  if (awayOverview) awayOverview.style.display = 'none';
  terminalArea.style.display = '';
  // Stop any subagent file-watches kept alive by Agent blocks that the user
  // was viewing — without this, fs.watchFile keeps polling indefinitely.
  // `drainViewerWatches` lives in jsonl-viewer.js; we reach it via window
  // because top-level function declarations in classic scripts attach there.
  if (typeof window.drainViewerWatches === 'function') window.drainViewerWatches();
}

function hidePlanViewer() {
  hideAllViewers();
}

// --- Memory ---

async function loadMemories() {
  cachedMemoryData = await window.api.getMemories();
  renderMemories();
}

// The search filter and the type filter are two independent narrowings of one list, so each has to
// survive a change to the other: picking a chip must not drop the query, and searching must not clear
// the chip. `renderMemories(ids)` keeps its old meaning for search-bar.js — pass the matches, or pass
// nothing to clear them — and the chip state lives here.
let memorySearchIds = null;
let memoryTypeFilter = null;
let memoryBackendFilter = null;

function renderMemories(filterIds) {
  memorySearchIds = filterIds || null;
  renderMemoryList();
}

/** The three filters as one value, for views/agent-file-filter.js to answer against. */
function memoryFilters() {
  return { searchIds: memorySearchIds, type: memoryTypeFilter, backend: memoryBackendFilter };
}

function renderMemoryList() {
  memoryContent.innerHTML = '';
  renderMemoryTypeFilters();
  bindMemoryTypeFilters();
  const data = cachedMemoryData;
  // Backend resource groups count as content (#440): a store can hold skills and no loose file, and
  // answering that with "no memory files found" would hide everything the tab just learned about.
  // Build first, count after — `shown` is what SURVIVED the filters, never the size of the raw data.
  // Asking the raw data was the defect: with a filter on and nothing matching, every group below
  // rendered nothing and the panel was left blank, while the "nothing matches" message sat unreachable.
  const { globalFiles, globalGroups, projects: projectSections, shown } =
    window.agentFileSections(data, memoryFilters());

  if (shown === 0) {
    const empty = document.createElement('div');
    empty.className = 'plans-empty';
    empty.textContent = window.agentFileEmptyMessage(memoryFilters());
    memoryContent.appendChild(empty);
    return;
  }

  if (globalFiles.length > 0 || globalGroups.length > 0) {
    memoryContent.appendChild(buildMemoryGroup('__global__', 'Global', globalFiles, globalGroups));
  }
  for (const section of projectSections) {
    memoryContent.appendChild(buildMemoryGroup(
      section.proj.folder,
      projectDisplayLabel(section.proj.displayName, section.proj.shortName),
      section.files, section.groups, section.proj.projectPath));
  }
}

// --- the type chips (#447) -------------------------------------------------------------------------
//
// Types and their labels arrive with the data (`getMemories().types`); this side counts nothing and
// names nothing. A chip whose type has vanished from the data takes the active filter with it, or the
// list would stay filtered by something with no chip left to switch off.
function chipHtml(cls, group, value, label, count, active, iconHtml) {
  return `
    <button type="button" class="project-tag-chip ${cls}${active ? ' active' : ''}"
            data-group="${group}" data-value="${escapeHtml(value)}" aria-pressed="${active}">
      ${iconHtml || ''}${escapeHtml(label)}<span class="agent-type-count">${count}</span>
    </button>`;
}

/**
 * The monogram chip a session row wears (`session-backend-badge`), for one backend id.
 *
 * Built the same way sidebar-session-row.js builds it — same class, same colour lookup — so the two
 * lists cannot drift apart. Every lookup is guarded: the registry answers asynchronously, and a badge
 * without its colour is a smaller loss than a list that throws while rendering.
 */
function memoryBackendBadge(backendId) {
  const descriptor = typeof window.getBackend === 'function' ? window.getBackend(backendId) : null;
  const badge = document.createElement('span');
  badge.className = 'session-backend-badge memory-backend-badge backend-' + backendId;
  badge.textContent = (descriptor && descriptor.monogram)
    || (window.backendMonogram ? window.backendMonogram(backendId) : backendId.slice(0, 2));
  badge.title = descriptor ? descriptor.label : backendId;
  if (window.backendIconColour) {
    badge.style.background = window.backendIconColour((descriptor && descriptor.icon) || backendId);
  }
  return badge;
}

function renderMemoryTypeFilters() {
  const bar = document.getElementById('agent-file-type-filters');
  if (!bar) return;
  const data = cachedMemoryData || {};
  const types = Array.isArray(data.types) ? data.types : [];
  const backendRows = Array.isArray(data.backends) ? data.backends : [];
  // A filter whose chip left the data takes itself with it, or the list stays narrowed by something
  // there is no longer a way to switch off.
  memoryTypeFilter = window.agentFileLiveFilter(memoryTypeFilter, types);
  memoryBackendFilter = window.agentFileLiveFilter(memoryBackendFilter, backendRows);

  // One of a kind is no choice. Each group appears only once there is something to choose between, so
  // a single-backend install never sees a backend row it cannot use.
  const showTypes = types.length > 1;
  const showBackends = backendRows.length > 1;
  if (!showTypes && !showBackends) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }

  const typeChips = showTypes
    ? types.map(t => chipHtml('agent-type-chip', 'type', t.id, t.label, t.count, memoryTypeFilter === t.id)).join('')
    : '';
  // No glyph on a backend chip: for a backend without artwork the badge IS its monogram, so the chip
  // came out reading "H Hermes", "Pi Pi", "Cx Codex". The label alone is what a filter needs; the
  // badge belongs on the row, where it is the only thing saying which CLI reads that file.
  const backendChips = showBackends
    ? backendRows.map(b => chipHtml('agent-backend-chip', 'backend', b.id, b.label, b.count,
      memoryBackendFilter === b.id)).join('')
    : '';
  // The two kinds AND together — "skills, from Pi" — which is the whole reason they share one bar
  // instead of hiding behind a switch. A separator keeps them from reading as one list.
  const separator = (typeChips && backendChips) ? '<span class="agent-chip-separator" aria-hidden="true"></span>' : '';
  const clear = (memoryTypeFilter || memoryBackendFilter)
    ? '<button type="button" class="project-tag-chip agent-type-clear" data-group="clear" data-value="">Show all</button>'
    : '';

  bar.style.display = '';
  bar.innerHTML = typeChips + separator + backendChips + clear;
}

function bindMemoryTypeFilters() {
  const bar = document.getElementById('agent-file-type-filters');
  if (!bar || bar.dataset.bound === '1') return;
  bar.dataset.bound = '1';
  bar.addEventListener('click', (e) => {
    const chip = e.target.closest('.project-tag-chip');
    if (!chip) return;
    const group = chip.dataset.group;
    const value = chip.dataset.value || '';
    // Clicking the active chip again clears it, so a filter can always be undone where it was set.
    if (group === 'clear') { memoryTypeFilter = null; memoryBackendFilter = null; }
    else if (group === 'type') memoryTypeFilter = (memoryTypeFilter === value) ? null : value;
    else if (group === 'backend') memoryBackendFilter = (memoryBackendFilter === value) ? null : value;
    renderMemoryList();
  });
}

/** The bar belongs to one tab; every other tab hides it. Called by the tab switcher. */
function applyAgentFileTypeFilterVisibility(activeTabName) {
  const bar = document.getElementById('agent-file-type-filters');
  if (!bar) return;
  if (activeTabName !== 'memory') { bar.style.display = 'none'; return; }
  renderMemoryTypeFilters();
}

function buildMemoryGroup(key, label, files, resourceGroups = [], projectPath = null) {
  const group = document.createElement('div');
  group.className = 'project-group';
  // Default expanded, and never collapsed while a filter is on — a match hidden inside a collapsed
  // project is a match the filter appears not to have found. The stored state is read, not written,
  // so clearing the filter puts every group back where the user left it.
  const filtering = window.agentFileFiltering(memoryFilters());
  const isCollapsed = !filtering && memoryCollapsedState.get(key) === true;
  if (isCollapsed) group.classList.add('collapsed');

  // Header
  const header = document.createElement('div');
  header.className = 'project-header';

  const arrow = document.createElement('span');
  arrow.className = 'arrow';
  arrow.innerHTML = '&#9660;';
  header.appendChild(arrow);

  const nameSpan = document.createElement('span');
  nameSpan.className = 'project-name';
  nameSpan.textContent = label;
  header.appendChild(nameSpan);

  const countBadge = document.createElement('span');
  countBadge.className = 'memory-file-count';
  countBadge.textContent = files.length + resourceGroups.reduce((n, g) => n + g.files.length, 0);
  header.appendChild(countBadge);

  header.addEventListener('click', () => {
    const nowCollapsed = !group.classList.contains('collapsed');
    group.classList.toggle('collapsed');
    memoryCollapsedState.set(key, nowCollapsed);
  });

  group.appendChild(header);

  // Files list
  const filesList = document.createElement('div');
  filesList.className = 'project-sessions';
  for (const file of files) {
    filesList.appendChild(buildMemoryItem(file));
  }
  // The backend's own customization directories, each collapsible on its own (#440). They sit under the
  // instruction files because that is the reading order: what the agent is told, then what it can do.
  for (const rg of resourceGroups) {
    filesList.appendChild(buildResourceGroup(rg, key, projectPath));
  }
  group.appendChild(filesList);

  return group;
}

// A directory of skills / rules / commands, drawn as a nested collapsible block. Collapsed by default:
// the instruction files are what the tab has always been for, and a store with many skills would
// otherwise push them off the screen.
function buildResourceGroup(rg, parentKey, projectPath) {
  const key = parentKey + '::' + rg.id;
  const block = document.createElement('div');
  block.className = 'project-group memory-resource-group';
  // Collapsed by default, but never while a filter is on: filtering to Skills and being shown one
  // collapsed folder answers the question with the question. The stored state is left alone, so
  // clearing the filter puts everything back the way it was.
  const filtering = window.agentFileFiltering(memoryFilters());
  const isCollapsed = !filtering && memoryCollapsedState.get(key) !== false;
  if (isCollapsed) block.classList.add('collapsed');

  const header = document.createElement('div');
  header.className = 'project-header memory-resource-header';

  const arrow = document.createElement('span');
  arrow.className = 'arrow';
  arrow.innerHTML = '&#9660;';
  header.appendChild(arrow);

  const nameSpan = document.createElement('span');
  nameSpan.className = 'project-name';
  nameSpan.textContent = rg.label;
  header.appendChild(nameSpan);

  // The badge belongs where it DISTINGUISHES. Every row in this group has the same backend, so the
  // badge is stated once, here, instead of repeated down eighty skill rows saying the same thing.
  // A group with no backend at all — `.work-files/` belongs to the project, not to a CLI (#448) — says
  // nothing rather than picking one.
  if (rg.backendId) {
    header.appendChild(memoryBackendBadge(rg.backendId));

    const backendSpan = document.createElement('span');
    backendSpan.className = 'memory-resource-backend';
    backendSpan.textContent = rg.backendLabel;
    header.appendChild(backendSpan);
  } else if (rg.kind === 'work-file') {
    // Every other group opens with a backend monogram; this one has no backend, so that slot would sit
    // empty next to a column of badged headers. The folder glyph the Work Files tab wore fills it.
    const icon = document.createElement('span');
    icon.className = 'work-file-icon';
    icon.innerHTML = ICONS.workFiles(14);
    header.appendChild(icon);
  }

  const count = document.createElement('span');
  count.className = 'memory-file-count';
  // `rg.total` is what the group HOLDS, against what it is allowed to show. Work files are capped at 200
  // and a project can hold tens of thousands, so this badge is the only place the cap is admitted to —
  // without it a truncated list looks like a complete one.
  if (typeof rg.total === 'number' && rg.total > rg.files.length) {
    count.textContent = rg.files.length + '/' + rg.total;
    count.title = 'Showing ' + rg.files.length + ' of ' + rg.total + ' files';
  } else {
    count.textContent = rg.files.length;
  }
  header.appendChild(count);

  header.addEventListener('click', (e) => {
    e.stopPropagation();
    const nowCollapsed = !block.classList.contains('collapsed');
    block.classList.toggle('collapsed');
    memoryCollapsedState.set(key, nowCollapsed);
  });
  block.appendChild(header);

  const list = document.createElement('div');
  list.className = 'project-sessions';
  for (const file of rg.files) {
    list.appendChild(buildMemoryItem({ ...file, backendId: rg.backendId, projectPath }, rg.backendId));
  }
  if (rg.truncated) {
    const note = document.createElement('div');
    note.className = 'plans-empty memory-resource-note';
    note.textContent = 'Only the first entries are shown.';
    list.appendChild(note);
  }
  block.appendChild(list);

  return block;
}

/**
 * One row. `groupBackendId` is the backend its group already names, when it has one.
 *
 * A row in such a group shows no badge: the group said it once and eighty repetitions of the same
 * word are wallpaper. A row that DISAGREES with its group still shows its badges, and then the badge
 * means something again — this one is not what the heading led you to expect.
 */
function buildMemoryItem(file, groupBackendId) {
  const item = document.createElement('div');
  item.className = 'session-item memory-item';
  item.dataset.filepath = file.filePath;

  const row = document.createElement('div');
  row.className = 'session-row';


  // Which CLIs read this file — several, for the ones two backends both declare. The same monogram chip
  // a session row wears. (An inline SVG badge was tried first and stacked one per line, which made
  // every row three times as tall.)
  if (window.agentFileRowShowsBadges(file, groupBackendId)) {
    for (const backendId of file.backendIds) row.appendChild(memoryBackendBadge(backendId));
  }

  const info = document.createElement('div');
  info.className = 'session-info';

  const titleEl = document.createElement('div');
  titleEl.className = 'session-summary';
  titleEl.textContent = file.filename;

  const pathEl = document.createElement('div');
  pathEl.className = 'session-id';
  pathEl.textContent = file.displayPath;

  const metaEl = document.createElement('div');
  metaEl.className = 'session-meta';
  metaEl.textContent = formatDate(new Date(file.modified));

  info.appendChild(titleEl);
  info.appendChild(pathEl);
  info.appendChild(metaEl);
  row.appendChild(info);


  item.appendChild(row);

  // A work file opens in its own viewer, which is the one that can delete (#448). Reading it through
  // the memory reader would fail anyway — that reader only answers for `.md` under a memory root, and a
  // work file is as often a log or a `.jsonl`.
  const isWorkFile = file.kind === 'work-file';
  item.addEventListener('click', async () => {
    const kind = isWorkFile ? 'workFiles' : 'memory';
    if (await routeFileToViewWindow(kind, file, file.filename || 'File')) return;
    if (isWorkFile) openWorkFile(file); else openMemory(file);
  });
  return item;
}

async function openMemory(file) {
  // Mark active in sidebar
  memoryContent.querySelectorAll('.memory-item.active').forEach(el => el.classList.remove('active'));
  const target = memoryContent.querySelector(`.memory-item[data-filepath="${CSS.escape(file.filePath)}"]`);
  if (target) target.classList.add('active');

  // An instruction file is read as memory; a file that came from a backend's resource directory is read
  // through that backend, because the memory reader only answers for `.md` under a memory root (#440).
  let content;
  if (file.backendId) {
    const res = await window.api.backends.readResource(file.backendId, file.filePath, file.projectPath || null);
    if (!res || res.ok === false) {
      // The reason exists — say it, rather than showing an empty editor that looks like an empty file.
      showControlMessage({ title: 'Cannot show this file', message: (res && res.reason) || 'Unknown error', tone: 'warning' });
      return;
    }
    content = res.content;
  } else {
    content = await window.api.readMemory(file.filePath);
  }
  currentMemoryFilePath = file.filePath;
  currentMemoryContent = content;

  // Hide every other viewer (draining JSONL file-watches) before showing this one (issue #75).
  hideAllViewers();
  placeholder.style.display = 'none';
  terminalArea.style.display = 'none';
  memoryViewer.style.display = 'flex';

  memoryPanel.open(file.filename, file.filePath, content);
  window.panesView?.reportViews?.(); // #371 — see openPlan
}

// --- Work Files ---
//
// No list of its own since #448. The rows are built by the Agent Files renderer above, out of the group
// `get-memories` hands over. What lives here is the viewer half: opening one, and taking one out of the
// list after it was deleted.

let currentWorkFilePath = null;
let currentWorkFileContent = '';

/**
 * Take a deleted work file out of the cached payload and redraw.
 *
 * Not a reload: `get-memories` walks every project's `.work-files/` tree, and on a project with tens of
 * thousands of them that walk freezes the UI for as long as it runs. Deleting one file is a change this
 * side can make to its own copy exactly.
 *
 * The group's `total` is decremented with it, or the header would go on claiming a file that is gone —
 * and on a capped project that number is the only thing the user has to go by.
 */
function removeWorkFileFromCache(filePath) {
  for (const scope of [cachedMemoryData.global, ...(cachedMemoryData.projects || [])]) {
    for (const group of (scope && scope.groups) || []) {
      const idx = group.files.findIndex(f => f.filePath === filePath);
      if (idx === -1) continue;
      group.files.splice(idx, 1);
      if (typeof group.total === 'number') group.total = Math.max(0, group.total - 1);
    }
    if (scope && scope.groups) scope.groups = scope.groups.filter(g => g.files.length > 0);
  }
  renderMemoryList();
}

async function openWorkFile(file) {
  // The row lives in the Agent Files list now (#448), and it is a `.memory-item` like every other row
  // there — marking `.work-file-item` here would mark nothing.
  memoryContent.querySelectorAll('.memory-item.active').forEach(el => el.classList.remove('active'));
  const target = memoryContent.querySelector(`.memory-item[data-filepath="${CSS.escape(file.filePath)}"]`);
  if (target) target.classList.add('active');

  const content = await window.api.readWorkFile(file.filePath);
  currentWorkFilePath = file.filePath;
  currentWorkFileContent = content;

  // Hide every other viewer (draining JSONL file-watches) before showing this one (issue #75).
  hideAllViewers();
  placeholder.style.display = 'none';
  terminalArea.style.display = 'none';
  workFilesViewer.style.display = 'flex';

  workFilesPanel.open(file.filename, file.filePath, content);
  window.panesView?.reportViews?.(); // #371 — see openPlan
}
