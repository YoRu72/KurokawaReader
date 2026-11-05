// node tests/textpic.cjs: «Text as image» with a picture beside the words picked — the words before a picture
// (shown unasked), after it (offered, off), and the picture inside the words (shown, the words parted around it).
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
(async () => {
  await new Promise((r) => server.listen(5492, r));
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 500, height: 900 }, locale: 'en' })).newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto('http://localhost:5492/'); await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.visual', JSON.stringify({ readingMode: 'continuous' })); }); await p.reload(); await p.waitForSelector('.library-view');
  await p.setInputFiles('input[type=file]', [path.resolve('public/samples/alice-in-wonderland.epub')]); await p.waitForSelector('.book-card', { timeout: 60000 }); await p.waitForTimeout(600);
  const id = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result[0].id); }; }));
  await p.evaluate((i) => { location.hash = `#/read/${i}`; }, id); await p.waitForSelector('.kr-content'); await p.waitForTimeout(2500);
  // the words of the paragraph right before the first picture, then "Text as image"
  const select = async (which) => await p.evaluate((which) => {
    const c = document.querySelector('.kr-content'); let before, after, img;
    // (A picture with words right before and right after it, whatever they are.)
    for (const i of c.querySelectorAll('img')) { const blk = i.closest('figure') ?? i; if (blk.textContent.trim()) continue; let b = blk.previousElementSibling; while (b && !b.textContent.trim()) b = b.previousElementSibling; let a = blk.nextElementSibling; while (a && !a.textContent.trim()) a = a.nextElementSibling; if (b && a) { img = i; before = b; after = a; break; } }
    if (!img) return 'no picture between words';
    if (!(img.naturalWidth > 0)) { const sc = document.querySelector('.reader-scroll'); sc.scrollTop += sc.clientHeight * 2; return 'not loaded yet'; }
    const r = document.createRange();
    if (which === 'before') { r.selectNodeContents(before); } else if (which === 'after') { r.selectNodeContents(after); } else { r.setStart(before.firstChild, 0); r.setEnd(after.lastChild, after.lastChild.length); }
    (which === 'after' ? after : before).scrollIntoView({ block: 'center' }); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return `${which}: ${s.toString().length} chars`;
  }, which);
  const run = async (which) => {
    let got = await select(which); for (let k = 0; k < 80 && got === 'not loaded yet'; k++) { await p.waitForTimeout(350); got = await select(which); } console.log(got); await p.waitForTimeout(500); await p.evaluate(() => document.dispatchEvent(new Event('selectionchange'))); await p.waitForTimeout(500);
    await p.click('.sel-toolbar button:has-text("Text as image")'); await p.waitForSelector('.snap-preview'); await p.waitForTimeout(500);
    const box = await p.$('.snap-pic-row input'); const h = await p.$eval('.snap-preview', (c) => c.height);
    // (Whether a picture is really drawn: the canvas's middle band holds many different colours.)
    const colours = await p.$eval('.snap-preview', (c) => { const d = c.getContext('2d').getImageData(0, Math.round(c.height * 0.3), c.width, Math.round(c.height * 0.4)).data; const set = new Set(); for (let i = 0; i < d.length; i += 64) set.add((d[i] >> 4) * 4096 + (d[i + 1] >> 4) * 256 + (d[i + 2] >> 4)); return set.size; });
    const r = { has: !!box, on: box ? await box.isChecked() : null, h, colours };
    if (process.env.OUT) await p.screenshot({ path: path.join(process.env.OUT, `textpic-${which}-first.png`) });
    if (box) { await box.click(); await p.waitForTimeout(500); r.h2 = await p.$eval('.snap-preview', (c) => c.height); }
    if (process.env.OUT) await p.screenshot({ path: path.join(process.env.OUT, `textpic-${which}.png`) });
    await p.click('.sheet .sheet-head button[aria-label="Close"]').catch(() => p.keyboard.press('Escape')); await p.waitForTimeout(400); await p.evaluate(() => getSelection().removeAllRanges()); await p.waitForTimeout(300);
    return r;
  };
  const a = await run('before'); ok('the words before a picture: the picture on, drawn, and taller', a.has && a.on === true && a.h > a.h2 && a.colours > 8, a);
  const c = await run('after'); ok('the words after a picture: offered, off', c.has && c.on === false && c.h2 > c.h, c);
  const d = await run('both'); ok('the picture inside the words: on, drawn', d.has && d.on === true && d.h > d.h2 && d.colours > 8, d);
  ok('no page errors', !errors.length, errors);
  await b.close(); server.close(); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
