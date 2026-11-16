// node tests/scene.cjs: the scene engine's background «Motes» (animBg 'scene:motes': src/theme/sceneHost.ts drawing
// what the Rust engine core/kt-scene computes, loaded as dist/scene/ktscene.wasm) on a computer.
// The wasm is built in CI only (scripts/build-scene-wasm.sh; never committed). So this test has two paths:
//  - the wasm present (dist/scene/ktscene.wasm, or the file named by KT_SCENE_WASM — e.g. the «ktscene-wasm» artifact of
//    .github/workflows/scene-wasm.yml — served at scene/ktscene.wasm):
//      1. chosen at the start: the engine loads, ONE canvas, frames change, the instances drawn are the engine's;
//      2. the same pause gate as the designs: hidden → paused (no timer, no frame, no draw), visible → running;
//         the system's «less motion» → still; Still → one frame;
//      3. taken down from Appearance (Off), five times over: no canvas, timer, frame, listener, observer or engine
//         scene left (sceneHost's liveScenes back to 0);
//      4. readability (every text role ≥ 4.5:1 over the brightest and darkest pixel) and no yellow, dark and light;
//      5. the perf gate's numbers printed beside «drift» (generous checks only; the real gate is the owner's PC);
//  - the wasm absent: «Motes» chosen falls back to «drift» quietly — one console.info line, no error, drawing, the
//    Appearance line saying so — and the test says «wasm absent: fallback path only» and passes.
// Both: Appearance offers «Motes» on a computer (en, ar), never on a phone; never in the mini window.
//
// The perf numbers (with localStorage kt.anim.perf = '1', or ?animperf, `window.__ktAnimPerf()` in the page):
//  engineMsPerSec  the background's own script time a second (its ticks: step + draw), ms/s
//  rafLateAvgMs    after each drawn frame, how much later than 1/60 s the next frame came, averaged, ms
//  rafGapAvgMs     the gap itself, averaged, ms (≈16.7 when nothing is behind)
//  slow, tooSlow   the self-throttle now (1, 2, 4; true = it gave up to the still frame); slowDowns/slowUps counted
//  scene.stepMs    the wasm step of this scene, ms a call; scene.drawMs the Canvas2D drawing, ms a frame
//  __ktAnimPerf.bench()  the wasm step for 4,096 particles, ms (the critic's 1.5 ms gate)
// The critic's STOP rules (on the owner's PC, glass on, 1280×800 and 1920×1080, compared with «drift»): lateness >
// 2× drift's, or more than one slow-down in 60 s, or script > 25 ms/s, or the 4,096 step > 1.5 ms.
// Only loopback, made-up data. Run: NODE_PATH=$(npm root -g) node tests/scene.cjs [en|ar]
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const LANG = process.argv[2] === 'ar' ? 'ar' : 'en';
const WASM = process.env.KT_SCENE_WASM ? path.resolve(process.env.KT_SCENE_WASM) : path.join(DIST, 'scene', 'ktscene.wasm');
const HAVE = fs.existsSync(WASM);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const serve = () => http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = p === '/scene/ktscene.wasm' ? (HAVE ? WASM : '') : path.join(DIST, p);
  if (!f || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 600))); if (!c) fails++; };
const PC = { viewport: { width: 1280, height: 800 } };
const PHONE = { viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true };
const T = {
  en: { row: 'Animated background', motes: 'Motes', off: 'Off', fallback: /could not be loaded here/ },
  ar: { row: 'خلفيّةٌ متحرّكة', motes: 'الذرّاتُ السابحة', off: 'معطَّلة', fallback: /تعذّر تحميلُ محرّكِ المشاهد/ },
}[LANG];

