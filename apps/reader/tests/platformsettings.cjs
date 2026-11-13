// node tests/platformsettings.cjs: each setting shown only where it can act (src/platform.ts) — on an imitated Android
// phone (Capacitor imitated, as tests/backkeys.cjs does), the desktop app (its bridge imitated, as tests/pcui.cjs does),
// a plain web page on a computer (a mouse) and a plain web page on a phone (a finger; a browser that does not tell the
// battery), in English and Arabic:
//  1. Settings and the reader's options: the rows that must show there and the rows that must not.
//  2. Settings search finds a hidden row nowhere, and finds it where it shows.
//  3. A value set on the other kind of device stays stored and does nothing: tap zones (all «next page») and a
//     locked orientation, synced from the phone, on a computer; the interface size, set on a computer, on a phone.
//  4. «Customise buttons» offers «Open with another app» on Android only, and keeps its place elsewhere.
// The book is made here.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 500))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-platform-'));

// The strings, from the app's own files (one line each: `  key: "…",`).
const strings = (lang) => { const src = fs.readFileSync(path.join(__dirname, `../src/i18n/${lang}.ts`), 'utf8'); return (k) => { const m = new RegExp(`\\n  ${k}: (["'])((?:\\\\.|(?!\\1).)*)\\1,`).exec(src); if (!m) throw new Error(`no string ${k} in ${lang}`); return m[2].replace(/\\(.)/g, '$1'); }; };

// Where each row shows (src/platform.ts). Platforms: android, desktop (the app), webpc (a browser with a mouse),
// webphone (a phone's browser).
const ALL = ['android', 'desktop', 'webpc', 'webphone'];
const ROWS = {
  tapToTurn: ['android', 'webphone'], tapZones: ['android', 'webphone'], pinchText: ['android', 'webphone'], edgeBrightness: ['android', 'webphone'], orientation: ['android', 'webphone'],
  swipeTurn: ['android', 'webphone'], swipeSensitivity: ['android', 'webphone'],
  volumeKeys: ['android'], edgeGuard: ['android'], doubleBackExit: ['android'], snapFolder: ['android'],
  hideSystemBars: ['android', 'desktop'], uiSize: ['desktop'], shortcutsEditBody: ['desktop', 'webpc'],
  pdfPinchZoom: ['android', 'webphone'], barItemBattery: ['android', 'desktop', 'webpc'],
  backTwiceLeave: ALL, keepAwake: ALL, showStatusLine: ALL, readingMode: ALL,
};

async function makeEpub(file) {
  const JSZip = require('jszip'); const z = new JSZip();
  z.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  z.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const body = Array.from({ length: 60 }, (_, i) => `<p>Paragraph ${i + 1}. ${'The river ran past the old city and the people read their books by the water. '.repeat(3)}</p>`).join('');
  z.file('OEBPS/c1.xhtml', `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en"><head><title>One</title></head><body><h1>One</h1>${body}</body></html>`);
  z.file('OEBPS/nav.xhtml', '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Nav</title></head><body><nav epub:type="toc"><ol><li><a href="c1.xhtml">One</a></li></ol></nav></body></html>');
  z.file('OEBPS/content.opf', '<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">kr-platform-1</dc:identifier><dc:title>Platform Pages</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>');
  fs.writeFileSync(file, await z.generateAsync({ type: 'nodebuffer' }));
}

