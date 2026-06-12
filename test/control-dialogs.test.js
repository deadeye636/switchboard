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
  assert.equal(options.tone, 'default');
  assert.deepEqual(options.details, []);
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
