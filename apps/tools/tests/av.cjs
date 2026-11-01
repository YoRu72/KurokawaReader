// The antivirus check on a finished download (the desktop bridge faked): its line on the done card, and «Turn off»
// there stopping the checks for later downloads.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port;
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 420, height: 860 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  const check = (what, ok) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) errors.push(what); };
  await p.addInitScript(() => {
    const cbs = []; const mk = (state) => ({ id: 'a', kind: 'http', name: 'setup.exe', source: { url: 'https://x/setup.exe' }, dir: '/home/u/Downloads', state, done: state === 'done' ? 5e7 : 1e7, total: 5e7, downSpeed: 0, upSpeed: 0, files: [], addedAt: Date.now() - 60e3, doneAt: state === 'done' ? Date.now() : undefined, engine: 'desktop' });
    window.__emit = (state) => cbs.forEach((cb) => cb([mk(state)])); window.__scans = 0;
    window.kurokawaTools = { platform: 'desktop', available: true, os: 'linux', ready: async () => ({}), list: async () => [mk('downloading')], add: async (o) => ({ id: 't', ...o }), pause: async () => {}, resume: async () => {}, remove: async () => {}, setFiles: async () => {}, setLimits: async () => {}, configure: async () => {}, torrentInfo: async () => null, open: async () => {}, defaultDir: async () => '/home/u/Downloads', pickDir: async () => '/x', onTasks: (cb) => { cbs.push(cb); cb([mk('downloading')]); return () => {}; },
      avScan: async () => { window.__scans++; await new Promise((r) => setTimeout(r, 200)); return { result: 'clean', scanner: 'clamav' }; } };
    if (!localStorage.getItem('kt.settings')) localStorage.setItem('kt.settings', JSON.stringify({ av: { on: true, kind: 'auto', command: '', args: '{file}', extensions: 'exe zip' } }));
  });
  await p.goto(`http://127.0.0.1:${port}/#/`); await p.waitForSelector('.task-card'); await p.waitForTimeout(500);
  await p.evaluate(() => window.__emit('done')); await p.waitForSelector('.done-card .av-line.ok', { timeout: 5000 });
  console.log('line:', await p.$eval('.done-card .av-line', (e) => e.textContent));
  check('the check ran and its line shows', (await p.evaluate(() => window.__scans)) === 1);
  await p.click('.done-card .av-off'); await p.waitForTimeout(200);
  check('turned off from the card', (await p.evaluate(() => JSON.parse(localStorage.getItem('kt.settings')).av.on)) === false);
  check('no page errors', !errors.filter((e) => e !== 'no page errors').length);
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
