import http from 'node:http';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { Readable } from 'node:stream';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const home = path.resolve(process.env.AGENT_AUTOLOOP_HOME || (existsSync(path.join(root, '..', 'config.json')) ? path.join(root, '..') : path.join(homedir(), '.agent-autoloop')));
const app = path.resolve(process.env.AGENT_AUTOLOOP_APP || path.join(root, '..', 'app'));
const rulesFile = path.resolve(process.env.AGENT_AUTOLOOP_RULES || path.join(home, 'rules.json'));
const cli = path.join(app, 'bin', 'agent-autoloop.ts');
const token = randomBytes(32).toString('hex');
const hash = (s) => createHash('sha256').update(s).digest('hex');
const settings = { config: path.join(home, 'config.json'), secrets: path.join(home, 'secrets.env') };
const commands = new Set(['help','--version','status','why','answer','resolve','doctor','check','rules','pause','resume','run','emit','tell','ask','stop','key','add','backup','restore','update','uninstall','service','init','join','conformance']);
const contentTypes = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const jobs = new Map();
let managed = null;

function json(res, code, value) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  let value = '';
  for await (const part of req) { value += part; if (value.length > 1024 * 1024) throw new Error('请求内容太大'); }
  return JSON.parse(value || '{}');
}
async function config() { return JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8')); }
const hubUrl = (base, endpoint) => base.replace(/\/$/, '') + endpoint;
async function hub(method, endpoint, data, source = false) {
  const c = await config();
  const key = source ? c.source?.key : c.owner;
  if (!key) throw new Error(source ? '本机没有来源密钥' : '本机没有本人密钥');
  const response = await fetch(hubUrl(c.url, endpoint), { method, headers: { authorization: `Bearer ${key}`, ...(data !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(12000) });
  const text = await response.text();
  let value; try { value = JSON.parse(text); } catch { value = { error: text || `中台返回 ${response.status}` }; }
  if (!response.ok) throw new Error(value.error || `中台返回 ${response.status}`);
  return value;
}
function checkCommand(args, input) {
  if (!Array.isArray(args) || !args.length || !commands.has(args[0]) || args.some(x => typeof x !== 'string' || x.length > 10000) || typeof input !== 'string') throw new Error('命令参数无效');
}
function runCli(args, input = '') {
  checkCommand(args, input);
  const job = { id: randomBytes(16).toString('hex'), command: args[0], startedAt: new Date().toISOString(), done: false, code: null, output: '', truncated: false };
  jobs.set(job.id, job);
  for (const [id, old] of jobs) { if (jobs.size <= 20) break; if (old.done) jobs.delete(id); }
  const child = spawn(process.execPath, [cli, ...args], { cwd: app, env: { ...process.env, AGENT_AUTOLOOP_HOME: home, AGENT_AUTOLOOP_RULES: rulesFile }, windowsHide: true, shell: false });
  const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8');
  const collect = (text) => {
    const remaining = 500000 - job.output.length;
    if (remaining > 0) job.output += text.slice(0, remaining);
    if (text.length > remaining) job.truncated = true;
  };
  child.stdout.on('data', chunk => collect(stdout.write(chunk)));
  child.stderr.on('data', chunk => collect(stderr.write(chunk)));
  child.on('error', error => { job.error = error.message; });
  child.on('close', code => { collect(stdout.end()); collect(stderr.end()); job.code = code; job.done = true; });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  return job;
}
function runtimeView() {
  if (!managed) return { state: 'stopped', output: '' };
  const { child, output, startedAt, code } = managed;
  return { state: child.exitCode === null && child.signalCode === null ? 'running' : 'stopped', pid: child.pid, startedAt, code, output };
}
function startRuntime() {
  if (managed && managed.child.exitCode === null && managed.child.signalCode === null) throw new Error('工作台启动的中台已经在运行');
  const child = spawn(process.execPath, [cli, 'up'], { cwd: app, env: { ...process.env, AGENT_AUTOLOOP_HOME: home, AGENT_AUTOLOOP_RULES: rulesFile }, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const entry = { child, output: '', startedAt: new Date().toISOString(), code: null }; managed = entry;
  const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8');
  const collect = text => { entry.output = (entry.output + text).slice(-50000); };
  child.stdout.on('data', chunk => collect(stdout.write(chunk))); child.stderr.on('data', chunk => collect(stderr.write(chunk)));
  child.on('error', error => collect(error.message));
  child.on('close', code => { collect(stdout.end()); collect(stderr.end()); entry.code = code; });
  return runtimeView();
}
async function validateRules(text) {
  const { parseRules } = await import(pathToFileURL(path.join(app, 'protocol', 'rules.ts')).href);
  parseRules(text, Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone);
}
async function settingsText(name) {
  try { return await readFile(settings[name], 'utf8'); }
  catch (error) { if (name === 'secrets' && error.code === 'ENOENT') return ''; throw error; }
}
async function validateSettings(name, text) {
  if (name === 'secrets') return;
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('配置不是有效的 JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.url !== 'string') throw new Error('配置必须包含中台地址 url');
  let url; try { url = new URL(value.url); } catch { throw new Error('中台地址 url 无效'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('中台地址必须使用 HTTP 或 HTTPS');
  if (value.hub !== undefined) {
    if (!value.hub || typeof value.hub !== 'object' || typeof value.hub.listen !== 'string') throw new Error('hub.listen 必须是主机和端口');
    const { parseListen } = await import(pathToFileURL(path.join(app, 'host', 'config.ts')).href);
    parseListen(value.hub.listen);
  }
  if (value.worker !== undefined && (!value.worker || typeof value.worker !== 'object' || typeof value.worker.name !== 'string' || typeof value.worker.key !== 'string')) throw new Error('worker 必须包含 name 和 key');
  if (value.source !== undefined && (!value.source || typeof value.source !== 'object' || typeof value.source.name !== 'string' || typeof value.source.key !== 'string')) throw new Error('source 必须包含 name 和 key');
  if (value.channels !== undefined && (!value.channels || typeof value.channels !== 'object' || Array.isArray(value.channels))) throw new Error('channels 必须是对象');
}
async function atomicWrite(file, text) {
  const tmp = `${file}.workbench-${randomBytes(6).toString('hex')}.tmp`;
  try { await writeFile(tmp, text, { flag: 'wx', mode: 0o600 }); await rename(tmp, file); } finally { await unlink(tmp).catch(() => {}); }
}

const server = http.createServer(async (req, res) => {
  try {
    const address = server.address();
    if (req.headers.host !== `127.0.0.1:${address.port}`) return json(res, 403, { error: '仅允许本机访问' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/') {
      const html = (await readFile(path.join(root, 'public', 'index.html'), 'utf8')).replace('__WORKBENCH_TOKEN__', token);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff' }); return res.end(html);
    }
    if (req.method === 'GET' && ['/app.js','/style.css'].includes(url.pathname)) {
      res.writeHead(200, { 'content-type': contentTypes[path.extname(url.pathname)], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); return res.end(await readFile(path.join(root, 'public', url.pathname.slice(1))));
    }
    if (!url.pathname.startsWith('/api/') || req.headers['x-workbench-token'] !== token || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)) return json(res, 403, { error: '请求未授权' });
    if (req.method === 'GET' && url.pathname === '/api/info') return json(res, 200, { home, app, rulesFile, node: process.execPath, cli });
    if (req.method === 'GET' && url.pathname === '/api/runtime') return json(res, 200, runtimeView());
    if (req.method === 'POST' && url.pathname === '/api/runtime') {
      const { action } = await body(req);
      if (action === 'start') return json(res, 200, startRuntime());
      if (action === 'stop') {
        if (!managed || managed.child.exitCode !== null || managed.child.signalCode !== null) throw new Error('没有由工作台启动的进程');
        managed.child.kill(); return json(res, 200, { ok: true });
      }
      throw new Error('不支持此操作');
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const before = url.searchParams.get('before');
      if (before && !/^\d+$/.test(before)) throw new Error('页码无效');
      return json(res, 200, await hub('GET', `/v1/state${before ? `?before=${before}` : ''}`));
    }
    if (req.method === 'GET' && url.pathname === '/api/stream') {
      const after = url.searchParams.get('after') || '0';
      if (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after))) throw new Error('日志序号无效');
      const c = await config(); if (!c.owner) throw new Error('本机没有本人密钥');
      const gone = new AbortController(); res.on('close', () => gone.abort());
      let upstream;
      try { upstream = await fetch(hubUrl(c.url, `/v1/stream?after=${after}`), { headers: { authorization: `Bearer ${c.owner}` }, signal: gone.signal }); }
      catch (error) { if (gone.signal.aborted) return; throw error; }
      if (!upstream.ok || !upstream.body) throw new Error(`中台事件流返回 ${upstream.status}`);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
      return;
    }
    if (req.method === 'GET' && /^\/api\/why\/\d+$/.test(url.pathname)) return json(res, 200, await hub('GET', url.pathname.replace('/api/why/', '/v1/runs/') + '/why'));
    if (req.method === 'GET' && url.pathname === '/api/rules') { const text = await readFile(rulesFile, 'utf8'); return json(res, 200, { text, hash: hash(text) }); }
    if (req.method === 'POST' && url.pathname === '/api/rules') {
      const data = await body(req); if (typeof data.text !== 'string') throw new Error('规则内容无效');
      await validateRules(data.text);
      if (data.save) {
        if (hash(await readFile(rulesFile, 'utf8')) !== data.hash) return json(res, 409, { error: '规则文件已被其他程序修改，请重新加载后再保存' });
        await atomicWrite(rulesFile, data.text);
      }
      return json(res, 200, { ok: true, hash: hash(data.text) });
    }
    const settingsRoute = /^\/api\/settings\/(config|secrets)$/.exec(url.pathname);
    if (settingsRoute && req.method === 'GET') { const text = await settingsText(settingsRoute[1]); return json(res, 200, { text, hash: hash(text) }); }
    if (settingsRoute && req.method === 'POST') {
      const name = settingsRoute[1], data = await body(req);
      if (typeof data.text !== 'string') throw new Error('文件内容无效');
      await validateSettings(name, data.text);
      if (hash(await settingsText(name)) !== data.hash) return json(res, 409, { error: '文件已被其他程序修改，请重新加载后再保存' });
      await atomicWrite(settings[name], data.text);
      return json(res, 200, { ok: true, hash: hash(data.text) });
    }
    if (req.method === 'POST' && url.pathname === '/api/action') {
      const { kind, id, data = {} } = await body(req);
      const numeric = Number.isSafeInteger(id) && id > 0;
      let endpoint;
      if (numeric && ['answer','resolve'].includes(kind)) endpoint = `/v1/cards/${id}/${kind}`;
      else if (numeric && kind === 'cancel') endpoint = `/v1/runs/${id}/cancel`;
      else if (typeof id === 'string' && id && ['pause','resume','run'].includes(kind)) endpoint = `/v1/rules/${encodeURIComponent(id)}/${kind}`;
      else if (kind === 'event') endpoint = '/v1/events';
      else throw new Error('不支持此操作');
      return json(res, 200, await hub('POST', endpoint, data, kind === 'event'));
    }
    if (req.method === 'POST' && (url.pathname === '/api/cli' || url.pathname === '/api/jobs')) {
      const { args, input = '' } = await body(req);
      const job = runCli(args, input);
      if (url.pathname === '/api/jobs') return json(res, 200, { id: job.id });
      while (!job.done) await new Promise(resolve => setTimeout(resolve, 50));
      return json(res, 200, job);
    }
    if (req.method === 'GET' && url.pathname === '/api/jobs') return json(res, 200, [...jobs.values()].map(({ id, command, startedAt, done, code }) => ({ id, command, startedAt, done, code })).reverse());
    if (req.method === 'GET' && /^\/api\/jobs\/[a-f0-9]{32}$/.test(url.pathname)) {
      const job = jobs.get(url.pathname.split('/').at(-1));
      return job ? json(res, 200, job) : json(res, 404, { error: '没有这个操作记录，工作台可能已重启' });
    }
    return json(res, 404, { error: '没有这个接口' });
  } catch (error) { return json(res, 500, { error: error.message || String(error) }); }
});

server.listen(Number(process.env.WORKBENCH_PORT || 3390), '127.0.0.1', () => console.log(`Workbench: http://127.0.0.1:${server.address().port}`));
function shutdown() { if (managed && managed.child.exitCode === null && managed.child.signalCode === null) managed.child.kill(); server.close(() => { if (process.connected) process.disconnect(); }); server.closeAllConnections(); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
if (process.env.WORKBENCH_DESKTOP === '1' && process.send) {
  process.on('message', message => { if (message === 'shutdown') shutdown(); });
}
