import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {harness} from './harness.mjs';

const arg=name=>process.argv.find(value=>value.startsWith('--'+name+'='))?.slice(name.length+3);
const baseline=arg('baseline');
const results=[];
/** Same seeded documents and update hooks for both versions; server/GPU costs are excluded. */
async function run(label,moduleUrl,options) {
  const env=await harness({...options,moduleUrl});
  try {
    for(let i=0;i<5;i++){env.advance(5000);await env.tick();}
    env.reset();const times=[];
    for(let i=0;i<120;i++) {env.advance(5000);const start=performance.now();await env.tick();times.push(performance.now()-start);}
    times.sort((a,b)=>a-b);
    results.push({label,...options,ticks:120,medianMs:+times[60].toFixed(3),p95Ms:+times[114].toFixed(3),maxMs:+times.at(-1).toFixed(3),...env.stats,intervals:env.intervals.size});
  } finally {await env.close();}
}
const current=new URL('../scripts/module.js',import.meta.url);
const old=baseline?pathToFileURL(path.resolve(baseline,'scripts/module.js')):null;
for(const openPanel of [false,true]) {
  const options={active:6,inactive:4000,inventory:100,openPanel};
  if(old) await run('0.2.0',old,options);
  await run('current',current,options);
}
await run('stress',current,{active:60,inactive:10000,inventory:100,openPanel:false});
for(const client of ['P1','P2','P3','P4','P5','P6']) await run('player',current,{active:6,inactive:4000,inventory:100,openPanel:false,client});
console.log(JSON.stringify({note:'Synthetic controller benchmark: CPU includes fake document hooks; no real Foundry server, network or WebGL.',results},null,2));
