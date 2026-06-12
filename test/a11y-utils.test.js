const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isKeyboardActivation,
  handleKeyboardActivation,
  makeButtonLike,
  syncTitleToAriaLabel,
} = require('../public/a11y-utils');

function event(key, type) {
  return {
    key,
    type,
    prevented: false,
    preventDefault() { this.prevented = true; },
  };
}

test('isKeyboardActivation matches native button timing', () => {
  assert.equal(isKeyboardActivation(event('Enter', 'keydown')), true);
  assert.equal(isKeyboardActivation(event('Enter', 'keyup')), false);
  assert.equal(isKeyboardActivation(event(' ', 'keydown')), false);
  assert.equal(isKeyboardActivation(event(' ', 'keyup')), true);
  assert.equal(isKeyboardActivation(event('Spacebar', 'keyup')), true);
  assert.equal(isKeyboardActivation(event('Escape', 'keydown')), false);
});

test('handleKeyboardActivation prevents default and invokes callback', () => {
  const e = event('Enter', 'keydown');
  let called = false;
  const handled = handleKeyboardActivation(e, () => { called = true; });

  assert.equal(handled, true);
  assert.equal(called, true);
  assert.equal(e.prevented, true);
});

test('makeButtonLike sets role, tabIndex, and keyboard listener', () => {
  const listeners = {};
  const el = {
    tabIndex: -1,
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name]; },
    addEventListener(name, callback) { listeners[name] = callback; },
  };
  let called = false;

  makeButtonLike(el, () => { called = true; }, 'Open session');
  listeners.keydown(event('Enter', 'keydown'));

  assert.equal(el.attributes.role, 'button');
  assert.equal(el.attributes['aria-label'], 'Open session');
  assert.equal(el.tabIndex, 0);
  assert.equal(called, true);
});

test('syncTitleToAriaLabel names title-only icon buttons', () => {
  const named = [];
  const root = {
    querySelectorAll(selector) {
      assert.equal(selector, 'button[title]:not([aria-label])');
      return [
        { title: 'Stop session', setAttribute(name, value) { named.push([name, value]); } },
      ];
    },
  };

  syncTitleToAriaLabel(root);
  assert.deepEqual(named, [['aria-label', 'Stop session']]);
});
