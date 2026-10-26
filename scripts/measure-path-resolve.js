#!/usr/bin/env node
// scripts/measure-path-resolve.js — what the static MCP check's PATH walk costs on this machine (#789, slice D).
//
// `resolveCommands` (src/app/path-resolve.js) lists every PATH directory once and answers a batch of names from
// that listing. The settings card asks it on open and on every card change, so its cold cost is time a user waits
// for the facts line; the cached cost is what a burst of edits pays. Spec 36 ("As built (slice D)") records the
// numbers this script printed on the machine that set them. Re-run it when the resolver changes or a number there
// is questioned, and update the spec.
//
// It prints the PATH directory count, the wall time of each run and the answer counts per state and reason. It
// prints no path and no variable value. Each cold run starts from `forgetListing()`; the run after it is served
// from the listing cache.
'use strict';

const path = require('path');
const { resolveCommands, forgetListing } = require('../src/app/path-resolve');

const NAMES = ['node', 'npx', 'uvx', 'uv', 'pipx', 'python', 'git', 'docker', 'sb-no-such-command-a', 'sb-no-such-command-b'];

function argValue(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const n = hit ? Number(hit.slice(name.length + 3)) : NaN;
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

async function once(label) {
  const started = process.hrtime.bigint();
  const answers = await resolveCommands(NAMES, { env: process.env, cwd: process.cwd(), isForeignNetworkPath: () => false });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const states = {};
  for (const a of answers.values()) {
    const key = a.state + (a.reason ? `/${a.reason}` : '');
    states[key] = (states[key] || 0) + 1;
  }
  console.log(`${label.padEnd(6)} ${ms.toFixed(1).padStart(8)} ms  ${JSON.stringify(states)}`);
}

(async () => {
  const runs = argValue('runs', 2);
  const pathValue = process.env.PATH || process.env.Path || '';
  const dirs = pathValue.split(path.delimiter).filter(Boolean).length;
  console.log(`PATH directories: ${dirs}, names: ${NAMES.length}, runs: ${runs}`);
  for (let i = 0; i < runs; i++) {
    forgetListing();
    await once('cold');
    await once('cached');
  }
})();
