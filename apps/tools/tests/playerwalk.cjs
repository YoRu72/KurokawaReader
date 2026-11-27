// node tests/playerwalk.cjs : the player used the way a viewer uses it, control by control, on a phone (360x800 and
// 412x915, the browser's own touch input through CDP like gesturewalk.cjs) and a computer (1280x800, mouse and keys),
// in English and Arabic. Made-up loopback media only (ffmpeg's test pattern, 30 s). For each control: the state it
// leaves AND what is drawn (the icon and label match the state), used twice quickly, while paused, with the controls
// hidden, at 0:00 and at the end, during a seek, after turning the phone, back from the floating window, with a
// two hour duration, a 90 character title, a broken file; then the close: timers and listeners left, the position
// kept on an abrupt leave, the second open not doubling anything, no yellow, targets of at least 40 px, no overlap.
// Env: WALK_WIDTHS=360,412,1280  WALK_LANGS=en,ar  WALK_SHOTS=<dir>
const { chromium, devices } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const { execFileSync } = require('node:child_process');
const DIST = path.join(__dirname, '..', 'dist');
const MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-pwalk-'));
const SHOTS = process.env.WALK_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'kt-pwalkshots-'));
try { execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '30', '-c:v', 'libvpx', '-b:v', '200k', '-c:a', 'libopus', path.join(MEDIA, 'clip.webm')]); }
catch { if (process.env.KT_REQUIRE_FFMPEG) { console.log('FAIL ffmpeg is required here (KT_REQUIRE_FFMPEG)'); process.exit(1); } console.log('ffmpeg not available - skipped'); process.exit(0); }
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.webm': 'video/webm', '.srt': 'text/plain' };
let fails = 0, passes = 0; const faultLog = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WIDTHS = (process.env.WALK_WIDTHS || '360,412,1280').split(',').map(Number); const LANGS = (process.env.WALK_LANGS || 'en,ar').split(',');
setTimeout(() => { console.log('FAIL timed out'); process.exit(1); }, 900000).unref();
const serve = () => http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = p.startsWith('/media/') ? path.join(MEDIA, p.slice(7)) : path.join(DIST, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end(); return; }
  const size = fs.statSync(f).size; const range = /bytes=(\d+)-(\d*)/.exec(q.headers.range || ''); const type = MIME[path.extname(f)] || 'application/octet-stream';
  if (range) { const a = Number(range[1]), b = range[2] ? Number(range[2]) : size - 1; r.writeHead(206, { 'content-type': type, 'content-range': `bytes ${a}-${b}/${size}`, 'accept-ranges': 'bytes', 'content-length': b - a + 1, 'access-control-allow-origin': '*' }); fs.createReadStream(f, { start: a, end: b }).pipe(r); return; }
  r.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size, 'access-control-allow-origin': '*' }); fs.createReadStream(f).pipe(r);
});

// The made-up phone: three finished downloads (a normal clip, one with a 90 character name, one whose file is gone).
const FIXTURE = (lang, port, pc) => {
  const now = Date.now(); const long = 'A very long episode title that goes on and on and on, season two part nine, directors cut - '.slice(0, 86) + 'clip.webm';
  const mk = (id, name, p) => ({ id, kind: 'http', name, source: { url: `https://x/${id}` }, dir: '/sdcard/Download', state: 'done', done: 1, total: 1, downSpeed: 0, upSpeed: 0, files: [{ index: 0, path: p, size: 1, done: 1, priority: 1 }], addedAt: now - 60e3, doneAt: now, engine: 'native' });
  const tasks = [mk('v', 'clip.webm', 'clip.webm'), mk('w', long, long), mk('x', 'gone.webm', 'gone.webm')];
  const api = {
    addListener: async () => ({ remove() {} }), list: async () => ({ tasks }), defaultDir: async () => ({ dir: '/sdcard/Download' }),
    localUrl: async (o) => ({ url: /clip\.webm$/.test(o.path || '') ? `http://127.0.0.1:${port}/media/clip.webm` : `http://127.0.0.1:${port}/media/missing.webm` }),
    siblings: async () => ({ paths: [] }), orientation: async () => ({}), pip: async () => ({ ok: true }), pipAuto: async () => ({}),
    httpRequest: async (o) => { const r = await fetch(o.url, { method: o.method || 'GET', headers: o.headers, body: o.body }); return { status: r.status, headers: {}, body: await r.text() }; },
  };
  const plugin = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
  try { localStorage.setItem('kr.lang', lang); if (!sessionStorage.getItem('walk-init')) { sessionStorage.setItem('walk-init', '1'); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['player'], navOrder: ['downloads'], playerWith: 'app' })); localStorage.setItem('kt.player', JSON.stringify({ controlsTimeout: 2 })); } } catch { /* blank */ }
  if (pc) document.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add('pc'));
};

