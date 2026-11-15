// The player's full screen and the phone's turn («Rotate for full screen», phones only; the Android plugin faked, its
// orientation calls recorded): turned sideways while playing → the full screen, on the back stack; Back leaves it
// first and the player stays; still sideways, it does not come back until the phone was upright; upright → out of it.
// The button: a wide video turns the screen to landscape (either side: the phone's sensor), a tall one to portrait,
// given back when the full screen ends. The setting off: turning does nothing. In Settings the switch is on a phone's
// player section, on by default, and absent on a computer. KT_SHOTS=<dir>: screenshots of both settings.
// Run: NODE_PATH=$(npm root -g) node tests/playerrotate.cjs
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const SHOTS = process.env.KT_SHOTS;
const PORTRAIT = { width: 412, height: 860 }, LANDSCAPE = { width: 860, height: 412 };

async function phone(br, port, lang) {
  const ctx = await br.newContext({ viewport: PORTRAIT, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 404 }));
  const p = await ctx.newPage(); const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript((lang) => {
    localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['player'], playerWith: 'app', playerEngine: 'web' }));
    window.__turns = [];
    const api = { addListener: () => ({ remove() {} }), list: async () => ({ tasks: [] }), orientation: async (o) => { window.__turns.push(o.to); }, systemBars: async () => {}, mpvAvailable: async () => ({ available: false }) };
    const App = { addListener: (ev, fn) => { if (ev === 'backButton') window.__back = fn; return { remove() {} }; }, minimizeApp: () => {}, exitApp: () => {} };
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) }), App }, PluginHeaders: [] };
  }, lang);
  const full = () => p.evaluate(() => { const r = document.querySelector('.kt-player'); return !!r && (document.fullscreenElement === r || r.classList.contains('kt-full')); });
  const top = () => p.evaluate(() => { const l = window.__ktBack.layers.filter((x) => !x.on || x.on()); return l[l.length - 1]?.kind; });
  const turn = async (v) => { await p.setViewportSize(v); await p.waitForTimeout(400); };
  const open = async (w, hh) => { await p.evaluate(() => window.dispatchEvent(new CustomEvent('kt:play', { detail: { url: 'http://127.0.0.1:1/none.mp4', name: 'Test video' } }))); await p.waitForSelector('.kt-player'); await p.waitForTimeout(300); await p.evaluate(([w, hh]) => { const v = document.querySelector('.kt-player video'); Object.defineProperty(v, 'videoWidth', { configurable: true, get: () => w }); Object.defineProperty(v, 'videoHeight', { configurable: true, get: () => hh }); }, [w, hh]); };
  await p.goto(`http://127.0.0.1:${port}/#/`); await p.waitForFunction(() => !!window.__ktBack); await p.waitForTimeout(300);
  if (lang === 'en') {
    await open(1920, 1080);
    ok('opened upright: not in full screen', !(await full()));
    await turn(LANDSCAPE); ok('turned sideways while playing: full screen', await full());
    ok('the full screen is on the back stack, above the player', (await top()) === 'fullscreen');
    await p.evaluate(() => window.__back()); await p.waitForTimeout(400);
    ok('Back: out of the full screen first, the player stays', !(await full()) && !!(await p.$('.kt-player')));
    await p.waitForTimeout(300); ok('still sideways: the full screen does not come back by itself', !(await full()));
    await turn(PORTRAIT); await turn(LANDSCAPE); ok('upright, then sideways again: full screen', await full());
    await turn(PORTRAIT); ok('turned upright: out of the full screen', !(await full()));
    await p.evaluate(() => { window.__turns.length = 0; });
    await p.evaluate(() => document.querySelector('.kt-player .kt-bottom button[data-icon="fullscreen"]').click()); await p.waitForTimeout(400);
    ok('the button, a wide video: full screen, the screen turned to landscape (either side)', (await full()) && (await p.evaluate(() => window.__turns.includes('landscape'))), await p.evaluate(() => window.__turns));
    await p.evaluate(() => document.querySelector('.kt-player .kt-bottom button[data-icon="fullscreen"]').click()); await p.waitForTimeout(400);
    ok('out again: the turn given back to the phone', !(await full()) && (await p.evaluate(() => window.__turns[window.__turns.length - 1])) === 'auto', await p.evaluate(() => window.__turns));
    await p.evaluate(() => window.__back()); await p.waitForTimeout(300);
    await open(1080, 1920); await p.evaluate(() => { window.__turns.length = 0; });
    await p.evaluate(() => document.querySelector('.kt-player .kt-bottom button[data-icon="fullscreen"]').click()); await p.waitForTimeout(400);
    ok('the button, a tall video: the screen kept to portrait', (await full()) && (await p.evaluate(() => window.__turns.includes('portrait') && !window.__turns.includes('landscape'))), await p.evaluate(() => window.__turns));
    await p.evaluate(() => window.__back()); await p.waitForTimeout(300); ok('Back from it: out of the full screen, the player stays', !(await full()) && !!(await p.$('.kt-player')));
    await p.evaluate(() => window.__back()); await p.waitForTimeout(300); ok('Back again: the player closed', !(await p.$('.kt-player')));
    // The setting off.
    await p.evaluate(() => { const k = JSON.parse(localStorage.getItem('kt.player') || '{}'); k.autoRotateFull = false; localStorage.setItem('kt.player', JSON.stringify(k)); });
    await p.reload(); await p.waitForFunction(() => !!window.__ktBack); await p.waitForTimeout(300);
    await open(1920, 1080); await turn(LANDSCAPE); ok('the setting off: turning sideways leaves the player as it is', !(await full()));
    await turn(PORTRAIT); await p.evaluate(() => window.__back()); await p.waitForTimeout(300);
    await p.evaluate(() => { const k = JSON.parse(localStorage.getItem('kt.player') || '{}'); delete k.autoRotateFull; localStorage.setItem('kt.player', JSON.stringify(k)); }); await p.reload(); await p.waitForFunction(() => !!window.__ktBack);
  }
  // Settings on the phone: the switch in the player's section, on by default.
  await p.evaluate(() => { location.hash = '#/settings/player'; }); await p.waitForSelector('.pp-panel', { state: 'attached', timeout: 10000 }); await p.waitForTimeout(500);
  const sw = await p.evaluate(() => { const g = [...document.querySelectorAll('.pp-panel details.pp-group')].find((d) => d.querySelector('input') && [...d.querySelectorAll('.switch-row')].some((r) => r.dataset)); void g; const rows = [...document.querySelectorAll('.pp-panel .switch-row')]; const r = rows.find((x) => /Rotate for full screen|ملء الشاشة بالتدوير/.test(x.textContent)); return r ? { on: r.querySelector('input').checked, text: r.querySelector('span').childNodes[0].textContent } : null; });
  ok(`[${lang}] Settings on a phone: «Rotate for full screen» in the player section, on`, !!sw && sw.on, sw);
  if (SHOTS) {
    await p.evaluate(() => { const rows = [...document.querySelectorAll('.pp-panel .switch-row')]; const r = rows.find((x) => /Rotate for full screen|ملء الشاشة بالتدوير/.test(x.textContent)); const d = r.closest('details'); d.open = true; r.scrollIntoView({ block: 'center' }); r.style.outline = '2px solid var(--md-primary)'; r.style.outlineOffset = '4px'; r.style.borderRadius = '12px'; });
    await p.waitForTimeout(300); await p.screenshot({ path: path.join(SHOTS, `player-setting-phone-${lang}.png`) });
  }
  ok(`[${lang}] phone: no page errors`, !errors.length, errors);
  await ctx.close();
}

