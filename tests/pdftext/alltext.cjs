// node tests/pdftext/alltext.cjs <outdir> <file.pdf...>: each PDF's reading text (first 40 pages, what search sees)
// into <outdir>/<name>.txt — run before and after a change to the text code and diff the two.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const [out, ...files] = process.argv.slice(2); fs.mkdirSync(out, { recursive: true });
(async () => {
  await new Promise((r) => server.listen(5198, r));
  const browser = await chromium.launch(); const page = await (await browser.newContext()).newPage();
  page.on('dialog', (d) => void d.accept('secret'));
  await page.goto('http://localhost:5198/'); await page.waitForFunction(() => window.krPdfDebug);
  for (const f of files) {
    const data = fs.readFileSync(f).toString('base64');
    const r = await page.evaluate(async (data) => window.krPdfDebug(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)), 0).catch((e) => ({ text: 'ERROR ' + e })), data);
    fs.writeFileSync(path.join(out, path.basename(f, '.pdf') + '.txt'), r.text);
  }
  await browser.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
