// The computer's layout: a sidebar with each place's name (folded to icons by its button, remembered), a page's
// title and body on the same edge, the settings' chip rows wrapping (a mouse cannot swipe them), add-on tabs by name.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch(); const errors = [];
  const check = (what, ok, x) => { console.log(ok ? 'ok  ' : 'FAIL', what, ok ? '' : JSON.stringify(x ?? '')); if (!ok) errors.push(what); };
  for (const lang of ['en', 'ar']) {
    const ctx = await br.newContext({ viewport: { width: 1366, height: 768 } }); const p = await ctx.newPage(); p.setDefaultTimeout(6000); p.on('pageerror', (e) => errors.push(e.message));
    await ctx.route(/raw\.githubusercontent|graphql|cinemeta/, (r) => r.abort());
    await p.addInitScript((l) => { localStorage.setItem('kr.lang', l); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['anime', 'tv', 'player', 'files', 'video'], settingsLayout: 'tabs' })); window.kurokawaTools = { platform: 'desktop', available: true, os: 'win32', ready: async () => ({}), list: async () => [], on: () => () => {}, onTasks: () => () => {}, freeSpace: async () => 5e11 }; }, lang);
    await p.goto(base + '#/'); await p.waitForSelector('.nav-rail .rail-item');
    const rail = await p.evaluate(() => { const r = document.querySelector('.nav-rail').getBoundingClientRect(); const lab = document.querySelector('.rail-item[data-dest="search"] .rail-label'); return { w: Math.round(r.width), label: lab && getComputedStyle(lab).display !== 'none' ? lab.textContent : null, name: !!document.querySelector('.rail-name')?.offsetWidth }; });
    check(`${lang}: a sidebar with the places' names`, rail.w >= 220 && !!rail.label && rail.name, rail);
    const edge = async () => p.evaluate(() => { const rtl = document.documentElement.dir === 'rtl'; const v = document.querySelector('.view'); const t = v.querySelector('.topbar .title > span').getBoundingClientRect(); const first = v.querySelector('.body > :not([hidden]):not(.empty)') || v.querySelector('.body'); const b = first.getBoundingClientRect(); const cs = getComputedStyle(v.querySelector('.body')); const bodyEdge = rtl ? v.querySelector('.body').getBoundingClientRect().right - parseFloat(cs.paddingRight) : v.querySelector('.body').getBoundingClientRect().left + parseFloat(cs.paddingLeft); return { title: Math.round(rtl ? t.right : t.left), body: Math.round(bodyEdge) }; });
    const e1 = await edge(); check(`${lang}: the title on the body's edge`, Math.abs(e1.title - e1.body) <= 2, e1);
    await p.click('.rail-fold'); await p.waitForTimeout(200);
    const folded = await p.evaluate(() => ({ w: Math.round(document.querySelector('.nav-rail').getBoundingClientRect().width), label: getComputedStyle(document.querySelector('.rail-label')).display }));
    await p.reload(); await p.waitForSelector('.nav-rail .rail-item');
    const kept = await p.evaluate(() => document.documentElement.classList.contains('rail-mini'));
    check(`${lang}: folded to its icons, and kept so`, folded.w <= 90 && folded.label === 'none' && kept, { folded, kept });
    await p.click('.rail-fold'); await p.goto(base + '#/settings'); await p.waitForSelector('.settings-nav .chip');
    const st = await p.evaluate(() => { const nav = document.querySelector('.settings-nav'); const tabs = [...document.querySelectorAll('.settings-tabs .chip')].map((x) => x.textContent.trim()); return { overflow: nav.scrollWidth > nav.clientWidth + 2, tabs }; });
    check(`${lang}: the settings' sections all in view (no sideways scrolling)`, !st.overflow, st);
    check(`${lang}: add-on tabs by name, not by id`, !st.tabs.some((x) => /^(anime|tv|player|video|files)$/.test(x)), st.tabs);
    await ctx.close();
  }
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
