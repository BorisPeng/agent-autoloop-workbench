// History must search beyond the loaded page without duplicating old active runs or mixing other rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const app=path.resolve(process.env.AGENT_AUTOLOOP_APP||path.join(root,'..','app'));
test('rule history searches and pages finished runs using the upstream implementation',{skip:!existsSync(path.join(app,'cli','runs.ts'))},async()=>{
  const home=await mkdtemp(path.join(await realpath(tmpdir()),'workbench-history-'));
  const requests=[];
  const hub=http.createServer((req,res)=>{requests.push(req.url);const before=Number(new URL(req.url,'http://local').searchParams.get('before')||121);const all=Array.from({length:120},(_,i)=>120-i).filter(id=>id<before);const page=all.slice(0,60);const hasMore=all.length>60;const runs=page.map(id=>({id,rule:id%2===0?'目标':'其他',state:'done'}));if(before===121)runs.push({id:1,rule:'目标',state:'claimed'});res.setHeader('content-type','application/json');res.end(JSON.stringify({runs,hasMore,nextBefore:hasMore?page.at(-1):null}));});
  let child;
  try{
    hub.listen(0,'127.0.0.1');await once(hub,'listening');await writeFile(path.join(home,'config.json'),JSON.stringify({url:`http://127.0.0.1:${hub.address().port}`,owner:'owner'}));
    child=spawn(process.execPath,[path.join(root,'server.mjs')],{env:{...process.env,AGENT_AUTOLOOP_HOME:home,AGENT_AUTOLOOP_APP:app,WORKBENCH_PORT:'0'},stdio:['ignore','pipe','pipe'],windowsHide:true});
    const [chunk]=await once(child.stdout,'data');const base=chunk.toString().trim().split(' ').at(-1);const html=await (await fetch(base)).text();const token=html.match(/name="workbench-token" content="([a-f0-9]+)"/)[1];const headers={'x-workbench-token':token};
    const first=await (await fetch(`${base}/api/history?rule=${encodeURIComponent('目标')}`,{headers})).json();assert.equal(first.runs.length,20);assert.ok(first.runs.every(r=>r.rule==='目标'&&r.state==='done'));assert.equal(first.before,82);
    const second=await (await fetch(`${base}/api/history?rule=${encodeURIComponent('目标')}&before=${first.before}`,{headers})).json();assert.equal(second.runs[0].id,80);assert.equal(new Set([...first.runs,...second.runs].map(r=>r.id)).size,40);assert.ok(requests.some(url=>url.includes('before=82')));
  } finally {if(child&&child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'exit');}await new Promise(resolve=>hub.close(resolve));await rm(home,{recursive:true,force:true});}
});
