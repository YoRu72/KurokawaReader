// The library's Browse button: the count of what waits at the sources, kept from the last check, shows its mark at
// once (the sources themselves are not loaded to draw the library), and a change of the count shows at once too.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.writeHead(200, { 'content-type': MIME[path.extname(f)] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const br = await chromium.launch(); const ctx = await br.newContext({ serviceWorkers: 'block' }); const p = await ctx.newPage(); const errors = [];
  p.on('pageerror', (e) => errors.push(e.message)); const check = (w, ok) => { console.log(ok ? 'ok  ' : 'FAIL', w); if (!ok) errors.push(w); };
  await ctx.addInitScript(() => { localStorage.setItem('kr.update.lastCheck', String(Date.now())); if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('kr.updates.pending', JSON.stringify({ chapters: 3, series: 1 })); } });
  await p.goto(`http://127.0.0.1:${port}/`); await p.waitForSelector('.browse-btn');
  check('the mark shows at once from the kept count', await p.$eval('.browse-btn .alert-mark', (e) => !e.hidden));
  await p.evaluate(() => { localStorage.setItem('kr.updates.pending', JSON.stringify({ chapters: 0, series: 0 })); window.dispatchEvent(new Event('kr-pending')); });
  check('a change of the count shows at once', await p.$eval('.browse-btn .alert-mark', (e) => e.hidden));
  // the sources counted again a few seconds after start: nothing waits in a new library, so the mark stays off
  await p.evaluate(() => { localStorage.setItem('kr.updates.pending', JSON.stringify({ chapters: 2, series: 0 })); window.dispatchEvent(new Event('kr-pending')); });
  await p.waitForFunction(() => document.querySelector('.browse-btn .alert-mark').hidden, null, { timeout: 9000 }).catch(() => undefined);
  check('the real count replaces a stale one', await p.$eval('.browse-btn .alert-mark', (e) => e.hidden));
  console.log(errors.length ? 'errors ' + JSON.stringify(errors) : 'all passed'); await br.close(); server.close(); process.exit(errors.length ? 1 : 0);
})();