/** In the page before anything runs: settings, the desktop bridge (or the phone's plugin), the counters (as animbg.cjs). */
function init({ settings, phone, lang }) {
  localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.pc.starter', '1'); localStorage.setItem('kt.update.lastCheck', String(Date.now())); localStorage.setItem('kt.themeMigrated', '1'); localStorage.setItem('kt.mainTheme', '1');
  localStorage.setItem('kt.settings', JSON.stringify({ themeChosen: true, autoUpdateCheck: false, ...settings }));
  localStorage.setItem('kt.anim.perf', '1');
  const c = (window.__abg = { draws: 0, sprites: 0, listeners: 0, observers: 0, timers: new Set(), rafs: new Set(), rafCalls: 0, info: [] });
  const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener; const seen = new WeakMap();
  const counted = (t) => t === window || t === document || t instanceof MediaQueryList;
  EventTarget.prototype.addEventListener = function (ty, f, o) { if (counted(this) && f) { const k = ty + (typeof o === 'boolean' ? o : !!o?.capture); let m = seen.get(this); if (!m) seen.set(this, (m = new Map())); let s = m.get(k); if (!s) m.set(k, (s = new Set())); if (!s.has(f)) { s.add(f); c.listeners++; } } return add.call(this, ty, f, o); };
  EventTarget.prototype.removeEventListener = function (ty, f, o) { if (counted(this) && f) { const k = ty + (typeof o === 'boolean' ? o : !!o?.capture); const s = seen.get(this)?.get(k); if (s?.delete(f)) c.listeners--; } return rem.call(this, ty, f, o); };
  const MO = window.MutationObserver; window.MutationObserver = class extends MO { constructor(...a) { super(...a); this.__on = false; } observe(...a) { if (!this.__on) { this.__on = true; c.observers++; } return super.observe(...a); } disconnect() { if (this.__on) { this.__on = false; c.observers--; } return super.disconnect(); } };
  const mine_ = (f) => typeof f === 'function' && /\.tick\b|unfocused|\.raf2?\s*=\s*0/.test(String(f));
  const st = window.setTimeout, ct = window.clearTimeout;
  window.setTimeout = function (f, ms, ...a) { if (!mine_(f)) return st.call(window, f, ms, ...a); const id = st.call(window, (...b) => { c.timers.delete(id); f(...b); }, ms, ...a); c.timers.add(id); return id; };
  window.clearTimeout = function (id) { c.timers.delete(id); return ct.call(window, id); };
  const ra = window.requestAnimationFrame, ca = window.cancelAnimationFrame;
  window.requestAnimationFrame = function (f) { if (!mine_(f)) return ra.call(window, f); c.rafCalls++; const id = ra.call(window, (t) => { c.rafs.delete(id); f(t); }); c.rafs.add(id); return id; };
  window.cancelAnimationFrame = function (id) { c.rafs.delete(id); return ca.call(window, id); };
  const fr = CanvasRenderingContext2D.prototype.fillRect;
  CanvasRenderingContext2D.prototype.fillRect = function (...a) { if (this.canvas.className === 'abg-canvas' && this.canvas.parentElement?.id === 'kt-animbg') c.draws++; return fr.apply(this, a); };
  const di = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (...a) { if (this.canvas.className === 'abg-canvas' && this.canvas.parentElement?.id === 'kt-animbg') c.sprites++; return di.apply(this, a); };
  const inf = console.info; console.info = function (...a) { c.info.push(a.join(' ')); return inf.apply(console, a); };
  window.__snap = () => { const h = document.getElementById('kt-animbg'); return { draws: c.draws, sprites: c.sprites, listeners: c.listeners, observers: c.observers, timers: c.timers.size, rafs: c.rafs.size, rafCalls: c.rafCalls, canvases: document.querySelectorAll('.abg-canvas').length, hostCanvases: h ? h.querySelectorAll('canvas').length : 0, hosts: document.querySelectorAll('#kt-animbg').length, abg: document.documentElement.classList.contains('abg'), state: h?.dataset.state ?? null, kind: h?.dataset.kind ?? null, engine: h?.dataset.engine ?? null, fallback: h?.dataset.fallback ?? null, info: c.info.slice() }; };
  const now = Date.now(); const ts = []; for (let i = 0; i < 30; i++) ts.push({ id: 't' + i, kind: 'http', name: `made-up-${i}.mkv`, source: { url: `https://example.test/${i}` }, dir: '/d', state: i < 2 ? 'active' : 'done', done: 4e8, total: 9e8, downSpeed: i < 2 ? 2e6 : 0, upSpeed: 0, files: [], addedAt: now - i * 60000 });
  if (phone) { const api = { addListener: () => ({ remove() {} }), list: async () => ({ tasks: [] }) }; window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) }) }, PluginHeaders: [] }; }
  else window.kurokawaTools = new Proxy({ platform: 'desktop', available: true, os: 'linux', ready: async () => ({}), list: async () => ts, onTasks: (cb) => { cb(ts); return () => {}; }, defaultDir: async () => '/d' }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) });
}