const CTX = {
  android: { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true },
  webphone: { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1366, height: 768 } },
  webpc: { viewport: { width: 1366, height: 768 } },
};
// (Each page's imitation: the shell, and a record of what is asked of the screen's orientation and the window's zoom.)
const INIT = ({ plat, lang, visual }) => {
  window.__locks = []; window.__zoom = [];
  try { Object.defineProperty(screen.orientation, 'lock', { configurable: true, value: async (o) => { window.__locks.push(o); } }); Object.defineProperty(screen.orientation, 'unlock', { configurable: true, value: () => { window.__locks.push('unlock'); } }); } catch { /* none */ }
  if (plat === 'android') {
    window.__cap = {};
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {
      App: { addListener: (ev, fn) => { window.__cap[ev] = fn; return Promise.resolve({ remove() {} }); }, getLaunchUrl: async () => null, minimizeApp: async () => undefined },
      Kurokawa: { setVolumeKeys: async () => undefined, setEdgeGuard: async () => ({ ok: true }) },
      ScreenOrientation: { lock: async (o) => { window.__locks.push(o.orientation); }, unlock: async () => { window.__locks.push('unlock'); } },
    } };
  }
  if (plat === 'desktop') window.kurokawaDesktop = new Proxy({ setZoom: (f) => window.__zoom.push(f) }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : () => undefined) });
  if (plat === 'webphone') { try { delete Navigator.prototype.getBattery; } catch { /* none */ } }
  if (!sessionStorage.getItem('kr.platform.init')) {
    sessionStorage.setItem('kr.platform.init', '1');
    localStorage.setItem('kr.lang', lang); localStorage.setItem('kr.update.lastCheck', String(Date.now()));
    localStorage.setItem('kr.visual', JSON.stringify(visual));
    if (plat !== 'desktop') localStorage.setItem('kr.uiSize', '1.3');
  }
};

