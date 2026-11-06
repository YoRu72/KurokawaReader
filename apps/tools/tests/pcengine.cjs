// The computer with aria2c not (yet) up: its own engine is still the one used — a magnet added goes to the app, where
// adding starts aria2c again —, never the browser's (which only hands a link over and calls it done).
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch(); const errors = [];
  const check = (what, ok, x) => { console.log(ok ? 'ok  ' : 'FAIL', what, ok ? '' : JSON.stringify(x ?? '')); if (!ok) errors.push(what); };
  const ctx = await br.newContext({ viewport: { width: 1366, height: 768 } }); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await ctx.route(/raw\.githubusercontent\.com/, (r) => r.fulfill({ status: 404 }));
  await p.addInitScript(() => {
    localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.pc.starter', '1'); window.__added = []; window.__retried = 0;
    const st = { available: false, reason: 'aria2c did not answer' };
    window.kurokawaTools = new Proxy({ platform: 'desktop', get available() { return st.available; }, get reason() { return st.reason; }, os: 'win32', list: async () => [], on: () => () => {}, onTasks: () => () => {},
      retryEngine: async () => { window.__retried++; return st; },
      add: async (o) => { window.__added.push(o); st.available = true; st.reason = ''; return { id: 'g1', kind: 'torrent', name: 'x', source: o.source, dir: '', state: 'metadata', done: 0, total: 0, speed: 0, created: Date.now() }; } },
      { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) });
  });
  await p.goto(base + '#/'); await p.waitForSelector('.rail-fab');
  await p.click('.rail-fab'); await p.click('.fab-item >> nth=0'); await p.waitForSelector('.add-sheet');
  await p.fill('.add-input', 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=test'); await p.waitForTimeout(600);
  await p.click('.add-sheet .btn.primary'); await p.waitForTimeout(1200);
  const added = await p.evaluate(() => window.__added.length);
  const toast = await p.evaluate(() => document.querySelector('.toast')?.textContent || '');
  check('the magnet went to the computer\'s engine', added === 1, { added, toast });
  check('no «no download engine» refusal', !/no download engine/i.test(toast), toast);
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
