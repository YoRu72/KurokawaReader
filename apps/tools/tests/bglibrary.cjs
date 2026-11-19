// node tests/bglibrary.cjs [en|ar]: the background LIBRARY on a computer (src/theme/bgLib.ts, bgRun.ts, weLib.ts,
// src/views/bgLibrary.ts) — the reader's own pictures and looping videos as the app's background.
//  1. the rules, in the page (the perf flag's hook): a stored list never trusted (junk refused, ranges clamped, at most
//     40, ids unique); the no-yellow rule (yellow, amber, gold, orange moved to an allowed neighbour, greys kept); the
//     palette of a made-up yellow picture shifted, of a two-colour one both colours found; the caps refused with their
//     fault — not a picture, a header claiming too many pixels, a file too large, a video too short, the library full;
//     a made-up looping video (recorded here) kept with its length and colours;
//  2. a made-up bright picture (yellow and white, generated here) added through the file chooser and used as the
//     background, in light and in dark: every text at 4.5:1 or more over it; «Match the app's colours»: the accent
//     out of the banned hues and readable on the ground;
//  3. a video as the background: playing while the window may move; paused when the window is hidden; still with
//     «less motion»;
//  4. the library grid: rename, delete with Undo; the controls sheet (own sliders, no spinners, buttons of one width that
//     do not touch, the footer not over the last row; a swatch chosen and saved); opened and closed five times: no
//     listener, observer, timer, frame, sheet or background run left;
//  5. Wallpaper Engine (a fake bridge with the real methods' arguments over a MADE-UP folder tree): Steam found through
//     libraryfolders.vdf, its bad entries refused; video, scene and web wallpapers listed, hostile project.json files
//     (too large, wrong types, not JSON, paths leaving the folder) refused; nothing read outside the libraries, nothing
//     but project.json, previews and the chosen video read; search, filters, counts; a video copied in as the
//     background, a scene marked for a later update with its picture usable;
//  6. a phone: none of it.
// Only loopback, made-up pictures and folders.
// Run: NODE_PATH=$(npm root -g) node tests/bglibrary.cjs [en|ar]
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const zlib = require('node:zlib');
const DIST = path.join(__dirname, '..', 'dist');
const LANG = process.argv[2] === 'ar' ? 'ar' : 'en';
const SHOTS = process.env.KT_BGLIB_SHOTS || '';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const serve = () => http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 700))); if (!c) fails++; };
const PC = { viewport: { width: 1280, height: 800 } };
const PHONE = { viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true };
const T = {
  en: { mine: 'Your pictures and videos', add: 'Add a picture or video', we: 'Wallpaper Engine', count: /^Shown: (\d+)$/, later: 'Later update', notMedia: 'This is not a picture or video the app can show' },
  ar: { mine: 'صورُك ومقاطعُك', add: 'أضِفْ صورةً أو مقطعًا', we: 'Wallpaper Engine', count: /^المعروض \(العدد: (\d+)\)$/, later: 'في تحديثٍ لاحق', notMedia: 'ليس هذا صورةً ولا مقطعًا يعرضُه التطبيق' },
}[LANG];

/* ---------- a tiny PNG writer (made-up pictures: plain colour blocks) ---------- */
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return (b) => { let c = -1; for (const x of b) c = t[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }; })();
function png(w, h, colourAt) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; for (let x = 0; x < w; x++) { const c = colourAt(x, y); const o = y * (w * 4 + 1) + 1 + x * 4; raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = c[3] ?? 255; } }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// (Bright: a yellow band, white, a pale blue — the hardest under light and dark text alike.)
const BRIGHT = png(640, 400, (x, y) => (x < 260 ? [236, 206, 40] : y < 200 ? [252, 252, 250] : [176, 214, 246]));
const TWO = png(320, 200, (x) => (x < 160 ? [30, 90, 200] : [40, 170, 110]));
const PREVIEW = png(320, 180, (x, y) => [60 + (x >> 2), 80, 140 + (y >> 2)]);

/* ---------- the made-up Wallpaper Engine tree (the fake bridge's disk) ---------- */
const HOME = '/home/u'; const STEAM = `${HOME}/.local/share/Steam`; const LIB2 = '/mnt/games/SteamLibrary';
const WS = `${STEAM}/steamapps/workshop/content/431960`; const MINE = `${LIB2}/steamapps/common/wallpaper_engine/projects/myprojects`;
const VDF = `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${STEAM}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${LIB2}"\n\t}\n\t"2"\n\t{\n\t\t"path"\t\t"/mnt/../etc"\n\t}\n\t"3"\n\t{\n\t\t"path"\t\t"relative/lib"\n\t}\n}\n`;
const pj = (o) => JSON.stringify(o);
function tree() {
  const F = {}; const D = new Set();
  const dir = (p) => { for (let q = p; q && q !== '/'; q = q.slice(0, q.lastIndexOf('/')) || '/') D.add(q); };
  const file = (p, text) => { dir(p.slice(0, p.lastIndexOf('/'))); F[p] = text; };
  dir(`${STEAM}/steamapps`); file(`${STEAM}/steamapps/libraryfolders.vdf`, VDF); dir(`${LIB2}/steamapps`);
  file(`${WS}/1001/project.json`, pj({ title: 'Quiet tide loop', type: 'Video', file: 'tide.webm', preview: 'preview.png', tags: ['Nature', 'Calm'] })); file(`${WS}/1001/tide.webm`, '@video'); file(`${WS}/1001/preview.png`, '@preview');
  file(`${WS}/1002/project.json`, pj({ title: 'Paper lanterns scene', type: 'scene', file: 'scene.pkg', preview: 'preview.png', tags: ['Calm'] })); file(`${WS}/1002/scene.pkg`, 'PKGV-made-up'); file(`${WS}/1002/preview.png`, '@preview');
  file(`${WS}/1003/project.json`, pj({ title: 'Grid clock web', type: 'web', file: 'index.html', preview: 'preview.png', tags: ['Abstract'] })); file(`${WS}/1003/index.html`, '<script>alert(1)</script>'); file(`${WS}/1003/preview.png`, '@preview');
  file(`${WS}/1004/project.json`, pj({ title: 'Escaping video', type: 'video', file: '../../../../../../etc/passwd.mp4', preview: '/etc/shadow.png' }));
  file(`${WS}/1005/project.json`, '{"title":"' + 'x'.repeat(300 * 1024) + '"}');
  file(`${WS}/1006/project.json`, pj({ title: 5, type: ['video'], tags: 'not-a-list', file: { a: 1 }, preview: 'C:\\Windows\\x.png' }));
  file(`${WS}/1007/project.json`, '{ not json');
  file(`${WS}/1008/project.json`, pj({ title: 'Back-slash escape', type: 'video', file: '..\\..\\secret.mp4', preview: 'sub/../../x.png' }));
  dir(`${WS}/1009`); // (no project.json)
  file(`${MINE}/mine-one/project.json`, pj({ title: 'My own drift', type: 'video', file: 'drift.webm', preview: 'preview.png', tags: ['Mine'] })); file(`${MINE}/mine-one/drift.webm`, '@video'); file(`${MINE}/mine-one/preview.png`, '@preview');
  return { F, D: [...D] };
}

