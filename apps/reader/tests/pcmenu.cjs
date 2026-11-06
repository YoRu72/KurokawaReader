// A computer's library: right-clicking a book opens its menu at the pointer (the selection bar's actions for that one
// book) instead of choosing it; a click outside closes it and leaves nothing chosen; Browse is in the sidebar and lit
// on its page; the library's tools are one row sized for a mouse.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.epub': 'application/epub+zip', '.png': 'image/png', '.jpg': 'image/jpeg' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch(); const errors = [];
  const check = (what, ok, x) => { console.log(ok ? 'ok  ' : 'FAIL', what, ok ? '' : JSON.stringify(x ?? '')); if (!ok) errors.push(what); };
  for (const lang of ['en', 'ar']) {
    const ctx = await br.newContext({ viewport: { width: 1366, height: 768 } }); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
    await p.addInitScript((l) => localStorage.setItem('kr.lang', l), lang);
    await p.goto(base); await p.waitForSelector('.empty .btn:not(.primary)'); await p.click('.empty .btn:not(.primary)'); await p.waitForSelector('.book-card'); await p.waitForTimeout(800);
    const tools = await p.evaluate(() => { const r = [...document.querySelectorAll('.library-tools > :not([hidden])')].map((e) => e.getBoundingClientRect()); return { rows: new Set(r.map((x) => Math.round(x.top))).size, maxH: Math.max(...r.map((x) => x.height)) }; });
    check(`${lang}: the tools are one row, 40 px high`, tools.rows === 1 && tools.maxH <= 41, tools);
    const b = await p.locator('.book-card').first().boundingBox(); const x = b.x + b.width / 2, y = b.y + 40;
    await p.mouse.click(x, y, { button: 'right' }); await p.waitForSelector('.sheet.as-menu'); await p.waitForTimeout(150);
    const m = await p.evaluate(() => { const r = document.querySelector('.sheet.as-menu').getBoundingClientRect(); return { x: r.left, r: r.right, y: r.top, b: r.bottom, fits: r.top >= 0 && r.bottom <= innerHeight, rows: document.querySelectorAll('.sheet.as-menu .dest-row').length, del: !!document.querySelector('.sheet.as-menu .sheet-actions .danger'), bar: !document.querySelector('.sel-bar, .selection-bar')?.hidden && !!document.querySelector('.library-view.selecting') }; });
    check(`${lang}: right-click opens the book's menu at the pointer, on the screen`, (lang === 'ar' ? Math.abs(m.r - x) < 4 : Math.abs(m.x - x) < 4) && (Math.abs(m.y - y) < 4 || (m.fits && m.b >= y - 4)) && m.rows >= 8 && m.del, m);
    check(`${lang}: not choosing`, !m.bar, m);
    await p.mouse.click(700, 740); await p.waitForTimeout(200);
    const after = await p.evaluate(() => ({ menu: !!document.querySelector('.sheet'), picked: document.querySelectorAll('.book-card[aria-selected="true"]').length }));
    check(`${lang}: a click outside closes it, nothing chosen`, !after.menu && !after.picked, after);
    await p.click('.rail-item[data-dest="sources"]'); await p.waitForTimeout(600);
    check(`${lang}: Browse in the sidebar, lit on its page`, /#\/sources/.test(p.url()) && (await p.getAttribute('.rail-item[data-dest="sources"]', 'aria-current')) === 'page');
    await ctx.close();
  }
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
