// Adversarial fs.watch probe: log EVERY event, tag phase, cover create/append/delete/mkdir/nested/multi-folder.
// The evidence behind #524 in docs/ai/lessons.md: a recursive fs.watch reports the containing folder at
// the top level when a file inside it is appended to (observed on Windows).
// Run by hand: `node scripts/fswatch-probe.js`.
// Siblings: fswatch-probe-rate.js (how often), fswatch-probe-dirs.js (folder create/remove reliability).
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-fswatch-'));
fs.mkdirSync(path.join(root, 'project-a'), { recursive: true });
fs.mkdirSync(path.join(root, 'project-c'), { recursive: true });
const fileA = path.join(root, 'project-a', 'session.jsonl');
fs.writeFileSync(fileA, '{"a":0}\n');
const fileC = path.join(root, 'project-c', 'session.jsonl');
fs.writeFileSync(fileC, '{"c":0}\n');

let phase = 'settle';
const log = [];
const w = fs.watch(root, { recursive: true }, (type, filename) => {
  const parts = String(filename).split(path.sep);
  log.push(`${String(phase).padEnd(16)} ${(parts.length === 1 ? 'TOP ' : 'sub ')} ${String(type).padEnd(7)} "${filename}"`);
});

const steps = [
  ['append-a-1',    () => fs.appendFileSync(fileA, '{"a":1}\n')],
  ['append-a-2',    () => fs.appendFileSync(fileA, '{"a":2}\n')],
  ['append-a-3',    () => fs.appendFileSync(fileA, '{"a":3}\n')],
  ['append-a+c',    () => { fs.appendFileSync(fileA, '{"a":4}\n'); fs.appendFileSync(fileC, '{"c":4}\n'); }],
  ['newfile-in-a',  () => fs.writeFileSync(path.join(root, 'project-a', 'new.jsonl'), '{"n":1}\n')],
  ['append-new',    () => fs.appendFileSync(path.join(root, 'project-a', 'new.jsonl'), '{"n":2}\n')],
  ['mkdir-nested',  () => fs.mkdirSync(path.join(root, 'project-a', 'sub'))],
  ['nested-file',   () => fs.writeFileSync(path.join(root, 'project-a', 'sub', 's.jsonl'), '{"s":1}\n')],
  ['append-nested', () => fs.appendFileSync(path.join(root, 'project-a', 'sub', 's.jsonl'), '{"s":2}\n')],
  ['mkdir-b',       () => fs.mkdirSync(path.join(root, 'project-b'))],
  ['file-in-b',     () => fs.writeFileSync(path.join(root, 'project-b', 'x.jsonl'), '{"x":1}\n')],
  ['delfile-a',     () => fs.rmSync(path.join(root, 'project-a', 'new.jsonl'))],
  ['rmdir-b',       () => fs.rmSync(path.join(root, 'project-b'), { recursive: true, force: true })],
  ['toplevel-file', () => fs.writeFileSync(path.join(root, 'loose.txt'), 'x')],
  ['toplevel-app',  () => fs.appendFileSync(path.join(root, 'loose.txt'), 'y')],
];
let i = 0;
const next = () => {
  if (i >= steps.length) {
    setTimeout(() => { w.close(); console.log(log.join('\n')); fs.rmSync(root, { recursive: true, force: true }); }, 400);
    return;
  }
  const [name, fn] = steps[i++];
  phase = name;
  try { fn(); } catch (e) { log.push(`${name} ERROR ${e.message}`); }
  setTimeout(next, 300);
};
setTimeout(() => { phase = 'RUN'; next(); }, 400);
