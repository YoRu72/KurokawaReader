// node tests/diag.cjs: the app's own performance record (src/diag.ts) and its page (Settings → About → Performance,
// ui/perfsheet.ts), on an imitated phone (412×915, touch):
//  - the start-up marks are there (script, library shown, library usable);
//  - opening a book records its kind and how long it took (first content, place restored);
//  - leaving the reader by the top bar's back, by Android's back (a Capacitor backButton event, imitated — with a
//    touch at the screen's edge just before), after a tap on a link in the book, and by code: four different reasons;
//  - the app ended under an open book (storage kept, no unload — as tests/staysinbook.cjs imitates it) shows as an
//    unexpected end at the next start;
//  - the ring is capped (sessions, events, bytes);
//  - "Copy report" puts the report on the clipboard; neither the record nor the report holds the book's title or its
//    file's name;
//  - the page shows in English and in Arabic (screenshots to $KR_DIAG_SHOTS when set).
// The book is made here.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-diag-'));
const SHOTS = process.env.KR_DIAG_SHOTS ? path.resolve(process.env.KR_DIAG_SHOTS) : null;
const TITLE = 'Zebra Quartz Midnight'; const FILE = 'zebra-quartz-private-file.html';
const html = `<!doctype html><html><head><title>${TITLE}</title></head><body><h1>${TITLE}</h1>
<p id="intro">A note<a id="l-ref" href="#fn1">[1]</a> to follow.</p>
${Array.from({ length: 60 }, (_, i) => `<p>Paragraph ${i + 1}. ${'The river ran past the old city and the people read their books. '.repeat(4)}</p>`).join('\n')}
<p id="fn1">[1] The note.</p></body></html>`;
const file = path.join(TMP, FILE); fs.writeFileSync(file, html);
// (Capacitor imitated: the app's listeners kept, to be called as the system would.)
const CAP = () => { window.__cap = {}; window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { App: { addListener: (ev, fn) => { window.__cap[ev] = fn; return Promise.resolve({ remove() {} }); }, getLaunchUrl: async () => null, minimizeApp: async () => { window.__minimized = true; } } } }; };
const CLIP = () => { window.__clip = ''; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (s) => { window.__clip = s; }, readText: async () => window.__clip }, configurable: true }); };

