const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeControlDialogOptions,
  controlDialogToneClass,
  controlDialogConfirmText,
  formatControlDialogDetails,
} = require('../src/renderer/dialogs/control-dialogs');

test('normalizeControlDialogOptions applies safe defaults', () => {
  const options = normalizeControlDialogOptions({ title: 'Stop session' });

  assert.equal(options.title, 'Stop session');
  assert.equal(options.message, '');
  assert.equal(options.confirmLabel, 'Confirm');
  assert.equal(options.cancelLabel, 'Cancel');
  assert.equal(options.secondaryLabel, '');
  assert.equal(options.tone, 'default');
  assert.deepEqual(options.details, []);
});

test('normalizeControlDialogOptions accepts an optional secondary action label', () => {
  const options = normalizeControlDialogOptions({
    title: 'Create handoff',
    secondaryLabel: 'Ask Session',
  });

  assert.equal(options.secondaryLabel, 'Ask Session');
});

test('controlDialogToneClass only allows known tones', () => {
  assert.equal(controlDialogToneClass('danger'), 'control-dialog-danger');
  assert.equal(controlDialogToneClass('warning'), 'control-dialog-warning');
  assert.equal(controlDialogToneClass('success'), 'control-dialog-success');
  assert.equal(controlDialogToneClass('unknown'), 'control-dialog-default');
});

test('formatControlDialogDetails drops empty values and formats labels', () => {
  const details = formatControlDialogDetails({
    Project: 'switchboard',
    Sessions: 3,
    Empty: '',
    Missing: null,
  });

  assert.deepEqual(details, [
    { label: 'Project', value: 'switchboard' },
    { label: 'Sessions', value: '3' },
  ]);
});

// A dialog that holds WORK must not be dismissible by a stray click or a reflexive Escape.
//
// Every other overlay in the app is a question — closing one costs nothing. The handoff REVIEW dialog
// holds the packet an agent just spent minutes and tokens writing, and it cannot be recovered: the
// session may already have been stopped again, and the producer will not write the same summary twice.
// Reported from the field: a click in the empty area next to it threw the packet away.
test('a dialog is dismissible by default — a question costs nothing to close', () => {
  assert.equal(normalizeControlDialogOptions({}).dismissible, true);
  assert.equal(normalizeControlDialogOptions({ dismissible: true }).dismissible, true);
});

test('...and can opt out, for the ones where closing destroys something', () => {
  assert.equal(normalizeControlDialogOptions({ dismissible: false }).dismissible, false);
});

test('only an explicit `false` opts out — a missing flag must not silently trap the user', () => {
  for (const value of [undefined, null, 0, '']) {
    assert.equal(normalizeControlDialogOptions({ dismissible: value }).dismissible, true,
      `dismissible: ${JSON.stringify(value)} must not be read as "no way out"`);
  }
});

// --- The opt-in checkbox (#251) ---
//
// Archive-all used to stop every running session with no way out. The checkbox is how the user keeps
// live work alive, so it has to default to OFF and only appear where a caller asked for it.
test('no checkbox unless a caller asks for one', () => {
  assert.equal(normalizeControlDialogOptions({}).checkbox, null);
  assert.equal(normalizeControlDialogOptions({ checkbox: {} }).checkbox, null);
  assert.equal(normalizeControlDialogOptions({ checkbox: { checked: true } }).checkbox, null,
    'a checkbox with no label has nothing to say — it must not render');
});

test('a checkbox is unchecked unless the caller says otherwise', () => {
  assert.deepEqual(normalizeControlDialogOptions({ checkbox: { label: 'Include running' } }).checkbox,
    { label: 'Include running', checked: false });
  assert.deepEqual(normalizeControlDialogOptions({ checkbox: { label: 'Include running', checked: true } }).checkbox,
    { label: 'Include running', checked: true });
});

// A checkbox that changes what the action covers changes the number the button names, so the label
// follows the state instead of freezing at the count it was built with.
test('a function confirmLabel survives normalization and is resolved per checkbox state', () => {
  const options = normalizeControlDialogOptions({
    checkbox: { label: 'Include running' },
    confirmLabel: withRunning => `Archive ${withRunning ? 94 : 93} Sessions`,
  });

  assert.equal(typeof options.confirmLabel, 'function');
  assert.equal(controlDialogConfirmText(options, false), 'Archive 93 Sessions');
  assert.equal(controlDialogConfirmText(options, true), 'Archive 94 Sessions');
});

test('a string confirmLabel is unaffected by the checkbox state', () => {
  const options = normalizeControlDialogOptions({ confirmLabel: 'Archive' });
  assert.equal(controlDialogConfirmText(options, false), 'Archive');
  assert.equal(controlDialogConfirmText(options, true), 'Archive');
});

// The archive dialog names its subagent share so its count can be reconciled with the sidebar, which
// counts render items — but a project without subagents must not gain a "Subagents 0" row (#250).
test('an undefined detail value drops out, so an optional row can be omitted by passing nothing', () => {
  assert.deepEqual(formatControlDialogDetails({ Sessions: 94, Subagents: 0 || undefined, Running: 0 }), [
    { label: 'Sessions', value: '94' },
    { label: 'Running', value: '0' },
  ]);
  assert.deepEqual(formatControlDialogDetails({ Sessions: 94, Subagents: 84 || undefined }), [
    { label: 'Sessions', value: '94' },
    { label: 'Subagents', value: '84' },
  ]);
});
