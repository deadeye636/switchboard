const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isKeyboardActivation,
  handleKeyboardActivation,
  makeButtonLike,
  ariaButton,
  syncTitleToTooltip,
  syncTitleToAriaLabel,
} = require('../src/renderer/lib/a11y-utils');

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

test('ariaButton sets role/tabIndex/label but binds NO keyboard listener', () => {
  const listeners = {};
  const el = {
    tabIndex: -1,
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name]; },
    addEventListener(name, cb) { listeners[name] = cb; },
  };
  ariaButton(el, 'Open session');
  assert.equal(el.attributes.role, 'button');
  assert.equal(el.attributes['aria-label'], 'Open session');
  assert.equal(el.tabIndex, 0);
  // Unlike makeButtonLike, the click/keyboard activation is delegated — no per-node listener (#218 opt6).
  assert.deepEqual(Object.keys(listeners), []);
});

test('ariaButton does not overwrite an existing aria-label', () => {
  const el = {
    tabIndex: 0,
    attributes: { 'aria-label': 'Already named' },
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name]; },
  };
  ariaButton(el, 'New label');
  assert.equal(el.attributes['aria-label'], 'Already named');
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

test('syncTitleToTooltip mirrors title text into visible tooltip attributes', () => {
  const updates = [];
  const root = {
    querySelectorAll(selector) {
      assert.equal(selector, 'button[title]:not([data-tooltip])');
      return [
        {
          title: 'Fork session',
          setAttribute(name, value) { updates.push([name, value]); },
        },
      ];
    },
  };

  syncTitleToTooltip(root);
  assert.deepEqual(updates, [['data-tooltip', 'Fork session']]);
});
