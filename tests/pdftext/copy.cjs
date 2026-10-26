// node tests/pdftext/copy.cjs <file.pdf> <page> [shot.png]: open a PDF in the built reader, select the whole
// text of one page and print what Copy puts on the clipboard (the reader's own selection → text logic).
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const [pdf, pageNo, shot] = [path.resolve(process.argv[2]), process.argv[3] || '1', process.argv[4]];
(async () => {
  await new Promise((r) => server.listen(5198, r));
  const browser = await chromium.launch(); const ctx = await browser.newContext({ viewport: { width: 900, height: 1200 }, permissions: ['clipboard-read', 'clipboard-write'] }); const page = await ctx.newPage();
  if (process.env.ITEMS) { await page.addInitScript(([n, c]) => { globalThis.krDebugItems = n; globalThis.krDebugCut = !!c; }, [process.env.ITEMS, process.env.CUT || '']); page.on('console', (m) => { if (m.text().startsWith('KR ')) console.log(m.text()); }); }
  page.on('pageerror', (e) => console.log('pageerror', e.message)); page.on('dialog', (d) => void d.accept(process.env.PW || ''));
  await page.goto('http://localhost:5198/'); await page.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await page.reload(); await page.waitForSelector('.library-view');
  await page.setInputFiles('input[type=file]', [pdf]); await page.waitForSelector('.book-card', { timeout: 60000 });
  await page.click('.book-card'); await page.waitForSelector('.pdf-page canvas', { timeout: 60000 });
  await page.fill('.pdf-bar input[type=number]', pageNo); await page.press('.pdf-bar input[type=number]', 'Enter');
  await page.waitForTimeout(2500);
  const idx = +pageNo - 1;
  if (process.env.DRAG) {
    // DRAG="line,fromFrac,toFrac": press on a text line (index among the layer's lines) at a fraction of the page
    // width and drag to another fraction, like a reader selecting with the mouse; print what Copy gives.
    const [li, f0, f1] = process.env.DRAG.split(',').map(Number);
    const box = await page.evaluate(([i, li]) => {
      const pg = [...document.querySelectorAll('.pdf-page')].find((p) => p.dataset.page === String(i + 1));
      const spans = [...pg.querySelectorAll('.textLayer > span')];
      const tops = [...new Set(spans.map((s) => Math.round(s.getBoundingClientRect().top)))].sort((a, b) => a - b);
      const r = pg.getBoundingClientRect(); const ln = spans.filter((s) => Math.abs(Math.round(s.getBoundingClientRect().top) - tops[li]) < 4);
      const rr = ln[0].getBoundingClientRect();
      return { x: r.left, w: r.width, y: rr.top + rr.height / 2 };
    }, [idx, li]);
    await page.mouse.move(box.x + box.w * f0, box.y); await page.mouse.down();
    for (let k = 1; k <= 10; k++) await page.mouse.move(box.x + box.w * (f0 + (f1 - f0) * k / 10), box.y);
    await page.mouse.up(); await page.waitForTimeout(600);
    console.log('native:', await page.evaluate(() => getSelection().toString()));
    const b = await page.$('button:has-text("Copy")'); if (b) { await b.click(); await page.waitForTimeout(300); console.log('copy:', await page.evaluate(() => navigator.clipboard.readText())); }
    if (shot) await page.screenshot({ path: shot });
    await browser.close(); server.close(); return;
  }
  const text = await page.evaluate(async (i) => {
    const pages = [...document.querySelectorAll('.pdf-page')];
    const pg = pages.find((p) => p.dataset.page === String(i + 1)) || pages[i];
    const layer = pg && pg.querySelector('.textLayer');
    if (!layer || !layer.firstChild) return '(no text layer)';
    const r = document.createRange(); r.selectNodeContents(layer);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    document.dispatchEvent(new Event('selectionchange'));
    return '';
  }, idx);
  if (text) console.log(text);
  if (process.env.SPANS) console.log(await page.evaluate(([i, needle]) => {
    const pg = [...document.querySelectorAll('.pdf-page')].find((p) => p.dataset.page === String(i + 1));
    const spans = [...pg.querySelectorAll('.textLayer > span')];
    let y0;
    if (/^\d+$/.test(needle)) { const tops = [...new Set(spans.map((s) => Math.round(s.getBoundingClientRect().top / 6)))].sort((a, b) => a - b); y0 = tops[+needle] * 6; }
    else y0 = spans[spans.findIndex((s) => s.textContent.includes(needle))].getBoundingClientRect().top;
    return spans.filter((s) => Math.abs(s.getBoundingClientRect().top - y0) < 8).sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right).map((s) => { const r = s.getBoundingClientRect(); return JSON.stringify([s.textContent, Math.round(r.left), Math.round(r.right), Math.round(r.top), Math.round(r.height), 1 ? s.getAttribute('style') : '']); }).join('\n');
  }, [idx, process.env.SPANS]));
  await page.waitForTimeout(600);
  const btn = await page.$('button:has-text("Copy")');
  if (!btn) { console.log('(no copy button)'); } else { await btn.click(); await page.waitForTimeout(300); console.log(await page.evaluate(() => navigator.clipboard.readText())); }
  if (shot) await page.screenshot({ path: shot });
  await browser.close(); server.close();
})();
