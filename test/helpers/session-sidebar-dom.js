'use strict';
// A session sidebar in jsdom (#835, #834): the real lib/sidebar-groups.js, lib/variable-order.js and
// session/session-sidebar.js loaded as index.html loads them, one session mounted with every group open, and the
// renderer API faked. Each read records which group asked, so a test can say what was read.
//
// The Processes group polls on a window timer. `closeSessionSidebarWindows()` closes every window built here, which ends
// the timers; a test file that uses this helper calls it from `after`, or the file never exits.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { SESSION_SIDEBAR_GROUP_NAMES } = require('../../src/renderer/lib/sidebar-groups');

const REN = path.join(__dirname, '..', '..', 'src', 'renderer');
const read = (p) => fs.readFileSync(path.join(REN, p), 'utf8');
const ALL_GROUPS = SESSION_SIDEBAR_GROUP_NAMES.map((g) => g.id);
const windows = [];

/**
 * @param {object} [opts]
 * @param {string[]} [opts.hidden]  the stored `sessionSidebarHidden`
 * @param {boolean} [opts.mergeFails]  `mergeSetting` rejects
 * @param {(ids: string[]) => object} [opts.processUsage]  main's answer to `processUsage`
 * @param {string[]} [opts.openGroups]  the groups the stored state opens (default: all)
 * @param {object|Function} [opts.changesAnswer]  main's answer to `sessionChanges` (a function may return a promise)
 * @param {(id: string) => object} [opts.followAnswer]  main's answer to `sessionChangesFollow`
 * @param {object} [opts.issues]  turns the forge issues on (#882): loads views/tasks-logic.js and fakes `forgeIssuesList`,
 *   `forgeIssuesFollow`, `forgeIssuesUnfollow` and `onForgeIssuesUpdated`; recorded in `calls.issueLists`, `calls.issueFollows`
 *   and fired through `calls.issuesListener`. `issues.list` may be a function (projectPath, query, options) giving the answer.
 */
