// Electron shell: serves the built web app from an app:// origin (so IndexedDB,
// fonts and absolute paths behave exactly as on the web) and forwards files the
// OS asks us to open (double-click, "Open with", drag onto the icon).
const { app, BrowserWindow, protocol, net, ipcMain, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const DIST = path.join(__dirname, 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.epub': 'application/epub+zip', '.map': 'application/json' };

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

let win = null;
const pending = [];
const DOC_EXT = /\.(epub|pdf|docx|xlsx|pptx|txt|md|markdown|html?|fb2|odt|cbz|csv|tsv|jpe?g|png|gif|webp)$/i;

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

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 820, minWidth: 420, minHeight: 600,
    backgroundColor: '#121314', title: 'KurokawaReader', autoHideMenuBar: true,
    icon: path.join(__dirname, process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('did-finish-load', flush);
  win.loadURL('app://kurokawa/index.html');
  win.on('closed', () => { win = null; });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', (_e, argv) => { argv.slice(1).forEach(queueFile); if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.on('open-file', (e, p) => { e.preventDefault(); queueFile(p); });
  app.whenReady().then(() => {
    protocol.handle('app', (req) => {
      const url = new URL(req.url);
      let p = decodeURIComponent(url.pathname);
      if (p === '/' || p === '') p = '/index.html';
      let file = path.normalize(path.join(DIST, p));
      if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
      return net.fetch('file://' + file).then((res) => new Response(res.body, { headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' } }));
    });
    Menu.setApplicationMenu(null);
    createWindow();
    process.argv.slice(app.isPackaged ? 1 : 2).forEach(queueFile);
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
  const file = path.join(app.getPath('temp'), 'KurokawaReader-update.exe');
  const out = fs.createWriteStream(file);
  const reader = res.body.getReader();
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.write(Buffer.from(value));
    got += value.length;
    if (total) e.sender.send('kr:update-progress', Math.round((got / total) * 100));
  }
  await new Promise((r) => out.end(r));
  const err = await shell.openPath(file);
  if (err) throw new Error(err);
  setTimeout(() => app.quit(), 1500);
  return file;
});
ipcMain.handle('kr:is-portable', () => !!process.env.PORTABLE_EXECUTABLE_DIR);
