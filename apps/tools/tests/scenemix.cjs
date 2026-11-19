// node tests/scenemix.cjs [en|ar]: the background MIXER (src/theme/sceneMix.ts, src/views/mixer.ts) on a computer.
//  1. the composing rules, in the page (the perf flag's hook): every preset within the shared particle budget and the
//     engine's caps; a heavy base with two full overlays scaled down to the budget, the base kept whole; an overlay at
//     amount 0 adds nothing; a saved mix is never trusted — ranges clamped, unknown kinds and grounds dropped, at most two
//     overlays, names cut and cleaned, bad ids and empty names refused, at most 24 kept, duplicates and preset ids out;
//     each overlay kind, and the heaviest mix, loaded in the engine;
//  2. each Snowy and Rainy preset chosen as the background, in light and in dark: the engine draws it (no fallback, no
//     page error), every text at 4.5:1 or more over it, no yellow;
//  3. the picker: the presets' groups, «Mix your own»; the sheet: a live preview, the controls (own sliders, no number
//     spinners, buttons of one width that do not touch, the footer not over the last row); saved as a named preset, then
//     renamed, deleted (with Undo); a stored mix with junk shown cleaned, a missing one falling back quietly;
//  4. «less motion»: the sheet's preview still; the sheet opened and closed five times: no listener, observer, timer,
//     frame, canvas or engine scene left;
//  5. a phone: no mixer (the animated backgrounds are a computer's).
// Without the wasm (built in CI only) the engine parts are skipped and said so. Only loopback, made-up data.
// Run: NODE_PATH=$(npm root -g) KT_SCENE_WASM=<ktscene.wasm> node tests/scenemix.cjs [en|ar]
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
  en: { snowy: 'Snowy mixes', rainy: 'Rainy mixes', mine: 'Your mixes', newMix: 'Mix your own', title: 'Mix your own background', save: 'Save as preset', coldLight: 'Cold light snowflakes', particles: /^Particles: \d+ of 1600$/ },
  ar: { snowy: 'خلفيّاتٌ ثلجيّةٌ ممزوجة', rainy: 'خلفيّاتٌ ماطرةٌ ممزوجة', mine: 'ما مزجتَه', newMix: 'امزُجْ خلفيّتَك', title: 'امزُجْ خلفيّتَك', save: 'احفظْه مزيجًا جاهزًا', coldLight: 'نُدَفُ الثلجِ في ضوءٍ بارد', particles: /^الجسيمات \(العدد: \d+ من 1600\)$/ },
}[LANG];
const PRESETS = ['cold-light', 'night-snow', 'blizzard-dusk', 'frosted-window', 'aurora-snow', 'first-snow', 'soft-rain', 'night-rain'];

