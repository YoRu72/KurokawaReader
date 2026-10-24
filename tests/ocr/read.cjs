// node tests/ocr/read.cjs <image...>: read each picture with the app's OCR (in the built app, in Chromium) and print
// the text, the language chosen, the confidence and the time.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
(async () => {
  await new Promise((r) => server.listen(5205, r));
  const b = await chromium.launch(); const p = await b.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message)); p.on('console', (m) => { if (m.type() === 'error') console.log('console', m.text().slice(0, 200)); });
  await p.goto('http://localhost:5205/'); await p.waitForSelector('.library-view');
  for (const f of process.argv.slice(2)) {
    const b64 = fs.readFileSync(f).toString('base64'); const type = f.endsWith('.png') ? 'image/png' : 'image/jpeg';
    const r = await p.evaluate(async ([b64, type]) => {
      const bin = atob(b64); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
      const ocr = await window.krOcr(); const t0 = performance.now();
      const res = await ocr.recognizeAuto(new Blob([a], { type }), { pdf: true });
      return { text: res.text, lang: res.lang, conf: Math.round(res.confidence), ms: Math.round(performance.now() - t0), pdf: res.pdf ? res.pdf.length : 0, ok: await ocr.ocrAvailable() };
    }, [b64, type]);
    console.log(`== ${path.basename(f)} · ${r.lang} · confidence ${r.conf} · ${r.ms} ms · pdf ${r.pdf} B`);
    console.log(r.text.slice(0, Number(process.env.CHARS || 1200)));
  }
  await b.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
