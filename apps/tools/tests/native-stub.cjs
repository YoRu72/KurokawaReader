// The app as on Android, with the native bridge stubbed: Capacitor hands a listener's handle back directly (not as
// a promise) for plugins registered from the bridge's headers — the Downloads page must still draw.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port;
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 420, height: 860 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(() => {
    const listeners = {}; window.__emit = (ev, d) => (listeners[ev] || []).forEach((f) => f(d));
    const task = { id: 't1', kind: 'http', name: 'Some file.mkv', source: { url: 'https://x/y.mkv' }, dir: '/sdcard/Download', state: 'downloading', done: 50, total: 100, downSpeed: 10, upSpeed: 0, files: [], addedAt: Date.now(), engine: 'native' };
    const plugin = new Proxy({
      addListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); return { remove: () => undefined }; },   // a handle, not a promise
      list: async () => ({ tasks: [task] }), defaultDir: async () => ({ dir: '/sdcard/Download' }),
    }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
  });
  await p.goto(`http://127.0.0.1:${port}/`); await p.waitForTimeout(1500);
  const text = await p.evaluate(() => document.body.innerText);
  const drawn = text.includes('Some file.mkv') && !/Something went wrong/.test(text);
  await p.evaluate(() => window.__emit('tasksChanged', { tasks: [{ id: 't1', kind: 'http', name: 'Some file.mkv', source: {}, dir: '/', state: 'done', done: 100, total: 100, downSpeed: 0, upSpeed: 0, files: [], addedAt: Date.now(), engine: 'native' }] }));
  await p.waitForTimeout(500); const updated = await p.evaluate(() => document.body.innerText);
  console.log('drawn:', drawn, '| live update:', !/50%|٥٠/.test(updated));
  console.log(errors.length ? 'errors ' + JSON.stringify(errors) : drawn ? 'all passed' : 'FAILED\n' + text.slice(0, 400));
  await br.close(); web.close(); process.exit(errors.length || !drawn ? 1 : 0);
})();
