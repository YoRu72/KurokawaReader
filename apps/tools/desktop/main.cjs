// Electron shell of Kurokawa Tools: serves the built web app from an app:// origin, runs aria2c beside it (the
// engine), takes magnets and .torrent files from the system, and updates itself from the repository's tools-v*
// releases.
'use strict';
const { app, BrowserWindow, protocol, net, ipcMain, shell, Menu, dialog } = require('electron');
if (process.platform === 'win32') app.setAppUserModelId('app.kurokawa.tools');
const path = require('node:path');
const fs = require('node:fs');
const { Aria2Engine } = require('./aria2.cjs');

const DIST = path.join(__dirname, 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm' };
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

let win = null; let engine = null;
const pkg = require('./package.json');
const REPO = (pkg.kurokawa && pkg.kurokawa.repo) || 'YoRu72/KurokawaReader';
const pendingLinks = [];

const statePath = () => path.join(app.getPath('userData'), 'window-state.json');
function loadState() { try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch { return {}; } }
function saveState() { if (!win) return; try { const b = win.getNormalBounds(); fs.writeFileSync(statePath(), JSON.stringify({ ...b, maximized: win.isMaximized() })); } catch { /* ignore */ } }
function send(channel, payload) { if (win && !win.webContents.isLoading()) win.webContents.send(channel, payload); }

function createWindow() {
  const st = loadState();
  win = new BrowserWindow({
    width: st.width || 1100, height: st.height || 780, x: st.x, y: st.y, minWidth: 420, minHeight: 560,
    backgroundColor: '#121314', title: 'Kurokawa Tools', autoHideMenuBar: true,
    icon: path.join(__dirname, process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('did-finish-load', flushLinks);
  win.loadURL('app://kurokawa/index.html');
  if (st.maximized) win.maximize();
  win.on('resize', saveState); win.on('move', saveState); win.on('close', saveState);
  win.on('closed', () => { win = null; });
}
function flushLinks() { while (pendingLinks.length && win && !win.webContents.isLoading()) send('kt:open', pendingLinks.shift()); }
/** A magnet, a link, or a .torrent file (read as a data: URL) from the command line or the system. */
function takeArg(a) {
  if (!a || a.startsWith('-')) return;
  if (/^(magnet:|https?:|kurokawatools:)/i.test(a)) { pendingLinks.push(a.replace(/^kurokawatools:\/\/open\?u=/i, (m) => '')); flushLinks(); return; }
  if (/\.torrent$/i.test(a) && fs.existsSync(a)) { try { pendingLinks.push('data:application/x-bittorrent;base64,' + fs.readFileSync(a).toString('base64')); flushLinks(); } catch { /* ignore */ } }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', (_e, argv) => { argv.slice(1).forEach(takeArg); if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.on('open-url', (e, u) => { e.preventDefault(); takeArg(u); });
  app.on('open-file', (e, p) => { e.preventDefault(); takeArg(p); });
  process.on('uncaughtException', (err) => { console.error('[tools] uncaught', err); });
  app.whenReady().then(async () => {
    protocol.handle('app', (req) => {
      const u = new URL(req.url); let p = decodeURIComponent(u.pathname); if (p === '/' || p === '') p = '/index.html';
      let file = path.normalize(path.join(DIST, p)); if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
      return net.fetch('file://' + file).then((r) => new Response(r.body, { headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' } }));
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));
    const userData = app.getPath('userData'); fs.mkdirSync(userData, { recursive: true });
    engine = new Aria2Engine({ userData, resources: process.resourcesPath || path.join(__dirname, 'resources'), defaultDir: path.join(app.getPath('downloads'), 'Kurokawa') });
    await engine.start().catch((e) => { engine.available = false; engine.reason = String(e.message || e); });
    engine.onTasks((tasks) => send('kt:tasks', tasks));
    createWindow();
    process.argv.slice(1).forEach(takeArg);
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', () => { engine?.stop(); });
}

/* ---------- the engine, to the page ---------- */
const E = () => { if (!engine) throw new Error('engine'); return engine; };
ipcMain.handle('kt:state', () => ({ available: !!engine?.available, reason: engine?.reason || '', os: process.platform, arch: process.arch }));
ipcMain.handle('kt:list', () => E().list());
ipcMain.handle('kt:add', (_e, o) => E().add(o));
ipcMain.handle('kt:pause', (_e, id) => E().pause(id));
ipcMain.handle('kt:resume', (_e, id) => E().resume(id));
ipcMain.handle('kt:remove', (_e, id, del) => E().remove(id, !!del));
ipcMain.handle('kt:setFiles', (_e, id, p) => E().setFiles(id, p));
ipcMain.handle('kt:setLimits', (_e, l) => E().setLimits(l));
ipcMain.handle('kt:configure', (_e, o) => E().configure(o));
ipcMain.handle('kt:torrentInfo', (_e, s) => E().torrentInfo(s));
ipcMain.handle('kt:open', async (_e, id, fileIndex) => { const p = await E().fileOf(id, fileIndex); if (fileIndex === -1 || fileIndex === undefined && !p) { shell.showItemInFolder(p); return; } if (fileIndex === -1) { shell.showItemInFolder(p); return; } const err = await shell.openPath(p); if (err) shell.showItemInFolder(p); });
ipcMain.handle('kt:defaultDir', () => engine?.defaultDir || app.getPath('downloads'));
ipcMain.handle('kt:pickDir', async () => { const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] }); return r.canceled ? null : r.filePaths[0]; });
ipcMain.handle('kt:openExternal', (_e, u) => shell.openExternal(String(u)));
ipcMain.handle('kt:registerMagnet', () => { if (process.defaultApp) { if (process.argv.length >= 2) app.setAsDefaultProtocolClient('magnet', process.execPath, [path.resolve(process.argv[1])]); } else app.setAsDefaultProtocolClient('magnet'); return true; });
ipcMain.handle('kt:http', async (_e, o) => {
  const r = await net.fetch(String(o.url), { method: o.method || 'GET', headers: o.headers || {}, body: o.body ? (o.bodyBase64 ? Buffer.from(o.body, 'base64') : o.body) : undefined, redirect: 'follow' });
  const headers = {}; r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, url: r.url, headers, body: o.binary ? buf.toString('base64') : buf.toString('utf8') };
});
ipcMain.handle('kt:readFile', async (_e, p) => { const b = await fs.promises.readFile(String(p)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); });

/* ---------- updates: the repository's tools-v* releases ---------- */
const cmp = (a, b) => { const pa = a.split('.').map(Number), pb = b.split('.').map(Number); for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; } return 0; };
ipcMain.handle('kt:checkUpdate', async (_e, o) => {
  const r = await net.fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, { headers: { accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const all = (await r.json()).filter((x) => !x.draft && x.tag_name.startsWith('tools-v')).sort((a, b) => cmp(b.tag_name.slice(7), a.tag_name.slice(7)));
  const j = all[0]; if (!j) return null;
  const v = j.tag_name.slice(7); if (cmp(v, app.getVersion()) <= 0) return null;
  const want = process.platform === 'win32' ? /win-x64\.exe$/ : process.platform === 'darwin' ? /\.dmg$/ : /\.AppImage$/;
  const asset = j.assets.find((a) => want.test(a.name) && !/portable/.test(a.name));
  return { version: v, url: j.html_url, notes: j.body || '', asset: asset ? asset.browser_download_url : undefined };
});
ipcMain.handle('kt:installUpdate', async (e, url) => {
  const res = await net.fetch(url); if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
  const total = Number(res.headers.get('content-length') || 0);
  const ext = process.platform === 'win32' ? '.exe' : process.platform === 'darwin' ? '.dmg' : '.AppImage';
  const file = path.join(app.getPath('temp'), `KurokawaTools-update-${Date.now()}` + ext);
  const out = fs.createWriteStream(file); const reader = res.body.getReader(); let got = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; out.write(Buffer.from(value)); got += value.length; e.sender.send('kt:update-progress', { pct: total ? Math.round((got / total) * 100) : 0, got, total }); }
  await new Promise((r) => out.end(r));
  const { spawn } = require('node:child_process');
  if (process.platform === 'linux') {
    const current = process.env.APPIMAGE; fs.chmodSync(file, 0o755);
    if (current) { const script = path.join(app.getPath('temp'), 'kt-update.sh'); fs.writeFileSync(script, `#!/bin/sh\nsleep 2\nmv -f "${file}" "${current}" && chmod +x "${current}" && ("${current}" >/dev/null 2>&1 &)\nrm -f "$0"\n`, { mode: 0o755 }); spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref(); setTimeout(() => app.quit(), 500); return current; }
    shell.showItemInFolder(file); return file;
  }
  const err = await shell.openPath(file); if (err) throw new Error(err);
  setTimeout(() => app.quit(), 1500); return file;
});
