// node tests/jobs.cjs <outdir> <file.pdf>: start a PDF → Word conversion, close its sheet at once; the job goes on,
// a chip shows its progress, then that it is ready; the conversions sheet offers the result.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const [out, pdf] = process.argv.slice(2); fs.mkdirSync(out, { recursive: true });
(async () => {
  await new Promise((r) => server.listen(5182, r));
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 420, height: 860 }, deviceScaleFactor: 2 }); const p = await ctx.newPage();
  await ctx.grantPermissions(['notifications'], { origin: 'http://localhost:5182' });
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.goto('http://localhost:5182/'); await p.evaluate(() => { localStorage.setItem('kr.lang', 'ar'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); });
  await p.reload(); await p.waitForSelector('.library-view');
  await p.setInputFiles('input[type=file]', [path.resolve(pdf)]); await p.waitForSelector('.book-card', { timeout: 60000 }); await p.waitForTimeout(500);
  // (A long press selects the card; Convert is among the selection's actions — behind «More» on a narrow screen.)
  const card = await p.$('.book-card'); await card.dispatchEvent('contextmenu'); await p.waitForSelector('.sel-actions');
  const direct = await p.evaluate(() => { const b = [...document.querySelectorAll('.sel-actions button')].find((x) => /تحويل|Convert/.test(x.textContent)); b?.click(); return !!b; });
  if (!direct) { await p.evaluate(() => { const bs = [...document.querySelectorAll('.sel-actions button')]; bs[bs.length - 1].click(); }); await p.waitForSelector('.sheet'); await p.evaluate(() => { const b = [...document.querySelectorAll('.sheet button')].find((x) => /تحويل|Convert/.test(x.textContent)); b?.click(); }); }
  await p.waitForSelector('.convert-target');
  await p.click(process.env.T ? `.convert-target:has-text("${process.env.T}")` : '.convert-target >> nth=0'); await p.waitForTimeout(600);
  await p.keyboard.press('Escape'); await p.waitForTimeout(400);
  await p.waitForSelector('.job-chip', { timeout: 10000 }); await p.waitForTimeout(1200);
  console.log('chip while running:', await p.textContent('.job-chip'));
  await p.screenshot({ path: path.join(out, '1-running.png') });
  await p.waitForSelector('.job-chip.ready', { timeout: 300000 });
  console.log('chip when ready:', await p.textContent('.job-chip'));
  await p.screenshot({ path: path.join(out, '2-ready.png') });
  await p.click('.job-chip'); await p.waitForSelector('.job-row'); await p.waitForTimeout(400);
  console.log('jobs sheet:', (await p.textContent('.job-list')).replace(/\s+/g, ' '));
  await p.screenshot({ path: path.join(out, '3-sheet.png') });
  await b.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