async function pc(br, port) {
  const ctx = await br.newContext({ viewport: { width: 1366, height: 860 } });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 404 }));
  const p = await ctx.newPage(); const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(() => {
    localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['player'], playerWith: 'app' })); localStorage.setItem('kt.pc.starter', '1');
    window.kurokawaTools = new Proxy({ platform: 'desktop', available: true, os: 'linux', ready: async () => ({}), list: async () => [], onTasks: (cb) => { cb([]); return () => {}; }, defaultDir: async () => '/d' }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) });
  });
  await p.goto(`http://127.0.0.1:${port}/#/settings/player`); await p.waitForSelector('.pp-panel', { state: 'attached', timeout: 10000 }); await p.waitForTimeout(500);
  const has = await p.evaluate(() => [...document.querySelectorAll('.pp-panel .switch-row')].some((x) => /Rotate for full screen/.test(x.textContent)));
  const orient = await p.evaluate(() => [...document.querySelectorAll('.pp-panel .row')].some((x) => /Screen orientation|orientation/i.test(x.textContent)));
  ok('[pc] Settings on a computer: no «Rotate for full screen»', !has);
  void orient;
  if (SHOTS) { await p.evaluate(() => { const g = [...document.querySelectorAll('.pp-panel details.pp-group')].find((d) => /Playback/.test(d.querySelector('summary').textContent)); if (g) { g.open = true; const rows = [...g.querySelectorAll('.row, .field, label')]; const o = rows.reverse().find((r) => /orientation/i.test(r.textContent) && r.textContent.length < 80); (o || g).scrollIntoView({ block: 'center' }); } }); await p.waitForTimeout(300); await p.screenshot({ path: path.join(SHOTS, 'player-setting-pc-absent.png') }); }
  ok('[pc] no page errors', !errors.length, errors);
  await ctx.close();
}

(async () => {
  const web = serve().listen(0); const port = web.address().port; const br = await chromium.launch();
  await phone(br, port, 'en'); await phone(br, port, 'ar'); await pc(br, port);
  await br.close(); web.close();
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
