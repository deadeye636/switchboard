// renderer-stalls.js — a window's own thread held for long, written to main's log (#707).
//
// `[loop-lag]` in src/perf.js sees only the main process. A renderer drawing a whole conversation can freeze
// its window for a second while main stays on time, and the log then says nothing about the freeze the user
// saw. `src/renderer/shell/stall-report.js` observes the window's long tasks and sends the ones worth a line
// here, with the breadcrumbs that started inside them. This module only validates and logs: the renderer is
// not trusted to write the log itself, so every field is checked and capped before it reaches a line.
'use strict';

let ctx = null;

function init(context) {
  ctx = context;
}

const MAX_LABELS = 8;
const MAX_LABEL = 80;
const MAX_MS = 600_000;
// A renderer that reported in a loop would flood the log; a real stall is rare, so one line per window per
// this long loses nothing worth reading.
const MIN_GAP_MS = 2000;
const lastBySender = new WeakMap();

/** The log line for one report, or null for a report that is not one. Exported for the test. */
function stallLine(report, windowLabel) {
  if (!report || typeof report !== 'object') return null;
  const raw = Number(report.ms);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const ms = Math.min(raw, MAX_MS);
  const work = (Array.isArray(report.work) ? report.work : [])
    .filter(l => typeof l === 'string' && l)
    .slice(-MAX_LABELS)
    // Every control character, not only line breaks: an escape sequence or a separator would reach the file.
    .map(l => l.slice(0, MAX_LABEL).replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, ' '));
  const where = `${windowLabel}${report.hidden === true ? ' (hidden)' : ''}`;
  return `[renderer-stall] ${where} window blocked ~${Math.round(ms)}ms; work started in that task: ${work.length ? work.join(', ') : 'nothing noted'}`;
}

function windowLabelOf(sender) {
  const main = ctx && typeof ctx.getMainWindow === 'function' ? ctx.getMainWindow() : null;
  if (main && !main.isDestroyed() && main.webContents === sender) return 'main';
  return 'detached';
}

function registerIpc(ipc) {
  ipc.on('renderer-stall', (event, report) => {
    const sender = event && event.sender;
    const line = stallLine(report, windowLabelOf(sender));
    if (!line || !ctx || !ctx.log) return;
    if (sender && typeof sender === 'object') {
      const now = Date.now();
      if (now - (lastBySender.get(sender) || 0) < MIN_GAP_MS) return;
      lastBySender.set(sender, now);
    }
    ctx.log.info(line);
  });
}

module.exports = { init, registerIpc, stallLine };
