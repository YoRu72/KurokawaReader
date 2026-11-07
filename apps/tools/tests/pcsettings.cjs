// Settings on a computer: one section at a time, picked from the side list (and kept in the address); a search
// looks through every section; the phone's own rows (Android's notification access, the old storage move) are not
// shown on a computer; the Player has one section, not «Player» and «Player settings». A phone keeps folding cards.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch(); const errors = [];
  const check = (what, ok, x) => { console.log(ok ? 'ok  ' : 'FAIL', what, ok ? '' : JSON.stringify(x ?? '')); if (!ok) errors.push(what); };
  const init = (lang) => { localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.pc.starter', '1'); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['player'] }));
    window.kurokawaTools = new Proxy({ platform: 'desktop', available: true, os: 'win32', list: async () => [], onTasks: () => () => {} }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) }); };
  for (const lang of ['en', 'ar']) {
    const ctx = await br.newContext({ viewport: { width: 1366, height: 768 } }); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
    await ctx.route(/raw\.githubusercontent\.com/, (r) => r.fulfill({ status: 404 }));
    await p.addInitScript(init, lang); await p.goto(base + '#/settings'); await p.waitForSelector('.settings-nav .chip'); await p.waitForTimeout(300);
    const shown = () => p.$$eval('.settings-body > .card:not([hidden])', (e) => e.map((c) => c.id));
    let v = await shown(); check(`${lang}: one section shown`, v.length === 1, v);
    await p.click('.settings-nav .chip[data-sec="downloads"]'); await p.waitForTimeout(200); v = await shown();
    check(`${lang}: the side list picks it`, v.length === 1 && v[0] === 'downloads' && /#\/settings\/downloads$/.test(p.url()), { v, url: p.url() });
    check(`${lang}: picked one lit`, (await p.getAttribute('.settings-nav .chip[data-sec="downloads"]', 'aria-current')) === 'page');
    const txt = await p.$eval('.settings-body', (e) => e.innerText);
    check(`${lang}: no phone-only rows`, !/Android hides|أندرويد يخفيها|Download\/Kurokawa\b.*Move/.test(txt) && !(await p.$('.settings-body .card[id="downloads"] button:has-text("Move to")')));
    const navs = await p.$$eval('.settings-nav .chip', (e) => e.map((x) => x.textContent.trim()));
    check(`${lang}: one Player section`, !navs.some((x) => /Player settings|إعدادات المشغّل/.test(x)), navs);
    await p.fill('.settings-search', lang === 'ar' ? 'السمة' : 'theme'); await p.waitForTimeout(200); v = await shown();
    check(`${lang}: search looks through every section`, v.length >= 1 && !v.includes('downloads') && !(await p.$('.settings-body.pc-one')), v);
    await p.fill('.settings-search', ''); await p.waitForTimeout(150); v = await shown(); check(`${lang}: cleared: back to the section`, v.length === 1 && v[0] === 'downloads', v);
    // A row's choice: on its line, the control at the end, not a bar across the page.
    await p.click('.settings-nav .chip[data-sec="general"]'); await p.waitForTimeout(200);
    const r = await p.evaluate(() => { const row = [...document.querySelectorAll('#general .row')].find((x) => x.querySelector('.pick-btn')); const a = row.querySelector('span').getBoundingClientRect(), b = row.querySelector('.pick-btn').getBoundingClientRect(); return { same: Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) < 12, w: b.width, rw: row.getBoundingClientRect().width }; });
    check(`${lang}: a choice sits at the row's end`, r.same && r.w < r.rw / 2, r);
    await ctx.close();
  }
  // A phone: the folding list as before.
  const ctx = await br.newContext({ viewport: { width: 412, height: 900 }, isMobile: true, hasTouch: true }); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await ctx.route(/raw\.githubusercontent\.com/, (r) => r.fulfill({ status: 404 }));
  await p.addInitScript(() => localStorage.setItem('kr.lang', 'en')); await p.goto(base + '#/settings'); await p.waitForSelector('.settings-body > .card'); await p.waitForTimeout(300);
  const n = await p.$$eval('.settings-body > .card:not([hidden])', (e) => e.length); check('phone: every section listed', n > 4, n);
  await ctx.close(); await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
