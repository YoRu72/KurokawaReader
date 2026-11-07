// The computer's layout: a sidebar with each place's name (folded to icons by its button, remembered), and the
// interface's size — the desktop app's zoom, a little larger to start with, set from Appearance.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch(); const errors = [];
  const check = (what, ok, x) => { console.log(ok ? 'ok  ' : 'FAIL', what, ok ? '' : JSON.stringify(x ?? '')); if (!ok) errors.push(what); };
  for (const lang of ['en', 'ar']) {
    const ctx = await br.newContext({ viewport: { width: 1366, height: 768 } }); const p = await ctx.newPage(); p.setDefaultTimeout(8000); p.on('pageerror', (e) => errors.push(e.message));
    await p.addInitScript((l) => { localStorage.setItem('kr.lang', l); window.__zoom = []; window.kurokawaDesktop = new Proxy({ setZoom: (f) => window.__zoom.push(f) }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : () => undefined) }); }, lang);
    await p.goto(base + '#/'); await p.waitForSelector('.nav-rail .rail-item');
    const rail = await p.evaluate(() => { const r = document.querySelector('.nav-rail').getBoundingClientRect(); const lab = document.querySelector('.rail-item[data-dest="notes"] .rail-label'); return { w: Math.round(r.width), label: lab && getComputedStyle(lab).display !== 'none' ? lab.textContent : null, fab: getComputedStyle(document.querySelector('.rail-fab-label')).display !== 'none' }; });
    check(`${lang}: a sidebar with the places' names and «Import books»`, rail.w >= 220 && !!rail.label && rail.fab, rail);
    check(`${lang}: the interface a little larger on a computer`, (await p.evaluate(() => window.__zoom.at(-1))) === 1.1, await p.evaluate(() => window.__zoom));
    await p.click('.rail-fold'); await p.reload(); await p.waitForSelector('.nav-rail .rail-item');
    check(`${lang}: folded to its icons, and kept so`, await p.evaluate(() => document.documentElement.classList.contains('rail-mini') && document.querySelector('.nav-rail').getBoundingClientRect().width <= 90));
    await p.click('.rail-fold');
    await p.goto(base + '#/settings'); await p.waitForTimeout(600);
    // (A computer shows one section at a time: Appearance picked from the side list.)
    await p.locator('.settings-nav .chip', { hasText: /Appearance|المظهر/ }).first().click(); await p.waitForTimeout(200);
    check(`${lang}: one section shown at a time`, (await p.$$eval('.settings-body > .card:not([hidden])', (e) => e.length)) === 1);
    const btn = p.locator('.segmented button', { hasText: /^(120|١٢٠)%$/ }).first();
    if (!(await btn.count())) console.log('segmented:', await p.$$eval('.segmented button', (e) => e.slice(0, 12).map((x) => x.textContent)));
    const has = await btn.count(); if (has) await btn.click({ force: true });
    check(`${lang}: Appearance sets the interface size`, has > 0 && (await p.evaluate(() => window.__zoom.at(-1))) === 1.2, await p.evaluate(() => window.__zoom.slice(-3)));
    await ctx.close();
  }
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