function setupSessionSidebar({ hidden = [], mergeFails = false, processUsage, openGroups = ALL_GROUPS, changesAnswer, followAnswer, issues } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  windows.push(dom.window);
  const w = dom.window;
  // A window in view: jsdom reports `document.hidden` unless told otherwise. A test of a hidden window redefines it.
  Object.defineProperty(w.document, 'hidden', { configurable: true, get: () => false });
  const calls = { reads: [], merged: [], notified: 0, toasts: [], usage: [], follows: [], followIds: [], summaries: [], subscriptions: 0, changesListener: null, issueLists: [], issueFollows: [], issuesListener: null };
  const reading = (group, answer) => (...a) => { calls.reads.push(group); return Promise.resolve(typeof answer === 'function' ? answer(...a) : answer); };
  const stored = {};   // the settings rows the sidebar writes (the issue filter) and reads back
  w.api = {
    vcsDescribe: reading('repository', { ok: false }),
    taskList: reading('tasks', { tasks: [] }),
    getEffectiveSettings: () => Promise.resolve({}),
    listHandoffs: reading('handoffs', []),
    getSessionInstructions: reading('instructions', { ok: true, groups: [] }),
    getSkills: reading('connectors', { skills: [] }),
    processUsage: reading('processes', (ids) => {
      calls.usage.push(JSON.parse(JSON.stringify(ids)));
      return processUsage ? processUsage(ids) : { ok: true, supported: false, message: 'Not here.' };
    }),
    sessionChanges: reading('changes', changesAnswer || { ok: true, reports: true, state: 'nothing-since-review', request: { range: 'since-review', view: 'all' }, notes: [{ code: 'nothing-since-review' }], actions: {}, files: [], commits: [], blocks: [], figure: null }),
    sessionChangesSummary: (id) => { calls.summaries.push(id); return Promise.resolve({ ok: true, reports: true, figure: { files: 2, commits: 1 } }); },
    sessionChangesView: () => Promise.resolve({ ok: true }),
    sessionChangesClear: () => Promise.resolve({ ok: true }),
    sessionChangesFollow: (id) => { calls.follows.push('follow'); calls.followIds.push(id); return Promise.resolve(followAnswer ? followAnswer(id) : { ok: true }); },
    sessionChangesUnfollow: (id) => { calls.follows.push('unfollow'); calls.followIds.push(id); },
    // The one subscription of the window; a test fires it through `calls.pushChanges`.
    onSessionChangesUpdated: (cb) => { calls.changesListener = cb; calls.subscriptions++; return () => { calls.changesListener = null; }; },
    agent: { servers: () => Promise.resolve(null) },
    ...(issues ? {
      getEffectiveSettings: () => Promise.resolve({ forgeIssuesEnabled: issues.enabled !== false }),
      forgeIssuesList: (projectPath, query, options) => {
        calls.issueLists.push({ projectPath, query: JSON.parse(JSON.stringify(query)), force: !!(options && options.force), background: !!(options && options.background) });
        const answer = typeof issues.list === 'function' ? issues.list(projectPath, query, options) : issues.list;
        if (answer === null) return Promise.resolve(null);   // main declined a background read
        return Promise.resolve(answer || { enabled: true, ok: true, provider: 'GitHub', issues: [{ number: 1, title: 'First', labels: [], author: 'a', state: 'open' }], limit: 100, query, supports: { state: true, assignee: true, author: true }, web: { issues: 'https://example.org/issues', newIssue: 'https://example.org/issues/new' } });
      },
      forgeIssuesFollow: (id, projectPath, query, tier) => { calls.issueFollows.push({ op: 'follow', id, projectPath, query: JSON.parse(JSON.stringify(query)), tier }); return Promise.resolve({ ok: true }); },
      forgeIssuesUnfollow: (id) => { calls.issueFollows.push({ op: 'unfollow', id }); },
      onForgeIssuesUpdated: (cb) => { calls.issuesListener = cb; return () => { calls.issuesListener = null; }; },
    } : {}),
    // Through JSON: a value built in the vm's realm is not deepStrictEqual to one built here.
    getSetting: (key) => Promise.resolve(stored[key]),
    mergeSetting: (key, partial) => { stored[key] = { ...stored[key], ...partial }; calls.merged.push([key, JSON.parse(JSON.stringify(partial))]); return mergeFails ? Promise.reject(new Error('no')) : Promise.resolve(); },
    notifySettingsChanged: () => { calls.notified++; },
  };
  w.showControlToast = (m) => calls.toasts.push(m);
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.localStorage.setItem('sessionSidebar', JSON.stringify({ s1: { open: true, width: 280, groups: openGroups, at: 1 } }));
  const ctx = vm.createContext(w);
  ctx.__hidden = hidden;
  vm.runInContext(`
    var openSessions = new Map();
    var sessionMap = new Map();
    var appGlobalSettings = { sessionSidebarHidden: __hidden };
    var activeSessionId = 's1';
    function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
  `, ctx);
  // A window with the focus, unless a test takes it away (`setFocus`).
  const focus = { on: true };
  w.document.hasFocus = () => focus.on;
  const files = ['lib/sidebar-groups.js', 'lib/session-changes-rows.js', 'lib/variable-order.js', ...(issues ? ['views/tasks-logic.js'] : []), 'session/session-sidebar.js'];
  for (const f of files) vm.runInContext(read(f), ctx);
  const element = w.document.createElement('div');
  element.className = 'terminal-container visible';
  w.document.body.appendChild(element);
  ctx.__entry = { element, session: { sessionId: 's1', projectPath: '/p' } };
  vm.runInContext('openSessions.set("s1", __entry); sessionSidebarMount(__entry);', ctx);
  const root = () => element.querySelector('.session-sidebar');
  const slot = (id) => root().querySelector(`.ssb-slot[data-group-slot="${id}"]`);
  const pop = () => w.document.querySelector('.ssb-groups-pop');
  const item = (id) => pop().querySelector(`[data-group-toggle="${id}"]`);
  const rightClick = (el, init = { clientX: 40, clientY: 50 }) => el.dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, ...init }));
  const setFocus = (on) => { focus.on = on; w.dispatchEvent(new w.Event(on ? 'focus' : 'blur')); };
  return { w, ctx, calls, element, entry: ctx.__entry, root, slot, pop, item, rightClick, setFocus, run: (src) => vm.runInContext(src, ctx) };
}

function closeSessionSidebarWindows() {
  for (const w of windows.splice(0)) w.close();
}

module.exports = { setupSessionSidebar, closeSessionSidebarWindows, ALL_GROUPS };
