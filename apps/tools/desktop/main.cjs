// Electron shell of Kurokawa Tools: serves the built web app from an app:// origin, runs aria2c beside it (the
// engine), takes magnets and .torrent files from the system, and updates itself from the repository's tools-v*
// releases.
'use strict';
const { app, BrowserWindow, protocol, net, ipcMain, shell, Menu, dialog } = require('electron');
if (process.platform === 'win32') app.setAppUserModelId('app.kurokawa.tools');
const path = require('node:path');
const fs = require('node:fs');
const { Aria2Engine } = require('./aria2.cjs');
const Archive = require('./archive.cjs');
const Ffmpeg = require('./ffmpeg.cjs');
const Ytdlp = require('./ytdlp.cjs');
let videos = null; let lastAria = [];
const allTasks = () => [...lastAria, ...(videos ? videos.list() : [])];
const isVideoId = (id) => typeof id === 'string' && id.startsWith('v') && videos && videos.list().some((t) => t.id === id);

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
    videos = new Ytdlp.VideoJobs(() => send('kt:tasks', allTasks()));
    engine.onTasks((tasks) => { lastAria = tasks; send('kt:tasks', allTasks()); });
    setTimeout(() => void Ytdlp.maybeUpdate(), 15000); setInterval(() => void Ytdlp.maybeUpdate(), 6 * 3600000);
    createWindow();
    process.argv.slice(1).forEach(takeArg);
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', () => { engine?.stop(); videos?.stop(); });
}

/* ---------- the engine, to the page ---------- */
const E = () => { if (!engine) throw new Error('engine'); return engine; };
ipcMain.handle('kt:state', () => ({ available: !!engine?.available, reason: engine?.reason || '', os: process.platform, arch: process.arch }));
ipcMain.handle('kt:list', async () => { lastAria = await E().list(); return allTasks(); });
ipcMain.handle('kt:add', (_e, o) => (o.video ? videos.add({ ...o.video, url: o.source.url, dir: o.dir || engine.defaultDir, paused: o.paused, meta: o.meta }) : E().add(o)));
ipcMain.handle('kt:pause', (_e, id) => (isVideoId(id) ? videos.pause(id) : E().pause(id)));
ipcMain.handle('kt:resume', (_e, id) => (isVideoId(id) ? videos.resume(id) : E().resume(id)));
ipcMain.handle('kt:remove', (_e, id, del) => (isVideoId(id) ? videos.remove(id, !!del) : E().remove(id, !!del)));
ipcMain.handle('kt:setFiles', (_e, id, p) => E().setFiles(id, p));
ipcMain.handle('kt:setLimits', (_e, l) => E().setLimits(l));
ipcMain.handle('kt:configure', (_e, o) => E().configure(o));
ipcMain.handle('kt:torrentInfo', (_e, s) => E().torrentInfo(s));
ipcMain.handle('kt:open', async (_e, id, fileIndex) => { const p = isVideoId(id) ? videos.fileOf(id) : await E().fileOf(id, fileIndex); if (fileIndex === -1 || fileIndex === undefined && !p) { shell.showItemInFolder(p); return; } if (fileIndex === -1) { shell.showItemInFolder(p); return; } const err = await shell.openPath(p); if (err) shell.showItemInFolder(p); });
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
/** A small window for a sign-in: resolves with the first address that carries `marker` (the token in AniList's
 *  pin page URL), or null when the window is closed first. Nothing of the page is read beyond its address. */
ipcMain.handle('kt:captureUrl', (_e, o) => new Promise((resolve) => {
  const w = new BrowserWindow({ width: 520, height: 720, parent: win || undefined, title: String(o.title || ''), autoHideMenuBar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'persist:signin' } });
  let done = false; const finish = (v) => { if (done) return; done = true; resolve(v); setTimeout(() => { if (!w.isDestroyed()) w.close(); }, 50); };
  const check = (u) => { if (typeof u === 'string' && u.includes(String(o.marker))) finish(u); };
  w.webContents.on('will-navigate', (_ev, u) => check(u)); w.webContents.on('will-redirect', (_ev, u) => check(u)); w.webContents.on('did-navigate', (_ev, u) => check(u)); w.webContents.on('did-navigate-in-page', (_ev, u) => check(u));
  w.on('closed', () => finish(null));
  w.loadURL(String(o.url));
}));
ipcMain.handle('kt:readFile', async (_e, p) => { const b = await fs.promises.readFile(String(p)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); });