/** In the page before anything runs: settings, the desktop bridge (or the phone's plugin), the counters. */
function init({ settings, phone, lang, disk }) {
  localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.pc.starter', '1'); localStorage.setItem('kt.update.lastCheck', String(Date.now())); localStorage.setItem('kt.themeMigrated', '1'); localStorage.setItem('kt.mainTheme', '1');
  if (!sessionStorage.getItem('kt.bglib.keep')) localStorage.setItem('kt.settings', JSON.stringify({ themeChosen: true, autoUpdateCheck: false, ...settings }));
  localStorage.setItem('kt.anim.perf', '1');
  const c = (window.__abg = { listeners: 0, observers: 0, timers: new Set(), rafs: new Set(), info: [] });
  const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener; const seen = new WeakMap();
  const counted = (t) => t === window || t === document || t instanceof MediaQueryList;
  EventTarget.prototype.addEventListener = function (ty, f, o) { if (counted(this) && f) { const k = ty + (typeof o === 'boolean' ? o : !!o?.capture); let m = seen.get(this); if (!m) seen.set(this, (m = new Map())); let s = m.get(k); if (!s) m.set(k, (s = new Set())); if (!s.has(f)) { s.add(f); c.listeners++; } } return add.call(this, ty, f, o); };
  EventTarget.prototype.removeEventListener = function (ty, f, o) { if (counted(this) && f) { const k = ty + (typeof o === 'boolean' ? o : !!o?.capture); const s = seen.get(this)?.get(k); if (s?.delete(f)) c.listeners--; } return rem.call(this, ty, f, o); };
  const MO = window.MutationObserver; window.MutationObserver = class extends MO { constructor(...a) { super(...a); this.__on = false; } observe(...a) { if (!this.__on) { this.__on = true; c.observers++; } return super.observe(...a); } disconnect() { if (this.__on) { this.__on = false; c.observers--; } return super.disconnect(); } };
  const RO = window.ResizeObserver; window.ResizeObserver = class extends RO { constructor(...a) { super(...a); this.__on = false; } observe(...a) { if (!this.__on) { this.__on = true; c.observers++; } return super.observe(...a); } disconnect() { if (this.__on) { this.__on = false; c.observers--; } return super.disconnect(); } };
  const mine_ = (f) => typeof f === 'function' && /\.tick\b|unfocused|\.raf2?\s*=\s*0|timer = 0; if \(gone\)|raf = 0; if \(gone\)/.test(String(f));
  const st = window.setTimeout, ct = window.clearTimeout;
  window.setTimeout = function (f, ms, ...a) { if (!mine_(f)) return st.call(window, f, ms, ...a); const id = st.call(window, (...b) => { c.timers.delete(id); f(...b); }, ms, ...a); c.timers.add(id); return id; };
  window.clearTimeout = function (id) { c.timers.delete(id); return ct.call(window, id); };
  const ra = window.requestAnimationFrame, ca = window.cancelAnimationFrame;
  window.requestAnimationFrame = function (f) { if (!mine_(f)) return ra.call(window, f); const id = ra.call(window, (t) => { c.rafs.delete(id); f(t); }); c.rafs.add(id); return id; };
  window.cancelAnimationFrame = function (id) { c.rafs.delete(id); return ca.call(window, id); };
  const inf = console.info; console.info = function (...a) { c.info.push(a.join(' ')); return inf.apply(console, a); };
  window.__snap = () => ({ listeners: c.listeners, observers: c.observers, timers: c.timers.size, rafs: c.rafs.size, canvases: document.querySelectorAll('.abg-canvas').length, sheets: document.querySelectorAll('.sheet').length, info: c.info.slice() });
  // (Made-up media, made here: a picture of colour blocks, a looping video recorded from a canvas.)
  window.__mk = {
    png: (w, h, cols) => new Promise((res) => { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const g = cv.getContext('2d'); cols.forEach((col, i) => { g.fillStyle = col; g.fillRect((w / cols.length) * i, 0, w / cols.length + 1, h); }); cv.toBlob(res, 'image/png'); }),
    webm: (ms) => new Promise((res, rej) => { const cv = document.createElement('canvas'); cv.width = 160; cv.height = 96; const g = cv.getContext('2d'); const s = cv.captureStream(20); const r = new MediaRecorder(s, { mimeType: 'video/webm' }); const parts = []; r.ondataavailable = (e) => parts.push(e.data); r.onstop = () => res(new Blob(parts, { type: 'video/webm' })); r.onerror = rej; let k = 0; const iv = setInterval(() => { k++; g.fillStyle = `hsl(${200 + (k * 7) % 80} 55% ${30 + (k % 10) * 3}%)`; g.fillRect(0, 0, 160, 96); g.fillStyle = '#e8eef8'; g.fillRect((k * 6) % 160, 30, 30, 30); }, 50); r.start(100); setTimeout(() => { clearInterval(iv); r.stop(); }, ms); }),
  };
  if (phone) { const api = { addListener: () => ({ remove() {} }), list: async () => ({ tasks: [] }) }; window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) }) }, PluginHeaders: [] }; return; }
  // (The desktop bridge: the real methods' names and arguments — listDir(p), pathInfo(p), readFile(p), pickDir(),
  //  homeDir() —, over the made-up tree; every path asked is kept, to check nothing outside was reached.)
  const F = disk?.F ?? {}; const D = new Set(disk?.D ?? []); const asked = (window.__weAsked = []); const bytes = (window.__weBytes = {});
  const enc = new TextEncoder();
  const content = (p) => { const v = F[p]; if (v === '@video') return bytes.video; if (v === '@preview') return bytes.preview; return typeof v === 'string' ? enc.encode(v) : null; };
  const base = { platform: 'desktop', available: true, os: 'linux', ready: async () => ({}), list: async () => [], onTasks: (cb) => { cb([]); return () => {}; }, defaultDir: async () => '/d',
    homeDir: async () => '/home/u',
    pathInfo: async (p) => { asked.push(['pathInfo', p]); p = String(p); if (D.has(p)) return { exists: true, dir: true, size: 0, name: p.split('/').pop(), parent: p.slice(0, p.lastIndexOf('/')) }; const b = content(p); return b ? { exists: true, dir: false, size: b.length, name: p.split('/').pop(), parent: p.slice(0, p.lastIndexOf('/')) } : { exists: false }; },
    listDir: async (p) => { asked.push(['listDir', p]); p = String(p); if (!D.has(p)) return { entries: [], exists: false }; const kids = new Map(); for (const q of [...D, ...Object.keys(F)]) { if (q.startsWith(p + '/')) { const name = q.slice(p.length + 1).split('/')[0]; const full = p + '/' + name; if (!kids.has(name)) kids.set(name, { name, path: full, dir: D.has(full), size: D.has(full) ? 0 : (content(full)?.length ?? 0), mtime: 1700000000000 + name.length * 1000 }); } } return { entries: [...kids.values()], exists: true }; },
    readFile: async (p) => { asked.push(['readFile', p]); const b = content(String(p)); if (!b) throw new Error('ENOENT'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
    pickDir: async () => window.__wePick ?? null,
  };
  window.kurokawaTools = new Proxy(base, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) });
}

