// node tests/readgestures.cjs: reading gestures that live in peace with the phone's own (src/views/reader.ts SWIPE and
// its touch handlers, src/readkeys.ts inSystemZone and the Back gate, src/native.ts getGestureInsets), on an imitated
// Android phone (Capacitor imitated as tests/backkeys.cjs does; the Kurokawa plugin tells the system's gesture insets
// the test sets, and its "gestureInsets" event is fired by the test), touches made in the page with exact positions and
// timings, in a book written left to right and one written right to left, chapter by chapter and in the "flow" mode:
//  1. The system's Back zone (24 px each side here): a swipe that begins in it turns nothing; a Back during such a
//     touch goes on at once (it does not wait for the touch); a swipe begun just outside it turns, and a Back 120 ms
//     after that turn is ignored (the 350 ms gate). Two or three buttons (no zone, told by the event): the whole width
//     is the reader's. The edge guard on: inside its band (the middle of the edge) the reader's, above it the phone's.
//  2. Recognition: direction decided once (a scroll that bends sideways never turns); a quick short flick turns, a slow
//     short drag does not, a slow long one does; a swipe that comes back at the end turns nothing; a second finger,
//     a selection, an open panel, a cancelled touch turn nothing; a swipe on code that can still scroll sideways
//     scrolls it, and turns once the code is at its end; "Turn pages by swiping" off; "Swipe sensitivity" high and low.
//  3. Taps in the zone still work: the lower third turns the screen, the middle shows or hides the bars.
//  4. The empty band above a chapter's title: chapter by chapter, a chapter opened at its top has no rule and no margin
//     above its title (continuous reading keeps both), and a place saved in the chapter stays on its paragraph.
//  5. The Performance report: the zone and navigation at book open, the touches left to the system.
//  6. The settings: both rows on the phone, in English and Arabic.
// KR_GEST_SHOTS=<dir>: pictures of a chapter's top, 412×915 at 2×, before (the old rule put back) and after.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 500))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-readgestures-'));
const SHOTS = process.env.KR_GEST_SHOTS ? path.resolve(process.env.KR_GEST_SHOTS) : null;

async function makeEpub(file, id, title, lang, chapters) {
  const JSZip = require('jszip'); const z = new JSZip();
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  z.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  z.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  chapters.forEach(([t, body], i) => z.file(`OEBPS/c${i + 1}.xhtml`, `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}" dir="${dir}"><head><title>${t}</title></head><body><h1>${t}</h1>${body}</body></html>`));
  z.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Nav</title></head><body><nav epub:type="toc"><ol>${chapters.map(([t], i) => `<li><a href="c${i + 1}.xhtml">${t}</a></li>`).join('')}</ol></nav></body></html>`);
  z.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">${id}</dc:identifier><dc:title>${title}</dc:title><dc:language>${lang}</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${chapters.map((_, i) => `<item id="c${i + 1}" href="c${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${chapters.map((_, i) => `<itemref idref="c${i + 1}"/>`).join('')}</spine></package>`);
  fs.writeFileSync(file, await z.generateAsync({ type: 'nodebuffer' }));
}
const code = `<pre>${'const river = ["the", "old", "city", "and", "the", "people", "read", "their", "books", "by", "the", "water"].map((w) =&gt; w.toUpperCase()).join(" ");'.repeat(2)}</pre>`;
const enPara = (c, i) => `<p>Chapter ${c}, paragraph ${i}. ${'The river ran past the old city and the people read their books by the water. '.repeat(3)}</p>`;
const arPara = (c, i) => `<p>الفصل ${c}، الفقرة ${i}. ${'جرى النهر بمحاذاة المدينة القديمة، وقرأ الناس كتبهم على ضفته في المساء. '.repeat(3)}</p>`;

// (Capacitor imitated: the app's listeners kept; the Kurokawa plugin records the edge guard asked, tells the insets set
// in window.__ins and keeps its "gestureInsets" listener, to be fired by the test.)
const CAP = () => {
  window.__cap = {}; window.__kl = {}; window.__calls = [];
  window.__ins = JSON.parse(sessionStorage.getItem('kr.test.ins') || '{"left":24,"right":24,"nav":"gesture"}');
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {
    App: { addListener: (ev, fn) => { window.__cap[ev] = fn; return Promise.resolve({ remove() {} }); }, getLaunchUrl: async () => null, minimizeApp: async () => { window.__minimized = true; } },
    Kurokawa: { setVolumeKeys: async () => undefined, setEdgeGuard: async (o) => { window.__calls.push(['edge', !!o.on]); return { ok: true }; }, gestureInsets: async () => ({ ...window.__ins }), addListener: (ev, fn) => { window.__kl[ev] = fn; return Promise.resolve({ remove() {} }); } },
  } };
};

