// The guided protocol check must pass the selected credentials to a real isolated hub without asking for a file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const app=path.resolve(process.env.AGENT_AUTOLOOP_APP||path.join(root,'..','app'));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('guided conformance check runs against an isolated real hub', {timeout:60000}, async()=>{
  const home=await mkdtemp(path.join(await realpath(tmpdir()),'workbench-probe-'));
  let hub,child,runtime;
  try {
    const rules=JSON.parse(await readFile(path.join(app,'tests','rules.fixture.json'),'utf8'));
    rules.rules=rules.rules.filter(rule=>rule.when.source);await writeFile(path.join(home,'rules.json'),JSON.stringify(rules));
    process.env.AGENT_AUTOLOOP_HOME=home;process.env.AGENT_AUTOLOOP_RULES=path.join(home,'rules.json');
    runtime=await import(pathToFileURL(path.join(app,'host','runtime.ts')).href);
    const {serve}=await import(pathToFileURL(path.join(app,'host','http.ts')).href);
    const keys={source:runtime.addKey('source','app'),worker:runtime.addKey('worker','w1'),channel:runtime.addKey('channel','chat'),owner:runtime.addKey('owner','owner')};
    hub=serve(0,'127.0.0.1',{commit:'test'});await once(hub,'listening');
    const url=`http://127.0.0.1:${hub.address().port}`;
    child=spawn(process.execPath,[path.join(root,'server.mjs')],{env:{...process.env,AGENT_AUTOLOOP_HOME:home,AGENT_AUTOLOOP_APP:app,WORKBENCH_PORT:'0'},stdio:['ignore','pipe','pipe'],windowsHide:true});
    const [chunk]=await once(child.stdout,'data');const base=chunk.toString().trim().split(' ').at(-1);
    const html=await (await fetch(base)).text();const token=html.match(/name="workbench-token" content="([a-f0-9]+)"/)[1];const headers={'x-workbench-token':token,'content-type':'application/json'};
    const response=await fetch(`${base}/api/probe`,{method:'POST',headers,body:JSON.stringify({url,keys,eventType:'feedback.new',answerer:'me'})});assert.equal(response.status,200);
    const {id}=await response.json();let result;
    for(let i=0;i<300;i++){result=await (await fetch(`${base}/api/jobs/${id}`,{headers})).json();if(result.done)break;await delay(100);}
    assert.equal(result.done,true);assert.equal(result.code,0,result.output);assert.match(result.output,/检查完成：\d+ 项/);
    for(const key of Object.values(keys))assert.equal(result.output.includes(key),false);
  } finally {
    if(child&&child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'exit');}
    if(hub){hub.closeAllConnections();await new Promise(resolve=>hub.close(resolve));}
    if(runtime?.db?.isOpen)runtime.db.close();
    await rm(home,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  }
});
