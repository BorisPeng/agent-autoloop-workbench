// Form-based editing uses the original validators and retains fields the form does not change.
const option = (value, label, selected=false) => `<option value="${esc(value)}"${selected?' selected':''}>${esc(label)}</option>`;
const selectField = (label, name, options) => `<label class="form-field">${esc(label)}<select name="${esc(name)}">${options}</select></label>`;
const nonempty = value => typeof value === 'string' && value.trim() !== '';
const scheduleParts=[['minute','分钟',0,59],['hour','小时',0,23],['day','日期',1,31],['month','月份',1,12],['weekday','星期',0,6]];
function schedulePicker() {
  return `<div class="schedule-picker"><p class="footnote">不勾选表示不限；勾选后只在选中的时间运行。</p>${scheduleParts.map(([key,label,min,max])=>`<details class="schedule-part"><summary>${label}</summary><div class="schedule-options">${Array.from({length:max-min+1},(_,i)=>i+min).map(n=>`<label><input type="checkbox" data-schedule="${key}" value="${n}">${key==='weekday'?`星期${['日','一','二','三','四','五','六'][n]}`:n}</label>`).join('')}</div></details>`).join('')}<label class="form-field">同时指定日期和星期时<select data-schedule-relation><option value="either">满足其中之一</option><option value="both">两者都满足</option></select></label></div>`;
}
function scheduleValue(container) {
  const chosen=Object.fromEntries(scheduleParts.map(([key])=>[key,[...container.querySelectorAll(`[data-schedule="${key}"]:checked`)].map(x=>Number(x.value)).sort((a,b)=>a-b)]));
  if(scheduleParts.every(([key])=>chosen[key].length===0))throw new Error('请至少选择一项时间条件；如需每分钟运行，请选择“每隔几分钟”');
  const values=Object.fromEntries(scheduleParts.map(([key])=>[key,chosen[key].length?chosen[key].join(','):'*']));
  if(chosen.day.length&&chosen.weekday.length&&container.querySelector('[data-schedule-relation]').value==='both') {
    const key=chosen.day.includes(1)?'day':chosen.weekday.includes(0)?'weekday':null;
    if(!key)throw new Error('原系统的定时规则无法表示这组“同时满足”条件；请选择日期 1 或星期日，或改为满足其中之一');
    const minimum=key==='day'?1:0,rest=chosen[key].filter(n=>n!==minimum);values[key]=`*/999${rest.length?`,${rest.join(',')}`:''}`;
  }
  return scheduleParts.map(([key])=>values[key]).join(' ');
}

