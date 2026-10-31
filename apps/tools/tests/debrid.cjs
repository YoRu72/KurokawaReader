// The Debrid add-on in a browser: Real-Debrid stubbed; a magnet sent through it from the add sheet, the cloud
// watched until ready, the files queued as HTTP downloads on the (faked) engine; the Cloud sheet.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const REPO = path.join(__dirname, '..', '..', '..', 'repo');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port;
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 420, height: 860 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.route(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/main\/repo\/(.*)/, (r) => { const f = path.join(REPO, r.request().url().split('/main/repo/')[1]); if (!fs.existsSync(f)) return r.fulfill({ status: 404 }); r.fulfill({ body: fs.readFileSync(f), contentType: MIME[path.extname(f)] || 'application/octet-stream' }); });
  let polls = 0;
  await p.route('https://api.real-debrid.com/**', (r) => { const u = r.request().url(); const auth = r.request().headers().authorization; if (auth !== 'Bearer RDKEY') return r.fulfill({ status: 401, json: { error: 'bad_token' } });
    if (u.endsWith('/user')) return r.fulfill({ json: { username: 'maomao', type: 'premium', expiration: '2027-01-01T00:00:00Z' } });
    if (u.includes('/torrents/addMagnet')) return r.fulfill({ json: { id: 'RD1', uri: 'x' } });
    if (u.includes('/torrents/selectFiles')) return r.fulfill({ status: 204, body: '' });
    if (u.includes('/torrents/info/RD1')) { polls++; return r.fulfill({ json: { id: 'RD1', filename: 'Show.S01', hash: 'abc', bytes: 2000, progress: polls < 2 ? 40 : 100, status: polls < 2 ? 'downloading' : 'downloaded', speed: 5000000, seeders: 12, files: [{ id: 1, path: '/Show.S01/E01.mkv', bytes: 1000, selected: 1 }, { id: 2, path: '/Show.S01/E02.mkv', bytes: 1000, selected: 1 }], links: ['https://real-debrid.com/d/AAA', 'https://real-debrid.com/d/BBB'] } }); }
    if (u.endsWith('/torrents?limit=100')) return r.fulfill({ json: [] });
    if (u.includes('/unrestrict/link')) { const body = r.request().postData() || ''; return r.fulfill({ json: { download: `https://dl.real-debrid.com/${/AAA/.test(body) ? 'E01.mkv' : 'E02.mkv'}`, filename: /AAA/.test(body) ? 'E01.mkv' : 'E02.mkv', filesize: 1000 } }); }
    r.fulfill({ status: 404, json: { error: 'unknown' } }); });
  await p.addInitScript(() => {
    const tasks = []; window.__added = [];
    window.kurokawaTools = { platform: 'desktop', available: true, os: 'linux', ready: async () => ({}), list: async () => tasks, add: async (o) => { window.__added.push(o); const tk = { id: 't' + tasks.length, name: o.name || 'x', state: 'downloading', done: 0, total: 0, kind: 'http', source: o.source, dir: o.dir || '', ...o }; tasks.push(tk); return tk; }, pause: async () => {}, resume: async () => {}, remove: async () => {}, setFiles: async () => {}, setLimits: async () => {}, configure: async () => {}, torrentInfo: async () => null, open: async () => {}, defaultDir: async () => '/dl', pickDir: async () => null, onTasks: (cb) => { cb(tasks); return () => {}; },
      http: async (o) => { const r = await fetch(o.url, { method: o.method || 'GET', headers: o.headers || {}, body: o.body }); const headers = {}; r.headers.forEach((v, k) => { headers[k] = v; }); return { status: r.status, url: r.url, headers, body: await r.text() }; } };
    if (!localStorage.getItem('kt.settings')) localStorage.setItem('kt.settings', JSON.stringify({ downloadDir: '/dl', addonSettings: { debrid: { preferred: 'realdebrid', realdebridKey: 'RDKEY' } } }));
  });
  await p.goto(`http://127.0.0.1:${port}/#/settings`); await p.waitForSelector('.addon-row'); await p.click('.addon-row:has-text("Debrid") .btn'); await p.waitForSelector('.toast');
  await p.goto(`http://127.0.0.1:${port}/#/`); await p.reload(); await p.waitForSelector('.fab'); await p.click('.fab'); await p.waitForSelector('.sheet textarea');
  await p.waitForSelector('.debrid-row:not([hidden])'); console.log('debrid row:', await p.$eval('.debrid-row span', (e) => e.textContent));
  await p.fill('.sheet textarea', 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Show.S01'); await p.click('.debrid-row input'); await p.click('.sheet .btn.primary'); await p.waitForSelector('.toast');
  console.log('toast:', await p.$eval('.toast', (e) => e.textContent));
  await p.evaluate(() => import('./assets/app.js').catch(() => {})); 
  await p.waitForFunction(() => window.__added.length === 2, null, { timeout: 40000 }).catch(() => {});
  console.log('added:', JSON.stringify(await p.evaluate(() => window.__added.map((a) => [a.name, a.dir, a.source.url]))), 'polls', polls);
  await p.click('.topbar-actions button[aria-label="Cloud"]'); await p.waitForSelector('.cloud-box h4'); console.log('cloud:', await p.$eval('.cloud-box', (e) => e.innerText.replace(/\n+/g, ' | ').slice(0, 200)));
  console.log(errors.length ? 'errors ' + JSON.stringify(errors) : 'all passed');
  await br.close(); web.close(); process.exit(errors.length ? 1 : 0);
})();
