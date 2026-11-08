// Verify the packaged executable starts its own server, renders, sends an event, and shuts its server down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const executable = process.env.WORKBENCH_DESKTOP_EXE;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engine = path.resolve(process.env.AGENT_AUTOLOOP_APP || path.join(root, '..', 'app'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, message, timeout=20000) {
  const end=Date.now()+timeout;
  while(Date.now()<end){try{const result=await check();if(result)return result;}catch{}await delay(100);}
  throw new Error(message);
}

test('packaged desktop starts, renders, sends an event, and closes its local service', { skip: !executable, timeout: 90000 }, async () => {
  const temp=await mkdtemp(path.join(await realpath(tmpdir()),'workbench-desktop-'));
  const home=path.join(temp,'home'); await mkdir(home);
  const requests=[];
  const state={seq:1,now:new Date().toISOString(),timezone:'Asia/Shanghai',totals:{running:0,queued:0,doneToday:0,attention:0},spending:{today:{tokens:0,missingTokens:0,missingCost:0,rounds:0,cost:0}},cards:[],recentCards:[],runs:[],lines:[],timers:[],elsewhere:[],skipped:[],agents:[],channels:[],sources:[],unrouted:[]};
  const hub=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests.push({url:req.url,auth:req.headers.authorization,body});res.setHeader('content-type','application/json');if(req.url.startsWith('/v1/stream')){res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();return;}res.end(JSON.stringify(req.url==='/v1/state'?state:{routed:[]}));});
  let child,page,base;
  try {
    hub.listen(0,'127.0.0.1');await once(hub,'listening');
    await writeFile(path.join(home,'config.json'),JSON.stringify({url:`http://127.0.0.1:${hub.address().port}`,owner:'test-owner',source:{name:'local',key:'test-source'}}));
    await writeFile(path.join(home,'rules.json'),await readFile(path.join(engine,'tests','rules.fixture.json')));
    const env={...process.env,AGENT_AUTOLOOP_HOME:home,AGENT_AUTOLOOP_APP:engine,WORKBENCH_USER_DATA:path.join(temp,'profile')};
    if(process.env.WORKBENCH_TEST_NO_SYSTEM_NODE==='1') { env.PATH=path.join(process.env.SystemRoot,'System32'); delete env.AGENT_AUTOLOOP_NODE; }
    child=spawn(executable,['--remote-debugging-port=0'],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});
    let logs='';child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c);
    const debug=await waitFor(()=>logs.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/),'desktop debugging endpoint did not start');
    const port=debug[1];
    const target=await waitFor(async()=> (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t=>t.type==='page'&&t.url.startsWith('http://127.0.0.1:')),'desktop window did not load');
    page=new WebSocket(target.webSocketDebuggerUrl);await once(page,'open');
    let id=0;const pending=new Map(),errors=[];
    page.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}});
    const call=(method,params={})=>new Promise(resolve=>{const n=++id;pending.set(n,resolve);page.send(JSON.stringify({id:n,method,params}));});
    await call('Runtime.enable');
    const evaluate=async expression=>{const m=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(m.result?.exceptionDetails)throw new Error(m.result.exceptionDetails.text);return m.result?.result?.value;};
    await waitFor(()=>evaluate("document.querySelector('#side-status')?.textContent==='中台已连接'"),'desktop dashboard did not connect');
    if(process.env.WORKBENCH_TEST_NO_SYSTEM_NODE==='1') assert.equal(await stat(path.join(temp,'profile','runtime','v24.16.0','node.exe')).then(s=>s.isFile(),()=>false),true);
    base=await evaluate('location.origin');
    assert.equal(await evaluate('typeof window.require'),'undefined');
    await evaluate("document.querySelector('[data-page=tools]').click();document.querySelector('[data-action=event]').click();document.querySelector('[name=type]').value='demo.start';document.querySelector('[name=id]').value='desktop-test';document.querySelector('#action-form').requestSubmit()");
    await waitFor(()=>requests.some(r=>r.url==='/v1/events'),'desktop event was not sent');
    const event=requests.find(r=>r.url==='/v1/events'); assert.equal(event.auth,'Bearer test-source'); assert.equal(JSON.parse(event.body).id,'desktop-test');
    assert.deepEqual(errors,[]);
    page.send(JSON.stringify({id:++id,method:'Page.close'}));
    await waitFor(()=>child.exitCode!==null||child.signalCode!==null,'desktop process did not exit');
    await waitFor(async()=>!(await fetch(base).then(()=>true,()=>false)),'desktop left its workbench service running');
  } finally {
    page?.close();if(child&&child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'exit').catch(()=>{});}
    hub.closeAllConnections();await new Promise(resolve=>hub.close(resolve));await rm(temp,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  }
});
