// The Archives add-on's sheets in a browser, the desktop bridge faked: open an archive, see inside, extract with
// progress; make a zip.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const REPO = path.join(__dirname, '..', '..', '..', 'repo');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port;
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 420, height: 860 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.route(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/main\/repo\/(.*)/, (r) => { const f = path.join(REPO, r.request().url().split('/main/repo/')[1]); if (!fs.existsSync(f)) return r.fulfill({ status: 404 }); r.fulfill({ body: fs.readFileSync(f), contentType: /\.mjs$/.test(f) ? 'text/plain' : (MIME[path.extname(f)] || 'application/octet-stream') }); });  // (GitHub serves .mjs as text/plain)
  await p.addInitScript(() => {
    const tasks = []; const progressCbs = [];
    window.kurokawaTools = { platform: 'desktop', available: true, os: 'linux', ready: async () => ({}), list: async () => tasks, add: async (o) => ({ id: 't1', ...o }), pause: async () => {}, resume: async () => {}, remove: async () => {}, setFiles: async () => {}, setLimits: async () => {}, configure: async () => {}, torrentInfo: async () => null, open: async () => {}, defaultDir: async () => '/home/u/Downloads/Kurokawa', pickDir: async () => '/mnt/elsewhere', onTasks: (cb) => { cb(tasks); return () => {}; },
      archiveList: async (o) => ({ format: 'zip', entries: [{ path: 'a/', size: 0, dir: true }, { path: 'a/film.mkv', size: 1500000000, dir: false }, { path: 'readme.txt', size: 1200, dir: false }], total: 1500001200, encrypted: false, inPlaceOk: true }),
      archiveExtract: async (o) => { for (let i = 0; i <= 4; i++) { await new Promise((r) => setTimeout(r, 60)); progressCbs.forEach((cb) => cb({ id: o.id, done: i * 375000300, total: 1500001200, file: i < 3 ? 'a/film.mkv' : 'readme.txt' })); } window.__extracted = o; return { files: 2, dest: o.dest }; },
      archiveCancel: async () => {}, archiveCreate: async (o) => { progressCbs.forEach((cb) => cb({ id: o.id, done: 1, total: 1, file: '' })); return { files: o.inputs.length, path: o.out, size: 4242 }; },
      pickFile: async (o) => (o && o.multiple ? ['/home/u/x/one.png', '/home/u/x/two.txt'] : ['/home/u/Downloads/Kurokawa/show.zip']), pathInfo: async () => ({ exists: true }), onArchiveProgress: (cb) => { progressCbs.push(cb); return () => {}; } };
  });
  await p.goto(`http://127.0.0.1:${port}/#/settings/addons`); await p.waitForSelector('.addon-row'); await p.click('.addon-row:has-text("Archives") .btn'); await p.waitForSelector('.toast');
  console.log('toast:', await p.$eval('.toast', (e) => e.textContent));
  await p.goto(`http://127.0.0.1:${port}/#/`); await p.waitForSelector('.fab'); await p.click('.fab'); await p.waitForSelector('.sheet');
  await p.click('.sheet button:has-text("Open an archive")'); await p.waitForSelector('.entry-list');
  console.log('sheet:', (await p.$eval('.sheet', (e) => e.innerText)).replace(/\n+/g, ' | ').slice(0, 400));
  await p.click('.sheet .switch-row:has-text("in place") input');
  await p.screenshot({ path: 'shot-extract.png' });
  await p.click('.sheet .btn.primary'); await p.waitForFunction(() => window.__extracted); await p.waitForSelector('.toast:has-text("extracted")');
  console.log('extract call:', JSON.stringify(await p.evaluate(() => window.__extracted)));
  await p.click('.fab'); await p.waitForSelector('.sheet'); await p.click('.sheet button:has-text("Make a zip")'); await p.waitForSelector('.sheet input[type=text]');
  console.log('zip name:', await p.$eval('.sheet input[type=text]', (e) => e.value), '| dir:', await p.$eval('.sheet p[dir=ltr]', (e) => e.textContent));
  await p.click('.sheet .btn.primary'); await p.waitForSelector('.toast:has-text("made")'); console.log('zip toast:', await p.$eval('.toast', (e) => e.textContent));
  console.log(errors.length ? 'errors ' + JSON.stringify(errors) : 'all passed');
  await br.close(); web.close(); process.exit(errors.length ? 1 : 0);
})();
