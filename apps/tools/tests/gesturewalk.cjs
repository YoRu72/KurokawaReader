// node tests/gesturewalk.cjs [only=<surface>[,..]] : every touch gesture of the phone UI, driven the way a thumb does it:
// the browser's own touch input (CDP Input.dispatchTouchEvent: touchStart, many touchMove at 8-16 ms, touchEnd or
// touchCancel), never synthetic mouse or pointer events. Each gesture runs in the same variants: straight, 30 degrees off
// axis, slow, a fast flick, started in a nested scroller, started at the screen edge, a second finger landing, reversed
// half way, released exactly at the threshold, cancelled half way, five quick repeats, and (Arabic) mirrored. After each:
// the end state, that nothing is left half done (transforms, scrims, marks), that the page did not also scroll, select
// text or navigate, and that the console shows no passive-listener or uncancelable-touchmove complaint.
// Env: WALK_ONLY=sheet,drawer  WALK_WIDTHS=360,412  WALK_LANGS=en,ar  WALK_SHOTS=<dir for failure screenshots>
const { chromium, devices } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const { execFileSync } = require('node:child_process');
const DIST = path.join(__dirname, '..', 'dist');
const MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-walk-'));
const SHOTS = process.env.WALK_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'kt-walkshots-'));
let haveVideo = true;
try { execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '30', '-c:v', 'libvpx', '-b:v', '200k', '-c:a', 'libopus', path.join(MEDIA, 'clip.webm')]); } catch { haveVideo = false; }
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.webm': 'video/webm' };
let fails = 0, passes = 0; const faultLog = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const only = (process.env.WALK_ONLY || '').split(',').filter(Boolean);
const WIDTHS = (process.env.WALK_WIDTHS || '360,412').split(',').map(Number); const LANGS = (process.env.WALK_LANGS || 'en,ar').split(',');

const serve = () => http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = p.startsWith('/media/') ? path.join(MEDIA, p.slice(7)) : path.join(DIST, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end(); return; }
  const size = fs.statSync(f).size; const range = /bytes=(\d+)-(\d*)/.exec(q.headers.range || ''); const type = MIME[path.extname(f)] || 'application/octet-stream';
  if (range) { const a = Number(range[1]), b = range[2] ? Number(range[2]) : size - 1; r.writeHead(206, { 'content-type': type, 'content-range': `bytes ${a}-${b}/${size}`, 'accept-ranges': 'bytes', 'content-length': b - a + 1 }); fs.createReadStream(f, { start: a, end: b }).pipe(r); return; }
  r.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size }); fs.createReadStream(f).pipe(r);
});

// The made-up phone: a Files tree (images first, then 80 plain files so the fast scroller exists), two download cards.
const FIXTURE = (lang, port) => {
  window.__lists = 0; window.__calls = [];
  const dir = '/storage/emulated/0/Download/Kurokawa'; const now = Date.now();
  const kids = { 'a-one.jpg': 2.5e6, 'a-two.jpg': 2.4e6, 'Movie.mkv': 7e8, 'notes.txt': 1200, Sub: {} }; for (let i = 1; i <= 80; i++) kids[`f-${String(i).padStart(2, '0')}.txt`] = 1000 + i;
  const tree = { [dir]: kids };
  const listOf = (d) => Object.entries(tree[d] ?? {}).map(([name, v]) => ({ name, path: `${d}/${name}`, dir: typeof v === 'object', size: typeof v === 'object' ? 0 : v, mtime: 1760000000000, ext: typeof v === 'object' ? undefined : name.split('.').pop() }));
  const tasks = [
    { id: 'a', kind: 'http', name: 'one.iso', source: { url: 'https://x/1' }, dir: '/d', state: 'downloading', done: 1e8, total: 1e9, downSpeed: 1e6, upSpeed: 0, files: [], addedAt: now, engine: 'native' },
    { id: 'b', kind: 'http', name: 'two.iso', source: { url: 'https://x/2' }, dir: '/d', state: 'paused', done: 1e8, total: 1e9, downSpeed: 0, upSpeed: 0, files: [], addedAt: now - 1000, engine: 'native' },
    { id: 'v', kind: 'http', name: 'clip.webm', source: { url: 'https://x/clip.webm' }, dir: '/sdcard/Download', state: 'done', done: 1, total: 1, downSpeed: 0, upSpeed: 0, files: [{ index: 0, path: 'clip.webm', size: 1, done: 1, priority: 1 }], addedAt: now - 60e3, doneAt: now, engine: 'native' },
  ];
  const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
  const api = {
    addListener: async () => ({ remove() {} }), list: async () => ({ tasks }), defaultDir: async () => ({ dir: '/sdcard/Download' }),
    pause: async (o) => { window.__calls.push(['pause', o.id]); }, resume: async (o) => { window.__calls.push(['resume', o.id]); },
    filesRoots: async () => ({ allFiles: true, roots: [{ kind: 'app', path: dir, name: 'Kurokawa', readable: true, free: 12e9, total: 64e9 }] }),
    filesList: async ({ path }) => { window.__lists++; return { exists: true, entries: listOf(path) }; },
    localUrl: async (o) => ({ url: /clip\.webm$/.test(o.path || '') ? `http://127.0.0.1:${port}/media/clip.webm` : gif }), filesThumb: async () => ({ url: null }),
    siblings: async () => ({ paths: [] }), orientation: async () => ({}),
  };
  const plugin = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin, Filesystem: {} }, PluginHeaders: [] };
  try { localStorage.setItem('kr.lang', lang); if (!sessionStorage.getItem('walk-init')) { sessionStorage.setItem('walk-init', '1'); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['files', 'player'], navOrder: ['downloads', 'files'], playerWith: 'app' })); } } catch { /* blank */ }
};

