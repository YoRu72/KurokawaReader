// node tests/pdftools/docs.cjs <outdir> <file...>: Documents → PDF in the built app, from files on the device;
// saves the PDF and screenshots.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const [out, ...files] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
(async () => {
  await new Promise((r) => server.listen(5196, r));
  const browser = await chromium.launch(); const ctx = await browser.newContext({ viewport: { width: 900, height: 1000 }, acceptDownloads: true }); const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message)); page.on('console', (m) => { if (m.type() === 'error') console.log('console', m.text().slice(0, 300)); });
  await page.goto('http://localhost:5196/'); await page.evaluate(() => localStorage.setItem('kr.update.lastCheck', String(Date.now()))); await page.reload(); await page.waitForSelector('.library-view'); await page.evaluate(() => { globalThis.krTiming = {}; globalThis.krDebugLeaves = true; }); page.on('console', (m) => { if (m.text().startsWith('KR')) console.log(m.text()); });
  await page.click('.library-tools .tool-btn[data-icon="file"]'); await page.waitForSelector('.sheet .convert-target');
  await page.click('.sheet .convert-targets .convert-target:nth-child(1)'); await page.waitForSelector('.sheet:last-of-type .tool-bar');
  const [ch] = await Promise.all([page.waitForEvent('filechooser'), page.click('.sheet:last-of-type .tool-bar button:first-child')]); await ch.setFiles(files.map((f) => path.resolve(f)));
  await page.waitForFunction((n) => document.querySelectorAll('.sheet:last-of-type .tool-row').length >= n, files.length); await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, 'docs.png') });
  const t0 = Date.now(); await page.click('.sheet:last-of-type .sheet-actions .btn.primary'); await page.waitForSelector('.sheet:last-of-type .convert-result:not([hidden]) button', { timeout: 1500000 }); console.log('converted in', Date.now() - t0, 'ms', JSON.stringify(await page.evaluate(() => Object.fromEntries(Object.entries(globalThis.krTiming || {}).map(([k, v]) => [k, Math.round(v)])))));
  if (process.env.SVG) fs.writeFileSync(process.env.SVG, await page.evaluate(() => globalThis.krDebugSvg || ''));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.sheet:last-of-type .convert-result button:nth-child(2)')]); const f = path.join(out, 'docs.pdf'); await dl.saveAs(f); console.log('saved', fs.statSync(f).size);
  await browser.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
