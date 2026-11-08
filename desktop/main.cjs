const { app, BrowserWindow, dialog, Menu, session } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, copyFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

app.setName('Agent Autoloop Workbench');
app.setAppUserModelId('com.borispeng.autoloop-workbench');
const userData = process.env.WORKBENCH_USER_DATA || path.join(app.getPath('appData'), 'AgentAutoloopWorkbench');
app.setPath('userData', userData);
const preferencesFile = path.join(userData, 'connection.json');
let window, server, stopping = false, quitRequested = false;

function isEngine(directory) {
  return typeof directory === 'string' && existsSync(path.join(directory, 'bin', 'agent-autoloop.ts'));
}
function loadPreferences() {
  try { return JSON.parse(readFileSync(preferencesFile, 'utf8')); } catch { return {}; }
}
function savePreferences(settings) {
  mkdirSync(userData, { recursive: true });
  writeFileSync(preferencesFile, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}
async function chooseConnection() {
  const choice = await dialog.showOpenDialog({ title: '选择 Agent Autoloop 数据目录', message: '请选择包含 config.json 和 app 文件夹的 Agent Autoloop 数据目录。', properties: ['openDirectory', 'createDirectory'] });
  if (choice.canceled) return null;
  const home = choice.filePaths[0]; let engine = path.join(home, 'app');
  if (!isEngine(engine)) {
    const selected = await dialog.showOpenDialog({ title: '选择 Agent Autoloop 程序目录', message: '请选择包含 bin/agent-autoloop.ts 的 Agent Autoloop 程序目录。', properties: ['openDirectory'] });
    if (selected.canceled) return null;
    engine = selected.filePaths[0];
    if (!isEngine(engine)) throw new Error('所选程序目录没有 bin/agent-autoloop.ts。');
  }
  return { home, engine };
}
async function connection() {
  const saved = loadPreferences();
  if (typeof saved.home === 'string' && isEngine(saved.engine)) return saved;
  const fromEnv = process.env.AGENT_AUTOLOOP_HOME;
  const home = fromEnv || path.join(app.getPath('home'), '.agent-autoloop');
  const engine = process.env.AGENT_AUTOLOOP_APP || path.join(home, 'app');
  if (isEngine(engine)) return { home, engine };
  const selected = await chooseConnection();
  if (selected) savePreferences(selected);
  return selected;
}
function supportedNode(file) {
  if (!file || !existsSync(file)) return false;
  const version = spawnSync(file, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  return version.status === 0 && Number(/^v(\d+)/.exec(version.stdout.trim())?.[1]) >= 24;
}
function nodePath() {
  const found = spawnSync('where.exe', ['node.exe'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  const choices = [process.env.AGENT_AUTOLOOP_NODE, ...(found.status === 0 ? found.stdout.split(/\r?\n/) : [])];
  const installed = choices.find(supportedNode);
  if (installed) return installed;
  const embedded = path.join(process.resourcesPath, 'node', 'node.exe');
  if (!supportedNode(embedded)) throw new Error('找不到可用的 Node 24 运行环境。');
  const version = spawnSync(embedded, ['--version'], { encoding: 'utf8', windowsHide: true }).stdout.trim();
  const runtime = path.join(userData, 'runtime', version, 'node.exe');
  if (!supportedNode(runtime)) { mkdirSync(path.dirname(runtime), { recursive: true }); copyFileSync(embedded, runtime); }
  return runtime;
}
function startServer(settings) {
  return new Promise((resolve, reject) => {
    const node = app.isPackaged ? nodePath() : process.env.AGENT_AUTOLOOP_NODE || 'node';
    const source = app.isPackaged ? path.join(process.resourcesPath, 'workbench') : path.join(__dirname, '..');
    const env = { ...process.env, AGENT_AUTOLOOP_HOME: settings.home, AGENT_AUTOLOOP_APP: settings.engine, WORKBENCH_PORT: '0', WORKBENCH_DESKTOP: '1', PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH || ''}` };
    delete env.AGENT_AUTOLOOP_RULES;
    const child = spawn(node, [path.join(source, 'server.mjs')], { cwd: source, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    server = child;
    let output = '', ready = false;
    const timeout = setTimeout(() => fail(new Error('工作台服务启动超时。')), 20000);
    function fail(error) { if (!ready) { ready = true; clearTimeout(timeout); reject(error); } }
    child.on('error', fail);
    child.on('exit', code => {
      if (!ready) fail(new Error(`工作台服务提前退出（${code}）。\n${output.slice(-2000)}`));
      else if (!stopping) { dialog.showErrorBox('工作台已停止', `本机工作台服务已退出（${code}）。`); app.quit(); }
    });
    child.stderr.on('data', chunk => { output = (output + chunk.toString('utf8')).slice(-5000); });
    child.stdout.on('data', chunk => {
      output = (output + chunk.toString('utf8')).slice(-5000);
      const match = output.match(/Workbench: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match && !ready) { ready = true; clearTimeout(timeout); resolve(match[1]); }
    });
  });
}
function createWindow(url) {
  const origin = new URL(url).origin;
  window = new BrowserWindow({ title: 'Agent Autoloop 工作台', width: 1440, height: 960, minWidth: 780, minHeight: 600, backgroundColor: '#f5f6f5', show: false, icon: path.join(__dirname, 'icon.png'), webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => { try { if (new URL(target).origin !== origin) event.preventDefault(); } catch { event.preventDefault(); } });
  window.webContents.on('will-redirect', (event, target) => { try { if (new URL(target).origin !== origin) event.preventDefault(); } catch { event.preventDefault(); } });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { window = null; });
  window.loadURL(url).catch(error => { dialog.showErrorBox('无法打开工作台', error.message); app.quit(); });
}
function createMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: '连接', submenu: [
    { label: '更换 Agent Autoloop 数据目录…', click: async () => { try { const selected = await chooseConnection(); if (selected) { savePreferences(selected); app.relaunch(); app.quit(); } } catch (error) { dialog.showErrorBox('无法更换目录', error.message); } } },
    { type: 'separator' }, { role: 'quit', label: '退出' },
  ] }, { label: '视图', submenu: [{ role: 'reload', label: '刷新' }, { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }] }]));
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    try { const settings = await connection(); if (!settings) return app.quit(); createMenu(); createWindow(await startServer(settings)); }
    catch (error) { dialog.showErrorBox('无法启动工作台', error.message); app.quit(); }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (server && server.exitCode === null && server.signalCode === null && !quitRequested) {
      event.preventDefault(); quitRequested = true; stopping = true;
      const timer = setTimeout(() => server.kill(), 5000);
      server.once('exit', () => { clearTimeout(timer); app.quit(); });
      if (server.connected) server.send('shutdown'); else server.kill();
    }
  });
}
