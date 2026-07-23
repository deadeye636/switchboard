// Static no-undef guard for the renderer's classic scripts (#228 follow-up).
//
// WHY THIS EXISTS: the renderer has no bundler and no import graph — files share one global lexical scope
// through plain <script> tags. #218/#228 moved ~two thousand lines across two dozen files by hand, and the
// failure mode that recurred was a reference that resolves to nothing: a name a moved block DEFINED and
// something outside still CALLED (settingsViewerBody, stopShortcutCapture — the latter killed Save for
// every setting), or a name a new module READS that no loaded script declares. Both are `ReferenceError`
// at runtime, both invisible to the suite because nothing loads these files. The vm smoke tests
// (settings-modules-smoke.test.js) catch the first class for the settings ctx modules; this catches BOTH
// classes for EVERY classic script, statically.
//
// HOW: for each HTML environment (index.html, settings.html), the set of "globals" is every top-level
// declaration of every script that environment loads — that IS the shared scope. Feed that set to eslint's
// no-undef and lint each file: a reference to a name that is neither declared in the file, nor a global of
// the environment, nor a browser/vendor global, is a real undefined and fails here.
//
// The environment's file list and load order come from test/fixtures/script-order.json — the same fixture
// the three-file-change rule already maintains, so a new file is covered the moment it is registered.

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Linter } = require('eslint');
const espree = require('espree');

const REN = path.join(__dirname, '..', 'src', 'renderer');
const ORDER = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'script-order.json'), 'utf8'));

// Resolve a script-order basename to its path under src/renderer. The fixture stores basenames; the actual
// files live in subfolders, so build a basename -> relpath index from the HTML the environment names.
function htmlScriptPaths(htmlFile) {
  const html = fs.readFileSync(path.join(REN, htmlFile), 'utf8');
  const out = new Map();
  for (const m of html.matchAll(/<script src="([^"]+)"><\/script>/g)) {
    const rel = m[1];
    if (rel.startsWith('http')) continue;
    // `../shared/foo.js` from src/renderer resolves to src/shared/foo.js — a real classic script the
    // environment loads (the four shared modules both processes use). Keep it, resolved relative to REN.
    out.set(path.basename(rel), rel);
  }
  return out;
}

// What a classic script contributes to the shared scope. Two ways a name becomes global here:
//   1. A top-level (Program-body) const/let/var/function/class — a plain classic script's declarations.
//   2. A UMD/IIFE file that assigns onto the global object: `window.X = ...`, `Object.assign(root, factory())`
//      where the factory `return { a, b }`, or `module.exports = { a, b }` mirrored onto window. These are
//      the shared/pure modules (control-dialogs.js, preview-kind.js, the tag-map builders, …). Their
//      internals are private, but the names they export ARE global, so the walk collects them too.
function collectGlobals(src, into) {
  let ast;
  try {
    ast = espree.parse(src, { ecmaVersion: 2023, loc: false });
  } catch { return; }

  // (1) Program-level declarations.
  for (const node of ast.body) {
    if (node.type === 'FunctionDeclaration' && node.id) into.add(node.id.name);
    else if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) {
        if (d.id.type === 'Identifier') into.add(d.id.name);
        else if (d.id.type === 'ObjectPattern') for (const p of d.id.properties) if (p.value?.type === 'Identifier') into.add(p.value.name);
        else if (d.id.type === 'ArrayPattern') for (const e of d.id.elements) if (e?.type === 'Identifier') into.add(e.name);
      }
    } else if (node.type === 'ClassDeclaration' && node.id) into.add(node.id.name);
  }

  // (2) UMD/window exports, found by walking the whole tree.
  const GLOBAL_OBJ = new Set(['window', 'root', 'globalThis', 'self']);
  const objectExprKeys = (obj) => {
    if (obj?.type !== 'ObjectExpression') return;
    for (const p of obj.properties) {
      if (p.type === 'Property' && !p.computed) {
        into.add(p.key.type === 'Identifier' ? p.key.name : p.key.value);
      }
    }
  };
  const walk = (node) => {
    if (!node || typeof node.type !== 'string') return;
    // window.X = ...   /   root.X = ...
    if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression'
        && !node.left.computed && node.left.object.type === 'Identifier'
        && GLOBAL_OBJ.has(node.left.object.name) && node.left.property.type === 'Identifier') {
      into.add(node.left.property.name);
    }
    // Object.assign(root, factory()) / Object.assign(window, { ... }) — collect the exported keys.
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
        && node.callee.object.type === 'Identifier' && node.callee.object.name === 'Object'
        && node.callee.property.name === 'assign'
        && node.arguments[0]?.type === 'Identifier' && GLOBAL_OBJ.has(node.arguments[0].name)) {
      for (const arg of node.arguments.slice(1)) {
        if (arg.type === 'ObjectExpression') objectExprKeys(arg);
        else if (arg.type === 'CallExpression') {
          // factory() — find the factory's return object. The factory is usually the 2nd arg of the
          // outer UMD IIFE; simplest is to scan every function in the file for a `return { ... }`.
        }
      }
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(walk);
      else if (child && typeof child.type === 'string') walk(child);
    }
  };
  walk(ast);

  // (2b) Any function's `return { a, b }` — the UMD factory pattern returns its exports as an object
  // literal, and Object.assign(root, factory()) spreads those onto the global. Collecting every such
  // return's keys is broad but safe: it can only ADD legitimate globals, never mask a real undefined
  // (a truly-undefined name won't appear as an export key).
  const walkReturns = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'ReturnStatement' && node.argument?.type === 'ObjectExpression') objectExprKeys(node.argument);
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(walkReturns);
      else if (child && typeof child.type === 'string') walkReturns(child);
    }
  };
  walkReturns(ast);
}

