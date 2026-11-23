// node tests/selmenu.cjs [en|ar]: the selection menu on a touch screen (phone 412x915, dark). It never covers the selection's first
// or last line nor the handles that hang under them (short, long and screen-filling selections, a drop-cap-like first word); it
// stays away while the selection is being dragged (the system's magnifier is up then); a sheet over the page clears the selection
// (its handles would be drawn over the sheet) and it stays cleared. KR_SHOTS=<dir>: pictures. Made-up / shipped sample book only.
const { chromium, devices } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const lang = process.argv.includes('ar') ? 'ar' : 'en';
const DIST = path.resolve(__dirname, '../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const SHOTS = process.env.KR_SHOTS;
(async () => {
  await new Promise((r) => server.listen(5493, r));
  const b = await chromium.launch(); const ctx = await b.newContext({ ...devices['Pixel 7'], viewport: { width: 412, height: 915 }, locale: lang, colorScheme: 'dark', serviceWorkers: 'block' });
  await ctx.route((u) => !/^(127\.0\.0\.1|localhost)$/.test(u.hostname), (r) => r.abort());
  const p = await ctx.newPage(); const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto('http://localhost:5493/'); await p.evaluate((l) => { localStorage.setItem('kr.lang', l); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.visual', JSON.stringify({ readingMode: 'continuous' })); }, lang); await p.reload(); await p.waitForSelector('.library-view', { timeout: 20000 });
  await p.setInputFiles('input[type=file]', [path.resolve('public/samples/alice-in-wonderland.epub')]); await p.waitForSelector('.book-card', { timeout: 60000 }); await p.waitForTimeout(600);
  const id = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result[0].id); }; }));
  await p.evaluate((i) => { location.hash = `#/read/${i}`; }, id); await p.waitForSelector('.kr-content p', { timeout: 30000 }); await p.waitForTimeout(2500);
  ok('a touch screen', await p.evaluate(() => matchMedia('(pointer: coarse)').matches));
  // the paragraphs on the screen: a drop-cap-like first word (small capitals, larger) on the first of them
  const prep = await p.evaluate(async () => {
    const sc = document.querySelector('.reader-scroll'); const first = [...document.querySelectorAll('.kr-content p')].find((e) => e.textContent.trim().length > 200); if (first && sc) { sc.scrollTop += first.getBoundingClientRect().top - 130; await new Promise((r) => setTimeout(r, 600)); }
    const ps = [...document.querySelectorAll('.kr-content p')].filter((e) => { const r = e.getBoundingClientRect(); return r.top > 120 && r.bottom < innerHeight - 100 && e.textContent.trim().length > 120; });
    return ps.length;
  });
  ok('a paragraph to select in', prep >= 1, prep);
  // select from the start of paragraph a (its first word styled) to offset `end` characters into paragraph b
  const select = (a, b2, endChars) => p.evaluate(([a, b2, endChars]) => {
    const ps = [...document.querySelectorAll('.kr-content p')].filter((e) => { const r = e.getBoundingClientRect(); return r.top > 110 && r.bottom < innerHeight - 90 && e.textContent.trim().length > 120; });
    const pa = ps[a], pb = ps[Math.min(b2, ps.length - 1)]; if (!pa.querySelector('.kr-testcap')) { const t = pa.firstChild; if (t && t.nodeType === 3) { const m = t.data.match(/^(\s*\S+)/); if (m) { const sp = document.createElement('span'); sp.className = 'kr-testcap'; sp.style.cssText = 'font-variant:small-caps;font-size:1.5em;line-height:1'; sp.textContent = m[1]; t.data = t.data.slice(m[1].length); pa.insertBefore(sp, t); } } }
    const r = document.createRange(); r.setStart(pa.firstChild, 0); const tn = [...(function* w(n) { for (const c of n.childNodes) { if (c.nodeType === 3) yield c; else yield* w(c); } })(pb)]; let left = endChars; let node = tn[0], off = 0;
    for (const x of tn) { if (left <= x.length) { node = x; off = left; break; } left -= x.length; node = x; off = x.length; }
    r.setEnd(node, off); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return s.toString().length;
  }, [a, b2, endChars]);
  const state = () => p.evaluate(() => {
    const bar = document.querySelector('.sel-toolbar'); const s = getSelection(); const rs = s.rangeCount && !s.isCollapsed ? [...s.getRangeAt(0).getClientRects()].filter((r) => r.width > 1 && r.height > 1 && r.height < 40) : [];
    const first = rs.length ? rs.reduce((a, c) => (c.top < a.top - 2 ? c : a)) : null, last = rs.length ? rs.reduce((a, c) => (c.bottom > a.bottom + 2 ? c : a)) : null;
    const br = bar?.getBoundingClientRect(); return { bar: !!bar, visible: !!bar && getComputedStyle(bar).opacity !== '0', br: br && { top: br.top, bottom: br.bottom }, first: first && { top: first.top, bottom: first.bottom }, last: last && { top: last.top, bottom: last.bottom }, vh: innerHeight, collapsed: s.isCollapsed };
  });
  const clear = (st) => { // the menu is clear of the first line, the last line and their handles (30 px under each)
    if (!st.br) return false; const hit = (l) => st.br.top < l.bottom + 30 && st.br.bottom > l.top - 4; return !hit(st.first) && !hit(st.last) && st.br.top >= 60 && st.br.bottom <= st.vh;
  };
  const cases = [['one line', 0, 0, 25], ['three paragraphs', 0, 2, 60], ['the screen (long)', 0, 99, 400]];
  for (const [name, a, b2, n] of cases) {
    await p.evaluate(() => getSelection().removeAllRanges()); await p.waitForTimeout(300);
    const len = await select(a, b2, n); await p.waitForTimeout(1300); const st = await state();
    ok(`${name}: the menu is up (${len} chars)`, st.visible, st); ok(`${name}: the menu covers neither end line nor a handle`, clear(st), st);
    if (SHOTS && name === 'the screen (long)') await p.screenshot({ path: path.join(SHOTS, 'R6-selection-menu.png') });
  }
  // a drag: the selection changes every 200 ms; the menu stays away, and comes back placed afresh when it is still
  await select(0, 2, 60); await p.waitForTimeout(1300);
  for (let i = 1; i <= 6; i++) { await select(0, 2, 60 + i * 12); await p.waitForTimeout(200); const st = await state(); if (i === 6) ok('dragging: the menu is hidden', !st.visible, st); }
  await p.waitForTimeout(600); let st = await state(); ok('dragging, paused 0.6 s: still hidden (the magnifier may be up)', !st.visible, st);
  await p.waitForTimeout(900); st = await state(); ok('drag ended: the menu is back, clear of both ends and the handles', st.visible && clear(st), st);
  // a sheet over the page: the menu's «Text as image»; the selection is cleared and stays cleared after the sheet closes
  await p.click('.sel-toolbar button:has-text("' + (lang === 'ar' ? 'نص' : 'Text as image') + '")').catch(async () => { await p.evaluate(() => [...document.querySelectorAll('.sel-toolbar button')].at(-2).click()); });
  await p.waitForSelector('.sheet', { timeout: 15000 }); await p.waitForTimeout(700); st = await state();
  ok('a sheet over the page: the selection is cleared (no handles over it)', st.collapsed && !st.bar, st);
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'R6-textpic-sheet.png') });
  await p.evaluate(() => document.querySelector('.sheet .sheet-head button')?.click()); await p.waitForTimeout(900); st = await state();
  ok('the sheet closed: still cleared, no menu', st.collapsed && !st.bar, st);
  ok('no page errors', !errors.length, errors);
  await b.close(); server.close(); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
