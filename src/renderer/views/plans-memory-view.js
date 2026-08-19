// --- Plans & Memory viewers ---
// Depends on globals: cachedPlans, plansContent, planPanel, planViewer,
// memoryContent, memoryPanel, memoryViewer, placeholder, terminalArea,
// statsViewer, jsonlViewer, timelineViewer (app.js)
// Depends on: formatDate (utils.js)

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
  for (const plan of plans) {
    plansContent.appendChild(buildPlanItem(plan));
  }
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
  header.appendChild(memoryBackendBadge(rg.backendId));

  const backendSpan = document.createElement('span');
  backendSpan.className = 'memory-resource-backend';
  backendSpan.textContent = rg.backendLabel;
  header.appendChild(backendSpan);

  const count = document.createElement('span');
  count.className = 'memory-file-count';
  count.textContent = rg.files.length;
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

  item.addEventListener('click', async () => {
    if (await routeFileToViewWindow('memory', file, file.filename || 'File')) return;
    openMemory(file);
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

let cachedWorkFilesData = [];          // WorkFilesProject[]
let currentWorkFilePath = null;
let currentWorkFileContent = '';
const workFilesCollapsedState = new Map();

async function loadWorkFiles() {
  const result = await window.api.getWorkFiles();
  cachedWorkFilesData = result.projects || [];
  renderWorkFiles();
}

// Remove a single deleted file from the in-memory model and re-render.
// Avoids re-running the (sometimes slow) full disk scan in get-work-files.
function removeWorkFileFromCache(filePath) {
  for (const proj of cachedWorkFilesData) {
    const idx = proj.files.findIndex(f => f.filePath === filePath);
    if (idx !== -1) {
      proj.files.splice(idx, 1);
      if (typeof proj.totalCount === 'number') proj.totalCount = Math.max(0, proj.totalCount - 1);
      break;
    }
  }
  // Drop projects that no longer have files
  cachedWorkFilesData = cachedWorkFilesData.filter(p => p.files.length > 0);
  renderWorkFiles();
}

function renderWorkFiles(filterIds) {
  workFilesContent.innerHTML = '';
  if (cachedWorkFilesData.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'plans-empty';
    empty.textContent = 'No .work-files/ directories found in any project.';
    workFilesContent.appendChild(empty);
    return;
  }

  for (const proj of cachedWorkFilesData) {
    const projFiles = filterIds
      ? proj.files.filter(f => filterIds.has(f.filePath))
      : proj.files;
    if (projFiles.length === 0) continue;
    workFilesContent.appendChild(buildWorkFilesGroup(proj, projFiles));
  }
}

function buildWorkFilesGroup(proj, files) {
  const group = document.createElement('div');
  group.className = 'project-group';
  const isCollapsed = workFilesCollapsedState.get(proj.projectPath) === true;
  if (isCollapsed) group.classList.add('collapsed');

  const header = document.createElement('div');
  header.className = 'project-header';

  const arrow = document.createElement('span');
  arrow.className = 'arrow';
  arrow.innerHTML = '&#9660;';
  header.appendChild(arrow);

  const nameSpan = document.createElement('span');
  nameSpan.className = 'project-name';
  nameSpan.textContent = projectDisplayLabel(proj.displayName, proj.shortName);
  header.appendChild(nameSpan);

  const countBadge = document.createElement('span');
  countBadge.className = 'memory-file-count';
  if (proj.totalCount > files.length) {
    countBadge.textContent = files.length + '/' + proj.totalCount;
    countBadge.title = 'Showing ' + files.length + ' of ' + proj.totalCount + ' files (capped at 200)';
  } else {
    countBadge.textContent = files.length;
  }
  header.appendChild(countBadge);

  header.addEventListener('click', () => {
    const nowCollapsed = !group.classList.contains('collapsed');
    group.classList.toggle('collapsed');
    workFilesCollapsedState.set(proj.projectPath, nowCollapsed);
  });

  group.appendChild(header);

  const filesList = document.createElement('div');
  filesList.className = 'project-sessions';
  for (const file of files) {
    filesList.appendChild(buildWorkFileItem(file));
  }
  group.appendChild(filesList);

  return group;
}

function buildWorkFileItem(file) {
  const item = document.createElement('div');
  item.className = 'session-item work-file-item';
  item.dataset.filepath = file.filePath;

  const row = document.createElement('div');
  row.className = 'session-row';

  const icon = document.createElement('span');
  icon.className = 'work-file-icon';
  icon.innerHTML = ICONS.workFiles(15);
  row.appendChild(icon);

  const info = document.createElement('div');
  info.className = 'session-info';

  const titleEl = document.createElement('div');
  titleEl.className = 'session-summary';
  titleEl.textContent = file.filename;

  const pathEl = document.createElement('div');
  pathEl.className = 'session-id';
  pathEl.textContent = file.relativePath;

  const metaEl = document.createElement('div');
  metaEl.className = 'session-meta';
  metaEl.textContent = formatDate(new Date(file.modified));

  info.appendChild(titleEl);
  info.appendChild(pathEl);
  info.appendChild(metaEl);
  row.appendChild(info);
  item.appendChild(row);

  item.addEventListener('click', async () => {
    if (await routeFileToViewWindow('workFiles', file, file.filename || 'File')) return;
    openWorkFile(file);
  });
  return item;
}

async function openWorkFile(file) {
  workFilesContent.querySelectorAll('.work-file-item.active').forEach(el => el.classList.remove('active'));
  const target = workFilesContent.querySelector(`.work-file-item[data-filepath="${CSS.escape(file.filePath)}"]`);
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
