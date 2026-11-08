// Exercise the owner's complete loop through the Workbench against a real isolated hub and a deterministic local agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, realpath, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = path.resolve(process.env.AGENT_AUTOLOOP_APP || path.join(root, '..', 'app'));
const bin = path.join(app, 'bin', 'agent-autoloop.ts');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function waitFor(check, message, timeout = 30000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) { try { last = await check(); if (last) return last; } catch {} await delay(150); }
  throw new Error(message);
}
async function stop(child) {
  if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
}
async function openBrowser(url, profile) {
  const candidates = [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean);
  const binary = candidates.find(existsSync); if (!binary) return null;
  const child=spawn(binary,['--headless','--disable-gpu','--no-first-run','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${profile}`,url],{stdio:['ignore','ignore','pipe'],windowsHide:true});
  let stderr=''; child.stderr.on('data',chunk => stderr += chunk);
  const debug=await waitFor(() => stderr.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\/[^\s]+)/), 'browser did not start');
  const targets=await (await fetch(`http://127.0.0.1:${debug[2]}/json`)).json();
  const page=new WebSocket(targets.find(x=>x.type==='page').webSocketDebuggerUrl); await once(page,'open');
  const browser=new WebSocket(debug[1]); await once(browser,'open');
  let sequence=0; const pending=new Map(), errors=[];
  page.addEventListener('message',e=>{const msg=JSON.parse(e.data);if(msg.method==='Runtime.exceptionThrown')errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);if(msg.id&&pending.has(msg.id)){pending.get(msg.id)(msg);pending.delete(msg.id);}});
  const call=(method,params={})=>new Promise(resolve=>{const id=++sequence;pending.set(id,resolve);page.send(JSON.stringify({id,method,params}));});
  await call('Runtime.enable');
  const evaluate=async expression=>{const msg=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(msg.result?.exceptionDetails)throw new Error(msg.result.exceptionDetails.text);return msg.result?.result?.value;};
  return { evaluate, errors, async screenshot(file) {const result=await call('Page.captureScreenshot',{format:'png'});await writeFile(file,Buffer.from(result.result.data,'base64'));}, async close() { page.close(); browser.send(JSON.stringify({id:1,method:'Browser.close'})); browser.close(); if(child.exitCode===null&&child.signalCode===null)await once(child,'exit'); } };
}

