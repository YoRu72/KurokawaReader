// node tests/pdftools/scan.cjs <outdir> <lang> <photo...>: drive the document scanner in the built app — add
// photos, open the first page's editor (drag a corner, switch look, turn), and make the PDF — saving it and a
// screenshot of each step.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const [out, lang, ...photos] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
(async () => {
  await new Promise((r) => server.listen(5198, r));
  const browser = await chromium.launch(); const ctx = await browser.newContext({ viewport: { width: Number(process.env.W || 420), height: 860 }, deviceScaleFactor: 2, acceptDownloads: true, hasTouch: true }); const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message)); page.on('console', (m) => { if (m.type() === 'error') console.log('console', m.text().slice(0, 300)); });
  await page.goto('http://localhost:5198/'); await page.evaluate((l) => { localStorage.setItem('kr.lang', l); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }, lang); await page.reload(); await page.waitForSelector('.library-view');
  await page.click('.library-tools .tool-btn[data-icon="file"]'); await page.waitForSelector('.sheet .convert-target');
  await page.click('.sheet .convert-targets .convert-target:nth-child(2)'); await page.waitForSelector('.scan-sheet'); await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(out, '1-empty.png') });
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.scan-sheet .tool-bar .btn.tonal')]); await chooser.setFiles(photos.map((p) => path.resolve(p)));
  await page.waitForFunction((n) => document.querySelectorAll('.scan-sheet .page-tile').length >= n, photos.length, { timeout: 120000 }); await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, '2-pages.png'), fullPage: true });
  await page.click('.scan-sheet .page-tile:first-child .page-frame'); await page.waitForSelector('.scan-editor .scan-handle'); await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(out, '3-editor.png') });
  const hd = await page.$('.scan-editor .scan-handle:nth-of-type(1)'); const b = await hd.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down(); await page.mouse.move(b.x + 40, b.y + 30, { steps: 5 });
  await page.screenshot({ path: path.join(out, '4-drag.png') }); await page.mouse.up();
  await page.click('.scan-editor .scan-filters .chip:nth-child(4)'); await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, '5-result-bw.png') });
  await page.click('.scan-editor .sheet-actions .btn.primary'); await page.waitForTimeout(500);
  await page.click('.scan-sheet .tool-bar .icon-btn'); await page.waitForSelector('.scan-check'); await page.waitForTimeout(600); await page.screenshot({ path: path.join(out, '6-settings.png') });
  await page.click('.sheet:last-of-type .sheet-actions .btn.primary');
  await page.click('.scan-sheet .sheet-actions .btn.primary'); await page.waitForSelector('.scan-sheet .convert-result:not([hidden]) button', { timeout: 300000 });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.scan-sheet .convert-result button:nth-child(2)')]); const f = path.join(out, 'scan.pdf'); await dl.saveAs(f); console.log('saved', fs.statSync(f).size);
  await page.screenshot({ path: path.join(out, '7-done.png') });
  await browser.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