async function readRulesForm() {
  const result=await api('/api/rules');
  let data; try { data=JSON.parse(result.text); } catch { throw new Error('现有规则文件无法读取，请先修复规则文件或从备份恢复。'); }
  return {data,hash:result.hash};
}
async function writeRulesForm(data, hash) {
  return post('/api/rules',{text:JSON.stringify(data,null,2)+'\n',hash,save:true});
}
function modelSupport(agent) {
  if (!agent) return {model:false,effort:false};
  if (agent.use==='codex'||agent.use==='claude') return {model:true,effort:true};
  if (agent.use==='command') return {model:(agent.command||[]).some(x=>x.includes('{model}')),effort:(agent.command||[]).some(x=>x.includes('{effort}'))};
  return {model:false,effort:false};
}
async function showTaskForm(name='') {
  const {data,hash}=await readRulesForm();
  const [modelData,capabilities]=await Promise.all([api('/api/models'),api('/api/capabilities').catch(()=>({}))]);
  const models=modelData.models||[];features=capabilities;
  const original=name ? (data.rules||[]).find(r=>r.name===name) : null;
  if(name&&!original)throw new Error('没有找到这个任务，请刷新后重试');
  const agents=Object.entries(data.agents||{}), sources=Object.entries(data.sources||{}).filter(([id])=>id!=='schedule');
  if(!agents.length)throw new Error('请先在连接设置中添加 Agent');
  const selectedAgent=original?.to||agents[0][0];
  const source=original?.when?.source || (data.sources?.local?'local':sources[0]?.[0]);
  const title=name?'编辑任务':'新建任务';
  const advanced=(capabilities.ruleTitle?`${field('会话标题（可选）','session_title','例如 任务-{id}，不能含空格',original?.title||'')}<p class="footnote">可用 {id} 或 {subject} 区分事项。Codex 的提示词前还有自身说明，标题不一定是会话第一行。</p>`:'')+(capabilities.ruleMaxActive?`${field('此任务同时执行上限（可选）','max_active','留空表示不单独限制',original?.maxActive??'','number')}<p class="footnote">任务、Agent、并发组和接单程序的上限会共同生效。</p>`:'');
  const triggers=(name ? option('keep','保持当前触发方式',true) : '')+
    option('manual','手动运行',!name)+option('minutes','每隔几分钟')+option('hourly','每小时')+option('daily','每天定时')+option('weekdays','工作日定时')+option('weekly','每周定时')+option('monthly','每月定时')+option('custom','自定义时间')+option('event','收到事件时');
  modal(title,form(`${field('任务名称','name','例如：整理本周资料',original?.name||'')}${textarea('任务描述','prompt','描述希望 Agent 完成的事情',original?.prompt||'')}${directoryField('工作目录','cwd','选择或填写任务的工作目录',original?.cwd||'')}${selectField('执行的 Agent','agent',agents.map(([id,a])=>option(id,`${a.name||id}（${id}）`,id===selectedAgent)).join(''))}<div id="task-model-fields"></div>${selectField('操作权限','task_access',option('__inherit__','使用所选 Agent 的权限',true)+option('read','只读')+option('edit','可编辑工作目录')+option('full','完全访问'))}${advanced?`<details class="tree-group"><summary>更多任务设置</summary><div class="tree-body">${advanced}</div></details>`:''}${selectField('触发方式','trigger',triggers)}<div id="task-schedule" hidden>${selectField('间隔','interval',[1,5,10,15,20,30].map(n=>option(String(n),`${n} 分钟`,n===5)).join(''))}${field('每小时的第几分钟','hour_minute','0 到 59','0','number')}${field('时间','time','','09:00','time')}${selectField('星期','weekday',['日','一','二','三','四','五','六'].map((d,i)=>option(String(i),`星期${d}`,i===1)).join(''))}${field('每月的日期','monthday','1 到 31','1','number')}</div><div id="task-custom-schedule" hidden>${schedulePicker()}</div><div id="task-event" hidden>${selectField('事件来源','source',sources.map(([id,s])=>option(id,s.name||id,id===source)).join(''))}${field('事件类型','types','例如 feedback.new，多个类型用逗号分隔',original?.when?.types?.join(', ')||'')}</div><p class="footnote">保存后可在规则列表中手动运行。已领取的轮次保留原设置。</p>`,'保存任务'));
  const formEl=$('#action-form');
  function updateAgent() {
    const id=formEl.elements.agent.value, agent=data.agents[id], support=modelSupport(agent);
    if(!support.model&&!support.effort){$('#task-model-fields').innerHTML='<p class="footnote">此 Agent 的接入方式不支持在这里设置模型或思考强度，将使用它自身的配置。</p>';return;}
    const choices=agent.use==='codex' ? models : agent.use==='claude'?[{id:'sonnet',name:'Sonnet'},{id:'opus',name:'Opus'}]:[];
    const currentModel=agent.model||'', known=choices.some(m=>m.id===currentModel);
    const modelOptions=option('','使用程序默认模型',!currentModel)+choices.map(m=>option(m.id,m.name,m.id===currentModel)).join('')+option('__custom__','填写其他模型',Boolean(currentModel&&!known));
    const currentEffort=agent.effort||'';
    const tier=agent.use==='codex'&&capabilities.agentTier?selectField('服务档位','tier',option('__inherit__',`沿用 Agent 设置${agent.tier?`（${agent.tier}）`:''}`,true)+option('__default__','使用 Codex 默认')+option('priority','优先（Fast）')+option('__custom__','填写其他档位'))+`<div id="custom-tier" hidden>${field('其他服务档位','tier_custom')}</div>`:'';
    $('#task-model-fields').innerHTML=(support.model?selectField('模型','model',modelOptions)+`<div id="custom-model"${currentModel&&!known?'':' hidden'}>${field('其他模型 ID','model_custom','填写 Agent 支持的模型',currentModel&&!known?currentModel:'')}</div>`:'')+(support.effort?selectField('思考强度','effort',''):'')+tier+'<p class="footnote">模型列表来自本机缓存；可用性取决于所选 Agent 和账号。</p>';
    function updateEfforts(preferred, preserveExisting=false) {
      const selected=choices.find(m=>m.id===formEl.elements.model?.value);
      const efforts=selected?.efforts?.length?selected.efforts:agent.use==='claude'?['low','medium','high','xhigh','max']:['low','medium','high','xhigh','max','ultra'];
      const names={low:'低',medium:'中',high:'高',xhigh:'很高',max:'最大',ultra:'极高'};
      const allowed=!preferred||efforts.includes(preferred);
      formEl.elements.effort.innerHTML=option('','使用程序默认强度',!preferred||(!allowed&&!preserveExisting))+efforts.map(e=>option(e,names[e]||e,e===preferred)).join('')+(!allowed&&preserveExisting?option(preferred,`${preferred}（当前设置）`,true):'');
      if(!allowed&&!preserveExisting)toast('所选模型不支持原思考强度，已选择默认');
    }
    if(support.effort)updateEfforts(currentEffort,true);
    formEl.elements.model?.addEventListener('change',()=>{const custom=$('#custom-model');if(custom)custom.hidden=formEl.elements.model.value!=='__custom__';if(support.effort)updateEfforts(formEl.elements.effort.value);});
    formEl.elements.tier?.addEventListener('change',()=>{$('#custom-tier').hidden=formEl.elements.tier.value!=='__custom__';});
  }
  function updateTrigger() { const kind=formEl.elements.trigger.value; $('#task-schedule').hidden=!['minutes','hourly','daily','weekdays','weekly','monthly'].includes(kind);$('#task-custom-schedule').hidden=kind!=='custom'; $('#task-event').hidden=kind!=='event';formEl.elements.interval.closest('label').hidden=kind!=='minutes';formEl.elements.hour_minute.closest('label').hidden=kind!=='hourly';formEl.elements.weekday.closest('label').hidden=kind!=='weekly';formEl.elements.monthday.closest('label').hidden=kind!=='monthly';formEl.elements.time.closest('label').hidden=!['daily','weekdays','weekly','monthly'].includes(kind); }
  formEl.elements.agent.addEventListener('change',updateAgent); formEl.elements.trigger.addEventListener('change',updateTrigger);updateAgent();updateTrigger();
  formEl.addEventListener('input',()=>rulesDirty=true);
  bindForm(async v=>{
    if(!nonempty(v.name)||!nonempty(v.cwd))throw new Error('请填写任务名称和工作目录');
    if(original&&v.name.trim()!==name&&!confirm('更改任务名称后，已有卡片和等待中的事项仍关联原名称。确定更改？'))return;
    const originalAgent=data.agents[v.agent], support=modelSupport(originalAgent);
    if(!nonempty(v.prompt)&&!original?.skill&&originalAgent.use!=='command')throw new Error('请填写任务描述');
    const selectedModel=support.model?(v.model==='__custom__'?v.model_custom:v.model):undefined;
    if(v.model==='__custom__'&&!nonempty(selectedModel))throw new Error('请填写模型 ID');
    const selectedEffort=support.effort?v.effort:undefined;
    const selectedTier=v.tier==='__inherit__'?originalAgent.tier||'':v.tier==='__default__'?'':v.tier==='__custom__'?v.tier_custom:v.tier;
    if(v.tier==='__custom__'&&!nonempty(selectedTier))throw new Error('请填写服务档位');
    let agentId=v.agent;
    const accessChanged=v.task_access!=='__inherit__' && v.task_access!==(originalAgent.access||'edit');
    const tierChanged=v.tier!==undefined&&(selectedTier||'')!==(originalAgent.tier||'');
    if((support.model&&(selectedModel||'')!==(originalAgent.model||''))||(support.effort&&(selectedEffort||'')!==(originalAgent.effort||''))||accessChanged||tierChanged) {
      if(originalAgent.maxActive&&!confirm('单独设置会创建一个独立 Agent，它的并发上限会单独计算，不再与原 Agent 共用。确定继续？'))return;
      agentId=`wb-${crypto.randomUUID().slice(0,12)}`;
      const clone={...originalAgent,name:`${originalAgent.name||v.agent} · ${v.name}`};
      if(support.model){if(nonempty(selectedModel))clone.model=selectedModel.trim();else delete clone.model;}
      if(support.effort){if(nonempty(selectedEffort))clone.effort=selectedEffort;else delete clone.effort;}
      if(accessChanged)clone.access=v.task_access;
      if(tierChanged){if(nonempty(selectedTier))clone.tier=selectedTier.trim();else delete clone.tier;}
      data.agents[agentId]=clone;
    }
    let when=original?.when;
    if(v.trigger==='manual') { if(!sources.length)throw new Error('请先添加事件来源');when={source:data.sources.local?'local':sources[0][0],types:[`workbench.${crypto.randomUUID().slice(0,8)}`]}; }
    if(v.trigger==='event') { const types=(v.types||'').split(/[,，\n]/).map(x=>x.trim()).filter(Boolean);if(!v.source||!types.length)throw new Error('请选择来源并填写事件类型');when={source:v.source,types}; }
    if(v.trigger==='custom')when={cron:scheduleValue($('#task-custom-schedule'))};
    if(['minutes','hourly','daily','weekdays','weekly','monthly'].includes(v.trigger)) {
      const [hour,minute]=(v.time||'09:00').split(':').map(Number);
      if(['daily','weekdays','weekly','monthly'].includes(v.trigger)&&(!Number.isInteger(hour)||hour<0||hour>23||!Number.isInteger(minute)||minute<0||minute>59))throw new Error('请选择有效时间');
      if(v.trigger==='hourly'&&(!/^\d+$/.test(v.hour_minute)||Number(v.hour_minute)>59))throw new Error('每小时的分钟数需要在 0 到 59 之间');
      if(v.trigger==='monthly'&&(!/^\d+$/.test(v.monthday)||Number(v.monthday)<1||Number(v.monthday)>31))throw new Error('每月日期需要在 1 到 31 之间');
      const day=v.trigger==='monthly'?v.monthday:'*',week=v.trigger==='weekly'?v.weekday:v.trigger==='weekdays'?'1-5':'*';
      when={cron:v.trigger==='minutes'?`*/${v.interval} * * * *`:v.trigger==='hourly'?`${v.hour_minute} * * * *`:`${minute} ${hour} ${day} * ${week}`};
    }
    if(!when)throw new Error('请选择触发方式');
    const task={...(original||{}),name:v.name.trim(),when,to:agentId,cwd:v.cwd.trim()};
    if(capabilities.ruleTitle){if(nonempty(v.session_title))task.title=v.session_title.trim();else delete task.title;}
    if(capabilities.ruleMaxActive){if(v.max_active){if(!/^[1-9]\d*$/.test(v.max_active))throw new Error('同时执行上限需要是正整数');task.maxActive=Number(v.max_active);}else delete task.maxActive;}
    if(nonempty(v.prompt))task.prompt=v.prompt;else delete task.prompt;
    if(original){const index=data.rules.findIndex(r=>r.name===name);data.rules[index]=task;}else (data.rules ||= []).push(task);
    await writeRulesForm(data,hash); rulesDirty=false; closeModal(); page='rules'; toast('任务已保存'); await refresh(true);
  });
}