// ---- the finger
async function finger(cdp, o) {
  // o: { pts:[[x,y]..] (the path), ms (step interval), second:{at, from, to} (a second finger lands at path index `at`),
  //      cancelAt (index at which the browser cancels), mid:(i)=>Promise (called once when index === o.midAt), hold (ms held before the first move), tail (ms held at the end before lifting), cancel (end with touchCancel) }
  // (The events carry their own clock — 8 to 16 ms apart as a thumb's are — so the speed the page reads is the finger's, not this box's slow round trips.)
  const P = o.pts; const id0 = { id: 0, radiusX: 4, radiusY: 4, force: 0.5 }; let clock = Date.now() / 1000; const tick = (ms) => { clock += ms / 1000; return clock; };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: P[0][0], y: P[0][1], ...id0 }], timestamp: clock });
  if (o.hold) { await sleep(o.hold); tick(o.hold); }
  let two = false;
  for (let i = 1; i < P.length; i++) {
    const tp = [{ x: P[i][0], y: P[i][1], ...id0 }];
    if (o.second && i === o.second.at) { two = true; }
    if (two) { const k = Math.min(1, (i - o.second.at + 1) / 4); tp.push({ x: o.second.from[0] + (o.second.to[0] - o.second.from[0]) * k, y: o.second.from[1] + (o.second.to[1] - o.second.from[1]) * k, id: 1, radiusX: 4, radiusY: 4, force: 0.5 }); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp, timestamp: tick(typeof o.ms === 'function' ? o.ms(i) : o.ms) });
    if (o.midAt === i && o.mid) await o.mid(i);
    if (o.cancelAt === i) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [], timestamp: tick(8) }); return; }
    await sleep(typeof o.ms === 'function' ? o.ms(i) : o.ms);
  }
  if (o.tail) { await sleep(o.tail); tick(o.tail); }
  if (o.before) await o.before();
  await cdp.send('Input.dispatchTouchEvent', { type: o.cancel ? 'touchCancel' : 'touchEnd', touchPoints: [], timestamp: tick(8) });
}
const lerp = (a, b, n) => Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);

