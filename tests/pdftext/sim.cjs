// node tests/pdftext/sim.cjs <dir>: the reading text the app gets from each PDF of tests/pdftext/sim.py, scored
// against the base's (how much of its words come back, order aside) — and simple8 against its own sentences.
// Prints a line per variant and the first lines of each, to see what kind of wreck remains.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.bcmap': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const dir = process.argv[2];
const SIMPLE8 = ['اللفظ: وسميناه في تقسيمنا: اللسان.', 'وقد سبق إلى ذكر هذه العلامات المناطقة حين قسموا الدلالة إلى دلالة', 'وضعية، ودلالة عقلية، ودلالة طبيعية.'].join('\n');
const words = (s) => s.normalize('NFKC').replace(/[ً-ٰٟ]/g, '').split(/[\s،:.؛!؟()«»"]+/).filter((w) => w.length > 1);
const score = (got, want) => { const g = new Map(); for (const w of words(got)) g.set(w, (g.get(w) || 0) + 1); let hit = 0, n = 0; for (const w of words(want)) { n++; if (g.get(w)) { hit++; g.set(w, g.get(w) - 1); } } return n ? hit / n : 0; };
(async () => {
  await new Promise((r) => server.listen(5213, r));
  const browser = await chromium.launch(); const page = await (await browser.newContext()).newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto('http://localhost:5213/'); await page.waitForFunction(() => window.krPdfDebug);
  const text = async (f) => (await page.evaluate(async (data) => window.krPdfDebug(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)), 0).catch((e) => ({ text: 'ERROR ' + e })), fs.readFileSync(f).toString('base64'))).text;
  const base = await text(path.join(dir, 'base.pdf'));
  fs.writeFileSync(path.join(dir, 'base.txt'), base);
  console.log(`base: ${words(base).length} words; first lines: ${base.split('\n').slice(1, 4).join(' | ').slice(0, 160)}`);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.pdf') && x !== 'base.pdf').sort()) {
    const got = await text(path.join(dir, f)); fs.writeFileSync(path.join(dir, f.replace('.pdf', '.txt')), got);
    const want = f === 'simple8.pdf' ? SIMPLE8 : base;
    console.log(`${f.padEnd(14)} ${(score(got, want) * 100).toFixed(0).padStart(3)}%  ${got.split('\n').filter((l) => !l.startsWith('===')).slice(0, 2).join(' | ').slice(0, 140)}`);
  }
  await browser.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
