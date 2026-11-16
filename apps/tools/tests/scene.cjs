// node tests/scene.cjs: the scene engine's backgrounds «Motes», «Night snowfall» and «Aurora over a lake» (animBg 'scene:…': src/theme/
// sceneHost.ts drawing what the Rust engine core/kt-scene computes, loaded as dist/scene/ktscene.wasm) on a computer.
// The wasm is built in CI only (scripts/build-scene-wasm.sh; never committed). So this test has two paths:
//  - the wasm present (dist/scene/ktscene.wasm, or the file named by KT_SCENE_WASM — e.g. the «ktscene-wasm» artifact of
//    .github/workflows/scene-wasm.yml — served at scene/ktscene.wasm):
//      1. chosen at the start: the engine loads, ONE canvas, frames change, the instances drawn are the engine's;
//         Night snowfall: a composition — static layers drawn once (sky, moon, ridges, hills, ground), snow moving;
//      2. the same pause gate as the designs: hidden → paused, visible → running, «less motion» → still, Still → one frame;
//      3. taken down from Appearance (Off), five times over: no canvas, timer, frame, listener, observer or engine
//         scene left (sceneHost's liveScenes back to 0);
//      4. a trap (the engine throwing — the host's test hook, as a real trap would): «drift» drawn instead, one quiet
//         line, no page error, the engine let go; chosen again later, a new engine instance runs the scene;
//      5. readability, measured on the REAL text, for EVERY scene in dark and light, running and still (after another
//         view): every visible text's rectangle, the scene's pixels under it averaged, every panel between composited
//         over them — 4.5:1 or more; no yellow; each scene clearly visible by its own measure (5b: views changed many
//         times leave nothing marked behind; a click's zoom, an unchanged resize remake nothing; a drag-resize, once);
//      6. the page round a scene: «Where the background shows» (whole window: the sidebar a measured panel; content
//         only: the theme's own surfaces), «Match the app's colours» (on: the scene's accent, ≥ 4.5:1, no yellow; off:
//         the reader's accent back exactly), «Reacts to the mouse» (Off: no click listener);
//      7. the perf gate's numbers printed beside «drift» (generous checks only; the real gate is the owner's PC);
//  - the wasm absent: a scene chosen falls back to «drift» quietly — one console.info line, no error, drawing, the
//    Appearance line saying so — and the test says «wasm absent: fallback path only» and passes, UNLESS
//    KT_SCENE_REQUIRED=1 (the release workflow sets it): then the missing engine is a failure.
// Both: Appearance offers both scenes on a computer (en, ar), never on a phone; never in the mini window.
//
// The perf numbers (with localStorage kt.anim.perf = '1', or ?animperf, `window.__ktAnimPerf()` in the page):
//  engineMsPerSec  the background's own script time a second (its ticks: step + draw), ms/s
//  rafLateAvgMs    after each drawn frame, how much later than 1/60 s the next frame came, averaged, ms
//  rafGapAvgMs     the gap itself, averaged, ms (≈16.7 when nothing is behind)
//  slow, tooSlow   the self-throttle now (1, 2, 4; true = it gave up to the still frame); slowDowns/slowUps counted
//  scene.stepMs    the wasm step of this scene, ms a call; scene.drawMs the Canvas2D drawing, ms a frame;
//  scene.statics   static canvases (composited once); scene.panelScrim / scrimMax: the contrast rule's pulls (0–1)
//  __ktAnimPerf.bench()  the wasm step for 4,096 particles, ms (the critic's 1.5 ms gate)
// The critic's STOP rules (on the owner's PC, glass on, 1280×800 and 1920×1080, compared with «drift»): lateness >
// 2× drift's, or more than one slow-down in 60 s, or script > 25 ms/s, or the 4,096 step > 1.5 ms.
// Only loopback, made-up data. Run: NODE_PATH=$(npm root -g) node tests/scene.cjs [en|ar]
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const LANG = process.argv[2] === 'ar' ? 'ar' : 'en';
const WASM = process.env.KT_SCENE_WASM ? path.resolve(process.env.KT_SCENE_WASM) : path.join(DIST, 'scene', 'ktscene.wasm');
const HAVE = fs.existsSync(WASM);
const REQUIRED = process.env.KT_SCENE_REQUIRED === '1';
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
  en: { scene: 'Scene', row: 'Animated background', motes: 'Motes', snow: 'Night snowfall', aurora: 'Aurora over a lake', off: 'Off', fallback: /could not be loaded here/, where: 'Where the background shows', tint: "Match the app's colours to the background", react: 'Reacts to the mouse' },
  ar: { scene: 'مشهد', row: 'خلفيّةٌ متحرّكة', motes: 'الذرّاتُ السابحة', snow: 'ثلجُ الليل', aurora: 'شفقٌ فوقَ بحيرة', off: 'معطَّلة', fallback: /تعذّر تحميلُ محرّكِ المشاهد/, where: 'موضعُ ظهورِ الخلفيّة', tint: 'مواءمةُ ألوانِ التطبيقِ للخلفيّة', react: 'التفاعلُ مع الفأرة' },
}[LANG];

