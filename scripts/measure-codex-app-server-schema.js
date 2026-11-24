// Check which Codex versions offer what a native Codex backend needs from app-server (#734): the requests, server requests,
// notifications and fields listed below, and whether `threadSource` takes a free string. It generates each version's
// schema with `codex app-server generate-json-schema`, which needs no account and starts no model turn. A version that
// passes here can still be refused by the server at its first turn: that half is `scripts/measure-codex-app-server.js`.
//
// Usage: node scripts/measure-codex-app-server-schema.js --out=<dir> <version|installed>...
//   --out      Where the schemas go, one folder per version (`<dir>/schema-<version>`). An existing folder is reused.
//   versions   x.y.z runs `npx -y @openai/codex@<version>`; `installed` runs the `codex` on PATH.
//
// Prints one line per version: what is missing, and the type of `ThreadSource`. Names only. The last measurement is in
// `docs/backend-formats.md` (Codex, "Driving a thread over app-server (#734)").
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const outArg = args.find((a) => a.startsWith('--out='));
const versions = args.filter((a) => !a.startsWith('--'));
if (!outArg || !versions.length || versions.some((v) => v !== 'installed' && !/^\d+\.\d+\.\d+$/.test(v))) {
  console.error('Usage: node scripts/measure-codex-app-server-schema.js --out=<dir> <version|installed>...');
  process.exit(1);
}
const OUT = path.resolve(outArg.slice('--out='.length));
// The folder goes onto a shell command line inside quotes; a character the shell could act on there is refused.
if (/["%^&|<>!`$]/.test(OUT)) {
  console.error('--out may not contain any of " % ^ & | < > ! ` $');
  process.exit(1);
}
const GENERATE_TIMEOUT_MS = 300000;

// What the native backend uses. A second copy of the calls the backend will make: when it starts using another method,
// add it here too.
const NEEDED = {
  client: ['initialize', 'thread/start', 'thread/resume', 'thread/fork', 'thread/read', 'thread/compact/start',
    'turn/start', 'turn/steer', 'turn/interrupt', 'model/list'],
  server: ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput',
    'item/permissions/requestApproval'],
  notification: ['thread/started', 'thread/status/changed', 'thread/tokenUsage/updated', 'turn/started', 'turn/completed',
    'turn/plan/updated', 'item/started', 'item/completed', 'item/agentMessage/delta', 'serverRequest/resolved'],
  fields: [['ThreadStartParams', 'threadSource'], ['ThreadForkParams', 'threadSource'], ['Thread', 'threadSource'],
    ['Thread', 'path'], ['TurnStartParams', 'model']],
};

function generate(version, dir) {
  if (fs.existsSync(path.join(dir, 'ClientRequest.json'))) return Promise.resolve(null);
  // A shell because npx and the Codex shim are `.cmd` files on Windows; the version was checked against x.y.z above.
  const command = version === 'installed' ? 'codex' : `npx -y @openai/codex@${version}`;
  return new Promise((resolve) => {
    const child = execFile(`${command} app-server generate-json-schema --out "${dir}"`, { shell: true, timeout: GENERATE_TIMEOUT_MS },
      (err) => resolve(err ? String(err.message).split('\n')[0] : null));
    child.stdin?.end();
  });
}

function methods(file) {
  if (!fs.existsSync(file)) return new Set();
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  return new Set((s.oneOf || s.anyOf || []).map((o) => o.properties?.method?.enum?.[0]).filter(Boolean));
}

function definitions(dir) {
  for (const name of ['codex_app_server_protocol.v2.schemas.json', 'codex_app_server_protocol.schemas.json']) {
    const f = path.join(dir, name);
    if (fs.existsSync(f)) { const s = JSON.parse(fs.readFileSync(f, 'utf8')); return s.definitions || s.$defs || {}; }
  }
  return {};
}

(async () => {
  for (const version of versions) {
    const dir = path.join(OUT, `schema-${version}`);
    const err = await generate(version, dir);
    if (err) { console.log(JSON.stringify({ version, error: err })); continue; }
    const client = methods(path.join(dir, 'ClientRequest.json'));
    const server = methods(path.join(dir, 'ServerRequest.json'));
    const notes = methods(path.join(dir, 'ServerNotification.json'));
    const defs = definitions(dir);
    const missing = [
      ...NEEDED.client.filter((m) => !client.has(m)),
      ...NEEDED.server.filter((m) => !server.has(m)).map((m) => `request ${m}`),
      ...NEEDED.notification.filter((m) => !notes.has(m)).map((m) => `notification ${m}`),
      ...NEEDED.fields.filter(([t, f]) => !(defs[t]?.properties && f in defs[t].properties)).map(([t, f]) => `${t}.${f}`),
    ];
    const ts = defs.ThreadSource;
    const threadSource = !ts ? 'absent' : Array.isArray(ts.enum) ? `enum ${ts.enum.join('|')}` : ts.type ?? `other ${JSON.stringify(ts).slice(0, 120)}`;
    console.log(JSON.stringify({ version, missing, threadSource }));
  }
})();
