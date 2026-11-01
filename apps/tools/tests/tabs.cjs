// Each tab remembers its screen: Settings opened at a section and scrolled, Downloads visited, Settings tapped
// again → the same screen (the same element, the same scroll); tapping the open tab goes to its start.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg' };
const web = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }).listen(0, async () => {
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 420, height: 860 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(() => localStorage.setItem('kr.lang', 'en'));
  await p.goto(`http://127.0.0.1:${web.address().port}/#/settings/about`); await p.waitForSelector('#about'); await p.waitForTimeout(500);
  await p.evaluate(() => { document.querySelector('.view').__mark = 42; window.scrollTo(0, 400); const b = document.querySelector('.view .body'); if (b) b.scrollTop = 400; });
  const before = await p.evaluate(() => [window.scrollY, document.querySelector('.view .body')?.scrollTop ?? 0]);
  await p.click('[data-dest="downloads"]'); await p.waitForTimeout(400);
  const onDl = await p.evaluate(() => location.hash);
  await p.click('[data-dest="settings"]'); await p.waitForTimeout(400);
  const back = await p.evaluate(() => [location.hash, document.querySelector('.view').__mark, window.scrollY, document.querySelector('.view .body')?.scrollTop ?? 0]);
  await p.click('[data-dest="settings"]'); await p.waitForTimeout(300);
  const start = await p.evaluate(() => location.hash);
  console.log('before', before, 'downloads', onDl, 'back', back, 'tap again', start);
  const pass = back[0] === '#/settings/about' && back[1] === 42 && (back[2] === before[0] && back[3] === before[1]) && start === '#/settings';
  console.log(errors.length ? 'errors ' + JSON.stringify(errors) : pass ? 'all passed' : 'FAILED');
  await br.close(); web.close(); process.exit(errors.length || !pass ? 1 : 0);
});
