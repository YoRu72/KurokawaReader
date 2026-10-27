// Electron shell: serves the built web app from an app:// origin (so IndexedDB,
// fonts and absolute paths behave exactly as on the web) and forwards files the
// OS asks us to open (double-click, "Open with", drag onto the icon).
const { app, BrowserWindow, protocol, net, ipcMain, shell, Menu, clipboard, nativeImage } = require('electron');
// (Windows shows the app's notifications under its own name only with this.)
if (process.platform === 'win32') app.setAppUserModelId('app.kurokawa.reader');
const path = require('node:path');
const fs = require('node:fs');

const DIST = path.join(__dirname, 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.epub': 'application/epub+zip', '.map': 'application/json' };

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

let win = null;
const pending = [];
const DOC_EXT = /\.(epub|pdf|docx|xlsx|pptx|txt|md|markdown|html?|fb2|odt|cbz|csv|tsv|jpe?g|png|gif|webp|ttf|otf|woff2?|zip)$/i;

function queueFile(p) {
  if (!p || !DOC_EXT.test(p) || !fs.existsSync(p)) return;
  pending.push(p);
  flush();
}
function flush() {
  if (!win || !win.webContents || win.webContents.isLoading()) return;
  while (pending.length) {
    const p = pending.shift();
    try {
      const data = fs.readFileSync(p);
      win.webContents.send('kr:open-file', { name: path.basename(p), data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) });
    } catch (e) { console.error('open-file failed', e); }
  }
}

// Remember window size/position between runs.
const statePath = () => path.join(app.getPath('userData'), 'window-state.json');
function loadState() { try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch { return {}; } }
function saveState() { if (!win) return; try { const b = win.getNormalBounds(); fs.writeFileSync(statePath(), JSON.stringify({ ...b, maximized: win.isMaximized() })); } catch { /* ignore */ } }