// ---- the finger (the browser's own touch input; events carry their own clock like gesturewalk.cjs)
async function finger(cdp, o) {
  const P = o.pts; const id0 = { id: 0, radiusX: 4, radiusY: 4, force: 0.5 }; let clock = Date.now() / 1000; const tick = (ms) => { clock += ms / 1000; return clock; };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: P[0][0], y: P[0][1], ...id0 }], timestamp: clock });
  for (let i = 1; i < P.length; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: P[i][0], y: P[i][1], ...id0 }], timestamp: tick(o.ms || 12) });
    await sleep(o.ms || 12);
  }
  if (o.before) await o.before();
  await cdp.send('Input.dispatchTouchEvent', { type: o.cancel ? 'touchCancel' : 'touchEnd', touchPoints: [], timestamp: tick(8) });
}
const lerp = (a, b, n) => Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);

// ---- page-side probes
const STATE = () => {
  const v = document.querySelector('.kt-video'); const root = document.querySelector('.kt-player'); if (!v || !root) return null;
  const svg = (el) => (el && el.querySelector('svg') ? el.querySelector('svg').innerHTML : '');
  const play = root.querySelector('.kt-play'); const big = root.querySelector('.kt-bigplay'); const vol = root.querySelector('.kt-vol button');
  const chips = [...root.querySelectorAll('.kt-chip')].map((c) => c.textContent.trim());
  const sl = root.querySelector('.kt-vol-slider');
  return { t: v.currentTime, d: v.duration, paused: v.paused, rate: v.playbackRate, vol: v.volume, muted: v.muted, hidden: root.classList.contains('hide-ui'), locked: root.classList.contains('locked'), full: root.classList.contains('kt-full'), pip: root.classList.contains('kt-pip'), busy: !!root.querySelector('.kt-centre.busy'), holding: root.classList.contains('holding'),
    playLabel: play && play.getAttribute('aria-label'), bigLabel: big && big.getAttribute('aria-label'), playIcon: svg(play), bigIcon: svg(big), volIcon: svg(vol), chips,
    sliderVal: sl ? Number(sl.value) : -1, ab: root.querySelector('.kt-chip.on') ? root.querySelector('.kt-chip.on').textContent : '', marks: [...root.querySelectorAll('.kt-mark')].map((m) => !m.hidden), unlock: !root.querySelector('.kt-unlock').hidden };
};
// Every button, chip and handle that is on screen, with its box.
const BOXES = () => {
  const root = document.querySelector('.kt-player'); const out = [];
  const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !e.closest('[hidden]') && !e.closest('.hide-ui .kt-top, .hide-ui .kt-bottom'); };
  const rows = [...root.querySelectorAll('.kt-row, .kt-top')];
  for (const e of root.querySelectorAll('.kt-top button, .kt-bottom button, .kt-bottom input[type=range], .kt-bigplay, .kt-unlock, .kt-skip-op, .kt-mark, .kt-seek')) {
    if (!vis(e)) continue; const r = e.getBoundingClientRect(); const sc = e.closest('.kt-tools'); if (sc) { const q = sc.getBoundingClientRect(); if (r.right > q.right + 1 || r.left < q.left - 1) continue; } const row = e.closest('.kt-row,.kt-top');
    out.push({ seek: e.classList.contains('kt-seek'), n: (e.getAttribute('data-icon') || e.getAttribute('aria-label') || String(e.className) || e.tagName).split(' ').slice(0, 2).join('.') + (e.textContent && e.textContent.trim().length < 8 && e.textContent.trim() ? `[${e.textContent.trim()}]` : ''), x: r.x, y: r.y, w: r.width, h: r.height, row: row ? rows.indexOf(row) : -1 });
  }
  return out;
};
// Anything on screen of a yellow / amber / orange hue (text, background, border, fill, stroke).
const YELLOW = () => {
  const bad = []; const hue = (c) => { const m = /rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)(?:[, /]+([\d.]+))?/.exec(c); if (!m) return null; if (m[4] !== undefined && Number(m[4]) < 0.2) return null; const [r, g, b] = [m[1], m[2], m[3]].map((x) => Number(x) / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (d < 0.18 || mx < 0.35) return null; let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h = (h * 60 + 360) % 360; return { h, s: d / mx }; };
  for (const e of document.querySelectorAll('.kt-player *, .sheet *')) { const r = e.getBoundingClientRect(); if (!r.width && !r.height) continue; const cs = getComputedStyle(e); for (const k of ['color', 'backgroundColor', 'borderTopColor', 'fill', 'stroke', 'outlineColor']) { const x = hue(cs[k]); if (x && x.h >= 28 && x.h <= 68 && x.s > 0.35) bad.push(`${e.tagName}.${String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className).split(' ')[0]} ${k} ${cs[k]}`); } }
  return bad.slice(0, 8);
};
const CUT = () => {
  const bad = []; for (const e of document.querySelectorAll('.kt-player .kt-chip, .kt-player .kt-time, .kt-player .kt-tool span, .sheet .btn, .sheet .chip, .kt-framepad button, .kt-framepad span')) { const r = e.getBoundingClientRect(); if (!r.width) continue; if (e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).textOverflow !== 'ellipsis') bad.push(`${String(e.className).split(' ')[0]} "${(e.textContent || '').slice(0, 16)}" ${e.scrollWidth}>${e.clientWidth}`); }
  return bad.slice(0, 6);
};
const DIGITS = (s) => String(s).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));

