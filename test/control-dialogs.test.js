const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeControlDialogOptions,
  controlDialogToneClass,
  formatControlDialogDetails,
} = require('../public/control-dialogs');

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
