// Prism's mini window (the computer): #/mini shows the speed, how many are downloading and waiting, the first
// four with their progress and «and N more»; the pause button pauses them all; nothing else of the app starts.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const lang = process.argv[2] || 'en';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg' };
const web = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }).listen(0, async () => {
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 320, height: 200 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript((lang) => {
    localStorage.setItem('kr.lang', lang); window.__calls = [];
    const mk = (id, name, state, done, speed) => ({ id, kind: 'http', name, source: { url: 'https://x/' + name }, dir: '/d', state, done, total: 1e9, downSpeed: speed, upSpeed: 0, files: [], addedAt: Date.now(), engine: 'aria2' });
    const tasks = [mk('1', 'Ubuntu 26.04.iso', 'downloading', 4.2e8, 5.5e6), mk('2', 'Season 2 Episode 03.mkv', 'downloading', 7.7e8, 2.1e6), mk('3', 'fonts.zip', 'queued', 0, 0), mk('4', 'a.bin', 'queued', 0, 0), mk('5', 'b.bin', 'queued', 0, 0), mk('6', 'done.pdf', 'done', 1e9, 0)];
    window.kurokawaTools = new Proxy({ platform: 'desktop', available: true, os: 'linux', ready: async () => ({}), list: async () => tasks, onTasks: (cb) => { setTimeout(() => cb(tasks), 50); return () => {}; },
      pause: async (id) => { window.__calls.push(['pause', id]); }, resume: async (id) => { window.__calls.push(['resume', id]); }, mini: async (o) => { window.__calls.push(['mini', o]); return { open: true }; } },
      { get: (t, k) => (k in t ? t[k] : k === 'then' || k === 'can' ? undefined : async () => ({})) });
  }, lang);
  await p.goto(`http://127.0.0.1:${web.address().port}/#/mini`); await p.waitForSelector('.mini-row'); await p.waitForTimeout(300);
  const text = (await p.$eval('.mini-view', (e) => e.innerText)).replace(/\s+/g, ' '); console.log('mini:', text);
  const nav = await p.$('.bottom-nav, .nav-rail'); const fab = await p.$('.fab');
  await p.screenshot({ path: path.join(__dirname, `shot-mini-${lang}.png`) });
  await p.click('.mini-head .mini-btn >> nth=0'); await p.waitForTimeout(200);
  const paused = await p.evaluate(() => window.__calls.filter((c) => c[0] === 'pause').map((c) => c[1]).join(','));
  await p.click('.mini-head .mini-btn >> nth=1'); await p.waitForTimeout(100);
  const main = await p.evaluate(() => window.__calls.find((c) => c[0] === 'mini'));
  console.log('paused:', paused, 'main:', JSON.stringify(main), 'nav:', !!nav, 'fab:', !!fab);
  const pass = /7\.2 MB|٧٫٢/.test(text) && (await p.$$('.mini-row')).length === 4 && paused === '1,2,3,4,5' && main && main[1].action === 'main' && !nav && !fab;
  console.log(errors.length ? 'errors ' + JSON.stringify(errors) : pass ? 'all passed' : 'FAILED');
  await br.close(); web.close(); process.exit(errors.length || !pass ? 1 : 0);
});