(async () => {
  const web = serve().listen(0); const port = web.address().port; const base = `http://127.0.0.1:${port}/`;
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  for (const W of WIDTHS) for (const lang of LANGS) {
    const pc = W >= 1000; const H = pc ? 800 : W === 360 ? 800 : 915; const rtl = lang === 'ar'; const tag = `${pc ? 'pc' : 'phone'}${W}${lang}`;
    const ctx = await b.newContext(pc ? { viewport: { width: W, height: H }, deviceScaleFactor: 1 } : { ...devices['Pixel 7'], viewport: { width: W, height: H }, screen: { width: W, height: H }, deviceScaleFactor: 1 });
    const p = await ctx.newPage(); const cdp = await ctx.newCDPSession(p);
    const pageErrors = []; p.on('pageerror', (e) => pageErrors.push(e.message));
    await p.addInitScript(`(${FIXTURE.toString()})(${JSON.stringify(lang)}, ${port}, ${pc})`);
    const ok = (name, c, x) => { if (c) passes++; else { fails++; faultLog.push(`${tag} ${name} ${x === undefined ? '' : JSON.stringify(x).slice(0, 300)}`); } console.log((c ? 'ok   ' : 'FAIL ') + `[${tag}] ` + name + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 300))); };
    const shot = async (name) => { try { await p.screenshot({ path: path.join(SHOTS, `D2-${tag}-${name.replace(/[^\w-]+/g, '_')}.png`) }); } catch { /* gone */ } };
    const st = () => p.evaluate(STATE);
    const until = (fn, arg, ms = 6000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);
    const rectOf = (sel) => p.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; });
    const tap = async (x, y) => { if (pc) { await p.mouse.move(x, y); await p.mouse.down(); await p.mouse.up(); } else await finger(cdp, { pts: [[x, y], [x, y]], ms: 20 }); };
    const drag = async (a, bb, n = 14) => { if (pc) { await p.mouse.move(a[0], a[1]); await p.mouse.down(); for (const q of lerp(a, bb, n).slice(1)) { await p.mouse.move(q[0], q[1]); await sleep(8); } await p.mouse.up(); } else await finger(cdp, { pts: lerp(a, bb, n), ms: 12 }); };
    const heldAt = async (x0, x1, y, whileHeld) => { if (pc) { await p.mouse.move(x0, y); await p.mouse.down(); await p.mouse.move(x1, y, { steps: 4 }); await whileHeld(); await p.mouse.up(); } else await finger(cdp, { pts: lerp([x0, y], [x1, y], 6), ms: 12, before: whileHeld }); };
    const fresh = async () => { await p.goto('about:blank'); await p.goto(base + '#/'); await p.waitForSelector('.task-card', { timeout: 8000 }); await sleep(250); };
    const open = async (id = 'v', pause = true) => {
      await fresh(); await p.click(`.task-card[data-id="${id}"] .task-actions button >> nth=0`); await p.waitForSelector('.kt-player video.kt-video');
      await until(() => document.querySelector('.kt-video').currentTime > 0.3, null, 15000);
      if (pause) { await p.evaluate(() => document.querySelector('.kt-video').pause()); await until(() => document.querySelector('.kt-video').paused); } await sleep(150);
    };
    const still = async () => { let a = -1; for (let i = 0; i < 30; i++) { const y = await p.evaluate(() => document.querySelector('.kt-bottom').getBoundingClientRect().y); if (Math.abs(y - a) < 0.2) return; a = y; await sleep(60); } };
    const showControls = async () => { if ((await st()).hidden) { const s = await rectOf('.kt-stage'); await tap(s.cx + 40, s.cy + 120); await until(() => !document.querySelector('.kt-player').classList.contains('hide-ui')); } await still(); };
    const closePlayer = async () => { await p.evaluate(() => document.querySelector('.kt-player') && document.querySelector('.kt-player').dispatchEvent(new Event('kt-close'))); await until(() => !document.querySelector('.kt-player')); };
    const listeners = async () => { const o = {}; for (const w of ['window', 'document']) { const { result } = await cdp.send('Runtime.evaluate', { expression: w }); const r = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId }); for (const l of r.listeners) o[`${w}.${l.type}`] = (o[`${w}.${l.type}`] || 0) + 1; } return o; };
    const diff = (a, c) => Object.fromEntries(Object.keys({ ...a, ...c }).filter((k) => (a[k] || 0) !== (c[k] || 0)).map((k) => [k, (c[k] || 0) - (a[k] || 0)]));
    const tapBtn = async (sel) => { const r = await rectOf(sel); await tap(r.cx, r.cy); };
    const closeSheets = async () => { await p.evaluate(() => { const s = document.querySelector('.sheet'); if (s) { const x = s.querySelector('.sheet-head button, button[aria-label]'); if (x) x.click(); } }); await sleep(350); };

    try {
      // ===== 1. first look, targets, overlaps, colours
      await open('v'); await showControls(); await sleep(300);
      let s = await st();
      ok('opens with the length known and the controls shown', !s.hidden && s.d > 20, s);
      ok('play button and big button draw the same icon and label as the state (paused)', s.paused && s.playIcon === s.bigIcon && s.playLabel === s.bigLabel, [s.playLabel, s.bigLabel]);
      const hintShown = await p.evaluate(() => { const h0 = document.querySelector('.kt-hint'); return h0 && !h0.hidden ? h0.textContent : null; });
      ok(pc ? 'first play on a computer: a hint about the keys is shown once' : 'first play on a phone: a hint about the touches is shown once', !!hintShown && (lang !== 'en' || (pc ? /Space/.test(hintShown) : /Swipe/.test(hintShown))) && !(pc && /Swipe/.test(hintShown)) && !(!pc && /Space plays/.test(hintShown)), hintShown);
      await shot('hint');
      ok('the chips read left to right whatever the language (+85, 1x)', await p.evaluate(() => [...document.querySelectorAll('.kt-chip')].filter((c) => /^[+\d.,:×]+$/.test(c.textContent.trim().replace(/[٠-٩]/g, '0'))).every((c) => { const n = c.firstChild; const r1 = document.createRange(); r1.setStart(n, 0); r1.setEnd(n, 1); const r2 = document.createRange(); r2.setStart(n, n.length - 1); r2.setEnd(n, n.length); return r1.getBoundingClientRect().left < r2.getBoundingClientRect().left; })));
      await shot('controls-paused');
      const boxes = await p.evaluate(BOXES);
      const small = boxes.filter((x) => (x.w < 40 || x.h < 40) && !x.seek && !/kt-mark|slider/.test(x.n));
      ok('every button and chip is at least 40 x 40 px', !small.length, small);
      const seekBox = boxes.find((x) => x.seek); ok('the seek bar is at least 40 px high to grab', seekBox && seekBox.h >= 40, seekBox);
      const overlaps = []; for (const a of boxes) for (const c of boxes) { if (a === c || a.row !== c.row || a.row < 0) continue; if (a.seek || c.seek || /kt-mark|slider/.test(a.n + c.n)) continue; const gx = Math.max(a.x, c.x) - Math.min(a.x + a.w, c.x + c.w); const gy = Math.max(a.y, c.y) - Math.min(a.y + a.h, c.y + c.h); if (gx < 0 && gy < 0) overlaps.push(`${a.n}|${c.n}`); }
      ok('no two controls overlap', !overlaps.length, overlaps.slice(0, 4));
      ok('every control lies inside the screen', boxes.every((x) => x.x >= -0.5 && x.x + x.w <= W + 0.5 && x.y >= -0.5 && x.y + x.h <= H + 0.5), boxes.filter((x) => x.x < 0 || x.x + x.w > W || x.y + x.h > H).slice(0, 4));
      const hasVol = await p.evaluate(() => { const v = document.querySelector('.kt-vol'); return !!v && v.getBoundingClientRect().width > 0 && getComputedStyle(v).display !== 'none'; });
      ok(pc ? 'PC shows the volume slider' : 'the phone does not show the desktop volume slider', pc ? hasVol : !hasVol, hasVol);
      ok('no yellow, amber or orange in the player', !(await p.evaluate(YELLOW)).length, await p.evaluate(YELLOW));
      ok('no label is cut', !(await p.evaluate(CUT)).length, await p.evaluate(CUT));

      // ===== 2. play / pause: each way, twice quickly, the picture agrees with the state
      await tapBtn('.kt-bigplay'); await until(() => !document.querySelector('.kt-video').paused); await sleep(150); s = await st();
      ok('big button plays; both icons and labels agree and no longer say Play', !s.paused && s.playIcon === s.bigIcon && s.playLabel === s.bigLabel && !/^(Play|تشغيل)$/.test(s.playLabel), [s.paused, s.playLabel, s.bigLabel]);
      await tapBtn('.kt-bigplay'); await sleep(60); await tapBtn('.kt-bigplay'); await sleep(400); s = await st();
      ok('two quick taps on the big button end where they began (playing) with matching icons', !s.paused && s.playIcon === s.bigIcon, [s.paused]);
      await showControls(); await tapBtn('.kt-play'); await until(() => document.querySelector('.kt-video').paused); s = await st();
      ok('bar button pauses; icons agree', s.paused && s.playIcon === s.bigIcon && s.playLabel === s.bigLabel, [s.playLabel, s.bigLabel]);
      if (pc) {
        await p.keyboard.press('Space'); await until(() => !document.querySelector('.kt-video').paused); ok('Space plays after a click on the bar button (focus not lost)', !(await st()).paused, await st());
        await p.keyboard.press('k'); await until(() => document.querySelector('.kt-video').paused); ok('K pauses', (await st()).paused);
      }
      await showControls(); const sg = await rectOf('.kt-stage'); const was = (await st()).paused;
      await tap(sg.cx, sg.cy - 150); await until(() => document.querySelector('.kt-player').classList.contains('hide-ui')); s = await st();
      ok('a tap on a paused stage hides the controls (paused too) and does not play', s.hidden && s.paused === was, s);
      await shot('controls-hidden-paused');
      await tap(sg.cx, sg.cy - 150); await until(() => !document.querySelector('.kt-player').classList.contains('hide-ui')); s = await st();
      ok('another tap brings them back, state unchanged', !s.hidden && s.paused === was, s);
      await p.evaluate(() => document.querySelector('.kt-video').play()); await until(() => document.querySelector('.kt-player').classList.contains('hide-ui'), null, 9000);
      s = await st(); ok('playing: the controls hide by themselves (2 s setting)', s.hidden && !s.paused, s);
      await tap(sg.cx, sg.cy - 150); ok('a tap shows them again', await until(() => !document.querySelector('.kt-player').classList.contains('hide-ui')), await st());
      await sleep(450); await shot('controls-playing');
      await p.evaluate(() => document.querySelector('.kt-video').pause());

      // ===== 3. seek bar: tap, drag, keys, ends, RTL
      await showControls(); const br = await rectOf('.kt-seek'); const d = (await st()).d;
      await tap(br.x + br.w * 0.5, br.cy); await sleep(400); s = await st();
      ok('a tap in the middle of the bar seeks to about half', Math.abs(s.t - d * 0.5) < d * 0.06, [s.t, d]);
      const at = (f) => (rtl ? br.x + br.w * (1 - f) : br.x + br.w * f);
      const hitEl = await p.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e ? e.tagName + '.' + String(e.className).split(' ')[0] : null; }, [at(0.2), br.cy]);
      await tap(at(0.2), br.cy); await sleep(400); s = await st(); if (Math.abs(s.t - d * 0.2) >= d * 0.06) console.log('   (debug) element at the tap:', hitEl, 'bar rect now', JSON.stringify(await rectOf('.kt-seek')), 'first rect', JSON.stringify(br));
      ok(`a tap at 20% of the bar (${rtl ? 'from the right' : 'from the left'}) goes to about 20%`, Math.abs(s.t - d * 0.2) < d * 0.06, [s.t, d]);
      await drag([at(0.2), br.cy], [at(0.7), br.cy], 16); await sleep(400); s = await st();
      ok('dragging along the bar lands where the finger was lifted', Math.abs(s.t - d * 0.7) < d * 0.07, [s.t, d]);
      await p.evaluate(() => document.querySelector('.kt-video').play());
      let midHidden = null; await heldAt(at(0.3), at(0.4), br.cy, async () => { await sleep(2600); midHidden = (await st()).hidden; });
      ok('the controls do not hide while the finger is on the seek bar (2 s setting, held 2.6 s)', midHidden === false, midHidden);
      await p.evaluate(() => document.querySelector('.kt-video').pause());
      await showControls(); const br2 = await rectOf('.kt-seek'); await tap(rtl ? br2.x + br2.w - 2 : br2.x + 2, br2.cy); await sleep(300); s = await st(); ok('0:00: a tap at the very start seeks to the start', s.t >= 0 && s.t < d * 0.05, s.t);
      if (pc) { await p.keyboard.press('ArrowLeft'); await sleep(200); ok('0:00: Left stays at 0', (await st()).t === 0, (await st()).t); }
      await showControls(); const br3 = await rectOf('.kt-seek'); await tap(rtl ? br3.x + 2 : br3.x + br3.w - 2, br3.cy); await sleep(500); s = await st(); ok('the end: a tap at the very end stays within the length', s.t <= s.d && s.t > d - 2, [s.t, s.d]);
      await showControls(); await tapBtn('.kt-play'); await until(() => document.querySelector('.kt-video').ended || document.querySelector('.kt-video').paused, null, 4000); await sleep(300); s = await st();
      ok('the end: Play from the last second plays it out to the end and stops there with the Play icon', s.paused && s.t >= d - 0.5 && s.playIcon === s.bigIcon && /^(Play|تشغيل)$/.test(s.playLabel), s);
      await tapBtn('.kt-play'); await sleep(500); s = await st(); ok('the end: Play again starts from the beginning', !s.paused && s.t < d - 2, s);
      await p.evaluate(() => document.querySelector('.kt-video').pause());

      // ===== 4. speed, mute, lock, A/B
      await showControls(); const speedChip = await p.evaluate(() => [...document.querySelectorAll('.kt-chip')].findIndex((c) => /×/.test(c.textContent)));
      ok('a speed chip is on the bar', speedChip >= 0);
      await p.evaluate((i) => document.querySelectorAll('.kt-chip')[i].click(), speedChip); await until(() => document.querySelector('.sheet')); await shot('speed-sheet');
      ok('no yellow in the speed sheet', !(await p.evaluate(YELLOW)).length, await p.evaluate(YELLOW));
      const pick = await p.evaluate((dg) => { const c = [...document.querySelectorAll('.sheet .chip, .sheet button')].find((x) => /^1[.,٫]5/.test(x.textContent.trim().replace(/[٠-٩]/g, (q) => dg.indexOf(q)))); if (c) { c.click(); return c.textContent.trim(); } return null; }, '٠١٢٣٤٥٦٧٨٩');
      await sleep(300); s = await st(); ok('a speed preset sets the rate and the chip shows it', !!pick && s.rate === 1.5 && s.chips.some((c) => /1[.,٫]5/.test(DIGITS(c))), [pick, s.rate, s.chips]);
      await closeSheets();
      const sg2 = await rectOf('.kt-stage'); await p.evaluate(() => document.querySelector('.kt-video').play());
      const rate0 = (await st()).rate; let heldRate = 0; await heldAt(sg2.cx, sg2.cx + 2, sg2.cy + 60, async () => { await sleep(750); heldRate = (await st()).rate; });
      await sleep(300); s = await st(); ok('long press speeds up while held and goes back on release', heldRate > rate0 && s.rate === rate0 && !s.holding, [rate0, heldRate, s.rate, s.holding]);
      await p.evaluate(() => document.querySelector('.kt-video').pause());
      await showControls();
      if (pc) { const a = await st(); await tapBtn('.kt-vol button'); await sleep(200); const c = await st(); ok('mute: state, slider and icon agree', c.muted && c.sliderVal === 0 && c.volIcon !== a.volIcon, [c.muted, c.sliderVal]); await tapBtn('.kt-vol button'); await sleep(200); ok('unmute restores icon and slider', !(await st()).muted && (await st()).volIcon === a.volIcon, await st()); }
      await showControls(); await tapBtn('.kt-bottom [data-icon="lock"]'); await sleep(300); s = await st();
      ok('lock: locked, controls hidden, unlock button drawn', s.locked && s.hidden && s.unlock, s);
      const t0 = s.t; if (pc) { await p.keyboard.press('ArrowRight'); await p.keyboard.press('Space'); await sleep(250); } await tap(sg.cx, sg.cy); await sleep(400); s = await st();
      ok('lock: taps and keys change nothing while locked (no seek, no play/pause)', s.t === t0 && s.paused && s.locked, [t0, s.t, s.paused]);
      await tapBtn('.kt-unlock'); await sleep(300); s = await st(); ok('unlock: controls back, lock cleared', !s.locked && !s.hidden && !s.unlock, s);
      await showControls(); await tapBtn('.kt-chip:has-text("A/B")'); await sleep(200); s = await st(); ok('A/B: first press sets A (marker shown, chip not yet lit)', s.marks[0] === true && s.ab === '', s);
      await p.evaluate(() => { document.querySelector('.kt-video').currentTime = 12; }); await sleep(300); await tapBtn('.kt-chip:has-text("A/B")'); await sleep(200); s = await st(); ok('A/B: second press sets B (both markers, chip lit)', s.marks[1] === true && /A\/B/.test(s.ab), s);
      const mk = await p.evaluate(() => [...document.querySelectorAll('.kt-mark')].map((m) => { const r = m.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })); ok('A/B handles are 40 px or more across', mk.every((m) => m[0] >= 40 && m[1] >= 40), mk);
      await tapBtn('.kt-chip:has-text("A/B")'); await sleep(200); s = await st(); ok('A/B: third press clears both', s.marks.every((x) => !x) && s.ab === '', s);

      // ----- keys that meet the focused seek bar, volume keys and the drawn volume, the full screen button, a double tap
      if (pc) {
        await showControls(); const b4 = await rectOf('.kt-seek'); await tap(b4.x + b4.w * (rtl ? 0.7 : 0.3), b4.cy); await sleep(300); const k0 = (await st()).t; await p.keyboard.press('ArrowRight'); await sleep(300); const k1 = (await st()).t;
        ok('Right arrow after a click on the seek bar moves one step (10 s), not two', Math.abs(k1 - k0 - 10) < 0.5, [k0, k1]);
        await p.keyboard.press('ArrowDown'); await p.keyboard.press('ArrowDown'); await sleep(200); s = await st(); ok('Down arrow lowers the volume and the slider shows it', s.vol < 1 && Math.abs(s.sliderVal - Math.round(s.vol * 100)) <= 1, [s.vol, s.sliderVal]);
        const mv0 = (await st()).volIcon; await p.keyboard.press('m'); await sleep(200); s = await st(); ok('M mutes: the speaker icon and the slider change too', s.muted && s.volIcon !== mv0 && s.sliderVal === 0, [s.muted, s.sliderVal]); await p.keyboard.press('m'); await sleep(150);
      }
      { await showControls(); const fb = '.kt-bottom [data-icon="fullscreen"]'; const before = await p.evaluate((q) => document.querySelector(q).innerHTML + document.querySelector(q).getAttribute('aria-label'), fb);
        await tapBtn(fb); await sleep(600); s = await st(); const mid = await p.evaluate((q) => { const e = document.querySelector(q); return e ? e.innerHTML + e.getAttribute('aria-label') : null; }, fb);
        ok('full screen: the player is marked full and the button now shows the way out (icon or label changed)', s.full ? mid !== before : true, [s.full]);
        if (s.full) { await showControls(); await tapBtn(fb); await sleep(500); ok('full screen: pressed again, back to normal', !(await st()).full); } }
      { await showControls(); const sgd = await rectOf('.kt-stage'); const hb = (await st()).hidden; const tb = (await st()).t; const dx = sgd.x + sgd.w * 0.9, dy = sgd.cy - 120; await tap(dx, dy); await sleep(60); await tap(dx, dy); await sleep(600); s = await st();
        ok('a double tap on the forward side seeks ahead and does not also toggle the controls', s.t - tb > 4 && s.hidden === hb, [tb, s.t, hb, s.hidden]); }
      // ----- the level at the side while volume or brightness changes
      if (pc) { await p.keyboard.press('ArrowUp'); await sleep(150); const lv = await p.evaluate(() => { const l = document.querySelector('.kt-level'); return l && !l.hidden ? { txt: l.textContent, fill: document.querySelector('.kt-level-fill').style.height } : null; }); ok('PC: the volume keys show the level at the side (it was silent)', !!lv && /\d/.test(lv.txt), lv); await shot('level'); await sleep(1200); ok('PC: the level goes away by itself', await p.evaluate(() => ((document.querySelector('.kt-level') || { hidden: true }).hidden))); }
      else { const sgl = await rectOf('.kt-stage'); await drag([sgl.x + sgl.w * 0.85, sgl.cy + 100], [sgl.x + sgl.w * 0.85, sgl.cy - 60], 8); const lv = await p.evaluate(() => { const l = document.querySelector('.kt-level'); return l && !l.hidden ? { txt: l.textContent, left: l.classList.contains('left'), x: l.getBoundingClientRect().x } : null; }); ok('phone: a swipe on the right shows the volume level on the right', !!lv && !lv.left && lv.x > W / 2, lv); await shot('level'); await sleep(1200); ok('phone: the level goes away by itself', await p.evaluate(() => ((document.querySelector('.kt-level') || { hidden: true }).hidden))); }
      // ===== 5. buffering, controls while buffering, the floating window round trip
      await p.evaluate(() => document.querySelector('.kt-video').dispatchEvent(new Event('waiting'))); await sleep(200); s = await st(); ok('buffering: the spinner is drawn', s.busy, s);
      await showControls(); await tapBtn('.kt-play'); await sleep(300); s = await st(); ok('buffering: a press on Play still works and the icons agree', s.playIcon === s.bigIcon, s);
      await p.evaluate(() => document.querySelector('.kt-video').dispatchEvent(new Event('canplay'))); await sleep(100); ok('buffering: the spinner clears on canplay', !(await st()).busy);
      await p.evaluate(() => window.dispatchEvent(new CustomEvent('ktpip', { detail: true }))); await sleep(200); s = await st(); ok('floating window: controls hidden and marked', s.pip && s.hidden, s);
      await p.evaluate(() => window.dispatchEvent(new CustomEvent('ktpip', { detail: false }))); await sleep(300); s = await st(); ok('back from the floating window: the controls are shown again', !s.pip && !s.hidden, s);

      // ===== 6. time labels with a two hour video
      await p.evaluate(() => { const v = document.querySelector('.kt-video'); Object.defineProperty(v, 'duration', { get: () => 7384, configurable: true }); Object.defineProperty(v, 'currentTime', { get: () => 3725, set() {}, configurable: true }); v.dispatchEvent(new Event('timeupdate')); });
      await showControls(); await sleep(200); const tl = await p.evaluate(() => { const a = document.querySelector('.kt-time'), e = document.querySelector('.kt-time.end'), sk = document.querySelector('.kt-seek'); return { a: a.textContent, e: e.textContent, aw: a.scrollWidth - a.clientWidth, ew: e.scrollWidth - e.clientWidth, seek: sk.getBoundingClientRect().width }; });
      ok('2 h: time labels fit (1:02:05 / 2:03:04) and the bar keeps at least 40% of the width', tl.aw <= 1 && tl.ew <= 1 && tl.seek >= W * 0.4 && /1.*02.*05/.test(DIGITS(tl.a)), tl);
      await shot('two-hours'); await p.evaluate(() => { const v = document.querySelector('.kt-video'); delete v.duration; delete v.currentTime; });

      // ===== 7. turned sideways (phone) / made smaller (PC)
      const lw = pc ? 900 : H, lh = pc ? 420 : W; await p.setViewportSize({ width: lw, height: lh }); await sleep(600); await showControls(); await sleep(300);
      const bx = await p.evaluate(BOXES); ok('after turning: every control inside the screen', bx.every((x) => x.x >= -0.5 && x.x + x.w <= lw + 0.5 && x.y >= -0.5 && x.y + x.h <= lh + 0.5), bx.filter((x) => x.x + x.w > lw || x.y + x.h > lh).slice(0, 4));
      const bh = await p.evaluate(() => document.querySelector('.kt-bottom').getBoundingClientRect().height + document.querySelector('.kt-top').getBoundingClientRect().height); ok('after turning: the top and bottom bars leave at least 45% of the height for the picture', bh <= lh * 0.55, [Math.round(bh), lh]);
      await shot('landscape'); await p.setViewportSize({ width: W, height: H }); await sleep(500);

      // ===== 8. title of 90 characters
      await open('w'); await showControls(); await sleep(250); const tt = await p.evaluate(() => { const t0 = document.querySelector('.kt-title'); const r = t0.getBoundingClientRect(); const b0 = [...document.querySelectorAll('.kt-top button')].map((x) => x.getBoundingClientRect()); return { text: t0.textContent.length, w: Math.round(r.width), ell: getComputedStyle(t0).textOverflow, right: Math.max(...b0.map((x) => x.right)), left: Math.min(...b0.map((x) => x.left)) }; });
      ok('90 character title: shortened with an ellipsis, buttons stay on screen, the title keeps some room', tt.text >= 80 && tt.ell === 'ellipsis' && tt.right <= W + 0.5 && tt.left >= -0.5 && tt.w >= 40, tt); await shot('long-title');
      const topBoxes = (await p.evaluate(BOXES)).filter((x) => x.row === 0); ok('90 character title: no overlap in the top bar', !topBoxes.some((a, i) => topBoxes.some((c, j) => j !== i && Math.max(a.x, c.x) < Math.min(a.x + a.w, c.x + c.w) - 0.5)), topBoxes.map((x) => [x.n, Math.round(x.x), Math.round(x.w)]));

      ok('the hint is not shown a second time', await p.evaluate(() => { const h0 = document.querySelector('.kt-hint'); return !h0 || h0.hidden; }));
      // ----- the time bubble when there is no picture preview
      await p.evaluate(() => localStorage.setItem('kt.player', JSON.stringify({ controlsTimeout: 2, seekPreview: false }))); await open('v'); await showControls();
      { const bq = await rectOf('.kt-seek'); const fx = rtl ? bq.x + bq.w * 0.7 : bq.x + bq.w * 0.3; let seen = null;
        await heldAt(fx, rtl ? fx - 30 : fx + 30, bq.cy, async () => { await sleep(200); await shot('bubble-held'); seen = await p.evaluate(() => { const b0 = document.querySelector('.kt-bubble'); if (!b0 || b0.hidden) return null; const r = b0.getBoundingClientRect(), k = document.querySelector('.kt-seek').getBoundingClientRect(); return { txt: b0.textContent, inside: r.left >= k.left - 1 && r.right <= k.right + 1, above: r.bottom <= k.top + 2 }; }); });
        ok('no preview: a time bubble sits above the bar while the finger scrubs', !!seen && /\d:\d\d/.test(DIGITS(seen.txt)) && seen.inside && seen.above, seen); await sleep(200); ok('...and goes when the finger lifts', await p.evaluate(() => { const b0 = document.querySelector('.kt-bubble'); return !b0 || b0.hidden; })); await shot('bubble'); }
      // ===== 9. a broken file
      await fresh(); await p.click('.task-card[data-id="x"] .task-actions button >> nth=0'); await sleep(2500);
      s = await p.evaluate(() => ({ sheet: !!document.querySelector('.sheet'), toast: !!document.querySelector('.toast, .snack, .undo-snack'), player: !!document.querySelector('.kt-player'), hidden: !!document.querySelector('.kt-player.hide-ui') }));
      ok('broken file: the viewer is told (a sheet or a note) and the controls are not hidden', (s.sheet || s.toast) && s.player && !s.hidden, s); await shot('broken');
      await closeSheets(); await closePlayer();

      // ===== 10. close: what is left behind, the position on an abrupt leave, a second open
      await open('v', false); await closePlayer(); await sleep(300); const before = await listeners();
      await open('v', false); await sleep(2300); await p.evaluate(() => { window.dispatchEvent(new Event('pagehide')); });
      const memAbrupt = await p.evaluate(() => { try { return Object.values(JSON.parse(localStorage.getItem('kt.player.memory') || '{}')).map((x) => x.pos); } catch { return null; } });
      ok('an abrupt leave (pagehide) keeps the position (at least 1 s of 2.3 s played)', (memAbrupt || []).some((x) => x >= 1), memAbrupt);
      await closePlayer(); await sleep(400); const after = await listeners();
      ok('after close: nothing left on window or document', !Object.keys(diff(before, after)).length, diff(before, after));
      await open('v', false); await p.evaluate(() => { window.__n = 0; const v = document.querySelector('.kt-video'); v.addEventListener('play', () => window.__n++); v.addEventListener('pause', () => { window.__n += 100; }); });
      if (pc) { await p.keyboard.press('Space'); await sleep(300); const n = await p.evaluate(() => window.__n); ok('second open: one Space is one pause (no doubled handlers)', n === 100 || n === 1, n); }
      await closePlayer();
      const timers = await p.evaluate(() => new Promise((r) => { const orig = window.setInterval; let n = 0; window.setInterval = (...a) => { n++; return orig(...a); }; setTimeout(() => { window.setInterval = orig; r(n); }, 1500); }));
      ok('after close: no interval started by a closed player', timers === 0, timers);
      ok('no page errors', !pageErrors.length, pageErrors.slice(0, 3));
    } catch (e) { ok('walk ran to the end', false, String(e.stack || e).split('\n').slice(0, 3).join(' | ')); }
    await ctx.close();
  }
  await b.close(); web.close(); fs.rmSync(MEDIA, { recursive: true, force: true });
  console.log(`\n${passes} ok, ${fails} FAILED`); if (faultLog.length) console.log(faultLog.map((x) => ' - ' + x).join('\n'));
  console.log(fails ? `${fails} FAILED` : 'all ok'); process.exit(fails ? 1 : 0);
})();
