// node tests/streamenter.cjs [en|ar] : choosing something to stream opens the player's own screen at once, from where the
// user is (never the Downloads on the way); Back there stops everything and leaves the page exactly as it was; leaving a
// streamed episode asks «Keep this episode?» (Keep / Delete from cache, equal buttons, «Remember my choice», shown in
// Settings → Streaming); the download's progress is one slim line at the top of the player (with the controls, gone with
// them). Everything is on 127.0.0.1 with made-up data: a made-up show (AniList's answer through the page's own stub), a
// release picked before (so nothing is searched), and a stand-in engine in the place of the phone's: its own store of
// downloads, its stream address, a clip served here. Phone 360x800 and 412x915, computer 1280x800.
// Env: ENTER_SIZES=360,412,1280  ENTER_SHOTS=<dir>
const { chromium, devices } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const { execFileSync } = require('node:child_process');
const LANG = process.argv[2] === 'ar' ? 'ar' : 'en';
const DIST = path.join(__dirname, '..', 'dist');
const MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-enter-')); const SHOTS = process.env.ENTER_SHOTS || MEDIA;
const CLIP = path.join(MEDIA, 'clip.webm');
try { execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '30', '-c:v', 'libvpx', '-b:v', '200k', '-g', '25', '-c:a', 'libopus', CLIP]); }
catch { if (process.env.KT_REQUIRE_FFMPEG) { console.log('FAIL ffmpeg is required here (KT_REQUIRE_FFMPEG)'); process.exit(1); } console.log('ffmpeg not available - skipped'); process.exit(0); }
const DATA = fs.readFileSync(CLIP); const SIZE = DATA.length;
let fails = 0, passes = 0; const ok = (n, c, x) => { if (c) passes++; else fails++; console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 500))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log('FAIL timed out'); process.exit(1); }, 900000).unref();
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const ID = 4242;
// ---- the clip served as a download still coming is: ranges, a slow rate, every connection counted
const SRV = { reqs: 0, live: new Set() };
const web = http.createServer((q, r) => {
  if (q.url.startsWith('/media/')) {
    SRV.reqs++; r.on('close', () => SRV.live.delete(r)); SRV.live.add(r);
    const m = /bytes=(\d*)-(\d*)/.exec(q.headers.range || ''); const a = m && m[1] ? Number(m[1]) : 0; const b = m && m[2] ? Math.min(SIZE - 1, Number(m[2])) : SIZE - 1;
    r.writeHead(m ? 206 : 200, { 'content-type': 'video/webm', 'accept-ranges': 'bytes', 'content-length': b - a + 1, ...(m ? { 'content-range': `bytes ${a}-${b}/${SIZE}` } : {}) });
    let pos = a; const tick = () => { if (r.destroyed || pos > b) { if (!r.destroyed) r.end(); return; } const n = Math.min(32768, b - pos + 1); r.write(DATA.subarray(pos, pos + n)); pos += n; setTimeout(tick, 20); }; tick(); return;
  }
  let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r);
});
const MEDIA_AL = () => ({ id: ID, idMal: 4343, title: { romaji: 'Hoshizora Kissa', english: 'Starlit Cafe', native: '星空喫茶', userPreferred: 'Starlit Cafe' }, synonyms: [], coverImage: { large: '', extraLarge: '', color: '#5c6bc0' }, format: 'TV', status: 'FINISHED', episodes: 12, season: 'FALL', seasonYear: 2026, startDate: { year: 2026, month: 10, day: 1 }, genres: ['Slice of Life'], averageScore: 70, popularity: 10, isAdult: false, siteUrl: `https://anilist.co/anime/${ID}`, nextAiringEpisode: null, duration: 24, description: 'Made up.', studios: { nodes: [] }, airingSchedule: { nodes: [] }, streamingEpisodes: [], externalLinks: [], relations: { edges: [] }, mediaListEntry: null });

