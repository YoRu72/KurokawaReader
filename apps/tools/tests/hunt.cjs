// The bug hunt: every page of the app opened and left, forty times over, while listeners, timers, observers and the
// DOM are counted — a page that leaves something behind each time it is left is a leak and fails here. Page errors
// and console errors fail too. Run: NODE_PATH=$(npm root -g) node tests/hunt.cjs   (KT_HUNT_ROUNDS=… for more rounds)
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.join(__dirname, '..', 'dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (what, cond, x) => { console.log((cond ? 'ok   ' : 'FAIL ') + what + (cond || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!cond) fails++; };
const ROUNDS = Number(process.env.KT_HUNT_ROUNDS || 40);
// Every place of the app a reader can reach (the add-ons all on, the desktop bridge absent, so the pages draw their own fallbacks).
const ROUTES = ['/', '/?f=active', '/add', '/search?q=test', '/addons', '/subs?q=naruto', '/anime', '/anime?tab=season', '/anime?tab=schedule', '/tv', '/tv?tab=watchlist', '/videos', '/videos?tab=folders', '/files', '/files?c=recent', '/screen', '/settings', '/settings/general', '/settings/downloads', '/settings/addons', '/settings/updates', '/settings/about'];
(async () => {
  await new Promise((r) => server.listen(5483, r));
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 412, height: 900 }, deviceScaleFactor: 1 });
  const errors = []; p.on('pageerror', (e) => errors.push(String(e))); p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|CORS policy/.test(m.text())) errors.push(m.text()); });
  await p.addInitScript(() => {
    // The counters: listeners on window/document, timers alive, observers alive.
    const c = (window.__hunt = { listeners: 0, intervals: 0, timeouts: 0, observers: 0, raf: 0 });
    for (const target of [window, document]) {
      const add = target.addEventListener.bind(target), rem = target.removeEventListener.bind(target);
      target.addEventListener = (t, f, o) => { c.listeners++; return add(t, f, o); };
      target.removeEventListener = (t, f, o) => { c.listeners--; return rem(t, f, o); };
    }
    const si = window.setInterval.bind(window), ci = window.clearInterval.bind(window); const live = new Set();
    window.setInterval = (f, ms, ...a) => { const id = si(f, ms, ...a); live.add(id); c.intervals = live.size; return id; };
    window.clearInterval = (id) => { live.delete(id); c.intervals = live.size; return ci(id); };
    for (const K of ['IntersectionObserver', 'MutationObserver', 'ResizeObserver']) {
      const Orig = window[K]; if (!Orig) continue;
      window[K] = class extends Orig { constructor(...a) { super(...a); c.observers++; } disconnect() { c.observers--; return super.disconnect(); } };
    }
    localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['anime', 'tv', 'videos', 'subtitles', 'player', 'files', 'archives', 'screen'], autoUpdateCheck: false }));
  });
  await p.goto('http://localhost:5483/#/'); await p.waitForSelector('.view'); await p.waitForTimeout(600);
  const snap = async () => p.evaluate(() => ({ ...window.__hunt, nodes: document.getElementsByTagName('*').length, views: document.querySelectorAll('.view').length, sheets: document.querySelectorAll('.sheet, .sheet-scrim').length }));
  const warm = async () => { for (const r of ROUTES) { await p.goto('http://localhost:5483/#' + r); await p.waitForTimeout(120); } await p.goto('http://localhost:5483/#/'); await p.waitForTimeout(300); };
  await warm(); await warm(); const before = await snap();
  for (let i = 0; i < ROUNDS; i++) { await warm(); }
  await p.evaluate(() => new Promise((r) => setTimeout(r, 500)));
  const after = await snap();
  const grew = (k, allow) => after[k] - before[k] > allow;
  ok(`listeners on window/document do not pile up (${before.listeners} → ${after.listeners})`, !grew('listeners', ROUNDS), after);
  ok(`intervals do not pile up (${before.intervals} → ${after.intervals})`, !grew('intervals', 2), after);
  ok(`observers do not pile up (${before.observers} → ${after.observers})`, !grew('observers', ROUNDS), after);
  ok(`the DOM does not grow (${before.nodes} → ${after.nodes})`, after.nodes <= before.nodes * 1.15 + 50, after);
  ok('one view at a time, no sheets left', after.views <= 2 && after.sheets === 0, after);
  // Sheets: opened and closed by the top bar's buttons on each page, the scrim cleaning up after each.
  let opened = 0;
  for (const r of ROUTES) {
    await p.goto('http://localhost:5483/#' + r); await p.waitForTimeout(150);
    const buttons = await p.$$('.topbar button, .fab');
    for (let i = 0; i < Math.min(buttons.length, 6); i++) {
      const bs = await p.$$('.topbar button, .fab'); if (!bs[i]) break;
      try { await bs[i].click({ timeout: 800 }); } catch { continue; }
      await p.waitForTimeout(120); const sheet = await p.$('.sheet'); if (sheet) { opened++; await p.keyboard.press('Escape'); await p.waitForTimeout(80); if (await p.$('.sheet')) { const x = await p.$('.sheet-head button'); if (x) await x.click().catch(() => undefined); } }
      if (!(await p.url()).includes('#' + r)) { await p.goto('http://localhost:5483/#' + r); await p.waitForTimeout(120); }
    }
  }
  ok(`sheets opened and closed from the pages (${opened})`, opened >= 6 && (await p.$$('.sheet')).length === 0);
  ok('no page errors', !errors.length); if (errors.length) console.log([...new Set(errors)].slice(0, 12));
  await b.close(); server.close(); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
