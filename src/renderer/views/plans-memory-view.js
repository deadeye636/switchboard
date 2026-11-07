// --- Plans viewer ---
// Depends on globals: cachedPlans, plansContent, planPanel, planViewer,
// placeholder, terminalArea, statsViewer, jsonlViewer, timelineViewer (app.js)
// Depends on: formatDate (utils.js)
//
// Instruction files, memory and work files used to be listed here too (the Agent Files tab). They live
// in Settings -> Instructions now (#823, spec 44); this file is Plans only.

let currentPlanContent = "";
let currentPlanFilePath = "";
let currentPlanFilename = "";

// --- Plans ---
let plansHasStore = true; // whether any launchable backend declares a plans dir at all (#227)
let plansUnfulfilled = [];  // { projectPath, backendId, dir, reason } — asked for, nothing there (#450)
async function loadPlans() {
  const res = await window.api.getPlans();
  // #227: get-plans returns { plans, hasStore } — plans span every backend's plans dir, not just Claude's.
  cachedPlans = (res && res.plans) || [];
  plansHasStore = !res || res.hasStore !== false;
  // #450: directories a project asked its CLI to use, that have no plans in them. Claude refuses a
  // plansDirectory outside the project root, one reached through a link, and one whose real path
  // disagrees — each silently. The list is the only place that can notice.
  plansUnfulfilled = (res && res.unfulfilled) || [];
  renderPlans();
  // …and then the query again, if one is live. A reload renders the WHOLE list, so a plan written while
  // someone is searching used to replace their results with everything — and now that a group starts
  // collapsed, it would put their matches out of sight as well. Only while this tab is the one on
  // screen: the search box belongs to whichever tab is showing, and re-running it from here for any
  // other tab would search THAT tab's query. Guarded because this file is loaded by pages that have no
  // search bar at all.
  if (typeof activeTab !== 'undefined' && activeTab === 'plans'
      && typeof reapplyActiveSearch === 'function') reapplyActiveSearch();
}

// The list follows the directory (#452). Reloading only when the tab is on screen: a rebuild costs a read
// of every plan file, and doing that for a panel nobody is looking at buys a list that is refreshed again
// the moment the tab comes back anyway.
//
// Guarded because this file is loaded by pages that have no plans list at all.
if (window.api && typeof window.api.onPlansChanged === 'function') {
  window.api.onPlansChanged(() => {
    const listVisible = plansContent && plansContent.style.display !== 'none';
    const planViewVisible = planViewer && planViewer.style.display !== 'none';
    if (listVisible || planViewVisible) loadPlans();
  });
}

function renderUnfulfilled() {
  // What a project asked for and did not get (#450). Claude declines a plans directory outside the
  // project root, one reached through a link and one whose real path disagrees — each of them silently,
  // so the list is the only place that can notice.
  for (const miss of plansUnfulfilled) {
    const note = document.createElement('div');
    note.className = 'plans-empty plan-unfulfilled';
    note.textContent = miss.reason === 'not created yet'
      ? `${miss.dir} is configured for plans but does not exist yet.`
      : miss.reason === 'outside the project'
        ? `${miss.dir} is configured for plans but sits outside the project — the CLI refuses that and uses its own.`
        : `${miss.dir} is configured for plans and holds none. If plans keep arriving elsewhere, the CLI declined the path.`;
    note.title = miss.projectPath;
    plansContent.appendChild(note);
  }
}

function renderPlans(plans) {
  // A list that is not THE list is a narrowed one: search-bar.js hands over a filtered copy while a
  // query is live and `cachedPlans` itself otherwise. That is what decides whether a group may stay
  // collapsed — a match inside a collapsed group is a match the search appears not to have found.
  const filtering = !!plans && plans !== cachedPlans;
  plans = plans || cachedPlans;
  plansContent.innerHTML = '';
  // BEFORE the empty branch, not after: a configured directory with nothing in it is exactly the case
  // where the list is empty, and a notice that only appears when there are already plans would never be
  // seen by the person who needs it.
  renderUnfulfilled();
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
    plansContent.appendChild(buildPlanGroup(group, filtering));
  }
}

// Which groups the user has opened, for as long as this window lives. Deliberately not persisted: the
// state is "where I am right now", and a project left open three days ago is not that.
const planCollapsedState = new Map();