/** In the page before anything runs: settings, the desktop bridge (or the phone's plugin), the counters (as animbg.cjs). */
function init({ settings, phone, lang, trapAfter }) {
  if (typeof trapAfter === 'number') window.__ktSceneTrapAfter = trapAfter;
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
  if (REQUIRED && !HAVE) { console.log('FAIL KT_SCENE_REQUIRED=1 and no ktscene.wasm: a release must carry the scene engine'); process.exit(1); }
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`; const br = await chromium.launch();
  const open = async (o, opts, route = '#/') => {
    const ctx = await br.newContext(o); const p = await ctx.newPage(); const errs = []; const reqs = [];
    p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); }); p.on('request', (r) => reqs.push(r.url()));
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 404, body: '' }));
    await p.addInitScript(init, { lang: LANG, ...opts }); await p.goto(base + route); await p.waitForSelector('.view, .mini-view, body'); await p.waitForTimeout(700);
    return { p, ctx, errs, reqs, snap: () => p.evaluate(() => window.__snap()), fetched: (re) => reqs.some((u) => re.test(u)) };
  };
  // (A design or Off from the row's sheet; a scene: «Scene» there, then its picture in the grid.)
  const choose = async (p, option) => {
    const scene = ![T.off].includes(option);
    const tile = () => p.locator('#appearance .abg-tile', { hasText: option }).first();
    if (scene && (await p.locator('#appearance .abg-tile').count())) { await tile().click(); await p.waitForTimeout(300); return; }
    await p.locator('#appearance .row', { hasText: T.row }).first().locator('.pick-btn').click();
    await p.locator('.sheet .dest-row', { hasText: new RegExp(`^\\s*${scene ? T.scene : option}\\s*$`) }).first().locator('input').click(); await p.waitForTimeout(300);
    if (scene) { await tile().click(); await p.waitForTimeout(300); }
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
    ok(`Appearance (PC, ${LANG}) offers «${T.scene}»`, (await p.locator('.sheet .dest-row', { hasText: T.scene }).count()) === 1);
    await p.keyboard.press('Escape'); await p.waitForTimeout(250);
    ok('…and nothing of the engine fetched before it is chosen', !fetched(/sceneHost|ktscene\.wasm/));
    // (Chosen: the grid of pictures, grouped, the chosen one marked; drawn once each, no live engine per picture.)
    await choose(p, T.snow);
    const grid = await p.evaluate(() => ({ tiles: document.querySelectorAll('#appearance .abg-tile').length, groups: document.querySelectorAll('#appearance .abg-group').length, on: [...document.querySelectorAll('#appearance .abg-tile[aria-checked="true"]')].map((b) => b.dataset.scene) }));
    ok('the scenes as a grid: 14 pictures in 4 groups, Night snowfall marked', grid.tiles === 14 && grid.groups === 4 && grid.on.join() === 'night-snowfall', grid);
    ok(`…«${T.motes}» and «${T.aurora}» among them`, (await p.locator('#appearance .abg-tile', { hasText: T.motes }).count()) === 1 && (await p.locator('#appearance .abg-tile', { hasText: T.aurora }).count()) === 1);
    const drawn = await waitFor(p, () => document.querySelectorAll('#appearance .abg-thumb.drawn').length === 14, null, 30000);
    const pics = await p.evaluate(() => [...document.querySelectorAll('#appearance .abg-thumb')].map((x) => x.style.backgroundImage.slice(0, 22)));
    ok(`every picture drawn (${HAVE ? 'by the engine' : 'the sky, without the engine'})`, drawn && pics.every((u) => (HAVE ? u.startsWith('url("data:image/') : u.startsWith('linear-gradient'))), pics.slice(0, 3));
    if (HAVE) ok('…and let go: no engine scene kept for a picture (the page and the preview only)', (await p.evaluate(() => window.__ktAnimPerf.liveScenes())) <= 2);
    // (Keyboard: Tab reaches the chosen one, the arrows move between them.)
    await p.locator('#appearance .abg-tile[tabindex="0"]').focus(); await p.keyboard.press(LANG === 'ar' ? 'ArrowLeft' : 'ArrowRight');
    ok('keyboard: the arrows move to the next picture', (await p.evaluate(() => document.activeElement?.dataset?.scene)) === 'snowflakes');
    await p.keyboard.press('Enter'); await p.waitForTimeout(400);
    ok('…and Enter chooses it', (await p.evaluate(() => JSON.parse(localStorage.getItem('kt.settings')).animBg)) === 'scene:snowflakes');
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

  /* ---------- Night snowfall: a composition ---------- */
  {
    const { p, ctx, errs, snap } = await open(PC, { settings: { theme: 'frost', uiMode: 'dark', animBg: 'scene:night-snowfall' } });
    ok('Night snowfall: the engine settled', await waitFor(p, (w) => document.getElementById('kt-animbg')?.dataset.engine === w, WANT_ENGINE, 6000), await snap());
    ok('Night snowfall: running', await waitState(p, 'running', 4000));
    if (HAVE) {
      const perf = await p.evaluate(() => window.__ktAnimPerf());
      ok('static layers composited into canvases once (sky, moon, ridges, hills), snow as instances', perf.scene && perf.scene.statics >= 2 && perf.scene.instances > 500, perf.scene);
      const d0 = (await snap()).sprites; await p.waitForTimeout(800); const d1 = (await snap()).sprites;
      ok('the snow moves (sprites drawn each frame)', d1 - d0 > 1000, { d0, d1 });
      // (The sky, at the top of the window: the scene's own palette — a deep blue, not the theme's grey ground.)
      const top = await p.evaluate(() => { const cv = document.querySelector('#kt-animbg .abg-canvas'); const d = cv.getContext('2d').getImageData(Math.round(cv.width * 0.3), 6, 1, 1).data; return [d[0], d[1], d[2]]; });
      ok('its own palette: a night-blue sky', top[2] > top[0] + 6 && top[2] > top[1], top);
    }
    ok('no page errors (snow)', !errs.length, errs); await ctx.close();
  }

  /* ---------- 4. a trap ---------- */
  if (HAVE) {
    const { p, ctx, errs, snap } = await open(PC, { settings: { theme: 'frost', uiMode: 'dark', animBg: 'scene:night-snowfall' }, trapAfter: 25 });
    ok('a trap: «drift» drawn instead', await waitFor(p, () => document.getElementById('kt-animbg')?.dataset.fallback === 'drift', null, 8000), await snap());
    ok('…running, drawing', (await waitState(p, 'running', 3000)) && (await drawsIn(p, 900)) > 3);
    const s = await snap();
    ok('…one quiet line saying the engine stopped, no error', s.info.filter((x) => /scene engine stopped/.test(x)).length === 1, s.info);
    ok('…the scene let go in the engine', (await p.evaluate(() => window.__ktAnimPerf.liveScenes())) === 0);
    ok('…one canvas still, the scrim taken off the page', s.hostCanvases === 1 && !(await p.evaluate(() => document.documentElement.classList.contains('abg-scene'))));
    // (Chosen again later: a new engine instance runs it.)
    await p.evaluate(() => { window.__ktSceneTrapAfter = undefined; });
    await p.goto(base + '#/settings/appearance'); await p.waitForSelector('#appearance'); await choose(p, T.motes);
    ok('chosen again: a new engine runs the scene', await waitFor(p, () => document.getElementById('kt-animbg')?.dataset.engine === 'scene', null, 6000), await snap());
    ok('no page errors (trap)', !errs.length, errs); await ctx.close();
  }

  /* ---------- 5. readability, on the real text: EVERY scene, dark and light, running and still ---------- */
  if (HAVE) {
    // (What the scene's pixels and the real text give: the lowest text contrast over the scene and its panels; any yellow;
    //  `detail` — the share of pixels standing ≥ 1.3:1 off their own row's median (stars, flakes, glows, silhouettes,
    //  shafts: what the scene draws on its sky) — and `span` — the 2nd to 98th percentile's contrast (the sky's depth).)
    const READ = () => {
      const cv = document.querySelector('#kt-animbg .abg-canvas'); const k = cv.width / (innerWidth + 32); const img = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
      const cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
      const parse = (s) => { let m = /rgba?\(([^)]+)\)/.exec(s); if (m) { const v = m[1].split(/[ ,/]+/).filter(Boolean).map(parseFloat); return [v[0], v[1], v[2], v[3] ?? 1]; } m = /color\(srgb ([^)]+)\)/.exec(s); if (m) { const v = m[1].split(/[ /]+/).filter(Boolean).map(parseFloat); return [v[0] * 255, v[1] * 255, v[2] * 255, v[3] ?? 1]; } return [0, 0, 0, 0]; };
      const over = (t, u) => [t[0] * t[3] + u[0] * (1 - t[3]), t[1] * t[3] + u[1] * (1 - t[3]), t[2] * t[3] + u[2] * (1 - t[3]), 1];
      let w = 99, at = null, n = 0; const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let node;
      while ((node = walker.nextNode())) {
        if (!node.nodeValue.trim()) continue; const el = node.parentElement; if (!el || el.closest('#kt-animbg,script,style,[hidden],[aria-hidden="true"]')) continue;
        const st = getComputedStyle(el); if (st.visibility === 'hidden' || +st.opacity === 0) continue;
        const range = document.createRange(); range.selectNodeContents(node); const rr = range.getBoundingClientRect();
        if (rr.width < 2 || rr.height < 2 || rr.top < 0 || rr.left < 0 || rr.bottom > innerHeight || rr.right > innerWidth) continue;
        // (The scene under the text, averaged — the local mean the rule speaks of.)
        let sum = [0, 0, 0], c = 0; const x0 = Math.floor((rr.left + 16) * k), x1 = Math.ceil((rr.right + 16) * k), y0 = Math.floor((rr.top + 16) * k), y1 = Math.ceil((rr.bottom + 16) * k);
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const j = (y * cv.width + x) * 4; sum[0] += img[j]; sum[1] += img[j + 1]; sum[2] += img[j + 2]; c++; }
        if (!c) continue; let back = [sum[0] / c, sum[1] / c, sum[2] / c, 1];
        // (Every panel between, outermost first, composited over it: its colour, then a flat colour laid over it as a
        //  background image — the scenes' veil on themed surfaces.)
        const chain = []; for (let a = el; a && a !== document.documentElement; a = a.parentElement) chain.push(a);
        for (const a of chain.reverse()) { const cs = getComputedStyle(a); back = over(parse(cs.backgroundColor), back); const m = /^linear-gradient\((rgba?\([^)]*\)|color\([^)]*\)), \1\)$/.exec(cs.backgroundImage); if (m) back = over(parse(m[1]), back); }
        // (Text with the scenes' halo: its soft shadow in the veil colour counted as the host counts it, 0.35.)
        if (el.closest('[data-abg-halo]')) { const g = getComputedStyle(document.documentElement).getPropertyValue('--abg-g').trim().split(/\s+/).map(Number); if (g.length === 3) back = over([g[0], g[1], g[2], 0.35], back); }
        const fg = parse(st.color); if (fg[3] < 0.05) continue; const ratio = cr(over(fg, back), back); n++;
        if (ratio < w) { w = ratio; at = { text: node.nodeValue.trim().slice(0, 30), ratio: +ratio.toFixed(2), back: back.map(Math.round), fg: fg.map((v) => +v.toFixed(2)) }; }
      }
      const yel = []; const ls = []; let detail = 0, cnt = 0;
      for (let y = 0; y < cv.height; y += 2) {
        const row = []; for (let x = 0; x < cv.width; x += 2) { const j = (y * cv.width + x) * 4; row.push(lum([img[j], img[j + 1], img[j + 2]])); }
        const med = [...row].sort((a, b) => a - b)[row.length >> 1];
        for (let x = 0; x < row.length; x++) { const L = row[x]; ls.push(L); cnt++; if ((Math.max(L, med) + 0.05) / (Math.min(L, med) + 0.05) >= 1.3) detail++;
          const j = (y * cv.width + x * 2) * 4; const px = [img[j], img[j + 1], img[j + 2]]; const mx = Math.max(...px), mn = Math.min(...px);
          if ((mx - mn) / 255 > 0.08) { let h = mx === px[0] ? ((px[1] - px[2]) / (mx - mn)) % 6 : mx === px[1] ? (px[2] - px[0]) / (mx - mn) + 2 : (px[0] - px[1]) / (mx - mn) + 4; h *= 60; if (h < 0) h += 360; if (h >= 42 && h <= 68 && yel.length < 3) yel.push([...px, Math.round(h)]); } }
      }
      ls.sort((a, b) => a - b); const lo = ls[Math.floor(ls.length * 0.02)], hi = ls[Math.floor(ls.length * 0.98)];
      return { w: +w.toFixed(2), at, n, yel, detail: +(detail / cnt).toFixed(4), span: +((hi + 0.05) / (lo + 0.05)).toFixed(2) };
    };
    // (Per scene, what «clearly visible» means: the least share of standing-out pixels and the least depth of the sky,
    //  about half of what each scene measured here when it was made — sparse skies ask less, busy ones more.)
    const SEEN = {
      'motes': [0.002, 1.15], 'night-snowfall': [0.025, 1.8], 'aurora-lake': [0.04, 2], 'snowflakes': [0.003, 1.3], 'blizzard': [0.025, 1.6], 'first-snow': [0.025, 1.6], 'rain': [0.004, 1.15],
      'waves': [0.012, 1.3], 'underwater': [0.0005, 1.3], 'fireflies': [0.003, 1.5], 'starfield': [0.0012, 1.2], 'meteors': [0.007, 1.6], 'petals': [0.007, 1.5], 'neon-night': [0.002, 1.15],
    };
    const IDS = Object.keys(SEEN); const worst = []; const yellow = []; const seen = [];
    const ACC = ['graphite', 'teal', 'violet', 'gold']; const ROUTES = ['#/', '#/settings/appearance'];
    let i = 0;
    for (const id of IDS) for (const mode of ['dark', 'light']) {
      const accent = ACC[i % ACC.length], route = ROUTES[i % 2], other = ROUTES[(i + 1) % 2]; i++;
      const { p, ctx, errs } = await open(PC, { settings: { theme: 'frost', uiMode: mode, accent, animBg: `scene:${id}` } }, route);
      await waitState(p, 'running', 6000); await p.waitForTimeout(3000);
      const r = await p.evaluate(READ);
      // (Still — «less motion» —, then another view: the scrim measured again for it without a running frame.)
      await p.emulateMedia({ reducedMotion: 'reduce' }); await waitState(p, 'still', 3000);
      await p.evaluate((h) => { location.hash = h; }, other); await p.waitForTimeout(3200);
      const q = await p.evaluate(READ);
      const tag = `${id} ${mode} ${accent}`;
      worst.push(`${id}/${mode}: ${r.w} running (${route}) · ${q.w} still (${other})`);
      ok(`${tag} running ${route}: every text ≥ 4.5:1 over the scene and its panels (lowest ${r.w}, ${r.n} texts)`, r.w >= 4.5 && r.n > 20, r);
      ok(`${tag} still, after going to ${other}: every text ≥ 4.5:1 (lowest ${q.w}, ${q.n} texts)`, q.w >= 4.5 && q.n > 20, q);
      const [dMin, sMin] = SEEN[id];
      ok(`${tag}: clearly visible — ${(r.detail * 100).toFixed(2)} % of pixels stand out (≥ ${(dMin * 100).toFixed(1)}), sky depth ${r.span}:1 (≥ ${sMin})`, r.detail >= dMin && r.span >= sMin, { detail: r.detail, span: r.span });
      seen.push(`${id}/${mode} ${(r.detail * 100).toFixed(2)}% ${r.span}`);
      if (r.yel.length || q.yel.length) yellow.push({ id, mode, accent, px: [...r.yel, ...q.yel] });
      ok(`no page errors (${tag})`, !errs.length, errs); await ctx.close();
    }
    console.log('     lowest text contrast: ' + worst.join(' | '));
    console.log('     visible (detail, depth): ' + seen.join(' | '));
    ok('no yellow, amber or gold in any scene, dark or light, running or still', !yellow.length, yellow);
  }

  /* ---------- 5b. a scene running while the views change: nothing of the old views kept, no static canvas remade
     for a click's zoom or an unchanged resize; a drag-resize remakes them once it rests ---------- */
  if (HAVE) {
    const { p, ctx, errs } = await open(PC, { settings: { theme: 'frost', uiMode: 'dark', animBg: 'scene:night-snowfall', animBgReact: 'lively' } });
    await waitState(p, 'running', 6000); await p.waitForTimeout(3000);
    const routes = ['#/settings/appearance', '#/', '#/settings', '#/', '#/settings/appearance', '#/settings'];
    const t0 = await p.evaluate(() => window.__ktAnimPerf.touched()); const nodes = [];
    for (let k = 0; k < 24; k++) { await p.evaluate((h) => { location.hash = h; }, routes[k % routes.length]); await p.waitForTimeout(k % 6 === 5 ? 3000 : 900); if (k % 6 === 5) nodes.push(await p.evaluate(() => window.__ktAnimPerf.touched())); }
    ok('views changed 24 times: no element the scene marked has left the page, and the marked sets do not grow', nodes.every((x) => x.gone === 0) && nodes[3].bare <= nodes[0].bare + 2 && nodes[3].halos <= nodes[0].halos + 40 && nodes[3].panels <= nodes[0].panels + 40, { t0, nodes });
    const builds = async () => (await p.evaluate(() => window.__ktAnimPerf())).scene.builds;
    await p.evaluate(() => { location.hash = '#/'; }); await p.waitForTimeout(3200);
    const b0 = await builds();
    for (let k = 0; k < 3; k++) { await p.evaluate((x) => window.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: 400, bubbles: true })), 600 + k * 40); await p.waitForTimeout(600); }
    await p.waitForTimeout(400); const b1 = await builds();
    ok('Lively clicks (the zoom pulse): no static canvas made again', b1 === b0, { b0, b1 });
    await p.evaluate(() => { for (let k = 0; k < 10; k++) window.dispatchEvent(new Event('resize')); }); await p.waitForTimeout(700);
    const b2 = await builds(); ok('resize events with the size unchanged: nothing made again', b2 === b1, { b1, b2 });
    for (let k = 0; k < 8; k++) { await p.setViewportSize({ width: 1180 + k * 15, height: 760 + k * 6 }); await p.waitForTimeout(40); }
    const b3 = await builds(); await p.waitForTimeout(900); const b4 = await builds();
    ok('a window dragged larger: the old canvases scaled meanwhile, made again once (or twice: the scrim) when it rests', b3 - b2 <= 1 && b4 - b2 >= 1 && b4 - b2 <= 3, { b2, b3, b4 });
    ok('no page errors (5b)', !errs.length, errs); await ctx.close();
  }

  /* ---------- 6. the page round a scene: where it shows, the app's colours, the mouse ---------- */
  {
    const { p, ctx, errs } = await open(PC, { settings: { theme: 'frost', uiMode: 'dark', animBg: 'scene:aurora-lake' } }, '#/settings/appearance');
    await p.waitForSelector('#appearance'); await p.waitForTimeout(400);
    const has = async (txt) => (await p.locator('#appearance .row', { hasText: txt }).count()) > 0;
    ok(`a scene chosen (PC, ${LANG}): «${T.where}», «${T.tint}» and «${T.react}» offered`, (await has(T.where)) && (await has(T.tint)) && (await has(T.react)));
    // (Clicks are listened to only while the scene answers the mouse: Subtle by default, none with Off.)
    const cdp = await ctx.newCDPSession(p);
    const downs = async () => { const { result } = await cdp.send('Runtime.evaluate', { expression: 'window' }); const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId }); return listeners.filter((l) => l.type === 'pointerdown').length; };
    const d1 = await downs();
    await p.locator('#appearance .row', { hasText: T.react }).first().locator('.pick-btn').click(); await p.waitForTimeout(250);
    await p.locator('.sheet .dest-row').nth(0).locator('input').click(); await p.waitForTimeout(800);
    const d0 = await downs();
    ok('«Reacts to the mouse» Off: no click listener of the scene (Subtle: one more)', d1 === d0 + 1, { subtle: d1, off: d0 });
    ok('no page errors (6a)', !errs.length, errs); await ctx.close();
  }
  if (HAVE) {
    const { p, ctx, errs } = await open(PC, { settings: { theme: 'frost', uiMode: 'dark', accent: 'teal', animBg: 'scene:night-snowfall' } });
    await waitState(p, 'running', 6000); await p.waitForTimeout(3000);
    const look = () => p.evaluate(() => { const h = document.documentElement; const cs = getComputedStyle(h); const rail = document.querySelector('.nav-rail'); return { cls: h.className, primary: cs.getPropertyValue('--md-primary').trim(), style: !!document.getElementById('kt-abg-ui'), railP: rail?.style.getPropertyValue('--abg-p') ?? '', railBf: rail ? getComputedStyle(rail).backdropFilter : '' }; });
    const a = await look();
    ok('whole window (the default): the sidebar is a panel over the scene, measured (its own veil)', /abg-whole/.test(a.cls) && a.railP !== '' && !/abg-content/.test(a.cls), a);
    // (Match the app's colours: on, the scene's accent on the theme's tokens; off again, the reader's accent exactly.)
    await p.goto(p.url().replace(/#.*$/, '#/settings/appearance')); await p.waitForSelector('#appearance'); await p.waitForTimeout(600);
    const tintBox = () => p.locator('#appearance .row', { hasText: T.tint }).first().locator('input[type=checkbox]');
    await tintBox().click(); await p.waitForTimeout(1000);
    const b = await look();
    const ratio = await p.evaluate(() => { const c = (v) => { const d = document.createElement('div'); d.style.color = v; document.body.append(d); const m = getComputedStyle(d).color.match(/[\d.]+/g).map(Number); d.remove(); return m; }; const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; const L = (x) => 0.2126 * lin(x[0]) + 0.7152 * lin(x[1]) + 0.0722 * lin(x[2]); const cs = getComputedStyle(document.documentElement); const p = c(cs.getPropertyValue('--md-primary')), g = c(cs.getPropertyValue('--md-surface')); const x = L(p), y = L(g); const mx = Math.max(...p), mn = Math.min(...p); let hue = 0; if (mx > mn) { hue = mx === p[0] ? ((p[1] - p[2]) / (mx - mn)) % 6 : mx === p[1] ? (p[2] - p[0]) / (mx - mn) + 2 : (p[0] - p[1]) / (mx - mn) + 4; hue = (hue * 60 + 360) % 360; } return { cr: (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05), hue }; });
    ok('Match colours on: the scene\'s accent on the tokens, ≥ 4.5:1 on the ground, no yellow, amber or orange', /abg-tint/.test(b.cls) && b.style && b.primary !== a.primary && ratio.cr >= 4.5 && !(ratio.hue >= 20 && ratio.hue <= 70), { a: a.primary, b: b.primary, ratio });
    await tintBox().click(); await p.waitForTimeout(800);
    const c = await look();
    ok('…off again: the reader\'s own accent back exactly, nothing of the scene left on the tokens', !/abg-tint/.test(c.cls) && !c.style && c.primary === a.primary, { before: a.primary, after: c.primary });
    // (Content area only: the sidebar and the bars keep the theme's own surfaces.)
    await p.locator('#appearance .row', { hasText: T.where }).first().locator('.pick-btn').click(); await p.waitForTimeout(250);
    await p.locator('.sheet .dest-row').nth(1).locator('input').click(); await p.waitForTimeout(800);
    const d = await look();
    ok('«Content area only»: the sidebar is the theme\'s own surface again, no glass over the scene', /abg-content/.test(d.cls) && d.railBf === 'none', d);
    ok('no page errors (6b)', !errs.length, errs); await ctx.close();
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
