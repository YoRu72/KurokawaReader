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
const StreamProxy = require('./streamproxy.cjs');
const TorrentStream = require('./torrentstream.cjs');
const Packs = require('./packs.cjs');
const Antivirus = require('./antivirus.cjs');
const ScreenTr = require('./screentr.cjs');
let quitting = false;
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
function saveState() { if (!win) return; try { const b = win.getNormalBounds(); fs.writeFileSync(statePath(), JSON.stringify({ ...loadState(), ...b, maximized: win.isMaximized() })); } catch { /* ignore */ } }
/* ---------- the computer's side of the downloads: a progress bar on the taskbar / dock, a count on the dock,
   the computer kept awake while they run, and what to do when they are all done ---------- */
let awakeId = -1; const deskPrefs = { keepAwake: true, whenDone: 'nothing' }; let wasActive = false;
function onDesktopTasks(tasks) {
  if (!Array.isArray(tasks) || !win || win.isDestroyed()) return;
  const moving = tasks.filter((x) => ['downloading', 'metadata', 'checking'].includes(x.state));
  const total = moving.reduce((n, x) => n + (Number(x.total) || 0), 0), done = moving.reduce((n, x) => n + (Number(x.done) || 0), 0);
  try { win.setProgressBar(moving.length ? (total > 0 ? Math.min(1, done / total) : 2) : -1); } catch { /* not here */ }
  try { if (process.platform !== 'win32') app.setBadgeCount(moving.length); } catch { /* not here */ }
  const { powerSaveBlocker } = require('electron');
  if (moving.length && deskPrefs.keepAwake && awakeId < 0) awakeId = powerSaveBlocker.start('prevent-app-suspension');
  if ((!moving.length || !deskPrefs.keepAwake) && awakeId >= 0) { try { powerSaveBlocker.stop(awakeId); } catch { /* gone */ } awakeId = -1; }
  // (All done — something was running and nothing is now, none failed in between —: as chosen.)
  if (wasActive && !moving.length && !tasks.some((x) => x.state === 'queued') && deskPrefs.whenDone !== 'nothing') whenAllDone(deskPrefs.whenDone);
  wasActive = moving.length > 0;
}
function whenAllDone(what) {
  const { exec } = require('node:child_process'); const p = process.platform;
  const cmd = what === 'sleep' ? (p === 'win32' ? 'rundll32.exe powrprof.dll,SetSuspendState 0,1,0' : p === 'darwin' ? 'pmset sleepnow' : 'systemctl suspend')
    : what === 'shutdown' ? (p === 'win32' ? 'shutdown /s /t 60' : p === 'darwin' ? 'osascript -e \'tell app "System Events" to shut down\'' : 'systemctl poweroff') : what === 'quit' ? null : null;
  if (what === 'quit') { setTimeout(() => app.quit(), 3000); return; }
  if (cmd) setTimeout(() => exec(cmd, () => undefined), 5000);
}
function send(channel, payload) { if (win && !win.webContents.isLoading()) win.webContents.send(channel, payload); if (channel === 'kt:tasks' && mini && !mini.webContents.isLoading()) mini.webContents.send(channel, payload); }
/* ---------- Prism's mini window: small, on top of the others, the speed and what is downloading ---------- */
let mini = null;
function miniPath() { return path.join(app.getPath('userData'), 'mini-state.json'); }
function openMini() {
  if (mini) { mini.show(); mini.focus(); return; }
  let st = {}; try { st = JSON.parse(fs.readFileSync(miniPath(), 'utf8')); } catch { /* first time */ }
  mini = new BrowserWindow({ width: 320, height: 200, x: st.x, y: st.y, minWidth: 260, minHeight: 120, frame: false, resizable: true, alwaysOnTop: true, skipTaskbar: true, fullscreenable: false, maximizable: false, minimizable: false, backgroundColor: '#17181a', title: 'Kurokawa Tools',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  mini.setAlwaysOnTop(true, 'floating'); mini.setVisibleOnAllWorkspaces?.(true);
  mini.loadURL('app://kurokawa/index.html#/mini');
  const keep = () => { try { const b = mini.getBounds(); fs.writeFileSync(miniPath(), JSON.stringify({ x: b.x, y: b.y })); } catch { /* ignore */ } };
  mini.on('move', keep); mini.on('closed', () => { mini = null; });
}
function closeMini() { if (mini) mini.close(); }

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
  win.on('resize', saveState); win.on('move', saveState);
  // (The screen translator kept in the tray: closing the window hides it; Quit is in the tray's menu.)
  win.on('close', (e) => { saveState(); if (!quitting && ScreenTr.keepInTray()) { e.preventDefault(); win.hide(); } });
  win.on('closed', () => { win = null; closeMini(); });
  // (The mini window when the main one is put away, if chosen.)
  win.on('minimize', () => { if (loadState().miniOnMinimize) openMini(); });
  win.on('restore', () => { if (loadState().miniOnMinimize) closeMini(); });
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
    engine.onTasks((tasks) => { lastAria = tasks; const all = allTasks(); send('kt:tasks', all); onDesktopTasks(all); });
    setTimeout(() => void Ytdlp.maybeUpdate(), 15000); setInterval(() => void Ytdlp.maybeUpdate(), 6 * 3600000);
    createWindow();
    ScreenTr.init({
      showMain: (route) => { if (!win) createWindow(); if (win.isMinimized()) win.restore(); win.show(); win.focus(); if (route) win.webContents.executeJavaScript(`location.hash = ${JSON.stringify('#' + route)}`).catch(() => undefined); },
      hideMain: () => { if (win) win.hide(); },
      quit: () => { quitting = true; app.quit(); },
    });
    process.argv.slice(1).forEach(takeArg);
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !ScreenTr.keepInTray()) app.quit(); });
  app.on('before-quit', () => { quitting = true; ScreenTr.stopAll(); engine?.stop(); videos?.stop(); StreamProxy.stop(); });
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
ipcMain.handle('kt:exists', (_e, ps) => (Array.isArray(ps) ? ps : []).map((p) => { try { return require('node:fs').existsSync(String(p)); } catch { return false; } }));
ipcMain.handle('kt:mini', (_e, o) => { const a = o && o.action; if (a === 'open') openMini(); else if (a === 'close') closeMini(); else if (a === 'main') { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } } else if (a === 'auto') { try { const s = loadState(); s.miniOnMinimize = !!o.on; fs.writeFileSync(statePath(), JSON.stringify(s)); } catch { /* ignore */ } } return { open: !!mini }; });
// A site opened in a window of the app's own session (the one its requests use), for the user to pass the
// site's browser check by hand; resolves when the window is closed.
ipcMain.handle('kt:siteWindow', (_e, o) => new Promise((resolve) => { const u = String(o && o.url || ''); if (!/^https:\/\//.test(u)) { resolve(false); return; } const w = new BrowserWindow({ width: 520, height: 720, parent: win || undefined, title: String(o.title || ''), autoHideMenuBar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } }); w.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); w.on('closed', () => resolve(true)); w.loadURL(u); }));
/* ---------- the app's browser (the computer): a site in a window of the app's session, its DNS over HTTPS
   included; a file it downloads goes to the app's Add sheet, «Grab links» hands the page's links and media to
   the app to pick from ---------- */
const GRAB_JS = "(function () {\nvar o = [], s = {};\nfunction add(u, t, k) {\nif (!u || typeof u !== 'string') return;\ntry { u = new URL(u.replace(/\\\\\\//g, '/').replace(/\\\\u0026/gi, '&').replace(/&amp;/g, '&'), location.href).href; } catch (x) { return; }\nif (s[u] || !/^(https?:|magnet:)/i.test(u)) return;\ns[u] = 1; o.push({ href: u, text: (t || '').trim().slice(0, 200), kind: k || '' });\n}\nvar media = /\\.(m3u8|mpd|mp4|mkv|webm|m4v|mov)(\\?|#|$)/i, audio = /\\.(mp3|m4a|flac|ogg|opus|aac|wav)(\\?|#|$)/i;\nvar title = document.title;\ndocument.querySelectorAll('video, audio').forEach(function (v) {\nvar k = v.tagName === 'AUDIO' ? 'music' : 'video', name = v.getAttribute('title') || v.getAttribute('aria-label') || title;\nif (v.currentSrc && !/^blob:/.test(v.currentSrc)) add(v.currentSrc, name, k);\nif (v.src && !/^blob:/.test(v.src)) add(v.src, name, k);\nv.querySelectorAll('source[src]').forEach(function (x) { add(x.src, name, k); });\n});\ndocument.querySelectorAll('a[href]').forEach(function (a) { add(a.href, a.textContent || a.title || a.getAttribute('download'), media.test(a.href) ? 'video' : audio.test(a.href) ? 'music' : 'a'); });\ndocument.querySelectorAll('source[src], img[src], iframe[src], track[src], embed[src], object[data]').forEach(function (e) { add(e.currentSrc || e.src || e.data, e.alt || e.title || '', e.tagName.toLowerCase()); });\ndocument.querySelectorAll('[data-src], [data-href], [data-url], [data-file], [data-video], [data-video-src], [data-hls], [data-mp4]').forEach(function (e) {\nvar d = e.dataset, u = d.video || d.videoSrc || d.hls || d.mp4 || d.src || d.href || d.url || d.file;\nadd(u, e.textContent || e.title, d.video || d.videoSrc || d.hls || d.mp4 || media.test(u || '') ? 'video' : 'data');\n});\ndocument.querySelectorAll('meta[property^=\"og:video\"], meta[name^=\"og:video\"], meta[property=\"og:audio\"], meta[name=\"twitter:player:stream\"], meta[itemprop=\"contentUrl\"], link[rel=\"video_src\"]').forEach(function (m) {\nvar u = m.getAttribute('content') || m.getAttribute('href') || '', p = (m.getAttribute('property') || m.getAttribute('name') || '');\nif (/:(type|width|height|duration|tag|release_date)$/.test(p) || !/^(https?:)?\\/\\//i.test(u)) return;\nadd(u, title, /audio/.test(p) ? 'music' : 'video');\n});\ndocument.querySelectorAll('script[type=\"application/ld+json\"]').forEach(function (sc) {\n(sc.textContent.match(/\"(contentUrl|embedUrl)\"\\s*:\\s*\"[^\"]+\"/g) || []).forEach(function (m) { add(m.replace(/^[^:]*:\\s*\"/, '').replace(/\"$/, ''), title, 'video'); });\n});\ntry {\nvar html = document.documentElement.innerHTML;\n(html.match(/https?:(?:\\\\?\\/){2}[^\"'\\s<>()\\\\]+(?:\\\\\\/[^\"'\\s<>()\\\\]+)*?\\.(?:m3u8|mpd|mp4|webm|mkv|m4v|mov|mp3|m4a|flac)(?:\\?[^\"'\\s<>()]*)?/gi) || []).slice(0, 300).forEach(function (u) { add(u, '', audio.test(u) ? 'music' : 'video'); });\n} catch (x) {}\ntry {\nperformance.getEntriesByType('resource').forEach(function (r) {\nif (media.test(r.name) || r.initiatorType === 'video' || /\\.m3u8|\\.mpd|\\/manifest|videoplayback/i.test(r.name)) { if (!/\\.(ts|m4s)(\\?|$)/i.test(r.name)) add(r.name, '', 'video'); }\nelse if (audio.test(r.name) || r.initiatorType === 'audio') add(r.name, '', 'music');\nelse if (/\\.(zip|7z|rar|apk|pdf|epub)(\\?|$)/i.test(r.name)) add(r.name, '', 'media');\n});\n} catch (x) {}\nreturn { url: location.href, title: title, links: o.slice(0, 3000) };\n})()";
let browserWin = null; let browserMedia = new Map();
function openBrowser(url) {
  const u = /^https?:\/\//i.test(url) ? url : 'https://duckduckgo.com/';
  if (browserWin) { browserWin.loadURL(u); browserWin.show(); browserWin.focus(); return; }
  const w = browserWin = new BrowserWindow({ width: 1100, height: 800, parent: undefined, title: 'Kurokawa Tools', autoHideMenuBar: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  browserMedia = new Map();
  const toApp = (o) => { if (win && !win.webContents.isLoading()) { win.webContents.send('kt:browser', o); if (win.isMinimized()) win.restore(); win.focus(); } };
  const grab = async () => { try { const page = await w.webContents.executeJavaScript(GRAB_JS, true); for (const [m, k] of browserMedia) page.links.push({ href: m, text: '', kind: k === 1 ? 'media' : k }); toApp({ kind: 'links', ...page, ua: w.webContents.getUserAgent() }); } catch (e) { dialog.showErrorBox('Kurokawa Tools', String(e && e.message || e)); } };
  w.setMenu(Menu.buildFromTemplate([
    { label: '‹', accelerator: 'Alt+Left', click: () => { if (w.webContents.navigationHistory?.canGoBack?.() ?? w.webContents.canGoBack()) w.webContents.goBack(); } },
    { label: '›', accelerator: 'Alt+Right', click: () => { if (w.webContents.navigationHistory?.canGoForward?.() ?? w.webContents.canGoForward()) w.webContents.goForward(); } },
    { label: '↻', accelerator: 'F5', click: () => w.webContents.reload() },
    { label: 'Grab links', accelerator: 'CmdOrCtrl+G', click: () => void grab() },
    { label: 'Copy address', accelerator: 'CmdOrCtrl+L', click: () => require('electron').clipboard.writeText(w.webContents.getURL()) },
    { label: 'Open in system browser', click: () => shell.openExternal(w.webContents.getURL()) },
  ]));
  w.webContents.setWindowOpenHandler(({ url: to }) => { if (/^magnet:/i.test(to)) { toApp({ kind: 'download', url: to }); return { action: 'deny' }; } if (/^https?:/i.test(to)) w.loadURL(to); return { action: 'deny' }; });
  w.webContents.on('will-navigate', (e, to) => { if (/^magnet:/i.test(to)) { e.preventDefault(); toApp({ kind: 'download', url: to }); } });
  w.webContents.on('page-title-updated', (_e, t) => w.setTitle(`${t} — Kurokawa Tools`));
  const onDl = (e, item, wc) => { if (wc !== w.webContents) return; e.preventDefault(); const url = item.getURL(); const name = item.getFilename(); void w.webContents.session.cookies.get({ url }).catch(() => []).then((cs) => toApp({ kind: 'download', url, name, referer: w.webContents.getURL(), ua: w.webContents.getUserAgent(), cookie: cs.map((c) => `${c.name}=${c.value}`).join('; ') })); };
  w.webContents.session.on('will-download', onDl);
  // (A medium the page loaded: by its address, by what the server said it is — video/…, audio/…, a playlist or a
  // manifest —, or because a <video> or <audio> element asked for it. A stream's pieces are left out.)
  const seen = (d) => {
    if (d.webContentsId !== w.webContents.id || browserMedia.size >= 400 || browserMedia.has(d.url) || !/^https?:/i.test(d.url)) return;
    const h = d.responseHeaders || {}; const ct = String((Object.entries(h).find(([k]) => k.toLowerCase() === 'content-type') || [, ['']])[1][0] || '').toLowerCase();
    const manifest = /\.m3u8|\.mpd|\/manifest(\.|\/|\?|$)|videoplayback\?/i.test(d.url) || /mpegurl|dash\+xml/.test(ct);
    if (!manifest && (/\.(ts|m4s|aac|vtt|key)(\?|$)|[/_-](seg|segment|chunk|frag|fragment|init)[-_]?\d*\.(m4s|mp4|m4v|m4a|ts)(\?|$)/i.test(d.url) || /mp2t/.test(ct))) return;
    let kind = '';
    if (manifest || /^video\//.test(ct) || d.resourceType === 'media' && !/^audio\//.test(ct) || /\.(mp4|mkv|webm|m4v|mov)(\?|$)/i.test(d.url)) kind = 'video';
    else if (/^audio\//.test(ct) || /\.(mp3|m4a|flac|ogg|opus|wav)(\?|$)/i.test(d.url)) kind = 'music';
    else if (/\.(zip|7z|rar|apk|pdf|epub)(\?|$)/i.test(d.url) || /^application\/(zip|x-7z|x-rar|pdf|epub|vnd\.android)/.test(ct)) kind = 'media';
    if (kind) browserMedia.set(d.url, kind);
  };
  w.webContents.session.webRequest.onCompleted({ urls: ['http://*/*', 'https://*/*'] }, seen);
  w.on('closed', () => { try { w.webContents.session.removeListener('will-download', onDl); } catch { /* gone */ } browserWin = null; });
  w.webContents.on('did-navigate', () => { browserMedia = new Map(); });
  w.loadURL(u);
}
ipcMain.handle('kt:browse', (_e, o) => { openBrowser(String(o && o.url || '')); return true; });
ipcMain.handle('kt:move', (_e, id, how) => E().move(id, how));
ipcMain.handle('kt:setUrl', (_e, id, url) => E().setUrl(id, url));
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
  try { const dest = o.dest === 'cache:' ? path.join(require('os').tmpdir(), 'kurokawa-archive-view') : o.dest || path.dirname(String(o.path)); const files = await Archive.extract(String(o.path), dest, { only: Array.isArray(o.only) ? o.only.map(String) : undefined, inPlace: !!o.inPlace && !o.only, deleteAfter: !!o.deleteAfter, replace: o.replace || 'replace', password: o.password, verifyFirst: !!o.verifyFirst, ...(typeof o.keepFree === 'number' && o.keepFree >= 0 ? { keepFree: o.keepFree } : {}) }, { on: (done, total, file) => { const now = Date.now(); if (now - last < 250 && done < total) return; last = now; e.sender.send('kt:archiveProgress', { id: o.id, done, total, file }); }, stopped: () => stop.v }); return { files, dest }; }
  finally { if (o.id) archiveJobs.delete(o.id); }
});
ipcMain.handle('kt:archiveTest', async (e, o) => {
  const stop = { v: false }; if (o.id) archiveJobs.set(o.id, stop); let last = 0;
  try { return await Archive.test(String(o.path), o.password, { on: (done, total, file) => { const now = Date.now(); if (now - last < 250 && done < total) return; last = now; e.sender.send('kt:archiveProgress', { id: o.id, done, total, file }); }, stopped: () => stop.v }); }
  finally { if (o.id) archiveJobs.delete(o.id); }
});
ipcMain.handle('kt:hashFile', (_e, p) => new Promise((res, rej) => { const crypto = require('node:crypto'); const hs = { md5: crypto.createHash('md5'), sha1: crypto.createHash('sha1'), sha256: crypto.createHash('sha256') }; const st = fs.createReadStream(String(p), { highWaterMark: 1 << 20 }); st.on('data', (c) => { for (const h of Object.values(hs)) h.update(c); }); st.on('error', rej); st.on('end', () => res({ md5: hs.md5.digest('hex'), sha1: hs.sha1.digest('hex'), sha256: hs.sha256.digest('hex'), size: fs.statSync(String(p)).size })); }));
// (The computer's font folders, for styled subtitles: the system's and the user's own.)
ipcMain.handle('kt:fontDirs', () => { const os = require('node:os'); const home = os.homedir(); const c = process.platform === 'win32' ? [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'), path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts')] : process.platform === 'darwin' ? ['/System/Library/Fonts', '/Library/Fonts', path.join(home, 'Library', 'Fonts')] : ['/usr/share/fonts', '/usr/local/share/fonts', path.join(home, '.local', 'share', 'fonts'), path.join(home, '.fonts')]; return c.filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } }); });
// (Their fonts' family names, read here by seeking — only the table of contents and the «name» table of each file, a
// few KB, not the whole font —, kept between calls; a file read again only when it changed.)
const fontIx = new Map();
function fontFamilies(file) {
  const fd = fs.openSync(file, 'r'); const rd = (off, len) => { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, off); return b.subarray(0, n); };
  const out = new Set();
  const one = (off) => {
    const hd = rd(off, 12); if (hd.length < 12) return; const n = hd.readUInt16BE(4); const dir = rd(off + 12, n * 16);
    for (let i = 0; i + 16 <= dir.length; i += 16) {
      if (dir.toString('latin1', i, i + 4) !== 'name') continue;
      const to = dir.readUInt32BE(i + 8), tl = Math.min(dir.readUInt32BE(i + 12), 256 * 1024); const t = rd(to, tl); if (t.length < 6) return;
      const count = t.readUInt16BE(2), strs = t.readUInt16BE(4);
      for (let j = 0; j < count; j++) { const r = 6 + j * 12; if (r + 12 > t.length) break; const pid = t.readUInt16BE(r), eid = t.readUInt16BE(r + 2), nid = t.readUInt16BE(r + 6), len = t.readUInt16BE(r + 8), so = strs + t.readUInt16BE(r + 10);
        if (![1, 4, 16].includes(nid) || so + len > t.length) continue; let str = '';
        if (pid === 3 || pid === 0) { for (let k = 0; k + 1 < len; k += 2) str += String.fromCharCode(t.readUInt16BE(so + k)); } else if (pid === 1 && eid === 0) str = t.toString('latin1', so, so + len);
        str = str.replace(/\0/g, '').trim(); if (str) out.add(str); }
      return;
    }
  };
  try { const h = rd(0, 12); if (h.toString('latin1', 0, 4) === 'ttcf') { const n = Math.min(h.readUInt32BE(8), 64); const offs = rd(12, n * 4); for (let i = 0; i + 4 <= offs.length; i += 4) one(offs.readUInt32BE(i)); } else one(0); } finally { fs.closeSync(fd); }
  return [...out];
}
ipcMain.handle('kt:fontIndex', async (_e, dirs) => {
  const files = []; const walk = (d, depth) => { let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of ents) { const p = path.join(d, e.name); if (e.isDirectory() && depth < 3) walk(p, depth + 1); else if (/\.(ttf|otf|ttc|otc)$/i.test(e.name)) files.push(p); } };
  for (const d of (Array.isArray(dirs) ? dirs : []).map(String)) walk(d, 0);
  const out = [];
  for (const f of files.slice(0, 6000)) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    const had = fontIx.get(f); if (had && had.size === st.size && had.mtime === st.mtimeMs) { out.push(had); continue; }
    let families = []; try { families = fontFamilies(f); } catch { /* not a font this reads */ }
    if (!families.length) families = [path.basename(f).replace(/\.[^.]+$/, '').replace(/[-_](regular|bold|italic|medium|light|semibold|black|thin)$/i, '').replace(/[-_]+/g, ' ')];
    const x = { path: f, size: st.size, mtime: st.mtimeMs, families }; fontIx.set(f, x); out.push(x);
  }
  return out;
});
ipcMain.handle('kt:desktopPrefs', (_e, o) => { if (o && typeof o === 'object') { if ('keepAwake' in o) deskPrefs.keepAwake = !!o.keepAwake; if (['nothing', 'quit', 'sleep', 'shutdown'].includes(o.whenDone)) deskPrefs.whenDone = o.whenDone; } return deskPrefs; });
ipcMain.handle('kt:streamUrl', async (_e, o) => ({ url: await TorrentStream.url(E(), String(o.id), Number(o.fileIndex) || 0) }));
ipcMain.handle('kt:audioUrl', async () => ({ url: await StreamProxy.audioBase() }));
ipcMain.handle('kt:proxyUrl', (_e, o) => StreamProxy.url(String(o.url), o.headers || {}));
ipcMain.handle('kt:clipboardText', () => require('electron').clipboard.readText());
// DNS over HTTPS for the app's own requests (Chromium's resolver), the same providers as on Android.
const DOH = { cloudflare: 'https://cloudflare-dns.com/dns-query', google: 'https://dns.google/dns-query', quad9: 'https://dns.quad9.net/dns-query', adguard: 'https://dns.adguard-dns.com/dns-query' };
ipcMain.handle('kt:setDoh', (_e, o) => { const p = String(o.provider || 'off'); try { app.configureHostResolver(p === 'off' ? { secureDnsMode: 'off' } : { secureDnsMode: 'secure', secureDnsServers: [DOH[p] || p] }); } catch (err) { throw new Error(String(err.message || err)); } return { provider: p }; });
ipcMain.handle('kt:openPath', async (_e, p) => { const err = await shell.openPath(String(p)); if (err) throw new Error(err); });
ipcMain.handle('kt:archiveRestore', async (_e, o) => ({ left: await Archive.restore(String(o.path)) }));
ipcMain.handle('kt:archiveFree', async (_e, o) => { let d = String(o.dir); while (d && !fs.existsSync(d)) { const up = path.dirname(d); if (up === d) break; d = up; } return { free: await Archive.freeSpace(d) }; });
ipcMain.handle('kt:archiveExisting', async (_e, o) => ({ existing: await Archive.existing(String(o.dest), (o.names || []).map(String)) }));
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
ipcMain.handle('kt:avScan', (_e, o) => Antivirus.scan(o.cfg || {}, String(o.file)));
ipcMain.handle('kt:avAvailable', () => Antivirus.available());
ipcMain.handle('kt:packStatus', () => Packs.status());
ipcMain.handle('kt:packInstall', async (e, o) => { await Packs.install(o, (p) => e.sender.send('kt:packProgress', p)); });
ipcMain.handle('kt:packCancel', (_e, n) => Packs.cancel(String(n)));
ipcMain.handle('kt:packRemove', (_e, n) => Packs.remove(String(n)));
ipcMain.handle('kt:ffmpegAvailable', () => Ffmpeg.available());
ipcMain.handle('kt:ffmpeg', (e, o) => { let last = 0; return Ffmpeg.run(String(o.id), (o.args || []).map(String), (p) => { const now = Date.now(); if (now - last < 300 && !p.done) return; last = now; e.sender.send('kt:ffmpegProgress', { id: o.id, ...p }); }); });
ipcMain.handle('kt:ffmpegCancel', (_e, id) => Ffmpeg.cancel(String(id)));
ipcMain.handle('kt:ffprobe', (_e, p) => Ffmpeg.probe(String(p)));
const WifiShare = require('./wifishare.cjs');
ipcMain.handle('kt:shareWifi', (_e, o) => WifiShare.start((o.paths || []).map(String), (o.names || []).map(String)));
ipcMain.handle('kt:shareWifiStop', () => { WifiShare.stop(); });
ipcMain.handle('kt:shareWifiStatus', () => WifiShare.status());
ipcMain.handle('kt:saveText', async (_e, o) => { const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), String(o && o.name || 'kurokawa.txt')) }); if (r.canceled || !r.filePath) return { path: null }; await fs.promises.writeFile(r.filePath, String(o && o.text || ''), 'utf8'); return { path: r.filePath }; });
ipcMain.handle('kt:writeTempBytes', async (_e, o) => { const dir = path.join(app.getPath('temp'), 'kurokawa-clip', o.sub ? String(o.sub).replace(/[\\/]/g, '_') : ''); fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, String(o.name).replace(/[\\/]/g, '_')); await fs.promises.writeFile(f, Buffer.from(String(o.b64), 'base64')); return f; });
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
  const ext = process.platform === 'win32' ? '.exe' : process.platform === 'darwin' ? '.dmg' : '.AppImage';
  const file = path.join(app.getPath('temp'), `KurokawaTools-update-${Date.now()}` + ext);
  await fastFetch(url, file, (got, total) => e.sender.send('kt:update-progress', { pct: total ? Math.round((got / total) * 100) : 0, got, total }));
  const { spawn } = require('node:child_process');
  if (process.platform === 'linux') {
    const current = process.env.APPIMAGE; fs.chmodSync(file, 0o755);
    if (current) { const script = path.join(app.getPath('temp'), 'kt-update.sh'); fs.writeFileSync(script, `#!/bin/sh\nsleep 2\nmv -f "${file}" "${current}" && chmod +x "${current}" && ("${current}" >/dev/null 2>&1 &)\nrm -f "$0"\n`, { mode: 0o755 }); spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref(); setTimeout(() => app.quit(), 500); return current; }
    shell.showItemInFolder(file); return file;
  }
  // (Windows, installed: the new version put in quietly over this one — no wizard to click through — and opened
  // again when it is in, as the phone's own installer does. The portable app: its installer opened, as before.)
  if (process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_FILE) {
    try { spawn(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); setTimeout(() => app.quit(), 300); return file; } catch { /* opened instead */ }
  }
  const err = await shell.openPath(file); if (err) throw new Error(err);
  setTimeout(() => app.quit(), 1500); return file;
});
/** A file fetched over several connections at once (8, each its own range) when the server allows ranges — as the
 *  phone's downloader does —, else in one stream; `tick(got, total)` as it comes. */