function send(channel, payload) { if (win && !win.webContents.isLoading()) win.webContents.send(channel, payload); }

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'Add books…', click: () => send('kr:command', 'import') },
      { label: 'Scan this computer…', click: () => send('kr:command', 'scan') },
      { type: 'separator' },
      { label: 'Library', click: () => send('kr:command', 'library') },
      { label: 'Settings', click: () => send('kr:command', 'settings') },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit' },
    ] },
    { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [
      { label: 'Visual options', click: () => send('kr:command', 'options') },
      { label: 'Search in book', click: () => send('kr:command', 'search') },
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
    ] },
    { label: 'Help', submenu: [
      { label: 'Check for updates', click: () => send('kr:command', 'update') },
      { label: 'Releases on GitHub', click: () => shell.openExternal('https://github.com/YoRu72/KurokawaReader/releases') },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const st = loadState();
  win = new BrowserWindow({
    width: st.width || 1180, height: st.height || 820, x: st.x, y: st.y, minWidth: 420, minHeight: 600,
    backgroundColor: '#121314', title: 'KurokawaReader', autoHideMenuBar: true,
    icon: path.join(__dirname, process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('did-finish-load', flush);
  win.loadURL('app://kurokawa/index.html');
  if (st.maximized) win.maximize();
  win.on('resize', saveState); win.on('move', saveState); win.on('close', saveState);
  // (The app's hidden browser windows go with it: they would keep it running unseen.)
  win.on('closed', () => { win = null; closeHelpers(); });
}

// kurokawareader:// links (OAuth redirects for cloud sync)
if (process.defaultApp) { if (process.argv.length >= 2) app.setAsDefaultProtocolClient('kurokawareader', process.execPath, [path.resolve(process.argv[1])]); } else app.setAsDefaultProtocolClient('kurokawareader');
function handleUrl(u) { if (u && /^kurokawareader:/i.test(u)) { const go = () => send('kr:open-url', u); if (win && !win.webContents.isLoading()) go(); else setTimeout(go, 1500); } }
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', (_e, argv) => { argv.slice(1).forEach((a) => { if (/^kurokawareader:/i.test(a)) handleUrl(a); else queueFile(a); }); if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.on('open-url', (e, u) => { e.preventDefault(); handleUrl(u); });
  app.on('open-file', (e, p) => { e.preventDefault(); queueFile(p); });
  process.on('uncaughtException', (err) => { console.error('[kurokawa] uncaught', err); });
app.whenReady().then(() => {
    protocol.handle('app', (req) => {
      const url = new URL(req.url);
      let p = decodeURIComponent(url.pathname);
      if (p === '/' || p === '') p = '/index.html';
      let file = path.normalize(path.join(DIST, p));
      if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
      return net.fetch('file://' + file).then((res) => new Response(res.body, { headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' } }));
    });
    buildMenu();
    // Let the page list fonts installed on this computer (Local Font Access API).
    const { session } = require('electron');
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(['local-fonts', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen'].includes(permission)));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => ['local-fonts', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen'].includes(permission));
    createWindow();
    process.argv.slice(app.isPackaged ? 1 : 2).forEach((a) => { if (/^kurokawareader:/i.test(a)) handleUrl(a); else queueFile(a); });
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
ipcMain.handle('kr:ready', () => { flush(); return true; });

// In-app update. First choice: electron-updater, which fetches only the parts of the new installer that
// differ from the one installed (the release carries latest.yml and the .blockmap for that) and installs it
// on quit — so an update is a few MB, not the whole program again. It needs the installed build (Windows
// NSIS, Linux AppImage); the portable EXE and the unsigned macOS app cannot use it, and if it fails for any
// reason the full-download path below takes over, so an update never breaks the app that is running.
function updaterOrNull() {
  if (process.env.PORTABLE_EXECUTABLE_DIR || process.platform === 'darwin' || !app.isPackaged) return null;
  try { const { autoUpdater } = require('electron-updater'); autoUpdater.autoDownload = false; autoUpdater.autoInstallOnAppQuit = true; autoUpdater.allowDowngrade = false; autoUpdater.logger = null; return autoUpdater; } catch { return null; }
}
// Background updates (Settings → download in the background): the difference is fetched quietly and installed
// when the app quits; the window is told when it is ready so it can offer a restart.
let downloadedVersion = null;
ipcMain.handle('kr:update-download', async (e, o) => {
  const updater = updaterOrNull(); if (!updater) return 'unsupported';
  if (downloadedVersion) return 'downloaded';
  updater.allowPrerelease = !!(o && o.beta);
  const r = await updater.checkForUpdates().catch(() => null);
  if (!r || !r.updateInfo || !r.updateInfo.version || r.updateInfo.version === app.getVersion()) return 'none';
  try { const files = await updater.downloadUpdate(); if (!files || !files.length) return 'none'; } catch (err) { console.warn('background update failed:', err && err.message); return 'none'; }
  downloadedVersion = r.updateInfo.version;
  return 'downloaded';
});
ipcMain.handle('kr:update-install', () => { const updater = updaterOrNull(); if (updater && downloadedVersion) setTimeout(() => updater.quitAndInstall(false, true), 300); return !!downloadedVersion; });

async function differentialUpdate(e, beta) {
  const updater = updaterOrNull(); if (!updater) return false;
  updater.allowPrerelease = !!beta;
  const r = await updater.checkForUpdates().catch(() => null);
  if (!r || !r.updateInfo || !r.updateInfo.version || r.updateInfo.version === app.getVersion()) return false;
  const onProgress = (p) => { try { e.sender.send('kr:update-progress', { pct: Math.round(p.percent || 0), got: p.transferred || 0, total: p.total || 0, speed: p.bytesPerSecond || 0 }); } catch { /* window gone */ } };
  updater.on('download-progress', onProgress);
  try {
    const files = await updater.downloadUpdate();
    if (!files || !files.length) return false;
  } catch (err) {
    updater.removeListener('download-progress', onProgress);
    console.warn('differential update failed, falling back to a full download:', err && err.message);
    return false;
  }
  updater.removeListener('download-progress', onProgress);
  setTimeout(() => updater.quitAndInstall(false, true), 800);
  return true;
}

ipcMain.handle('kr:install-update', async (e, url, opts) => {
  if (await differentialUpdate(e, opts && opts.beta)) return 'differential';
  const res = await net.fetch(url);
  if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
  const total = Number(res.headers.get('content-length') || 0);
  const ext = process.platform === 'win32' ? '.exe' : process.platform === 'darwin' ? '.dmg' : '.AppImage';
  const file = path.join(app.getPath('temp'), `KurokawaReader-update-${Date.now()}` + ext);
  // Old leftovers (a locked one from a previous attempt must never take the app down).
  try { for (const f of fs.readdirSync(app.getPath('temp'))) if (f.startsWith('KurokawaReader-update') && f !== path.basename(file)) { try { fs.unlinkSync(path.join(app.getPath('temp'), f)); } catch { /* still busy */ } } } catch { /* ignore */ }
  const out = fs.createWriteStream(file);
  let streamError = null;
  out.on('error', (err) => { streamError = err; });
  const reader = res.body.getReader();
  let got = 0; let lastT = Date.now(); let lastGot = 0; let speed = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.write(Buffer.from(value));
    got += value.length;
    const now = Date.now();
    if (now - lastT > 400) { speed = (got - lastGot) / ((now - lastT) / 1000); lastT = now; lastGot = got; }
    e.sender.send('kr:update-progress', { pct: total ? Math.round((got / total) * 100) : 0, got, total, speed });
  }
  await new Promise((r) => out.end(r));
  if (streamError) throw streamError;
  const { spawn } = require('child_process');
  const portableFile = process.env.PORTABLE_EXECUTABLE_FILE;
  if (process.platform === 'win32' && portableFile) {
    // Portable build: swap the running .exe for the new one once we have exited, then start it.
    const script = path.join(app.getPath('temp'), 'kr-update.cmd');
    fs.writeFileSync(script, [
      '@echo off', 'timeout /t 2 /nobreak >nul', 'set n=0',
      ':retry', 'set /a n+=1', 'if %n% gtr 60 goto fail',
      `move /y "${file}" "${portableFile}" >nul 2>&1 || (timeout /t 1 /nobreak >nul & goto retry)`,
      `start "" "${portableFile}"`, 'del "%~f0"', 'exit',
      ':fail', `start "" "${file}"`, 'del "%~f0"',
    ].join('\r\n'));
    spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    setTimeout(() => app.quit(), 500);
    return file;
  }
  if (process.platform === 'linux') {
    const current = process.env.APPIMAGE;
    fs.chmodSync(file, 0o755);
    if (current) {
      // Replace the running AppImage in place and relaunch it.
      const script = path.join(app.getPath('temp'), 'kr-update.sh');
      fs.writeFileSync(script, `#!/bin/sh\nsleep 2\nmv -f "${file}" "${current}" && chmod +x "${current}" && ("${current}" >/dev/null 2>&1 &)\nrm -f "$0"\n`, { mode: 0o755 });
      spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref();
      setTimeout(() => app.quit(), 500);
      return current;
    }
    shell.showItemInFolder(file); return file;
  }
  // Windows installer / macOS disk image: open it and get out of the way.
  const err = await shell.openPath(file);
  if (err) throw new Error(err);
  setTimeout(() => app.quit(), 1500);
  return file;
});
ipcMain.handle('kr:is-portable', () => !!process.env.PORTABLE_EXECUTABLE_DIR);

// Whole-device scan: the user's home folder (Documents, Downloads, Desktop, …) plus any
// other drives on Windows, limited in depth so it stays quick.
ipcMain.handle('kr:scan-device', async (_e, exts) => {
  const os = require('os');
  const fsp = require('fs/promises');
  const wanted = new Set((exts || []).map((x) => String(x).toLowerCase()));
  const roots = [os.homedir()];
  if (process.platform === 'win32') {
    for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') { const d = `${letter}:\\`; try { await fsp.access(d); roots.push(d); } catch { /* no such drive */ } }
  }
  const skip = new Set(['node_modules', 'AppData', 'Library', '.git', 'Windows', 'Program Files', 'Program Files (x86)', '$RECYCLE.BIN', 'System Volume Information']);
  const files = []; let visited = 0; let truncated = false;
  const queue = roots.map((r) => ({ dir: r, depth: 0 }));
  while (queue.length && files.length < 8000) {
    const { dir, depth } = queue.shift();
    if (++visited > 20000) { truncated = true; break; }
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 7 && !e.name.startsWith('.') && !skip.has(e.name)) queue.push({ dir: full, depth: depth + 1 }); continue; }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).slice(1).toLowerCase();
      if (wanted.size && !wanted.has(ext)) continue;
      try { const st = await fsp.stat(full); files.push({ path: full, name: e.name, size: st.size }); } catch { /* skip */ }
    }
  }
  if (queue.length) truncated = true;
  return { root: roots.join(' · '), files, truncated };
});
// Pages read for the sources (archive.org, Shamela, novel sites) go through the app's own session: its cookies
// go with them — a Cloudflare clearance passed in the window below is kept there — and the app's identity is
// a plain Chrome's (the Electron token in the user agent gets a browser check from some sites).
app.userAgentFallback = app.userAgentFallback.replace(/ ?Electron\/[\d.]+/, '').replace(/ ?KurokawaReader\/[\d.]+/, '');
ipcMain.handle('kr:http', async (_e, o) => {
  const headers = {}; for (const [k, v] of Object.entries(o.headers || {})) if (k.toLowerCase() !== 'accept-encoding') headers[k] = v;
  const res = await net.fetch(o.url, { method: o.method || 'GET', headers, body: o.body == null ? undefined : (o.bodyBase64 ? Buffer.from(o.body, 'base64') : o.body), useSessionCookies: true });
  const buf = Buffer.from(await res.arrayBuffer());
  const hs = {}; res.headers.forEach((v, k) => { hs[k.toLowerCase()] = v; });
  return { status: res.status, headers: hs, body: o.binary ? buf.toString('base64') : decodeText(buf, hs['content-type']), url: res.url };
});
// A page's text in its own charset: the header's, else a <meta> in its first bytes, else UTF-8.
function decodeText(buf, contentType) {
  let cs = /charset=["']?([\w-]+)/i.exec(contentType || '')?.[1];
  if (!cs) cs = /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 2048).toString('latin1'))?.[1];
  try { return new TextDecoder(cs || 'utf-8').decode(buf); } catch { return buf.toString('utf8'); }
}
// Long work under way (a conversion): its progress on the taskbar icon, and full speed while the window is
// minimised or behind others (Chromium slows a hidden page's timers).
ipcMain.on('kr:progress', (e, p) => {
  const w = BrowserWindow.fromWebContents(e.sender); if (!w) return;
  const busy = typeof p === 'number' && p >= 0;
  w.setProgressBar(busy ? Math.min(1, p) : -1);
  e.sender.setBackgroundThrottling(!busy);
});
// The app's own browser, for the sites that answer only a browser (Cloudflare, DDoS-Guard…): windows sharing
// the app's session — its cookies, and the same identity (User-Agent) as its requests.
//  - kr:open-webview: a site's check passed, out of sight ({hidden}, the JavaScript checks pass by themselves)
//    or in a window the reader acts in, titled with {message}; resolves {passed, blocked, title} — passed once
//    the site shows a page of its own (no check on it), blocked when it refuses outright. {fresh} clears the
//    site's old clearance first; {stay} keeps the window until the reader closes it (the site opened for them).
//  - kr:browser-fetch: a request made by a page of the site itself — a hidden window opened on the site once
//    (its check passed as any browser passes it), kept a few minutes; each request that page's own fetch.
//  - kr:browser-reset / kr:browser-forget: the site's window closed; its clearance (or every cookie) cleared.
const STATE_JS = "(function(){try{var t=document.title||'',b=document.body?(document.body.innerText||'').slice(0,700):'';var bl=/used Cloudflare to restrict access|Sorry, you have been blocked|You are unable to access|has banned you|banned your IP|Error 10(06|07|08|09|10|12|20)\\b/i.test(t+' '+b);var ch=!bl&&(/Just a moment|Attention Required|Verifying you are human|Verify you are human|Checking your browser|Checking if the site connection is secure|Please wait|DDoS-Guard|One moment|لحظة|Один момент/i.test(t)||!!document.querySelector('#challenge-form,#challenge-running,#challenge-stage,#cf-challenge-running,.cf-browser-verification,#cf-please-wait,#turnstile-wrapper,[name=\"cf-turnstile-response\"],#ddg-captcha,.ddg-captcha,#sucuri_cloudproxy_js'));return [document.readyState,location.origin,ch?1:0,bl?1:0,t.slice(0,140)].join('\\u0001');}catch(e){return 'error';}})()";
const pageState = async (w) => { try { const s = String(await w.webContents.executeJavaScript(STATE_JS, true)).split('\u0001'); return s.length >= 5 ? { ready: s[0], origin: s[1], check: s[2] === '1', blocked: s[3] === '1', title: s[4] } : null; } catch { return null; } };
const isClear = (st, origin) => !!st && st.origin === origin && st.ready !== 'loading' && !st.check && !st.blocked;
const originOf = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.origin : null; } catch { return null; } };
async function forgetSite(url, all) {
  const { session } = require('electron');
  let n = 0;
  try {
    for (const c of await session.defaultSession.cookies.get({ url })) {
      if (!all && !/^(cf_clearance|__cf.*|cf_chl.*|__ddg.*)$/.test(c.name)) continue;
      await session.defaultSession.cookies.remove(url, c.name).catch(() => undefined); n++;
    }
  } catch { /* nothing to clear */ }
  return n;
}
ipcMain.handle('kr:open-webview', async (_e, arg) => {
  const o = typeof arg === 'string' ? { url: arg } : (arg || {});
  const url = String(o.url || ''); const origin = originOf(url); const hidden = !!o.hidden; const stay = !!o.stay && !hidden; const timeout = Number(o.timeout) || (hidden ? 15000 : 300000);
  if (!origin) return { passed: false, blocked: false, title: '' };
  if (o.fresh) await forgetSite(url, false);
  return new Promise((resolve) => {
    const w = new BrowserWindow({ width: 980, height: 820, show: !hidden, parent: hidden ? undefined : (win || undefined), title: String(o.message || url), autoHideMenuBar: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    w.setMenuBarVisibility(false);
    if (hidden) { hiddenChecks.add(w); w.on('closed', () => hiddenChecks.delete(w)); }
    // (The window keeps the reader's line as its title, whatever the page calls itself.)
    if (!hidden) w.on('page-title-updated', (ev) => ev.preventDefault());
    let done = false; let passed = false; let blocked = false; let title = '';
    const finish = () => { if (done) return; done = true; clearTimeout(limit); resolve({ passed, blocked, title }); if (!w.isDestroyed()) w.destroy(); };
    const tick = async () => {
      if (done || w.isDestroyed()) return;
      const st = await pageState(w);
      if (st) { title = st.title; blocked = st.blocked; }
      // (A window that stays — the site opened for the reader to use — closes only when they close it.)
      if (isClear(st, origin)) { passed = true; blocked = false; if (stay) setTimeout(tick, 1500); else setTimeout(finish, hidden ? 0 : 900); return; }
      if (st && st.blocked && hidden) { finish(); return; }
      setTimeout(tick, 600);
    };
    const limit = setTimeout(finish, timeout);
    // (Closed by the reader: looked at once more — a check passed a moment before counts.)
    w.on('close', (ev) => { if (done) return; ev.preventDefault(); void pageState(w).then((st) => { if (isClear(st, origin)) passed = true; finish(); }); });
    w.on('closed', finish);
    w.loadURL(url).catch(() => {});
    setTimeout(tick, 800);
  });
});
const lanes = new Map();
const LANE_IDLE = 4 * 60000;
const hiddenChecks = new Set();
function closeHelpers() {
  for (const l of [...lanes.values()]) closeLane(l);
  for (const w of [...hiddenChecks]) if (!w.isDestroyed()) w.destroy();
  hiddenChecks.clear();
}
let laneSweep = null;
function closeLane(l) { if (lanes.get(l.origin) === l) lanes.delete(l.origin); l.fail?.(Object.assign(new Error('closed'), { why: 'error' })); if (!l.win.isDestroyed()) l.win.destroy(); }
// A window set aside: new requests open the site afresh (with the cookies as they are now); the requests under
// way in it finish first, then it is closed (after a minute at the most). One still opening goes on.
function retireLane(l) {
  if (!l.settled) return;
  if (lanes.get(l.origin) === l) lanes.delete(l.origin);
  const until = Date.now() + 60000;
  const end = () => { if (l.win.isDestroyed()) return; if (!l.busy || Date.now() > until) closeLane(l); else setTimeout(end, 2000); };
  end();
}
function openLane(origin, page, timeout) {
  const had = lanes.get(origin);
  if (had && !had.win.isDestroyed()) { had.used = Date.now(); return had.ready; }
  const w = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  const lane = { origin, win: w, used: Date.now(), busy: 0, title: '' };
  lane.ready = new Promise((resolve, reject) => {
    const start = Date.now(); let settled = false;
    const settle = (err) => { if (settled) return; settled = true; lane.settled = true; if (err) { closeLane(lane); reject(err); } else { lane.used = Date.now(); resolve(lane); } };
    lane.fail = (err) => settle(err);
    w.webContents.on('did-fail-load', (_ev, code, desc, _u, isMain) => { if (isMain && code !== -3) settle(Object.assign(new Error(desc || 'the page did not load'), { why: 'error' })); });
    // (A page whose renderer went away is opened afresh by the next request.)
    w.webContents.on('render-process-gone', () => { settle(Object.assign(new Error('the page stopped'), { why: 'error' })); closeLane(lane); });
    const tick = async () => {
      if (settled || w.isDestroyed()) return;
      const st = await pageState(w);
      if (st) lane.title = st.title;
      if (isClear(st, origin)) return settle();
      if (st && st.blocked) return settle(Object.assign(new Error('blocked'), { why: 'blocked', title: st.title }));
      if (Date.now() - start > timeout) return settle(Object.assign(new Error('challenge'), { why: 'challenge', title: lane.title }));
      setTimeout(tick, 500);
    };
    w.loadURL(page).catch(() => {});
    setTimeout(tick, 700);
  });
  lane.ready.catch(() => undefined);
  lanes.set(origin, lane);
  if (!laneSweep) laneSweep = setInterval(() => { for (const l of [...lanes.values()]) if (l.settled && !l.busy && Date.now() - l.used > LANE_IDLE) closeLane(l); if (!lanes.size) { clearInterval(laneSweep); laneSweep = null; } }, 60000);
  return lane.ready;
}
// The page's own request (o given): its answer as base64 with its status, headers and address.
const LANE_FETCH = `(async (o) => {
  const h = {}; for (const [k, v] of Object.entries(o.headers || {})) if (!/^(user-agent|referer|cookie|cookie2|accept-encoding|host|origin|connection|content-length|keep-alive|te|trailer|transfer-encoding|upgrade|via|sec-.*|proxy-.*)$/i.test(k)) h[k] = v;
  const init = { method: o.method || 'GET', headers: h, credentials: 'include', cache: 'no-store', redirect: 'follow' };
  if (o.body != null) init.body = o.bodyBase64 ? Uint8Array.from(atob(o.body), (c) => c.charCodeAt(0)) : o.body;
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), o.timeout || 90000); init.signal = ctl.signal;
  try {
    const r = await fetch(o.url, init);
    const hs = {}; r.headers.forEach((v, n) => { hs[n.toLowerCase()] = v; });
    const u8 = new Uint8Array(await r.arrayBuffer()); let s = '';
    for (let j = 0; j < u8.length; j += 8192) s += String.fromCharCode.apply(null, u8.subarray(j, j + 8192));
    return { status: r.status, headers: hs, b64: btoa(s), url: r.url || o.url };
  } finally { clearTimeout(tm); }
})`;
function refusal(url, blocked, title, binary) {
  const html = `<html><head><title>${String(title || (blocked ? 'Access denied' : 'Just a moment...')).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</title></head><body></body></html>`;
  return { status: 403, headers: { 'content-type': 'text/html; charset=utf-8', ...(blocked ? { 'x-kr-lane': 'blocked' } : { 'cf-mitigated': 'challenge', 'x-kr-lane': 'challenge' }) }, body: binary ? Buffer.from(html).toString('base64') : html, url, via: 'browser' };
}
ipcMain.handle('kr:browser-fetch', async (_e, o) => {
  const url = String(o?.url || ''); const origin = originOf(url);
  if (!origin) throw new Error('Bad address');
  let lane;
  try { lane = await openLane(origin, String(o.page || origin + '/'), Number(o.openTimeout) || 25000); }
  catch (err) { if (err.why === 'blocked' || err.why === 'challenge') return refusal(url, err.why === 'blocked', err.title, !!o.binary); throw new Error('Browser could not open the site: ' + err.message); }
  lane.busy++; lane.used = Date.now();
  try {
    const timeout = Number(o.timeout) || 90000;
    const run = lane.win.webContents.executeJavaScript(`${LANE_FETCH}(${JSON.stringify({ url, method: o.method || 'GET', headers: o.headers || {}, body: o.body ?? null, bodyBase64: !!o.bodyBase64, timeout })})`, true);
    // (The timer cleared once the answer is in: a promise left to reject later would be an unhandled one.)
    let timer = null;
    const res = await Promise.race([run, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('Browser request timed out')), timeout + 15000); })]).finally(() => clearTimeout(timer));
    const buf = Buffer.from(res.b64 || '', 'base64');
    return { status: res.status, headers: res.headers || {}, body: o.binary ? (res.b64 || '') : decodeText(buf, (res.headers || {})['content-type']), url: res.url || url, via: 'browser' };
  } finally { lane.busy--; lane.used = Date.now(); }
});
ipcMain.handle('kr:browser-reset', async (_e, url) => { const origin = originOf(String(url || '')); const l = origin && lanes.get(origin); if (l) retireLane(l); return true; });
ipcMain.handle('kr:browser-forget', async (_e, url, all) => { const origin = originOf(String(url || '')); const l = origin && lanes.get(origin); if (l) retireLane(l); return { cleared: origin ? await forgetSite(String(url), !!all) : 0 }; });
// A system notification (new chapters, extension updates); a click brings the app forward and opens the hash given.
ipcMain.handle('kr:notify', async (e, o) => {
  try {
    const { Notification } = require('electron');
    if (!Notification.isSupported()) return false;
    const n = new Notification({ title: String(o?.title || 'KurokawaReader'), body: String(o?.body || ''), silent: !!o?.silent });
    n.on('click', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); if (o?.hash) e.sender.send('kr:command', { open: String(o.hash) }); } });
    n.show();
    return true;
  } catch { return false; }
});
ipcMain.handle('kr:folder-pick', async () => { const { dialog } = require('electron'); const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] }); return r.canceled ? null : r.filePaths[0]; });
ipcMain.handle('kr:folder-read', async (_e, p) => { try { return await require('fs/promises').readFile(String(p), 'utf8'); } catch { return null; } });
// Downloads into the app's data folder (learning decks), with progress. Uses aria2c when it is
// installed (16 connections), otherwise splits the file into ranges fetched in parallel itself.
function hasAria2() {
  try { return require('child_process').spawnSync('aria2c', ['--version'], { timeout: 4000, windowsHide: true }).status === 0; } catch { return false; }
}
async function downloadAria2(e, url, dir, name) {
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    const p = spawn('aria2c', ['-x', '16', '-s', '16', '-k', '1M', '--file-allocation=none', '--allow-overwrite=true', '--auto-file-renaming=false', '--summary-interval=1', '--console-log-level=warn', '-d', dir, '-o', name, url], { windowsHide: true });
    const parse = (buf) => {
      // [#2089b0 12MiB/104MiB(11%) CN:16 DL:5.2MiB ETA:17s]
      const m = /([\d.]+)([KMG]?i?B)\/([\d.]+)([KMG]?i?B)\((\d+)%\).*?DL:([\d.]+)([KMG]?i?B)/.exec(String(buf));
      if (!m) return;
      const mul = (u) => (u.startsWith('G') ? 1073741824 : u.startsWith('M') ? 1048576 : u.startsWith('K') ? 1024 : 1);
      e.sender.send('kr:download-progress', { got: Number(m[1]) * mul(m[2]), total: Number(m[3]) * mul(m[4]), pct: Number(m[5]), speed: Number(m[6]) * mul(m[7]), via: 'aria2c' });
    };
    p.stdout.on('data', parse); p.stderr.on('data', parse);
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(path.join(dir, name)) : reject(new Error('aria2c exited with ' + code))));
  });
}
async function downloadSegmented(e, url, file) {
  let total = 0, ranged = false, final = url;
  const probe = await net.fetch(url, { headers: { Range: 'bytes=0-0' } });
  final = probe.url || url;
  const cr = probe.headers.get('content-range');
  if (probe.status === 206 && cr && cr.includes('/')) { total = Number(cr.split('/').pop()); ranged = total > 0; }
  try { await probe.arrayBuffer(); } catch { /* drain */ }
  let got = 0, lastT = Date.now(), lastGot = 0, speed = 0;
  const report = () => { const now = Date.now(); if (now - lastT < 400) return; speed = (got - lastGot) / ((now - lastT) / 1000); lastT = now; lastGot = got; e.sender.send('kr:download-progress', { pct: total ? Math.round((got / total) * 100) : 0, got, total, speed }); };
  if (ranged && total > 4 * 1048576) {
    const n = Math.min(8, Math.max(1, Math.floor(total / 1048576)));
    const seg = Math.ceil(total / n);
    const fh = await fs.promises.open(file, 'w'); await fh.truncate(total);
    try {
      await Promise.all(Array.from({ length: n }, async (_, i) => {
        let pos = i * seg; const to = Math.min(total - 1, pos + seg - 1);
        for (let attempt = 0; attempt < 4 && pos <= to; attempt++) {
          try {
            const res = await net.fetch(final, { headers: { Range: `bytes=${pos}-${to}` } });
            if (res.status !== 206 || !res.body) throw new Error('HTTP ' + res.status);
            const reader = res.body.getReader();
            for (;;) { const { done, value } = await reader.read(); if (done) break; await fh.write(Buffer.from(value), 0, value.length, pos); pos += value.length; got += value.length; report(); }
          } catch (err) { if (attempt === 3) throw err; }
        }
      }));
    } finally { await fh.close(); }
  } else {
    const res = await net.fetch(url);
    if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
    total = Number(res.headers.get('content-length') || 0);
    const out = fs.createWriteStream(file); let err = null; out.on('error', (x) => { err = x; });
    const reader = res.body.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; out.write(Buffer.from(value)); got += value.length; report(); }
    await new Promise((r) => out.end(r)); if (err) throw err;
  }
  return file;
}
ipcMain.handle('kr:download', async (e, url, name) => {
  const dir = path.join(app.getPath('userData'), 'downloads'); fs.mkdirSync(dir, { recursive: true });
  const safe = String(name).replace(/[\\/:*?"<>|]/g, '_');
  if (hasAria2()) { try { return await downloadAria2(e, String(url), dir, safe); } catch (err) { console.warn('[kurokawa] aria2c failed, using the built-in downloader', err); } }
  return downloadSegmented(e, String(url), path.join(dir, safe));
});
ipcMain.handle('kr:delete-download', async (_e, p) => { const dir = path.join(app.getPath('userData'), 'downloads'); const f = path.resolve(String(p)); if (!f.startsWith(dir)) return false; try { await fs.promises.unlink(f); return true; } catch { return false; } });
ipcMain.handle('kr:write-binary', async (_e, p, b64, append) => { const fsp = require('fs/promises'); const buf = Buffer.from(String(b64), 'base64'); if (append) await fsp.appendFile(String(p), buf); else await fsp.writeFile(String(p), buf); return true; });
ipcMain.handle('kr:folder-write', async (_e, p, text) => { await require('fs/promises').writeFile(String(p), String(text), 'utf8'); return true; });
ipcMain.handle('kr:default-apps', () => { if (process.platform === 'win32') return shell.openExternal('ms-settings:defaultapps'); if (process.platform === 'darwin') return shell.openExternal('x-apple.systempreferences:'); return false; });
ipcMain.handle('kr:fullscreen', (_e, v) => { if (!win) return false; const next = v === 'toggle' ? !win.isFullScreen() : !!v; win.setFullScreen(next); return next; });
ipcMain.handle('kr:immersive', (_e, on) => { if (win) win.setFullScreen(!!on); return true; });
// Real, text-based PDF from HTML: a hidden window lays the document out and prints it.
ipcMain.handle('kr:print-pdf', async (_e, html, opts) => {
  const w = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { sandbox: true, javascript: false, offscreen: true } });
  try {
    await w.loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(String(html), 'utf8').toString('base64'));
    await new Promise((r) => setTimeout(r, 400));   // fonts
    const buf = await w.webContents.printToPDF({ pageSize: (opts && opts.pageSize) || 'A4', printBackground: true, margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 }, preferCSSPageSize: false });
    return buf.toString('base64');
  } finally { w.destroy(); }
});
ipcMain.handle('kr:copy-image', (_e, b64) => { const img = nativeImage.createFromBuffer(Buffer.from(String(b64), 'base64')); if (img.isEmpty()) return false; clipboard.writeImage(img); return true; });
ipcMain.handle('kr:read-file', async (_e, p) => { const buf = await require('fs/promises').readFile(String(p)); return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); });
