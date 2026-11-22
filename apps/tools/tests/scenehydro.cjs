// node tests/scenehydro.cjs: the «Hydro» wallpaper (src/theme/scenes/hydro.json, ktscene/1, data only — the engine's
// existing kinds: a mirror, glints, ring sprites that grow on a click, caustics and motes pushed by the pointer and a
// click). Two paths, as tests/scene.cjs:
//  - always: Appearance lists it in «Rain and water» with its name (en, ar), its picture drawn; the mixer takes it as a
//    base (cleaned as it is, composed within the budget); chosen without the engine, «drift» quietly instead;
//  - the wasm present (dist/scene/ktscene.wasm or KT_SCENE_WASM): dark and light both draw non-blank, changing frames;
//    two clicks change the frames round them more than elsewhere (rings spreading, caustics pushed); «less motion» gives
//    a still frame (no more drawing); its script time and long frames within the bounds scene.cjs holds Motes to.
//  KT_SCENE_REQUIRED=1 (the release workflow): the wasm missing is a failure. KT_SHOTS=<dir>: U2-hydro-dark.png,
//  U2-hydro-light.png, U2-hydro-rings.png (just after two clicks) written there.
// (What the engine itself does with the file — read with nothing unknown, three rings a click, all gone in five
//  seconds — is checked natively: core/kt-scene, cargo test, hydro_rings_from_a_click.)
// Only loopback, made-up data. Run: NODE_PATH=$(npm root -g) node tests/scenehydro.cjs [en|ar]
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
const T = { en: { row: 'Animated background', scene: 'Scene', hydro: 'Hydro', water: 'Rain and water' }, ar: { row: 'خلفيّةٌ متحرّكة', scene: 'مشهد', hydro: 'صفحةُ الماء', water: 'المطرُ والماء' } }[LANG];

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
  console.log(HAVE ? `wasm present (${fs.statSync(WASM).size} bytes): the engine's path` : 'wasm absent: the picker, the mixer and the fallback only');
  if (REQUIRED && !HAVE) { console.log('FAIL KT_SCENE_REQUIRED=1 and no ktscene.wasm'); process.exit(1); }
  const SHOTS = process.env.KT_SHOTS ? path.resolve(process.env.KT_SHOTS) : null; if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`; const br = await chromium.launch();
  const open = async (o, opts, route = '#/') => {
    const ctx = await br.newContext(o); const p = await ctx.newPage(); const errs = [];
    p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 404, body: '' }));
    await p.addInitScript(init, { lang: LANG, ...opts }); await p.goto(base + route); await p.waitForSelector('.view, .mini-view, body'); await p.waitForTimeout(700);
    return { p, ctx, errs, snap: () => p.evaluate(() => window.__snap()) };
  };
  const waitFor = (p, fn, arg, ms = 4000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);
  const waitState = (p, want, ms = 4000) => waitFor(p, (w) => (document.getElementById('kt-animbg')?.dataset.state ?? null) === w, want, ms);
  // (The scene canvas: its pixels' luminance spread and a box's mean change between two reads.)
  const grab = (p) => p.evaluate(() => { const cv = document.querySelector('#kt-animbg .abg-canvas'); if (!cv || !cv.width) return null; const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; return { w: cv.width, h: cv.height, d: Array.from(d) }; });
  const lum = (d, j) => (0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2]) / 255;
  const spread = (g) => { const ls = []; for (let j = 0; j < g.d.length; j += 4 * 7) ls.push(lum(g.d, j)); ls.sort((a, b) => a - b); return (ls[Math.floor(ls.length * 0.98)] + 0.05) / (ls[Math.floor(ls.length * 0.02)] + 0.05); };
  const boxDiff = (a, b, cx, cy, bw, bh) => { let s = 0, n = 0; const x0 = Math.max(0, Math.round((cx - bw / 2) * a.w)), x1 = Math.min(a.w, Math.round((cx + bw / 2) * a.w)), y0 = Math.max(0, Math.round((cy - bh / 2) * a.h)), y1 = Math.min(a.h, Math.round((cy + bh / 2) * a.h));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const j = (y * a.w + x) * 4; s += Math.abs(a.d[j] - b.d[j]) + Math.abs(a.d[j + 1] - b.d[j + 1]) + Math.abs(a.d[j + 2] - b.d[j + 2]); n++; } return n ? s / n : 0; };

  /* ---------- 1. the picker and the mixer ---------- */
  {
    const { p, ctx, errs } = await open(PC, { settings: { theme: 'frost', uiMode: 'dark', animBg: 'scene:waves' } }, '#/settings/appearance');
    await p.waitForSelector('#appearance');
    const tile = p.locator('#appearance .abg-group', { hasText: T.water }).locator('.abg-tile[data-scene="hydro"]');
    ok(`«${T.hydro}» in «${T.water}»`, (await tile.count()) === 1 && (await tile.innerText()).includes(T.hydro), await tile.count());
    ok('…its picture drawn', await waitFor(p, () => !!document.querySelector('#appearance .abg-tile[data-scene="hydro"] .abg-thumb.drawn'), null, 45000));
    const mix = await p.evaluate(async () => { const m = await window.__ktAnimPerf.mix(); const c = m.clean({ id: 'hy', name: 'hy', ground: 'night', base: 'hydro', overlays: [{ kind: 'mist', amount: 0.5, size: 1 }], wind: 0 }); const k = c ? m.compose(c) : null; return { base: c?.base, total: k?.total, budget: m.budget, dropped: k?.dropped }; });
    ok('the mixer takes it as a base, within the budget', mix.base === 'hydro' && mix.total > 0 && mix.total <= mix.budget, mix);
    await tile.click(); await p.waitForTimeout(500);
    ok('chosen from its picture', (await p.evaluate(() => JSON.parse(localStorage.getItem('kt.settings')).animBg)) === 'scene:hydro');
    if (!HAVE) { const s = await p.evaluate(() => window.__snap()); ok('without the engine: «drift» quietly instead (one line, no error)', s.info.filter((x) => /scene engine unavailable/.test(x)).length === 1, s.info); }
    ok('no page errors (1)', !errs.length, errs); await ctx.close();
  }

  /* ---------- 2. the engine's path: dark and light, clicks, still, budget ---------- */
  if (HAVE) {
    for (const mode of ['dark', 'light']) {
      const { p, ctx, errs } = await open(PC, { settings: { theme: 'frost', uiMode: mode, animBg: 'scene:hydro' } });
      ok(`${mode}: running on the engine`, await waitState(p, 'running', 6000) && (await p.evaluate(() => document.getElementById('kt-animbg')?.dataset.engine)) === 'scene');
      await p.waitForTimeout(1500);
      const a = await grab(p); await p.waitForTimeout(700); const b = await grab(p);
      ok(`${mode}: not blank (luminance spread ${a && spread(a).toFixed(2)}:1, ≥ 1.15)`, a && spread(a) >= 1.15);
      ok(`${mode}: frames change`, a && b && boxDiff(a, b, 0.5, 0.5, 1, 1) > 0);
      if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `U2-hydro-${mode}.png`) });
      if (mode === 'dark') {
        // (Two clicks on the bare background (as scene.cjs gives them: on the window), low left; their neighbourhood compared with a box as large on the right.)
        const vw = 1280, vh = 800; const pts = [[0.2, 0.72], [0.3, 0.8]];
        const c0 = await grab(p);
        for (const [x, y] of pts) { await p.evaluate(([cx, cy]) => window.dispatchEvent(new PointerEvent('pointerdown', { clientX: cx, clientY: cy, bubbles: true })), [Math.round(x * vw), Math.round(y * vh)]); await p.waitForTimeout(150); }
        await p.waitForTimeout(1300); const c1 = await grab(p);
        if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'U2-hydro-rings.png') });
        const near = boxDiff(c0, c1, 0.25, 0.76, 0.3, 0.3), far = boxDiff(c0, c1, 0.85, 0.76, 0.2, 0.3);
        ok(`two clicks: the frames change round them more than elsewhere (${near.toFixed(2)} vs ${far.toFixed(2)})`, near > far * 1.2 && near > 0.5, { near, far });
        // (The budget, as scene.cjs holds Motes to it: script under 40 ms a second headless, long frames under 10 %.)
        const cdp = await ctx.newCDPSession(p); await cdp.send('Performance.enable'); const m = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
        await p.evaluate(() => { window.__fr = []; let last = 0; const f = (t) => { if (last) window.__fr.push(t - last); last = t; if (window.__frOn) requestAnimationFrame(f); }; window.__frOn = true; requestAnimationFrame(f); });
        const m0 = await m(); await p.waitForTimeout(5000); const m1 = await m(); const fr = await p.evaluate(() => { window.__frOn = false; return window.__fr; });
        const script = (m1.ScriptDuration - m0.ScriptDuration) * 200; const long = fr.filter((x) => x > 50).length; const perf = await p.evaluate(() => window.__ktAnimPerf());
        console.log(`     hydro: script ${script.toFixed(1)} ms/s · ${perf?.fps} fps · step ${perf?.scene?.stepMs?.toFixed?.(3)} ms · draw ${perf?.scene?.drawMs?.toFixed?.(2)} ms · ${perf?.scene?.instances} instances`);
        ok('budget: script under 40 ms a second (headless, the guard scene.cjs holds Motes to)', script < 40, { script });
        ok('budget: long frames (> 50 ms) under 10 %', long <= Math.max(3, fr.length * 0.1), { long, frames: fr.length });
        // («Less motion»: a still frame, nothing drawn after it.)
        await p.emulateMedia({ reducedMotion: 'reduce' }); const still = await waitState(p, 'still', 3000);
        await p.waitForTimeout(400); const d0 = (await p.evaluate(() => window.__snap())).draws; await p.waitForTimeout(1200); const d1 = (await p.evaluate(() => window.__snap())).draws;
        const s0 = await grab(p);
        ok('less motion: still, one frame kept, nothing drawn after', still && d1 === d0 && s0 && spread(s0) >= 1.15, { still, d0, d1 });
      }
      ok(`no page errors (${mode})`, !errs.length, errs); await ctx.close();
    }
  }

  await br.close(); web.close();
  if (!HAVE) console.log('wasm absent: the engine\'s path (dark, light, clicks, still, budget) runs once dist/scene/ktscene.wasm exists (CI)');
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