// ---- what the page gets before anything of the app runs: the phone's plugin with an engine of its own (a store of
// downloads, ten files of a batch, a stream address), counted timers, every route change recorded
const FIXTURE = (lang, port, size, pc) => {
  const E = window.__eng = { tasks: [], bytes: {}, removed: [], adds: 0, metaMs: 1200, failAdd: false, failStream: false, timers: new Set(), subs: [] };
  window.__routes = [location.hash]; window.addEventListener('hashchange', () => window.__routes.push(location.hash));
  const emit = () => { for (const cb of E.subs) cb({ tasks: E.tasks }); };
  const api = {
    addListener: (ev, cb) => { if (ev === 'tasksChanged') E.subs.push(cb); return Promise.resolve({ remove() { E.subs = E.subs.filter((x) => x !== cb); } }); },
    list: async () => ({ tasks: E.tasks }), defaultDir: async () => ({ dir: '/sdcard/Download' }),
    add: async (o) => {
      if (E.failAdd) throw new Error('The engine refused it');
      E.adds++; const id = `t${E.adds}`; const t = { id, kind: 'torrent', name: 'Starlit batch', source: o.source, dir: '/sdcard/Download', state: 'metadata', done: 0, total: 0, downSpeed: 0, upSpeed: 0, peers: 3, files: [], meta: o.meta, addedAt: Date.now() };
      E.tasks = [...E.tasks, t]; emit();
      const tm = setTimeout(() => {
        E.timers.delete(tm); if (!E.tasks.some((x) => x.id === id)) return;
        const files = [1, 2, 3].map((n, i) => ({ index: i, path: `Starlit batch/Starlit 0${n}.webm`, size, done: 0, priority: 2 }));
        const x = E.tasks.find((y) => y.id === id); x.files = files; x.state = 'downloading'; x.total = size * 3; emit();
        const iv = setInterval(() => { const y = E.tasks.find((z) => z.id === id); if (!y) { clearInterval(iv); E.timers.delete(iv); return; } y.done = Math.min(y.total, y.done + Math.floor(size / 12)); y.downSpeed = 1.5e6; E.bytes[id] = y.done; if (y.done >= y.total) { y.state = 'done'; y.downSpeed = 0; clearInterval(iv); E.timers.delete(iv); } emit(); }, 250);
        E.timers.add(iv);
      }, E.metaMs); E.timers.add(tm);
      return { task: t };
    },
    remove: async (o) => { E.removed.push({ id: o.id, deleteFiles: !!o.deleteFiles }); E.tasks = E.tasks.filter((x) => x.id !== o.id); if (o.deleteFiles) delete E.bytes[o.id]; emit(); return {}; },
    streamUrl: async (o) => { if (E.failStream) throw new Error('No stream address'); return { url: `http://127.0.0.1:${port}/media/clip.webm?task=${o.id}&f=${o.fileIndex}` }; },
    setFiles: async () => ({}), resume: async () => ({}), siblings: async () => ({ paths: [] }), orientation: async () => ({}), pip: async () => ({ ok: true }), pipAuto: async () => ({}),
    httpRequest: async (o) => window.__http(o),
  };
  window.__seed = (n) => { const o = n || {}; const dn = o.done ?? Math.floor(size / 3); const t = { id: 'seed', kind: 'torrent', name: 'Seeded show 01', source: { magnet: 'magnet:?xt=urn:btih:' + '1'.repeat(40) }, dir: '/sdcard/Download', state: o.state || 'downloading', done: dn, total: size, downSpeed: o.state ? 0 : 1e6, upSpeed: 0, peers: 5, files: [{ index: 0, path: 'Seeded show 01/clip.webm', size, done: dn, priority: 2 }], addedAt: Date.now() - 1e4, meta: {} }; E.tasks = [...E.tasks, t]; E.bytes.seed = t.done; };
  const plugin = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
  try {
    localStorage.setItem('kr.lang', lang);
    if (!sessionStorage.getItem('enter-init')) {
      sessionStorage.setItem('enter-init', '1');
      localStorage.setItem('kt.settings', JSON.stringify({ addons: ['player', 'anime'], playerWith: 'app', playerEngine: 'web', subLangs: ['en'] }));
      localStorage.setItem('kt.player', JSON.stringify({ controlsTimeout: 2, autoSubs: false, resume: 'never', autoplayNext: false }));
      localStorage.setItem('kt.player.hint', '1'); localStorage.setItem('kt.update.lastCheck', String(Date.now()));
      localStorage.setItem('kt.anilist.token', 'MADE-UP'); localStorage.setItem('kt.anilist.user', JSON.stringify({ id: 1, name: 'Test Viewer', scoreFormat: 'POINT_10' }));
      // (The release picked before for this show: a batch, so «Watch now» searches nothing.)
      localStorage.setItem('kt.watchPick', JSON.stringify({ 4242: { title: '[Group] Starlit Cafe (01-12) [1080p]', hash: 'a'.repeat(40), link: 'magnet:?xt=urn:btih:' + 'a'.repeat(40), provider: 'made-up', batch: true, at: Date.now() } }));
    }
  } catch { /* blank */ }
  const live = new Set(); const si = window.setInterval, ci = window.clearInterval;
  window.setInterval = (...a) => { const id = si(...a); live.add(id); return id; }; window.clearInterval = (id) => { live.delete(id); return ci(id); }; window.__liveIntervals = () => live.size;
  // (When the start screen first shows, and when the click that asked for it came.)
  window.__t = { click: 0, start: 0 };
  document.addEventListener('click', () => { window.__t.click = performance.now(); window.__t.start = 0; }, true);
  new MutationObserver(() => { if (!window.__t.start && document.querySelector('.kt-start')) window.__t.start = performance.now(); }).observe(document, { childList: true, subtree: true });
  if (pc) document.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add('pc'));
};

