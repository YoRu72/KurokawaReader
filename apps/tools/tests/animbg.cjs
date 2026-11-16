// node tests/animbg.cjs: the animated backgrounds (src/theme/animbg.ts) — a computer only, chosen in Appearance.
//  1. PC, a fresh install: off — the engine's module never fetched, nothing of it in the page; Appearance offers it.
//  2. Each choice made in Appearance mounts ONE background and taking it off leaves nothing behind: no canvas, no
//     timer, no animation frame, no listener, no observer, no WebGL context (counted as tests/hunt.cjs counts), five
//     times over.
//  3. It pauses — the window hidden, unfocused for a while, full screen, a video playing — and goes on again; the
//     system's «less motion» shows it still; a scroll holds it; Still draws one frame and schedules nothing.
//  4. «Match the theme»: Frost → drift, Expressive 3 → flow, Aurora → none, a theme of the reader's → its own.
//  5. Readability: text (on, variant, dim) over every pixel of frames spread over each loop — dark and light, Frost and
//     Expressive 3, several accents, the grain's swing counted — ≥ 4.5:1, on the bare background and under the glass;
//     no yellow, amber or gold in any frame (a gold accent included).
//  6. «My themes»: an animated background kept, read back, exported and imported; themes saved before stay valid;
//     an unknown kind refused.
//  7. A phone: no setting, nothing fetched, even with the setting carried over from a computer.
//  8. A measured budget (generous, not to flake): frames a second as designed, the engine's script time, no long frames.
// Only loopback, made-up data. Run: NODE_PATH=$(npm root -g) node tests/animbg.cjs
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const esbuild = require(path.join(__dirname, '..', 'node_modules', 'esbuild'));
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 500))); if (!c) fails++; };
const PC = { viewport: { width: 1280, height: 800 } };
const PHONE = { viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true };

/** In the page before anything runs: settings, the desktop bridge (or the phone's plugin), the counters. */
function init({ settings, mine, phone }) {
  localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.pc.starter', '1'); localStorage.setItem('kt.update.lastCheck', String(Date.now())); localStorage.setItem('kt.themeMigrated', '1'); localStorage.setItem('kt.mainTheme', '1');
  localStorage.setItem('kt.settings', JSON.stringify({ themeChosen: true, autoUpdateCheck: false, ...settings }));
  if (mine) localStorage.setItem('kt.myThemes', JSON.stringify(mine));
  const c = (window.__abg = { draws: 0, gl: 0, ctx2d: 0, listeners: 0, observers: 0, timers: new Set(), rafs: new Set(), rafCalls: 0 });
  const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener; const seen = new WeakMap();
  const counted = (t) => t === window || t === document || t instanceof MediaQueryList;
  EventTarget.prototype.addEventListener = function (ty, f, o) { if (counted(this) && f) { const k = ty + (typeof o === 'boolean' ? o : !!o?.capture); let m = seen.get(this); if (!m) seen.set(this, (m = new Map())); let s = m.get(k); if (!s) m.set(k, (s = new Set())); if (!s.has(f)) { s.add(f); c.listeners++; } } return add.call(this, ty, f, o); };
  EventTarget.prototype.removeEventListener = function (ty, f, o) { if (counted(this) && f) { const k = ty + (typeof o === 'boolean' ? o : !!o?.capture); const s = seen.get(this)?.get(k); if (s?.delete(f)) c.listeners--; } return rem.call(this, ty, f, o); };
  const MO = window.MutationObserver; window.MutationObserver = class extends MO { constructor(...a) { super(...a); this.__on = false; } observe(...a) { if (!this.__on) { this.__on = true; c.observers++; } return super.observe(...a); } disconnect() { if (this.__on) { this.__on = false; c.observers--; } return super.disconnect(); } };
  // (The engine's own timers and frames: told by their source.)
  const mine_ = (f) => typeof f === 'function' && /\.tick\b|unfocused|\.raf2?\s*=\s*0/.test(String(f));
  const st = window.setTimeout, ct = window.clearTimeout;
  window.setTimeout = function (f, ms, ...a) { if (!mine_(f)) return st.call(window, f, ms, ...a); const id = st.call(window, (...b) => { c.timers.delete(id); f(...b); }, ms, ...a); c.timers.add(id); return id; };
  window.clearTimeout = function (id) { c.timers.delete(id); return ct.call(window, id); };
  const ra = window.requestAnimationFrame, ca = window.cancelAnimationFrame;
  window.requestAnimationFrame = function (f) { if (!mine_(f)) return ra.call(window, f); c.rafCalls++; const id = ra.call(window, (t) => { c.rafs.delete(id); f(t); }); c.rafs.add(id); return id; };
  window.cancelAnimationFrame = function (id) { c.rafs.delete(id); return ca.call(window, id); };
  const gc = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (k, o) { if (/webgl/i.test(k)) c.gl++; if (k === '2d' && this.className === 'abg-canvas') c.ctx2d++; return gc.call(this, k, o); };
  const fr = CanvasRenderingContext2D.prototype.fillRect;
  CanvasRenderingContext2D.prototype.fillRect = function (...a) { if (this.canvas.className === 'abg-canvas' && this.canvas.parentElement?.id === 'kt-animbg') c.draws++; return fr.apply(this, a); };
  window.__snap = () => ({ draws: c.draws, gl: c.gl, listeners: c.listeners, observers: c.observers, timers: c.timers.size, rafs: c.rafs.size, rafCalls: c.rafCalls, canvases: document.querySelectorAll('.abg-canvas').length, hosts: document.querySelectorAll('#kt-animbg').length, abg: document.documentElement.classList.contains('abg'), state: document.getElementById('kt-animbg')?.dataset.state ?? null, kind: document.getElementById('kt-animbg')?.dataset.kind ?? null });
  const now = Date.now(); const ts = []; for (let i = 0; i < 40; i++) ts.push({ id: 't' + i, kind: 'http', name: `made-up-${i}.mkv`, source: { url: `https://example.test/${i}` }, dir: '/d', state: i < 2 ? 'active' : 'done', done: 4e8, total: 9e8, downSpeed: i < 2 ? 2e6 : 0, upSpeed: 0, files: [], addedAt: now - i * 60000 });
  if (phone) { const api = { addListener: () => ({ remove() {} }), list: async () => ({ tasks: [] }) }; window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) }) }, PluginHeaders: [] }; }
  else window.kurokawaTools = new Proxy({ platform: 'desktop', available: true, os: 'linux', ready: async () => ({}), list: async () => ts, onTasks: (cb) => { cb(ts); return () => {}; }, defaultDir: async () => '/d' }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) });
}

