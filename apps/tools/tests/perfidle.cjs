// node tests/perfidle.cjs: the app left open on Downloads with nothing running, for 60 s of (fake) time — once visible,
// once hidden — at phone size (the phone's plugin faked) and PC size (the desktop bridge faked). Counted: the JS timer
// wake-ups (setTimeout/setInterval callbacks, by where they come from), animation frames, network requests and calls to
// the bridge/plugin. Stand-ins only; the clock is Playwright's, so a minute takes moments.
// Budgets: hidden → no wake-up at all after the first seconds; visible and idle → only what can be seen changing (none
// here), the clipboard read only while focused, no animation-frame loop. KT_DIST=<another dist>: report only.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = process.env.KT_DIST || path.join(__dirname, '..', 'dist'); const BEFORE = !!process.env.KT_DIST;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
(async () => {
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`; const br = await chromium.launch();
  const run = async (kind, hidden, focused) => {
    const ctx = await br.newContext(kind === 'phone' ? { viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true } : { viewport: { width: 1366, height: 768 } }); const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    let net = 0; await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => { net++; r.fulfill({ status: 404 }); });
    await p.clock.install();
    await p.addInitScript(({ kind }) => {
      localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.pc.starter', '1');
      localStorage.setItem('kt.settings', JSON.stringify({ addons: ['video'], clipboardWatch: true, doh: kind === 'phone' ? 'cloudflare' : 'off' }));
      window.__w = { timers: {}, frames: 0, bridge: {}, clip: 0, on: false };
      const label = (fn) => String(fn).replace(/\s+/g, ' ').slice(0, 70);
      const wrap = (orig, kindName) => function (fn, ms, ...a) { if (typeof fn !== 'function') return orig.call(this, fn, ms, ...a); const l = `${kindName}:${ms ?? 0}:${label(fn)}`; return orig.call(this, function (...b) { if (window.__w.on) window.__w.timers[l] = (window.__w.timers[l] || 0) + 1; return fn.apply(this, b); }, ms, ...a); };
      window.setTimeout = wrap(window.setTimeout, 'timeout'); window.setInterval = wrap(window.setInterval, 'interval');
      const raf = window.requestAnimationFrame; window.requestAnimationFrame = (fn) => raf((t) => { if (window.__w.on) window.__w.frames++; fn(t); });
      const count = (k) => { if (window.__w.on) window.__w.bridge[k] = (window.__w.bridge[k] || 0) + 1; };
      if (kind === 'pc') window.kurokawaTools = new Proxy({ platform: 'desktop', available: true, os: 'linux', list: async () => [], onTasks: (cb) => { cb([]); return () => {}; }, defaultDir: async () => '/d', clipboardText: async () => { if (window.__w.on) window.__w.clip++; return ''; } }, { get: (t, k) => { if (typeof k === 'string' && k !== 'then') count(k); return k in t ? t[k] : k === 'then' ? undefined : async () => undefined; } });
      else { const api = { addListener: () => ({ remove() {} }), list: async () => ({ tasks: [] }), clipboardText: async () => { if (window.__w.on) window.__w.clip++; return { text: '' }; } }; const plugin = new Proxy(api, { get: (t, k) => { if (typeof k === 'string' && k !== 'then') count(k); return k in t ? t[k] : k === 'then' ? undefined : async () => ({}); } }); window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] }; }
    }, { kind });
    await p.goto(base + '#/'); await p.waitForSelector('.downloads-view .task-list', { state: 'attached' });
    if (kind === 'phone') { await p.goto(base + '#/settings/network').catch(() => undefined); await p.waitForTimeout(300); await p.goto(base + '#/'); await p.waitForSelector('.downloads-view .task-list', { state: 'attached' }); }
    await p.waitForTimeout(1500); await p.clock.runFor(30000); // (the start's own work done: the first update checks, the starters)
    await p.evaluate(({ hidden, focused }) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') }); Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      document.hasFocus = () => focused && !hidden; document.dispatchEvent(new Event('visibilitychange')); if (!focused || hidden) window.dispatchEvent(new Event('blur'));
      window.__w.on = true;
    }, { hidden, focused });
    net = 0; await p.clock.runFor(60000); await p.waitForTimeout(50);
    const w = await p.evaluate(() => window.__w); await ctx.close();
    const wake = Object.values(w.timers).reduce((a, b) => a + b, 0);
    return { wake, timers: w.timers, frames: w.frames, bridge: w.bridge, clip: w.clip, net, errs };
  };
  const show = (n, r) => { console.log(`${n}: wake-ups ${r.wake} · frames ${r.frames} · bridge calls ${Object.values(r.bridge).reduce((a, b) => a + b, 0)} · clipboard reads ${r.clip} · requests ${r.net}`); if (process.env.KT_DETAIL) { for (const [k, v] of Object.entries(r.timers)) console.log('   ', v, k); console.log('    bridge', JSON.stringify(r.bridge)); } };
  const R = {};
  for (const kind of ['phone', 'pc']) for (const [st, hidden, focused] of [['hidden', true, false], ['visible, not focused', false, false], ['visible, focused', false, true]]) { const r = await run(kind, hidden, focused); R[`${kind} ${st}`] = r; show(`${kind} ${st}`, r); }
  if (!BEFORE) {
    for (const k of ['phone hidden', 'pc hidden']) ok(`${k}: no JS wake-up in 60 s`, R[k].wake === 0 && R[k].frames === 0, R[k].timers);
    for (const k of ['phone visible, not focused', 'pc visible, not focused']) ok(`${k}: no clipboard read, at most a few wake-ups`, R[k].clip === 0 && R[k].wake <= 4, R[k].timers);
    for (const k of ['phone visible, focused', 'pc visible, focused']) ok(`${k}: idle — no timer, no animation-frame loop, no clipboard poll`, R[k].frames <= 2 && R[k].wake <= 1 && R[k].clip === 0, R[k]);
    ok('no page errors', Object.values(R).every((r) => !r.errs.length), Object.values(R).flatMap((r) => r.errs));
  }
  await br.close(); web.close(); process.exit(fails ? 1 : 0);
})();