const formLabels={timezone:'时区',askFirst:'需要先征求意见的事项',sources:'事件来源',agents:'Agent',channels:'通知通道',defaultChannels:'默认通知通道',rules:'任务规则',elsewhere:'外部定时任务',name:'名称',adapter:'来源插件',worker:'接单程序',use:'接入方式',model:'模型',effort:'思考强度',tier:'服务档位',title:'会话标题',maxActive:'同时执行上限',access:'操作权限',command:'命令参数',program:'程序路径',timeout:'超时分钟数',answerers:'允许回答的人',links:'使用回答链接',when:'触发条件',source:'事件来源',types:'事件类型',cron:'定时表达式',to:'执行的 Agent',cwd:'工作目录',skill:'任务手册',prompt:'任务描述',group:'并发组',parallel:'并发数量',resume:'接续会话',tell:'通知方式',emits:'允许发出的事件',where:'运行位置',url:'中台地址',hub:'中台',listen:'监听地址',publicUrl:'对外地址',capacity:'接单容量',unreachable:'不可连接的通道',owner:'本人密钥',key:'密钥',user:'接收用户',lark:'飞书程序',platform:'平台',body:'消息内容',text:'文本',headers:'请求头'};
const enums={access:[['read','只读'],['edit','可编辑工作目录'],['full','完全访问']],tell:[['needed','仅需要时通知'],['always','每轮通知'],['never','不发送普通通知']],effort:[['low','低'],['medium','中'],['high','高'],['xhigh','很高'],['max','最大'],['ultra','极高']]};
const typeLabels={string:'文字',number:'数字',boolean:'是或否',object:'一组设置',array:'列表',null:'空值'};
const shape=(value)=>value===null?'null':Array.isArray(value)?'array':typeof value;
const defaultShape=(type)=>({string:'',number:1,boolean:false,object:{},array:[],null:null}[type]);
function knownFields(kind,path,value) {
  const root=path[0], last=path.at(-1), inRecord=path.length===2;
  if(kind==='rules'&&path.length===0)return {timezone:'string',askFirst:'array',sources:'object',agents:'object',channels:'object',...(features.defaultChannels?{defaultChannels:'array'}:{}),rules:'array',elsewhere:'array'};
  if(kind==='rules'&&root==='agents'&&inRecord)return {name:'string',worker:'string',use:'string',model:'string',effort:'string',...(features.agentTier?{tier:'string'}:{}),...(features.agentMaxActive?{maxActive:'number'}:{}),access:'string',command:'array',program:'string',timeout:'number'};
  if(kind==='rules'&&root==='sources'&&inRecord)return {name:'string',adapter:'string'};
  if(kind==='rules'&&root==='channels'&&inRecord)return {name:'string',answerers:'array',links:'boolean'};
  if(kind==='rules'&&root==='rules'&&inRecord)return {name:'string',when:'object',to:'string',cwd:'string',skill:'string',prompt:'string',...(features.ruleTitle?{title:'string'}:{}),group:'string',parallel:'number',...(features.ruleMaxActive?{maxActive:'number'}:{}),resume:'boolean',tell:'string',emits:'object',channels:'array'};
  if(kind==='rules'&&root==='elsewhere'&&inRecord)return {name:'string',source:'string',to:'string',cron:'string',where:'string',...(features.elsewhereModel?{model:'string',effort:'string'}:{}),cwd:'string',skill:'string',prompt:'string'};
  if(kind==='rules'&&['when','emits'].includes(last))return {source:'string',types:'array',cron:'string'};
  if(kind==='config'&&path.length===0)return {url:'string',hub:'object',worker:'object',channels:'object',source:'object',owner:'string'};
  if(kind==='config'&&last==='hub')return {listen:'string',publicUrl:'string'};
  if(kind==='config'&&last==='worker')return {name:'string',key:'string',capacity:'number',unreachable:'array'};
  if(kind==='config'&&last==='source')return {name:'string',key:'string'};
  if(kind==='config'&&root==='channels'&&path.length===2)return {use:'string',key:'string',user:'string',lark:'string',url:'string',platform:'string',body:'object'};
  return {};
}
function entryDefault(kind,path,type,root) {
  if(kind==='rules'&&path.length===1&&path[0]==='agents')return {name:'新 Agent',worker:Object.values(root.agents||{})[0]?.worker||'',use:'codex'};
  if(kind==='rules'&&path.length===1&&path[0]==='sources')return {name:'新来源'};
  if(kind==='rules'&&path.length===1&&path[0]==='channels')return {name:'新通道'};
  if(kind==='config'&&path.length===1&&path[0]==='channels')return {key:''};
  return defaultShape(type);
}
function showTreeEditor(kind,data,hash,section='') {
  const title=kind==='rules'?'规则与连接设置':'本机连接设置';
  let refs=[];
  modal(title,`<p class="footnote">${kind==='rules'?'展开各项即可修改。保存前会使用原项目校验器检查。':'修改后需要重启中台。密钥默认隐藏，输入新值会替换原值。'}保存前会检查是否被其他程序修改。</p><div id="tree-editor"></div><div id="tree-result" class="footnote"></div><div class="actions"><button type="button" class="button" data-action="close">取消</button><button type="button" class="button primary" id="tree-save">保存设置</button></div>`);
  const container=$('#tree-editor');
  const get=(path)=>path.reduce((value,key)=>value[key],data);
  const reference=(path)=>{refs.push(path);return refs.length-1;};
  const controls=(value,path)=>{
    const type=shape(value), id=reference(path), key=String(path.at(-1)??''), label=Array.isArray(get(path.slice(0,-1)))?(value?.name || `第 ${Number(key)+1} 项`):(formLabels[key]||(value?.name?`${value.name}（${key}）`:key)||title);
    const sensitive=kind==='config'&&(key==='owner'||(path[0]==='channels'&&key==='url')||/key|secret|token|password|authorization|credential/i.test(key));
    const removable=path.length?`<button type="button" class="link-button danger" data-tree-remove="${id}">删除</button>`:'';
    if(type==='object'||type==='array') {
      const entries=Object.entries(value);
      const choices=type==='object'?knownFields(kind,path,value):{};
      const additions=Object.entries(choices).filter(([name])=>!Object.hasOwn(value,name));
      const collection=type==='object'&&path.length===1&&((kind==='rules'&&['agents','sources','channels'].includes(path[0]))||(kind==='config'&&path[0]==='channels'));
      const options=additions.map(([name,t])=>option(name,formLabels[name]||name)).join('')+option('__custom__',type==='array'?'添加一项':collection?'添加项目':'自定义名称');
      const add=`<div class="tree-add"><select data-tree-choice="${id}">${options}</select><input data-tree-key="${id}" placeholder="${collection?'编号：小写字母、数字和连字符':'名称或编号'}"${additions.length||type==='array'?' hidden':''}><select data-tree-type="${id}"${additions.length||collection?' hidden':''}>${Object.entries(typeLabels).map(([k,v])=>option(k,v)).join('')}</select><button type="button" class="button" data-tree-add="${id}">添加</button></div>`;
      const children=entries.map(([name,v])=>controls(v,[...path,type==='array'?Number(name):name])).join('');
      return `<details class="tree-group" data-tree-path="${esc(JSON.stringify(path))}" ${path.length===0?'open':''}><summary><span>${esc(label)}</span><span>${removable}</span></summary><div class="tree-body">${children||'<p class="footnote">暂无内容</p>'}${add}</div></details>`;
    }
    let input;
    if(type==='boolean')input=`<select data-tree-value="${id}" data-type="boolean">${option('true','是',value)}${option('false','否',!value)}</select>`;
    else if(type==='null')input='<span class="footnote">空值；可删除后添加其他类型。</span>';
    else if(type==='string'&&kind==='rules'&&Array.isArray(get(path.slice(0,-1)))&&(path[0]==='defaultChannels'||(path[0]==='rules'&&path.at(-2)==='channels'))) {const choices=Object.entries(data.channels||{});input=`<select data-tree-value="${id}" data-type="string">${!choices.some(([v])=>v===value)?option(value,value||'请选择',true):''}${choices.map(([v,o])=>option(v,o.name||v,v===value)).join('')}</select>`;}
    else if(type==='string'&&kind==='rules'&&key==='cron')input=`<div><span class="footnote">${value?'已设置周期':'尚未设置周期'}</span> <button type="button" class="button" data-tree-schedule="${id}">选择时间</button><div data-tree-schedule-pane="${id}" hidden>${schedulePicker()}<button type="button" class="button" data-tree-schedule-apply="${id}">应用时间</button></div></div>`;
    else if(type==='string'&&kind==='rules'&&['to','source'].includes(key)) {const choices=Object.entries(key==='to'?(data.agents||{}):(data.sources||{}));input=`<select data-tree-value="${id}" data-type="string">${!choices.some(([v])=>v===value)?option(value,value||'请选择',true):''}${choices.map(([v,o])=>option(v,o.name||v,v===value)).join('')}</select>`;}
    else if(type==='string'&&enums[key]) { const choices=enums[key];input=`<select data-tree-value="${id}" data-type="string">${choices.map(([v,l])=>option(v,l,v===value)).join('')}${!choices.some(([v])=>v===value)?option(value,value||'请选择',true):''}</select>`; }
    else if(type==='string'&&key==='use') {const choices=[['codex','Codex'],['claude','Claude Code'],['dsh','DeepSeek Harness'],...(features.zcode?[['zcode','ZCode']]:[]),['acp','ACP'],['command','自定义命令'],['desktop','桌面通知'],['feishu','飞书'],['webhook','Webhook']];input=`<input list="tree-use-${id}" data-tree-value="${id}" data-type="string" value="${esc(value)}"><datalist id="tree-use-${id}">${choices.map(([v,l])=>option(v,l)).join('')}</datalist>`;}
    else if(type==='string'&&key==='tier')input=`<input list="tree-tier-${id}" data-tree-value="${id}" data-type="string" value="${esc(value)}"><datalist id="tree-tier-${id}">${option('priority','优先（Fast）')}</datalist>`;
    else if(type==='string'&&key==='cwd'&&window.workbench?.chooseDirectory)input=`<div class="copy-row"><input data-tree-value="${id}" data-type="string" value="${esc(value)}"><button type="button" class="button" data-tree-directory="${id}">选择文件夹</button></div>`;
    else if(type==='string'&&key==='program'&&window.workbench?.chooseFile)input=`<div class="copy-row"><input data-tree-value="${id}" data-type="string" value="${esc(value)}"><button type="button" class="button" data-tree-file="${id}">选择文件</button></div>`;
    else if(type==='string'&&sensitive)input=`<div class="copy-row"><input type="password" data-tree-value="${id}" data-type="string" value="${esc(value)}"><button type="button" class="button" data-tree-reveal="${id}">显示</button></div>`;
    else if(type==='string'&&(key==='prompt'||key==='text'||String(value).includes('\n')))input=`<textarea rows="3" data-tree-value="${id}" data-type="string">${esc(value)}</textarea>`;
    else input=`<input type="${type==='number'?'number':/key|secret|token|password/i.test(key)?'password':'text'}" data-tree-value="${id}" data-type="${esc(type)}" value="${esc(value)}">`;
    return `<div class="tree-field"><label><span>${esc(label)}</span>${input}</label>${removable}</div>`;
  };
  function renderTree(){const existing=[...container.querySelectorAll('details[open]')].map(x=>x.dataset.treePath);refs=[];container.innerHTML=controls(data,[]);if(existing.length)for(const item of container.querySelectorAll('details'))item.open=existing.includes(item.dataset.treePath);}
  container.addEventListener('input',e=>{
    const el=e.target;if(!el.hasAttribute('data-tree-value'))return;
    const path=refs[Number(el.dataset.treeValue)], parent=get(path.slice(0,-1)), key=path.at(-1);
    if(el.dataset.type==='number'){if(el.value===''||!Number.isFinite(Number(el.value))){el.setCustomValidity('请填写有效数字');return;}el.setCustomValidity('');parent[key]=Number(el.value);}
    else if(el.dataset.type==='boolean')parent[key]=el.value==='true';else parent[key]=el.value;
    rulesDirty=true;
  });
  container.addEventListener('change',e=>{
    const el=e.target;if(!el.hasAttribute('data-tree-choice'))return;
    const id=el.dataset.treeChoice, custom=el.value==='__custom__';
    const key=container.querySelector(`[data-tree-key="${id}"]`),type=container.querySelector(`[data-tree-type="${id}"]`);
    const path=refs[Number(id)],collection=path.length===1&&((kind==='rules'&&['agents','sources','channels'].includes(path[0]))||(kind==='config'&&path[0]==='channels'));
    if(key)key.hidden=!custom||Array.isArray(get(path));if(type)type.hidden=!custom||collection;
  });
  container.addEventListener('click',async e=>{
    const reveal=e.target.closest('[data-tree-reveal]');if(reveal){const input=container.querySelector(`[data-tree-value="${reveal.dataset.treeReveal}"]`);if(input){input.type=input.type==='password'?'text':'password';reveal.textContent=input.type==='password'?'显示':'隐藏';}return;}
    const directory=e.target.closest('[data-tree-directory]');if(directory){try{const value=await window.workbench.chooseDirectory();if(value){const input=container.querySelector(`[data-tree-value="${directory.dataset.treeDirectory}"]`);if(input){input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}}}catch(error){toast(error.message);}return;}
    const file=e.target.closest('[data-tree-file]');if(file){try{const value=await window.workbench.chooseFile();if(value){const input=container.querySelector(`[data-tree-value="${file.dataset.treeFile}"]`);if(input){input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}}}catch(error){toast(error.message);}return;}
    const schedule=e.target.closest('[data-tree-schedule]');if(schedule){const pane=container.querySelector(`[data-tree-schedule-pane="${schedule.dataset.treeSchedule}"]`);pane.hidden=!pane.hidden;return;}
    const apply=e.target.closest('[data-tree-schedule-apply]');if(apply){const id=Number(apply.dataset.treeScheduleApply),path=refs[id],pane=container.querySelector(`[data-tree-schedule-pane="${id}"]`);try{get(path.slice(0,-1))[path.at(-1)]=scheduleValue(pane);pane.hidden=true;rulesDirty=true;toast('已选择时间，保存设置后生效');}catch(error){toast(error.message);}return;}
    const remove=e.target.closest('[data-tree-remove]');
    if(remove){e.preventDefault();e.stopPropagation();const path=refs[Number(remove.dataset.treeRemove)],parent=get(path.slice(0,-1)),key=path.at(-1);if(!confirm('确定删除这一项？'))return;if(Array.isArray(parent))parent.splice(Number(key),1);else delete parent[key];rulesDirty=true;renderTree();return;}
    const add=e.target.closest('[data-tree-add]');if(!add)return;
    const id=add.dataset.treeAdd,path=refs[Number(id)],target=get(path),choice=container.querySelector(`[data-tree-choice="${id}"]`),keyField=container.querySelector(`[data-tree-key="${id}"]`),typeField=container.querySelector(`[data-tree-type="${id}"]`);
    const key=Array.isArray(target)?target.length:choice.value==='__custom__'?keyField.value.trim():choice.value;
    if(!Array.isArray(target)&&(!key||['__proto__','prototype','constructor'].includes(key))){toast('请填写有效的名称或编号');return;}
    if(!Array.isArray(target)&&Object.hasOwn(target,key)){toast('名称已存在');return;}
    const type=choice.value==='__custom__'?typeField.value:knownFields(kind,path,target)[choice.value];
    const value=entryDefault(kind,path,type,data);if(Array.isArray(target))target.push(value);else target[key]=value;
    rulesDirty=true;renderTree();
  });
  $('#tree-save').addEventListener('click',async e=>{
    const invalid=[...container.querySelectorAll('input,select,textarea')].find(element=>!element.checkValidity());if(invalid){invalid.reportValidity();return;}const button=e.currentTarget;button.disabled=true;
    try { if(kind==='rules')await writeRulesForm(data,hash);else await post('/api/settings/config',{text:JSON.stringify(data,null,2)+'\n',hash});rulesDirty=false;closeModal();toast(kind==='rules'?'设置已保存':'设置已保存，请重启中台');await refresh(true); }
    catch(error){const result=$('#tree-result');if(result)result.textContent=error.message;toast(error.message);}finally{button.disabled=false;}
  });
  renderTree();if(section){const group=[...container.querySelectorAll('details')].find(item=>item.dataset.treePath===JSON.stringify([section]));if(group)group.open=true;}
}
async function showRulesSettings(section='') { const [{data,hash},caps]=await Promise.all([readRulesForm(),api('/api/capabilities').catch(()=>({}))]);features=caps;showTreeEditor('rules',data,hash,section); }
async function showConnectionSettings() { const r=await api('/api/settings/config');let data;try{data=JSON.parse(r.text);}catch{throw new Error('现有连接设置无法读取，请从备份恢复。');}showTreeEditor('config',data,r.hash); }
function parseDeliveryArgs(command,supported) {
  const args=Array.isArray(command)?command:[],values={},extras=[];
  if(args.includes('--'))throw new Error('已有交付选项使用了参数分隔符，请使用 Agent 设置逐项调整');
  for(let i=1;i<args.length;i++) {
    const item=args[i],match=/^--([^=]+)(?:=(.*))?$/.exec(item);
    if(!match||!supported[match[1]]){extras.push(item);continue;}
    if(match[1]==='auto-merge'){if(match[2]!==undefined)throw new Error('已有交付选项无法安全编辑，请使用 Agent 设置逐项调整');values[match[1]]=true;continue;}
    const value=match[2]!==undefined?match[2]:args[++i];if(!value||value.startsWith('--'))throw new Error('已有交付选项缺少参数，请使用 Agent 设置逐项调整');values[match[1]]=value;
  }
  return {repo:args[0]||'',values,extras};
}
async function showDeliveryAgent() {
  const [{data,hash},caps]=await Promise.all([readRulesForm(),api('/api/capabilities')]);features=caps;
  if(!caps.delivery)throw new Error('当前程序没有交付插件');
  const existing=Object.entries(data.agents||{}).filter(([,agent])=>agent.use==='delivery');
  const workers=[...new Set(Object.values(data.agents||{}).map(agent=>agent.worker).filter(Boolean))];
  const options=option('','新建交付 Agent',true)+existing.map(([id,agent])=>option(id,agent.name||id)).join('');
  modal('交付 Agent 设置',form(`${selectField('选择','delivery_existing',options)}<div id="delivery-fields"></div><p class="footnote">共享策略从所选仓库的 main 读取。此处只配置接单程序；项目仍需在可信的 main 中准备交付设置。</p>`,'保存'));
  const formEl=$('#action-form'),supported=caps.deliveryOptions||{};
  function redraw() {
    const id=formEl.elements.delivery_existing.value,agent=id?data.agents[id]:null,parsed=parseDeliveryArgs(agent?.command,supported),v=parsed.values;
    const more=(supported['review-policy']?field('共享审查策略（可选）','policy','例如 owner/策略仓库:ops/review-policy.json',v['review-policy']||''):'')+(supported['review-status']?field('审查状态名称（可选）','review_status','留空使用项目设置',v['review-status']||''):'')+(supported.toolkit?field('工具仓库（可选）','toolkit','例如 owner/repository',v.toolkit||''):'')+(supported['progress-command']?fileField('进度程序（可选）','progress','选择可执行程序',v['progress-command']||''):'')+(supported['notify-command']?fileField('通知程序（可选）','notify','选择可执行程序',v['notify-command']||''):'')+(supported['auto-merge']?`<label class="form-field"><span><input type="checkbox" name="auto_merge" value="yes" ${v['auto-merge']?'checked':''}> 检查和审查通过后开启自动合并</span></label>`:'');
    $('#delivery-fields').innerHTML=`${field('名称','name','例如：项目交付',agent?.name||'')}${field('GitHub 仓库','repo','例如 owner/repository',parsed.repo)}<label class="form-field">接单程序<input name="worker" list="delivery-workers" placeholder="选择或填写接单程序" value="${esc(agent?.worker||workers[0]||'')}"><datalist id="delivery-workers">${workers.map(w=>option(w,w)).join('')}</datalist></label>${field('超时分钟数（可选）','timeout','留空使用默认',agent?.timeout??'','number')}${caps.agentMaxActive?field('此 Agent 同时执行上限（可选）','max_active','留空不单独限制',agent?.maxActive??'','number'):''}${more}${parsed.extras.length?'<p class="footnote">其他已有交付选项将保留。</p>':''}`;
  }
  formEl.elements.delivery_existing.addEventListener('change',()=>{try{redraw();}catch(error){toast(error.message);}});redraw();formEl.addEventListener('input',()=>rulesDirty=true);
  bindForm(async v=>{
    const existingId=v.delivery_existing,original=existingId?data.agents[existingId]:null,parsed=parseDeliveryArgs(original?.command,supported);
    if(!nonempty(v.name)||!nonempty(v.worker)||!/^[\w.-]+\/[\w.-]+$/.test(v.repo||''))throw new Error('请填写名称、接单程序和有效的 GitHub 仓库');
    if(v.timeout&&!/^[1-9]\d*$/.test(v.timeout))throw new Error('超时分钟数需要是正整数');
    if(v.max_active&&!/^[1-9]\d*$/.test(v.max_active))throw new Error('同时执行上限需要是正整数');
    if(v.policy){const [repo,policyPath,...rest]=v.policy.split(':');if(rest.length||!/^[\w.-]+\/[\w.-]+$/.test(repo)||!policyPath||policyPath.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('共享策略请填写仓库和路径，例如 owner/repository:ops/review-policy.json');}
    if(v.toolkit&&!/^[\w.-]+\/[\w.-]+$/.test(v.toolkit))throw new Error('工具仓库请填写 owner/repository');
    const command=[v.repo,...parsed.extras];
    for(const [name,value] of [['review-policy',v.policy],['review-status',v.review_status],['toolkit',v.toolkit],['progress-command',v.progress],['notify-command',v.notify]])if(supported[name]&&nonempty(value))command.push(`--${name}`,value.trim());
    if(supported['auto-merge']&&v.auto_merge)command.push('--auto-merge');
    const id=existingId||`delivery-${crypto.randomUUID().slice(0,8)}`,agent={...(original||{}),name:v.name.trim(),worker:v.worker.trim(),use:'delivery',command};
    if(v.timeout)agent.timeout=Number(v.timeout);else delete agent.timeout;
    if(caps.agentMaxActive){if(v.max_active)agent.maxActive=Number(v.max_active);else delete agent.maxActive;}
    data.agents[id]=agent;await writeRulesForm(data,hash);rulesDirty=false;closeModal();toast('交付 Agent 已保存');await refresh(true);
  });
}
async function showSecrets() {
  const result=await api('/api/secrets');
  modal('密钥与环境变量',`<p class="footnote">更改后需要重启中台；其他内容和注释会保留。</p>${result.names.length?result.names.map(name=>`<div class="row"><div class="row-main"><div class="row-title">${esc(name)}</div></div>${btn('查看','secret-view',name)}${btn('替换','secret-edit',name)}${btn('删除','secret-remove',name,'danger')}</div>`).join(''):empty('还没有环境变量') }<div class="actions">${btn('添加','secret-edit','','primary')}</div>`);
}
async function viewSecret(name) {const result=await api(`/api/secrets/value?name=${encodeURIComponent(name)}`);modal('查看环境变量',`<label class="form-field">${esc(name)}<textarea id="secret-value" rows="4" readonly>${esc(result.value)}</textarea></label><div class="actions">${btn('复制','copy-value','secret-value')}${btn('返回','settings','secrets')}</div>`);}
async function editSecret(name='') {
  const initial=await api('/api/secrets');
  modal(name?'替换环境变量':'添加环境变量',form(`${name?`<p class="detail-text">${esc(name)}</p>`:field('名称','name','例如 AGENT_AUTOLOOP_SECRET_GITHUB')}${field('新值','value','请输入完整的新值','','password')}`,'保存'));
  bindForm(async v=>{const key=name||v.name;if(!nonempty(key))throw new Error('请填写名称');await post('/api/secrets',{action:'set',name:key,value:v.value||'',hash:initial.hash});rulesDirty=false;toast('已保存，请重启中台');await showSecrets();});
}
async function removeSecret(name) {
  if(!confirm(`确定删除「${name}」？`))return;
  const initial=await api('/api/secrets');await post('/api/secrets',{action:'remove',name,hash:initial.hash});toast('已删除，请重启中台');await showSecrets();
}
async function showQuestionForm() {
  const {data}=await readRulesForm(); const tasks=(data.elsewhere||[]).filter(task=>task.cwd&&(task.skill||task.prompt||data.agents?.[task.to]?.use==='command'));
  if(!tasks.length)throw new Error('请先在规则设置中添加可接续的外部定时任务');
  modal('发起提问',form(`${selectField('外部定时任务','task',tasks.map(task=>option(task.name,task.name)).join(''))}${field('问题标题','title')}${textarea('问题说明','text')}${textarea('备选答案','options','每行一个选项，填写 2 到 5 个')}${field('推荐选项序号（可选）','recommend','从 1 开始','','number')}${field('问题编号（可选）','key','相同问题可用同一个编号')}${textarea('回答后的说明（可选）','about')}`,'发送提问'));
  bindForm(async v=>{const options=(v.options||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);if(!nonempty(v.title)||!nonempty(v.text)||options.length<2||options.length>5)throw new Error('请填写标题、说明和 2 到 5 个选项');const question={title:v.title,text:v.text,options};if(v.recommend){const n=Number(v.recommend);if(!Number.isInteger(n)||n<1||n>options.length)throw new Error('推荐选项序号不正确');question.recommend=n-1;}if(v.key)question.key=v.key;if(v.about)question.about=v.about;await startJob(['ask','--task',v.task],JSON.stringify(question));});
}
function showProbeForm() {
  modal('检查测试中台',form(`<p class="footnote">检查会在目标系统写入事件和卡片，只适用于专门准备的测试中台。</p>${field('测试中台地址','url','http://127.0.0.1:端口')}${field('来源密钥','source','','','password')}${field('接单程序密钥','worker','','','password')}${field('通道密钥','channel','','','password')}${field('本人密钥','owner','','','password')}${field('测试事件类型','eventType')}${field('测试回答人','answerer')}`,'开始检查'));
  bindForm(async v=>{if(!confirm('该检查会在目标中台写入测试事件和卡片，确定这是专用测试系统？'))return;const job=await post('/api/probe',{url:v.url,keys:{source:v.source,worker:v.worker,channel:v.channel,owner:v.owner},eventType:v.eventType,answerer:v.answerer});await showJob(job.id);});
}
function showMcpInfo() {
  const rows=[['启动程序',info?.node],['第一个参数',info?.cli],['第二个参数','mcp'],['环境变量 AGENT_AUTOLOOP_HOME',info?.home],['环境变量 AGENT_AUTOLOOP_RULES',info?.rulesFile]];
  modal('MCP 接入',`<p class="footnote">在支持 MCP 的客户端设置界面选择标准输入输出，并逐项填写以下内容。不要连接到此系统用来接单的 Agent 用户级配置。</p>${rows.map(([label,value],index)=>`<label class="form-field">${esc(label)}<div class="copy-row"><input id="mcp-value-${index}" readonly value="${esc(value||'')}"><button type="button" class="button" data-action="copy-value" data-id="mcp-value-${index}">复制</button></div></label>`).join('')}`);
}
function showGuidedTools() {
  modal('更多操作',`<div class="toolbar">${btn('查看状态','quick-cli','status')}${btn('查看帮助','quick-cli','help')}${btn('检查规则','quick-cli','check')}${btn('检查其他规则','check-file')}${btn('规则说明','quick-cli','rules explain')}${btn('发起提问','ask-form')}${btn('检查测试中台','probe-form')}${btn('MCP 接入','mcp')}</div><p class="footnote">任务、事件、密钥、插件和备份可在对应页面直接操作。</p>`);
}
function showCheckFile() {modal('检查其他规则',form(fileField('选择规则文件','path','选择或填写规则文件位置'),'检查'));bindForm(async v=>{if(!nonempty(v.path))throw new Error('请选择规则文件');await startJob(['check',v.path]);});}