function buildPlanGroup(group, filtering) {
  const block = document.createElement('div');
  block.className = 'project-group plan-group';
  // Collapsed until opened. The list answers "which projects have plans"
  // first; a project with forty plans otherwise buried every project under it.
  const stored = planCollapsedState.get(group.key);
  const isCollapsed = !filtering && stored !== false;
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

  // Which directory these came from, when the project keeps them itself (#454). Without it two groups
  // under one project name read as a duplicate rather than as two different places.
  const sourceDir = window.planGroupSource(group);
  if (sourceDir) {
    const src = document.createElement('span');
    src.className = 'memory-resource-backend plan-group-source';
    src.textContent = sourceDir;
    header.appendChild(src);
  }

  const count = document.createElement('span');
  count.className = 'memory-file-count';
  count.textContent = group.plans.length;
  header.appendChild(count);

  header.addEventListener('click', () => {
    const nowCollapsed = !block.classList.contains('collapsed');
    block.classList.toggle('collapsed');
    // The state is what the user chose about the FULL list, so a click while a search is narrowing it
    // closes the group and nothing more. Recording it would answer "where did I leave this open" with
    // something done to a list of three matches, and the group would still be shut once the query went.
    if (!filtering) planCollapsedState.set(group.key, nowCollapsed);
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
  // Selection key for openPlan's active marking (data-attribute technique — text
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
 * This view is steered from the sidebar and a detached window has none, so a view pushed to
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
  // Mark active in sidebar (data attribute)
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

// --- The command-palette route to a plan (#486) ----------------------------------------------------
//
// The mirror image of `handoff.create`, and deliberately far smaller than it. A handoff is produced,
// reviewed and written BY the app; a plan is the agent's own document — `docs/plans-convention.md` says
// the app reads plans and never writes one, and that stays true here. So this types a prompt and stops.
//
// Nothing has to poll for an answer, and nothing has to be saved: the plan directories are watched
// (`src/app/plans-memory.js`), so a plan the agent just wrote shows up in the list on its own.
//
// Reaches at parse time: registerCommandAction (shell/command-actions.js).
// Reaches at call time: focusedActionSession, activePtyIds, seedSessionWhenReady (app.js), getBackend
// (backends/backend-registry.js), sessionBackendId, cleanDisplayName, showControlToast, and from
// session/session-health.js: resolvePlanPrompt, withDirHint, fillPromptTemplate.

// The prompt this session gets, with the project's plan directory in it. Split out from the action so
// the wiring is readable: resolve the backend's prompt, tell a slash command where the plan belongs,
// then substitute — the same three steps, in the same order, as the handoff routes.
async function buildPlanPrompt(session) {
  const g = (await window.api.getSetting('global')) || {};
  const backendId = (typeof sessionBackendId === 'function' ? sessionBackendId(session) : null) || '';
  const backend = (typeof getBackend === 'function' ? getBackend(backendId) : null) || { id: backendId };

  let dirs = {};
  if (session.projectPath) {
    try {
      const answer = await window.api.projectConventionDirs(session.projectPath);
      if (answer && typeof answer === 'object') dirs = answer;
    } catch { dirs = {}; }
  }

  return {
    backend,
    text: fillPromptTemplate(
      withDirHint(resolvePlanPrompt(backend, g), dirs, 'plan'),
      { ...session, ...dirs },
    ),
  };
}

// Can this session be asked anything at all? A prompt goes into a RUNNING agent: `focusedActionSession`
// resolves through `sessionMap`, which holds sessions whose CLI has exited and, in panes mode, dormant
// ones that were never mounted. `seedSessionWhenReady` returns silently for those — so without this the
// palette would report "asked the agent" over a session that was never typed into.
//
// A plain terminal is excluded for the same reason the handoff flow excludes it: a shell is not an agent,
// and a plan prompt pasted into one is a command it will try to run.
function canBeAskedForPlan(session) {
  if (!session || !session.sessionId) return false;
  if (session.type === 'terminal') return false;
  return typeof activePtyIds !== 'undefined' && activePtyIds.has(session.sessionId);
}

async function startPlanForSession(session) {
  if (!canBeAskedForPlan(session)) return;
  const { backend, text } = await buildPlanPrompt(session);

  // The same seeding primitive the handoff uses: it waits for the CLI to fall quiet rather than for a
  // fixed delay, and it submits with a carriage return. `graceMs` is the backend's own floor — a CLI
  // that is still importing cannot hear a prompt, and one pasted into it is simply gone.
  seedSessionWhenReady(session.sessionId, text, {
    graceMs: (backend && backend.seedGraceMs) || 0,
    timelineLabel: 'Plan requested',
    timelineNote: 'Asked the agent to write a plan before implementing.',
  });
  if (typeof showControlToast === 'function') {
    showControlToast({ message: 'Asked the agent for a plan — it appears in Plans once written.' });
  }
}

// Guarded the way sidebar-collapse.js and grid-view.js guard theirs: this file is loaded on its own by
// several test harnesses, and a bare call at parse time takes the whole file down where the registry is
// not in scope.
if (typeof registerCommandAction === 'function') registerCommandAction({
  id: 'plan.create',
  // It NAMES the session, for the reason handoff.create does: the action follows the app's focus, which
  // can be a session whose terminal is not the thing on screen.
  title: () => {
    const session = typeof focusedActionSession === 'function' ? focusedActionSession() : null;
    const name = session
      ? (cleanDisplayName(session.name || session.aiTitle || session.summary) || session.sessionId)
      : '';
    return name ? `Write a plan for “${name}”` : 'Write a plan';
  },
  group: 'Plan',
  keywords: 'plan design approach steps before implementing write plan',
  // Offered when it applies, absent when it does not — and "applies" means a running agent, not merely a
  // session in the list.
  available: () => canBeAskedForPlan(typeof focusedActionSession === 'function' ? focusedActionSession() : null),
  run: () => {
    // Asked again rather than closed over: the palette may have been open while the session ended.
    const session = typeof focusedActionSession === 'function' ? focusedActionSession() : null;
    if (session) return startPlanForSession(session);
  },
});