const COMBOS = (process.env.ENTER_SIZES || '360,412,1280').split(',').map(Number);
(async () => {
  await new Promise((r) => web.listen(0, '127.0.0.1', r)); const port = web.address().port; const base = `http://127.0.0.1:${port}/`;
  const br = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  for (const W of COMBOS) {
    const pc = W >= 1000; const H = pc ? 800 : W === 412 ? 915 : 800; const tag = `${W}x${H} ${LANG}`;
    const ctx = await br.newContext(pc ? { viewport: { width: W, height: H } } : { ...devices['Pixel 7'], viewport: { width: W, height: H }, screen: { width: W, height: H }, deviceScaleFactor: 1 });
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 404, body: '' }));
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.exposeFunction('__http', (o) => {
      if (/graphql\.anilist\.co/.test(o.url)) { const q = JSON.parse(o.body || '{}').query || ''; if (/Media\(id/.test(q)) return { status: 200, headers: {}, body: JSON.stringify({ data: { Media: MEDIA_AL() } }) }; return { status: 200, headers: {}, body: JSON.stringify({ data: { Page: { pageInfo: { hasNextPage: false }, media: [MEDIA_AL()] }, MediaListCollection: { lists: [] } } }) }; }
      return { status: 404, headers: {}, body: '' };
    });
    await p.addInitScript(`(${FIXTURE.toString()})(${JSON.stringify(LANG)}, ${port}, ${SIZE}, ${pc})`);
    const T = (n, c, x) => ok(`[${tag}] ${n}`, c, x);
    const until = (fn, arg, ms = 10000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);
    const hashNow = () => p.evaluate(() => location.hash);
    const scroller = '.view:not([hidden]) > .body';
    const shot = async (n) => { try { await p.screenshot({ path: path.join(SHOTS, n) }); } catch { /* gone */ } };
    const open = async (fresh) => { if (fresh) { await p.goto('about:blank'); } await p.goto(`${base}#/anime/${ID}`); await p.waitForSelector('.ep-row[data-ep="2"]', { timeout: 15000 }); await p.waitForTimeout(300); };
    const resetEngine = () => p.evaluate(() => { const E = window.__eng; for (const x of E.timers) { clearTimeout(x); clearInterval(x); } E.timers.clear(); E.tasks = []; E.bytes = {}; E.removed = []; E.adds = 0; E.metaMs = 1200; E.failAdd = false; E.failStream = false; try { localStorage.removeItem('kt.stream.made'); } catch { /* none */ } });
    const watchNow = async () => { await p.click('.ep-row[data-ep="2"] .ep-title'); await p.waitForSelector('.ep-sheet .dest-row.primary'); await p.click('.ep-sheet .dest-row.primary'); };
    const leaveBtn = '.kt-top button[data-icon="back"]';
    const scrolled = async () => { await p.evaluate((sel) => { document.querySelector('.ep-row[data-ep="12"]')?.scrollIntoView({ block: 'end' }); void sel; }, scroller); await p.waitForTimeout(150); return p.$eval(scroller, (e) => e.scrollTop).catch(() => -1); };
    const sheetState = () => p.evaluate(() => { const sh = [...document.querySelectorAll('.sheet')]; const vis = (e) => e.getBoundingClientRect().width > 0; return sh.filter(vis).map((s) => ({ cls: s.className, title: (s.querySelector('.sheet-head, h2, h3') || {}).textContent || '', buttons: [...s.querySelectorAll('.btn')].filter(vis).map((b) => { const r = b.getBoundingClientRect(); return { t: b.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height) }; }) })); });
    try {
      // ===== 1. from the show's episode list: Watch now =====
      await open(true); await resetEngine();
      const top00 = await scrolled(); T(`the list is scrolled (${top00})`, top00 > 100, top00);
      const routes0 = await p.evaluate(() => window.__routes.length);
      await watchNow();
      T('the start screen is there at once (the click to the screen)', await until(() => !!document.querySelector('.kt-start'), null, 4000));
      const top0 = await p.$eval(scroller, (e) => e.scrollTop);   // (the tap itself may have scrolled the row into view)
      const lat = await p.evaluate(() => window.__t.start - window.__t.click); T(`…within ${Math.round(lat)} ms of the tap (under 700)`, lat > 0 && lat < 700, lat);
      const st = await p.evaluate(() => ({ line: document.querySelector('.kt-start .kt-wait')?.textContent ?? '', title: document.querySelector('.kt-start .kt-title')?.textContent ?? '', back: !!document.querySelector('.kt-start .kt-top button[data-icon="back"]'), cancel: [...document.querySelectorAll('.kt-start-actions .btn')].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }), hash: location.hash }));
      T(`the start screen says what it does («${st.line}») and has Back and Cancel at least 40 px high`, st.line.length > 3 && st.back && st.cancel.length === 1 && st.cancel[0][1] >= 40, st);
      T('…the title is the show\'s', /Starlit|Cafe/.test(st.title) || LANG === 'ar', st.title);
      await shot(`ST2-starting-${LANG}${pc ? '-pc' : ''}-${W}.png`);
      T('the page under it is where it was (same hash, never the Downloads)', st.hash === `#/anime/${ID}` && (await p.evaluate(() => window.__routes.length)) === routes0, await p.evaluate(() => window.__routes));
      // the real player takes the screen; the progress line at the top
      T('the player opens on the stream', await until(() => !!document.querySelector('.kt-player:not(.kt-start) video.kt-video') && !document.querySelector('.kt-start'), null, 15000));
      T('the video plays', await until(() => { const v = document.querySelector('.kt-video'); return v && !v.paused && v.currentTime > 0.5; }, null, 20000));
      const dl = async () => p.evaluate(() => { const e = document.querySelector('.kt-dl'); const top = document.querySelector('.kt-top'); const title = document.querySelector('.kt-top .kt-title'); if (!e) return null; const r = e.getBoundingClientRect(); const tr = title.getBoundingClientRect(); const cs = getComputedStyle(e); return { text: e.textContent, hidden: e.hidden || r.width === 0, vis: cs.visibility, topOp: getComputedStyle(top).opacity, under: r.top >= tr.bottom - 2, overflow: e.scrollWidth > e.clientWidth + 1, lines: Math.round(r.height / 17), h: Math.round(r.height), within: r.right <= innerWidth + 1 && r.left >= -1 }; });
      let d = await dl(); T(`the progress line is shown with the controls («${d && d.text}»)`, !!d && !d.hidden && d.vis === 'visible' && d.topOp === '1', d);
      T('…it has numbers, none NaN, none over 100 %', !!d && !/NaN|undefined|Infinity/.test(d.text) && ![...d.text.matchAll(/(\d+)\s*%/g)].some((m) => Number(m[1]) > 100) && /\d/.test(d.text), d && d.text);
      T('…under the title row, one line of text, inside the screen', !!d && d.under && !d.overflow && d.within && d.h <= 40, d);
      await shot(`ST2-progress-${LANG}${pc ? '-pc' : ''}-${W}.png`);
      // hidden with the controls
      T('the controls hide by themselves', await until(() => document.querySelector('.kt-player')?.classList.contains('hide-ui'), null, 9000));
      d = await dl(); T('…and the progress line goes with them', !!d && (d.vis === 'hidden' || d.topOp === '0'), d);
      await p.mouse.move(W / 2, H / 2).catch(() => undefined);
      await p.waitForTimeout(300);
      // leave: back to the same page, scrolled the same, and the question
      await p.evaluate(() => document.querySelector('.kt-player')?.classList.remove('hide-ui'));
      await p.click(leaveBtn);
      T('leaving: the player is gone', await until(() => !document.querySelector('.kt-player'), null, 6000));
      T('…the same page (hash)', (await hashNow()) === `#/anime/${ID}`, await p.evaluate(() => window.__routes));
      T('…never the Downloads on the way', !(await p.evaluate(() => window.__routes.includes('#/'))), await p.evaluate(() => window.__routes));
      const top1 = await p.$eval(scroller, (e) => e.scrollTop); T(`…scrolled where it was (${top0} → ${top1})`, Math.abs(top1 - top0) <= 2, [top0, top1]);
      T('«Keep this episode?» is asked', await until(() => !!document.querySelector('.kt-keep'), null, 6000));
      const q = await sheetState(); const ks = q.find((s) => /kt-keep/.test(s.cls));
      T('…two buttons of equal width, each at least 40 px high', !!ks && ks.buttons.length === 2 && Math.abs(ks.buttons[0].w - ks.buttons[1].w) <= 1 && ks.buttons.every((b) => b.h >= 40), ks);
      T('…«Remember my choice» is a switch (not a bare checkbox)', await p.evaluate(() => { const i = document.querySelector('.kt-keep .switch-row input[type=checkbox]'); return !!i && getComputedStyle(i).appearance === 'none' && i.getBoundingClientRect().width >= 40; }));
      T('…the words are the UI language\'s', await p.evaluate((l) => { const s = document.querySelector('.kt-keep').textContent; return l === 'ar' ? /[؀-ۿ]/.test(s) && !/Keep|Delete/.test(s) : /Keep this episode\?/.test(s) && /Delete from cache/.test(s); }, LANG), q);
      await p.waitForTimeout(800); await shot(`ST2-keep-${LANG}${pc ? '-pc' : ''}-${W}.png`);
      // Delete: the card and the bytes go
      const del = await p.$$('.kt-keep .kt-keep-actions .btn'); await del[1].click();
      T('Delete removes the download and its bytes (the stand-in\'s store is empty)', await until(() => window.__eng.tasks.length === 0 && Object.keys(window.__eng.bytes).length === 0 && window.__eng.removed.length === 1 && window.__eng.removed[0].deleteFiles === true, null, 6000), await p.evaluate(() => ({ t: window.__eng.tasks.length, b: window.__eng.bytes, r: window.__eng.removed })));
      T('…and a notice says so', await until(() => /Deleted from cache|حُذف من الذاكرة المؤقتة/.test(document.querySelector('.toast')?.textContent ?? ''), null, 4000));
      // ===== 2. Keep =====
      await p.evaluate(() => document.querySelectorAll('.sheet, .scrim, .sheet-scrim, .toast').forEach((e) => e.remove())); await resetEngine(); await open(false);
      await watchNow(); await until(() => !!document.querySelector('.kt-player:not(.kt-start) video'), null, 15000); await until(() => window.__eng.tasks[0] && window.__eng.tasks[0].done > 0, null, 8000);
      await p.click(leaveBtn); await p.waitForSelector('.kt-keep', { timeout: 8000 });
      const keep = await p.$$('.kt-keep .kt-keep-actions .btn'); await keep[0].click(); await p.waitForTimeout(600);
      T('Keep leaves the download (partial or finished) in the store', await p.evaluate(() => window.__eng.tasks.length === 1 && window.__eng.removed.length === 0), await p.evaluate(() => window.__eng.removed));
      T('…the question is gone', !(await p.$('.kt-keep')));
      // a kept download is a normal one: streamed again, not asked about
      await p.evaluate(() => document.querySelectorAll('.sheet, .scrim, .sheet-scrim, .toast').forEach((e) => e.remove()));
      await p.evaluate(() => { const x = window.__eng.tasks[0]; if (x) { x.meta = x.meta || {}; } });
      // ===== 3. Remember my choice =====
      await resetEngine(); await open(false); await watchNow(); await until(() => !!document.querySelector('.kt-player:not(.kt-start) video'), null, 15000); await until(() => window.__eng.tasks[0] && window.__eng.tasks[0].done > 0, null, 8000);
      await p.click(leaveBtn); await p.waitForSelector('.kt-keep', { timeout: 8000 });
      await p.click('.kt-keep .switch-row input[type=checkbox]'); const rem = await p.$$('.kt-keep .kt-keep-actions .btn'); await rem[1].click();
      T('Delete with «Remember» removes it', await until(() => window.__eng.tasks.length === 0, null, 6000));
      T('…the choice is kept', (await p.evaluate(() => JSON.parse(localStorage.getItem('kt.settings')).streamKeep)) === 'delete');
      await p.evaluate(() => document.querySelectorAll('.sheet, .scrim, .sheet-scrim, .toast').forEach((e) => e.remove())); await resetEngine(); await open(false);
      await watchNow(); await until(() => !!document.querySelector('.kt-player:not(.kt-start) video'), null, 15000); await until(() => window.__eng.tasks[0] && window.__eng.tasks[0].done > 0, null, 8000);
      await p.click(leaveBtn); await p.waitForTimeout(1500);
      T('next time: no question, the episode is deleted from the cache by itself', !(await p.$('.kt-keep')) && (await p.evaluate(() => window.__eng.tasks.length === 0)), await p.evaluate(() => ({ t: window.__eng.tasks.length })));
      await p.goto('about:blank'); await p.goto(`${base}#/settings/streaming`); await p.waitForSelector("#streaming", { timeout: 10000 });
      const sett = await p.$eval('#streaming', (e) => ({ text: e.textContent, btn: [...e.querySelectorAll('button')].map((b) => b.textContent.trim()) }));
      T(`Settings → Streaming shows the remembered choice (${sett.btn.join(' / ')})`, LANG === 'ar' ? /الحذف من الذاكرة المؤقتة/.test(sett.text) : /Delete from cache/.test(sett.text), sett);
      await shot(`ST2-settings-${LANG}${pc ? '-pc' : ''}-${W}.png`);
      await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('kt.settings')); delete s.streamKeep; localStorage.setItem('kt.settings', JSON.stringify(s)); });
      // ===== 4. Back during the start: everything stops, the page is as it was =====
      await open(true); await resetEngine(); await p.evaluate(() => { window.__eng.metaMs = 5000; });
      await scrolled(); await p.evaluate(() => { window.__eng.metaMs = 5000; }); const base0 = await p.evaluate(() => ({ iv: window.__liveIntervals(), routes: window.__routes.length }));
      await watchNow(); await p.waitForSelector('.kt-start', { timeout: 4000 }); const top2 = await p.$eval(scroller, (e) => e.scrollTop); await until(() => window.__eng.adds === 1, null, 6000);
      const reqs0 = SRV.reqs;
      await p.click('.kt-start-actions .btn');
      T('Cancel during the start: the screen is gone, no player', await until(() => !document.querySelector('.kt-start') && !document.querySelector('.kt-player'), null, 4000));
      T('…the same page, never the Downloads', (await hashNow()) === `#/anime/${ID}` && !(await p.evaluate(() => window.__routes.includes('#/'))), await p.evaluate(() => window.__routes));
      const top3 = await p.$eval(scroller, (e) => e.scrollTop); T(`…the same scroll position (${top2} → ${top3})`, Math.abs(top2 - top3) <= 2, [top2, top3]);
      T('…the episode\'s sheet put back as it was', await until(() => !!document.querySelector('.ep-sheet'), null, 3000));
      T('…the empty download the start made is gone (store empty, nothing left running)', await until(() => window.__eng.tasks.length === 0 && window.__eng.timers.size === 0 && Object.keys(window.__eng.bytes).length === 0, null, 5000), await p.evaluate(() => ({ t: window.__eng.tasks.length, tm: window.__eng.timers.size })));
      await p.waitForTimeout(1200);
      const left = await p.evaluate(() => ({ iv: window.__liveIntervals(), start: !!document.querySelector('.kt-start, .kt-player'), adds: window.__eng.adds }));
      T(`…no timer left (${left.iv} against ${base0.iv}), no new download, no request to the source (${SRV.reqs - reqs0})`, left.iv <= base0.iv && !left.start && left.adds === 1 && SRV.reqs === reqs0 && SRV.live.size === 0, [left, SRV.reqs - reqs0]);
      T('…no question about it (it never got data)', !(await p.$('.kt-keep')));
      // the Escape key and the system's back do the same
      await p.evaluate(() => document.querySelectorAll('.sheet, .scrim, .sheet-scrim').forEach((e) => e.remove())); await resetEngine(); await p.evaluate(() => { window.__eng.metaMs = 5000; });
      await watchNow(); await p.waitForSelector('.kt-start', { timeout: 4000 });
      await p.keyboard.press('Escape'); T('Escape during the start leaves it', await until(() => !document.querySelector('.kt-start'), null, 3000));
      await p.evaluate(() => document.querySelectorAll('.sheet, .scrim, .sheet-scrim').forEach((e) => e.remove())); await resetEngine(); await p.evaluate(() => { window.__eng.metaMs = 5000; });
      await watchNow(); await p.waitForSelector('.kt-start', { timeout: 4000 });
      await p.goBack().catch(() => undefined); T('the system\'s Back during the start leaves it', await until(() => !document.querySelector('.kt-start'), null, 3000));
      T('…and stops what it started', await until(() => window.__eng.tasks.length === 0, null, 5000));
      // ===== 5. a start that fails: the sheet with Try again / Back / Another stream =====
      await open(true); await resetEngine(); await p.evaluate(() => { window.__eng.failAdd = true; });
      await watchNow(); T('a failed start shows the sheet over the start screen', await until(() => !!document.querySelector('.kt-start') && !!document.querySelector('.kt-problem'), null, 8000));
      const fs0 = await sheetState(); const fsh = fs0.find((s) => s.buttons.length >= 2);
      T('…three actions of equal width: Try again, Back, Another stream', !!fsh && fsh.buttons.length === 3 && fsh.buttons.every((b) => Math.abs(b.w - fsh.buttons[0].w) <= 1 && b.h >= 40), fs0);
      const btns = await p.$$('.kt-problem .ext-error-actions .btn'); await btns[2].click();
      T('«Another stream» reopens the chooser and leaves the start screen', await until(() => !document.querySelector('.kt-start') && !!document.querySelector('.sheet'), null, 6000));
      T('…the same page, never the Downloads', (await hashNow()) === `#/anime/${ID}` && !(await p.evaluate(() => window.__routes.includes('#/'))));
      // ===== 6. a download still coming, from its page (a link added earlier): Stream =====
      await p.evaluate(() => document.querySelectorAll('.sheet, .scrim, .sheet-scrim').forEach((e) => e.remove())); await resetEngine();
      await p.goto('about:blank'); await p.goto(`${base}#/`); await p.waitForSelector('.downloads-view', { timeout: 10000 }); await p.evaluate(() => window.__seed()); await p.evaluate(() => { location.hash = '#/task/seed'; }); await p.waitForSelector('.task-detail-actions', { timeout: 10000 });
      const r6 = await p.evaluate(() => window.__routes.length);
      await p.click('.task-detail-actions .btn:has(polygon)');
      T('a card\'s Stream button: the start screen at once', await until(() => !!document.querySelector('.kt-start') || !!document.querySelector('.kt-player'), null, 3000));
      T('…the player plays it', await until(() => { const v = document.querySelector('.kt-video'); return v && !v.paused && v.currentTime > 0.5; }, null, 20000));
      const dd = await dl(); T(`…the progress line shows it («${dd && dd.text}»)`, !!dd && !dd.hidden && !/NaN/.test(dd.text), dd);
      await p.click(leaveBtn); await p.waitForTimeout(1200);
      T('…leaving: the same page (the download\'s), no question (a download that was not made for the stream)', (await hashNow()) === '#/task/seed' && !(await p.$('.kt-keep')) && (await p.evaluate(() => window.__routes.length)) === r6, await p.evaluate(() => window.__routes));
      T('…and the download is still there', await p.evaluate(() => window.__eng.tasks.some((x) => x.id === 'seed') && window.__eng.removed.length === 0));
      // the stream address fails: the sheet on the start screen, Back leaves
      await p.evaluate(() => { window.__eng.failStream = true; }); await p.click('.task-detail-actions .btn:has(polygon)');
      T('a stream that cannot start: the sheet (Try again / Back), no «Another stream» without a chooser', await until(() => !!document.querySelector('.kt-problem'), null, 6000) && (await p.$$('.kt-problem .ext-error-actions .btn')).length === 2);
      await (await p.$$('.kt-problem .ext-error-actions .btn'))[1].click();
      T('…Back leaves, the page as it was', (await until(() => !document.querySelector('.kt-start') && !document.querySelector('.kt-problem'), null, 4000)) && (await hashNow()) === '#/task/seed');
      // ===== 7. a download that was there before is never the stream's: cancelled, failed or left, it stays with its data =====
      for (const [label, o, stale] of [['a queued download with no bytes', { state: 'queued', done: 0 }, false], ['a paused, partly downloaded one', { state: 'paused', done: 400000 }, false], ['one an old stream list still names (no marker on it)', { state: 'downloading', done: 0 }, true]]) {
        await p.evaluate(() => document.querySelectorAll('.sheet, .scrim, .sheet-scrim').forEach((e) => e.remove())); await resetEngine();
        await p.goto('about:blank'); await p.goto(`${base}#/`); await p.waitForSelector('.downloads-view', { timeout: 10000 });
        await p.evaluate(([oo, st]) => { window.__seed(oo); if (st) localStorage.setItem('kt.stream.made', JSON.stringify(['seed'])); window.__eng.metaMs = 5000; location.hash = '#/task/seed'; }, [o, stale]); await p.waitForSelector('.task-detail-actions', { timeout: 10000 });
        const kept = await p.evaluate(() => ({ done: window.__eng.tasks[0].done }));
        await p.getByRole('button', { name: /Play while downloading|تشغيل في أثناء التنزيل/ }).first().click(); await p.waitForSelector('.kt-start, .kt-player', { timeout: 4000 }); await p.waitForTimeout(400);
        await p.click('.kt-start .kt-start-actions .btn, .kt-player .kt-top button'); await p.waitForTimeout(1000);
        T(`[7] ${label}: streamed, then cancelled: the card is still there, nothing removed, its data kept`, await p.evaluate((d) => window.__eng.tasks.some((x) => x.id === 'seed') && window.__eng.removed.length === 0 && 'seed' in window.__eng.bytes && window.__eng.tasks[0].done === d, kept.done) && !(await p.$('.kt-keep')), await p.evaluate(() => ({ r: window.__eng.removed, t: window.__eng.tasks.length })));
      }
      // a stream-made download carries its marker from the moment it was made, and a restart before its first data leaves it to be asked about, not removed
      await p.evaluate(() => document.querySelectorAll('.sheet, .scrim, .sheet-scrim').forEach((e) => e.remove())); await resetEngine();
      await open(true); await p.evaluate(() => { window.__eng.metaMs = 5000; }); await watchNow(); await until(() => window.__eng.adds === 1, null, 6000);
      T('[7] a download the stream made: marked on the task itself at creation, and in the list of ids', await p.evaluate(() => window.__eng.tasks[0].meta && window.__eng.tasks[0].meta.streamMade === true && JSON.parse(localStorage.getItem('kt.stream.made') || '[]').includes('t1')));
      T('[7] …a restart before its first data: the marker survives (the id list is kept; the app removes nothing on starting)', await (async () => { await p.goto('about:blank'); await p.goto(`${base}#/`); await p.waitForSelector('.downloads-view', { timeout: 10000 }); await p.waitForTimeout(800); return p.evaluate(() => JSON.parse(localStorage.getItem('kt.stream.made') || '[]').includes('t1')); })());
      T('no page error', errs.length === 0, errs);
    } catch (e) { ok(`[${tag}] the walk ended by itself: ${String(e.message || e).split('\n')[0]}`, false); await shot(`ST2-fail-${W}.png`); }
    await ctx.close();
  }
  await br.close(); web.close(); web.closeAllConnections?.();
  console.log(`${passes} passed, ${fails} failed`); console.log(fails ? 'FAIL streamenter' : 'ok   streamenter'); process.exit(fails ? 1 : 0);
})();