/** The lowest text contrast over the background and its panels (as tests/scenemix.cjs measures it). */
const READ = () => {
  const cv = document.querySelector('#kt-animbg .abg-canvas'); const k = cv.width / (innerWidth + 32); const img = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const parse = (s) => { let m = /rgba?\(([^)]+)\)/.exec(s); if (m) { const v = m[1].split(/[ ,/]+/).filter(Boolean).map(parseFloat); return [v[0], v[1], v[2], v[3] ?? 1]; } m = /color\(srgb ([^)]+)\)/.exec(s); if (m) { const v = m[1].split(/[ /]+/).filter(Boolean).map(parseFloat); return [v[0] * 255, v[1] * 255, v[2] * 255, v[3] ?? 1]; } return [0, 0, 0, 0]; };
  const over = (t, u) => [t[0] * t[3] + u[0] * (1 - t[3]), t[1] * t[3] + u[1] * (1 - t[3]), t[2] * t[3] + u[2] * (1 - t[3]), 1];
  let w = 99, at = null, n = 0; const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let node;
  while ((node = walker.nextNode())) {
    if (!node.nodeValue.trim()) continue; const el = node.parentElement; if (!el || el.closest('#kt-animbg,script,style,[hidden],[aria-hidden="true"],.toast')) continue;
    const st = getComputedStyle(el); if (st.visibility === 'hidden' || +st.opacity === 0) continue;
    const range = document.createRange(); range.selectNodeContents(node); const rr = range.getBoundingClientRect();
    if (rr.width < 2 || rr.height < 2 || rr.top < 0 || rr.left < 0 || rr.bottom > innerHeight || rr.right > innerWidth) continue;
    let sum = [0, 0, 0], c = 0; const x0 = Math.floor((rr.left + 16) * k), x1 = Math.ceil((rr.right + 16) * k), y0 = Math.floor((rr.top + 16) * k), y1 = Math.ceil((rr.bottom + 16) * k);
    // (The worst pixel under the text, not the mean: a picture has hard edges.)
    let worst = null;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const j = (y * cv.width + x) * 4; sum[0] += img[j]; sum[1] += img[j + 1]; sum[2] += img[j + 2]; c++; }
    if (!c) continue; let back = [sum[0] / c, sum[1] / c, sum[2] / c, 1];
    const chain = []; for (let a = el; a && a !== document.documentElement; a = a.parentElement) chain.push(a);
    for (const a of chain.reverse()) { const cs = getComputedStyle(a); back = over(parse(cs.backgroundColor), back); const m = /^linear-gradient\((rgba?\([^)]*\)|color\([^)]*\)), \1\)$/.exec(cs.backgroundImage); if (m) back = over(parse(m[1]), back); }
    if (el.closest('[data-abg-halo]')) { const g = getComputedStyle(document.documentElement).getPropertyValue('--abg-g').trim().split(/\s+/).map(Number); if (g.length === 3) back = over([g[0], g[1], g[2], 0.35], back); }
    const fg = parse(st.color); if (fg[3] < 0.05) continue; const ratio = cr(over(fg, back), back); n++; void worst;
    if (ratio < w) { w = ratio; at = { text: node.nodeValue.trim().slice(0, 30), ratio: +ratio.toFixed(2) }; }
  }
  return { w: +w.toFixed(2), at, n };
};
/** A colour's hue (degrees) and chroma (0–1) from «rgb(r g b)». */
const HUE = (s) => { const v = (s.match(/[\d.]+/g) || []).map(Number); const [r, g, b] = v; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); const d = mx - mn; if (!d) return [0, 0]; let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; if (h < 0) h += 360; return [Math.round(h), +(d / 255).toFixed(3)]; };

