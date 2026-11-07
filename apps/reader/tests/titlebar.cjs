// The window's own bar on a computer (both apps run this test, each with its own page): the icon and the name on a
// strip at the top in the theme's colours, told to the system's buttons; the page below it; gone in full screen; no
// bar in a browser. Run: node tests/titlebar.cjs [tools|reader]
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const APP = process.argv[2] || (__dirname.includes('/reader/') ? 'reader' : 'tools');
const DIST = path.join(__dirname, '..', '..', APP, 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch(); const errors = [];
  const check = (what, ok, x) => { console.log(ok ? 'ok  ' : 'FAIL', `${APP}: ${what}`, ok ? '' : JSON.stringify(x ?? '')); if (!ok) errors.push(what); };
  const ctx = await br.newContext({ viewport: { width: 1366, height: 768 } }); await ctx.route(/raw\.githubusercontent\.com/, (r) => r.fulfill({ status: 404 }));
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript((app) => {
    localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.pc.starter', '1'); window.__tb = []; let cb = null;
    const tb = { titleBar: async (o) => { if (o) window.__tb.push(o); return { platform: 'win32', height: 38, fullscreen: false }; }, onTitleBarState: (f) => { cb = f; return () => {}; } };
    window.__full = (on) => cb && cb({ fullscreen: on });
    if (app === 'tools') window.kurokawaTools = new Proxy({ platform: 'desktop', available: true, os: 'win32', list: async () => [], onTasks: () => () => {}, ...tb }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) });
    else window.kurokawaDesktop = { onOpenFile: () => {}, setZoom: () => {}, ...tb };
  }, APP);
  await p.goto(base); await p.waitForSelector('.win-titlebar'); await p.waitForTimeout(800);
  const g = await p.evaluate(() => { const b = document.querySelector('.win-titlebar').getBoundingClientRect(); const rail = document.querySelector('.rail, .pc-rail, nav.rail, .side-rail'); return { top: b.top, h: b.height, name: document.querySelector('.win-title').textContent, logo: !!document.querySelector('.win-titlebar img[data-brand]'), railTop: rail ? rail.getBoundingClientRect().top : -1, bodyTop: document.body.getBoundingClientRect().top }; });
  check('a bar of its own at the top, with the icon and the name', g.top === 0 && g.h === 38 && /Kurokawa/i.test(g.name) && g.logo, g);
  check('the page below it', g.bodyTop === 38 && (g.railTop < 0 || g.railTop >= 38), g);
  const sent = await p.evaluate(() => window.__tb.at(-1)); check('the system\'s buttons told the theme\'s colours', !!sent && /^#[0-9a-f]{6}$/.test(sent.color) && /^#[0-9a-f]{6}$/.test(sent.symbol), sent);
  await p.evaluate(() => window.__full(true)); await p.waitForTimeout(100);
  check('gone in full screen', await p.evaluate(() => getComputedStyle(document.querySelector('.win-titlebar')).display === 'none' && document.body.getBoundingClientRect().top === 0));
  await p.evaluate(() => window.__full(false));
  await ctx.close();
  const c2 = await br.newContext({ viewport: { width: 1366, height: 768 } }); await c2.route(/raw\.githubusercontent\.com/, (r) => r.fulfill({ status: 404 })); const q = await c2.newPage(); q.on('pageerror', (e) => errors.push(e.message));
  await q.addInitScript(() => localStorage.setItem('kr.lang', 'en')); await q.goto(base); await q.waitForTimeout(1500);
  check('no bar in a browser', !(await q.$('.win-titlebar')) && (await q.evaluate(() => document.body.getBoundingClientRect().top)) === 0);
  await c2.close(); await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