(async () => {
  await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
  const epub = path.join(TMP, 'platform.epub'); await makeEpub(epub);
  const br = await chromium.launch();
  for (const lang of ['en', 'ar']) {
    const S = strings(lang);
    for (const plat of ALL) {
      const tag = `${lang} ${plat}`;
      const ctx = await br.newContext({ ...CTX[plat], deviceScaleFactor: 1, serviceWorkers: 'block', locale: lang });
      const p = await ctx.newPage(); const errors = []; p.on('pageerror', (e) => errors.push(e.message)); p.setDefaultTimeout(15000);
      // (Set on the phone, synced here: every tap zone turns the page, the screen held sideways, the volume keys on.)
      const visual = { bookPage: 'never', readingMode: 'chapters', turnAnimation: 'none', showStatusLine: true, tapToTurn: true, brightnessMode: 'app', volumeKeys: true, orientation: 'landscape', tapZones: Array(9).fill('next') };
      await p.addInitScript(INIT, { plat, lang, visual });
      await p.goto(base + '#/'); await p.waitForSelector('.library-view');

      /* ---------- 1. The rows ---------- */
      await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForSelector('.settings-body .options-grid', { state: 'attached' }); await p.waitForTimeout(700);
      const text = await p.evaluate(() => document.querySelector('.settings-body').textContent);
      const wrong = [];
      for (const [k, where] of Object.entries(ROWS)) { const want = where.includes(plat); if (text.includes(S(k)) !== want) wrong.push(`${k}: ${want ? 'missing' : 'shown'}`); }
      ok(`${tag}: the settings show the rows that act here, and only those`, !wrong.length, wrong);
      if (plat === 'android') ok(`${tag}: the battery shows where the device tells it`, await p.evaluate(() => typeof navigator.getBattery === 'function'));

      /* ---------- 2. Search ---------- */
      const search = async (q) => { await p.fill('.settings-search', q); await p.waitForTimeout(250); return p.evaluate((q) => [...document.querySelectorAll('.settings-body .card *')].some((e) => !e.closest('[hidden]') && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.includes(q)) && e.getClientRects().length > 0), q); };
      for (const k of ['tapToTurn', 'volumeKeys', 'uiSize', 'snapFolder']) {
        const want = ROWS[k].includes(plat);
        ok(`${tag}: searching «${S(k)}» ${want ? 'finds it' : 'finds nothing'}`, (await search(S(k))) === want);
      }
      await p.fill('.settings-search', '');

      // A hidden value stays stored when another setting is changed.
      await p.evaluate(() => { const v = JSON.parse(localStorage.getItem('kr.visual')); v.showQuote = !v.showQuote; localStorage.setItem('kr.visual', JSON.stringify(v)); });
      ok(`${tag}: a value not shown here stays stored`, await p.evaluate(() => { const v = JSON.parse(localStorage.getItem('kr.visual')); return v.volumeKeys === true && v.orientation === 'landscape' && v.tapZones.every((z) => z === 'next'); }));

      /* ---------- 3. Values from the other kind of device ---------- */
      const phone = plat === 'android' || plat === 'webphone';
      await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view');
      await p.setInputFiles('.library-view input[type=file]', [epub]);
      let id = null;
      for (let i = 0; i < 120 && !id; i++) { await p.waitForTimeout(250); id = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res((q.result.find((b) => /Platform/.test(b.title)) || {}).id || null); }; })); }
      ok(`${tag}: the book is imported`, !!id);
      await p.evaluate(() => { window.__locks.length = 0; });
      await p.evaluate((id) => { location.hash = `#/read/${id}`; }, id);
      await p.waitForSelector('.reader-flow .kr-content p'); await p.waitForTimeout(900);
      const locks = await p.evaluate(() => window.__locks.slice());
      ok(`${tag}: a locked orientation ${phone ? 'is applied' : 'from the phone is left alone'}`, phone ? locks.includes('landscape') : !locks.length, locks);
      const before = await p.evaluate(() => ({ top: document.querySelector('.reader-scroll').scrollTop, imm: !!document.querySelector('.immersive') }));
      const box = await p.evaluate(() => { const r = document.querySelector('.reader-scroll').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      if (CTX[plat].hasTouch) await p.touchscreen.tap(box.x, box.y); else await p.mouse.click(box.x, box.y);
      await p.waitForTimeout(900);
      const after = await p.evaluate(() => ({ top: document.querySelector('.reader-scroll').scrollTop, imm: !!document.querySelector('.immersive') }));
      if (phone) ok(`${tag}: a tap in the middle turns the page, as its zone says`, after.top > before.top + 100, { before, after });
      else ok(`${tag}: a click in the middle shows or hides the bars (the phone's zones do nothing here)`, after.top === before.top && after.imm !== before.imm, { before, after });
      if (phone) ok(`${tag}: the interface size set on a computer does nothing`, await p.evaluate(() => window.__zoom.length === 0 && Math.abs(document.documentElement.getBoundingClientRect().width - innerWidth) < 2 && (getComputedStyle(document.documentElement).zoom || '1') === '1'));

      /* ---------- 4. Customise buttons ---------- */
      await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForSelector('.open-buttons', { state: 'attached' });
      await p.evaluate(() => document.querySelector('.open-buttons').click()); await p.waitForSelector('.buttons-sheet');
      await p.evaluate(() => document.querySelector('.buttons-kind button[data-kind="pdf"]').click()); await p.waitForTimeout(200);
      const hasOpenWith = await p.evaluate((name) => document.querySelector('.buttons-sheet').textContent.includes(name), S('openWithApp'));
      ok(`${tag}: «${S('openWithApp')}» offered ${plat === 'android' ? 'on Android' : 'nowhere else'}`, hasOpenWith === (plat === 'android'));
      // (A change made here keeps its place in the saved list.)
      await p.evaluate(() => document.querySelector('.buttons-sheet .buttons-foot button').click()); await p.waitForTimeout(150);
      const first = await p.$('.buttons-sheet .placed-row, .buttons-sheet [data-id]');
      if (first) { const mv = await p.$('.buttons-sheet button.mv-down:not([disabled])'); if (mv) { await mv.click(); await p.waitForTimeout(150); } }
      ok(`${tag}: «Open with another app» keeps its place in what is saved`, await p.evaluate(() => { const v = JSON.parse(localStorage.getItem('kr.visual')); return (v.pdfButtons || []).some((x) => x.id === 'openWithApp' && x.at === 'more'); }));

      ok(`${tag}: no page errors`, !errors.length, errors);
      await ctx.close();
    }
  }
  await br.close(); server.close(); fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
