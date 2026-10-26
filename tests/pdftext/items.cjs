// node tests/pdftext/items.cjs <file.pdf> <page> [y-from y-to]: the text items the reader's (patched) pdf.js gives
// for one page — [text, x, y, width, dir, font] — and the page's reading text (what search sees).
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const [pdf, pageNo, y0, y1] = [path.resolve(process.argv[2]), Number(process.argv[3]), process.argv[4], process.argv[5]];
(async () => {
  await new Promise((r) => server.listen(5197, r));
  const browser = await chromium.launch(); const page = await (await browser.newContext({ viewport: { width: 1100, height: 1000 } })).newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message)); page.on('console', (m) => { if (m.text().startsWith('KR')) console.log(m.text()); });
  if (process.env.ROW) await page.addInitScript((r) => { globalThis.krDebugRows = r; }, process.env.ROW);
  await page.goto('http://localhost:5197/'); await page.waitForSelector('.library-view');
  const data = fs.readFileSync(pdf).toString('base64');
  await page.waitForFunction(() => window.krPdfDebug);
  const out = await page.evaluate(async ({ data, pageNo }) => window.krPdfDebug(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)), pageNo), { data, pageNo });
  for (const it of out.items) if (y0 === undefined || (it[2] >= +y0 && it[2] <= +y1)) console.log(JSON.stringify(it));
  console.log('--- reading text ---\n' + out.text);
  await browser.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
