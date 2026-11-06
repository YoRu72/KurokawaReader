// The computer's app comes ready: on its first start every add-on (with its sources) is installed by itself —
// Debrid left to be chosen —, and only once.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const REPO = path.join(__dirname, '..', '..', '..', 'repo');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch(); const errors = [];
  const check = (what, ok, x) => { console.log(ok ? 'ok  ' : 'FAIL', what, ok ? '' : JSON.stringify(x ?? '')); if (!ok) errors.push(what); };
  const ctx = await br.newContext({ viewport: { width: 1366, height: 768 } }); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  let asked = 0;
  await ctx.route(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/main\/repo\/(.*)/, (r) => { asked++; const f = path.join(REPO, r.request().url().split('/main/repo/')[1].split('?')[0]); if (!fs.existsSync(f)) return r.fulfill({ status: 404 }); r.fulfill({ body: fs.readFileSync(f), contentType: f.endsWith('.json') ? 'application/json' : 'text/javascript' }); });
  await p.addInitScript(() => { localStorage.setItem('kr.lang', 'en'); window.kurokawaTools = new Proxy({ platform: 'desktop', available: true, os: 'win32', list: async () => [], on: () => () => {}, onTasks: () => () => {} }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) }); });
  await p.goto(base + '#/');
  await p.waitForFunction(() => { try { return localStorage.getItem('kt.pc.starter') === '1'; } catch { return false; } }, null, { timeout: 20000 }).catch(() => undefined);
  const s = await p.evaluate(() => JSON.parse(localStorage.getItem('kt.settings') || '{}').addons || []);
  const want = ['torrent-search', 'torrent-search-nyaa', 'anime', 'anime-nyaa', 'tv', 'subtitles', 'video', 'player', 'files', 'archives'];
  check('every add-on and its sources installed on the first start', want.every((x) => s.includes(x)) && !s.includes('debrid'), s);
  const before = asked; await p.reload(); await p.waitForTimeout(6000);
  check('only once', asked === before || asked - before <= 1, { before, after: asked });
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
