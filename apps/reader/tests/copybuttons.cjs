// node tests/copybuttons.cjs: the copy buttons — the AI instructions (the text as edited; the built-in ones when the box is empty), the
// glossary (the whole list as text that pastes back in; one term), the notes (one note; every note of a book, in the list's order).
const { chromium, devices } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const BOOK = path.resolve(__dirname, 'fixtures/alice-in-wonderland.epub');
const LONG = 'Alice was beginning to get very tired of sitting by her sister on the bank, and of having nothing to do: once or twice she had peeped into the book her sister was reading, but it had no pictures or conversations in it. ' + 'x'.repeat(100);
(async () => {
  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const b = await chromium.launch();
  for (const lang of ['en', 'ar']) {
    const en = lang === 'en'; const L = (e, a) => (en ? e : a);
    const ctx = await b.newContext({ ...devices['Pixel 7'], locale: lang }); const p = await ctx.newPage();
    // (The page's clipboard stubbed: what the app writes is kept, and what it reads is the last thing written.)
    await p.addInitScript(() => { window.__clip = ''; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (s) => { window.__clip = s; }, readText: async () => window.__clip }, configurable: true }); });
    const errors = []; p.on('pageerror', (e) => errors.push(e.message));
    const clip = () => p.evaluate(() => window.__clip); const toasted = () => p.evaluate(() => document.querySelector('.toast')?.textContent ?? '');
    await p.goto(`http://127.0.0.1:${port}/`); await p.evaluate((l) => { localStorage.setItem('kr.lang', l); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }, lang); await p.reload(); await p.waitForSelector('.library-view');
    const tag = `[${lang}] `;
    // ---- the AI instructions
    await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForTimeout(1200);
    await p.evaluate(() => { const h = [...document.querySelectorAll('h3')].find((x) => /AI|الذكاء/.test(x.textContent)); if (h && h.closest('.card')?.classList.contains('collapsed')) h.click(); }); await p.waitForTimeout(200);
    await p.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /instructions|التعليمات/.test(x.textContent) && /AI|key|model|المزود|المفتاح/i.test(x.textContent)); b.click(); });
    await p.waitForSelector('.sheet textarea', { timeout: 8000 });
    const pbtn = p.locator('.sheet button[data-icon=copy]').first();
    ok(tag + 'the instructions have a copy button, a 40px target', (await pbtn.count()) === 1 && (await pbtn.boundingBox()).width >= 40);
    await p.fill('.sheet textarea', 'My own\ninstructions — شرح {lang}'); await pbtn.click(); await p.waitForTimeout(100);
    ok(tag + 'the text as edited is copied (no change event needed)', (await clip()) === 'My own\ninstructions — شرح {lang}', await clip());
    ok(tag + '"Copied" shown', (await toasted()) === L('Copied', 'نُسخ'), await toasted());
    await p.fill('.sheet textarea', '');
    const ph = await p.getAttribute('.sheet textarea', 'placeholder'); await pbtn.click(); await p.waitForTimeout(100);
    ok(tag + 'an empty box copies the built-in instructions', (await clip()) === ph && ph.length > 20, [await clip(), ph]);
    // ---- the glossary (opened from the AI settings; every book)
    await p.evaluate(() => localStorage.setItem('kr.glossary', JSON.stringify([{ id: 'a1', from: 'Lin Feng', to: 'لين فنغ', kind: 'person', lang: 'ar' }, { id: 'a2', from: 'Azure Sect', to: 'الطائفة اللازوردية', kind: 'group', lang: 'ar' }, { id: 'a3', from: 'Qi', to: 'التشي', lang: 'ar' }])));
    await p.evaluate(() => { [...document.querySelectorAll('.sheet button')].find((x) => x.querySelector('svg') && /Glossary|المسرد|مسرد/i.test(x.textContent)).click(); });
    await p.waitForSelector('.gloss-sheet .gloss-row', { timeout: 8000 });
    ok(tag + 'the glossary sheet renders ' + (en ? 'LTR' : 'RTL'), (await p.evaluate(() => getComputedStyle(document.querySelector('.gloss-sheet')).direction)) === (en ? 'ltr' : 'rtl'));
    const all = p.locator('.gloss-sheet .sheet-actions button[data-icon=copy]'); ok(tag + 'a "copy all" button in the glossary', (await all.count()) === 1);
    await all.click(); await p.waitForTimeout(100); const g = await clip();
    const want = ['Azure Sect = الطائفة اللازوردية\tgroup\tar', 'Lin Feng = لين فنغ\tperson\tar', 'Qi = التشي\t\tar'];
    ok(tag + 'every term copied, one line each, name = rendering', g.split('\n').length === 3 && want.every((w) => g.split('\n').includes(w)), g);
    // paste it back after wiping: the same terms return
    await p.evaluate(() => { localStorage.removeItem('kr.glossary'); location.hash = '#/'; }); await p.reload(); await p.waitForSelector('.library-view');
    await p.evaluate((t) => { window.__clip = t; location.hash = '#/settings'; }, g); await p.waitForTimeout(1200);
    await p.evaluate(() => { const h = [...document.querySelectorAll('h3')].find((x) => /AI|الذكاء/.test(x.textContent)); if (h && h.closest('.card')?.classList.contains('collapsed')) h.click(); }); await p.waitForTimeout(200);
    await p.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /instructions|التعليمات/.test(x.textContent) && /AI|key|model|المزود|المفتاح/i.test(x.textContent)); b.click(); }); await p.waitForSelector('.sheet textarea');
    await p.evaluate(() => { [...document.querySelectorAll('.sheet button')].find((x) => x.querySelector('svg') && /Glossary|المسرد|مسرد/i.test(x.textContent)).click(); }); await p.waitForSelector('.gloss-sheet');
    ok(tag + 'the glossary is empty after wiping', (await p.$$('.gloss-sheet .gloss-row')).length === 0);
    await p.locator('.gloss-sheet .sheet-actions button[data-icon=import]').click(); await p.waitForTimeout(300);
    await p.locator('.gloss-sheet .sheet-actions button[data-icon=copy]').click(); await p.waitForTimeout(100);
    ok(tag + 'pasted back: the same entries (copy again gives the same text)', (await clip()) === g && (await p.$$('.gloss-sheet .gloss-row')).length === 3, await clip());
    await p.locator('.gloss-row').first().locator('button[data-icon=copy]').click(); await p.waitForTimeout(100);
    ok(tag + 'one term copied (name = rendering)', (await clip()) === 'Azure Sect = الطائفة اللازوردية', await clip());
    ok(tag + 'the row copy button is a 40px target', (await p.locator('.gloss-row button[data-icon=copy]').first().boundingBox()).width >= 40);
    // ---- the notes
    await p.evaluate(() => { document.querySelectorAll('.sheet,.scrim').forEach((x) => x.remove()); location.hash = '#/'; }); await p.waitForSelector('.library-view');
    await p.setInputFiles('input[type=file]', [BOOK]); await p.waitForSelector('.book-card', { timeout: 60000 }); await p.waitForTimeout(800);
    await p.evaluate(([LONG]) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const tx = r.result.transaction('books', 'readwrite'); const st = tx.objectStore('books'); const q = st.getAll(); q.onsuccess = () => { const bk = q.result[0]; const n = Date.now();
      bk.bookmarks = [{ id: 'b1', label: 'Chapter one', cfi: '', createdAt: n }];
      bk.highlights = [{ id: 'h1', text: LONG, color: 'amber', note: 'first note', createdAt: n - 2000 }, { id: 'h2', text: 'Second quote', color: 'rose', note: 'second note\nwith a line', createdAt: n - 1000 }, { id: 'h3', text: 'No note here', color: 'sky', createdAt: n - 500 }];
      st.put(bk); tx.oncomplete = res; }; }; }), [LONG]);
    await p.reload(); await p.waitForSelector('.library-view'); await p.evaluate(() => { location.hash = '#/notes'; }); await p.waitForSelector('.notes-book'); await p.click('.notes-head'); await p.waitForTimeout(200);
    ok(tag + 'the notes view renders ' + (en ? 'LTR' : 'RTL'), (await p.evaluate(() => getComputedStyle(document.querySelector('.notes-view')).direction)) === (en ? 'ltr' : 'rtl'));
    const li = p.locator('.notes-book .plain-list li'); const nCopy = li.locator('button[data-icon=copy]');
    ok(tag + 'a copy button on each note (not on the bookmark)', (await nCopy.count()) === 2, await nCopy.count());
    const bb = await nCopy.first().boundingBox(); const lb = await li.nth(1).boundingBox();
    ok(tag + 'the note copy button: 40px, at the end side of its row', bb.width >= 40 && bb.height >= 40 && (en ? bb.x > lb.x + lb.width / 2 : bb.x + bb.width < lb.x + lb.width / 2), [bb, lb]);
    await nCopy.first().click(); await p.waitForTimeout(100); const n1 = await clip();
    ok(tag + 'a note copies its full quote, its note and the date', n1.startsWith('> ' + LONG) && n1.includes('first note') && /<sub>.+<\/sub>/.test(n1), n1);
    ok(tag + '"Copied" toast', (await toasted()) === L('Copied', 'نُسخ'), await toasted());
    await p.locator('.notes-head-row button[data-icon=copy]').click(); await p.waitForTimeout(100); const na = await clip();
    const order = ['Chapter one', 'first note', 'second note'].map((s) => na.indexOf(s));
    ok(tag + 'copy all: the bookmark, then the notes in the list order; the highlight without a note left out', order.every((x) => x >= 0) && order[0] < order[1] && order[1] < order[2] && !na.includes('No note here') && na.includes(LONG) && na.startsWith('# '), na);
    await p.screenshot({ path: path.join(process.env.OUT || '/tmp', `copybuttons-${lang}.png`) });
    ok(tag + 'no page errors', errors.length === 0, errors);
    await ctx.close();
  }
  console.log(fails ? `${fails} failed` : 'all passed'); await b.close(); server.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
