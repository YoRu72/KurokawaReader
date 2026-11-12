// node tests/speakstop.cjs: read-aloud is quiet once stopped (src/tts.ts speakPassage / stopSpeech; src/views/reader.ts
// mountPdf's "Speak" and speak/stopSpeaking):
//  1. read aloud started and stopped at once — before the voices are known — speaks nothing afterwards (one passage
//     was still spoken);
//  2. a PDF's "Speak" (selected words) stops when the book is closed (it went on talking in the library).
// The device's speech is stubbed (headless has no voices): what is spoken and still playing is counted. The books are
// made here.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 600))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-speakstop-'));
const allBooks = (p) => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result); }; }));
async function importFile(p, file, re) {
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.waitForTimeout(600);
  await p.setInputFiles('.library-view input[type=file]', [file]);
  for (let i = 0; i < 120; i++) {
    const b = (await allBooks(p)).find((x) => new RegExp(re, 'i').test(x.title)); if (b) return b;
    await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); s?.querySelector('.sheet-actions button, button.btn')?.click(); });
    await p.waitForTimeout(250);
  }
  throw new Error('not imported: ' + file);
}
// The device's speech, stubbed: no voices listed (as on a device whose list fills late), each utterance counted as
// playing until it is cancelled.
const stub = () => {
  const s = window.speechSynthesis; window.__tts = { spoken: [], playing: [] };
  s.getVoices = () => [];
  s.speak = (u) => { window.__tts.spoken.push(u.text); window.__tts.playing.push(u.text); };
  s.cancel = () => { window.__tts.playing = []; };
};
const tts = (p) => p.evaluate(() => ({ spoken: window.__tts.spoken.length, playing: window.__tts.playing.length }));

(async () => {
  const txt = path.join(TMP, 'quiet.txt');
  fs.writeFileSync(txt, ['The Quiet Book', 'A first paragraph that would be read aloud.', 'A second paragraph after it.', 'A third one to end.'].join('\n\n') + '\n');
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const d = await PDFDocument.create(); const font = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([400, 500]).drawText('Words of the paper to be spoken aloud.', { x: 40, y: 420, size: 16, font });
  const pdf = path.join(TMP, 'spoken.pdf'); fs.writeFileSync(pdf, await d.save());

  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const br = await chromium.launch(); const errors = [];
  const ctx = await br.newContext({ viewport: { width: 900, height: 900 }, locale: 'en' });
  await ctx.addInitScript(stub);
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`http://127.0.0.1:${port}/`);
  await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.visual', JSON.stringify({ readingMode: 'continuous' })); });
  await p.reload(); await p.waitForSelector('.library-view');

  // ---- 1. started and stopped at once
  {
    const bk = await importFile(p, txt, 'quiet');
    await p.evaluate((id) => { location.hash = `#/read/${id}`; }, bk.id); await p.waitForSelector('.reader-flow .kr-content', { timeout: 30000 }); await p.waitForTimeout(800);
    await p.evaluate(() => { document.dispatchEvent(new CustomEvent('kr:command', { detail: 'speak' })); });
    await p.waitForTimeout(150);
    await p.evaluate(() => { document.dispatchEvent(new CustomEvent('kr:command', { detail: 'speak' })); });   // (pressed again: stop)
    await p.waitForTimeout(2500);
    const n = await tts(p); ok('read aloud stopped right after it was started: nothing spoken', n.spoken === 0 && n.playing === 0, n);
    // (and started for good, it does speak — the stub works)
    const was = n.spoken;
    await p.evaluate(() => { document.dispatchEvent(new CustomEvent('kr:command', { detail: 'speak' })); });
    await p.waitForFunction((was) => window.__tts.spoken.length > was, was, { timeout: 5000 }).catch(() => undefined);
    const m = await tts(p); ok('read aloud left going: it speaks', m.spoken === was + 1 && m.playing === 1, m);
    await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.waitForTimeout(300);
    ok('the book closed: the flowing book\'s reading stops (as before)', (await tts(p)).playing === 0);
  }

  // ---- 2. a PDF's "Speak", and the book closed
  {
    const bk = await importFile(p, pdf, 'spoken');
    await p.evaluate((id) => { location.hash = `#/read/${id}`; }, bk.id);
    await p.waitForSelector('.pdf-page .textLayer span', { timeout: 30000 }); await p.waitForTimeout(800);
    const before = (await tts(p)).spoken;
    const sel = await p.evaluate(() => { const span = [...document.querySelectorAll('.pdf-page .textLayer span')].find((s) => /spoken/.test(s.textContent)); if (!span) return false; const r = document.createRange(); r.selectNodeContents(span); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; });
    ok('selected the words on the page', sel);
    await p.waitForSelector('.sel-toolbar', { timeout: 5000 }); await p.click('.sel-toolbar .sel-row button:has-text("More")');
    await p.waitForSelector('.sheet .plain-list button');
    await p.evaluate(() => [...document.querySelectorAll('.sheet .plain-list button')].find((b) => b.textContent.trim() === 'Speak').click());
    await p.waitForFunction((n) => window.__tts.spoken.length > n, before, { timeout: 5000 }).catch(() => undefined);
    const n = await tts(p); ok('PDF: the selected words are spoken', n.spoken > before && n.playing === 1, n);
    await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.waitForTimeout(400);
    const m = await tts(p); ok('PDF: the book closed, the speech stops', m.playing === 0, m);
  }
  ok('no page errors', !errors.length, errors);
  await br.close(); server.close(); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