(async () => {
  await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
  const br = await chromium.launch(); const errors = [];
  const ctx = await br.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block', locale: 'en' });
  await ctx.addInitScript(CLIP);
  const visible = (p, sel, timeout = 30000) => p.waitForFunction((sel) => [...document.querySelectorAll(sel)].some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && getComputedStyle(e).visibility !== 'hidden'; }), sel, { timeout, polling: 100 });
  const page = async (init) => { const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message)); if (init) await p.addInitScript(init.fn, init.arg); return p; };
  const data = (p) => p.evaluate(() => window.__krDiag.data());
  const lastEv = async (p, k) => { const d = await data(p); return d.events.filter((e) => e.k === k).pop(); };
  // (A page closed while the next starts would write its own copy of the record over the other's: one at a time.)
  const close = (p) => p.close({ runBeforeUnload: true });

  let p, d, s, e;
  // 0. The ring is capped (first, and cleared after: the record the later steps make is the sample report).
  p = await page({ fn: () => { if (sessionStorage.getItem('kr.test.ring')) return; sessionStorage.setItem('kr.test.ring', '1'); const s = []; for (let i = 0; i < 60; i++) s.push({ at: Date.now() - (60 - i) * 60000, env: { v: '0', plat: 'web', wv: 'x', scr: 'x', lang: 'en', mode: 'chapters', rm: false }, st: {}, scr: 'library', ran: 1000, hid: true, book: false, lt: [0, 0, 0, 0], laf: [0, 0, 0, 0], ltRead: 0, worst: [], ev: { slow: 0, maxDelay: 0, maxDur: 0 }, opens: 0, leaves: 0, oh: 0, end: 'left' }); const e = []; for (let i = 0; i < 1000; i++) e.push({ t: Date.now() - 1000 + i, k: 'test', n: i }); localStorage.setItem('kr.diag', JSON.stringify({ s, e })); } });
  await p.goto(base); await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await visible(p, '.library-view'); await p.waitForTimeout(800);
  let stored = await p.evaluate(() => { window.__krDiag.flush(); const v = localStorage.getItem('kr.diag'); const j = JSON.parse(v); return { bytes: v.length, s: j.s.length, e: j.e.length, cap: window.__krDiag.cap }; });
  ok('the ring keeps the last 20 sessions and 200 events', stored.s <= stored.cap.sessions && stored.e <= stored.cap.events && stored.s >= 2, stored);
  stored = await p.evaluate(() => { for (let i = 0; i < 400; i++) window.__krDiag.event('test', { pad: 'x'.repeat(400) }); window.__krDiag.flush(); const v = localStorage.getItem('kr.diag'); return { bytes: v.length, e: JSON.parse(v).e.length, cap: window.__krDiag.cap.bytes }; });
  ok('… and stays under its byte cap with large events', stored.bytes <= stored.cap && stored.e > 20, stored);
  await p.evaluate(() => window.__krDiag.clear());
  await close(p);

  // 1. The start, a book opened and left in four ways.
  p = await page();
  await p.goto(base);
  await visible(p, '.library-view .btn, .library-view .book-card'); await p.waitForTimeout(1200);
  d = await data(p); s = d.sessions[d.sessions.length - 1];
  ok('start-up marks: script, library shown, library usable (ms from the start, in order)', s.st.js > 0 && s.st.shown >= s.st.js && s.st.usable >= s.st.js && s.st.usable < 30000, s.st);
  ok('the environment: version, platform, browser version, screen, language', /^\d+\.\d+/.test(s.env.v) && s.env.plat === 'web' && /^Chrome \d+/.test(s.env.wv) && /^412x915@2$/.test(s.env.scr) && s.env.lang === 'en', s.env);
  await p.setInputFiles('.library-view input[type=file]', [file]);
  let id = null;
  for (let i = 0; i < 120 && !id; i++) { await p.waitForTimeout(250); id = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result[0]?.id ?? null); }; })); }
  ok('the book is imported', !!id);
  const openBook = async (pg) => { await pg.evaluate((id) => { location.hash = `#/read/${id}`; }, id); await visible(pg, '.reader-flow .kr-content p'); await pg.waitForTimeout(1500); };
  await openBook(p);
  e = await lastEv(p, 'open');
  ok('opening a book records its kind, rounded size and times', e && e.kind === 'text' && typeof e.first === 'number' && typeof e.placed === 'number' && e.placed >= e.first && /^\d/.test(e.paras ?? '') && /^\d/.test(e.bytes ?? ''), e);
  await p.click('.reader-view .topbar button[data-icon="back"]'); await visible(p, '.library-view'); await p.waitForTimeout(300);
  e = await lastEv(p, 'leave');
  ok('left by the top bar\'s back: "top-back"', e && e.why === 'top-back' && e.to === 'library', e);
  await openBook(p);
  await p.evaluate(() => { const a = document.querySelector('.reader-flow .kr-content a#l-ref') || [...document.querySelectorAll('.reader-flow .kr-content a')][0]; a.scrollIntoView({ block: 'center' }); });
  await p.waitForTimeout(300);
  const box = await p.evaluate(() => { const r = [...document.querySelectorAll('.reader-flow .kr-content a')][0].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  // (A link tapped and the reader left at once — as a link's fragment taken for the app's route did before 0.60.x.)
  await p.touchscreen.tap(box.x, box.y); await p.evaluate(() => { location.hash = '#/'; }); await visible(p, '.library-view'); await p.waitForTimeout(300);
  e = await lastEv(p, 'leave');
  ok('left just after a tap on a link in the book: "link"', e && e.why === 'link', e);
  await openBook(p);
  await p.evaluate(() => { location.hash = '#/settings'; }); await visible(p, '.settings-view'); await p.waitForTimeout(300);
  e = await lastEv(p, 'leave');
  ok('left by the app\'s own move (nothing said): "code"', e && e.why === 'code' && e.to === 'settings', e);
  await close(p);

  // 2. Android's back (the Capacitor event), a touch at the left edge just before.
  p = await page({ fn: CAP });
  await p.goto(base); await visible(p, '.library-view'); await p.waitForTimeout(600);
  ok('the app listens for Capacitor\'s backButton and appStateChange', await p.evaluate(() => typeof window.__cap.backButton === 'function' && typeof window.__cap.appStateChange === 'function'));
  await openBook(p);
  await p.evaluate(() => { const t = new Touch({ identifier: 7, target: document.body, clientX: 4, clientY: 450 }); document.body.dispatchEvent(new TouchEvent('touchstart', { touches: [t], changedTouches: [t], bubbles: true })); });
  await p.waitForTimeout(120);
  await p.evaluate(() => window.__cap.backButton({ canGoBack: true })); await visible(p, '.library-view'); await p.waitForTimeout(300);
  e = await lastEv(p, 'leave');
  ok('left by the back button / gesture: "back-button", the edge touch kept', e && e.why === 'back-button' && e.edge === 'left' && e.edgeAgo >= 0 && e.edgeAgo <= 600 && e.touching === true, e);
  const back = await lastEv(p, 'back');
  ok('… and the press itself recorded, on the reader', back && back.src === 'back-button' && back.scr === 'read', back);
  await p.evaluate(() => window.__cap.appStateChange({ isActive: false })); await p.waitForTimeout(100);
  d = await data(p);
  ok('appStateChange (background) recorded and the session marked hidden', d.events.some((x) => x.k === 'bg') && d.sessions[d.sessions.length - 1].hid === true);
  await p.evaluate(() => window.__cap.appStateChange({ isActive: true }));
  await close(p);
  // (A page closed in the ordinary way: its session ended "left".)

  // 3. Ended by the system under an open book: storage as it was at that moment, no unload.
  p = await page();
  await p.goto(base); await visible(p, '.library-view'); await openBook(p); await p.waitForTimeout(2500);
  const kept = await p.evaluate(() => ({ diag: localStorage.getItem('kr.diag'), reading: localStorage.getItem('kr.reading') }));
  const startedAt = JSON.parse(kept.diag).s.slice(-1)[0].at;
  await close(p);
  p = await page({ fn: (v) => { if (!sessionStorage.getItem('kr.test.started')) { sessionStorage.setItem('kr.test.started', '1'); localStorage.setItem('kr.diag', v.diag); if (v.reading) localStorage.setItem('kr.reading', v.reading); else localStorage.removeItem('kr.reading'); } }, arg: kept });
  await p.goto(base); await visible(p, '.library-view, .reader-view'); await p.waitForTimeout(1500);
  d = await data(p);
  const prev = d.sessions.find((x) => x.at === startedAt);
  ok('the session ended under an open book shows as an unexpected end at the next start', prev && prev.end === 'unexpected' && prev.book === true && prev.scr === 'read', prev && { end: prev.end, book: prev.book, scr: prev.scr });
  const ended = d.events.filter((x) => x.k === 'ended').pop();
  ok('… with an "ended" event (how, screen, book open)', ended && ended.how === 'unexpected' && ended.book === true, ended);
  const earlier = d.sessions.filter((x) => x.at < startedAt && x.end);
  ok('the sessions closed in the ordinary way show as left', earlier.length >= 2 && earlier.every((x) => x.end === 'left'), earlier.map((x) => x.end));
  await close(p);

  // 4. The page: Copy report, nothing of the book in it; English and Arabic.
  for (const lang of ['en', 'ar']) {
    p = await page();
    await p.goto(base); await p.evaluate((l) => localStorage.setItem('kr.lang', l), lang); await p.reload(); await visible(p, '.library-view');
    if (lang === 'en') { await openBook(p); await p.click('.reader-view .topbar button[data-icon="back"]'); await visible(p, '.library-view'); }
    await p.evaluate(() => { location.hash = '#/settings'; }); await visible(p, '.settings-view .card-title');
    await p.evaluate(() => { const b = document.querySelector('.perf-entry button'); b.closest('.card').classList.remove('collapsed'); b.scrollIntoView({ block: 'center' }); });
    await visible(p, '.perf-entry button'); await p.click('.perf-entry button');
    await visible(p, '.perf-sheet .perf-row'); await p.waitForTimeout(400);
    const text = await p.evaluate(() => document.querySelector('.perf-sheet').innerText);
    if (lang === 'en') ok('[en] the page: start-up, last book, slow moments, sessions, reasons', /Start-up/.test(text) && /Last book opened/.test(text) && /Slow moments/.test(text) && /Recent sessions/.test(text) && /Why the reader was left/.test(text) && /The back arrow at the top: \d/.test(text) && /nothing is sent anywhere/i.test(text), text.slice(0, 600));
    else ok('[ar] the page in Arabic, counts as «العدد: n», laid right to left', /الأداء/.test(text) && /العدد: /.test(text) && /لا يُرسَل/.test(text) && (await p.evaluate(() => document.documentElement.dir)) === 'rtl', text.slice(0, 400));
    const over = await p.evaluate(() => { const sh = document.querySelector('.perf-sheet'); return [...sh.querySelectorAll('*')].filter((x) => x.getBoundingClientRect().right > innerWidth + 1 || x.getBoundingClientRect().left < -1).map((x) => x.className || x.tagName).slice(0, 5); });
    ok(`[${lang}] nothing on the page runs off the screen`, over.length === 0, over);
    if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, `perf-${lang}.png`) }); await p.evaluate(() => document.querySelector('.perf-sheet .sheet-body').scrollTo(0, 1e6)); await p.waitForTimeout(200); await p.screenshot({ path: path.join(SHOTS, `perf-${lang}-end.png`) }); }
    const copy = p.locator('.perf-sheet .sheet-actions button').first();
    await copy.click(); await p.waitForTimeout(300);
    const clip = await p.evaluate(() => window.__clip);
    if (lang === 'en') {
      ok('Copy report puts the report on the clipboard (plain text, English)', /^KurokawaReader performance report\n/.test(clip) && /Sessions \(newest first\)/.test(clip) && /top-back -> library/.test(clip) && /Recorder's own time: [\d.]+ ms/.test(clip), clip.slice(0, 300));
      const all = clip + (await p.evaluate(() => localStorage.getItem('kr.diag')));
      ok('neither the report nor the record holds the book\'s title or file name', !/zebra|quartz|midnight/i.test(all) && !all.includes(id), (all.match(/.{0,40}(zebra|quartz|midnight).{0,40}/i) || [])[0]);
      console.log('---- sample report ----\n' + clip + '---- end ----');
    } else ok('[ar] the copied report is the English one', /^KurokawaReader performance report/.test(clip));
    // Clear: the record let go but this session.
    await p.locator('.perf-sheet .sheet-actions button').nth(2).click(); await p.waitForTimeout(200);
    d = await data(p);
    ok(`[${lang}] Clear leaves only the session running, no events`, d.sessions.length === 1 && d.events.length === 0, { s: d.sessions.length, e: d.events.length });
    await close(p);
  }

  ok('no page errors', errors.length === 0, errors);
  console.log(fails ? `${fails} failed` : 'all passed');
  await br.close(); server.close(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