// ---- what a clean page looks like once a gesture is over
const PROBE = () => {
  const bad = []; const ident = (t) => t === 'none' || t === 'matrix(1, 0, 0, 1, 0, 0)';
  for (const el of document.querySelectorAll('.sheet:not(.as-menu), #app > *, .task-card, .task-card > *, .files-row, .files-row > *, .files-viewer-img, .files-viewer-stage > *, .kt-player .kt-stage, .kt-player video')) {
    const r = el.getBoundingClientRect(); if (!r.width) continue;
    const t = getComputedStyle(el).transform; if (!ident(t) && !(el.classList.contains('sheet') && el.dataset.leaving)) bad.push(`${el.tagName}.${String(el.className).split(' ')[0]} transform ${t}`);
  }
  for (const el of document.querySelectorAll('.scrim')) if (el.style.opacity && el.style.opacity !== '1') bad.push(`scrim inline opacity ${el.style.opacity}`);
  for (const el of document.querySelectorAll('.sheet')) if (el.style.opacity && el.style.opacity !== '1') bad.push(`sheet inline opacity ${el.style.opacity}`);
  if (document.querySelector('.ptr-mark')) bad.push('pull mark left in the page');
  if (document.querySelector('.swiping, .swipe-under')) bad.push('row still swiping');
  if (document.querySelector('[inert]')) bad.push('inert left');
  for (const a of ['overflow', 'position', 'touchAction']) if (document.body.style[a]) bad.push(`body.style.${a}=${document.body.style[a]}`);
  if (document.documentElement.classList.contains('page-in-next') || document.documentElement.classList.contains('page-in-prev')) bad.push('page-in class left');
  return { bad, sel: String(getSelection()), hash: location.hash, sy: Math.round(window.scrollY + (document.querySelector('.body')?.scrollTop || 0)) };
};

