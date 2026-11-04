// The Add sheet on a stubbed phone: a link to «file.bin» that is really a PDF gets its name and extension filled
// (the site's name, its bytes), its size and the storage shown, a page link told as a page, and Wi-Fi only /
// retry / hidden going into the task added.
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path');
const DIST = path.join(__dirname, '..', 'dist'); const lang = process.argv[2] || 'en';
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200000, 0x20)]);
const srv = http.createServer((q, r) => {
  let p = q.url.split('?')[0];
  if (p === '/file.bin') { const rg = /bytes=(\d+)-(\d+)/.exec(q.headers.range || ''); r.setHeader('accept-ranges', 'bytes'); r.setHeader('content-disposition', 'attachment; filename="report-final.bin"'); if (q.method === 'HEAD') { r.writeHead(200, { 'content-length': PDF.length, 'content-type': 'application/octet-stream' }); r.end(); return; } if (rg) { const a = +rg[1], b = Math.min(+rg[2], PDF.length - 1); r.writeHead(206, { 'content-range': `bytes ${a}-${b}/${PDF.length}`, 'content-length': b - a + 1, 'content-type': 'application/octet-stream' }); r.end(PDF.subarray(a, b + 1)); return; } r.writeHead(200, { 'content-length': PDF.length }); r.end(PDF); return; }
  if (p === '/page') { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><html><body>sign in</body></html>'); return; }
  if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f)) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : 'text/html' }); r.end(fs.readFileSync(f));
}).listen(0, '127.0.0.1', async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 412, height: 900 } }); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript((lang) => {
    localStorage.setItem('kr.lang', lang); window.__calls = [];
    const plugin = new Proxy({ addListener: () => ({ remove() {} }), list: async () => ({ tasks: [] }), add: async (o) => { window.__calls.push(['add', o]); return { task: { id: 'n1', kind: 'http', name: o.name, source: o.source, dir: '/d', state: 'downloading', done: 0, total: 0, files: [], addedAt: Date.now(), engine: 'native', meta: o.meta } }; }, archiveFree: async () => ({ free: 7e9 }), defaultDir: async () => ({ dir: '/storage/emulated/0/Download/Kurokawa' }), configure: async () => ({}), can: async () => ({ torrents: true }) }, { get: (t, k) => k === 'httpRequest' ? undefined : k in t ? t[k] : async () => ({}) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
  }, lang);
  const base = `http://127.0.0.1:${srv.address().port}`;
  await p.goto(`${base}/`); await p.waitForSelector('.fab, .topbar', { timeout: 15000 });
  await p.waitForSelector('.fab'); await p.click('.fab'); await p.click('.fab-item >> nth=0'); await p.waitForSelector('.add-input', { timeout: 10000 });
  await p.fill('.add-input', `${base}/file.bin`); await p.waitForFunction(() => /\.pdf|pdf/.test(document.querySelector('.add-size')?.textContent || '') && document.querySelector('.ext-in')?.value === 'pdf', null, { timeout: 15000 });
  const R = {}; R.name = await p.$eval('.save-as input.grow', (e) => e.value); R.ext = await p.$eval('.ext-in', (e) => e.value); R.size = await p.$eval('.add-size', (e) => e.textContent); R.storage = await p.$eval('.add-storage', (e) => e.textContent);
  console.log('name:', R.name, '| ext:', R.ext, '| size line:', R.size, '| storage:', R.storage);
  await p.screenshot({ path: path.join(__dirname, `shot-addprobe-${lang}.png`) });
  await p.fill('.add-input', `${base}/page`); await p.waitForFunction(() => /page|صفحة/.test(document.querySelector('.add-size')?.textContent || ''), null, { timeout: 15000 }); R.page = await p.$eval('.add-size', (e) => e.textContent); console.log('page:', R.page);
  await p.fill('.add-input', `${base}/file.bin`); await p.waitForFunction(() => document.querySelector('.ext-in')?.value === 'pdf', null, { timeout: 15000 });
  await p.check('.check-grid label:nth-child(1) input'); await p.check('.check-grid label:nth-child(3) input'); await p.uncheck('.check-grid label:nth-child(2) input');
  await p.click('.sheet-actions .btn.primary'); await p.waitForFunction(() => window.__calls.length > 0, null, { timeout: 10000 });
  const add = await p.evaluate(() => window.__calls[0][1]); console.log('added:', JSON.stringify({ name: add.name, meta: add.meta }));
  const pass = !errs.length && R.name === 'report-final' && R.ext === 'pdf' && /195/.test(R.size) && /6\.5/.test(R.storage) && add.name === '.report-final.pdf' && add.meta?.wifiOnly === true && add.meta?.noRetry === true && add.meta?.hidden === true;
  console.log(errs.length ? 'ERRORS ' + errs.join(' ; ') : pass ? 'all passed' : 'FAILED'); await b.close(); srv.close(); process.exit(pass ? 0 : 1);
});
