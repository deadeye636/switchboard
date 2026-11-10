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
 */
function setupSessionSidebar({ hidden = [], mergeFails = false, processUsage } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  windows.push(dom.window);
  const w = dom.window;
  // A window in view: jsdom reports `document.hidden` unless told otherwise. A test of a hidden window redefines it.
  Object.defineProperty(w.document, 'hidden', { configurable: true, get: () => false });
  const calls = { reads: [], merged: [], notified: 0, toasts: [], usage: [] };
  const reading = (group, answer) => (...a) => { calls.reads.push(group); return Promise.resolve(typeof answer === 'function' ? answer(...a) : answer); };
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
    agent: { servers: () => Promise.resolve(null) },
    // Through JSON: a value built in the vm's realm is not deepStrictEqual to one built here.
    mergeSetting: (key, partial) => { calls.merged.push([key, JSON.parse(JSON.stringify(partial))]); return mergeFails ? Promise.reject(new Error('no')) : Promise.resolve(); },
    notifySettingsChanged: () => { calls.notified++; },
  };
  w.showControlToast = (m) => calls.toasts.push(m);
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.localStorage.setItem('sessionSidebar', JSON.stringify({ s1: { open: true, width: 280, groups: ALL_GROUPS, at: 1 } }));
  const ctx = vm.createContext(w);
  ctx.__hidden = hidden;
  vm.runInContext(`
    var openSessions = new Map();
    var sessionMap = new Map();
    var appGlobalSettings = { sessionSidebarHidden: __hidden };
    function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
  `, ctx);
  for (const f of ['lib/sidebar-groups.js', 'lib/variable-order.js', 'session/session-sidebar.js']) vm.runInContext(read(f), ctx);
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
  return { w, ctx, calls, element, entry: ctx.__entry, root, slot, pop, item, rightClick, run: (src) => vm.runInContext(src, ctx) };
}

function closeSessionSidebarWindows() {
  for (const w of windows.splice(0)) w.close();
}

module.exports = { setupSessionSidebar, closeSessionSidebarWindows, ALL_GROUPS };
