// Reliability: 25 mkdir/rmdir cycles under concurrent append traffic. Does a folder create/remove EVER
// arrive without a top-level `rename`? Part of the #524 evidence (docs/ai/lessons.md), next to
// scripts/fswatch-probe.js. Run by hand: `node scripts/fswatch-probe-dirs.js`.
const fs=require('fs'),os=require('os'),path=require('path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'switchboard-fswatch-dirs-'));
fs.mkdirSync(path.join(root,'busy'),{recursive:true});
const busy=path.join(root,'busy','s.jsonl'); fs.writeFileSync(busy,'');
const seen=[];
const w=fs.watch(root,{recursive:true},(t,fn)=>{
  const parts=String(fn).split(path.sep);
  if(parts.length===1) seen.push({t,fn,at:Date.now()});
});
const noise=setInterval(()=>{fs.appendFileSync(busy,'x'.repeat(300)+'\n');},20);
let i=0;const N=25;
const marks=[];
const step=()=>{
  if(i>=N){clearInterval(noise);setTimeout(()=>{w.close();
    let missCreate=0,missRemove=0,stray=0;
    for(const m of marks){
      const evs=seen.filter(e=>e.fn===m.name&&e.at>=m.tCreate-5&&e.at<=m.tCreate+250);
      const evs2=seen.filter(e=>e.fn===m.name&&e.at>=m.tRemove-5&&e.at<=m.tRemove+250);
      if(!evs.some(e=>e.t==='rename'))missCreate++;
      if(!evs2.some(e=>e.t==='rename'))missRemove++;
    }
    const busyTop=seen.filter(e=>e.fn==='busy');
    console.log(`${N} create/remove cycles under ~${Math.round(N*300/20)} appends`);
    console.log(`creates missing a top-level rename: ${missCreate}`);
    console.log(`removes missing a top-level rename: ${missRemove}`);
    console.log(`top-level events for the busy FOLDER: change=${busyTop.filter(e=>e.t==='change').length} rename=${busyTop.filter(e=>e.t==='rename').length}`);
    console.log(`total top-level: change=${seen.filter(e=>e.t==='change').length} rename=${seen.filter(e=>e.t==='rename').length}`);
    fs.rmSync(root,{recursive:true,force:true});
  },600);return;}
  const name='proj-'+(i++);
  const p=path.join(root,name);
  const tCreate=Date.now(); fs.mkdirSync(p);
  setTimeout(()=>{const tRemove=Date.now();fs.rmSync(p,{recursive:true,force:true});marks.push({name,tCreate,tRemove});setTimeout(step,150);},150);
};
setTimeout(step,300);
