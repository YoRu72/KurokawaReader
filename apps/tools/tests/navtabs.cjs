// The bottom bar: each place lights its own tab (Files lit Files, not Search), a tab goes to its own last place, and
// tapping the open tab goes to its start.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 420, height: 860 } }); p.setDefaultTimeout(6000);
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  const check = (what, ok, x) => { console.log(ok ? 'ok  ' : 'FAIL', what, ok ? '' : JSON.stringify(x ?? '')); if (!ok) errors.push(what); };
  await p.addInitScript(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['files', 'player', 'anime'] })); });
  const lit = () => p.$$eval('.nav [data-dest].active, .rail [data-dest].active, [data-dest].active', (e) => e.map((x) => x.dataset.dest));
  const tab = async (d) => { await p.click(`[data-dest="${d}"]`); await p.waitForTimeout(250); };
  await p.goto(base + '#/'); await p.waitForSelector('[data-dest="files"]');
  await tab('files'); check('Files lights Files', JSON.stringify(await lit()) === '["files"]', await lit());
  await p.evaluate(() => { location.hash = '#/files?p=%2Fsdcard%2FMovies'; }); await p.waitForTimeout(300);
  check('a folder in Files still lights Files', JSON.stringify(await lit()) === '["files"]', await lit());
  await tab('search'); const h1 = await p.evaluate(() => location.hash);
  check('Search goes to Search, not to Files\' folder', h1.startsWith('#/search'), h1); check('Search lit', JSON.stringify(await lit()) === '["search"]', await lit());
  await tab('files'); const h2 = await p.evaluate(() => decodeURIComponent(location.hash));
  check('Files comes back to its folder', h2 === '#/files?p=/sdcard/Movies', h2);
  await tab('files'); const h3 = await p.evaluate(() => location.hash); check('the open tab tapped: its start', h3 === '#/files', h3);
  await p.evaluate(() => { location.hash = '#/courses'; }); await p.waitForTimeout(300);
  check('Courses lights Videos', JSON.stringify(await lit()) === '["videos"]', await lit());
  check('no page errors', !errors.filter((e) => !/lights|goes|comes|tapped|lit/.test(e)).length);
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
