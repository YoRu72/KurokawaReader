// node tests/pdftext/langs.cjs <dir>: what the app reads back from each language's PDF (tests/pdftext/langs.py),
// scored word by word against the sentences it was made from, after the search normalisation (so a word is
// found when a search for it would find it); the words that would not be found are printed.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.bcmap': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const dir = process.argv[2]; const texts = JSON.parse(fs.readFileSync(path.join(dir, 'langs.json'), 'utf8'));
(async () => {
  await new Promise((r) => server.listen(5215, r));
  const browser = await chromium.launch(); const page = await (await browser.newContext()).newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto('http://localhost:5215/'); await page.waitForFunction(() => window.krPdfDebug && window.krNorm);
  let allHit = 0, allN = 0;
  const files = fs.readdirSync(dir).filter((x) => /^lang-.*\.pdf$/.test(x)).sort();
  for (const file of files) {
    const name = file.slice(5, -4), lang = name.split('-')[0], lines = texts[lang]; if (!lines) continue;
    const f = path.join(dir, file);
    const got = (await page.evaluate(async (data) => window.krPdfDebug(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)), 0).catch((e) => ({ text: 'ERROR ' + e })), fs.readFileSync(f).toString('base64'))).text;
    fs.writeFileSync(path.join(dir, `lang-${name}.txt`), got);
    // Found: a word of the source, normalised as search normalises, occurs in the normalised page text (for
    // scripts without spaces — Japanese, Chinese, Thai — the source is cut into runs of 2 characters).
    const r = await page.evaluate(([got, lines, lang]) => {
      const n = (s) => window.krNorm(s).text;
      const compact = /^(ja|zh|th)$/.test(lang);
      const hay = compact ? n(got).replace(/[\s。、，！？：；「」『』（）.,!?:;]/g, '') : n(got.replace(/\n/g, ' ')).replace(/\s+/g, ' ');
      const units = [];
      for (const ln of lines) {
        if (compact) { const s = n(ln).replace(/[\s。、，！？：；「」『』（）.,!?:;]/g, ''); for (let i = 0; i + 2 <= s.length; i += 2) units.push(s.slice(i, i + 2)); }
        else for (const w of n(ln).split(/[\s.,;:!?()«»"'“”‘’،؛؟।۔]+/)) if (w.length > 1) units.push(w);
      }
      const miss = units.filter((u) => !hay.includes(u) && !(compact ? false : hay.replace(/-\s+/g, '').includes(u)));
      return { n: units.length, hit: units.length - miss.length, miss, first: got.split('\n').filter((l) => l && !l.startsWith('===')).slice(0, 2).join(' | ') };
    }, [got, lines, lang]);
    allHit += r.hit; allN += r.n;
    console.log(`${name.padEnd(12)} ${String(Math.round(100 * r.hit / r.n)).padStart(3)}%  missing: ${r.miss.slice(0, 8).join(' ')}${r.miss.length > 8 ? ` (+${r.miss.length - 8})` : ''}`);
    if (process.env.SHOW) console.log('     ', r.first.slice(0, 200));
  }
  console.log(`all ${Math.round(100 * allHit / allN)}% of ${allN} words`);
  await browser.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
