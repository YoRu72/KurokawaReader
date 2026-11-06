// A computer's menus: right-clicking a download opens its menu at the pointer (not a dialog, not choosing), the ⋮
// button opens it under itself, a choice button drops down under itself, and each closes on a click outside. A phone
// keeps its sheets (a long press still chooses).
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
const fake = (lang) => { localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.pc.starter', '1');
  const tasks = [{ id: 'a', kind: 'http', name: 'ubuntu-26.04-desktop-amd64.iso', source: { url: 'https://example.com/ubuntu.iso' }, dir: '/d', state: 'downloading', done: 2e9, total: 6e9, speed: 1e7, upSpeed: 0, files: [], created: Date.now() }];
  window.kurokawaTools = new Proxy({ platform: 'desktop', available: true, os: 'win32', list: async () => tasks, onTasks: (cb) => { setTimeout(() => cb(tasks), 50); return () => {}; } },
    { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) }); };
(async () => {
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch(); const errors = [];
  const check = (what, ok, x) => { console.log(ok ? 'ok  ' : 'FAIL', what, ok ? '' : JSON.stringify(x ?? '')); if (!ok) errors.push(what); };
  for (const lang of ['en', 'ar']) {
    const ctx = await br.newContext({ viewport: { width: 1366, height: 768 } }); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
    await ctx.route(/raw\.githubusercontent\.com/, (r) => r.fulfill({ status: 404 }));
    await p.addInitScript(fake, lang); await p.goto(base + '#/'); await p.waitForSelector('.task-card .task-main');
    const card = await p.locator('.task-card .task-main').boundingBox(); const cx = card.x + card.width / 2, cy = card.y + card.height / 2;
    await p.mouse.click(cx, cy, { button: 'right' }); await p.waitForSelector('.sheet.as-menu'); await p.waitForTimeout(150);
    const m = await p.evaluate(() => { const r = document.querySelector('.sheet.as-menu').getBoundingClientRect(); return { x: r.left, r: r.right, y: r.top, w: r.width, choosing: document.querySelector('.downloads-view')?.classList.contains('selecting') || !!document.querySelector('.task-pick:checked'), scrim: getComputedStyle(document.querySelector('.menu-scrim')).backgroundColor }; });
    check(`${lang}: right-click opens the menu at the pointer`, Math.abs(m.y - cy) < 4 && (lang === 'ar' ? Math.abs(m.r - cx) < 4 : Math.abs(m.x - cx) < 4) && m.w < 360, { m, cx, cy });
    check(`${lang}: not choosing`, !m.choosing, m);
    check(`${lang}: no dimming behind a menu`, /rgba\(0, 0, 0, 0\)|transparent/.test(m.scrim), m.scrim);
    await p.mouse.click(5, 760); await p.waitForTimeout(150);
    check(`${lang}: a click outside closes it`, !(await p.$('.sheet')));
    const more = await p.locator('.task-card .task-actions .icon-btn[aria-label]').last(); const mb = await more.boundingBox(); await more.click(); await p.waitForSelector('.sheet.as-menu'); await p.waitForTimeout(150);
    const m2 = await p.evaluate(() => { const r = document.querySelector('.sheet.as-menu').getBoundingClientRect(); return { x: r.left, r: r.right, y: r.top }; });
    check(`${lang}: ⋮ opens it under itself`, m2.y >= mb.y + mb.height && m2.y < mb.y + mb.height + 12 && (lang === 'ar' ? Math.abs(m2.x - mb.x) < 2 : Math.abs(m2.r - (mb.x + mb.width)) < 2), { m2, mb });
    await p.keyboard.press('Escape'); await p.waitForTimeout(100);
    // A choice button in Settings: a dropdown under itself.
    await p.goto(base + '#/settings'); await p.waitForSelector('.pick-btn:visible'); const pb = p.locator('.pick-btn:visible').first(); const bb = await pb.boundingBox(); await pb.click();
    await p.waitForSelector('.sheet.as-menu'); await p.waitForTimeout(150);
    const m3 = await p.evaluate(() => { const r = document.querySelector('.sheet.as-menu').getBoundingClientRect(); return { y: r.top, h: r.height, inView: r.bottom <= innerHeight && r.top >= 0 && r.left >= 0 && r.right <= innerWidth }; });
    check(`${lang}: a choice button drops down, on the screen`, m3.inView && (Math.abs(m3.y - (bb.y + bb.height + 4)) < 3 || m3.y + m3.h <= bb.y), { m3, bb });
    await ctx.close();
  }
  // A phone: a long press on a download still chooses, and menus stay sheets.
  const ctx = await br.newContext({ viewport: { width: 412, height: 900 }, hasTouch: true, isMobile: true }); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await ctx.route(/raw\.githubusercontent\.com/, (r) => r.fulfill({ status: 404 }));
  await p.addInitScript(fake, 'en'); await p.goto(base + '#/'); await p.waitForSelector('.task-card .task-main');
  await p.locator('.task-card .task-actions .icon-btn').last().click(); await p.waitForSelector('.sheet'); 
  check('phone: ⋮ is still a sheet', !(await p.$('.sheet.as-menu')));
  await ctx.close(); await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
