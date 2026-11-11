// node tests/pdfsearch.cjs: searching a PDF — a hit opened shows a bar over the page that steps through the hits
// (↑ ↓) without the panel; the search opened again shows the last one as it was (kept unless the switch is off).
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
// A long book still being searched (a phone's 1,061-page PDF): a hit tapped before the search ends is gone to, and the
// panel opened again shows the same search going on — not started again from the first page. (The book is made here:
// 600 pages, "needle" on every seventh. Each page's text is slowed down from the test side — pdf.js's GetTextContent
// to its worker delayed — and pages past 300 held back until released, so the search is surely still running.)
async function longBook(b, port, errors) {
  const { PDFDocument, StandardFonts } = require('pdf-lib'); const file = path.join(require('os').tmpdir(), 'kr-pdfsearch-long.pdf');
  const d = await PDFDocument.create(); const font = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 600; i++) { const pg = d.addPage([400, 560]); for (let l = 1; l <= 12; l++) pg.drawText(`line ${l}: ${i % 7 === 0 && l === 5 ? 'needle' : 'text'} of page ${i}`, { x: 30, y: 520 - l * 36, size: 14, font }); }
  fs.writeFileSync(file, await d.save());
  const ctx = await b.newContext({ viewport: { width: 412, height: 860 }, locale: 'en', isMobile: true, hasTouch: true });
  await ctx.addInitScript(() => {
    window.__hold = true; const held = []; window.__release = () => { window.__hold = false; held.splice(0).forEach((f) => f()); };
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (m, ...rest) {
      if (!m || m.action !== 'GetTextContent') return post.call(this, m, ...rest);
      const send = () => post.call(this, m, ...rest);
      if (window.__hold && m.data && m.data.pageIndex >= 300) held.push(send); else setTimeout(send, 25);
    };
  });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`http://127.0.0.1:${port}/`); await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await p.reload(); await p.waitForSelector('.library-view');
  await p.setInputFiles('input[type=file]', [file]); await p.waitForSelector('.book-card', { timeout: 60000 });
  await p.click('.book-card'); await p.waitForSelector('.pdf-page', { timeout: 30000 }); await p.waitForTimeout(800);
  const status = () => p.evaluate(() => document.querySelector('.panel.open .plain-list')?.previousElementSibling?.textContent ?? '');
  const hits = async () => (await p.$$('.panel.open .hit')).length;
  await p.keyboard.press('/'); await p.waitForSelector('.panel.open input[type=search]');
  await p.fill('.panel.open input[type=search]', 'needle');
  await p.waitForFunction(() => document.querySelectorAll('.panel.open .hit').length >= 6, null, { timeout: 60000 });
  const [s1, k1] = await p.evaluate(() => [document.querySelector('.panel.open .plain-list').previousElementSibling.textContent, document.querySelectorAll('.panel.open .hit').length]); console.log('while searching:', s1, '·', k1, 'listed');
  ok('long book: the search is still running, counting what is listed', /^Searching \d+ of 600/.test(s1) && s1.endsWith(` · ${k1} result(s)`));
  await p.tap('.panel.open .hit >> nth=3');
  // (Its page drawn, the word found is marked and brought to the middle of the screen.)
  await p.waitForFunction(() => document.querySelectorAll('.pdf-page')[27].querySelector('.textLayer .highlight'), null, { timeout: 15000 }).catch(() => undefined); await p.waitForTimeout(300);
  const at = await p.evaluate(() => { const r = document.querySelectorAll('.pdf-page')[27].getBoundingClientRect(); const m = document.querySelectorAll('.pdf-page')[27].querySelector('.textLayer .highlight')?.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), mark: m ? Math.round(m.top) : null, count: document.querySelector('.pcount')?.textContent ?? '' }; });
  const nav1 = (await p.$('.search-nav')) ? await p.$eval('.search-nav-text', (e) => e.textContent) : ''; console.log('tapped:', JSON.stringify(at), 'nav:', nav1);
  ok('a hit tapped while searching: the viewer goes to its page (28), the word marked in view', at.mark !== null && at.mark > 80 && at.mark < p.viewportSize().height - 40 && at.top < at.mark && /Page 28 of/.test(at.count));
  ok('… and the hit bar shows it', /^4 \/ \d+ · Page 28/.test(nav1));
  const before = await p.$$eval('.search-nav-text', (e) => e[0].textContent); const n0 = Number(/\/ (\d+)/.exec(before)[1]);
  await p.click('.search-nav button[aria-label="Search in book"]'); await p.waitForSelector('.panel.open .hit');
  const s2 = await status(); const k2 = await hits(); console.log('reopened:', s2, '·', k2, 'listed');
  const done1 = Number(/Searching (\d+)/.exec(s1)?.[1] ?? 0), done2 = Number(/Searching (\d+)/.exec(s2)?.[1] ?? -1);
  ok('reopened: the same query, its results kept (the tapped one marked)', (await p.inputValue('.panel.open input[type=search]')) === 'needle' && k2 >= n0 && k2 >= 6 && !!(await p.$('.panel.open .hit.current')));
  ok('reopened: the search goes on where it was, not from the first page', /^Searching/.test(s2) && done2 >= done1);
  await p.waitForTimeout(700);
  ok('… and is not started again (the list not cleared)', (await hits()) >= k2 && !!(await p.$('.panel.open .hit.current')));
  await p.evaluate(() => window.__release());
  await p.waitForFunction(() => /^\d+ result/.test(document.querySelector('.panel.open .plain-list')?.previousElementSibling?.textContent ?? ''), null, { timeout: 120000 });
  const s3 = await status(); const k3 = await hits(); const nav3 = await p.$eval('.search-nav-text', (e) => e.textContent); console.log('done:', s3, '·', k3, 'listed · nav:', nav3);
  ok('done: the count is final (85 hits, all listed, the bar counts them)', s3 === '85 result(s)' && k3 === 85 && /^4 \/ 85 /.test(nav3));
  await ctx.close();
}
(async () => {
  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 412, height: 860 }, locale: 'en' })).newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`http://127.0.0.1:${port}/`); await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await p.reload(); await p.waitForSelector('.library-view');
  await p.setInputFiles('input[type=file]', [path.join(__dirname, 'pdfsearch/sample.pdf')]); await p.waitForSelector('.book-card', { timeout: 60000 });
  await p.click('.book-card'); await p.waitForSelector('.pdf-page', { timeout: 30000 }); await p.waitForTimeout(1200);
  await p.keyboard.press('/'); await p.waitForSelector('.panel.open input[type=search]');
  await p.fill('.panel.open input[type=search]', 'line 3:'); await p.waitForSelector('.panel.open .hit', { timeout: 30000 }); await p.waitForTimeout(2500);
  const n = (await p.$$('.panel.open .hit')).length; console.log('hits:', n);
  await p.click('.panel.open .hit >> nth=0'); await p.waitForTimeout(300);
  if (await p.$('.panel.open')) await p.click('.panel.open .panel-head button');
  await p.waitForSelector('.search-nav'); const t1 = await p.$eval('.search-nav-text', (e) => e.textContent); console.log('nav:', t1);
  ok('a hit opened: the bar over the page, the first of all', /^1 \/ \d+/.test(t1) && n > 1);
  await p.click('.search-nav button[aria-label="Next result"]'); await p.waitForTimeout(200);
  const t2 = await p.$eval('.search-nav-text', (e) => e.textContent); console.log('next:', t2);
  ok('the next hit without the panel', /^2 \//.test(t2) && /Page 2/.test(t2));
  await p.click('.search-nav button[aria-label="Previous result"]'); await p.click('.search-nav button[aria-label="Previous result"]'); await p.waitForTimeout(200);
  ok('back past the first: the last', new RegExp(`^${n} /`).test(await p.$eval('.search-nav-text', (e) => e.textContent)));
  await p.click('.search-nav button[aria-label="Search in book"]'); await p.waitForSelector('.panel.open .hit');
  ok('opened again: the last search as it was', (await p.inputValue('.panel.open input[type=search]')) === 'line 3:' && (await p.$$('.panel.open .hit')).length === n && !!(await p.$('.panel.open .hit.current')));
  await p.waitForTimeout(150); await p.keyboard.type('Z'); const typed = await p.inputValue('.panel.open input[type=search]'); ok('opened again: what is typed next goes after the words, not before them', typed === 'line 3:Z', typed); await p.keyboard.press('Backspace'); await p.waitForTimeout(500);
  await p.click('.panel.open .search-keep input'); await p.click('.panel.open .panel-head button'); await p.keyboard.press('/'); await p.waitForSelector('.panel.open input[type=search]');
  ok('the switch off: a new search each time', (await p.inputValue('.panel.open input[type=search]')) === '');
  await longBook(b, port, errors);
  ok('no page errors', !errors.length); if (errors.length) console.log(errors);
  await b.close(); server.close(); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
