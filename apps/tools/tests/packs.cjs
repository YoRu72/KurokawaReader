// Packs and the player choice on a stubbed phone: installing the Video add-on asks for Python and ffmpeg (sizes from
// the release's packs file), downloads them with progress, then installs the add-on; Play asks how to watch, and
// «another app» hands the finished file to the phone's chooser, remembered when asked to.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const REPO = path.join(__dirname, '..', '..', '..', 'repo');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
const MANIFEST = { ydl: '0.18.1', packs: { python: { 'arm64-v8a': { file: 'KurokawaTools-pack-python-0.18.1-arm64-v8a.zip', size: 14250000, sha256: 'aa' } }, ffmpeg: { 'arm64-v8a': { file: 'KurokawaTools-pack-ffmpeg-0.18.1-arm64-v8a.zip', size: 38400000, sha256: 'bb' } } } };
(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port;
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 420, height: 860 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.route(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/main\/repo\/(.*)/, (r) => { const f = path.join(REPO, r.request().url().split('/main/repo/')[1].split('?')[0]); if (!fs.existsSync(f)) return r.fulfill({ status: 404, body: '' }); r.fulfill({ body: fs.readFileSync(f), contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' } }); });
  await p.addInitScript((manifest) => {
    const listeners = {}; const emit = (ev, d) => (listeners[ev] || []).forEach((f) => f(d)); window.__calls = [];
    const packs = { python: { version: null, size: 0 }, ffmpeg: { version: null, size: 0 } };
    const task = { id: 't1', kind: 'http', name: 'Episode 05.mkv', source: { url: 'https://x/e.mkv' }, dir: '/sdcard/Download', state: 'done', done: 100, total: 100, downSpeed: 0, upSpeed: 0, files: [{ index: 0, path: 'Episode 05.mkv', size: 100, done: 100, priority: 1 }], addedAt: Date.now(), engine: 'native' };
    const plugin = new Proxy({
      addListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); return { remove: () => undefined }; },
      list: async () => ({ tasks: [task] }), defaultDir: async () => ({ dir: '/sdcard/Download' }),
      httpRequest: async (o) => { if (/KurokawaTools-packs\.json$/.test(o.url)) return { status: 200, body: JSON.stringify(manifest), headers: {} }; const r = await fetch(o.url); return { status: r.status, body: await r.text(), headers: {} }; },
      packStatus: async () => ({ ...JSON.parse(JSON.stringify(packs)), abi: 'arm64-v8a' }),
      packInstall: async (o) => { window.__calls.push(['packInstall', o.name, o.url.split('/').pop(), o.sha256]); for (let i = 1; i <= 4; i++) { await new Promise((r) => setTimeout(r, 60)); emit('packProgress', { name: o.name, done: i * 1e6, total: 4e6 }); } packs[o.name] = { version: o.version, size: 5e7 }; },
      openWith: async (o) => { window.__calls.push(['openWith', o.path || o.url]); },
      localUrl: async (o) => ({ url: 'http://127.0.0.1:9/file?p=' + encodeURIComponent(o.path) }), streamUrl: async () => ({ url: 'http://127.0.0.1:9/t1/0' }),
    }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
  }, MANIFEST);
  await p.goto(`http://127.0.0.1:${port}/#/settings/addons`); await p.waitForSelector('.addon-row[data-id="video"]');
  await p.click('.addon-row[data-id="video"] .btn'); await p.waitForSelector('.sheet .pack-row');
  const ask = (await p.$eval('.sheet', (e) => e.innerText)).replace(/\s+/g, ' '); console.log('pack sheet:', ask.slice(0, 300));
  await p.click('.sheet .btn.primary'); await p.waitForFunction(() => window.__calls.filter((c) => c[0] === 'packInstall').length === 2); await p.waitForTimeout(500);
  const installed = await p.evaluate(() => JSON.parse(localStorage.getItem('kt.settings') || '{}').addons || []);
  const calls1 = await p.evaluate(() => window.__calls); console.log('installs:', JSON.stringify(calls1), '| video add-on:', installed.includes('video'));
  // Storage lists them with their size
  await p.goto(`http://127.0.0.1:${port}/#/settings/storage`); await p.waitForSelector('#storage .addon-row'); await p.evaluate(() => document.querySelector('#storage').classList.remove('collapsed'));
  const storage = (await p.$eval('#storage', (e) => e.innerText)).replace(/\s+/g, ' '); console.log('storage:', storage.slice(0, 200));
  // Play: asked how; another app, remembered
  await p.goto(`http://127.0.0.1:${port}/#/`); await p.waitForSelector('.task-card'); await p.click('.task-card button[aria-label="Play"]'); await p.waitForSelector('.watch-choice');
  const choice = (await p.$eval('.sheet', (e) => e.innerText)).replace(/\s+/g, ' '); console.log('choice:', choice);
  await p.click('.sheet .switch-row input'); await p.click('.watch-choice >> nth=1'); await p.waitForTimeout(400);
  const calls2 = await p.evaluate(() => window.__calls.filter((c) => c[0] === 'openWith')); const pref = await p.evaluate(() => JSON.parse(localStorage.getItem('kt.settings')).playerWith);
  console.log('openWith:', JSON.stringify(calls2), '| remembered:', pref);
  const pass = /Python/.test(ask) && /ffmpeg/.test(ask) && /50\.?\d* MB|5\d\.\d MB/.test(ask) && calls1.length === 2 && calls1[0][2] === 'KurokawaTools-pack-python-0.18.1-arm64-v8a.zip' && installed.includes('video') && /Installed/.test(storage) && calls2.length === 1 && calls2[0][1] === '/sdcard/Download/Episode 05.mkv' && pref === 'external';
  console.log(errors.length ? 'errors ' + JSON.stringify(errors) : pass ? 'all passed' : 'FAILED');
  await br.close(); web.close(); process.exit(errors.length || !pass ? 1 : 0);
})();
