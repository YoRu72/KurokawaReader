// Back on Android (the App plugin faked): the video's case — a page reached through a tab switch — goes up to its
// own tab's top, never round between two tabs; the phone's Back closes a sheet first, goes up, then to the
// downloads, and only from the downloads' top sends the app to the background.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port;
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 400, height: 860 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message)); const check = (what, ok) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) errors.push(what); };
  await p.addInitScript(() => {
    localStorage.setItem('kr.lang', 'en'); window.__min = 0;
    const task = { id: 'b', kind: 'http', name: 'Show 04.mkv', source: { url: 'https://x/a.mkv' }, dir: '/sdcard/Download', state: 'done', done: 1, total: 1, downSpeed: 0, upSpeed: 0, files: [], addedAt: Date.now(), engine: 'native' };
    const api = { addListener: () => Promise.resolve({ remove() {} }), list: async () => ({ tasks: [task] }) };
    const App = { addListener: (ev, fn) => { if (ev === 'backButton') window.__back = fn; return { remove() {} }; }, minimizeApp: () => { window.__min++; }, exitApp: async () => { window.__exit = true; } };
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) }), App }, PluginHeaders: [] };
  });
  const hash = () => p.evaluate(() => location.hash || '#/');
  const sysBack = async () => { await p.evaluate(() => window.__back()); await p.waitForTimeout(350); };
  await p.goto(`http://127.0.0.1:${port}/#/`); await p.waitForSelector('.task-card'); await p.waitForTimeout(300);
  check('the app takes Android\'s back', await p.evaluate(() => typeof window.__back === 'function'));
  // Within one tab: the page, then ← back to the list.
  await p.evaluate(() => { location.hash = '#/task/b'; }); await p.waitForSelector('.task-view'); await p.click('.task-view .topbar button[data-icon="back"]'); await p.waitForTimeout(300);
  check('← from a page opened from the list: the list', (await hash()) === '#/');
  // The video's case: a page, another tab, back to this tab (the page comes back), then ←.
  await p.evaluate(() => { location.hash = '#/task/b'; }); await p.waitForSelector('.task-view');
  await p.click('[data-dest="settings"]'); await p.waitForTimeout(300); await p.click('[data-dest="downloads"]'); await p.waitForTimeout(400);
  console.log('after the tabs:', await hash());
  await p.click('.view .topbar button[data-icon="back"]'); await p.waitForTimeout(300);
  check('← there: its own tab\'s top, not the other tab', (await hash()) === '#/');
  // The phone's Back: from Settings to the downloads, then the background — never round.
  await p.click('[data-dest="settings"]'); await p.waitForTimeout(300);
  await sysBack(); check('Back from Settings: the downloads', (await hash()) === '#/');
  await sysBack(); check('Back from the downloads\' top: the app to the background', (await p.evaluate(() => window.__min)) === 1 && (await hash()) === '#/');
  // A sheet open: Back closes it first.
  await p.click('.fab'); await p.locator('.fab-item').first().click(); await p.waitForSelector('.sheet'); await sysBack();
  check('Back closes the open sheet first', !(await p.$('.sheet')) && (await p.evaluate(() => window.__min)) === 1);
  check('no page errors', !errors.filter((e) => e !== 'no page errors').length);
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
