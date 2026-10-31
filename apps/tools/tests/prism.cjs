// Prism's tools in a browser, the sites faked: a ZIP's contents read with range requests before downloading it,
// and the grabber collecting a page's links by kind.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const ZIP = process.env.ZIP_FILE;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port;
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 420, height: 860 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message)); const ranges = [];
  const zip = fs.readFileSync(ZIP); const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': '*' };
  await p.route('https://files.test/**', (r) => { const q = r.request(); if (q.method() === 'OPTIONS') return r.fulfill({ headers: cors }); if (q.method() === 'HEAD') return r.fulfill({ headers: { ...cors, 'content-length': String(zip.length), 'accept-ranges': 'bytes' } }); const rg = q.headers()['range']; if (rg) { ranges.push(rg); const [a, b] = rg.slice(6).split('-').map(Number); return r.fulfill({ status: 206, headers: { ...cors, 'content-range': 'bytes ' + a + '-' + b + '/' + zip.length }, body: zip.subarray(a, b + 1) }); } r.fulfill({ headers: cors, body: zip }); });
  await p.route('https://page.test/**', (r) => r.fulfill({ headers: cors, contentType: 'text/html', body: '<a href="/v/one.mkv">One</a><a href="two.mp4">Two</a><a href="https://x.test/a.zip">Pack</a><a href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Z">Mag</a><img src="p.jpg"><a href="/about">About</a>' }));
  await p.addInitScript(() => { window.__added = []; window.kurokawaTools = { platform: 'desktop', available: true, os: 'linux', ready: async () => ({}), list: async () => [], add: async (o) => { window.__added.push(o.source.url || o.source.magnet); return { id: 't', name: 'x', ...o }; }, pause: async () => {}, resume: async () => {}, remove: async () => {}, setFiles: async () => {}, setLimits: async () => {}, configure: async () => {}, torrentInfo: async () => { throw new Error('no'); }, open: async () => {}, defaultDir: async () => '/dl', pickDir: async () => null, onTasks: (cb) => { cb([]); return () => {}; } }; });
  await p.goto('http://127.0.0.1:' + port + '/#/'); await p.waitForSelector('.fab'); await p.click('.fab'); await p.waitForSelector('.sheet');
  await p.fill('.add-input', 'https://files.test/pack.zip'); await p.waitForSelector('.add-files details', { timeout: 8000 });
  console.log('zip peek:', await p.$eval('.add-files details summary', (e) => e.textContent), '| ranges:', ranges.join(' , '));
  await p.click('.add-files details summary'); console.log('entries:', (await p.$$eval('.add-files .file-row', (e) => e.map((x) => x.innerText.replace(/\n/g, ' ')))).slice(0, 4).join(' | '));
  await p.click('.sheet button:has-text("Grab links")'); await p.waitForSelector('.sheet input[type=url]'); await p.fill('.sheet input[type=url]', 'https://page.test/list'); await p.press('.sheet input[type=url]', 'Enter');
  await p.waitForSelector('.grab-list .file-row'); console.log('grab chips:', (await p.$$eval('.sheet .chip', (e) => e.map((x) => x.textContent))).join(' | '));
  await p.click('.sheet .btn.primary'); await p.waitForFunction(() => window.__added.length >= 2); console.log('added:', JSON.stringify(await p.evaluate(() => window.__added)));
  console.log(errors.length ? 'errors ' + JSON.stringify(errors) : 'all passed');
  await br.close(); web.close(); process.exit(errors.length ? 1 : 0);
})();