async function fastFetch(url, file, tick) {
  let total = 0, ranges = false, final = url;
  try { const h = await net.fetch(url, { headers: { range: 'bytes=0-0' } }); final = h.url || url; const cr = h.headers.get('content-range') || ''; const m = /\/(\d+)$/.exec(cr); if (h.status === 206 && m) { total = Number(m[1]); ranges = true; } else total = Number(h.headers.get('content-length') || 0); try { await h.body?.cancel(); } catch { /* fine */ } } catch { /* one stream */ }
  if (!ranges || total < 4 * 1048576) {
    const res = await net.fetch(url); if (!res.ok || !res.body) throw new Error('HTTP ' + res.status); total = total || Number(res.headers.get('content-length') || 0);
    const out = fs.createWriteStream(file); const reader = res.body.getReader(); let got = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r)); got += value.length; tick(got, total); }
    await new Promise((r) => out.end(r)); return;
  }
  const fd = fs.openSync(file, 'w'); fs.ftruncateSync(fd, total); let got = 0; const N = 8; const part = Math.ceil(total / N); let last = 0;
  const one = async (k) => {
    let from = k * part; const to = Math.min(total, (k + 1) * part) - 1;
    for (let tries = 0; from <= to; tries++) {
      try {
        const res = await net.fetch(final, { headers: { range: `bytes=${from}-${to}` } }); if (res.status !== 206 || !res.body) throw new Error('HTTP ' + res.status);
        const reader = res.body.getReader();
        for (;;) { const { done, value } = await reader.read(); if (done) break; const b = Buffer.from(value); fs.writeSync(fd, b, 0, b.length, from); from += b.length; got += b.length; const now = Date.now(); if (now - last > 150) { last = now; tick(got, total); } }
      } catch (err) { if (tries >= 4) throw err; await new Promise((r) => setTimeout(r, 800 * (tries + 1))); }
    }
  };
  try { await Promise.all(Array.from({ length: N }, (_, k) => one(k))); } finally { fs.closeSync(fd); }
  tick(total, total);
}
