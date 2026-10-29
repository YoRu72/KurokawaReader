// node tests/offline.cjs: the web app installed for offline use — a few megabytes at once (not the samples, pdf.js's
// resources, every font) — and then opened with no network: the library still comes up.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
let served = 0;
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); served += fs.statSync(f).size; res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
(async () => {
  await new Promise((r) => server.listen(5465, r));
  const b = await chromium.launch(); const ctx = await b.newContext(); const p = await ctx.newPage();
  await p.goto('http://localhost:5465/'); await p.waitForSelector('.library-view');
  await p.waitForFunction(() => navigator.serviceWorker?.controller || navigator.serviceWorker?.getRegistration().then((r) => r?.active), null, { timeout: 30000 });
  await p.waitForTimeout(4000);
  ok(`installed with a few megabytes (${(served / 1048576).toFixed(1)} MB served)`, served < 7 * 1048576);
  await ctx.setOffline(true);
  await p.reload(); await p.waitForSelector('.library-view', { timeout: 20000 }).catch(() => {});
  ok('opened offline: the library comes up', !!(await p.$('.library-view')));
  await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForSelector('.settings-body', { timeout: 15000 }).catch(() => {});
  ok('… and another view, fetched only now, too', !!(await p.$('.settings-body')));
  console.log(fails ? `${fails} FAILED` : 'all passed');
  await b.close(); server.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