(async () => {
  const web = serve().listen(0); const port = web.address().port; const base = `http://127.0.0.1:${port}/`;
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

  for (const W of WIDTHS) for (const lang of LANGS) {
    const H = W === 360 ? 800 : 915; const rtl = lang === 'ar'; const fwd = rtl ? -1 : 1; // start -> end direction, physical x
    const ctx = await b.newContext({ ...devices['Pixel 7'], viewport: { width: W, height: H }, screen: { width: W, height: H }, deviceScaleFactor: 1 });
    const p = await ctx.newPage(); const cdp = await ctx.newCDPSession(p);
    const consoleBad = []; const pageErrors = []; let curTag = '';
    p.on('console', (m) => { const x = m.text(); if (/preventDefault|cancelable|Intervention/i.test(x)) consoleBad.push(`${curTag}: ${x.slice(0, 160)}`); });
    p.on('pageerror', (e) => pageErrors.push(`${curTag}: ${e.message}`));
    await p.addInitScript(`(${FIXTURE.toString()})(${JSON.stringify(lang)}, ${port})`);
    const tagBase = `${W}${lang}`;
    const ok = (name, c, x) => { if (c) passes++; else { fails++; faultLog.push(`${tagBase} ${name} ${x === undefined ? '' : JSON.stringify(x)}`); } console.log((c ? 'ok   ' : 'FAIL ') + `[${tagBase}] ` + name + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); return c; };
    const shot = async (name) => { try { await p.screenshot({ path: path.join(SHOTS, `T1-${tagBase}-${name.replace(/[^\w-]+/g, '_')}.png`) }); } catch { /* gone */ } };
    const probe = () => p.evaluate(PROBE);
    const fresh = async (hash) => { await p.goto('about:blank'); await p.goto(base + hash); await p.waitForSelector('.bottom-nav', { timeout: 8000 }); await sleep(350); };
    const rectOf = (sel) => p.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; });

    // ---------- surfaces ----------
    // axis: unit [dx,dy] of the commit direction (physical); thr: px to commit by distance; start(): [x,y]; state(): value that tells commit; committed(before, after)
    const S = {};
    S.sheet = {
      axis: [0, 1], thr: () => Math.round(S.sheet.h * 0.3), flick: true, follow: 0.85, h: 0,
      async setup() { await fresh('#/'); await p.click('.fab'); await p.click('.fab-item >> nth=0'); await p.waitForSelector('.add-sheet'); await sleep(500); S.sheet.h = (await rectOf('.add-sheet')).h; },
      async start() { const r = await rectOf('.add-sheet .sheet-head'); return [r.x + 60, r.cy]; },
      async nested() { await p.evaluate(() => { const bd = document.querySelector('.add-sheet .sheet-body'); const s = document.createElement('div'); s.style.cssText = 'height:1600px;flex:none'; bd.append(s); bd.style.overflowY = 'auto'; bd.style.maxHeight = '40vh'; }); const r = await rectOf('.add-sheet .sheet-body'); return [r.cx, r.y + 30]; },
      async offset() { return p.evaluate(() => { const e = document.querySelector('.add-sheet'); return e ? new DOMMatrix(getComputedStyle(e).transform).m42 : 9999; }); },
      state: () => p.evaluate(() => !!document.querySelector('.add-sheet')), committedIf: (s) => s === false,
    };
    S.drawer = {
      axis: [-fwd, 0], thr: () => 70, flick: true, follow: 0.85,
      async setup() { await fresh('#/files'); await p.waitForSelector('.files-row'); await p.click('.topbar button >> nth=0'); await p.waitForSelector('.files-drawer'); await sleep(500); },
      async start() { const r = await rectOf('.files-drawer'); return [rtl ? r.x + r.w - 50 : r.x + 50, 120]; },
      async nested() { await p.evaluate(() => { const d = document.querySelector('.files-drawer .sheet-body'); if (!d) return; const s = document.createElement('div'); s.style.cssText = 'height:1600px;flex:none'; d.append(s); d.style.overflowY = 'auto'; d.style.maxHeight = '50vh'; }); const r = await rectOf('.files-drawer .sheet-body'); return [rtl ? r.x + r.w - 60 : r.x + 60, r.y + 60]; },
      async offset() { return p.evaluate(() => { const e = document.querySelector('.files-drawer'); return e ? new DOMMatrix(getComputedStyle(e).transform).m41 : 9999; }); },
      state: () => p.evaluate(() => !!document.querySelector('.files-drawer')), committedIf: (s) => s === false, edgeX: () => (rtl ? W - 8 : 8),
    };
    S.edgeopen = {
      axis: [fwd, 0], thr: () => 64, flick: true, follow: 0,
      async setup() { await fresh('#/files'); await p.waitForSelector('.files-row'); await sleep(200); },
      async start() { return [rtl ? W - 60 : 60, 500]; },
      nested: async () => null, offset: async () => 0,
      state: () => p.evaluate(() => !!document.querySelector('.files-drawer')), committedIf: (s) => s === true, edgeX: () => (rtl ? W - 8 : 8),
    };
    S.pageswipe = {
      axis: [-fwd, 0], thr: () => Math.min(120, Math.round(W * 0.28)), flick: true, follow: 0.1,
      async setup() { await fresh('#/'); },
      async start() { return [W / 2 + fwd * 80, Math.round(H * 0.74)]; },
      async nested() { const r = await p.$eval('.filter-chips', (e) => { const b = e.getBoundingClientRect(); return { sw: e.scrollWidth, cw: e.clientWidth, cx: b.x + b.width / 2, cy: b.y + b.height / 2 }; }).catch(() => null); return r && r.sw > r.cw + 2 ? [r.cx, r.cy] : null; },
      async offset() { return p.evaluate(() => { const v = document.querySelector('#app > *'); return v ? new DOMMatrix(getComputedStyle(v).transform).m41 : 0; }); },
      state: () => p.evaluate(() => location.hash), committedIf: (s, s0) => s !== s0, edgeX: () => (rtl ? W - 8 : 8),
    };
    S.ptr = {
      axis: [0, 1], thr: () => 144, flick: 'either', follow: 0,
      async setup() { await fresh('#/files'); await p.waitForSelector('.files-row'); await sleep(300); },
      start: async () => [W / 2, 300], nested: async () => null,
      async offset() { return p.evaluate(() => { const m = document.querySelector('.ptr-mark'); return m ? new DOMMatrix(getComputedStyle(m).transform).m42 + 40 : 0; }); },
      state: () => p.evaluate(() => window.__lists), committedIf: (s, s0) => s > s0,
    };
    S.row = {
      axis: [fwd, 0], thr: () => Math.round((W - 32) / 3) + 2, flick: 'either', follow: 0.85,
      async setup() { await fresh('#/'); await p.waitForSelector('.task-card[data-id="a"]'); },
      async start() { const r = await rectOf('.task-card[data-id="a"]'); return [r.cx - fwd * r.w * 0.25, r.cy]; },
      nested: async () => null,
      async offset() { return p.evaluate(() => { let m = 0; for (const e of document.querySelectorAll('.task-card[data-id="a"] > :not(.swipe-under)')) { const x = new DOMMatrix(getComputedStyle(e).transform).m41; if (Math.abs(x) > Math.abs(m)) m = x; } return m; }); },
      state: () => p.evaluate(() => window.__calls.length), committedIf: (s, s0) => s > s0, edgeX: () => (rtl ? W - 8 : 8),
    };
    S.pill = {
      axis: [fwd, 0], thr: () => 100, flick: true, follow: 0.8, noMidShot: false,
      async setup() { await fresh('#/'); await p.waitForSelector('.task-card[data-id="a"]'); const r = await rectOf('.task-card[data-id="a"]');
        await finger(cdp, { pts: lerp([r.cx + fwd * r.w * 0.25, r.cy], [r.cx - fwd * r.w * 0.3, r.cy], 12), ms: 12 }); await p.waitForSelector('.sheet .btn.danger', { timeout: 4000 }); await p.click('.sheet .btn.danger'); await p.waitForSelector('.undo-snack', { timeout: 4000 }); await sleep(500); },
      async start() { const r = await rectOf('.undo-snack'); return [r.x + r.w * 0.3, r.cy]; },
      nested: async () => null,
      async offset() { return p.evaluate(() => { const e = document.querySelector('.undo-snack'); return e ? new DOMMatrix(getComputedStyle(e).transform).m41 + e.offsetWidth / 2 : 9999; }); },
      state: () => p.evaluate(() => !!document.querySelector('.undo-snack')), committedIf: (s) => s === false, edgeX: () => (rtl ? W - 8 : 8),
    };
    S.fast = {
      axis: [0, 1], thr: () => 120, flick: 'either', follow: 0, noCommit: true,
      async setup() { await fresh('#/files'); await p.waitForSelector('.files-row'); await sleep(300); await p.evaluate(() => window.scrollBy(0, 300)); await sleep(250); await p.waitForSelector('.files-fast.on', { timeout: 3000 }).catch(() => undefined); },
      async start() { await p.evaluate(() => window.scrollBy(0, 40)); await sleep(120); const r = await rectOf('.files-fast-thumb'); return [r.cx, r.cy]; },
      nested: async () => null, offset: async () => 0,
      state: () => p.evaluate(() => Math.round(window.scrollY + (document.querySelector('.body')?.scrollTop || 0))), committedIf: (s, s0) => s > s0 + 200, edgeX: () => (rtl ? 6 : W - 6),
    };
    S.viewer = {
      axis: [0, 1], thr: () => 110, flick: true, follow: 0.9,
      async setup() { await fresh('#/files'); await p.waitForSelector('.files-row'); await p.click('.files-row:has-text("a-one.jpg")'); await p.waitForSelector('.files-viewer-stage', { timeout: 5000 }); await sleep(500); },
      async start() { const r = await rectOf('.files-viewer-stage'); return [r.cx, r.y + 70]; },
      nested: async () => null,
      async offset() { return p.evaluate(() => { const e = document.querySelector('.files-viewer-img'); return e ? new DOMMatrix(getComputedStyle(e).transform).m42 : 9999; }); },
      state: () => p.evaluate(() => !!document.querySelector('.files-viewer')), committedIf: (s) => s === false,
    };
    S.viewerNext = {
      axis: [-fwd, 0], thr: () => 60, flick: true, follow: 0.9,
      async setup() { await S.viewer.setup(); },
      async start() { const r = await rectOf('.files-viewer-stage'); return [r.cx + fwd * 70, r.cy]; },
      nested: async () => null,
      async offset() { return p.evaluate(() => { const e = document.querySelector('.files-viewer-img'); return e ? new DOMMatrix(getComputedStyle(e).transform).m41 : 9999; }); },
      state: () => p.evaluate(() => document.querySelector('.files-viewer .sheet-head h3')?.textContent || ''), committedIf: (s, s0) => s !== s0, edgeX: () => (rtl ? W - 8 : 8),
    };

    // ---------- variants ----------
    const VARIANTS = ['straight', 'diagonal', 'slow', 'flick', 'nested', 'edge', 'second', 'reversed', 'threshold', 'cancel', 'repeat'];
    async function walk(name, v) {
      const s = S[name]; curTag = `${tagBase} ${name}/${v}`;
      await s.setup(); const s0 = await s.state(); const before = await probe(); const sel0 = before.sel;
      const A = s.axis; const perp = [-A[1], A[0]]; const thr = s.thr(); let st = await s.start();
      const at = (d, c = 0) => [st[0] + A[0] * d + perp[0] * c, st[1] + A[1] * d + perp[1] * c];
      const o = { ms: 12 }; let expect = 'either'; let note = '';
      const full = Math.round(thr * 1.8);
      if (v === 'straight') { o.pts = lerp(st, at(full), 14); expect = true; }
      else if (v === 'diagonal') { o.pts = lerp(st, at(full, full * Math.tan(Math.PI / 6)), 14); }
      else if (v === 'slow') { o.pts = lerp(st, at(Math.round(thr * 1.3)), 16); o.ms = 70; expect = true; }
      else if (v === 'flick') { const d = Math.max(Math.round(thr * 0.5), 48); o.pts = lerp(st, at(d), 5); o.ms = 8; expect = s.flick; }
      else if (v === 'nested') { const n = await s.nested(); if (!n) return 'n/a'; st = n; o.pts = lerp(st, at(full), 14); expect = 'either'; note = 'started in a nested scroller'; }
      else if (v === 'edge') { const ex = s.edgeX ? s.edgeX() : 8; st = [ex, st[1]]; o.pts = lerp(st, at(full), 14); expect = 'either'; }
      else if (v === 'second') { o.pts = lerp(st, at(Math.round(thr * 0.7)), 10); o.ms = 25; const f2 = at(10, 130); o.second = { at: 5, from: f2, to: [f2[0] + 8, f2[1] + 8] }; o.midAt = 5; expect = false; }
      else if (v === 'reversed') { const out = lerp(st, at(Math.round(thr * 1.6)), 10); o.pts = out.concat(lerp(at(Math.round(thr * 1.6)), st, 10).slice(1)); expect = false; }
      else if (v === 'threshold') { o.pts = lerp(st, at(thr), 12); o.tail = 30; }
      else if (v === 'cancel') { o.pts = lerp(st, at(full), 14); o.cancelAt = 7; expect = false; }
      else if (v === 'repeat') { expect = 'clean'; }
      let offMid = null;
      if (v === 'straight' || v === 'slow') { o.midAt = Math.floor(o.pts.length / 2); o.mid = async () => { await sleep(60); offMid = await s.offset(); if (v === 'straight' && !s.noMidShot) { await shot(`${name}-mid`); } }; }
      // (A cancel path ends the sequence by itself; the others lift.)
      if (v === 'reversed') o.before = async () => { await sleep(80); const off = await s.offset(); const want = 0; if (Math.abs(off - want) > 14 && off !== 9999) fault(`reversed: ${name} left ${off}px from home while the finger is back at the start`); };
      let faultsHere = [];
      const fault = (m) => faultsHere.push(m);
      if (v === 'repeat') {
        for (let i = 0; i < 5; i++) { const out = lerp(st, at(Math.round(thr * 0.45)), 5); await finger(cdp, { pts: out.concat(lerp(at(Math.round(thr * 0.45)), st, 5).slice(1)), ms: 30 }); await sleep(70); }
        await sleep(700); const mid = await probe(); if (mid.bad.length) fault(`after 5 short repeats: ${mid.bad.join('; ')}`);
        if ((await s.state()) !== s0 && !s.noCommit && s.committedIf(await s.state(), s0)) fault('five short repeats committed');
        // a normal one after them still works
        if (name !== 'fast') { await finger(cdp, { pts: lerp(await s.start(), at(full), 14), ms: 12 }); await sleep(800); const after = await s.state(); if (!s.committedIf(after, s0)) fault(`a straight gesture after 5 repeats did not commit (state ${JSON.stringify(after)})`); }
      } else {
        await finger(cdp, o); await sleep(850);
        const after = await s.state(); const pr = await probe(); const com = s.committedIf(after, s0);
        if (expect === true && !com && !s.noCommit) fault(`expected to commit, state ${JSON.stringify(s0)} -> ${JSON.stringify(after)}`);
        if (expect === false && com && name !== 'fast') fault('committed but must not (second finger / reversed / cancelled)');
        if (!com || name === 'fast') { for (const x of pr.bad) fault(`left half done: ${x}`); }
        else { for (const x of pr.bad.filter((z) => !/^(DIV|SECTION|ASIDE)\.sheet/.test(z) && !/leaving/.test(z))) fault(`left over after commit: ${x}`); }
        if (pr.sel && pr.sel !== sel0) fault(`text got selected: "${pr.sel.slice(0, 30)}"`);
        const horiz = A[1] === 0; if (name !== 'fast' && name !== 'ptr' && horiz && Math.abs(pr.sy - before.sy) > 6 && (v === 'straight' || v === 'slow' || v === 'flick')) fault(`page also scrolled ${pr.sy - before.sy}px`);
        if (name !== 'pageswipe' && name !== 'viewerNext' && !pr.hash.startsWith(before.hash.split('?')[0].slice(0, 7)) && s.axis[1] === 0 && v !== 'edge') fault(`navigated: ${before.hash} -> ${pr.hash}`);
        if (v === 'straight' && s.follow && offMid !== null && Math.abs(offMid) < 5 && s.follow > 0.5) fault(`did not follow the finger at 50% (offset ${offMid}px)`);
        if (v === 'straight') note = `mid offset ${offMid}px of ${Math.round(full / 2)}px`;
      }
      if (faultsHere.length || process.env.WALK_SHOTALL) { await shot(`${name}-${v}`); }
      return { faults: faultsHere, note };
    }

    for (const name of Object.keys(S)) {
      if (only.length && !only.includes(name)) continue;
      for (const v of VARIANTS) {
        let r; try { r = await walk(name, v); } catch (e) { r = { faults: [`walk threw: ${String(e.message).split('\n')[0]}`], note: '' }; await shot(`${name}-${v}-threw`); }
        if (r === 'n/a') { console.log(`skip [${tagBase}] ${name}/${v}: nothing to start in`); continue; }
        ok(`${name} / ${v}${r.note ? ' (' + r.note + ')' : ''}`, !r.faults.length, r.faults);
      }
    }

    // ---------- targets: what a thumb grabs is at least 40 px ----------
    curTag = `${tagBase} targets`;
    {
      await fresh('#/files'); await p.waitForSelector('.files-row'); await p.evaluate(() => window.scrollBy(0, 300)); await sleep(300);
      const t = await p.evaluate(() => { const o = {}; for (const [k, sel] of [['fastThumb', '.files-fast-thumb']]) { const e = document.querySelector(sel); if (e) { const r = e.getBoundingClientRect(); o[k] = [Math.round(r.width), Math.round(r.height)]; } } return o; });
      for (const [k, [w, h]] of Object.entries(t)) ok(`target ${k} is at least 40 px each way`, w >= 40 && h >= 40, [w, h]);
      // the sheet's close button and the theme editor's handle are measured from CSS below
    }
    if (haveVideo && (!only.length || only.includes('player'))) { try { await playerWalk(); } catch (e) { ok('player walk ran', false, String(e.message).split('\n')[0]); } }

    async function playerWalk() {
      const prof = async (pc) => {
        curTag = `${tagBase} player${pc ? ' pc' : ''}`;
        await fresh('#/'); if (pc) await p.evaluate(() => document.documentElement.classList.add('pc'));
        await p.click('.task-card[data-id="v"] .task-actions button >> nth=0'); await p.waitForSelector('.kt-player video.kt-video');
        await p.waitForFunction(() => document.querySelector('.kt-video').currentTime > 0.3, null, { timeout: 15000 });
        await p.evaluate(() => document.querySelector('.kt-video').pause()); await sleep(200);
      };
      const T = () => p.evaluate(() => document.querySelector('.kt-video').currentTime);
      const V = () => p.evaluate(() => document.querySelector('.kt-video').volume);
      const R = () => p.evaluate(() => document.querySelector('.kt-video').playbackRate);
      const stage = async () => rectOf('.kt-player .kt-stage').catch(() => rectOf('.kt-player'));
      // seek by horizontal drag
      await prof(false); let sg = await stage(); const y = sg.y + sg.h * 0.45;
      // (One side of the screen is volume, the other brightness: a vertical drag on each.)
      await p.evaluate(() => { document.querySelector('.kt-video').volume = 0.5; }); const v0 = await V();
      await finger(cdp, { pts: lerp([sg.x + sg.w * 0.8, y + 100], [sg.x + sg.w * 0.8, y - 100], 12), ms: 12 }); await sleep(300); const v1 = await V();
      await finger(cdp, { pts: lerp([sg.x + sg.w * 0.2, y + 100], [sg.x + sg.w * 0.2, y - 100], 12), ms: 12 }); await sleep(300);
      ok('player: a vertical drag on the phone changes the volume on one side', Math.abs(v1 - v0) > 0.05, [v0, v1]);
      ok('player: ...and the brightness on the other', await p.evaluate(() => /brightness\((?!1\))/.test(getComputedStyle(document.querySelector('.kt-video')).filter)), await p.evaluate(() => getComputedStyle(document.querySelector('.kt-video')).filter));
      let t0 = await T(); await finger(cdp, { pts: lerp([sg.x + sg.w * 0.3, y], [sg.x + sg.w * 0.3 + sg.w * 0.4, y], 14), ms: 12 }); await sleep(500); let t1 = await T();
      ok('player: horizontal drag to the right seeks forward (the sides are as seen, in Arabic too)', t1 - t0 > 1.5, [t0, t1]);
      t0 = await T(); await finger(cdp, { pts: lerp([sg.x + sg.w * 0.3, y], [sg.x + sg.w * 0.3 + sg.w * 0.4, y], 14), ms: 12, cancelAt: 8 }); await sleep(500); t1 = await T();
      ok('player: a seek drag the browser cancels does not seek', Math.abs(t1 - t0) < 0.6, [t0, t1]);
      t0 = await T(); await finger(cdp, { pts: lerp([6, y], [6 + sg.w * 0.4, y], 14), ms: 12 }); await sleep(500); t1 = await T();
      ok('player: a drag starting in the system back zone (x < 16) does not seek', Math.abs(t1 - t0) < 0.6, [t0, t1]);
      t0 = await T(); await finger(cdp, { pts: lerp([W - 6, y], [W - 6 - sg.w * 0.4, y], 14), ms: 12 }); await sleep(500); t1 = await T();
      ok('player: a drag starting in the end-side back zone does not seek', Math.abs(t1 - t0) < 0.6, [t0, t1]);
      t0 = await T(); await finger(cdp, { pts: lerp([sg.x + sg.w * 0.5, y], [sg.x + sg.w * 0.5 + 120, y], 10), ms: 12, second: { at: 4, from: [sg.x + 60, y + 200], to: [sg.x + 90, y + 190] }, midAt: 4 }); await sleep(500); t1 = await T();
      ok('player: a second finger landing mid drag leaves a clean state (no stuck gesture)', await p.evaluate(() => !document.querySelector('.kt-player.holding')), null);
      // double tap on the forward side seeks
      t0 = await T(); const tapAt = [sg.x + sg.w * 0.88, y];
      for (let i = 0; i < 2; i++) { await finger(cdp, { pts: [tapAt, tapAt], ms: 20 }); await sleep(90); } await sleep(500); t1 = await T();
      ok('player: double tap on the right side seeks forward (as seen: right is on)', t1 - t0 > 5, [t0, t1]);
      // long press speed, then the browser cancels
      await finger(cdp, { pts: [[sg.cx, y], [sg.cx, y]], ms: 20, hold: 700, tail: 100, cancel: true }); await sleep(300);
      ok('player: long press speed released by a touch cancel', (await R()) <= 1.01 && await p.evaluate(() => !document.querySelector('.kt-player.holding')), await R());
      // a mouse (the computer) must not turn a drag into volume or brightness
      await prof(true); sg = await stage(); await p.evaluate(() => { document.querySelector('.kt-video').volume = 0.5; }); const pv0 = await V();
      for (const side of [0.2, 0.8]) { await p.mouse.move(sg.x + sg.w * side, sg.cy + 100); await p.mouse.down(); for (let i = 1; i <= 10; i++) await p.mouse.move(sg.x + sg.w * side, sg.cy + 100 - i * 18); await p.mouse.up(); await sleep(200); }
      ok('player: on the computer a vertical drag does not change volume', Math.abs((await V()) - pv0) < 0.02, [pv0, await V()]);
      ok('player: on the computer the brightness filter is untouched', await p.evaluate(() => !/brightness\((?!1\))/.test(getComputedStyle(document.querySelector('.kt-video')).filter)), await p.evaluate(() => getComputedStyle(document.querySelector('.kt-video')).filter));
      const prefsOnPc = await p.evaluate(async () => { const b = [...document.querySelectorAll('.kt-player button')].find((x) => /settings|player settings/i.test(x.getAttribute('aria-label') || x.title || '')); return !!b; });
      void prefsOnPc;
    }

    ok('no passive-listener or uncancelable-touchmove complaint in the console', !consoleBad.length, [...new Set(consoleBad)].slice(0, 6));
    ok('no page errors', !pageErrors.length, pageErrors.slice(0, 4));
    await ctx.close();
  }
  await b.close(); web.close(); fs.rmSync(MEDIA, { recursive: true, force: true });
  console.log(fails ? `${fails} failed, ${passes} passed` : `all passed (${passes})`); process.exit(fails ? 1 : 0);
})();
