const $ = (s) => document.querySelector(s);
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const token = $('meta[name="workbench-token"]').content;
let state = null, info = null, page = 'overview', rulesDirty = false, loading = false, older = [], nextBefore = null;
let streamStarted=false, streamAfter=0, streamController=null, streamRefresh=null;
const labels = {overview:['总览','在一个地方掌握自动化的运行与进展。'],cards:['待处理','查看需要你决定的事项，以及最近处理过的卡片。'],runs:['运行记录','追踪每一轮任务，查看结果与完整时间线。'],rules:['规则与调度','管理自动化规则、定时任务和等待复查的事项。'],connections:['连接与资源','查看 Agent、事件来源与通知通道的连接情况。'],tools:['工具箱','检查设置，管理服务、插件和密钥。']};
const statusLabels = {queued:'排队中',claimed:'运行中',unknown:'状态未知',done:'已完成',nothing:'无事可做',failed:'失败',cancelled:'已停止',open:'待处理',decided:'已回答',closed:'已关闭'};
const fmt = (v) => v ? new Date(v).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '—';
const num = (v) => Number(v || 0).toLocaleString('zh-CN');
const badge = (text, color='') => `<span class="badge ${color}">${esc(text)}</span>`;
const status = (s) => badge(statusLabels[s] || s, ['done','nothing'].includes(s)?'green':['queued','claimed','open'].includes(s)?'amber':['failed','unknown'].includes(s)?'red':'');
const btn = (text, action, id='', extra='') => `<button type="button" class="button ${extra}" data-action="${action}" data-id="${esc(id)}">${esc(text)}</button>`;
const empty = (text, icon='◇') => `<div class="empty"><div class="empty-icon">${icon}</div>${esc(text)}</div>`;
const panel = (title, subtitle, content, link='') => `<section class="panel"><div class="panel-head"><div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div>${link}</div>${content}</section>`;
const field = (label, name, placeholder='', value='', type='text') => `<label class="form-field">${esc(label)}<input name="${name}" type="${type}" placeholder="${esc(placeholder)}" value="${esc(value)}"></label>`;
const directoryField = (label,name,placeholder='',value='') => `<label class="form-field">${esc(label)}<span class="copy-row"><input id="directory-${esc(name)}" name="${esc(name)}" placeholder="${esc(placeholder)}" value="${esc(value)}">${window.workbench?.chooseDirectory?btn('选择文件夹','choose-directory',`directory-${name}`):''}</span></label>`;
const fileField = (label,name,placeholder='',value='') => `<label class="form-field">${esc(label)}<span class="copy-row"><input id="file-${esc(name)}" name="${esc(name)}" placeholder="${esc(placeholder)}" value="${esc(value)}">${window.workbench?.chooseFile?btn('选择文件','choose-file',`file-${name}`):''}</span></label>`;
const textarea = (label, name, placeholder='', value='') => `<label class="form-field">${esc(label)}<textarea name="${name}" rows="4" placeholder="${esc(placeholder)}">${esc(value)}</textarea></label>`;
async function api(path, options={}) { const response = await fetch(path, { ...options, headers: {'x-workbench-token': token, ...(options.body ? {'content-type':'application/json'} : {}), ...options.headers} }); const result = await response.json(); if (!response.ok) throw new Error(result.error || '请求失败'); return result; }
const post = (path, data) => api(path, {method:'POST',body:JSON.stringify(data)});
function toast(text) { const el=$('#toast'); el.textContent=text; el.classList.add('show'); clearTimeout(toast.timer); toast.timer=setTimeout(()=>el.classList.remove('show'),3000); }
function modal(title, body) { $('#dialog-title').textContent=title; $('#dialog-body').innerHTML=body; $('#dialog').showModal(); }
function closeModal() { $('#dialog').close(); }
function nav(next) { if (rulesDirty && next !== page && !confirm('草稿尚未保存，确定离开？')) return; rulesDirty=false; page=next; older=[]; nextBefore=state?.nextBefore; render(); }
async function refresh(quiet=false) {
  if (loading) return; loading=true;
  try { const previousSeq=state?.seq; state=await api('/api/state'); if(!streamStarted){streamStarted=true;streamAfter=state.seq;void followStream();}else if(previousSeq!==undefined&&state.seq<previousSeq){streamAfter=state.seq;streamController?.abort();} if (!older.length) nextBefore=state.nextBefore; $('#alert').hidden=true; $('#side-status').textContent='中台已连接'; $('#side-dot').className='live-dot on'; $('#updated').textContent=`更新于 ${fmt(state.now)}`; $('#card-count').textContent=state.cards?.length || ''; if (!rulesDirty) { if(page==='runs' && (document.activeElement?.id==='run-search' || $('#run-search')?.value || $('#run-filter')?.value)) filterRuns(); else render(); } }
  catch(e) { $('#side-status').textContent='中台未连接'; $('#side-dot').className='live-dot off'; $('#alert').textContent=`无法读取中台：${e.message}。请检查服务与本机配置。`; $('#alert').hidden=false; if(!state) render(); if (!quiet) toast('连接失败'); }
  finally { loading=false; }
}
function refreshFromStream() {
  clearTimeout(streamRefresh);
  streamRefresh=setTimeout(()=>{if(loading)refreshFromStream();else refresh(true);},200);
}
async function followStream() {
  for (;;) {
    streamController=new AbortController();
    try {
      const response=await fetch(`/api/stream?after=${streamAfter}`,{headers:{'x-workbench-token':token},signal:streamController.signal});
      if(!response.ok||!response.body)throw new Error('事件流连接失败');
      const reader=response.body.getReader(), decoder=new TextDecoder(); let buffer='';
      for (;;) {
        const {value,done}=await reader.read(); if(done)break;
        buffer+=decoder.decode(value,{stream:true}); let end;
        while((end=buffer.indexOf('\n\n'))!==-1){const event=buffer.slice(0,end);buffer=buffer.slice(end+2);const match=event.match(/^id: (\d+)$/m);if(match){streamAfter=Math.max(streamAfter,Number(match[1]));refreshFromStream();}}
      }
    } catch {}
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
}
function runRows(runs, compact=false) { return runs.length ? runs.map(r=>`<div class="row"><div class="chip">↗</div><div class="row-main"><div class="row-title">${esc(r.rule)} <span class="muted">#${esc(r.id)}</span></div><div class="row-sub">${esc(r.summary || r.error || `${r.agent} · ${fmt(r.createdAt)}`)}</div>${!compact?`<div class="row-sub">${esc(r.agent)} · ${fmt(r.createdAt)} ${r.attempts ? `· 重试 ${r.attempts} 次` : ''}</div>`:''}</div>${status(r.state)}<div class="row-actions">${btn('详情','why',r.id)}${['claimed','queued','unknown'].includes(r.state)?btn('停止','cancel',r.id,'danger'):''}</div></div>`).join('') : empty('还没有运行记录','↗'); }
function cardRows(cards, recent=false) { return cards.length ? cards.map(c=>`<div class="row"><div class="chip">◇</div><div class="row-main"><div class="row-title">${esc(c.title)} <span class="muted">#${esc(c.id)}</span></div><div class="row-sub">${esc(c.text)} · ${fmt(c.createdAt)}</div></div>${status(c.state)}<div class="row-actions">${btn(recent?'查看':'处理','card',c.id)}</div></div>`).join('') : empty(recent?'暂无已处理卡片':'当前没有需要处理的事项'); }
function overview() { const s=state,t=s.totals||{},sp=s.spending?.today||{}; return `<div class="grid metrics"><div class="metric"><div class="metric-top">需要关注 <span class="metric-icon">◇</span></div><strong>${num(t.attention)}</strong><small>等待你处理的卡片</small></div><div class="metric"><div class="metric-top">正在运行 <span class="metric-icon">↗</span></div><strong>${num(t.running)}</strong><small>${num(t.queued)} 轮正在排队</small></div><div class="metric"><div class="metric-top">今日完成 <span class="metric-icon">✓</span></div><strong>${num(t.doneToday)}</strong><small>系统时区 ${esc(s.timezone)}</small></div><div class="metric"><div class="metric-top">今日 Token <span class="metric-icon">✳</span></div><strong>${num(sp.tokens)}</strong><small>${num(sp.missingTokens)} 轮未上报用量</small></div></div><div class="grid overview-grid"><div class="stack">${panel('最近运行','最近的自动化活动',runRows((s.runs||[]).slice(0,5),true),'<button class="link-button" data-nav="runs">查看全部 →</button>')}${panel('需要你处理','等待决定或确认的事项',cardRows((s.cards||[]).slice(0,3)),'<button class="link-button" data-nav="cards">查看全部 →</button>')}</div><div class="stack">${panel('系统状态','连接与运行概况',`<div class="panel-body stat-list"><div class="stat-line"><span>在线 Agent</span><strong>${(s.agents||[]).filter(a=>a.online).length} / ${(s.agents||[]).length}</strong></div><div class="stat-line"><span>在线通道</span><strong>${(s.channels||[]).filter(a=>a.online).length} / ${(s.channels||[]).length}</strong></div><div class="stat-line"><span>生效规则</span><strong>${(s.lines||[]).length}</strong></div><div class="stat-line"><span>等待复查</span><strong>${(s.timers||[]).length}</strong></div></div>`,'<button class="link-button" data-nav="connections">查看连接 →</button>')}${panel('用量概览','今天已结束的轮次',`<div class="panel-body stat-list"><div class="stat-line"><span>已结束</span><strong>${num(sp.rounds)} 轮</strong></div><div class="stat-line"><span>已上报费用</span><strong>$${Number(sp.cost||0).toFixed(4)}</strong></div><div class="stat-line"><span>未上报费用</span><strong>${num(sp.missingCost)} 轮</strong></div><progress max="${Math.max(1,sp.rounds||0)}" value="${Math.max(0,(sp.rounds||0)-(sp.missingCost||0))}" aria-label="已上报费用的轮次"></progress><div class="footnote">用量由 Agent 上报；未上报的费用不会按零计算。</div></div>`)}</div></div>`; }
function cardsPage() { return `<div class="stack">${panel('待处理卡片',`${state.cards.length} 项等待处理`,cardRows(state.cards))}${panel('最近处理','最近 20 张已处理或已关闭的卡片',cardRows(state.recentCards||[],true))}</div>`; }
function runsPage() { const runs=[...(state.runs||[]),...older]; return `<div class="toolbar"><input class="search" id="run-search" placeholder="搜索规则、Agent 或结果"><select id="run-filter"><option value="">所有状态</option>${Object.entries(statusLabels).slice(0,7).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></div>${panel('运行记录',`已加载 ${runs.length} 轮`, `<div id="run-list">${runRows(runs)}</div><div class="panel-body">${nextBefore ? btn('加载更早记录','older') : '<span class="footnote">没有更多记录</span>'}</div>`)}`; }
function ruleRows(lines) { return lines.length ? lines.map(r=>`<div class="row"><div class="chip">⌘</div><div class="row-main"><div class="row-title">${esc(r.name)}</div><div class="row-sub">${esc(r.agent)} · ${esc(r.every || `${r.source}: ${(r.types||[]).join(', ')}`)}${r.next?` · 下次 ${fmt(r.next)}`:''}</div></div>${r.paused?badge('已暂停','amber'):badge('启用中','green')}<div class="row-actions">${btn('编辑','edit-task',r.id)}${btn('运行','rule-run',r.id)}${btn(r.paused?'恢复':'暂停',r.paused?'resume':'pause',r.id)}</div></div>`).join('') : empty('暂无规则','⌘'); }
function rulesPage() { const s=state; return `<div class="stack">${panel('规则',`${(s.lines||[]).length} 条事件或定时规则`,ruleRows(s.lines||[]),btn('编辑规则','edit-rules'))}${panel('等待复查','由 Agent 留下的后续检查', (s.timers||[]).length ? s.timers.map(t=>`<div class="row"><div class="chip">◷</div><div class="row-main"><div class="row-title">${esc(t.rule)} · ${esc(t.key)}</div><div class="row-sub">${esc(t.about||'')} ${t.lane?`· ${esc(t.lane)}`:''}</div></div>${badge(fmt(t.at),'amber')}</div>`).join('') : empty('没有等待复查的事项','◷'))}${panel('外部定时任务','由其他程序运行，中台只展示', (s.elsewhere||[]).length ? s.elsewhere.map(t=>`<div class="row"><div class="row-main"><div class="row-title">${esc(t.name)}</div><div class="row-sub">${esc(t.every)} · ${esc(t.where)} · 下次 ${fmt(t.next)}</div></div></div>`).join('') : empty('没有外部定时任务','◷'))}${panel('暂停时跳过的事件','最近 20 条', (s.skipped||[]).length ? s.skipped.map(e=>`<div class="row"><div class="row-main"><div class="row-title">${esc(e.type)} · ${esc(e.subject)}</div><div class="row-sub">${esc(e.summary)} · ${fmt(e.receivedAt)} · ${esc((e.rules||[]).join('、'))}</div></div></div>`).join('') : empty('没有跳过的事件'))}</div>`; }
function connectionsPage() { const s=state; const connections=(items, desc)=>items.length?items.map(x=>`<div class="row"><div class="chip">◎</div><div class="row-main"><div class="row-title">${esc(x.name)} <span class="muted">${esc(x.id)}</span></div><div class="row-sub">${esc(desc(x))}</div></div>${x.online===undefined?badge(`${num(x.events)} 个事件`):badge(x.online?'在线':'离线',x.online?'green':'')}</div>`).join(''):empty('暂无配置','◎'); return `<div class="grid two-col">${panel('Agent','执行任务的接单程序',connections(s.agents||[],a=>`${a.use} · ${a.worker} · 最近活动 ${fmt(a.seenAt)}`),btn('设置','rules-section','agents'))}${panel('通知通道','发送卡片与通知',connections(s.channels||[],a=>`最近活动 ${fmt(a.seenAt)}`),btn('设置','rules-section','channels'))}${panel('事件来源','可以将事件交给中台',connections(s.sources||[],()=> '已配置的来源'),btn('设置','rules-section','sources'))}${panel('未匹配事件','没有规则接收的最近事件',(s.unrouted||[]).length?(s.unrouted||[]).map(e=>`<div class="row"><div class="row-main"><div class="row-title">${esc(e.type)}</div><div class="row-sub">${esc(e.summary||e.subject||'')}</div></div></div>`).join(''):empty('没有未匹配事件'))}</div>`; }
function toolsPage() { return `<div class="grid two-col">
${panel('服务与安装','安装、连接和运行本机服务',`<div class="panel-body"><p class="muted">可临时启动中台，或安装登录服务自动启动。服务安装会启动或重启中台。</p><div class="toolbar">${btn('临时运行与日志','runtime')}${btn('安装与启动服务','service','install')}${btn('停止并移除服务','service','remove')}${btn('初始化','setup','init')}${btn('加入中台','setup','join')}${btn('连接设置','settings','config')}${btn('环境变量','settings','secrets')}</div></div>`)}
${panel('密钥与插件','管理连接凭据和扩展',`<div class="panel-body"><p class="muted">新密钥仅由创建操作输出，请及时保存；插件安装执行项目原有的 Git 克隆流程。</p><div class="toolbar">${btn('查看密钥','manage','key-list')}${btn('新建密钥','manage','key-new')}${btn('撤销密钥','manage','key-remove')}${btn('安装插件','manage','plugin')}</div></div>`)}
${panel('备份与维护','备份配置和数据，管理程序',`<div class="panel-body"><p class="muted">恢复会替换本机数据，需先停止中台；备份中包含密钥。</p><div class="toolbar">${btn('创建备份','manage','backup')}${btn('恢复备份','manage','restore')}${btn('更新程序','manage','update')}${btn('卸载程序','manage','uninstall')}</div></div>`)}
${panel('诊断与规则','检查安装和规则配置',`<div class="panel-body"><p class="muted">使用项目自身的诊断与检查命令；中台离线时仍可编辑规则。</p><div class="toolbar">${btn('运行诊断','quick-cli','doctor')}${btn('检查规则','quick-cli','check')}${btn('编辑规则','edit-rules')}${btn('规则说明','quick-cli','rules explain')}${btn('查看版本','quick-cli','--version')}</div></div>`)}
${panel('事件入口','向已配置的本机来源发送事件',`<div class="panel-body"><p class="muted">事件按现有规则路由；可先预演匹配结果。</p><div class="toolbar">${btn('发送事件','event')}${btn('开始试跑','try')}${btn('发送通知','manage','tell')}</div></div>`)}
${panel('更多工具','提问、测试和操作记录',`<div class="panel-body"><p class="muted">后台操作运行期间可关闭结果窗口。</p><div class="toolbar">${btn('更多操作','cli')}${btn('操作记录','jobs')}${btn('MCP 接入','mcp')}</div></div>`)}
${panel('连接信息','当前工作台使用的位置',`<div class="panel-body stat-list"><div class="stat-line"><span>数据目录</span><strong>${esc(info?.home||'—')}</strong></div><div class="stat-line"><span>项目目录</span><strong>${esc(info?.app||'—')}</strong></div><div class="stat-line"><span>规则文件</span><strong>${esc(info?.rulesFile||'—')}</strong></div><p class="footnote">工作台只监听本机；Agent 和中台按原配置运行。</p></div>`)}</div>`; }
function render() { $('#page-title').textContent=labels[page][0]; $('#page-description').textContent=labels[page][1]; $('#breadcrumb').textContent=labels[page][0]; $('#primary').disabled=false; $('#primary').textContent='＋ 新建任务'; document.querySelectorAll('#nav button').forEach(b=>b.classList.toggle('active',b.dataset.page===page)); $('#view').innerHTML=!state && page!=='tools' ? panel('无法连接中台','请检查中台服务后重试',empty('工具箱仍可用于运行诊断和检查配置','◎'),'<button class="link-button" data-nav="tools">打开工具箱 →</button>') : ({overview,cards:cardsPage,runs:runsPage,rules:rulesPage,connections:connectionsPage,tools:toolsPage})[page](); }
const values = (form) => Object.fromEntries(new FormData(form).entries());
const form = (inside, label='执行') => `<form id="action-form">${inside}<div class="actions"><button type="button" class="button" data-action="close">取消</button><button type="submit" class="button primary">${label}</button></div></form>`;
function bindForm(handler) { $('#action-form').addEventListener('submit', async e=>{e.preventDefault(); const button=e.submitter || e.currentTarget.querySelector('[type="submit"]'); if(button)button.disabled=true; try{await handler(values(e.currentTarget));}catch(error){toast(error.message);}finally{if(button)button.disabled=false;}}); }
async function action(kind,id,data={}) { const result=await post('/api/action',{kind,id,data}); closeModal(); toast('操作已提交'); await refresh(true); return result; }
function showRun(rule='') { const opts=(state.lines||[]).map(r=>`<option value="${esc(r.id)}" ${r.id===rule?'selected':''}>${esc(r.name)}${r.paused?'（已暂停）':''}</option>`).join(''); if(!opts)return toast('当前没有规则'); modal('立即运行规则',form(`<label class="form-field">规则<select name="rule">${opts}</select></label>${field('对象（可选）','subject','并行规则的事项标识')}${field('运行说明（可选）','reason','为什么运行这一轮')}`,'运行')); bindForm(v=>action('run',v.rule,Object.fromEntries(Object.entries({subject:v.subject,reason:v.reason}).filter(([,x])=>x)))); }
function showCard(id) { const c=[...(state.cards||[]),...(state.recentCards||[])].find(x=>x.id===Number(id)); if(!c)return; const open=c.state==='open'; const options=open && c.kind==='ask' ? `<label class="form-field">选择一个选项<select name="choice"><option value="">不选择，使用文字回答</option>${c.options.map((o,i)=>`<option value="${i}">${esc(o)}${c.recommend===i?'（推荐）':''}</option>`).join('')}</select></label>`:''; const detail=`<p class="detail-text">${esc(c.text)}</p><p class="footnote">规则：${esc(c.rule||'—')} · 创建于 ${fmt(c.createdAt)}${c.lane?` · 事项：${esc(c.lane)}`:''}</p>${c.about?`<p class="footnote">后续说明：${esc(c.about)}</p>`:''}${!open?`<p class="detail-text">处理结果：${esc(c.result || c.answer || (c.choice!=null?c.options[c.choice]:'—'))}</p>`:''}`; modal(c.title,open?form(`${detail}${options}${textarea(c.kind==='ask'?'文字回答（可选）':'处理说明（可选）','text','填写回答或处理说明')}<div class="toolbar">${btn('直接结案','resolve',c.id,'danger')}</div>`,'提交回答'):detail); if(open)bindForm(v=>{if(c.kind==='ask'&&!v.text&&v.choice==='')throw new Error('请选择选项或填写回答');const data={}; if(v.choice!==undefined&&v.choice!=='')data.choice=Number(v.choice); if(v.text)data.text=v.text; return action('answer',c.id,data);}); }
function showPause(id) { modal('暂停规则',form(`<p class="footnote">暂停期间的新事件不会交给这条规则；已经运行的轮次继续运行。</p>${field('原因（可选）','reason')}${field('自动恢复时间（可选）','until','','','datetime-local')}`,'暂停')); bindForm(v=>{const data={};if(v.reason)data.reason=v.reason;if(v.until)data.until=new Date(v.until).toISOString();return action('pause',id,data);}); }
function showEvent() { modal('发送事件',form(`<label class="form-field">事件来源<select name="source_mode"><option value="local">本机来源</option><option value="other">使用其他来源密钥</option></select></label><div id="event-source-key" hidden>${field('其他来源密钥','source_key','','','password')}</div>${field('事件类型','type','例如 feedback.new')}${field('事件 ID','id','留空自动生成')}${field('对象（可选）','subject','#12')}${field('摘要（可选）','summary')}${textarea('详情（可选）','detail')}${field('链接（可选）','link','https://')}<button type="button" class="button" data-action="preview-event">预演匹配</button><pre id="event-preview" hidden></pre>`,'发送事件')); const element=$('#action-form');element.elements.source_mode.addEventListener('change',()=>{$('#event-source-key').hidden=element.elements.source_mode.value!=='other';});bindForm(async v=>{if(!v.type)throw new Error('请填写事件类型');const key=v.source_mode==='other'?v.source_key:undefined;if(v.source_mode==='other'&&!key)throw new Error('请填写来源密钥');delete v.source_mode;delete v.source_key;v.id ||= crypto.randomUUID();Object.keys(v).forEach(k=>{if(!v[k])delete v[k]});const r=await post('/api/action',{kind:'event',data:v,...(key?{sourceKey:key}:{})});closeModal();toast(`事件已提交，匹配 ${r.routed?.length||0} 条规则`);await refresh(true);}); }
async function quickCli(command) { const r=await post('/api/cli',{args:command.split(' ')}); modal('命令结果',`<p class="footnote">退出码：${esc(r.code)}${r.timedOut?' · 等待超时':''}</p><pre>${esc(r.output||'（无输出）')}</pre>`); }
async function startJob(args, input='') {
  const job=await post('/api/jobs',{args,input});
  await showJob(job.id);
}
async function showJob(id) {
  modal('操作结果',`<div id="job-detail" data-job-id="${esc(id)}"><p id="job-status" class="footnote">正在运行，可关闭此窗口后从操作记录查看。</p><pre id="job-output">等待输出…</pre></div>`);
  async function poll() {
    if (!document.querySelector(`#job-detail[data-job-id="${id}"]`)) return;
    try {
      const j=await api(`/api/jobs/${id}`);
      if (!document.querySelector(`#job-detail[data-job-id="${id}"]`)) return;
      $('#job-status').textContent=j.done?`已结束 · 退出码 ${j.code ?? '无'}${j.error ? ` · ${j.error}` : ''}${j.truncated?' · 输出已截断':''}`:'正在运行，可关闭此窗口后从操作记录查看。';
      $('#job-output').textContent=j.output || (j.done?'（无输出）':'等待输出…');
      if (!j.done) setTimeout(poll,1000); else refresh(true);
    } catch(e) { if($('#job-status'))$('#job-status').textContent=e.message; }
  }
  await poll();
}
async function showJobs() {
  const jobs=await api('/api/jobs');
  modal('操作记录',jobs.length ? jobs.map(j=>`<div class="row"><div class="row-main"><div class="row-title">${esc(j.command)}</div><div class="row-sub">${fmt(j.startedAt)}</div></div>${badge(j.done?`退出码 ${j.code ?? '无'}`:'运行中',j.done?(j.code===0?'green':'red'):'amber')}${btn('查看','job',j.id)}</div>`).join('') : empty('本次工作台启动后还没有运行命令'));
}
async function showRuntime() {
  modal('临时运行与日志',`<div id="runtime-detail"><p class="footnote">临时运行只管理由此工作台启动的进程；关闭工作台时该进程也会停止。已有登录服务请使用服务管理。</p><p id="runtime-status" class="footnote">正在读取…</p><div class="toolbar">${btn('启动','runtime-start')}${btn('停止','runtime-stop')}</div><pre id="runtime-log">等待输出…</pre></div>`);
  async function poll() {
    if(!$('#runtime-detail'))return;
    try { const r=await api('/api/runtime'); if(!$('#runtime-detail'))return; $('#runtime-status').textContent=r.state==='running'?`工作台启动的进程运行中 · PID ${r.pid}`:`工作台启动的进程未运行${r.code!==null&&r.code!==undefined?` · 退出码 ${r.code}`:''}`; $('#runtime-log').textContent=r.output||'（暂无输出）'; }
    catch(e){if($('#runtime-status'))$('#runtime-status').textContent=e.message;}
    if($('#runtime-detail'))setTimeout(poll,1000);
  }
  await poll();
}
const kindSelect = `<label class="form-field">密钥类型<select name="kind"><option value="source">事件来源</option><option value="worker">接单程序</option><option value="channel">通知通道</option><option value="owner">本人</option></select></label>`;
async function manage(which) {
  if(which==='key-list')return startJob(['key','list']);
  if(which==='update'||which==='uninstall') {
    if(confirm(which==='update'?'更新程序并按项目配置重启服务？':'卸载程序和服务，保留数据？'))return startJob(which==='update'?['update']:['uninstall','--yes']);
    return;
  }
  const externalTasks=which==='tell'?((await readRulesForm()).data.elsewhere||[]):[];
  const specs={
    'key-new':['新建密钥',`${kindSelect}${field('名称','name','小写字母、数字和连字符')}`,v=>['key','new',v.kind,v.name]],
    'key-remove':['撤销密钥',`${kindSelect}${field('名称','name','要撤销的密钥名称')}`,v=>['key','remove',v.kind,v.name]],
    'plugin':['安装插件',field('Git 仓库地址','url','https://github.com/owner/plugin.git'),v=>['add',v.url]],
    'backup':['创建备份',directoryField('目标目录（可选）','path','留空使用默认备份目录'),v=>['backup',...(v.path?[v.path]:[])]],
    'restore':['恢复备份',`<p class="footnote">恢复将替换本机数据库、主密钥、配置、规则和密钥环境变量。请先停止中台。</p>${directoryField('备份目录','path','备份文件所在目录')}`,v=>['restore',v.path,'--yes']],
    'tell':['发送通知',`${field('事项编号','key','用于去重')}${selectField('发送身份','task',option('','本机来源')+externalTasks.map(t=>option(t.name,`外部任务：${t.name}`)).join(''))}${textarea('通知内容','text')}`,v=>['tell',v.key,...(v.task?['--task',v.task]:[])]],
  };
  const spec=specs[which]; if(!spec)return;
  modal(spec[0],form(spec[1],spec[0]));
  bindForm(async v=>{
    if ((which==='key-new'||which==='key-remove')&&!v.name)throw new Error('请填写名称');
    if(which==='plugin'&&!v.url)throw new Error('请填写仓库地址');
    if(which==='restore'&&!v.path)throw new Error('请填写备份目录');
    if(which==='tell'&&(!v.key||!v.text))throw new Error('请填写事项编号和通知内容');
    if(['key-new','key-remove','plugin','restore'].includes(which)&&!confirm(`确定${spec[0]}？`))return;
    await startJob(spec[2](v),which==='tell'?v.text:'');
  });
}
function setup(kind) {
  if(kind==='init') {
    modal('初始化本机',form(`<p class="footnote">已有配置不会被覆盖。命令 Agent 按空白分割参数，复杂路径可初始化后在规则编辑器调整。</p><label class="form-field">Agent<select name="agent"><option value="">自动发现</option><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="command">自定义命令</option></select></label>${field('自定义命令','command','例如 node {prompt}')}${field('中台端口','port','3350','3350','number')}<label class="form-field"><span><input type="checkbox" name="service" value="yes"> 同时安装登录服务</span></label>`,'初始化'));
    bindForm(async v=>{const args=['init','--port',v.port||'3350'];if(v.agent==='command'){if(!v.command)throw new Error('请填写自定义命令');args.push('--command',v.command);}else if(v.agent)args.push('--agent',v.agent);if(!v.service)args.push('--no-service');if(confirm('确定初始化本机？'))await startJob(args);});
  } else {
    modal('加入中台',form(`<p class="footnote">本机已有配置时项目会拒绝覆盖。</p>${field('中台地址','url','https://hub.example')}${field('接单程序名称','worker','worker-1')}${field('接单程序密钥','key','','','password')}<label class="form-field"><span><input type="checkbox" name="service" value="yes"> 同时安装登录服务</span></label>`,'加入'));
    bindForm(async v=>{if(!v.url||!v.worker||!v.key)throw new Error('请填写地址、名称和密钥');const args=['join',v.url,'--worker',v.worker,'--key',v.key];if(!v.service)args.push('--no-service');if(confirm('确定加入该中台？'))await startJob(args);});
  }
}
async function clickAction(a,id) { switch(a) {
  case 'close': if(rulesDirty&&!confirm('草稿尚未保存，确定关闭？'))return;rulesDirty=false;closeModal();break;
  case 'why':await startJob(['why',id]);break;
  case 'card':showCard(id);break;
  case 'resolve':modal('直接结案',form(field('结案原因','reason','说明为什么不再需要决定'),'结案'));bindForm(v=>{if(!v.reason)throw new Error('请填写结案原因');return action('resolve',Number(id),{reason:v.reason});});break;
  case 'cancel':if(confirm(`确定停止第 ${id} 轮？`)){await post('/api/action',{kind:'cancel',id:Number(id),data:{}});toast('已请求停止');await refresh(true);}break;
  case 'rule-run':showRun(id);break;
  case 'edit-task':await showTaskForm(id);break;
  case 'pause':showPause(id);break;
  case 'resume':if(confirm(`确定恢复规则「${id}」？`)){await post('/api/action',{kind:'resume',id,data:{}});toast('规则已恢复');await refresh(true);}break;
  case 'older':{const result=await api(`/api/state?before=${nextBefore}`);const known=new Set([...(state.runs||[]),...older].map(r=>r.id));older.push(...result.runs.filter(r=>!known.has(r.id)));nextBefore=result.nextBefore;render();break;}
  case 'edit-rules':if(rulesDirty&&!confirm('重新加载会丢弃未保存的草稿，确定继续？'))return; if($('#dialog').open)closeModal();await showRulesSettings();break;
  case 'rules-section':if(rulesDirty&&!confirm('草稿尚未保存，确定离开？'))return;if($('#dialog').open)closeModal();await showRulesSettings(id);break;
  case 'settings':if(rulesDirty&&!confirm('重新加载会丢弃未保存的草稿，确定继续？'))return;if($('#dialog').open)closeModal();if(id==='config')await showConnectionSettings();else await showSecrets();break;
  case 'secret-edit':await editSecret(id);break;
  case 'secret-view':await viewSecret(id);break;
  case 'secret-remove':await removeSecret(id);break;
  case 'event':showEvent();break;
  case 'try':{if(!confirm('开始试跑会发送 try.start 事件并调用已配置的 Agent。继续？'))return;const stamp=Date.now();const r=await post('/api/action',{kind:'event',data:{id:`try-${stamp}`,type:'try.start',subject:`#${stamp}`}});toast(r.routed?.length?'试跑已启动，请在待处理卡片查看进展':'事件已记录，但没有规则接收 try.start');await refresh(true);break;}
  case 'preview-event':{const v=values($('#action-form'));if(!v.type)throw new Error('请填写事件类型');if(v.source_mode==='other')throw new Error('预演只支持本机来源');const args=['emit',v.type,'--dry-run'];for(const name of ['id','subject','summary','detail','link'])if(v[name])args.push(`--${name}`,v[name]);const r=await post('/api/cli',{args});const output=$('#event-preview');output.hidden=false;output.textContent=r.output||'（无输出）';break;}
  case 'manage':await manage(id);break;
  case 'setup':setup(id);break;
  case 'service':if(confirm(id==='install'?'安装登录服务，并启动或重启中台？':'停止并移除登录服务？'))await startJob(['service',id]);break;
  case 'runtime':await showRuntime();break;
  case 'runtime-start':if(confirm('临时启动中台和已配置的接单程序、通道？')){await post('/api/runtime',{action:'start'});toast('已请求启动');}break;
  case 'runtime-stop':if(confirm('停止由工作台启动的中台和接单程序？')){await post('/api/runtime',{action:'stop'});toast('已请求停止');}break;
  case 'jobs':await showJobs();break;
  case 'job':await showJob(id);break;
  case 'mcp':showMcpInfo();break;
  case 'copy-value':{const element=document.getElementById(id);await navigator.clipboard.writeText(element.value);toast('已复制');break;}
  case 'choose-directory':{const value=await window.workbench.chooseDirectory();if(value){const element=document.getElementById(id);if(element){element.value=value;element.dispatchEvent(new Event('input',{bubbles:true}));}}break;}
  case 'choose-file':{const value=await window.workbench.chooseFile();if(value){const element=document.getElementById(id);if(element){element.value=value;element.dispatchEvent(new Event('input',{bubbles:true}));}}break;}
  case 'check-file':showCheckFile();break;
  case 'ask-form':await showQuestionForm();break;
  case 'probe-form':showProbeForm();break;
  case 'cli':showGuidedTools();break;
  case 'quick-cli':await quickCli(id);break;
}}
document.addEventListener('click',async e=>{const navButton=e.target.closest('[data-page],[data-nav]');if(navButton){nav(navButton.dataset.page||navButton.dataset.nav);return;}const button=e.target.closest('[data-action]');if(!button)return;button.disabled=true;try{await clickAction(button.dataset.action,button.dataset.id);}catch(error){toast(error.message);const result=$('#rules-result')||$('#settings-result');if(result)result.textContent=error.message;}finally{button.disabled=false;}});
function filterRuns() { const q=($('#run-search')?.value||'').toLowerCase(), f=$('#run-filter')?.value||''; const list=$('#run-list'); if(list)list.innerHTML=runRows([...(state.runs||[]),...older].filter(r=>(!f||r.state===f)&&`${r.rule} ${r.agent} ${r.summary} ${r.error}`.toLowerCase().includes(q))); }
document.addEventListener('input',e=>{if(e.target.id==='run-search'||e.target.id==='run-filter')filterRuns();});
$('#dialog-close').addEventListener('click',()=>{if(rulesDirty&&!confirm('草稿尚未保存，确定关闭？'))return;rulesDirty=false;closeModal();});
$('#dialog').addEventListener('cancel',e=>{if(rulesDirty&&!confirm('草稿尚未保存，确定关闭？'))e.preventDefault();else rulesDirty=false;});
$('#refresh').addEventListener('click',()=>refresh()); $('#primary').addEventListener('click',()=>showTaskForm().catch(e=>toast(e.message)));
Promise.allSettled([api('/api/info').then(x=>info=x),refresh()]).then(()=>{if(page==='tools')render();});
setInterval(()=>refresh(true),15000);