(async () => {
  console.log(HAVE ? `wasm present: ${path.relative(process.cwd(), WASM)} (${fs.statSync(WASM).size} bytes) — the engine's path` : 'wasm absent: fallback path only (dist/scene/ktscene.wasm is built in CI: scripts/build-scene-wasm.sh)');
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`; const br = await chromium.launch();
  const open = async (o, opts, route = '#/') => {
    const ctx = await br.newContext(o); const p = await ctx.newPage(); const errs = []; const reqs = [];
    p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); }); p.on('request', (r) => reqs.push(r.url()));
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 404, body: '' }));
    await p.addInitScript(init, { lang: LANG, ...opts }); await p.goto(base + route); await p.waitForSelector('.view, .mini-view, body'); await p.waitForTimeout(700);
    return { p, ctx, errs, reqs, snap: () => p.evaluate(() => window.__snap()), fetched: (re) => reqs.some((u) => re.test(u)) };
  };
  const choose = async (p, option) => {
    await p.locator('#appearance .row', { hasText: T.row }).first().locator('.pick-btn').click();
    await p.locator('.sheet .dest-row', { hasText: new RegExp(`^\\s*${option}\\s*$`) }).first().locator('input').click(); await p.waitForTimeout(300);
  };
  const waitFor = (p, fn, arg, ms = 4000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);
  const waitState = (p, want, ms = 4000) => waitFor(p, (w) => (document.getElementById('kt-animbg')?.dataset.state ?? null) === w, want, ms);
  const drawsIn = async (p, ms) => { const a = (await p.evaluate(() => window.__snap())).draws; await p.waitForTimeout(ms); return (await p.evaluate(() => window.__snap())).draws - a; };
  const pixels = (p) => p.evaluate(() => { const cv = document.querySelector('#kt-animbg .abg-canvas'); if (!cv || !cv.width) return null; const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let h = 2166136261; for (let i = 0; i < d.length; i += 97) h = Math.imul(h ^ d[i], 16777619) >>> 0; return { h, w: cv.width, hh: cv.height }; });
  const WANT_ENGINE = HAVE ? 'scene' : 'canvas';

  /* ---------- 0. Appearance offers «Motes» on a computer ---------- */
  {
    const { p, ctx, errs, fetched } = await open(PC, { settings: { theme: 'frost', uiMode: 'dark' } }, '#/settings/appearance');
    await p.waitForSelector('#appearance');
    await p.locator('#appearance .row', { hasText: T.row }).first().locator('.pick-btn').click(); await p.waitForTimeout(250);
    ok(`Appearance (PC, ${LANG}) offers «${T.motes}»`, (await p.locator('.sheet .dest-row', { hasText: T.motes }).count()) === 1);
    await p.keyboard.press('Escape'); await p.waitForTimeout(250);
    ok('…and nothing of the engine fetched before it is chosen', !fetched(/sceneHost|ktscene\.wasm/));
    ok('no page errors (0)', !errs.length, errs); await ctx.close();
  }

  /* ---------- 1. chosen at the start ---------- */
  {
    const { p, ctx, errs, snap, fetched } = await open(PC, { settings: { theme: 'frost', uiMode: 'dark', animBg: 'scene:motes' } });
    ok('chosen: the engine settled', await waitFor(p, (w) => document.getElementById('kt-animbg')?.dataset.engine === w, WANT_ENGINE, 6000), await snap());
    ok('running', await waitState(p, 'running', 4000), await snap());
    const s = await snap();
    ok('one background, one canvas in it, the kind kept as chosen', s.hosts === 1 && s.hostCanvases === 1 && s.canvases === 1 && s.kind === 'scene:motes', s);
    ok('the engine and its host fetched once chosen', fetched(/sceneHost/) && fetched(/ktscene\.wasm/));
    const a = await pixels(p); await p.waitForTimeout(900); const b = await pixels(p);
    ok('frames change', a && b && a.h !== b.h, { a, b });
    ok('it draws (> 5 frames in a second)', (await drawsIn(p, 1000)) > 5);
    if (HAVE) {
      const s2 = await snap(); ok('the engine\'s instances are what is drawn (sprites)', s2.sprites > 100, s2);
      ok('the scene canvas is near the window\'s resolution (not a design\'s sixteenth)', b && b.w >= 400, b);
      ok('no fallback line', !s2.info.some((x) => /scene engine unavailable/.test(x)), s2.info);
      const perf = await p.evaluate(() => window.__ktAnimPerf && window.__ktAnimPerf());
      ok('the perf numbers are there', perf && perf.engine === 'scene' && perf.scene && perf.scene.steps > 0, perf);
      const hash = await p.evaluate(() => window.__ktAnimPerf.hash()); ok('a state hash from the engine', typeof hash === 'number' && hash !== 0, hash);
      ok('one live scene in the engine', (await p.evaluate(() => window.__ktAnimPerf.liveScenes())) === 1);
    } else {
      const s2 = await snap();
      ok('absent: «drift» drawn instead (engine canvas, fallback drift)', s2.engine === 'canvas' && s2.fallback === 'drift', s2);
      ok('absent: one console.info line, no error', s2.info.filter((x) => /scene engine unavailable/.test(x)).length === 1, s2.info);
    }
    ok('no page errors (1)', !errs.length, errs);

    /* ---------- 2. the gate ---------- */
    const hide = (h) => p.evaluate((h) => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') }); Object.defineProperty(document, 'hidden', { configurable: true, get: () => h }); document.dispatchEvent(new Event('visibilitychange')); }, h);
    await hide(true); ok('hidden: paused', await waitState(p, 'paused'));
    const h1 = await snap(); ok('hidden: no timer, no frame, no draw', h1.timers === 0 && h1.rafs === 0 && (await drawsIn(p, 800)) === 0, h1);
    await hide(false); ok('visible: running and drawing again', (await waitState(p, 'running')) && (await drawsIn(p, 900)) > 3);
    await p.emulateMedia({ reducedMotion: 'reduce' }); ok('less motion: still', await waitState(p, 'still'));
    const h2 = await snap(); ok('still: nothing scheduled or drawn', h2.timers === 0 && h2.rafs === 0 && (await drawsIn(p, 800)) === 0, h2);
    await p.emulateMedia({ reducedMotion: 'no-preference' }); ok('motion again: running', await waitState(p, 'running'));
    await p.mouse.move(700, 500); let busy = false; for (let i = 0; i < 10; i++) { await p.mouse.wheel(0, i % 2 ? -200 : 200); await p.waitForTimeout(60); if ((await snap()).state === 'busy') busy = true; }
    ok('a scroll holds it', busy); ok('…then it runs again', await waitState(p, 'running', 2500));
    ok('no page errors (2)', !errs.length, errs); await ctx.close();
  }
  {
    const { p, ctx, errs, snap } = await open(PC, { settings: { theme: 'classic', uiMode: 'light', animBg: 'scene:motes', animBgLevel: 'still' } });
    ok('Still: one frame, nothing scheduled', (await waitState(p, 'still', 5000)) && (await drawsIn(p, 1000)) === 0 && (await snap()).timers === 0, await snap());
    ok('no page errors (Still)', !errs.length, errs); await ctx.close();
  }

  /* ---------- 3. teardown from Appearance ---------- */
  {
    const { p, ctx, errs, snap } = await open(PC, { settings: { theme: 'frost', uiMode: 'dark' } }, '#/settings/appearance');
    await p.waitForSelector('#appearance');
    const settle = () => p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await settle(); const before = await snap(); let clean = true, mounted = true, said = true; let last = null;
    for (let round = 0; round < 5; round++) {
      await choose(p, T.motes);
      if (!(await waitFor(p, (w) => document.getElementById('kt-animbg')?.dataset.engine === w, WANT_ENGINE, 6000)) || !(await waitState(p, 'running'))) mounted = false;
      if ((await p.locator('#kt-animbg .abg-canvas').count()) !== 1 || (await p.locator('.abg-preview .abg-canvas').count()) !== 1) mounted = false;
      if (!HAVE && round === 0) { await p.waitForTimeout(200); said = T.fallback.test((await p.locator('.abg-now').textContent()) || ''); }
      await choose(p, T.off); await p.waitForTimeout(300); await settle();
      last = await snap();
      if (last.hosts || last.canvases || last.abg || last.timers || last.rafs || last.listeners !== before.listeners || last.observers !== before.observers) clean = false;
    }
    ok('Motes chosen five times: one background and one preview each time', mounted);
    if (!HAVE) ok('absent: Appearance says the engine could not be loaded and drift is shown', said, await p.locator('.abg-now').textContent().catch(() => null));
    ok(`Off again each time: no canvas, timer, frame, listener (${before.listeners}) or observer (${before.observers}) left`, clean, { before, last });
    ok('no page errors (3)', !errs.length, errs); await ctx.close();
  }
  if (HAVE) {
    // (liveScenes read through the perf hook of a page that mounts, then takes down, the background.)
    const { p, ctx, errs } = await open(PC, { settings: { theme: 'frost', uiMode: 'dark', animBg: 'scene:motes' } });
    await waitFor(p, () => document.getElementById('kt-animbg')?.dataset.engine === 'scene', null, 6000);
    const live1 = await p.evaluate(() => window.__ktAnimPerf.liveScenes());
    await p.goto(base + '#/settings/appearance'); await p.waitForSelector('#appearance'); await choose(p, T.off); await p.waitForTimeout(400);
    const live0 = await p.evaluate(() => window.__ktAnimPerf.liveScenes());
    ok('teardown releases the engine\'s scene (live scenes 1 → 0)', live1 === 1 && live0 === 0, { live1, live0 });
    ok('no page errors (3b)', !errs.length, errs); await ctx.close();
  }

  /* ---------- the mini window and a phone ---------- */
  {
    const { p, ctx, errs, snap, fetched } = await open(PC, { settings: { theme: 'frost', uiMode: 'dark', animBg: 'scene:motes' } }, '#/mini');
    await p.waitForTimeout(1200); const s = await snap();
    ok('the mini window: no background, nothing of the engine fetched', s.hosts === 0 && s.canvases === 0 && !fetched(/sceneHost|ktscene\.wasm/), s);
    ok('no page errors (mini)', !errs.length, errs); await ctx.close();
  }
  {
    const { p, ctx, errs, snap, fetched } = await open(PHONE, { settings: { theme: 'frost', uiMode: 'dark', animBg: 'scene:motes' }, phone: true });
    await p.waitForTimeout(1200); const s = await snap();
    ok('a phone, the setting carried over: nothing, nothing fetched', s.hosts === 0 && !fetched(/sceneHost|ktscene\.wasm/), s);
    await p.goto(base + '#/settings/appearance'); await p.waitForTimeout(1000);
    ok('a phone: no «Motes» anywhere in Appearance', (await p.locator(`text=${T.motes}`).count()) === 0);
    ok('no page errors (phone)', !errs.length, errs); await ctx.close();
  }

  /* ---------- 4. readability and colour ---------- */
  if (HAVE) {
    for (const [theme, mode, accent] of [['frost', 'dark', 'graphite'], ['frost', 'light', 'graphite'], ['classic', 'dark', 'gold'], ['classic', 'light', 'gold'], ['frost', 'dark', 'coral']]) {
      const { p, ctx, errs } = await open(PC, { settings: { theme, uiMode: mode, accent, animBg: 'scene:motes' } });
      await waitState(p, 'running', 6000); await p.waitForTimeout(1200);
      const r = await p.evaluate(() => {
        const cv = document.querySelector('#kt-animbg .abg-canvas'); const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        const probe = (v) => { const s = document.createElement('span'); s.style.color = v; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); const k = document.createElement('canvas').getContext('2d'); k.fillStyle = c; k.fillRect(0, 0, 1, 1); const x = k.getImageData(0, 0, 1, 1).data; return [x[0], x[1], x[2], x[3] / 255]; };
        const texts = ['var(--md-on-surface)', 'var(--md-on-surface-variant)', 'var(--md-on-surface-dim, var(--md-on-surface-variant))'].map(probe);
        const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
        const ov = (t, u) => [t[0] * t[3] + u[0] * (1 - t[3]), t[1] * t[3] + u[1] * (1 - t[3]), t[2] * t[3] + u[2] * (1 - t[3]), 1];
        const cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
        let hi = [0, 0, 0, 1], lo = [255, 255, 255, 1], hiL = -1, loL = 2; const yel = []; let lit = 0;
        for (let j = 0; j < d.length; j += 4) {
          const px = [d[j], d[j + 1], d[j + 2], 1]; const l = lum(px); if (l > hiL) { hiL = l; hi = px; } if (l < loL) { loL = l; lo = px; }
          if (j && (d[j] !== d[0] || d[j + 1] !== d[1] || d[j + 2] !== d[2])) lit++;
          const mx = Math.max(px[0], px[1], px[2]), mn = Math.min(px[0], px[1], px[2]);
          if ((mx - mn) / 255 > 0.06) { let h = mx === px[0] ? ((px[1] - px[2]) / (mx - mn)) % 6 : mx === px[1] ? (px[2] - px[0]) / (mx - mn) + 2 : (px[0] - px[1]) / (mx - mn) + 4; h *= 60; if (h < 0) h += 360; if (h >= 40 && h <= 70 && yel.length < 3) yel.push([...px.slice(0, 3), Math.round(h)]); }
        }
        let w = 99; for (const b of [hi, lo]) for (const t of texts) w = Math.min(w, cr(ov(t, b), b));
        return { w: +w.toFixed(2), yel, lit: +(lit / (d.length / 4)).toFixed(4) };
      });
      ok(`${theme} ${mode} ${accent}: text ≥ 4.5:1 over the brightest and darkest pixel (${r.w}), motes visible (${(r.lit * 100).toFixed(1)} % of pixels)`, r.w >= 4.5 && r.lit > 0.003, r);
      ok(`${theme} ${mode} ${accent}: no yellow, amber or gold`, !r.yel.length, r.yel);
      ok(`no page errors (${theme} ${mode} ${accent})`, !errs.length, errs); await ctx.close();
    }
  }

  /* ---------- 5. the perf gate's numbers, beside «drift» (headless: a regression guard only) ---------- */
  {
    const run = async (animBg) => {
      const { p, ctx } = await open(PC, { settings: { theme: 'frost', uiMode: 'dark', animBg } }); await p.waitForTimeout(1500);
      const cdp = await ctx.newCDPSession(p); await cdp.send('Performance.enable'); const m = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
      await p.evaluate(() => { window.__ktAnimPerf?.reset(); window.__fr = []; let last = 0; const f = (t) => { if (last) window.__fr.push(t - last); last = t; if (window.__frOn) requestAnimationFrame(f); }; window.__frOn = true; requestAnimationFrame(f); });
      const a = await m(); await p.waitForTimeout(5000); const b = await m();
      const fr = await p.evaluate(() => { window.__frOn = false; return window.__fr; }); const perf = await p.evaluate(() => (window.__ktAnimPerf ? window.__ktAnimPerf() : null));
      const bench = HAVE && animBg !== 'off' ? await p.evaluate(() => window.__ktAnimPerf.bench()).catch((e) => String(e)) : null;
      await ctx.close();
      return { script: (b.ScriptDuration - a.ScriptDuration) * 200, long: fr.filter((x) => x > 50).length, frames: fr.length, perf, bench };
    };
    const off = await run('off'); const drift = await run('drift'); const motes = await run('scene:motes');
    const line = (n, r) => `     ${n}: script +${(r.script - off.script).toFixed(1)} ms/s (CDP) · engine ${r.perf?.engineMsPerSec ?? '-'} ms/s · ${r.perf?.fps ?? '-'} fps · rAF late ${r.perf?.rafLateAvgMs ?? '-'} ms (gap ${r.perf?.rafGapAvgMs ?? '-'}) · slow ${r.perf?.slow ?? '-'}${r.perf?.tooSlow ? ' TOO SLOW' : ''} (${r.perf?.slowDowns ?? 0} down) · long frames ${r.long}/${r.frames}` + (r.perf?.scene ? ` · wasm step ${r.perf.scene.stepMs.toFixed(3)} ms · draw ${r.perf.scene.drawMs.toFixed(3)} ms · ${r.perf.scene.instances} instances` : '') + (r.bench ? ` · 4,096 step ${typeof r.bench === 'object' ? r.bench.stepMs.toFixed(3) + ' ms (' + r.bench.live + ' live)' : r.bench}` : '');
    console.log(line('drift', drift)); console.log(line(HAVE ? 'motes' : 'motes (fallback: drift)', motes));
    // (Headless Chromium draws the canvas in software, so drawImage costs far more script time here than on a GPU: a
    //  regression guard at 40 ms/s; the critic's 25 ms/s is for the owner's PC.)
    ok('motes: its script under 40 ms a second (headless, a regression guard)', motes.script - off.script < 40, { motes, off });
    ok('motes: long frames (> 50 ms) under 10 %', motes.long <= Math.max(3, motes.frames * 0.1), motes);
    if (HAVE) ok('the 4,096-particle wasm step measured (gate 1.5 ms on the owner\'s PC; headless 4 ms here)', motes.bench && typeof motes.bench === 'object' && motes.bench.stepMs < 4 && motes.bench.live > 3000, motes.bench);
  }

  await br.close(); web.close();
  if (!HAVE) console.log('wasm absent: fallback path only — the engine\'s own path runs once dist/scene/ktscene.wasm exists (CI artifact «ktscene-wasm»)');
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