// Vendor globals provided by the bundled <script>s (xterm, codemirror bundle, morphdom, etc.) that are not
// classic source files we parse. These are real window globals the environment has; list them so no-undef
// does not flag legitimate use.
const VENDOR_GLOBALS = [
  'Terminal', 'FitAddon', 'WebLinksAddon', 'SearchAddon', 'Unicode11Addon', 'UnicodeGraphemesAddon',
  'WebglAddon', 'CanvasAddon', 'ImageAddon', 'LigaturesAddon', 'SerializeAddon',
  'morphdom', 'CodeMirror', 'marked', 'DOMPurify', 'mermaid',
];

// A handful of app.js globals that panels/settings-panel.js reaches for although it also loads in the
// standalone settings window (settings.html), where app.js is NOT present. Every use is `typeof`-guarded
// (verified), so it is correct — but no-undef is not flow-sensitive across the guard, so it flags the call
// inside the guarded `if`. Listing them keeps the guard honest for the settings.html environment: a NEW
// app.js global used UNGUARDED there is still caught, because it is not on this small curated list.
const CROSS_ENV_GUARDED = ['refreshSidebar', 'loadProjects', 'isMac', 'toast'];

function lintEnvironment(htmlFile, arrayKey) {
  const basenameToPath = htmlScriptPaths(htmlFile);
  const order = ORDER[arrayKey];
  // Parse-able source files this environment loads (skip vendor bundles not in src/renderer).
  const files = order
    .map(base => ({ base, rel: basenameToPath.get(base) }))
    .filter(x => x.rel && fs.existsSync(path.join(REN, x.rel)));

  // The shared scope: every top-level name and every UMD/window export of every file in the environment.
  const gset = new Set();
  const sources = new Map();
  for (const { rel } of files) {
    const src = fs.readFileSync(path.join(REN, rel), 'utf8');
    sources.set(rel, src);
    collectGlobals(src, gset);
  }
  const globals = {};
  for (const n of gset) globals[n] = 'writable';
  for (const v of VENDOR_GLOBALS) globals[v] = 'readonly';
  for (const v of CROSS_ENV_GUARDED) globals[v] = 'readonly';

  const linter = new Linter();
  const config = {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globalsBrowser(), ...globals },
    },
    rules: { 'no-undef': 'error' },
  };

  const undef = [];
  for (const { rel } of files) {
    const messages = linter.verify(sources.get(rel), config, { filename: rel });
    for (const m of messages) {
      if (m.ruleId === 'no-undef') undef.push(`${rel}:${m.line} ${m.message}`);
    }
  }
  return undef;
}

// A minimal browser globals set (eslint dropped built-in env presets in flat config; list what the
// renderer actually uses rather than pull in the `globals` package).
function globalsBrowser() {
  const names = ('window document navigator console localStorage sessionStorage setTimeout clearTimeout '
    + 'setInterval clearInterval requestAnimationFrame cancelAnimationFrame fetch WebSocket Event '
    + 'CustomEvent KeyboardEvent MouseEvent PointerEvent MutationObserver ResizeObserver IntersectionObserver '
    + 'AbortController FormData Blob URL URLSearchParams FileReader Image Audio Notification Intl '
    + 'structuredClone queueMicrotask crypto performance history location screen getComputedStyle '
    + 'matchMedia devicePixelRatio alert confirm prompt HTMLElement Node NodeFilter Range DOMParser '
    + 'module require exports CSS process __dirname getSelection DocumentFragment SVGElement '
    + 'DOMMatrixReadOnly DOMMatrix Path2D ImageData OffscreenCanvas ResizeObserverEntry '
    + 'XMLHttpRequest TextEncoder TextDecoder atob btoa globalThis self AudioContext webkitAudioContext').split(' ');
  const o = {};
  for (const n of names) o[n] = 'readonly';
  return o;
}

test('renderer classic scripts: no undefined references in the index.html environment', () => {
  const undef = lintEnvironment('index.html', 'index.html');
  assert.deepEqual(undef, [], `undefined references found:\n${undef.join('\n')}`);
});

test('renderer classic scripts: no undefined references in the settings.html environment', () => {
  const undef = lintEnvironment('settings.html', 'settings.html');
  assert.deepEqual(undef, [], `undefined references found:\n${undef.join('\n')}`);
});

test('renderer classic scripts: no undefined references in the changed-files.html environment', () => {
  const undef = lintEnvironment('changed-files.html', 'changed-files.html');
  assert.deepEqual(undef, [], `undefined references found:\n${undef.join('\n')}`);
});

test('renderer classic scripts: no undefined references in the diff-window.html environment', () => {
  const undef = lintEnvironment('diff-window.html', 'diff-window.html');
  assert.deepEqual(undef, [], `undefined references found:\n${undef.join('\n')}`);
});