(async () => {
  await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
  const br = await chromium.launch(); const errors = [];
  const ctx = await br.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: SHOTS ? 2 : 1, isMobile: true, hasTouch: true, serviceWorkers: 'block', locale: 'en' });
  const visible = (p, sel, timeout = 30000) => p.waitForFunction((sel) => [...document.querySelectorAll(sel)].some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && getComputedStyle(e).visibility !== 'hidden'; }), sel, { timeout, polling: 100 });
  const isVisible = (p, sel) => p.evaluate((sel) => [...document.querySelectorAll(sel)].some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && getComputedStyle(e).visibility !== 'hidden'; }), sel);
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(CAP);
  await p.goto(base);
  await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.visual', JSON.stringify({ bookPage: 'never', readingMode: 'chapters', turnAnimation: 'none' })); });
  await p.reload(); await visible(p, '.library-view');
  const setVisual = async (o) => { await p.evaluate((o) => { const v = JSON.parse(localStorage.getItem('kr.visual') || '{}'); Object.assign(v, o); localStorage.setItem('kr.visual', JSON.stringify(v)); location.hash = '#/'; }, o); await p.reload(); await visible(p, '.library-view'); await p.waitForTimeout(300); };
  const setIns = async (ins) => { await p.evaluate((ins) => { sessionStorage.setItem('kr.test.ins', JSON.stringify(ins)); window.__ins = ins; }, ins); };

  // The books: chapter 1 opens with a line of code wider than the page.
  const en = path.join(TMP, 'gest-en.epub'), ar = path.join(TMP, 'gest-ar.epub');
  await makeEpub(en, 'kr-gest-en', 'River Gestures', 'en', [1, 2, 3].map((c) => [`Chapter ${c}`, (c === 1 ? code : '') + Array.from({ length: 30 }, (_, i) => enPara(c, i + 1)).join('')]));
  await makeEpub(ar, 'kr-gest-ar', 'إيماءات النهر', 'ar', [1, 2, 3].map((c) => [`الفصل ${c}`, (c === 1 ? code : '') + Array.from({ length: 30 }, (_, i) => arPara(c, i + 1)).join('')]));
  const allBooks = () => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result.map((b) => ({ id: b.id, title: b.title }))); }; }));
  const ids = {};
  await p.setInputFiles('.library-view input[type=file]', [en, ar]);
  for (let i = 0; i < 160 && Object.keys(ids).length < 2; i++) { await p.waitForTimeout(250); const all = await allBooks(); const e = all.find((b) => /River/.test(b.title)), a = all.find((b) => /النهر/.test(b.title)); if (e) ids.en = e.id; if (a) ids.ar = a.id; }
  ok('the two books are imported', Object.keys(ids).length === 2, await allBooks());

  const inReader = () => isVisible(p, '.reader-view .reader-scroll');
  const inLibrary = () => isVisible(p, '.library-view');
  const barsShown = () => p.evaluate(() => !document.querySelector('.reader-view').classList.contains('immersive'));
  const tapMiddle = async () => { await p.touchscreen.tap(206, 420); await p.waitForTimeout(250); };
  const hideBars = async () => { if (await barsShown()) await tapMiddle(); await p.waitForTimeout(100); };
  const chapterNow = () => p.evaluate(() => [...document.querySelectorAll('.reader-flow .kr-chapter')].findIndex((c) => !c.hidden));
  const command = (c) => p.evaluate((c) => document.dispatchEvent(new CustomEvent('kr:command', { detail: c })), c);
  const openBook = async (key) => {
    await p.evaluate(() => { location.hash = '#/'; }); await visible(p, '.library-view');
    await p.evaluate((id) => { location.hash = `#/read/${id}`; }, ids[key]);
    await visible(p, '.reader-flow .kr-content p'); await p.waitForTimeout(700);
  };
  // (At the second chapter's top — a turn either way can be seen —, the bars hidden.)
  const atMiddle = async () => { for (let i = 0; i < 3; i++) await command('prevChapter'); await command('nextChapter'); await p.waitForTimeout(250); await p.evaluate(() => { document.querySelector('.reader-scroll').scrollTop = 0; }); await hideBars(); };
  // steps: ['s'|'m'|'e'|'c', x, y] the finger's touch events; ['S2', x, y] a second finger down, ['E2'] it lifted;
  // ['b'] the system's Back; ['w', ms] a wait; ['bt'] whether the book is still open, kept in window.__seen. All in
  // one go in the page; each touch's target is the element under its start.
  const gesture = (steps) => p.evaluate(async (steps) => {
    const sc = document.querySelector('.reader-scroll'); window.__seen = [];
    if (!sc) return;
    let el = sc, a = null, b = null;
    const mk = (id, x, y) => new Touch({ identifier: id, target: el, clientX: x, clientY: y });
    const fire = (type, touches, changed) => el.dispatchEvent(new TouchEvent(type, { touches, targetTouches: touches, changedTouches: changed, bubbles: true, cancelable: type !== 'touchcancel' }));
    for (const st of steps) {
      if (st[0] === 'b') { window.__cap.backButton({ canGoBack: true }); continue; }
      if (st[0] === 'w') { await new Promise((r) => setTimeout(r, st[1])); continue; }
      if (st[0] === 'bt') { await new Promise((r) => setTimeout(r, 30)); window.__seen.push(!!document.querySelector('.reader-view .reader-scroll')); continue; }
      if (document.querySelector('.reader-scroll') !== sc) return;
      if (st[0] === 's') { el = document.elementFromPoint(st[1], st[2]) || sc; if (!sc.contains(el)) el = sc; a = mk(7, st[1], st[2]); fire('touchstart', [a], [a]); }
      else if (st[0] === 'm') { a = mk(7, st[1], st[2]); fire('touchmove', b ? [a, b] : [a], [a]); }
      else if (st[0] === 'e') { a = mk(7, st[1], st[2]); fire('touchend', b ? [b] : [], [a]); }
      else if (st[0] === 'c') { a = mk(7, st[1], st[2]); fire('touchcancel', [], [a]); }
      else if (st[0] === 'S2') { b = mk(8, st[1], st[2]); fire('touchstart', [a, b], [b]); }
      else if (st[0] === 'E2') { const g = b; b = null; fire('touchend', [a], [g]); }
    }
  }, steps);
  // A drag from (x0, y) by dx (and dy) in n moves over ms, ended where it got to.
  const drag = (x0, y, dx, ms = 0, n = 5, dy = 0) => { const st = [['s', x0, y]]; for (let i = 1; i <= n; i++) { if (ms) st.push(['w', ms / n]); st.push(['m', x0 + (dx * i) / n, y + (dy * i) / n]); } st.push(['e', x0 + dx, y + dy]); return st; };
  const turned = async (steps, mid = true) => { if (mid) await atMiddle(); const c0 = await chapterNow(); await gesture(steps); await p.waitForTimeout(250); const c1 = await chapterNow(); return c1 - c0; };

  for (const mode of ['chapters', 'flow']) {
    await setIns({ left: 24, right: 24, nav: 'gesture' });
    await setVisual({ readingMode: mode, edgeGuard: false, swipeTurn: true, swipeSensitivity: 'normal' });
    for (const key of ['en', 'ar']) {
      const tag = `${mode} ${key === 'en' ? 'LTR' : 'RTL'}`;
      // (Forward: a finger moving left in a book written left to right, right in one written right to left.)
      const fw = key === 'en' ? -1 : 1;
      // (The edge the forward swipe starts from, in the zone and just outside it.)
      const inZone = fw < 0 ? 405 : 6, outZone = fw < 0 ? 380 : 32;
      await openBook(key); await atMiddle();

      /* ---------- 1. The system's Back zone ---------- */
      ok(`${tag}: a swipe begun in the system's Back zone turns nothing`, await turned(drag(inZone, 450, fw * 200)) === 0);
      ok(`${tag}: … nor one back from the other edge`, await turned(drag(fw < 0 ? 6 : 405, 450, -fw * 200)) === 0);
      ok(`${tag}: a swipe begun just outside the zone turns forward`, await turned(drag(outZone, 450, fw * 200)) === 1);
      ok(`${tag}: … and one the other way turns back`, await turned(drag(fw < 0 ? 32 : 380, 450, -fw * 200)) === -1);
      // Back 120 ms after a turn by a swipe begun outside the zone: part of the swipe.
      await atMiddle(); await gesture([...drag(outZone, 450, fw * 200), ['w', 120], ['b']]); await p.waitForTimeout(300);
      ok(`${tag}: a Back 120 ms after that turn is ignored, the book stays`, await inReader());
      // Back while a touch begun in the zone is still down: it goes on at once (not after the touch, nor 350 ms on).
      await gesture([['s', inZone, 450], ['m', inZone + fw * 30, 452], ['b'], ['bt'], ['w', 400], ['c', inZone + fw * 30, 452]]);
      const seen = await p.evaluate(() => window.__seen);
      ok(`${tag}: a Back during a touch begun in the zone leaves at once`, seen[0] === false && await inLibrary(), seen);
      await openBook(key); await atMiddle();
      // Two or three buttons: no zone (told by the shell's event), the whole width the reader's.
      ok(`${tag}: the shell's "gestureInsets" event is listened to`, await p.evaluate(() => typeof window.__kl.gestureInsets === 'function'));
      await p.evaluate(() => window.__kl.gestureInsets?.({ left: 0, right: 0, nav: 'buttons' }));
      ok(`${tag}: button navigation: a swipe from the very edge turns`, await turned(drag(inZone, 450, fw * 200)) === 1);
      await p.evaluate(() => window.__kl.gestureInsets?.({ left: 24, right: 24, nav: 'gesture' }));
      ok(`${tag}: gesture navigation told again: the edge is the phone's again`, await turned(drag(inZone, 450, fw * 200)) === 0);

      /* ---------- 2. Recognition ---------- */
      // A scroll that bends: first down (the direction decided), then sideways 100 px with 55 px down in all.
      ok(`${tag}: a scroll that bends sideways never turns`, await turned([['s', 206, 400], ['m', 206 + fw * 2, 415], ['m', 206 + fw * 50, 440], ['m', 206 + fw * 100, 455], ['e', 206 + fw * 100, 455]]) === 0);
      ok(`${tag}: a quick short flick (50 px in 60 ms) turns`, await turned(drag(206, 450, fw * 50, 60, 4)) === 1);
      ok(`${tag}: a slow short drag (60 px in 1.2 s) does not`, await turned(drag(206, 450, fw * 60, 1200, 6)) === 0);
      ok(`${tag}: a slow long drag (120 px in 1.5 s) turns`, await turned(drag(206, 450, fw * 120, 1500, 6)) === 1);
      ok(`${tag}: a swipe that comes back at the end (−120 then +30 quickly) turns nothing`, await turned([['s', 206, 450], ['m', 206 + fw * 60, 450], ['w', 100], ['m', 206 + fw * 120, 451], ['w', 200], ['m', 206 + fw * 115, 451], ['w', 16], ['m', 206 + fw * 100, 451], ['w', 16], ['m', 206 + fw * 90, 451], ['e', 206 + fw * 90, 451]]) === 0);
      ok(`${tag}: a second finger (a pinch) turns nothing`, await turned([['s', 300, 450], ['S2', 100, 455], ['m', 100, 450], ['E2'], ['e', 100, 450]]) === 0);
      ok(`${tag}: a touch cancelled (the system took it) turns nothing`, await turned([...drag(206, 450, fw * 200).slice(0, -1), ['c', 206 + fw * 200, 450]]) === 0);
      await p.evaluate(() => { const para = document.querySelector('.reader-flow .kr-chapter:not([hidden]) p'); const r = document.createRange(); r.selectNodeContents(para); getSelection().removeAllRanges(); getSelection().addRange(r); });
      ok(`${tag}: with text selected, a swipe turns nothing`, await turned(drag(206, 450, fw * 200), false) === 0);
      await p.evaluate(() => getSelection().removeAllRanges()); await p.waitForTimeout(200);
      await command('options'); await visible(p, '.panel.open'); await p.waitForTimeout(150);
      ok(`${tag}: with a panel open over the page, a swipe on the page turns nothing`, await turned(drag(206, 450, fw * 200), false) === 0);
      await p.evaluate(() => window.__cap.backButton({ canGoBack: true })); await p.waitForTimeout(300); await hideBars();
      // The code at chapter 1's top: it scrolls sideways; a swipe on it is the code's while it can still scroll that way.
      for (let i = 0; i < 3; i++) await command('prevChapter'); await p.waitForTimeout(250); await p.evaluate(() => { document.querySelector('.reader-scroll').scrollTop = 0; }); await hideBars();
      const preY = await p.evaluate(() => { const r = document.querySelector('.reader-flow .kr-chapter:not([hidden]) pre').getBoundingClientRect(); return Math.round(r.top + r.height / 2); });
      // (A finger moving to the left scrolls the code on toward its end; the right — the RTL book's forward — back.)
      await p.evaluate((fw) => { const pre = document.querySelector('.reader-flow .kr-chapter:not([hidden]) pre'); pre.scrollLeft = fw < 0 ? 0 : 200; }, fw);
      ok(`${tag}: a forward swipe on code that can still scroll that way turns nothing`, preY > 0 && preY < 900 && await turned(drag(206, preY, fw * 200), false) === 0, { preY });
      for (let i = 0; i < 3; i++) await command('prevChapter'); await p.waitForTimeout(250); await p.evaluate(() => { document.querySelector('.reader-scroll').scrollTop = 0; }); await hideBars();
      await p.evaluate((fw) => { const pre = document.querySelector('.reader-flow .kr-chapter:not([hidden]) pre'); pre.scrollLeft = fw < 0 ? pre.scrollWidth : 0; }, fw);
      ok(`${tag}: … once the code is at its end that way, the swipe turns`, await turned(drag(206, preY, fw * 200), false) === 1);
      await atMiddle();
      // The edge guard on: its band (the edge's middle 200 px) is the reader's, the edge above it the phone's.
      await setVisual({ edgeGuard: true }); await openBook(key); await atMiddle(); await p.waitForTimeout(200);
      ok(`${tag}: the guard on (bars hidden): asked of the shell`, (await p.evaluate(() => window.__calls.filter((c) => c[0] === 'edge').pop()))?.[1] === true);
      ok(`${tag}: the guard on: a swipe from the edge inside its band turns`, await turned(drag(inZone, 450, fw * 200)) === 1);
      ok(`${tag}: the guard on: a swipe from the edge above its band turns nothing`, await turned(drag(inZone, 150, fw * 200)) === 0);
      await setVisual({ edgeGuard: false });
      // The settings: swiping off; sensitivity high and low.
      await setVisual({ swipeTurn: false }); await openBook(key); await atMiddle();
      ok(`${tag}: "Turn pages by swiping" off: a long swipe turns nothing`, await turned(drag(206, 450, fw * 200)) === 0);
      await setVisual({ swipeTurn: true, swipeSensitivity: 'high' }); await openBook(key); await atMiddle();
      ok(`${tag}: sensitivity high: a slow 65 px drag turns`, await turned(drag(206, 450, fw * 65, 1000, 5)) === 1);
      await setVisual({ swipeSensitivity: 'low' }); await openBook(key); await atMiddle();
      ok(`${tag}: sensitivity low: a slow 100 px drag does not`, await turned(drag(206, 450, fw * 100, 1000, 5)) === 0);
      ok(`${tag}: sensitivity low: a slow 130 px drag does`, await turned(drag(206, 450, fw * 130, 1000, 5)) === 1);
      await setVisual({ swipeSensitivity: 'normal' }); await openBook(key); await atMiddle();

      // A turn by a swipe, the phone turned at once (the width changes, the text reflows): the new chapter stays — the
      // place a re-settle puts back is the one the swipe went to, never the chapter left (src/views/reader.ts readerTurn).
      {
        await atMiddle(); const c0 = await chapterNow();
        await gesture(drag(206, 450, fw * 200));
        for (let i = 1; i <= 6; i++) { await p.setViewportSize({ width: Math.round(412 + (915 - 412) * i / 6), height: Math.round(915 + (412 - 915) * i / 6) }); await p.waitForTimeout(40); }
        await p.waitForTimeout(1200); const c1 = await chapterNow();
        await p.setViewportSize({ width: 412, height: 915 }); await p.waitForTimeout(1200); const c2 = await chapterNow();
        ok(`${tag}: a swipe turn, the phone turned at once: the new chapter stays (and when turned back)`, c1 === c0 + 1 && c2 === c0 + 1, { c0, c1, c2 });
        await hideBars();
      }

      /* ---------- 3. Taps in the zone ---------- */
      const top0 = await p.evaluate(() => document.querySelector('.reader-scroll').scrollTop);
      await p.touchscreen.tap(inZone, 820); await p.waitForTimeout(400);
      const top1 = await p.evaluate(() => document.querySelector('.reader-scroll').scrollTop);
      ok(`${tag}: a tap in the zone's lower third turns the screen (tap zones as ever)`, top1 > top0 + 200, { top0, top1 });
      const b0 = await barsShown(); await p.touchscreen.tap(inZone, 450); await p.waitForTimeout(300);
      ok(`${tag}: a tap in the zone's middle shows the bars`, !b0 && await barsShown());
      await p.touchscreen.tap(inZone, 450); await p.waitForTimeout(300);
      ok(`${tag}: … and hides them again`, !(await barsShown()));
    }
  }
  // Continuous reading: no sideways turning at all (as before).
  await setVisual({ readingMode: 'continuous' }); await openBook('en'); await hideBars(); await p.waitForTimeout(1500);
  const where = () => p.evaluate(() => { const sc = document.querySelector('.reader-scroll'); const top = sc.getBoundingClientRect().top; const q = [...document.querySelectorAll('.reader-flow p')].find((x) => x.getBoundingClientRect().bottom > top + 8); return q ? q.textContent.slice(0, 24) : ''; });
  const w0 = await where();
  await gesture(drag(380, 450, -200)); await p.waitForTimeout(400);
  ok('continuous: a sideways swipe moves nothing', (await where()) === w0, { w0, w1: await where() });

  /* ---------- 4. The band above a chapter's title ---------- */
  const titleGap = () => p.evaluate(() => {
    const ch = [...document.querySelectorAll('.reader-flow .kr-chapter')].find((c) => !c.hidden && c.getBoundingClientRect().bottom > 0);
    const h = ch.querySelector('h1, h2, h3'); const sc = document.querySelector('.reader-scroll');
    return { margin: parseFloat(getComputedStyle(ch).marginTop), before: getComputedStyle(ch, '::before').content, gap: Math.round(h.getBoundingClientRect().top - sc.getBoundingClientRect().top) };
  });
  await setVisual({ readingMode: 'chapters' }); await openBook('en'); await hideBars();
  for (let i = 0; i < 3; i++) await command('prevChapter'); await command('nextChapter'); await p.waitForTimeout(400);
  const g2 = await titleGap();
  ok('chapter by chapter: chapter 2 opened at its top has no rule and no margin above its title', g2.margin === 0 && (g2.before === 'none' || g2.before === 'normal'), g2);
  const g1 = await (async () => { await command('prevChapter'); await p.evaluate(() => { document.querySelector('.reader-scroll').scrollTop = 0; }); await p.waitForTimeout(300); return titleGap(); })();
  ok('… its title stands as high as the first chapter\'s', Math.abs(g2.gap - g1.gap) <= 2, { g1, g2 });
  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await command('nextChapter'); await p.waitForTimeout(400);
    await p.screenshot({ path: path.join(SHOTS, 'chapter-top-after.png') });
    await p.addStyleTag({ content: '.kr-content .kr-chapter + .kr-chapter { margin-top: 2.5em; } .kr-content .kr-chapter + .kr-chapter::before { content: ""; display: block; width: 36px; border-top: 1px solid var(--r-rule); margin: 0 auto 2.5em; }' });
    await p.waitForTimeout(300); await p.screenshot({ path: path.join(SHOTS, 'chapter-top-before.png') });
  }
  // A place in chapter 2 saved chapter by chapter comes back on the same paragraph.
  await openBook('en'); for (let i = 0; i < 3; i++) await command('prevChapter'); await command('nextChapter'); await p.waitForTimeout(300);
  await p.evaluate(() => { const ps = [...document.querySelectorAll('.reader-flow .kr-chapter:not([hidden]) p')]; const sc = document.querySelector('.reader-scroll'); sc.scrollTop += ps[12].getBoundingClientRect().top - sc.getBoundingClientRect().top; sc.dispatchEvent(new Event('scroll')); });
  await p.waitForTimeout(1500);
  const firstPara = () => p.evaluate(() => { const sc = document.querySelector('.reader-scroll'); const top = sc.getBoundingClientRect().top; const ps = [...document.querySelectorAll('.reader-flow .kr-chapter:not([hidden]) p')]; const q = ps.find((x) => x.getBoundingClientRect().bottom > top + 8); return q ? q.textContent.slice(0, 30) : ''; });
  const want = await firstPara();
  await openBook('en'); await p.waitForTimeout(500);
  ok('chapter by chapter: a place saved in chapter 2 comes back on its paragraph', want.startsWith('Chapter 2, paragraph 13') && (await firstPara()) === want, { want, now: await firstPara() });
  await setVisual({ readingMode: 'continuous' }); await openBook('en');
  const gc = await p.evaluate(() => { const chs = [...document.querySelectorAll('.reader-flow .kr-chapter')]; const c = chs[1]; return { margin: parseFloat(getComputedStyle(c).marginTop), before: getComputedStyle(c, '::before').content }; });
  ok('continuous: the rule and the margin between chapters stay', gc.margin > 20 && gc.before !== 'none', gc);
  await setVisual({ readingMode: 'chapters' });

  /* ---------- 5. The Performance report ---------- */
  await openBook('en'); await atMiddle();
  await gesture(drag(405, 450, -200)); await gesture(drag(6, 450, 200)); await p.waitForTimeout(100);
  await p.evaluate(() => { location.hash = '#/'; }); await visible(p, '.library-view'); await p.waitForTimeout(300);
  const ev = await p.evaluate(() => window.__krDiag.data().events.filter((e) => e.k === 'syszone' || e.k === 'systouch').slice(-4));
  const z = ev.filter((e) => e.k === 'syszone').pop(), st = ev.filter((e) => e.k === 'systouch').pop();
  ok('the record: the zone and navigation at book open', z && z.l === 24 && z.r === 24 && z.nav === 'gesture' && z.guard === false, ev);
  ok('the record: the touches left to the system, counted when the book closed', st && st.n >= 2, ev);
  await p.evaluate(() => { window.__clip = ''; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (s) => { window.__clip = s; } }, configurable: true }); location.hash = '#/settings'; });
  await visible(p, '.settings-view .card-title');
  await p.evaluate(() => { const b = document.querySelector('.perf-entry button'); b.closest('.card').classList.remove('collapsed'); b.scrollIntoView({ block: 'center' }); });
  await visible(p, '.perf-entry button'); await p.click('.perf-entry button'); await visible(p, '.perf-sheet .perf-row'); await p.waitForTimeout(300);
  await p.locator('.perf-sheet .sheet-actions button').first().click(); await p.waitForTimeout(300);
  const text = await p.evaluate(() => window.__clip);
  await p.evaluate(() => document.querySelector('.perf-sheet .sheet-head button').click()); await p.waitForTimeout(200);
  ok('the report: the zone at the last book open, in one short line', /System Back zone at the last book open: left 24 px, right 24 px, gesture navigation\./.test(text), text.slice(-700));
  ok('the report: the touches left to the system', /Touches begun in it, left to the system: \d+ \(in \d+ of the last \d+ books opened\)\./.test(text));

  /* ---------- 6. The settings ---------- */
  for (const lang of ['en', 'ar']) {
    await p.evaluate((lang) => { localStorage.setItem('kr.lang', lang); location.hash = '#/settings'; }, lang); await p.reload(); await p.waitForSelector('.settings-body .options-grid', { state: 'attached' }); await p.waitForTimeout(600);
    const src = fs.readFileSync(path.join(__dirname, `../src/i18n/${lang}.ts`), 'utf8'); const S = (k) => new RegExp(`\\n  ${k}: "([^"]*)",`).exec(src)[1];
    const body = await p.evaluate(() => document.querySelector('.settings-body').textContent);
    ok(`settings (${lang}): "${S('swipeTurn')}" and "${S('swipeSensitivity')}" (${S('swipeLow')} / ${S('swipeNormal')} / ${S('swipeHigh')}) shown on the phone`, [S('swipeTurn'), S('swipeSensitivity'), S('swipeLow'), S('swipeNormal'), S('swipeHigh')].every((x) => body.includes(x)));
    const near = await p.evaluate(([a, b]) => { const els = [...document.querySelectorAll('.settings-body *')].filter((e) => e.children.length === 0); const i = els.findIndex((e) => e.textContent.trim() === a), j = els.findIndex((e) => e.textContent.trim() === b); return i >= 0 && j > i && j - i < 40; }, [S('edgeGuard'), S('swipeTurn')]);
    ok(`settings (${lang}): next to the edge protection`, near);
  }
  await p.evaluate(() => localStorage.setItem('kr.lang', 'en'));

  ok('no page errors', !errors.length, errors);
  await br.close(); server.close();
  console.log(fails ? `${fails} failed` : 'all passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
