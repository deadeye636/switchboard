// #427 — what `npm run demo:auth` copies into an isolated CLI home, and what it deliberately does not.
//
// The script had no test at all, and the thing that broke was not the copying: Hermes writes its OWN
// `auth.json` on first start, with the right shape and nothing chosen in it, so "a file is already
// there" was true and meaningless. The demo stayed unusable while the report said everything was fine.
//
// Nothing here touches a real home. Both ends are temp directories, and the real one is checked byte
// for byte afterwards — the demo home is downstream of the real one, always.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { copyCredentials, BACKENDS } = require('../scripts/demo-auth');

const HERMES = BACKENDS.find((b) => b.id === 'hermes');

/** A real home and a demo dir, both throwaway, with HERMES_HOME pointed at the fake real one. */
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-demo-auth-'));
  const realHome = path.join(root, 'real');
  const demoDir = path.join(root, 'demo');
  const demoHome = path.join(demoDir, 'stores', 'hermes');
  fs.mkdirSync(realHome, { recursive: true });
  fs.mkdirSync(demoHome, { recursive: true });
  const previous = process.env.HERMES_HOME;
  process.env.HERMES_HOME = realHome;
  return {
    root, realHome, demoDir, demoHome,
    restore() {
      if (previous === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = previous;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const REAL_AUTH = JSON.stringify({
  version: 1, providers: { anthropic: {} }, credential_pool: [], updated_at: 1, active_provider: 'anthropic',
});
// What Hermes writes for itself on a first start: the same shape, nobody chosen.
const STUB_AUTH = JSON.stringify({ version: 1, providers: {}, credential_pool: [], updated_at: 1 });

const hermesRows = (report) => report.filter((r) => r.id === 'hermes');

test('#427: Hermes copies its credential instead of being skipped', () => {
  const box = sandbox();
  try {
    fs.writeFileSync(path.join(box.realHome, 'auth.json'), REAL_AUTH);
    const rows = hermesRows(copyCredentials(box.demoDir));

    assert.deepEqual(rows.map((r) => r.state), ['copied'], `expected one copy, got ${JSON.stringify(rows)}`);
    assert.equal(fs.readFileSync(path.join(box.demoHome, 'auth.json'), 'utf8'), REAL_AUTH);
  } finally { box.restore(); }
});

test('#427: the file Hermes wrote for itself is replaced, not mistaken for a credential', () => {
  const box = sandbox();
  try {
    fs.writeFileSync(path.join(box.realHome, 'auth.json'), REAL_AUTH);
    fs.writeFileSync(path.join(box.demoHome, 'auth.json'), STUB_AUTH);

    const rows = hermesRows(copyCredentials(box.demoDir));
    assert.deepEqual(rows.map((r) => r.state), ['copied'],
      'nothing chosen in it means nobody to talk to — "already there" would leave the demo as stuck as before');
    assert.equal(fs.readFileSync(path.join(box.demoHome, 'auth.json'), 'utf8'), REAL_AUTH);
  } finally { box.restore(); }
});

test('#427: a demo credential that IS usable is left alone', () => {
  const box = sandbox();
  try {
    const mine = JSON.stringify({ version: 1, providers: {}, credential_pool: [], updated_at: 2, active_provider: 'openai' });
    fs.writeFileSync(path.join(box.realHome, 'auth.json'), REAL_AUTH);
    fs.writeFileSync(path.join(box.demoHome, 'auth.json'), mine);

    const rows = hermesRows(copyCredentials(box.demoDir));
    assert.deepEqual(rows.map((r) => r.state), ['kept']);
    assert.equal(fs.readFileSync(path.join(box.demoHome, 'auth.json'), 'utf8'), mine,
      'a login made inside the demo home must survive this script');
  } finally { box.restore(); }
});

test('#427: a real home with no credential is reported, not invented', () => {
  const box = sandbox();
  try {
    const rows = hermesRows(copyCredentials(box.demoDir));
    assert.deepEqual(rows.map((r) => r.state), ['missing']);
    assert.equal(fs.existsSync(path.join(box.demoHome, 'auth.json')), false);
  } finally { box.restore(); }
});

test('#427: the tool tuning and the user configuration stay behind', () => {
  assert.deepEqual(HERMES.files, ['auth.json'],
    '.env is eleven tool-tuning assignments and config.yaml is the user\'s own 64-key configuration — '
    + 'carrying either into a demo is what this script refuses to do for Claude too');
});

test('#427: nothing is ever written towards the real home', () => {
  const box = sandbox();
  try {
    fs.writeFileSync(path.join(box.realHome, 'auth.json'), REAL_AUTH);
    const before = fs.readdirSync(box.realHome).sort();

    copyCredentials(box.demoDir);

    assert.deepEqual(fs.readdirSync(box.realHome).sort(), before, 'the demo home is downstream, always');
    assert.equal(fs.readFileSync(path.join(box.realHome, 'auth.json'), 'utf8'), REAL_AUTH);
  } finally { box.restore(); }
});