/** In the page before anything runs: settings, the desktop bridge (or the phone's plugin), the counters (as scene.cjs). */
function init({ settings, phone, lang }) {
  localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.pc.starter', '1'); localStorage.setItem('kt.update.lastCheck', String(Date.now())); localStorage.setItem('kt.themeMigrated', '1'); localStorage.setItem('kt.mainTheme', '1');
  localStorage.setItem('kt.settings', JSON.stringify({ themeChosen: true, autoUpdateCheck: false, ...settings }));
  localStorage.setItem('kt.anim.perf', '1');
  const c = (window.__abg = { listeners: 0, observers: 0, timers: new Set(), rafs: new Set(), info: [] });
  const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener; const seen = new WeakMap();
  const counted = (t) => t === window || t === document || t instanceof MediaQueryList;
  EventTarget.prototype.addEventListener = function (ty, f, o) { if (counted(this) && f) { const k = ty + (typeof o === 'boolean' ? o : !!o?.capture); let m = seen.get(this); if (!m) seen.set(this, (m = new Map())); let s = m.get(k); if (!s) m.set(k, (s = new Set())); if (!s.has(f)) { s.add(f); c.listeners++; } } return add.call(this, ty, f, o); };
  EventTarget.prototype.removeEventListener = function (ty, f, o) { if (counted(this) && f) { const k = ty + (typeof o === 'boolean' ? o : !!o?.capture); const s = seen.get(this)?.get(k); if (s?.delete(f)) c.listeners--; } return rem.call(this, ty, f, o); };
  const MO = window.MutationObserver; window.MutationObserver = class extends MO { constructor(...a) { super(...a); this.__on = false; } observe(...a) { if (!this.__on) { this.__on = true; c.observers++; } return super.observe(...a); } disconnect() { if (this.__on) { this.__on = false; c.observers--; } return super.disconnect(); } };
  const mine_ = (f) => typeof f === 'function' && /\.tick\b|unfocused|\.raf2?\s*=\s*0|timer = 0; if \(gone\)/.test(String(f));
  const st = window.setTimeout, ct = window.clearTimeout;
  window.setTimeout = function (f, ms, ...a) { if (!mine_(f)) return st.call(window, f, ms, ...a); const id = st.call(window, (...b) => { c.timers.delete(id); f(...b); }, ms, ...a); c.timers.add(id); return id; };
  window.clearTimeout = function (id) { c.timers.delete(id); return ct.call(window, id); };
  const ra = window.requestAnimationFrame, ca = window.cancelAnimationFrame;
  window.requestAnimationFrame = function (f) { if (!mine_(f)) return ra.call(window, f); const id = ra.call(window, (t) => { c.rafs.delete(id); f(t); }); c.rafs.add(id); return id; };
  window.cancelAnimationFrame = function (id) { c.rafs.delete(id); return ca.call(window, id); };
  const inf = console.info; console.info = function (...a) { c.info.push(a.join(' ')); return inf.apply(console, a); };
  window.__snap = () => ({ listeners: c.listeners, observers: c.observers, timers: c.timers.size, rafs: c.rafs.size, canvases: document.querySelectorAll('.abg-canvas').length, sheets: document.querySelectorAll('.sheet').length, info: c.info.slice() });
  if (phone) { const api = { addListener: () => ({ remove() {} }), list: async () => ({ tasks: [] }) }; window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) }) }, PluginHeaders: [] }; }
  else { const ts = []; for (let i = 0; i < 12; i++) ts.push({ id: 't' + i, kind: 'http', name: `made-up-${i}.mkv`, source: { url: `https://example.test/${i}` }, dir: '/d', state: 'done', done: 9e8, total: 9e8, downSpeed: 0, upSpeed: 0, files: [], addedAt: Date.now() - i * 60000 }); window.kurokawaTools = new Proxy({ platform: 'desktop', available: true, os: 'linux', ready: async () => ({}), list: async () => ts, onTasks: (cb) => { cb(ts); return () => {}; }, defaultDir: async () => '/d' }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) }); }
}

/** The lowest text contrast over the scene and its panels, and any yellow (as tests/scene.cjs measures them). */
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
    let sum = [0, 0, 0], c = 0; const x0 = Math.floor((rr.left + 16) * k), x1 = Math.ceil((rr.right + 16) * k), y0 = Math.floor((rr.top + 16) * k), y1 = Math.ceil((rr.bottom + 16) * k);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const j = (y * cv.width + x) * 4; sum[0] += img[j]; sum[1] += img[j + 1]; sum[2] += img[j + 2]; c++; }
    if (!c) continue; let back = [sum[0] / c, sum[1] / c, sum[2] / c, 1];
    const chain = []; for (let a = el; a && a !== document.documentElement; a = a.parentElement) chain.push(a);
    for (const a of chain.reverse()) { const cs = getComputedStyle(a); back = over(parse(cs.backgroundColor), back); const m = /^linear-gradient\((rgba?\([^)]*\)|color\([^)]*\)), \1\)$/.exec(cs.backgroundImage); if (m) back = over(parse(m[1]), back); }
    if (el.closest('[data-abg-halo]')) { const g = getComputedStyle(document.documentElement).getPropertyValue('--abg-g').trim().split(/\s+/).map(Number); if (g.length === 3) back = over([g[0], g[1], g[2], 0.35], back); }
    const fg = parse(st.color); if (fg[3] < 0.05) continue; const ratio = cr(over(fg, back), back); n++;
    if (ratio < w) { w = ratio; at = { text: node.nodeValue.trim().slice(0, 30), ratio: +ratio.toFixed(2) }; }
  }
  const yel = [];
  for (let y = 0; y < cv.height; y += 3) for (let x = 0; x < cv.width; x += 3) { const j = (y * cv.width + x) * 4; const px = [img[j], img[j + 1], img[j + 2]]; const mx = Math.max(...px), mn = Math.min(...px);
    if ((mx - mn) / 255 > 0.08) { let h = mx === px[0] ? ((px[1] - px[2]) / (mx - mn)) % 6 : mx === px[1] ? (px[2] - px[0]) / (mx - mn) + 2 : (px[0] - px[1]) / (mx - mn) + 4; h *= 60; if (h < 0) h += 360; if (h >= 42 && h <= 68 && yel.length < 3) yel.push([...px, Math.round(h)]); } }
  return { w: +w.toFixed(2), at, n, yel };
};