/** A theme of the reader's (the values `fromBase` would give, kept by hand): its dark side's background as asked. */
const myTheme = (id, kind) => {
  const mode = { surfaces: { ground: '#131417', lowest: '#0f1012', low: '#18191d', mid: '#1e1f24', high: '#26282d', highest: '#2f3137' }, text: { on: '#eceef1', variant: '#cfd5df', dim: '#b6bfcc', outline: '#8693a6', outlineVariant: '#374151' }, roles: null, tint: '#18191d', strength: 0.6, blur: 24, sat: 1, edge: 0.1, sheen: 0.08, shadow: 0.7, bg: { kind, colors: ['#2a3d4f', '#33405a', '#2b4a4a'], solid: '#131417', veil: 0.2, picBlur: 0 } };
  return { v: 1, id, name: 'Mine', base: 'aurora', radius: 1, accent: 'app', force: 'dark', dark: mode, at: 1 };
};

(async () => {
  /* ---------- 6 (no browser): «My themes» ---------- */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-animbg-'));
  esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src', 'theme', 'custom.ts')], bundle: true, format: 'cjs', platform: 'node', outfile: path.join(tmp, 'custom.js'), logLevel: 'silent' });
  const C = require(path.join(tmp, 'custom.js'));
  {
    const flow = C.sanitise(JSON.parse(JSON.stringify(myTheme('my-abc1', 'flow'))));
    ok('a theme with a moving background is read back', flow.dark.bg.kind === 'flow');
    const def = C.toDef(flow); ok('its tokens carry the design and its three colours, and a still stand-in', def.dark.anim === 'flow' && def.dark.animColors.join() === '#2a3d4f,#33405a,#2b4a4a' && /radial-gradient/.test(def.dark.bg), def.dark);
    const old = C.sanitise(myTheme('my-old1', 'mesh')); const od = C.toDef(old);
    ok('a theme saved before (a mesh) still loads, without motion', old.dark.bg.kind === 'mesh' && od.dark.anim === undefined);
    let refused = false; try { C.sanitise(myTheme('my-bad1', 'sparkle')); } catch { refused = true; } ok('an unknown background kind is refused', refused);
    const file = await C.exportTheme(C.sanitise(myTheme('my-exp1', 'drift')), {}); const back = await C.importTheme(new TextEncoder().encode(file));
    ok('exported and imported (.ktheme): still a drift, a new id', back.my.dark.bg.kind === 'drift' && back.my.id !== 'my-exp1');
    const fixed = C.fixContrast(C.sanitise({ ...myTheme('my-fix1', 'flow'), dark: { ...myTheme('x', 'flow').dark, strength: 0, text: { ...myTheme('x', 'flow').dark.text, dim: '#3a3c40' }, bg: { ...myTheme('x', 'flow').dark.bg, colors: ['#d0d4dc', '#c8ccd4', '#bcc2cc'] } } }), 'dark', 'default');
    ok('«Fix contrast» draws a moving background\'s colours nearer the ground, as a mesh\'s', fixed.dark.bg.colors[0] !== '#d0d4dc');
  }

  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`; const br = await chromium.launch();
  const open = async (o, opts, route = '#/') => {
    const ctx = await br.newContext(o); const p = await ctx.newPage(); const errs = []; const reqs = [];
    p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); }); p.on('request', (r) => reqs.push(r.url()));
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 404, body: '' }));
    await p.addInitScript(init, opts); await p.goto(base + route); await p.waitForSelector('.view'); await p.waitForTimeout(700);
    return { p, ctx, errs, reqs, snap: () => p.evaluate(() => window.__snap()), fetched: () => reqs.some((u) => /animbg/i.test(u)) };
  };
  const choose = async (p, rowLabel, option) => {
    await p.locator('#appearance .row', { hasText: rowLabel }).first().locator('.pick-btn').click();
    await p.locator('.sheet .dest-row', { hasText: new RegExp(`^\\s*${option}\\s*$`) }).first().locator('input').click(); await p.waitForTimeout(250);
  };
  const waitState = (p, want, ms = 3000) => p.waitForFunction((w) => (document.getElementById('kt-animbg')?.dataset.state ?? null) === w, want, { timeout: ms }).then(() => true, () => false);
  const drawsIn = async (p, ms) => { const a = (await p.evaluate(() => window.__snap())).draws; await p.waitForTimeout(ms); return (await p.evaluate(() => window.__snap())).draws - a; };

  /* ---------- 1. off by default ---------- */
  {
    const { p, ctx, errs, fetched, snap } = await open(PC, { settings: { theme: 'frost', uiMode: 'dark' } });
    const s = await snap();
    ok('PC, fresh: nothing of the animated background in the page', s.hosts === 0 && s.canvases === 0 && !s.abg && s.timers === 0 && s.rafCalls === 0, s);
    ok('PC, fresh: its module not fetched', !fetched());
    await p.goto(base + '#/settings/appearance'); await p.waitForSelector('#appearance'); await p.waitForTimeout(500);
    ok('Appearance offers «Animated background» (PC), set to Off', await p.locator('#appearance .row', { hasText: 'Animated background' }).locator('.pick-label').first().textContent() === 'Off');
    ok('…and showing it (Off) still fetches nothing', !fetched());
    ok('no page errors (1)', !errs.length, errs); await ctx.close();
  }

  /* ---------- 2. each choice mounts once, and leaves nothing behind ---------- */
  {
    const { p, ctx, errs, snap, fetched } = await open(PC, { settings: { theme: 'frost', uiMode: 'dark' } }, '#/settings/appearance');
    // (A settings page leaves a listener of its own — ui/dohStatus.ts — that goes at the next visibilitychange: one is
    //  sent before each count, so only what the background leaves is counted.)
    const settle = () => p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await p.waitForSelector('#appearance'); await settle(); const before = await snap();
    let clean = true, once = true, ran = true; const after = [];
    for (let round = 0; round < 5; round++) {
      for (const [opt, kind] of [['Frost drift', 'drift'], ['Expressive flow', 'flow'], ['Match the theme', 'drift']]) {
        await choose(p, 'Animated background', opt); await waitState(p, 'running');
        const s = await snap(); if (s.hosts !== 1 || s.kind !== kind || p.locator('#kt-animbg .abg-canvas').count === undefined) once = false;
        if ((await p.locator('#kt-animbg .abg-canvas').count()) !== 1 || (await p.locator('.abg-preview .abg-canvas').count()) !== 1) once = false;
        if (round === 0 && (await drawsIn(p, 600)) < 3) ran = false;
      }
      await choose(p, 'Animated background', 'Off'); await p.waitForTimeout(300); await settle();
      const s = await snap(); after.push(s);
      if (s.hosts || s.canvases || s.abg || s.timers || s.rafs || s.listeners !== before.listeners || s.observers !== before.observers || s.gl) clean = false;
    }
    ok('each choice: one background of its design (and one preview in Appearance)', once);
    ok('…and it draws', ran);
    ok(`Off again, five times: no canvas, timer, frame, listener (${before.listeners}), observer (${before.observers}) or GL context left`, clean, { before, after: after[after.length - 1] });
    const r0 = (await snap()).rafCalls; await p.waitForTimeout(700); ok('Off: no frame asked for', (await snap()).rafCalls === r0);
    ok('the module was fetched once chosen', fetched());
    ok('no page errors (2)', !errs.length, errs); await ctx.close();
  }

  /* ---------- 3. pauses ---------- */
  {
    const { p, ctx, errs, snap } = await open(PC, { settings: { theme: 'frost', uiMode: 'dark', animBg: 'drift' } });
    ok('chosen at the start: running after the first screen', await waitState(p, 'running', 4000), await snap());
    const hide = (h) => p.evaluate((h) => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') }); Object.defineProperty(document, 'hidden', { configurable: true, get: () => h }); document.dispatchEvent(new Event('visibilitychange')); }, h);
    await hide(true); ok('hidden: paused', await waitState(p, 'paused'));
    const s1 = await snap(); ok('hidden: no timer, no frame, no draw', s1.timers === 0 && s1.rafs === 0 && (await drawsIn(p, 800)) === 0, s1);
    await hide(false); ok('visible again: running, drawing', (await waitState(p, 'running')) && (await drawsIn(p, 800)) > 3);
    await p.evaluate(() => window.dispatchEvent(new Event('blur'))); await p.waitForTimeout(1500);
    ok('unfocused a moment: still running', (await snap()).state === 'running');
    ok('unfocused 4 s: paused', await waitState(p, 'paused', 5000));
    await p.evaluate(() => window.dispatchEvent(new Event('focus'))); ok('focused: running', await waitState(p, 'running'));
    await p.evaluate(() => { Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => document.body }); document.dispatchEvent(new Event('fullscreenchange')); });
    ok('full screen: paused', await waitState(p, 'paused'));
    await p.evaluate(() => { Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null }); document.dispatchEvent(new Event('fullscreenchange')); });
    ok('out of full screen: running', await waitState(p, 'running'));
    await p.evaluate(() => { const v = document.createElement('video'); v.id = 'fakev'; let paused = false; Object.defineProperty(v, 'paused', { get: () => paused }); Object.defineProperty(v, 'readyState', { get: () => 4 }); v.__set = (x) => { paused = x; }; document.body.append(v); v.dispatchEvent(new Event('playing')); });
    ok('a video playing: paused', await waitState(p, 'paused'));
    await p.evaluate(() => { const v = document.getElementById('fakev'); v.__set(true); v.dispatchEvent(new Event('pause')); v.remove(); });
    ok('the video paused: running', await waitState(p, 'running'));
    await p.emulateMedia({ reducedMotion: 'reduce' }); ok('the system asks for less motion: still', await waitState(p, 'still'));
    const s2 = await snap(); ok('still: nothing scheduled, nothing drawn', s2.timers === 0 && s2.rafs === 0 && (await drawsIn(p, 800)) === 0, s2);
    await p.emulateMedia({ reducedMotion: 'no-preference' }); ok('motion allowed again: running', await waitState(p, 'running'));
    await p.mouse.move(700, 500); const d0 = (await snap()).draws; let busy = false;
    for (let i = 0; i < 12; i++) { await p.mouse.wheel(0, i % 2 ? -200 : 200); await p.waitForTimeout(60); if ((await snap()).state === 'busy') busy = true; }
    const during = (await snap()).draws - d0;
    ok('a scroll holds it (a frame at most while the wheel turns)', busy && during <= 2, { busy, during });
    ok('after the scroll: running again', await waitState(p, 'running', 2000));
    ok('no page errors (3)', !errs.length, errs); await ctx.close();
  }
  {
    const { p, ctx, errs, snap } = await open(PC, { settings: { theme: 'classic', uiMode: 'light', animBg: 'flow', animBgLevel: 'still' } });
    ok('Still: one frame drawn', await waitState(p, 'still', 4000));
    const s = await snap(); ok('Still: drew once, schedules nothing', s.draws >= 1 && s.draws <= 3 && s.timers === 0 && s.rafs === 0 && (await drawsIn(p, 1000)) === 0, s);
    ok('no page errors (Still)', !errs.length, errs); await ctx.close();
  }

  /* ---------- 4. «Match the theme» ---------- */
  for (const [theme, want, mine] of [['frost', 'drift'], ['classic', 'flow'], ['aurora', null], ['my-flow1', 'flow', [myTheme('my-flow1', 'flow')]], ['my-mesh1', null, [myTheme('my-mesh1', 'mesh')]]]) {
    const { p, ctx, errs, snap } = await open(PC, { settings: { theme, uiMode: 'dark', animBg: 'match' }, mine });
    await p.waitForTimeout(800); const s = await snap();
    ok(`Match the theme: ${theme} → ${want ?? 'none'}`, want ? s.kind === want && s.hosts === 1 : s.hosts === 0 && s.canvases === 0 && s.timers === 0, s);
    ok(`no page errors (match ${theme})`, !errs.length, errs); await ctx.close();
  }

  /* ---------- 5. readability and colour over sampled frames ---------- */
  {
    const worst = []; let yellow = [];
    for (const [theme, mode, accent, kind] of [['frost', 'dark', 'graphite', 'drift'], ['frost', 'light', 'graphite', 'drift'], ['classic', 'dark', 'graphite', 'flow'], ['classic', 'light', 'graphite', 'flow'], ['frost', 'dark', 'gold', 'drift'], ['classic', 'light', 'gold', 'flow'], ['classic', 'dark', 'coral', 'drift'], ['frost', 'light', 'teal', 'flow'], ['classic', 'dark', 'sand', 'flow'], ['frost', 'dark', 'violet', 'flow']]) {
      const { p, ctx, errs } = await open(PC, { settings: { theme, uiMode: mode, accent, animBg: kind } });
      await waitState(p, 'running', 4000);
      const r = await p.evaluate(async ({ kind }) => {
        const L = kind === 'drift' ? 300 : 240; const cv = document.querySelector('#kt-animbg .abg-canvas'); const g = cv.getContext('2d');
        const probe = (v) => { const s = document.createElement('span'); s.style.color = v; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); const k = document.createElement('canvas').getContext('2d'); k.fillStyle = c; k.fillRect(0, 0, 1, 1); const d = k.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
        const texts = ['var(--md-on-surface)', 'var(--md-on-surface-variant)', 'var(--md-on-surface-dim, var(--md-on-surface-variant))'].map(probe);
        const glass = document.documentElement.dataset.glass ? ['var(--g-card-t)', 'var(--g-pane-t)'].map(probe) : [];
        const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
        const ov = (t, u) => [t[0] * t[3] + u[0] * (1 - t[3]), t[1] * t[3] + u[1] * (1 - t[3]), t[2] * t[3] + u[2] * (1 - t[3]), 1];
        const cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
        let w = 99, wGlass = 99; const yel = []; const GR = 0.028;
        for (let i = 0; i < 8; i++) {
          window.dispatchEvent(new CustomEvent('kt:animbg', { detail: { seek: (L * i) / 8 + 3 } }));
          const d = g.getImageData(0, 0, cv.width, cv.height).data; let hi = [0, 0, 0, 1], lo = [255, 255, 255, 1], hiL = -1, loL = 2;
          for (let j = 0; j < d.length; j += 4) {
            const px = [d[j], d[j + 1], d[j + 2], 1]; const l = lum(px); if (l > hiL) { hiL = l; hi = px; } if (l < loL) { loL = l; lo = px; }
            const mx = Math.max(px[0], px[1], px[2]), mn = Math.min(px[0], px[1], px[2]), ch = (mx - mn) / 255;
            if (ch > 0.06) { let h = mx === px[0] ? ((px[1] - px[2]) / (mx - mn)) % 6 : mx === px[1] ? (px[2] - px[0]) / (mx - mn) + 2 : (px[0] - px[1]) / (mx - mn) + 4; h *= 60; if (h < 0) h += 360; if (h >= 40 && h <= 70 && yel.length < 3) yel.push([...px.slice(0, 3), Math.round(h)]); }
          }
          // (The grain's swing: up to 2.8 % toward white over the brightest, toward black under the darkest.)
          const hiG = hi.map((v, k) => (k < 3 ? v + GR * (255 - v) : v)), loG = lo.map((v, k) => (k < 3 ? v * (1 - GR) : v));
          for (const b of [hiG, loG]) { for (const t of texts) w = Math.min(w, cr(ov(t, b), b)); for (const gl of glass) { const u = ov(gl, b); for (const t of texts) wGlass = Math.min(wGlass, cr(ov(t, u), u)); } }
        }
        window.dispatchEvent(new CustomEvent('kt:animbg', { detail: { seek: null } }));
        return { w: +w.toFixed(2), wGlass: wGlass === 99 ? null : +wGlass.toFixed(2), yel };
      }, { kind });
      worst.push(`${theme}/${mode}/${accent}/${kind}: ${r.w}${r.wGlass ? ' · glass ' + r.wGlass : ''}`);
      ok(`text ≥ 4.5:1 over 8 frames — ${theme} ${mode}, ${accent}, ${kind}`, r.w >= 4.5 && (r.wGlass === null || r.wGlass >= 4.5), r);
      if (r.yel.length) yellow.push({ theme, mode, accent, kind, px: r.yel });
      ok(`no page errors (frames ${theme} ${accent})`, !errs.length, errs); await ctx.close();
    }
    console.log('     lowest contrast: ' + worst.join(' | '));
    ok('no yellow, amber or gold in any sampled frame', !yellow.length, yellow);
  }

  /* ---------- 7. a phone ---------- */
  {
    const { p, ctx, errs, fetched, snap } = await open(PHONE, { settings: { theme: 'frost', uiMode: 'dark', animBg: 'drift' }, phone: true });
    await p.waitForTimeout(1200); const s = await snap();
    ok('phone, the setting carried over: nothing in the page', s.hosts === 0 && s.canvases === 0 && !s.abg, s);
    await p.goto(base + '#/settings/appearance'); await p.waitForTimeout(1200);
    ok('phone: Appearance has no «Animated background»', (await p.locator('text=Animated background').count()) === 0);
    ok('phone: the engine never fetched', !fetched());
    ok('no page errors (phone)', !errs.length, errs); await ctx.close();
  }

  /* ---------- 8. a measured budget ---------- */
  for (const [kind, theme] of [['drift', 'frost'], ['flow', 'classic']]) {
    const run = async (animBg) => {
      const { p, ctx } = await open(PC, { settings: { theme, uiMode: 'dark', animBg } }); await p.waitForTimeout(1500);
      const cdp = await ctx.newCDPSession(p); await cdp.send('Performance.enable'); const m = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
      await p.evaluate(() => { window.__fr = []; let last = 0; const f = (t) => { if (last) window.__fr.push(t - last); last = t; if (window.__frOn) requestAnimationFrame(f); }; window.__frOn = true; requestAnimationFrame(f); });
      const a = await m(); const d0 = (await p.evaluate(() => window.__snap())).draws; await p.waitForTimeout(5000); const b = await m(); const d1 = (await p.evaluate(() => window.__snap())).draws;
      const fr = await p.evaluate(() => { window.__frOn = false; return window.__fr; }); await ctx.close();
      return { script: (b.ScriptDuration - a.ScriptDuration) * 200, task: (b.TaskDuration - a.TaskDuration) * 200, style: (b.RecalcStyleDuration - a.RecalcStyleDuration + b.LayoutDuration - a.LayoutDuration) * 200, fps: (d1 - d0) / 5, long: fr.filter((x) => x > 50).length, frames: fr.length };
    };
    const off = await run('off'); const on = await run(kind);
    console.log(`     ${kind} at 1280×800: ${on.fps.toFixed(1)} frames/s · script +${(on.script - off.script).toFixed(1)} ms/s · main thread +${(on.task - off.task).toFixed(1)} ms/s · style+layout ${on.style.toFixed(2)} ms/s · long frames ${on.long}/${on.frames}`);
    ok(`${kind}: frames a second as designed (5–26)`, on.fps >= 5 && on.fps <= 26, on);
    ok(`${kind}: the engine's script under 25 ms a second (generous)`, on.script - off.script < 25, { on, off });
    ok(`${kind}: no page restyled or laid out by it`, on.style - off.style < 3, { on, off });
    ok(`${kind}: long frames (> 50 ms) under 10 %`, on.long <= Math.max(3, on.frames * 0.1), on);
  }

  await br.close(); web.close(); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
