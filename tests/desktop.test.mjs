// Verify the packaged executable starts its own server, renders, sends an event, and shuts its server down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
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
    assert.equal(await evaluate('typeof window.workbench?.chooseDirectory'),'function');
    assert.equal(await evaluate('typeof window.workbench?.chooseFile'),'function');
    await evaluate("document.querySelector('#primary').click()");
    await waitFor(()=>evaluate("document.querySelector('#dialog').open && document.querySelector('#dialog-title').textContent==='新建任务'"),'desktop task form did not open');
    assert.equal(await evaluate("!!document.querySelector('[data-action=choose-directory]')"),true);
    if(process.platform==='win32'&&process.env.WORKBENCH_VERIFY_CHOOSER==='1') {
      await evaluate("window.__chooser='pending';window.workbench.chooseDirectory().then(v=>window.__chooser=v===null?'cancelled':'chosen').catch(e=>window.__chooser='error:'+e.message);true");
      const script=`Add-Type @'\nusing System; using System.Text; using System.Runtime.InteropServices;\npublic static class FolderDialogTest {\n  delegate bool EnumCallback(IntPtr h, IntPtr l);\n  [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr l);\n  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);\n  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);\n  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);\n  public static bool CloseFor(uint target) { bool closed=false; EnumWindows((h,l)=>{ uint pid; GetWindowThreadProcessId(h,out pid); var title=new StringBuilder(256); GetWindowText(h,title,256); if(pid==target && title.ToString().Contains("选择文件夹")) { PostMessage(h,0x10,IntPtr.Zero,IntPtr.Zero); closed=true; } return true; },IntPtr.Zero); return closed; }\n}\n'@\nfor($i=0;$i -lt 60;$i++){ if([FolderDialogTest]::CloseFor(${child.pid})){exit 0}; Start-Sleep -Milliseconds 150 }; exit 1`;
      const closed=spawnSync(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,encoding:'utf8',timeout:15000});
      assert.equal(closed.status,0,`folder chooser was not displayed: ${closed.stderr}`);
      await waitFor(()=>evaluate("window.__chooser==='cancelled'"),'folder chooser did not return cancellation');
    }
    await evaluate(`document.querySelector('[name=name]').value='桌面测试任务';document.querySelector('[name=prompt]').value='完成测试';document.querySelector('[name=cwd]').value=${JSON.stringify(home)};document.querySelector('[name=model]').value='sonnet';document.querySelector('[name=model]').dispatchEvent(new Event('change'));document.querySelector('[name=effort]').value='high';document.querySelector('#action-form').requestSubmit()`);
    const rules=await waitFor(async()=>{const r=JSON.parse(await readFile(path.join(home,'rules.json'),'utf8'));return r.rules.find(x=>x.name==='桌面测试任务')?r:null;},'desktop task was not saved');
    const task=rules.rules.find(x=>x.name==='桌面测试任务');assert.equal(rules.agents[task.to].model,'sonnet');assert.equal(rules.agents[task.to].effort,'high');assert.equal(rules.agents.a1.model,'m1');
    await waitFor(()=>evaluate("!document.querySelector('#dialog').open"),'desktop task form did not close');
    await writeFile(path.join(home,'rules.json'),JSON.stringify({sources:{},agents:rules.agents,channels:{},rules:[],elsewhere:[]}));
    await evaluate("document.querySelector('#primary').click()");
    await waitFor(()=>evaluate("document.querySelector('#dialog').open && document.querySelector('#dialog-title').textContent==='新建任务'"),'scheduled task form did not open');
    await evaluate(`document.querySelector('[name=name]').value='无来源定时任务';document.querySelector('[name=prompt]').value='完成测试';document.querySelector('[name=cwd]').value=${JSON.stringify(home)};document.querySelector('[name=trigger]').value='daily';document.querySelector('[name=trigger]').dispatchEvent(new Event('change'));document.querySelector('#action-form').requestSubmit()`);
    const scheduled=await waitFor(async()=>{const r=JSON.parse(await readFile(path.join(home,'rules.json'),'utf8'));return r.rules.find(x=>x.name==='无来源定时任务')?r:null;},'scheduled task without event source was not saved');
    assert.equal(scheduled.rules[0].when.cron,'0 9 * * *');
    await waitFor(()=>evaluate("!document.querySelector('#dialog').open"),'scheduled task form did not close');
    await evaluate("window.confirm=()=>true;document.querySelector('[data-page=tools]').click();document.querySelector('[data-action=edit-rules]').click()");
    await waitFor(()=>evaluate("document.querySelector('#dialog').open && !!document.querySelector('#tree-editor')"),'agent settings did not open');
    await evaluate(`(()=>{const a=[...document.querySelectorAll('details')].find(e=>e.dataset.treePath===JSON.stringify(['agents','a1']));a.open=true;const c=a.querySelector(':scope > .tree-body > .tree-add [data-tree-choice]');c.value='program';c.dispatchEvent(new Event('change'));a.querySelector(':scope > .tree-body > .tree-add [data-tree-add]').click()})()`);
    assert.equal(await evaluate("!!document.querySelector('[data-tree-file]')"),true);
    await evaluate("document.querySelector('#dialog-close').click();document.querySelector('[data-action=event]').click();document.querySelector('[name=type]').value='demo.start';document.querySelector('[name=id]').value='desktop-test';document.querySelector('#action-form').requestSubmit()");
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