test('real hub routes a workbench event, receives an answer and completes the follow-up', { timeout: 90000 }, async () => {
  const home = await mkdtemp(path.join(await realpath(tmpdir()), 'workbench-real-'));
  const port = await freePort();
  const env = { ...process.env, AGENT_AUTOLOOP_HOME: home, AGENT_AUTOLOOP_APP: app, WORKBENCH_PORT: '0' };
  delete env.AGENT_AUTOLOOP_RULES; delete env.AGENT_AUTOLOOP_PUBLIC_URL;
  let workbench, browser;
  try {
    const init = spawnSync(process.execPath, [bin, 'init', '--no-service', '--command', 'node', '--port', String(port)], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(init.status, 0, init.stderr);
    const configPath = path.join(home, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    delete config.channels; await writeFile(configPath, JSON.stringify(config));
    const agent = path.join(home, 'agent.mjs');
    await writeFile(agent, `import {readFileSync} from 'node:fs';\nconst context=readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT,'utf8');\nif(context.includes('card.answered'))console.log('已根据回答完成');\nelse console.log('请决定\\n\\n\`\`\`agent-autoloop\\n'+JSON.stringify({ask:[{title:'选择颜色',text:'请选择',options:['蓝色','绿色'],key:'color'}]})+'\\n\`\`\`');\n`);
    const rulesPath = path.join(home, 'rules.json');
    const rules = JSON.parse(await readFile(rulesPath, 'utf8'));
    rules.agents.agent.command = [process.execPath, agent, '{prompt}', '{model}', '{effort}'];
    rules.agents['codex-sample']={name:'测试 Codex',worker:rules.agents.agent.worker,use:'codex'};
    await writeFile(rulesPath, JSON.stringify(rules));
    const codexHome=path.join(home,'codex-cache');await mkdir(codexHome);
    await writeFile(path.join(codexHome,'models_cache.json'),JSON.stringify({models:[{slug:'model-a',display_name:'模型 A',visibility:'list',supported_reasoning_levels:[{effort:'medium'},{effort:'high'}]}]}));env.CODEX_HOME=codexHome;
    workbench = spawn(process.execPath, [path.join(root, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const [chunk] = await once(workbench.stdout, 'data'); const base = chunk.toString().trim().split(' ').at(-1);
    const html = await (await fetch(base)).text(); const token = html.match(/name="workbench-token" content="([a-f0-9]+)"/)[1];
    const headers = { 'x-workbench-token': token, 'content-type': 'application/json' };
    const runtime = async action => fetch(`${base}/api/runtime`, { method:'POST',headers,body:JSON.stringify({action}) });
    browser=await openBrowser(base,path.join(home,'browser-profile'));
    if(browser) {
      await waitFor(()=>browser.evaluate("document.querySelector('#side-status')?.textContent==='中台未连接'"),'offline dashboard did not load');
      await browser.evaluate("window.confirm=()=>true;document.querySelector('[data-page=tools]').click();document.querySelector('[data-action=runtime]').click()");
      await waitFor(()=>browser.evaluate("!!document.querySelector('[data-action=runtime-start]')"),'runtime controls did not open');
      await browser.evaluate("document.querySelector('[data-action=runtime-start]').click()");
    } else assert.equal((await runtime('start')).status,200);
    await waitFor(async () => (await fetch(`${config.url}/healthz`)).ok, 'isolated hub did not start');
    const post = async data => { const r = await fetch(`${base}/api/action`, { method: 'POST', headers, body: JSON.stringify(data) }); const value = await r.json(); assert.equal(r.status, 200, value.error); return value; };
    const job = async args => {
      const started=await (await fetch(`${base}/api/jobs`,{method:'POST',headers,body:JSON.stringify({args})})).json();
      return waitFor(async()=>{const result=await (await fetch(`${base}/api/jobs/${started.id}`,{headers})).json();return result.done?result:null;},`job ${args[0]} did not finish`);
    };
    const state = async () => (await fetch(`${base}/api/state`, { headers })).json();
    const before = await state();
    if(browser) {
      await browser.evaluate("document.querySelector('#dialog-close').click();document.querySelector('#refresh').click()");
      await waitFor(()=>browser.evaluate("document.querySelector('#side-status')?.textContent==='中台已连接'"),'browser did not load the dashboard');
      await browser.evaluate("document.querySelector('#primary').click()");
      await waitFor(()=>browser.evaluate("!!document.querySelector('[name=agent]')"),'task form did not open');
      if(process.env.WORKBENCH_SCREENSHOT)await browser.screenshot(process.env.WORKBENCH_SCREENSHOT);
      await browser.evaluate(`document.querySelector('[name=name]').value='界面新任务';document.querySelector('[name=prompt]').value='完成隔离测试';document.querySelector('[name=cwd]').value=${JSON.stringify(home)};document.querySelector('[name=model]').value='__custom__';document.querySelector('[name=model]').dispatchEvent(new Event('change'));document.querySelector('[name=model_custom]').value='test-model';document.querySelector('[name=effort]').value='high';document.querySelector('#action-form').requestSubmit()`);
      const createdRules=await waitFor(async()=>{const r=JSON.parse(await readFile(rulesPath,'utf8'));return r.rules.find(x=>x.name==='界面新任务')?r:null;},'task form did not save');
      const newRule=createdRules.rules.find(x=>x.name==='界面新任务');
      assert.equal(createdRules.agents[newRule.to].model,'test-model');assert.equal(createdRules.agents[newRule.to].effort,'high');
      assert.equal(createdRules.agents.agent.model,undefined);assert.equal(createdRules.rules.find(x=>x.name==='试一下').to,'agent');
      await waitFor(()=>browser.evaluate("!document.querySelector('#dialog').open"),'task form did not close');
      await waitFor(()=>browser.evaluate("!!document.querySelector('[data-action=edit-task][data-id=\"界面新任务\"]')"),'new task did not appear');
      await browser.evaluate("document.querySelector('[data-action=edit-task][data-id=\"界面新任务\"]').click()");
      await waitFor(()=>browser.evaluate("document.querySelector('#dialog').open && document.querySelector('#dialog-title').textContent==='编辑任务'"),'task edit form did not open');
      assert.equal(await browser.evaluate("document.querySelector('[name=trigger]').value"),'keep');
      await browser.evaluate("document.querySelector('[name=prompt]').value='更新后的描述';document.querySelector('#action-form').requestSubmit()");
      const editedRules=await waitFor(async()=>{const r=JSON.parse(await readFile(rulesPath,'utf8'));return r.rules.find(x=>x.name==='界面新任务')?.prompt==='更新后的描述'?r:null;},'task edit did not save',5000).catch(async error=>{throw new Error(`${error.message}: ${await browser.evaluate("document.querySelector('#toast').textContent")}`);});
      assert.deepEqual(editedRules.rules.find(x=>x.name==='界面新任务').when,newRule.when);assert.equal(Object.keys(editedRules.agents).length,Object.keys(createdRules.agents).length);
      await waitFor(()=>browser.evaluate("!document.querySelector('#dialog').open"),'task edit did not close');
      await browser.evaluate("document.querySelector('#primary').click()");
      await waitFor(()=>browser.evaluate("document.querySelector('#dialog').open && document.querySelector('#dialog-title').textContent==='新建任务'"),'second task form did not open');
      await browser.evaluate(`document.querySelector('[name=name]').value='模型选择任务';document.querySelector('[name=prompt]').value='完成测试';document.querySelector('[name=cwd]').value=${JSON.stringify(home)};document.querySelector('[name=agent]').value='codex-sample';document.querySelector('[name=agent]').dispatchEvent(new Event('change'));document.querySelector('[name=model]').value='model-a';document.querySelector('[name=model]').dispatchEvent(new Event('change'));`);
      assert.equal(await browser.evaluate("[...document.querySelector('[name=effort]').options].some(o=>o.value==='ultra')"),false);
      await browser.evaluate("document.querySelector('[name=effort]').value='high';document.querySelector('[name=task_access]').value='read';document.querySelector('[name=trigger]').value='custom';document.querySelector('[name=trigger]').dispatchEvent(new Event('change'));for(const [k,v] of [['minute','15'],['hour','9'],['day','1'],['month','1'],['weekday','1'],['weekday','3'],['weekday','5']])document.querySelector(`[data-schedule=\"${k}\"][value=\"${v}\"]`).checked=true;document.querySelector('[data-schedule-relation]').value='both';document.querySelector('#action-form').requestSubmit()");
      const modelRules=await waitFor(async()=>{const r=JSON.parse(await readFile(rulesPath,'utf8'));return r.rules.find(x=>x.name==='模型选择任务')?r:null;},'model choice did not save');
      const modelTask=modelRules.rules.find(x=>x.name==='模型选择任务');assert.equal(modelRules.agents[modelTask.to].model,'model-a');assert.equal(modelRules.agents[modelTask.to].effort,'high');assert.equal(modelRules.agents[modelTask.to].access,'read');assert.equal(modelRules.agents['codex-sample'].model,undefined);assert.equal(modelTask.when.cron,'15 9 */999 1 1,3,5');
      await waitFor(()=>browser.evaluate("!document.querySelector('#dialog').open"),'second task form did not close');
      await browser.evaluate("document.querySelector('[data-page=connections]').click();document.querySelector('[data-action=rules-section][data-id=agents]').click()");
      await waitFor(()=>browser.evaluate("document.querySelector('#dialog').open && !!document.querySelector('#tree-editor')"),'agent settings did not open');
      await browser.evaluate(`(()=>{const g=[...document.querySelectorAll('details')].find(e=>e.dataset.treePath===JSON.stringify(['agents','codex-sample']));g.open=true;const c=g.querySelector(':scope > .tree-body > .tree-add [data-tree-choice]');c.value='model';c.dispatchEvent(new Event('change'));g.querySelector(':scope > .tree-body > .tree-add [data-tree-add]').click();})()`);
      await browser.evaluate(`(()=>{const g=[...document.querySelectorAll('details')].find(e=>e.dataset.treePath===JSON.stringify(['agents','codex-sample']));const f=[...g.querySelectorAll('.tree-field label')].find(e=>e.querySelector('span').textContent==='模型');const i=f.querySelector('input');i.value='model-b';i.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#tree-save').click()})()`);
      const agentRules=await waitFor(async()=>{const r=JSON.parse(await readFile(rulesPath,'utf8'));return r.agents['codex-sample'].model==='model-b'?r:null;},'agent settings did not save');
      assert.equal(agentRules.agents[modelTask.to].model,'model-a');assert.deepEqual(agentRules.rules.find(x=>x.name==='界面新任务').when,newRule.when);
      await waitFor(()=>browser.evaluate("!document.querySelector('#dialog').open"),'agent settings did not close');
      await browser.evaluate("document.querySelector('[data-page=rules]').click();document.querySelector('[data-action=edit-rules]').click()");
      await waitFor(()=>browser.evaluate("document.querySelector('#dialog').open && !!document.querySelector('#tree-editor')"),'rule settings did not open');
      const modelIndex=agentRules.rules.findIndex(r=>r.name==='模型选择任务');
      await browser.evaluate(`(()=>{for(const p of [['rules'],['rules',${modelIndex}],['rules',${modelIndex},'when']]){const g=[...document.querySelectorAll('details')].find(e=>e.dataset.treePath===JSON.stringify(p));g.open=true;}const g=[...document.querySelectorAll('details')].find(e=>e.dataset.treePath===JSON.stringify(['rules',${modelIndex},'when']));g.querySelector('[data-tree-schedule]').click();for(const [k,v] of [['minute','0'],['hour','0'],['day','1'],['month','1']])g.querySelector('[data-schedule="'+k+'"][value="'+v+'"]').checked=true;g.querySelector('[data-tree-schedule-apply]').click();document.querySelector('#tree-save').click()})()`);
      const scheduleRules=await waitFor(async()=>{const r=JSON.parse(await readFile(rulesPath,'utf8'));return r.rules.find(x=>x.name==='模型选择任务')?.when.cron==='0 0 1 1 *'?r:null;},'schedule picker did not save');
      assert.equal(scheduleRules.agents[modelTask.to].model,'model-a');
      await waitFor(()=>browser.evaluate("!document.querySelector('#dialog').open"),'rule settings did not close');
      await browser.evaluate("document.querySelector('[data-page=cards]').click()");
    }
    const streamAbort = new AbortController();
    const stream = fetch(`${base}/api/stream?after=${before.seq}`, { headers, signal:streamAbort.signal });
    const emitted = await post({ kind: 'event', data: { id: 'real-loop-1', type: 'try.start', subject: '#1' } });
    assert.deepEqual(emitted.routed, ['试一下']);
    const response = await stream; assert.equal(response.status,200);
    const firstFact = new TextDecoder().decode((await response.body.getReader().read()).value);
    assert.match(firstFact,/event: fact/); assert.ok(Number(firstFact.match(/id: (\d+)/)[1]) > before.seq); streamAbort.abort();
    const card = await waitFor(async () => (await state()).cards.find(c => c.title === '选择颜色'), 'agent did not produce a card');
    assert.deepEqual(card.options, ['蓝色', '绿色']);
    if(browser) {
      await waitFor(()=>browser.evaluate(`!!document.querySelector('[data-action=card][data-id="${card.id}"]')`),'event stream did not refresh the card in the browser',10000);
      await browser.evaluate(`document.querySelector('[data-action=card][data-id="${card.id}"]').click()`);
      await browser.evaluate("document.querySelector('[name=choice]').value='1'; document.querySelector('#action-form').requestSubmit()");
    } else await post({ kind: 'answer', id: card.id, data: { choice: 1 } });
    const done = await waitFor(async () => (await state()).recentCards.find(c => c.id === card.id && c.state === 'done'), 'answer did not complete the follow-up');
    assert.match(done.result, /已根据回答完成/);
    const snapshot = await state(); assert.ok(snapshot.runs.length >= 2);
    const why = await fetch(`${base}/api/why/${snapshot.runs[0].id}`, { headers }); assert.equal(why.status, 200);
    await post({kind:'pause',id:'试一下',data:{reason:'隔离测试'}});
    const skipped=await post({kind:'event',data:{id:'real-loop-paused',type:'try.start',subject:'#2'}});
    assert.deepEqual(skipped.routed,[]); assert.deepEqual(skipped.paused,['试一下']);
    await post({kind:'resume',id:'试一下',data:{}});
    await post({kind:'run',id:'试一下',data:{reason:'隔离测试'}});
    const another=await waitFor(async()=> (await state()).cards.find(c=>c.title==='选择颜色' && c.id!==card.id),'manual run did not create a second card');
    await post({kind:'resolve',id:another.id,data:{reason:'无需决定'}});
    const closed=await waitFor(async()=> (await state()).recentCards.find(c=>c.id===another.id && c.state==='closed'),'card did not close');
    assert.equal(closed.result,'无需决定');
    if(browser) {
      await browser.evaluate("document.querySelector('[data-page=rules]').click()");
      await waitFor(()=>browser.evaluate("!!document.querySelector('[data-action=rule-run][data-id=\"界面新任务\"]')"),'created task was not available to run');
      await browser.evaluate("document.querySelector('[data-action=rule-run][data-id=\"界面新任务\"]').click()");
      assert.equal(await browser.evaluate("document.querySelector('[name=rule]').value"),'界面新任务');
      await browser.evaluate("document.querySelector('#action-form').requestSubmit()");
      const taskCard=await waitFor(async()=> (await state()).cards.find(c=>c.rule==='界面新任务'),'created task did not run');
      await post({kind:'answer',id:taskCard.id,data:{choice:1}});
      await waitFor(async()=> (await state()).recentCards.find(c=>c.id===taskCard.id&&c.state==='done'),'created task did not complete after answer');
    }
    const created=await job(['key','new','source','test-source']); assert.equal(created.code,0); assert.match(created.output.trim(),/^[A-Za-z0-9_-]{43}$/);
    const listed=await job(['key','list']); assert.equal(listed.code,0); assert.match(listed.output,/source test-source/);
    const removed=await job(['key','remove','source','test-source']); assert.equal(removed.code,0);
    const repository=path.join(home,'my-plugin'); await mkdir(repository);
    await writeFile(path.join(repository,'agent.ts'),'export default {};\n');
    const git = (...args) => spawnSync('git',args,{cwd:repository,encoding:'utf8'});
    assert.equal(git('init','-q').status,0); assert.equal(git('add','agent.ts').status,0);
    assert.equal(git('-c','user.name=Workbench Test','-c','user.email=test@example.invalid','commit','-qm','fixture').status,0);
    const installed=await job(['add',pathToFileURL(repository).href]); assert.equal(installed.code,0,installed.output);
    assert.equal(existsSync(path.join(home,'plugins','my-plugin','agent.ts')),true);
    const backupPath=path.join(home,'test-backup'); const backup=await job(['backup',backupPath]); assert.equal(backup.code,0,backup.output);
    assert.equal(existsSync(path.join(backupPath,'hub.db')),true);
    if(browser) {
      await browser.evaluate("document.querySelector('[data-page=tools]').click(); document.querySelector('[data-action=settings][data-id=config]').click()");
      await waitFor(()=>browser.evaluate("!!document.querySelector('#tree-editor')"),'configuration editor did not open');
      assert.equal(await browser.evaluate("[...document.querySelectorAll('.tree-field label')].find(e=>e.querySelector('span').textContent==='本人密钥').querySelector('input').type"),'password');
      await browser.evaluate("[...document.querySelectorAll('.tree-field label')].find(e=>e.querySelector('span').textContent==='本人密钥').querySelector('[data-tree-reveal]').click()");
      assert.equal(await browser.evaluate("[...document.querySelectorAll('.tree-field label')].find(e=>e.querySelector('span').textContent==='本人密钥').querySelector('input').type"),'text');
      await browser.evaluate(`(()=>{const g=[...document.querySelectorAll('details')].find(e=>e.dataset.treePath===JSON.stringify(['worker']));g.open=true;const c=g.querySelector(':scope > .tree-body > .tree-add [data-tree-choice]');c.value='capacity';c.dispatchEvent(new Event('change'));g.querySelector(':scope > .tree-body > .tree-add [data-tree-add]').click();})()`);
      await browser.evaluate(`(()=>{const f=[...document.querySelectorAll('.tree-field label')].find(e=>e.querySelector('span').textContent==='接单容量');const i=f.querySelector('input');i.value='3';i.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#tree-save').click()})()`);
      const saved=await waitFor(async()=>{const c=JSON.parse(await readFile(configPath,'utf8'));return c.worker.capacity===3?c:null;},'configuration form did not save');
      assert.equal(saved.owner,config.owner);assert.equal(saved.worker.key,config.worker.key);
      await waitFor(()=>browser.evaluate("!document.querySelector('#dialog').open"),'configuration form did not close');
      await browser.evaluate("document.querySelector('[data-action=settings][data-id=secrets]').click()");
      await waitFor(()=>browser.evaluate("document.querySelector('#dialog').open && !!document.querySelector('[data-action=secret-edit]')"),'secrets form did not open');
      await browser.evaluate("document.querySelector('[data-action=secret-edit]').click()");
      await waitFor(()=>browser.evaluate("document.querySelector('#dialog-title').textContent==='添加环境变量'"),'secret add form did not open');
      await browser.evaluate("document.querySelector('[name=name]').value='TEST_SECRET';document.querySelector('[name=value]').value='test-value';document.querySelector('#action-form').requestSubmit()");
      await waitFor(async()=> (await readFile(path.join(home,'secrets.env'),'utf8').catch(()=>'' )).includes('TEST_SECRET='),'secret form did not save');
      await waitFor(()=>browser.evaluate("document.querySelector('#dialog-title').textContent==='密钥与环境变量'"),'secret list did not reopen');
      await browser.evaluate("document.querySelector('[data-action=secret-view][data-id=TEST_SECRET]').click()");
      await waitFor(()=>browser.evaluate("document.querySelector('#secret-value')?.value==='test-value'"),'secret value did not open');
      await browser.evaluate("document.querySelector('[data-action=settings][data-id=secrets]').click()");
      await waitFor(()=>browser.evaluate("document.querySelector('#dialog-title').textContent==='密钥与环境变量'"),'secret list did not return');
      await browser.evaluate("document.querySelector('[data-action=secret-remove][data-id=TEST_SECRET]').click()");
      await waitFor(async()=> !(await readFile(path.join(home,'secrets.env'),'utf8')).includes('TEST_SECRET='),'secret form did not delete');
      await waitFor(()=>browser.evaluate("document.querySelector('#dialog-title').textContent==='密钥与环境变量' && !document.querySelector('[data-action=secret-remove][data-id=TEST_SECRET]')"),'secret list did not update');
      await browser.evaluate("document.querySelector('#dialog-close').click()");
      await browser.evaluate("document.querySelector('[data-action=manage][data-id=key-list]').click()");
      await waitFor(()=>browser.evaluate("document.querySelector('#job-status')?.textContent.includes('退出码 0')"),'CLI job did not finish in the browser');
      assert.deepEqual(browser.errors,[]);
    }
    if(browser) {
      await browser.evaluate("document.querySelector('#dialog-close').click();document.querySelector('[data-action=runtime]').click()");
      await waitFor(()=>browser.evaluate("!!document.querySelector('[data-action=runtime-stop]')"),'runtime controls did not reopen');
      await browser.evaluate("document.querySelector('[data-action=runtime-stop]').click()");
    } else assert.equal((await runtime('stop')).status,200);
    await waitFor(async()=> (await (await fetch(`${base}/api/runtime`,{headers})).json()).state==='stopped','managed hub did not stop');
    const restored=await job(['restore',backupPath,'--yes']); assert.equal(restored.code,0,restored.output);
  } finally {
    if(browser)await browser.close(); await stop(workbench); await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
});