/* ---------- archives ---------- */
const archiveJobs = new Map();
ipcMain.handle('kt:archiveList', (_e, o) => Archive.list(String(o.path), o.password));
ipcMain.handle('kt:archiveExtract', async (e, o) => {
  const stop = { v: false }; if (o.id) archiveJobs.set(o.id, stop); let last = 0;
  try { const dest = o.dest || path.dirname(String(o.path)); const files = await Archive.extract(String(o.path), dest, { inPlace: !!o.inPlace, deleteAfter: !!o.deleteAfter, replace: o.replace || 'replace', password: o.password }, { on: (done, total, file) => { const now = Date.now(); if (now - last < 250 && done < total) return; last = now; e.sender.send('kt:archiveProgress', { id: o.id, done, total, file }); }, stopped: () => stop.v }); return { files, dest }; }
  finally { if (o.id) archiveJobs.delete(o.id); }
});
ipcMain.handle('kt:archiveCancel', (_e, id) => { const s = archiveJobs.get(id); if (s) s.v = true; });
ipcMain.handle('kt:archiveCreate', async (e, o) => {
  const stop = { v: false }; if (o.id) archiveJobs.set(o.id, stop); let last = 0;
  try { const files = await Archive.createZip(String(o.out), (o.inputs || []).map(String), { on: (done, total, file) => { const now = Date.now(); if (now - last < 250 && done < total) return; last = now; e.sender.send('kt:archiveProgress', { id: o.id, done, total, file }); }, stopped: () => stop.v }); return { files, path: o.out, size: fs.statSync(String(o.out)).size }; }
  finally { if (o.id) archiveJobs.delete(o.id); }
});
ipcMain.handle('kt:pickFile', async (_e, o) => { const r = await dialog.showOpenDialog(win, { properties: ['openFile', ...(o?.multiple ? ['multiSelections'] : [])], filters: o?.filters }); return r.canceled ? null : r.filePaths; });
ipcMain.handle('kt:pathInfo', async (_e, p) => { try { const st = await fs.promises.stat(String(p)); return { exists: true, dir: st.isDirectory(), size: st.size, name: path.basename(String(p)), parent: path.dirname(String(p)) }; } catch { return { exists: false }; } });

/* ---------- the Files add-on ---------- */
ipcMain.handle('kt:listDir', async (_e, p) => { try { const ents = await fs.promises.readdir(String(p), { withFileTypes: true }); const out = []; for (const en of ents) { try { const st = await fs.promises.stat(path.join(String(p), en.name)); out.push({ name: en.name, path: path.join(String(p), en.name), dir: st.isDirectory(), size: st.isFile() ? st.size : 0, mtime: st.mtimeMs }); } catch { /* vanished */ } } return { entries: out, exists: true }; } catch { return { entries: [], exists: false }; } });
ipcMain.handle('kt:deletePath', async (_e, p) => { try { await shell.trashItem(String(p)); return { ok: true }; } catch { try { await fs.promises.rm(String(p), { recursive: true, force: true }); return { ok: true }; } catch { return { ok: false }; } } });
ipcMain.handle('kt:roots', () => ({ roots: [engine?.defaultDir || app.getPath('downloads'), app.getPath('downloads'), app.getPath('videos'), app.getPath('home')].filter((x, i, a) => x && a.indexOf(x) === i) }));

/* ---------- yt-dlp: what a page offers, the binary ---------- */
ipcMain.handle('kt:videoInfo', (_e, o) => Ytdlp.info(String(o.url), o));
ipcMain.handle('kt:videoReady', async (e) => { try { await Ytdlp.ensure((p) => e.sender.send('kt:update-progress', { pct: p.total ? Math.round((p.got / p.total) * 100) : 0, got: p.got, total: p.total, what: 'yt-dlp' })); return { ok: true, version: await Ytdlp.version() }; } catch (err) { return { ok: false, why: String(err.message) }; } });
ipcMain.handle('kt:videoVersion', async () => ({ version: Ytdlp.haveBinary() ? await Ytdlp.version() : null, ready: Ytdlp.haveBinary() }));
ipcMain.handle('kt:videoUpdate', async () => Ytdlp.update(true));
ipcMain.handle('kt:isVideoHost', (_e, u) => { try { return Ytdlp.VIDEO_HOSTS.test(new URL(String(u)).hostname); } catch { return false; } });

/* ---------- the player: ffmpeg for clips, files beside a video, a file's bytes ---------- */
ipcMain.handle('kt:ffmpegAvailable', () => Ffmpeg.available());
ipcMain.handle('kt:ffmpeg', (e, o) => { let last = 0; return Ffmpeg.run(String(o.id), (o.args || []).map(String), (p) => { const now = Date.now(); if (now - last < 300 && !p.done) return; last = now; e.sender.send('kt:ffmpegProgress', { id: o.id, ...p }); }); });
ipcMain.handle('kt:ffmpegCancel', (_e, id) => Ffmpeg.cancel(String(id)));
ipcMain.handle('kt:ffprobe', (_e, p) => Ffmpeg.probe(String(p)));
ipcMain.handle('kt:writeTemp', async (_e, o) => { const dir = path.join(app.getPath('temp'), 'kurokawa-clip'); fs.mkdirSync(path.join(dir, 'fonts'), { recursive: true }); const f = path.join(dir, String(o.name).replace(/[\\/]/g, '_')); await fs.promises.writeFile(f, String(o.text), 'utf8'); return f; });
ipcMain.handle('kt:siblings', async (_e, p) => { try { const dir = path.dirname(String(p)); const base = path.basename(String(p)).replace(/\.[^.]+$/, '').toLowerCase(); return (await fs.promises.readdir(dir)).filter((n) => n.toLowerCase().startsWith(base) && n !== path.basename(String(p))).map((n) => path.join(dir, n)); } catch { return []; } });
ipcMain.handle('kt:fileUrl', (_e, p) => 'file://' + String(p));

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
