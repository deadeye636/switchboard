'use strict';
// The terminal-header toolbar and the panes tools both carry "View timeline" next to "View messages".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', p), 'utf8');

test('toolbar timeline button sits directly left of the messages button', () => {
  const html = read('index.html');
  const t = html.indexOf('id="terminal-timeline-btn"');
  const m = html.indexOf('id="terminal-messages-btn"');
  assert.ok(t > 0 && t < m);
  assert.match(html.slice(t, m), /title="View timeline" aria-label="View timeline"/);
});

test('the timeline button shares the messages button styling rules', () => {
  const css = read('style.css');
  assert.equal(css.split('#terminal-timeline-btn').length, css.split('#terminal-messages-btn').length);
});

test('handlers open the timeline viewer for the session', () => {
  assert.match(read('app.js'), /terminal-timeline-btn[\s\S]{0,300}showTimelineViewer\(s\)/);
  assert.match(read('views/panes-view.js'), /btn\('View timeline'[\s\S]{0,400}showTimelineViewer\(session\)/);
});
