// node tests/swipe.cjs: download cards swiped on a phone — to the right a downloading one is paused, a paused one
// resumed; to the left the removal is asked; a short swipe does nothing; a vertical drag scrolls and does nothing.
const { chromium, devices } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
(async () => {
  const web = http.createServer((q, r) => { let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); }).listen(0);
  const b = await chromium.launch(); const ctx = await b.newContext({ ...devices['Pixel 7'] }); const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(() => {
    window.__calls = []; const now = Date.now();
    const tasks = [
      { id: 'a', kind: 'http', name: 'one.iso', source: { url: 'https://x/1' }, dir: '/d', state: 'downloading', done: 1e8, total: 1e9, downSpeed: 1e6, upSpeed: 0, files: [], addedAt: now, engine: 'native' },
      { id: 'b', kind: 'http', name: 'two.iso', source: { url: 'https://x/2' }, dir: '/d', state: 'paused', done: 1e8, total: 1e9, downSpeed: 0, upSpeed: 0, files: [], addedAt: now - 1000, engine: 'native' },
    ];
    const plugin = new Proxy({ addListener: async () => ({ remove() {} }), list: async () => ({ tasks }), pause: async (o) => { window.__calls.push(['pause', o.id]); }, resume: async (o) => { window.__calls.push(['resume', o.id]); }, defaultDir: async () => ({ dir: '/d' }) }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
  });
  await p.goto(`http://127.0.0.1:${web.address().port}/#/`); await p.waitForSelector('.task-card[data-id="b"]');
  const swipe = async (id, dx, dy = 0) => { const r = await p.$eval(`.task-card[data-id="${id}"]`, (e) => { const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
    await p.evaluate(({ id, r, dx, dy }) => { const el = document.querySelector(`.task-card[data-id="${id}"]`); const ev = (type, x, y) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: 'touch', clientX: x, clientY: y, isPrimary: true }));
      ev('pointerdown', r.x, r.y); for (let i = 1; i <= 8; i++) ev('pointermove', r.x + (dx * i) / 8, r.y + (dy * i) / 8); ev('pointerup', r.x + dx, r.y + dy); }, { id, r, dx, dy }); await p.waitForTimeout(300); };
  await swipe('a', 40); ok('a short swipe does nothing', !(await p.evaluate(() => window.__calls.length)));
  await swipe('a', 20, 200); ok('a vertical drag does nothing', !(await p.evaluate(() => window.__calls.length)));
  await swipe('a', 260); ok('swiped right: a download paused', JSON.stringify(await p.evaluate(() => window.__calls)) === '[["pause","a"]]');
  await swipe('b', 260); ok('swiped right: a paused one resumed', JSON.stringify(await p.evaluate(() => window.__calls.slice(1))) === '[["resume","b"]]');
  ok('the card back in place', await p.$eval('.task-card[data-id="b"]', (e) => !e.classList.contains('swiping') && !e.querySelector('.swipe-under')));
  await swipe('b', -260); await p.waitForTimeout(300);
  ok('swiped left: the removal asked', !!(await p.$('.sheet')) && /Remove|two\.iso/i.test(await p.$eval('.sheet', (e) => e.textContent)));
  ok('no page errors', !errors.length, errors);
  await b.close(); web.close(); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})();