(async () => {
  console.log(HAVE ? `wasm present: ${path.relative(process.cwd(), WASM)} — the engine's path` : 'wasm absent: the engine parts skipped (dist/scene/ktscene.wasm is built in CI)');
  if (REQUIRED && !HAVE) { console.log('FAIL KT_SCENE_REQUIRED=1 and no ktscene.wasm'); process.exit(1); }
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`; const br = await chromium.launch();
  const open = async (o, opts, route = '#/') => {
    const ctx = await br.newContext(o); const p = await ctx.newPage(); const errs = [];
    p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 404, body: '' }));
    await p.addInitScript(init, { lang: LANG, ...opts }); await p.goto(base + route); await p.waitForSelector('.view, body'); await p.waitForTimeout(600);
    return { p, ctx, errs, snap: () => p.evaluate(() => window.__snap()) };
  };
  const waitFor = (p, fn, arg, ms = 6000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);
  const settings = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('kt.settings')));

  /* ---------- 1. the composing rules ---------- */
  {
    const { p, ctx, errs } = await open(PC, { settings: { theme: 'frost', uiMode: 'dark', animBg: 'scene:motes' } });
    await waitFor(p, () => !!window.__ktAnimPerf?.mix);
    const r = await p.evaluate(async () => {
      const M = await window.__ktAnimPerf.mix(); const out = {};
      out.presets = M.presets.map((m) => ({ id: m.id, ...M.compose(m) }));
      // (The heaviest base, two full overlays at the largest size: scaled down; the base's own emitters untouched.)
      const heavy = { id: 'heavy', name: 'Heavy', ground: 'dusk', base: 'blizzard', overlays: [{ kind: 'snow', amount: 1, size: 2 }, { kind: 'frost', amount: 1, size: 2 }], wind: 1 };
      out.heavy = M.compose(heavy); out.blizzard = M.compose({ ...heavy, overlays: [] });
      out.zero = M.compose({ ...heavy, overlays: [{ kind: 'snow', amount: 0, size: 1 }] });
      out.none = M.compose({ id: 'n', name: 'N', ground: 'scene', base: 'none', overlays: [{ kind: 'rain', amount: 1, size: 1 }], wind: 0 });
      out.clamped = M.clean({ id: 'a1', name: '  Bad\u0000 ‮name\n' + 'x'.repeat(80), ground: 'lava', base: '../../etc', overlays: [{ kind: 'snow', amount: 9, size: -3 }, { kind: 'fire' }, { kind: 'rain', amount: NaN, size: Infinity }, { kind: 'mist' }], wind: 99, extra: '<script>' });
      out.refused = [null, 5, [], { id: '../x', name: 'a' }, { id: 'ok', name: '   ' }, { id: 'ok', name: 5 }, { id: 'A B', name: 'x' }].map((x) => M.clean(x));
      const many = []; for (let i = 0; i < 100; i++) many.push({ id: 'm' + i, name: 'Mix ' + i, ground: 'night', base: 'rain', overlays: [], wind: 0 });
      out.many = M.cleanAll([...many.slice(0, 3), { ...many[0], name: 'dupe' }, { ...many[5], id: 'cold-light' }, 'junk', ...many.slice(3)]).map((m) => m.id);
      out.notArray = M.cleanAll({ 0: many[0] }).length;
      out.budget = M.budget;
      return out;
    }).catch((e) => ({ error: String(e) }));
    ok('the mixer\'s rules reached in the page', !r.error, r.error);
    if (!r.error) {
      ok(`${r.presets.length} presets, each within the budget (${r.budget}) and the engine's caps, nothing left out`, r.presets.length === 8 && r.presets.every((x) => x.total <= r.budget && x.dropped === 0 && x.layers <= 32 && x.emitters.length <= 16 && x.palette <= 32), r.presets.map((x) => [x.id, x.total, x.dropped, x.layers, x.emitters.length, x.palette]));
      ok('…the presets the owner asked for are there', PRESETS.every((id) => r.presets.some((x) => x.id === id)));
      const baseMax = r.blizzard.emitters.reduce((a, e) => a + e[1], 0);
      const kept = r.blizzard.emitters.every(([id, max]) => r.heavy.emitters.some(([i2, m2]) => i2 === id && m2 === max));
      ok(`a heavy mix (Blizzard + two full overlays at ×2): ${r.heavy.total} particles ≤ ${r.budget}, overlays scaled (${r.heavy.scale.toFixed(2)}), the base's ${baseMax} kept whole`, r.heavy.total <= r.budget && r.heavy.scale < 1 && kept, { total: r.heavy.total, scale: r.heavy.scale });
      ok('…its wind given to the engine (±70 units/s at the ends)', r.heavy.wind === 70, r.heavy.wind);
      ok('an overlay at amount 0 adds nothing', r.zero.total === r.blizzard.total && r.zero.layers === r.blizzard.layers, { zero: r.zero.total, base: r.blizzard.total });
      ok('no base scene: a sky of the ground under the overlay', r.none.layers === 3 && r.none.total > 0, r.none);
      const c = r.clamped;
      ok('a saved mix cleaned: unknown ground and base out, amounts and sizes clamped, junk kinds dropped, two overlays at most, wind clamped', c && c.ground === 'frost' && c.base === 'none' && c.overlays.length === 2 && c.overlays[0].kind === 'snow' && c.overlays[0].amount === 1 && c.overlays[0].size === 0.5 && c.overlays[1].kind === 'rain' && c.overlays[1].amount === 0.5 && c.overlays[1].size === 1 && c.wind === 1 && !('extra' in c), c);
      ok('…its name stripped of control and direction marks, cut to 40', c && c.name.length <= 40 && !/[\u0000-\u001f‪-‮]/.test(c.name) && c.name.startsWith('Bad name'), c && c.name);
      ok('not a mix (null, a number, a list, a bad id, an empty or odd name): refused', r.refused.every((x) => x === null), r.refused);
      ok(`at most 24 kept, ids unique, a preset's id refused, junk skipped (${r.many.length})`, r.many.length === 24 && new Set(r.many).size === 24 && !r.many.includes('cold-light') && r.many[3] === 'm3', r.many.slice(0, 6));
      ok('not a list: none', r.notArray === 0);
    }
    if (HAVE) {
      await p.evaluate(() => { window.__ktHave = true; });
      const q = await p.evaluate(async () => { const M = await window.__ktAnimPerf.mix(); const out = []; for (const kind of ['snow', 'flakes', 'rain', 'mist', 'frost', 'petals', 'motes', 'stars', 'bubbles']) { try { const s = await M.load({ id: 'k', name: kind, ground: 'ink', base: 'none', overlays: [{ kind, amount: 1, size: 1.5 }], wind: 0.5 }); out.push([kind, s.live, s.statics]); } catch (e) { out.push([kind, 'ERR ' + e.message]); } }
        try { const s = await M.load({ id: 'heavy', name: 'Heavy', ground: 'dusk', base: 'blizzard', overlays: [{ kind: 'snow', amount: 1, size: 2 }, { kind: 'frost', amount: 1, size: 2 }], wind: 1 }); out.push(['heavy', s.live]); } catch (e) { out.push(['heavy', 'ERR ' + e.message]); }
        return { out, live: await window.__ktAnimPerf.liveScenes() }; });
      ok('the engine loads each overlay kind alone and the heaviest mix (particles live, no trap)', q.out.every(([k, live]) => k === 'mist' ? typeof live === 'number' : typeof live === 'number' && live > 0), q.out);
      ok('…and lets each go (one live scene: the background)', q.live === 1, q.live);
    }
    ok('no page errors (1)', !errs.length, errs); await ctx.close();
  }

  /* ---------- 2. every preset as the background, light and dark ---------- */
  if (HAVE) {
    const yellow = []; const lows = [];
    for (const id of PRESETS) for (const mode of ['light', 'dark']) {
      const { p, ctx, errs, snap } = await open(PC, { settings: { theme: 'frost', uiMode: mode, animBg: `scene:mix:${id}` } });
      const ran = await waitFor(p, () => document.getElementById('kt-animbg')?.dataset.state === 'running' && document.getElementById('kt-animbg')?.dataset.engine === 'scene', null, 8000);
      await p.waitForTimeout(2500);
      const s = await snap(); const r = await p.evaluate(READ);
      ok(`${id} ${mode}: the engine draws it (no fallback)`, ran && !s.info.some((x) => /drawing «drift» instead/.test(x)), s.info);
      ok(`${id} ${mode}: every text ≥ 4.5:1 over it (lowest ${r.w}, ${r.n} texts)`, r.w >= 4.5 && r.n > 20, r.at);
      lows.push(`${id}/${mode} ${r.w}`); if (r.yel.length) yellow.push({ id, mode, px: r.yel });
      ok(`no page errors (${id} ${mode})`, !errs.length, errs); await ctx.close();
    }
    console.log('     lowest text contrast: ' + lows.join(' | '));
    ok('no yellow, amber or gold in any preset', !yellow.length, yellow);
  } else console.log('skip  2. presets in the engine (no wasm)');

  /* ---------- 3–4. the picker and the sheet ---------- */
  {
    const junk = [{ id: 'good1', name: 'Quiet snow', ground: 'night', base: 'first-snow', overlays: [{ kind: 'flakes', amount: 0.5, size: 1 }], wind: 0 }, { id: '../bad', name: 'x' }, { id: 'odd', name: 'Odd', ground: 'lava', base: 'rain', overlays: [{ kind: 'fire', amount: 5 }], wind: 'x' }, 'junk'];
    const { p, ctx, errs, snap } = await open(PC, { settings: { theme: 'frost', uiMode: 'dark', animBg: 'scene:mix:soft-rain', animBgMixes: junk } }, '#/settings/appearance');
    await p.waitForSelector('#appearance');
    ok(`the picker: «${T.snowy}», «${T.rainy}» and «${T.mine}» groups`, (await p.locator('#appearance .abg-group-title', { hasText: T.snowy }).count()) === 1 && (await p.locator('#appearance .abg-group-title', { hasText: T.rainy }).count()) === 1 && (await p.locator('#appearance .abg-group-title', { hasText: T.mine }).count()) === 1);
    ok('…8 preset pictures, the chosen one (Soft rain) marked', (await p.locator('#appearance .abg-tile[data-scene^="mix:"]').count()) >= 8 && (await p.locator('#appearance .abg-tile[aria-checked="true"]').getAttribute('data-scene')) === 'mix:soft-rain');
    await waitFor(p, () => document.querySelectorAll('#appearance .abg-mine .abg-tile[data-scene]').length > 0);
    const mine = await p.evaluate(() => [...document.querySelectorAll('#appearance .abg-mine .abg-tile[data-scene]')].map((b) => [b.dataset.scene, b.textContent]));
    ok('a stored list with junk: only the clean mixes shown (good1, odd)', mine.length === 2 && mine[0][0] === 'mix:good1' && mine[1][0] === 'mix:odd', mine);
    ok(`«${T.newMix}» card there`, (await p.locator('#appearance [data-mix-new]', { hasText: T.newMix }).count()) === 1);
    ok(`a preset's name shown («${T.coldLight}»)`, (await p.locator('#appearance .abg-tile', { hasText: T.coldLight }).count()) === 1);
    if (HAVE) ok('every picture drawn by the engine', await waitFor(p, () => [...document.querySelectorAll('#appearance .abg-tile[data-scene] .abg-thumb')].every((x) => x.classList.contains('drawn') && x.style.backgroundImage.startsWith('url("data:image/')), null, 40000));
    await p.waitForTimeout(300);
    const before = await snap(); const live0 = HAVE ? await p.evaluate(() => window.__ktAnimPerf.liveScenes()) : 0;

    // (The sheet: a live preview, the controls.)
    await p.locator('#appearance [data-mix-new]').click();
    ok(`the sheet «${T.title}» opens`, await waitFor(p, () => !!document.querySelector('.mix-sheet .mix-preview')));
    if (HAVE) ok('…with a live preview drawn by the engine', await waitFor(p, () => document.querySelector('.mix-sheet .mix-preview')?.dataset.engine === 'scene', null, 8000));
    ok('…the particles counted', T.particles.test((await p.locator('.mix-sheet .mix-budget').textContent()).trim()), await p.locator('.mix-sheet .mix-budget').textContent());
    const form = await p.evaluate(() => {
      const sh = document.querySelector('.mix-sheet'); const btns = [...sh.querySelectorAll('.sheet-actions .btn')].map((b) => b.getBoundingClientRect());
      const ws = btns.map((r) => Math.round(r.width)); const byX = [...btns].sort((a, b) => a.left - b.left); let touch = false; for (let i = 1; i < byX.length; i++) if (byX[i].left - byX[i - 1].right < 8) touch = true;
      const body = sh.querySelector('.sheet-body'); body.scrollTop = body.scrollHeight; const last = body.lastElementChild.getBoundingClientRect(); const foot = sh.querySelector('.sheet-actions').getBoundingClientRect();
      const ctrls = [...sh.querySelectorAll('.mix-row, .mix-slider')].map((e) => e.getBoundingClientRect()); let overlap = false; for (let i = 1; i < ctrls.length; i++) if (ctrls[i].top < ctrls[i - 1].bottom - 0.5 && ctrls[i].left < ctrls[i - 1].right && ctrls[i - 1].left < ctrls[i].right) overlap = true;
      return { ws, touch, spinners: sh.querySelectorAll('input[type="number"]').length, checks: sh.querySelectorAll('input[type="checkbox"]').length, ranges: sh.querySelectorAll('input[type="range"]').length, lastBelow: last.bottom <= foot.top + 0.5, overlap };
    });
    ok('own sliders (styled ranges), no number spinner, no checkbox', form.ranges >= 3 && form.spinners === 0 && form.checks === 0, form);
    ok('footer buttons of one width that do not touch; the last row above the footer; no control over another', new Set(form.ws).size === 1 && !form.touch && form.lastBelow && !form.overlap, form);
    // (A choice made: the base, the first overlay's amount; the preview made again.)
    await p.locator('.mix-sheet .mix-row').first().locator('.pick-btn').click(); await p.waitForTimeout(200);
    await p.locator('.sheet.stacked .dest-row').nth(5).locator('input').click(); await p.waitForTimeout(300);
    ok('a stacked choice list closes and leaves the mixer open', (await p.locator('.mix-sheet').count()) === 1 && (await p.locator('.sheet.stacked').count()) === 0);
    await p.locator('.mix-sheet input[data-mix="amount0"]').evaluate((el) => { el.value = '0.9'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    ok('a slider moved: its value said and its track filled', (await p.locator('.mix-sheet input[data-mix="amount0"]').evaluate((el) => el.style.getPropertyValue('--p'))) === '90%');
    await p.locator('.mix-sheet input[data-mix="name"]').fill('  Snow\u0007 ' + 'z'.repeat(60));
    await p.locator('.mix-sheet [data-mix-act="save"]').click(); await p.waitForTimeout(500);
    let s = await settings(p); const saved = (s.animBgMixes || []).find((m) => m && !['good1', 'odd'].includes(m.id));
    ok('Saved as a preset: stored clean (name cut to 40, no control character) and put in use', saved && saved.name.length <= 40 && !/[\u0000-\u001f]/.test(saved.name) && s.animBg === `scene:mix:${saved.id}`, { saved, animBg: s.animBg });
    ok('…the sheet closed, the new mix\'s tile marked, its actions shown', (await p.locator('.mix-sheet').count()) === 0 && await waitFor(p, (id) => document.querySelector('#appearance .abg-tile[aria-checked="true"]')?.dataset.scene === `mix:${id}` && !document.querySelector('.abg-mix-acts').hidden, saved?.id));
    // (Rename, then delete with Undo.)
    await p.locator('.abg-mix-acts .btn').nth(1).click(); await p.waitForSelector('.sheet input[data-mix="rename"]');
    await p.locator('.sheet input[data-mix="rename"]').fill('Calm flakes'); await p.locator('.sheet [data-mix-act="rename"]').click(); await p.waitForTimeout(400);
    s = await settings(p); ok('renamed', (s.animBgMixes || []).some((m) => m.id === saved?.id && m.name === 'Calm flakes'));
    await waitFor(p, () => !document.querySelector('.abg-mix-acts')?.hidden);
    await p.locator('.abg-mix-acts .btn.danger').click(); await p.waitForTimeout(400);
    s = await settings(p); ok('deleted: gone from the list, the background back to its base scene', !(s.animBgMixes || []).some((m) => m.id === saved?.id) && /^scene:(?!mix:)/.test(s.animBg), s.animBg);
    await p.locator('.toast button, .toast .btn').first().click().catch(() => {}); await p.waitForTimeout(400);
    s = await settings(p); ok('…Undo brings it back, in use again', (s.animBgMixes || []).some((m) => m.id === saved?.id) && s.animBg === `scene:mix:${saved?.id}`, s.animBg);
    // (Edit a saved one: «Save changes» keeps its id.)
    await waitFor(p, () => !document.querySelector('.abg-mix-acts')?.hidden);
    await p.locator('.abg-mix-acts .btn').first().click(); await p.waitForSelector('.mix-sheet [data-mix-act="update"]');
    await p.locator('.mix-sheet input[data-mix="wind"]').evaluate((el) => { el.value = '-0.5'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await p.locator('.mix-sheet [data-mix-act="update"]').click(); await p.waitForTimeout(400);
    s = await settings(p); ok('edited: «Save changes» keeps the id, the wind stored', (s.animBgMixes || []).filter((m) => m.id === saved?.id).length === 1 && (s.animBgMixes || []).find((m) => m.id === saved?.id)?.wind === -0.5);

    // (Less motion: the sheet's preview still.)
    await p.emulateMedia({ reducedMotion: 'reduce' });
    await p.locator('#appearance [data-mix-new]').click(); await p.waitForSelector('.mix-sheet .mix-preview');
    if (HAVE) ok('«less motion»: the preview still', await waitFor(p, () => document.querySelector('.mix-sheet .mix-preview')?.dataset.state === 'still', null, 6000), await p.evaluate(() => document.querySelector('.mix-sheet .mix-preview')?.dataset.state));
    await p.keyboard.press('Escape'); await p.waitForTimeout(300); await p.emulateMedia({ reducedMotion: 'no-preference' });

    // (Leaks: opened and closed five times, a change made each time. The background and the page's preview keep running
    //  meanwhile: each holds at most one timer and two frames.)
    await p.waitForTimeout(600); const b2 = await snap(); const live2 = HAVE ? await p.evaluate(() => window.__ktAnimPerf.liveScenes()) : 0;
    for (let i = 0; i < 5; i++) {
      await p.locator('#appearance [data-mix-new]').click(); await p.waitForSelector('.mix-sheet .mix-preview');
      if (HAVE) await waitFor(p, () => document.querySelector('.mix-sheet .mix-preview')?.dataset.engine === 'scene', null, 6000);
      await p.locator('.mix-sheet input[data-mix="wind"]').evaluate((el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, (i - 2) / 4);
      await p.waitForTimeout(i % 2 ? 50 : 500);
      if (i % 2) await p.keyboard.press('Escape'); else await p.locator('.mix-sheet .sheet-head button').click();
      await p.waitForTimeout(350);
    }
    await p.waitForTimeout(600); const after = await snap(); const live3 = HAVE ? await p.evaluate(() => window.__ktAnimPerf.liveScenes()) : 0;
    ok(`the sheet opened and closed five times: no sheet, canvas, listener (${b2.listeners}), observer, timer or frame left`, after.sheets === 0 && after.canvases === b2.canvases && after.listeners === b2.listeners && after.observers === b2.observers && after.timers <= after.canvases && after.rafs <= 2 * after.canvases, { b2, after });
    if (HAVE) ok(`…no engine scene left (${live2} → ${live3}; ${live0} before the first sheet)`, live3 === live2 && live2 <= live0, { live0, live2, live3 });
    ok('no page errors (3–4)', !errs.length, errs); await ctx.close();
  }
  // (A stored choice whose mix is gone: falls back quietly.)
  {
    const { p, ctx, errs, snap } = await open(PC, { settings: { theme: 'frost', uiMode: 'light', animBg: 'scene:mix:gone', animBgMixes: [] } });
    await waitFor(p, () => document.getElementById('kt-animbg')?.dataset.fallback === 'drift', null, 8000);
    const s = await snap(); ok('a mix that is not there: «drift» drawn, one quiet line, no error', s.info.filter((x) => /drift/.test(x)).length === 1 && !errs.length, { info: s.info, errs });
    await ctx.close();
  }

  /* ---------- 5. a phone ---------- */
  {
    const { p, ctx, errs } = await open(PHONE, { phone: true, settings: { uiMode: 'dark', animBg: 'scene:mix:cold-light' } }, '#/settings/appearance');
    await p.waitForSelector('#appearance').catch(() => {}); await p.waitForTimeout(500);
    ok('a phone: no mixer, no background picker', (await p.locator('[data-mix-new]').count()) === 0 && (await p.locator('.abg-tile').count()) === 0 && (await p.locator('#kt-animbg').count()) === 0);
    ok('no page errors (phone)', !errs.length, errs); await ctx.close();
  }

  await br.close(); web.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
