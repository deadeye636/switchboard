// Rate test: under sustained appends, how often does a TOP-LEVEL event fire, and of what kind?
// Part of the #524 evidence (docs/ai/lessons.md), next to scripts/fswatch-probe.js. Run by hand:
// `node scripts/fswatch-probe-rate.js`.
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-fswatch-rate-'));
fs.mkdirSync(path.join(root, 'p1'), { recursive: true });
fs.mkdirSync(path.join(root, 'p2'), { recursive: true });
const f1 = path.join(root, 'p1', 's.jsonl'); fs.writeFileSync(f1, '');
const f2 = path.join(root, 'p2', 's.jsonl'); fs.writeFileSync(f2, '');
let topChange = 0, topRename = 0, subChange = 0, subRename = 0;
const topKinds = {};
const w = fs.watch(root, { recursive: true }, (t, fn) => {
  const parts = String(fn).split(path.sep);
  if (parts.length === 1) { if (t === 'change') topChange++; else topRename++; topKinds[t + ':' + fn] = (topKinds[t + ':' + fn] || 0) + 1; }
  else { if (t === 'change') subChange++; else subRename++; }
});
let n = 0;
const N = 60;
const iv = setInterval(() => {
  fs.appendFileSync(f1, JSON.stringify({ i: n, pad: 'x'.repeat(200) }) + '\n');
  if (n % 3 === 0) fs.appendFileSync(f2, JSON.stringify({ i: n }) + '\n');
  if (++n >= N) {
    clearInterval(iv);
    setTimeout(() => {
      w.close();
      console.log(`${N} appends to p1 + ${Math.ceil(N/3)} to p2 over ${N*100}ms`);
      console.log(`TOP change=${topChange} TOP rename=${topRename} | sub change=${subChange} sub rename=${subRename}`);
      console.log('top events:', JSON.stringify(topKinds));
      fs.rmSync(root, { recursive: true, force: true });
    }, 600);
  }
}, 100);
