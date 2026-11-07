// Reading on a computer: the tools in the top bar with their names; arrows at the sides (shown on mouse movement)
// turn the page; the contents dock beside the page, stay open after a jump, and open again with the next book until
// closed; a picture opens on a double-click, not a single one. A phone keeps the floating toolbar.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.epub': 'application/epub+zip', '.png': 'image/png', '.jpg': 'image/jpeg' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch(); const errors = [];
  const check = (what, ok, x) => { console.log(ok ? 'ok  ' : 'FAIL', what, ok ? '' : JSON.stringify(x ?? '')); if (!ok) errors.push(what); };
  const ctx = await br.newContext({ viewport: { width: 1366, height: 768 } }); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(() => localStorage.setItem('kr.lang', 'en'));
  await p.goto(base); await p.waitForSelector('.empty .btn:not(.primary)'); await p.click('.empty .btn:not(.primary)'); await p.waitForSelector('.book-card');
  const openBook = async (title) => { await p.goto(base); await p.waitForSelector('.book-card'); await p.locator('.book-card', { hasText: title }).first().click(); await p.waitForSelector('.book-read'); await p.click('.book-read'); await p.waitForSelector('.reader-flow .kr-content, .reader-flow p', { timeout: 20000 }); await p.waitForTimeout(1500); };
  await openBook('Alice');
  const tb = await p.evaluate(() => { const t = document.querySelector('.float-toolbar').getBoundingClientRect(); const l = [...document.querySelectorAll('.float-toolbar .tb-label')].filter((x) => x.offsetParent).map((x) => x.textContent); return { top: t.top, h: t.height, labels: l }; });
  check('the tools in the top bar, named', tb.top < 20 && tb.h <= 70 && tb.labels.includes('Contents'), tb);
  // Arrows: hidden at rest, shown on mouse movement; next turns the page.
  const op = () => p.$eval('.page-arrow.next', (e) => Number(getComputedStyle(e).opacity));
  check('arrows hidden at rest', (await op()) === 0);
  await p.mouse.move(600, 400); await p.mouse.move(640, 420); await p.waitForTimeout(400);
  check('arrows shown when the mouse moves', (await op()) > 0.5);
  const before = await p.$eval('.reader-scroll', (e) => e.scrollTop); await p.click('.page-arrow.next'); await p.waitForTimeout(900);
  const after = await p.$eval('.reader-scroll', (e) => e.scrollTop); check('next arrow turns the page', after > before, { before, after });
  // A picture: a single click does not open it, a double-click does.
  const img = p.locator('.reader-flow img').first();
  if (await img.count()) {
    await img.scrollIntoViewIfNeeded(); await img.click(); await p.waitForTimeout(500); const one = !!(await p.$('.gallery-view, .lightbox, .gallery'));
    await img.dblclick(); await p.waitForTimeout(700); const two = !!(await p.$('.gallery-view, .lightbox, .gallery, .view.gallery'));
    check('a picture: no on one click, opened on a double-click', !one && two, { one, two });
    await p.keyboard.press('Escape'); await p.waitForTimeout(400);
  } else check('a picture in the book', false);
  // Contents docked: no scrim, the text narrowed, open after a jump.
  await p.click('.float-toolbar .icon-btn[aria-label="Contents"]'); await p.waitForSelector('.panel.open'); await p.waitForTimeout(300);
  const d = await p.evaluate(() => ({ docked: document.querySelector('.panel').classList.contains('docked'), scrim: !document.querySelector('.reader-view > .scrim')?.hidden, readerR: document.querySelector('.reader').getBoundingClientRect().right, panelL: document.querySelector('.panel').getBoundingClientRect().left }));
  check('contents docked beside the page', d.docked && !d.scrim && d.readerR <= d.panelL + 1, d);
  await p.locator('.panel .toc-list button').nth(4).click(); await p.waitForTimeout(800);
  check('still open after a jump', await p.$eval('.panel', (e) => e.classList.contains('open')));
  await openBook('Alice'); await p.waitForTimeout(800);
  check('opened again with the next book', await p.$eval('.panel', (e) => e.classList.contains('open') && e.classList.contains('docked')));
  await p.click('.panel .panel-head .icon-btn'); await p.waitForTimeout(300);
  await openBook('Alice'); await p.waitForTimeout(1000);
  check('closed: not opened again', !(await p.$eval('.panel', (e) => e.classList.contains('open'))));
  await ctx.close();
  // A phone: the floating toolbar at the bottom, no names, no arrows.
  const c2 = await br.newContext({ viewport: { width: 412, height: 900 }, isMobile: true, hasTouch: true }); const q = await c2.newPage(); q.on('pageerror', (e) => errors.push(e.message));
  await q.addInitScript(() => localStorage.setItem('kr.lang', 'en')); await q.goto(base); await q.waitForSelector('.empty .btn:not(.primary)'); await q.click('.empty .btn:not(.primary)'); await q.waitForSelector('.book-card');
  await q.locator('.book-card').first().click(); await q.waitForTimeout(1500); await q.click('.fab.book-resume'); await q.waitForSelector('.float-toolbar'); await q.waitForTimeout(1200);
  const ph = await q.evaluate(() => ({ bottom: innerHeight - document.querySelector('.float-toolbar').getBoundingClientRect().bottom, labels: [...document.querySelectorAll('.float-toolbar .tb-label')].filter((x) => x.offsetParent).length, arrows: [...document.querySelectorAll('.page-arrow')].filter((x) => x.offsetParent).length }));
  check('phone: the floating toolbar, as it was', ph.bottom < 60 && !ph.labels && !ph.arrows, ph);
  await c2.close(); await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