(async () => {
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`; const br = await chromium.launch();
  const disk = tree();
  const open = async (o, opts, route = '#/') => {
    const ctx = await br.newContext(o); const p = await ctx.newPage(); const errs = [];
    p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 404, body: '' }));
    await p.addInitScript(init, { lang: LANG, disk, ...opts }); await p.goto(base + route); await p.waitForSelector('.view, body'); await p.waitForTimeout(500);
    return { p, ctx, errs, snap: () => p.evaluate(() => window.__snap()) };
  };
  const waitFor = (p, fn, arg, ms = 8000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);
  const settings = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('kt.settings')));
  const shot = async (p, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, `${name}-${LANG}.png`) }); } };
  /** A file given to the app's file chooser. */
  const choose = async (p, click, name, mimeType, buffer) => { const [fc] = await Promise.all([p.waitForEvent('filechooser'), click()]); await fc.setFiles({ name, mimeType, buffer }); };

  /* ---------- 1. the rules ---------- */
  let videoB64 = '';
  {
    // (The test hook is set once a background mounts: «drift» meanwhile.)
    const { p, ctx, errs } = await open(PC, { settings: { theme: 'frost', uiMode: 'dark', animBg: 'drift' } });
    await waitFor(p, () => !!window.__ktAnimPerf?.bglib, null, 6000);
    const r = await p.evaluate(async () => {
      const { lib, we } = await window.__ktAnimPerf.bglib(); const out = {};
      const good = { id: 'abcdef12', name: 'Sea', kind: 'image', type: 'image/webp', bytes: 100, w: 10, h: 10, at: 1, from: 'file', fit: 'cover', x: 0.5, y: 0.5, dim: 0.2, blur: 0, veil: 0.2, light: 'auto', pal: ['#336699'], col: { accent: 'auto', accent2: 'p0', tint: '#123456' } };
      out.clean = lib.cleanItem({ ...good, name: '  Bad\u0000 \u202ename\n' + 'z'.repeat(80), x: 9, dim: -3, blur: 99, veil: NaN, fit: 'zoom', light: 'max', pal: ['#ffffff', 'red', '#12345', '#ABCDEF'], col: { accent: 'p7', accent2: '<x>', tint: '#AbCdEf' }, extra: '<script>', bytes: -5 });
      out.refused = [null, 5, [], { ...good, id: '../x' }, { ...good, name: '   ' }, { ...good, kind: 'exe' }, { ...good, type: 'text/html' }, { ...good, id: 'AB CD' }].map((x) => lib.cleanItem(x));
      const many = []; for (let i = 0; i < 60; i++) many.push({ ...good, id: 'item' + String(i).padStart(4, '0') });
      out.many = lib.cleanItems([many[0], { ...many[0], name: 'dupe' }, 'junk', ...many.slice(1)]).map((x) => x.id);
      out.notList = lib.cleanItems({ a: good }).length;
      const hue = (c) => { const [r, g, b] = c; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); const d = mx - mn; if (!d) return [0, 0]; let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; if (h < 0) h += 360; return [Math.round(h), d / 255]; };
      out.shift = [[230, 200, 40, 1], [240, 140, 30, 1], [200, 160, 60, 1], [60, 110, 220, 1], [128, 128, 128, 1], [220, 60, 90, 1]].map((c) => [hue(c)[0], hue(lib.shiftHue(c))[0], +hue(lib.shiftHue(c))[1].toFixed(2)]);
      const pix = async (cols, w = 120, h = 60) => { const b = await window.__mk.png(w, h, cols); const bmp = await createImageBitmap(b); const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const g = cv.getContext('2d'); g.drawImage(bmp, 0, 0); return g.getImageData(0, 0, w, h).data; };
      out.yellowPal = lib.swatchesOf(await pix(['#e8c81c', '#f2d640', '#d9a520'])).map((x) => [x, hue(lib.parseHex(x))[0]]);
      out.yellowCols = lib.coloursOf({ pal: lib.swatchesOf(await pix(['#e8c81c', '#f2d640', '#d9a520'])), col: { accent: 'auto', accent2: 'auto', tint: 'auto' } });
      out.yellowCols = out.yellowCols && Object.fromEntries(Object.entries(out.yellowCols).map(([k, v]) => [k, hue(v)]));
      out.twoPal = lib.quantise(await pix(['#1e5ac8', '#28aa6e'])).map((q) => [q.c.map(Math.round).slice(0, 3), +q.pop.toFixed(2)]);
      out.custom = lib.coloursOf({ pal: ['#3366cc'], col: { accent: '#e0b020', accent2: 'p0', tint: 'auto' } }); out.custom = out.custom && hue(out.custom.accent);
      // (The caps: each refused with its fault.)
      const fault = async (blob, name) => { try { await lib.addFile(blob, name); return 'added'; } catch (e) { return e.fault ?? String(e); } };
      out.notMedia = await fault(new Blob(['just some words, not a picture']), 'words.txt');
      const hdr = new Uint8Array(64); hdr.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]); new DataView(hdr.buffer).setUint32(16, 9000); new DataView(hdr.buffer).setUint32(20, 9000);
      out.tooBig = await fault(new Blob([hdr], { type: 'image/png' }), 'huge.png');
      const big = new Uint8Array(51 * 1024 * 1024); big.set(hdr.subarray(0, 8)); out.tooLarge = await fault(new Blob([big]), 'large.png');
      out.tooShort = await fault(await window.__mk.webm(150), 'blink.webm');
      // (A real one: a recorded loop, 1.6 s.)
      const vid = await window.__mk.webm(1600); const it = await lib.addFile(vid, 'Made-up loop').catch((e) => ({ error: e.fault ?? String(e) }));
      out.video = it.error ? it : { kind: it.kind, dur: +(it.dur ?? 0).toFixed(1), pal: it.pal.length, bytes: it.bytes, used: lib.storageUsed(), list: lib.libItems().length };
      out.videoB64 = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.readAsDataURL(vid); });
      // (The library full: 40 entries already.)
      const s = JSON.parse(localStorage.getItem('kt.settings')); const keep = s.animBgLib;
      const forty = []; for (let i = 0; i < 40; i++) forty.push({ ...good, id: 'full' + String(i).padStart(4, '0') });
      const { set } = await window.__ktAnimPerf.bglib(); set({ animBgLib: forty });
      out.full = await fault(await window.__mk.png(20, 20, ['#336699']), 'one.png');
      // (Wallpaper Engine's rules.)
      out.safe = ['tide.webm', 'sub/a.mp4', '../x.mp4', '/etc/x', 'C:\\x.mp4', 'a/../../b', '..\\..\\x', '', 5, 'a\u0000b'].map((x) => we.safeRel(x));
      out.inside = [['/a/b', '/a/b/c'], ['/a/b', '/a/bc'], ['/a/b', '/a/b/../c'], ['C:\\S\\w', 'c:\\s\\w\\1'], ['C:\\S\\w', 'C:\\S\\other']].map(([a, b]) => we.inside(a, b));
      out.vdf = we.vdfLibraries('"path" "/ok/lib" "path" "/x/../etc" "path" "rel/x" "path" "/ok/lib"', false);
      out.vdfWin = we.vdfLibraries('"path"\t\t"D:\\\\SteamLibrary" "path" "\\\\server\\share"', true);
      out.parse = [we.parseProject('{"title":5,"type":["video"],"tags":"x","file":{"a":1}}', '/w/1', '1', 'workshop', 0), we.parseProject('[1,2]', '/w/2', '2', 'workshop', 0), we.parseProject(JSON.stringify({ title: 'T\u202e\u0007itle', type: 'VIDEO', file: '../../x.mp4', preview: 'p.exe' }), '/w/3', '3', 'workshop', 0)];
      set({ animBgLib: keep });
      return out;
    }).catch((e) => ({ error: String(e) }));
    ok('the rules reached in the page', !r.error, r.error);
    if (!r.error) {
      const c = r.clean;
      ok('a stored entry cleaned: ranges clamped, unknown fit and glass choice back to defaults, bad colours dropped, junk fields out', c && c.x === 1 && c.dim === 0 && c.blur === 24 && c.veil === 0.2 && c.fit === 'cover' && c.light === 'auto' && c.pal.length === 2 && c.col.accent === 'auto' && c.col.accent2 === 'auto' && c.col.tint === '#abcdef' && !('extra' in c) && c.bytes === 0, c);
      ok('…its name stripped of control and direction marks, cut to 40', c && c.name.length <= 40 && !/[\u0000-\u001f\u202a-\u202e]/.test(c.name) && c.name.startsWith('Bad name'), c && c.name);
      ok('not an entry (null, a number, a list, a bad id, an empty name, an unknown kind or type): refused', r.refused.every((x) => x === null), r.refused);
      ok(`at most 40 kept, ids unique, junk skipped (${r.many.length})`, r.many.length === 40 && new Set(r.many).size === 40 && r.notList === 0);
      ok('yellow, orange, gold moved out of 20°–85°; blue, grey and rose kept', r.shift.slice(0, 3).every(([, h2]) => h2 < 20 || h2 > 85) && r.shift[3][0] === r.shift[3][1] && r.shift[4][2] === 0 && r.shift[5][0] === r.shift[5][1], r.shift);
      ok('a made-up yellow picture: its swatches shifted out of the banned hues', r.yellowPal.length > 0 && r.yellowPal.every(([, h2]) => h2 < 20 || h2 > 85), r.yellowPal);
      ok('…the accent, second accent and tint taken from it are not yellow either', r.yellowCols && Object.values(r.yellowCols).every(([h2, ch]) => ch < 0.06 || h2 < 20 || h2 > 85), r.yellowCols);
      ok('a two-colour picture: both colours found, about half each', r.twoPal.length === 2 && r.twoPal.every(([, pop]) => pop > 0.4), r.twoPal);
      ok('a custom gold accent shifted too', r.custom && (r.custom[0] < 20 || r.custom[0] > 85), r.custom);
      ok('caps refused with their fault: not media, too many pixels (from the header), too large, too short, library full', r.notMedia === 'notMedia' && r.tooBig === 'tooBig' && r.tooLarge === 'tooLarge' && r.tooShort === 'tooShort' && r.full === 'full', [r.notMedia, r.tooBig, r.tooLarge, r.tooShort, r.full]);
      ok('a made-up looping video kept: its length, colours and bytes, the storage counted', r.video.kind === 'video' && r.video.dur >= 1 && r.video.dur <= 2.5 && r.video.pal > 0 && r.video.used === r.video.bytes && r.video.list === 1, r.video);
      ok('safe paths: plain and sub-folder names kept; «..», absolute, drive, empty, not text, NUL refused', JSON.stringify(r.safe) === JSON.stringify([['tide.webm'], ['sub', 'a.mp4'], null, null, null, null, null, null, null, null]), r.safe);
      ok('inside: a child is, a sibling with the same start, a «..» and another folder are not; Windows case-blind', JSON.stringify(r.inside) === '[true,false,false,true,false]', r.inside);
      ok('libraryfolders.vdf: «..» and relative paths refused, duplicates once; Windows paths unescaped', JSON.stringify(r.vdf) === '["/ok/lib"]' && JSON.stringify(r.vdfWin) === '["D:\\\\SteamLibrary"]', [r.vdf, r.vdfWin]);
      const [pw, pl, pe] = r.parse;
      ok('a project.json of wrong types: shown by its folder name, type unknown, file and tags refused', pw && pw.title === '1' && pw.type === 'unknown' && pw.file === null && pw.tags.length === 0 && pw.refused.includes('type') && pw.refused.includes('file') && pw.refused.includes('tags'), pw);
      ok('…a list is not a project; a leaving path and a preview that is not a picture refused, the title cleaned', pl === null && pe && pe.type === 'video' && pe.file === null && pe.preview === null && !/[\u0000-\u001f\u202e]/.test(pe.title), pe);
      videoB64 = r.videoB64 || '';
    }
    ok('no page errors (1)', !errs.length, errs); await ctx.close();
  }

  /* ---------- 2. a bright picture as the background, light and dark ---------- */
  for (const mode of ['dark', 'light']) {
    const { p, ctx, errs } = await open(PC, { settings: { theme: 'frost', uiMode: mode, animBgTint: true } }, '#/settings/appearance');
    await p.waitForSelector('#appearance');
    await p.locator('#appearance .row', { hasText: LANG === 'ar' ? 'خلفيّةٌ متحرّكة' : 'Animated background' }).locator('.pick-btn').first().click();
    await p.locator('.sheet .dest-row', { hasText: T.mine }).click(); await p.waitForTimeout(300);
    ok(`${mode}: «${T.mine}» shows the library with «${T.add}»`, await waitFor(p, () => !!document.querySelector('[data-bg-add]')));
    ok(`${mode}: …and the Wallpaper Engine tile (a computer's shell)`, (await p.locator('[data-bg-we]').count()) === 1);
    await choose(p, () => p.locator('[data-bg-add]').click(), 'bright made-up.png', 'image/png', BRIGHT);
    const added = await waitFor(p, () => (JSON.parse(localStorage.getItem('kt.settings')).animBg ?? '').startsWith('scene:user:'), null, 15000);
    const s = await settings(p); const it = (s.animBgLib || [])[0];
    ok(`${mode}: added through the file chooser, chosen as the background`, added && it && it.kind === 'image' && it.name === 'bright made-up', { animBg: s.animBg, it });
    ok(`${mode}: …the background drawn by the user-background run`, await waitFor(p, () => document.getElementById('kt-animbg')?.dataset.engine === 'scene' && document.getElementById('kt-animbg')?.dataset.state === 'still' || document.getElementById('kt-animbg')?.dataset.state === 'running', null, 8000));
    await p.evaluate(() => { location.hash = '#/'; }); await p.waitForTimeout(3200);
    const rr = await p.evaluate(READ);
    ok(`${mode}: every text ≥ 4.5:1 over the bright picture (lowest ${rr.w}, ${rr.n} texts)`, rr.w >= 4.5 && rr.n > 10, rr.at);
    const acc = await p.evaluate(() => { const cs = getComputedStyle(document.documentElement); return { on: document.documentElement.classList.contains('abg-tint'), p: cs.getPropertyValue('--md-primary').trim(), g: getComputedStyle(document.documentElement).getPropertyValue('--abg-g').trim() }; });
    const [hh, ch] = HUE(acc.p);
    ok(`${mode}: «Match the app's colours»: the accent from the picture, out of the banned hues (${hh}°)`, acc.on && (ch < 0.06 || hh < 20 || hh > 85), acc);
    if (mode === 'dark') await shot(p, 'bglib-picture-dark'); else await shot(p, 'bglib-picture-light');
    ok(`no page errors (2 ${mode})`, !errs.length, errs); await ctx.close();
  }

  /* ---------- 3. a video as the background: hidden → paused, less motion → still ---------- */
  if (videoB64) {
    const { p, ctx, errs } = await open(PC, { settings: { theme: 'frost', uiMode: 'dark', animBg: 'drift' } });
    await waitFor(p, () => !!window.__ktAnimPerf?.bglib);
    const id = await p.evaluate(async (b64) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); const { lib } = await window.__ktAnimPerf.bglib(); const it = await lib.addFile(new Blob([u], { type: 'video/webm' }), 'Loop'); return it.id; }, videoB64);
    await p.evaluate((id) => { const s = JSON.parse(localStorage.getItem('kt.settings')); s.animBg = 'scene:user:' + id; localStorage.setItem('kt.settings', JSON.stringify(s)); sessionStorage.setItem('kt.bglib.keep', '1'); }, id);
    await p.reload(); await waitFor(p, () => !!window.__ktAnimPerf);
    const playing = () => p.evaluate(() => window.__ktAnimPerf()?.scene?.playing);
    ok('a video background: drawn, playing while it may move', await waitFor(p, () => window.__ktAnimPerf?.()?.scene?.playing === true, null, 10000), await p.evaluate(() => window.__ktAnimPerf?.()));
    await p.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
    await p.waitForTimeout(300);
    ok('…the window hidden: the video paused', (await playing()) === false && (await p.evaluate(() => document.getElementById('kt-animbg').dataset.state)) === 'paused');
    await p.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
    ok('…shown again: playing again', await waitFor(p, () => window.__ktAnimPerf()?.scene?.playing === true, null, 5000));
    await p.emulateMedia({ reducedMotion: 'reduce' }); await p.waitForTimeout(400);
    ok('«less motion»: the video still (paused on a frame)', (await playing()) === false && (await p.evaluate(() => document.getElementById('kt-animbg').dataset.state)) === 'still');
    await p.emulateMedia({ reducedMotion: 'no-preference' });
    ok('no page errors (3)', !errs.length, errs); await ctx.close();
  } else ok('the made-up video was recorded (section 3 needs it)', false);

  /* ---------- 4. the grid, rename, delete with Undo, the controls sheet, leaks ---------- */
  {
    const { p, ctx, errs, snap } = await open(PC, { settings: { theme: 'frost', uiMode: 'dark', animBg: 'drift' } }, '#/settings/appearance');
    await p.waitForSelector('#appearance');
    await p.evaluate(async () => { const { lib } = await window.__ktAnimPerf.bglib(); for (const [n, cols] of [['Harbour blue', ['#1e4d8c', '#4f86c6']], ['Moss', ['#2e6b4a', '#9cc5a1', '#204030']]]) await lib.addFile(await window.__mk.png(400, 250, cols), n); const s = JSON.parse(localStorage.getItem('kt.settings')); s.animBg = 'scene:user:' + lib.libItems()[0].id; localStorage.setItem('kt.settings', JSON.stringify(s)); sessionStorage.setItem('kt.bglib.keep', '1'); });
    await p.reload(); await p.waitForSelector('#appearance');
    ok('the grid: both pictures, the chosen one marked, its actions shown', await waitFor(p, () => document.querySelectorAll('[data-bg-lib] .abg-tile[data-bg]').length === 2 && document.querySelector('[data-bg-lib] .abg-tile[aria-checked="true"]') && !document.querySelector('[data-bg-lib] .abg-mix-acts').hidden));
    ok('…their small pictures drawn', await waitFor(p, () => [...document.querySelectorAll('[data-bg-lib] .abg-tile[data-bg] .abg-thumb')].every((x) => x.classList.contains('drawn'))));
    ok('…the storage used said', /\d/.test(await p.locator('.bgl-store').textContent()));
    await p.locator('#appearance [data-bg-lib]').scrollIntoViewIfNeeded(); await shot(p, 'bglib-grid-dark');
    // (Rename.)
    await p.locator('[data-bg-act="rename"]').click(); await p.waitForSelector('.sheet input[data-bg="rename"]');
    await p.locator('.sheet input[data-bg="rename"]').fill('  Calm\u0007 harbour '); await p.locator('[data-bg-act="rename-ok"]').click(); await p.waitForTimeout(400);
    let s = await settings(p); ok('renamed (cleaned)', s.animBgLib[0].name === 'Calm harbour', s.animBgLib[0].name);
    // (Delete, then Undo.)
    await waitFor(p, () => !document.querySelector('[data-bg-lib] .abg-mix-acts')?.hidden);
    await p.locator('[data-bg-act="delete"]').click(); await p.waitForTimeout(400);
    s = await settings(p); ok('deleted: out of the list, the background off', s.animBgLib.length === 1 && s.animBg === 'off', { n: s.animBgLib.length, animBg: s.animBg });
    await p.locator('.toast button, .toast .btn').first().click().catch(() => {}); await p.waitForTimeout(400);
    s = await settings(p); ok('…Undo brings it back, in use again', s.animBgLib.length === 2 && s.animBg.startsWith('scene:user:'), s.animBg);
    const fileKept = await p.evaluate(async () => { await new Promise((r) => setTimeout(r, 7000)); const { lib } = await window.__ktAnimPerf.bglib(); return !!(await lib.itemFile(lib.libItems()[0])); });
    ok('…its file still there after the Undo window', fileKept);
    // (The controls sheet.)
    await waitFor(p, () => !document.querySelector('[data-bg-lib] .abg-mix-acts')?.hidden);
    await p.locator('[data-bg-act="adjust"]').click();
    ok('the controls sheet opens with a live preview', await waitFor(p, () => document.querySelector('.bg-sheet .mix-preview')?.dataset.engine === 'scene', null, 8000));
    const form = await p.evaluate(() => {
      const sh = document.querySelector('.bg-sheet'); const btns = [...sh.querySelectorAll('.sheet-actions .btn')].map((b) => b.getBoundingClientRect());
      const ws = btns.map((r) => Math.round(r.width)); const byX = [...btns].sort((a, b) => a.left - b.left); let touch = false; for (let i = 1; i < byX.length; i++) if (byX[i].left - byX[i - 1].right < 8) touch = true;
      const body = sh.querySelector('.sheet-body'); body.scrollTop = body.scrollHeight; const last = body.lastElementChild.getBoundingClientRect(); const foot = sh.querySelector('.sheet-actions').getBoundingClientRect();
      const ctrls = [...sh.querySelectorAll('.mix-row, .mix-slider, .bgl-sw')].map((e) => e.getBoundingClientRect()); let overlap = false;
      for (let i = 0; i < ctrls.length; i++) for (let j = i + 1; j < ctrls.length; j++) { const a = ctrls[i], b = ctrls[j]; if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) overlap = true; }
      const sws = [...sh.querySelectorAll('.bgl-sws')].map((w) => { const r = [...w.children].map((x) => x.getBoundingClientRect()).sort((a, b) => a.left - b.left); let t = false; for (let i = 1; i < r.length; i++) if (Math.abs(r[i].top - r[i - 1].top) < 4 && r[i].left - r[i - 1].right < 6) t = true; return t; });
      return { ws, touch, spinners: sh.querySelectorAll('input[type="number"]').length, plainChecks: sh.querySelectorAll('input[type="checkbox"]:not([role="switch"])').length, ranges: sh.querySelectorAll('input[type="range"]').length, lastBelow: last.bottom <= foot.top + 0.5, overlap, swTouch: sws.some(Boolean) };
    });
    ok('own sliders, no number spinner, switches only', form.ranges >= 5 && form.spinners === 0 && form.plainChecks === 0, form);
    ok('buttons of one width that do not touch; the last row above the footer; no control over another, swatches apart', new Set(form.ws).size === 1 && !form.touch && form.lastBelow && !form.overlap && !form.swTouch, form);
    await p.evaluate(() => { const b = document.querySelector('.bg-sheet .sheet-body'); b.scrollTop = 0; });
    await shot(p, 'bglib-controls-dark');
    await p.locator('.bg-sheet input[data-bg="dim"]').evaluate((el) => { el.value = '0.4'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await p.locator('.bg-sheet [data-sw="accent:p1"]').click();
    await p.evaluate(() => { const b = document.querySelector('.bg-sheet .sheet-body'); b.scrollTop = b.scrollHeight; }); await shot(p, 'bglib-swatches-dark');
    await p.locator('.bg-sheet [data-bg-act="save"]').click(); await p.waitForTimeout(500);
    s = await settings(p); const cur = s.animBgLib.find((x) => s.animBg === 'scene:user:' + x.id);
    ok('saved: the veil and the chosen swatch kept on that background', cur && cur.dim === 0.4 && cur.col.accent === 'p1', cur);
    // (Leaks: the sheet opened and closed five times.)
    await p.waitForTimeout(800); const b2 = await snap(); const live2 = await p.evaluate(async () => (await window.__ktAnimPerf.bglib()).run.liveUserBgs());
    for (let i = 0; i < 5; i++) {
      await waitFor(p, () => !document.querySelector('[data-bg-lib] .abg-mix-acts')?.hidden);
      await p.locator('[data-bg-act="adjust"]').click(); await waitFor(p, () => document.querySelector('.bg-sheet .mix-preview')?.dataset.engine === 'scene', null, 6000);
      await p.locator('.bg-sheet input[data-bg="blur"]').evaluate((el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, i * 3);
      await p.waitForTimeout(i % 2 ? 50 : 500);
      if (i % 2) await p.keyboard.press('Escape'); else await p.locator('.bg-sheet .sheet-head button').click();
      await p.waitForTimeout(350);
    }
    await p.waitForTimeout(800); const after = await snap(); const live3 = await p.evaluate(async () => (await window.__ktAnimPerf.bglib()).run.liveUserBgs());
    ok(`the sheet opened and closed five times: no sheet, canvas, listener (${b2.listeners}), observer, timer or frame left`, after.sheets === 0 && after.canvases === b2.canvases && after.listeners === b2.listeners && after.observers === b2.observers && after.timers <= after.canvases && after.rafs <= 2 * after.canvases, { b2, after });
    ok(`…no user-background run left (${live2} → ${live3})`, live3 === live2, { live2, live3 });
    // (The pictures in light as well, when asked for.)
    if (SHOTS) {
      // (A change of mode may reload the page: the settings kept — the session's flag.)
      await p.evaluate(async () => (await window.__ktAnimPerf.bglib()).set({ uiMode: 'light' })).catch(() => undefined); await p.waitForSelector('#appearance [data-bg-lib] .abg-tile[data-bg]'); await p.waitForTimeout(1500);
      await p.locator('#appearance [data-bg-lib]').scrollIntoViewIfNeeded(); await shot(p, 'bglib-grid-light');
      await p.locator('[data-bg-act="adjust"]').click(); await waitFor(p, () => document.querySelector('.bg-sheet .mix-preview')?.dataset.engine === 'scene', null, 6000); await p.waitForTimeout(500);
      await shot(p, 'bglib-controls-light');
      await p.evaluate(() => { const b = document.querySelector('.bg-sheet .sheet-body'); b.scrollTop = b.scrollHeight; }); await shot(p, 'bglib-swatches-light');
      await p.keyboard.press('Escape');
    }
    ok('no page errors (4)', !errs.length, errs); await ctx.close();
  }

  /* ---------- 5. Wallpaper Engine (made-up tree) ---------- */
  {
    const { p, ctx, errs, snap } = await open(PC, { settings: { theme: 'frost', uiMode: 'dark', animBg: 'drift' } }, '#/settings/appearance');
    await p.evaluate(([v, pr]) => { const dec = (b) => { const s = atob(b); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }; window.__weBytes.video = dec(v); window.__weBytes.preview = dec(pr); }, [videoB64, PREVIEW.toString('base64')]);
    await p.waitForSelector('#appearance');
    await p.locator('#appearance .row', { hasText: LANG === 'ar' ? 'خلفيّةٌ متحرّكة' : 'Animated background' }).locator('.pick-btn').first().click();
    await p.locator('.sheet .dest-row', { hasText: T.mine }).click(); await waitFor(p, () => !!document.querySelector('[data-bg-we]'));
    const b0 = await snap();
    await p.locator('[data-bg-we]').click();
    ok('the browser opens and lists what it found', await waitFor(p, () => document.querySelectorAll('.we-sheet .we-tile').length > 0, null, 10000));
    await waitFor(p, () => [...document.querySelectorAll('.we-sheet .we-tile canvas')].length > 0, null, 3000); await p.waitForTimeout(800);
    const cnt = (await p.locator('.we-count').textContent()).trim(); const m = T.count.exec(cnt);
    const types = await p.evaluate(() => [...document.querySelectorAll('.we-sheet .we-tile')].map((x) => [x.dataset.weKey, x.dataset.weType]));
    // (1001 video, 1002 scene, 1003 web, 1004 and 1008 videos with their file refused, 1006 unknown, mine-one video; 1005
    //  too large, 1007 not JSON, 1009 none: not listed.)
    ok(`counted «${cnt}»: the readable ones (7), the unreadable three left out`, m && Number(m[1]) === 7 && types.length === 7, types);
    ok('…a video, a scene, a web wallpaper, and one of Wallpaper Engine\'s own projects (the second library, from libraryfolders.vdf)', ['workshop:1001', 'workshop:1002', 'workshop:1003', 'mine:mine-one'].every((k) => types.some(([x]) => x === k)));
    const asked = await p.evaluate(() => window.__weAsked);
    const outside = asked.filter(([, q]) => !(q.startsWith('/home/u/') || q.startsWith('/mnt/games/SteamLibrary/') || q === '/home/u') || q.split('/').includes('..'));
    const reads = asked.filter(([k]) => k === 'readFile').map(([, q]) => q);
    ok('nothing asked outside the libraries, no «..» anywhere (vdf\'s bad entries never followed)', outside.length === 0, outside.slice(0, 5));
    ok('read only libraryfolders.vdf, project.json files and preview pictures — never a scene package or a web page', reads.every((q) => /(libraryfolders\.vdf|project\.json|preview\.png)$/.test(q)) && !reads.some((q) => /scene\.pkg|index\.html|passwd|secret/.test(q)), reads.filter((q) => !/project\.json$/.test(q)));
    ok('the huge project.json never read whole (its size refused first)', !reads.includes('/home/u/.local/share/Steam/steamapps/workshop/content/431960/1005/project.json'));
    ok('the visible tiles\' previews drawn (a still frame each; none where there is no preview)', await waitFor(p, () => [...document.querySelectorAll('.we-sheet .we-tile canvas')].every((c) => c.dataset.drawn), null, 8000), await p.evaluate(() => [...document.querySelectorAll('.we-sheet .we-tile')].map((x) => [x.dataset.weKey, x.querySelector('canvas').dataset.drawn ?? '-'])));
    await shot(p, 'bglib-we-dark');
    // (Filters, search, counts.)
    await p.locator('.we-sheet [data-we-filter="video"]').click(); await p.waitForTimeout(200);
    const vids = Number(T.count.exec((await p.locator('.we-count').textContent()).trim())?.[1]);
    ok('the Video filter: the video wallpapers only (4)', vids === 4 && (await p.locator('.we-sheet .we-tile[data-we-type="video"]').count()) === 4, vids);
    await p.locator('.we-sheet [data-we-filter="all"]').click(); await p.locator('.we-sheet input[data-we="search"]').fill('calm'); await p.waitForTimeout(200);
    ok('search by tag «calm»: the tide video and the lanterns scene', (await p.locator('.we-sheet .we-tile').count()) === 2);
    await p.locator('.we-sheet input[data-we="search"]').fill(''); await p.waitForTimeout(200);
    // (A scene: marked for a later update, its picture usable.)
    const scene = p.locator('.we-sheet .we-tile[data-we-key="workshop:1002"]');
    ok(`a scene marked «${T.later}»`, (await scene.locator('.we-later').textContent()) === T.later);
    await scene.click(); await p.waitForSelector('.we-detail [data-we-use="picture"]');
    ok('…its detail offers its picture as a still background', await p.locator('.we-detail [data-we-use="picture"]').isEnabled());
    await p.keyboard.press('Escape'); await p.waitForTimeout(250);
    // (The video: copied in as the background.)
    await p.locator('.we-sheet .we-tile[data-we-key="workshop:1001"]').click(); await p.waitForSelector('.we-detail [data-we-use="video"]');
    await p.locator('.we-detail [data-we-use="video"]').click();
    const used = await waitFor(p, () => (JSON.parse(localStorage.getItem('kt.settings')).animBg ?? '').startsWith('scene:user:'), null, 15000);
    const s = await settings(p); const it = (s.animBgLib || []).find((x) => s.animBg === 'scene:user:' + x.id);
    ok('«Use as background»: the video copied into the library and chosen', used && it && it.kind === 'video' && it.from === 'we' && it.name === 'Quiet tide loop', it);
    const reads2 = await p.evaluate(() => window.__weAsked.filter(([k]) => k === 'readFile').map(([, q]) => q));
    ok('…the only other file read: that video', reads2.filter((q) => /\.webm$/.test(q)).length === 1 && reads2.some((q) => q.endsWith('/1001/tide.webm')));
    // (A refused one: its video cannot be used.)
    await p.waitForTimeout(500);
    ok('the browser closed after use; nothing of it left (listeners, observers)', await waitFor(p, () => !document.querySelector('.we-sheet'), null, 3000) && await (async () => { await p.waitForTimeout(500); const a = await snap(); return a.observers <= b0.observers + 1 && a.listeners <= b0.listeners + 2; })(), await snap());
    ok('no page errors (5)', !errs.length, errs); await ctx.close();
  }
  // (The hostile ones through the browser: a video whose file leaves its folder offers nothing.)
  {
    const { p, ctx, errs } = await open(PC, { settings: { theme: 'frost', uiMode: 'light', animBg: 'drift' } }, '#/settings/appearance');
    await p.evaluate(([v, pr]) => { const dec = (b) => { const s = atob(b); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }; window.__weBytes.video = dec(v); window.__weBytes.preview = dec(pr); }, [videoB64, PREVIEW.toString('base64')]);
    await p.waitForSelector('#appearance');
    await p.locator('#appearance .row', { hasText: LANG === 'ar' ? 'خلفيّةٌ متحرّكة' : 'Animated background' }).locator('.pick-btn').first().click();
    await p.locator('.sheet .dest-row', { hasText: T.mine }).click(); await waitFor(p, () => !!document.querySelector('[data-bg-we]'));
    await p.locator('[data-bg-we]').click(); await waitFor(p, () => document.querySelectorAll('.we-sheet .we-tile').length > 0, null, 10000);
    await p.locator('.we-sheet .we-tile[data-we-key="workshop:1004"]').click(); await p.waitForSelector('.we-detail');
    ok('a video whose file leaves its folder: no «Use as background», its refusal said', (await p.locator('.we-detail [data-we-use="video"]').count()) === 0 && (await p.locator('.we-detail .we-refused').count()) === 1);
    await p.keyboard.press('Escape'); await p.waitForTimeout(250);
    await waitFor(p, () => [...document.querySelectorAll('.we-sheet .we-tile canvas')].every((c) => c.dataset.drawn), null, 8000); await shot(p, 'bglib-we-light');
    ok('no page errors (5b)', !errs.length, errs); await ctx.close();
  }

  /* ---------- 6. a phone ---------- */
  {
    const { p, ctx, errs } = await open(PHONE, { phone: true, settings: { uiMode: 'dark', animBg: 'scene:user:abcdef12', animBgLib: [{ id: 'abcdef12', name: 'X', kind: 'image', type: 'image/webp' }] } }, '#/settings/appearance');
    await p.waitForSelector('#appearance').catch(() => {}); await p.waitForTimeout(500);
    ok('a phone: no library, no Wallpaper Engine, no background', (await p.locator('[data-bg-add], [data-bg-we], [data-bg-lib]').count()) === 0 && (await p.locator('#kt-animbg').count()) === 0);
    ok('no page errors (phone)', !errs.length, errs); await ctx.close();
  }

  await br.close(); web.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
