// node tests/speedtest.cjs: the downloader's speed test on a stubbed phone — the app's downloader asked for the test
// file with 1, 2, 4, 8 and 16 connections; this «link» is fastest at 4 (a weak modem: more connections slow it), so
// 4 is offered and, once chosen, every file download is given 4 connections. Also: an add-on's pack failing with a
// message that says «canceled» shows its reason and Retry, not a silent «Cancelled».
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const REPO = path.join(__dirname, '..', '..', '..', 'repo');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
(async () => {
  const web = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }).listen(0);
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 400, height: 860 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.route(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/main\/repo\/(.*)/, (r) => { const f = path.join(REPO, r.request().url().split('/main/repo/')[1].split('?')[0]); if (!fs.existsSync(f)) return r.fulfill({ status: 404, body: '' }); r.fulfill({ body: fs.readFileSync(f), contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' } }); });
  await p.addInitScript(() => {
    const L = {}; const emit = (ev, d) => (L[ev] || []).forEach((f) => f(d)); window.__calls = []; const jobs = {};
    const RATE = { 1: 0.6e6, 2: 1.0e6, 4: 1.6e6, 8: 1.5e6, 16: 0.9e6 };
    const plugin = new Proxy({
      addListener: async (ev, fn) => { (L[ev] = L[ev] || []).push(fn); return { remove: () => { L[ev] = (L[ev] || []).filter((x) => x !== fn); } }; },
      list: async () => ({ tasks: [] }), defaultDir: async () => ({ dir: '/sdcard/Download' }),
      downloadFile: (o) => new Promise((ok, no) => { window.__calls.push(['dl', o.connections, o.url]); let got = 0; const tm = setInterval(() => { got += RATE[o.connections] / 5; emit('downloadProgress', { id: o.id, got }); }, 200); jobs[o.id] = () => { clearInterval(tm); no(new Error('cancelled')); }; }),
      cancelDownload: async (o) => { jobs[o.id]?.(); },
      add: async (o) => { window.__calls.push(['add', o.connections ?? null]); return { task: { id: 'a', kind: 'http', name: 'f', source: o.source, state: 'queued', done: 0, total: 0, downSpeed: 0, upSpeed: 0, addedAt: Date.now(), engine: 'native' } }; },
      packStatus: async () => ({ python: { version: null, size: 0 }, ffmpeg: { version: null, size: 0 }, abi: 'arm64-v8a' }),
      httpRequest: async (o) => { if (/packs\.json$/.test(o.url)) return { status: 200, body: JSON.stringify({ ydl: '1', packs: { python: { 'arm64-v8a': { file: 'py.zip', size: 1e7, sha256: 'a' } }, ffmpeg: { 'arm64-v8a': { file: 'ff.zip', size: 1e7, sha256: 'b' } } } }), headers: {} }; const r = await fetch(o.url); return { status: r.status, body: await r.text(), headers: {} }; },
      packInstall: async () => { await new Promise((r) => setTimeout(r, 300)); throw new Error('java.io.IOException: Canceled'); },
    }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
  });
  const port = web.address().port;
  await p.goto(`http://127.0.0.1:${port}/#/settings/downloads`); await p.waitForSelector('.speed-btn');
  await p.click('.speed-btn'); await p.waitForSelector('.sheet .speed-row');
  await p.waitForSelector('.sheet .row-actions .btn.primary', { timeout: 60000 });
  const res = await p.$$eval('.sheet .speed-row', (rs) => rs.map((r) => ({ t: r.innerText.replace(/\s+/g, ' '), best: r.classList.contains('best') })));
  console.log(JSON.stringify(res));
  ok('each connection count measured', res.length === 5 && res.every((r) => /\/s|s$/i.test(r.t) || /MB|KB/.test(r.t)), res);
  ok('the fastest few (4) chosen', res[2].best && res.filter((r) => r.best).length === 1);
  const calls = await p.evaluate(() => window.__calls.filter((c) => c[0] === 'dl').map((c) => c[1]));
  ok("the app's downloader asked with 1, 2, 4, 8, 16", JSON.stringify(calls) === '[1,2,4,8,16]', calls);
  await p.click('.sheet .row-actions .btn.primary'); await p.waitForTimeout(300);
  ok('kept as the downloads\' number', await p.evaluate(() => JSON.parse(localStorage.getItem('kt.settings')).connections === 4));
  // A download added: given 4 connections.
  await p.goto(`http://127.0.0.1:${port}/#/add?u=${encodeURIComponent('https://example.com/file.zip')}`); await p.waitForTimeout(800);
  const addBtn = await p.$('.sheet .btn.primary, .add-go, button.primary'); if (addBtn) await addBtn.click(); await p.waitForTimeout(800);
  const adds = await p.evaluate(() => window.__calls.filter((c) => c[0] === 'add').map((c) => c[1]));
  ok('a download added is given 4 connections', adds.length > 0 && adds.every((x) => x === 4), adds);
  // An add-on whose pack fails with «Canceled» from the network: the card says so and offers Retry.
  await p.goto(`http://127.0.0.1:${port}/#/settings/addons`); await p.waitForSelector('.addon-row[data-id="video"]');
  await p.click('.addon-row[data-id="video"] .btn'); await p.waitForSelector('.get-card'); await p.waitForTimeout(1200);
  const card = await p.$eval('.get-card', (e) => e.innerText.replace(/\s+/g, ' ')).catch(() => '');
  ok('a failed pack shows its reason and Retry (not a silent «Cancelled»)', /Canceled/.test(card) && /Try again/i.test(card), card);
  ok('no page errors', !errors.length, errors);
  await br.close(); web.close(); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})();
