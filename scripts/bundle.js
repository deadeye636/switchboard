#!/usr/bin/env node
'use strict';
// The renderer bundles, in one place (#484).
//
// CodeMirror and PDF.js are npm packages the renderer loads as plain <script> tags, so they have to be
// bundled first. That used to be two npm scripts with the flags written out inline, which was fine while
// npm was the only caller. `scripts/build-and-verify.js` is a second caller — it spawns the steps itself,
// because an `&&` chain cannot report on a step that killed it — and a second copy of the flag set is
// exactly the defect `.claude/rules/guards-and-scripts.md` names. So the flags live here and both callers
// run this.
//
// esbuild's JS API rather than its CLI: a `.cmd` shim cannot be spawned from Node without a shell
// (Node refuses it since CVE-2024-27980), and the API needs no shim at all.

const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const at = (...parts) => path.join(ROOT, ...parts);

// One shape for all three: a browser IIFE, minified, with its dependencies inlined.
const COMMON = { bundle: true, format: 'iife', platform: 'browser', minify: true };

const TARGETS = [
  { name: 'codemirror', entry: at('src', 'renderer', 'jsonl', 'codemirror-setup.js'), out: at('src', 'renderer', 'codemirror-bundle.js') },
  { name: 'pdf', entry: at('src', 'renderer', 'views', 'pdf-setup.js'), out: at('src', 'renderer', 'pdf-bundle.js') },
  { name: 'pdf-worker', entry: at('node_modules', 'pdfjs-dist', 'build', 'pdf.worker.mjs'), out: at('src', 'renderer', 'pdf-worker.js') },
];

async function bundleAll() {
  for (const target of TARGETS) {
    await esbuild.build(Object.assign({}, COMMON, { entryPoints: [target.entry], outfile: target.out }));
  }
  return TARGETS.map((t) => t.name);
}

module.exports = { bundleAll, TARGETS };

if (require.main === module) {
  bundleAll()
    .then((names) => console.log(`[bundle] ${names.join(', ')}`))
    .catch((err) => {
      console.error(`[bundle] failed: ${err && err.message ? err.message : err}`);
      process.exit(1);
    });
}
