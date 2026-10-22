// Electron shell: serves the built web app from an app:// origin (so IndexedDB,
// fonts and absolute paths behave exactly as on the web) and forwards files the
// OS asks us to open (double-click, "Open with", drag onto the icon).
const { app, BrowserWindow, protocol, net, ipcMain, shell, Menu, clipboard, nativeImage } = require('electron');
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
  win.on('closed', () => { win = null; });
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

// In-app update: download the installer to the temp folder and run it.
ipcMain.handle('kr:install-update', async (e, url) => {
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
ipcMain.handle('kr:http', async (_e, o) => {
  const res = await net.fetch(o.url, { method: o.method || 'GET', headers: o.headers || {}, body: o.body == null ? undefined : (o.bodyBase64 ? Buffer.from(o.body, 'base64') : o.body) });
  const buf = Buffer.from(await res.arrayBuffer());
  const headers = {}; res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  return { status: res.status, headers, body: o.binary ? buf.toString('base64') : buf.toString('utf8') };
});
ipcMain.handle('kr:folder-pick', async () => { const { dialog } = require('electron'); const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] }); return r.canceled ? null : r.filePaths[0]; });
ipcMain.handle('kr:folder-read', async (_e, p) => { try { return await require('fs/promises').readFile(String(p), 'utf8'); } catch { return null; } });
ipcMain.handle('kr:folder-write', async (_e, p, text) => { await require('fs/promises').writeFile(String(p), String(text), 'utf8'); return true; });
ipcMain.handle('kr:default-apps', () => { if (process.platform === 'win32') return shell.openExternal('ms-settings:defaultapps'); if (process.platform === 'darwin') return shell.openExternal('x-apple.systempreferences:'); return false; });
ipcMain.handle('kr:fullscreen', (_e, v) => { if (!win) return false; const next = v === 'toggle' ? !win.isFullScreen() : !!v; win.setFullScreen(next); return next; });
ipcMain.handle('kr:immersive', (_e, on) => { if (win) win.setFullScreen(!!on); return true; });
ipcMain.handle('kr:copy-image', (_e, b64) => { const img = nativeImage.createFromBuffer(Buffer.from(String(b64), 'base64')); if (img.isEmpty()) return false; clipboard.writeImage(img); return true; });
ipcMain.handle('kr:read-file', async (_e, p) => { const buf = await require('fs/promises').readFile(String(p)); return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); });
