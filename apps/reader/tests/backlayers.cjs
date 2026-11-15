// node tests/backlayers.cjs: one Back for every layer and place (src/ui/backstack.ts — the one dispatcher: pushLayer for
// sheets and side panels, onBack for a view's own steps, the arrow and Esc through it), table-driven: each row opens
// something, presses Back ONE way, and checks where that lands — the same for every way:
//   a phone (412×915, touch; Capacitor's Back imitated as the shell calls it): the phone's Back;
//   a computer (1280×800): Esc, Alt+←, the mouse's back button, and the view's top-left arrow where a hand can reach it.
// Rows: the library's sort sheet, a book's menu, the books selected, a search typed; in a book the reading options (closed
// by their close — never their first head button, Undo: the old regression), the contents, a sheet over a panel (only the
// sheet goes), the words selected, auto-scroll, the pictures' gallery, a picture's full view, nothing open (out to the
// library); the settings' search, the settings, a book's page, the notes — each back to where it came from.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os'); const zlib = require('zlib');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 500))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-backlayers-'));

function png(w, hgt) {
  const crc = (b) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } c = 0xffffffff; for (const x of b) c = t[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(hgt, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * hgt); for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 60 + x; raw[o + 1] = 90; raw[o + 2] = 120 + y; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
async function makeEpub(file) {
  const JSZip = require(path.resolve(__dirname, '../node_modules/jszip')); const z = new JSZip();
  z.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  z.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const ps = (k) => Array.from({ length: 14 }, (_, i) => `<p>[${k}${i}] The keeper climbed the stairs of the old tower at dusk and lit the lamp as his father had done before him.</p>`).join('');
  z.file('OEBPS/c1.xhtml', `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en"><head><title>t</title></head><body><h1>One</h1>${ps('A')}<p><img src="pic.png" alt="a picture"/></p>${ps('B')}</body></html>`);
  z.file('OEBPS/pic.png', png(160, 100));
  z.file('OEBPS/nav.xhtml', '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="c1.xhtml">One</a></li></ol></nav></body></html>');
  z.file('OEBPS/content.opf', '<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">kr-bl</dc:identifier><dc:title>Lantern Keeper</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="p" href="pic.png" media-type="image/png"/></manifest><spine><itemref idref="c1"/></spine></package>');
  fs.writeFileSync(file, await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}
const CAP = () => {
  window.__cap = {};
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {
    App: { addListener: (ev, fn) => { window.__cap[ev] = fn; return Promise.resolve({ remove() {} }); }, getLaunchUrl: async () => null, minimizeApp: async () => { window.__minimized = true; } },
    Kurokawa: { setVolumeKeys: async () => undefined, setEdgeGuard: async () => ({ ok: true }) },
  } };
};

// Where the app is: the view, what is open over it, the state a row looks at.
const where = (p) => p.evaluate(() => {
  const shown = (s) => [...document.querySelectorAll(s)].some((e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden');
  const sel = getSelection();
  return {
    hash: location.hash || '#/', reader: shown('.reader-view .reader-scroll'), library: shown('.library-view'), settings: shown('.settings-view'),
    sheets: document.querySelectorAll('.sheet').length, panel: !!document.querySelector('.panel.open'), dialog: shown('.lightbox, [role="dialog"].view'), lightbox: shown('.lightbox'),
    selecting: shown('.selection-bar'), search: (document.querySelector('.library-view input[type=search], .settings-view input[type=search]') || {}).value ?? '',
    words: !!sel && !sel.isCollapsed, auto: shown('.autoscroll-hud'), align: JSON.parse(localStorage.getItem('kr.visual') || '{}').align ?? null,
  };
});
const keyOn = async (p, k) => { await p.evaluate(() => document.activeElement?.blur?.()); await p.keyboard.press(k); };

(async () => {
  await new Promise((r) => server.listen(0, r));
  const file = path.join(TMP, 'keeper.epub'); await makeEpub(file);
  const ctxs = {
    phone: { opts: { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, serviceWorkers: 'block', locale: 'en' }, ways: ['android'] },
    pc: { opts: { viewport: { width: 1280, height: 800 }, serviceWorkers: 'block', locale: 'en' }, ways: ['esc', 'alt', 'mouse', 'arrow'] },
  };
  for (const [kind, c] of Object.entries(ctxs)) {
    const br = await chromium.launch(); const errors = [];
    const ctx = await br.newContext(c.opts); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
    if (kind === 'phone') await p.addInitScript(CAP);
    await p.goto(`http://127.0.0.1:${server.address().port}/`);
    await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.visual', JSON.stringify({ readingMode: 'continuous', bookPage: 'always', doubleBackExit: false, backTwiceLeave: false })); });
    await p.reload(); await p.waitForSelector('.library-view');
    await p.setInputFiles('.library-view input[type=file]', [file]);
    let id = null;
    for (let i = 0; i < 200 && !id; i++) { await p.waitForTimeout(250); id = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result[0]?.id ?? null); }; })); }
    const home = async () => { await p.evaluate(() => { document.querySelectorAll('.sheet, .scrim.sheet-scrim').forEach((x) => x.remove()); location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.waitForTimeout(400); };
    const reader = async () => { await home(); await p.evaluate((id) => { location.hash = `#/read/${id}`; }, id); await p.waitForSelector('.reader-flow .kr-content p >> visible=true'); await p.waitForTimeout(900); };
    const click = (s) => p.evaluate((s) => { const e = [...document.querySelectorAll(s)].find((x) => x.getClientRects().length); e?.click(); return !!e; }, s);
    const press = async (way) => {
      if (way === 'android') await p.evaluate(() => window.__cap.backButton({ canGoBack: true }));
      else if (way === 'esc') await keyOn(p, 'Escape');
      else if (way === 'alt') await keyOn(p, 'Alt+ArrowLeft');
      else if (way === 'mouse') await p.evaluate(() => { for (const t of ['mousedown', 'mouseup']) window.dispatchEvent(new MouseEvent(t, { button: 3, bubbles: true })); });
      // (The arrow as a hand reaches it: not under a scrim.)
      else if (way === 'arrow') { const b = await p.$('.view .topbar button[data-icon="back"] >> visible=true'); if (!b) return false; try { await b.click({ timeout: 1500 }); } catch { return false; } }
      await p.waitForTimeout(900); return true;
    };
    // [name, open, expected after one Back, ways the arrow can reach (none: arrow not tried)]
    const rows = [
      ['library: the sort sheet', async () => { await home(); await click('.sort-btn'); }, (w) => w.sheets === 0 && w.library && w.hash === '#/'],
      ['library: a book\'s menu', async () => { await home(); await p.click('.book-card', { button: 'right' }).catch(() => undefined); await p.waitForTimeout(300); if (!(await p.$('.sheet'))) await p.evaluate(() => document.querySelector('.book-card')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 300 }))); }, (w) => w.sheets === 0 && w.library && w.hash === '#/'],
      ['library: the books selected', async () => { await home(); await p.evaluate(() => document.activeElement?.blur?.()); await p.keyboard.press('Control+a'); }, (w) => !w.selecting && w.library && w.hash === '#/'],
      ['library: a search typed', async () => { await home(); await p.fill('.library-view input[type=search]', 'Lantern'); await p.waitForTimeout(500); await p.evaluate(() => document.activeElement?.blur?.()); }, (w) => w.search === '' && w.library && w.hash === '#/'],
      ['book: the reading options (their close, not Undo)', async () => { await reader(); await keyOn(p, 'v'); await p.waitForSelector('.panel.open .options-grid'); }, (w) => !w.panel && w.reader && w.align === null, true],
      ['book: the contents', async () => { await reader(); await keyOn(p, 'c'); await p.waitForSelector('.panel.open'); }, (w) => !w.panel && w.reader, true],
      ['book: a sheet over a panel (only the sheet goes)', async () => { await reader(); await keyOn(p, 'v'); await p.waitForSelector('.panel.open .options-grid'); await p.evaluate(() => { const b = [...document.querySelectorAll('.panel.open .options-grid button')].find((x) => /Customi[sz]e/.test(x.textContent)); b?.scrollIntoView(); b?.click(); }); await p.waitForSelector('.sheet'); }, (w) => w.sheets === 0 && w.panel && w.reader],
      ['book: the words selected', async () => { await reader(); await p.evaluate(() => { const e = document.querySelector('.reader-flow .kr-content p:nth-of-type(3)'); const r = document.createRange(); r.selectNodeContents(e); getSelection().removeAllRanges(); getSelection().addRange(r); document.dispatchEvent(new Event('selectionchange')); }); await p.waitForTimeout(400); }, (w) => !w.words && w.reader, true],
      ['book: auto-scroll', async () => { await reader(); await keyOn(p, 'a'); await p.waitForSelector('.autoscroll-hud'); }, (w) => !w.auto && w.reader, true],
      ['book: the pictures\' gallery', async () => { await reader(); await keyOn(p, 'g'); await p.waitForTimeout(600); }, (w) => !w.dialog && w.reader],
      ['book: a picture\'s full view', async () => { await reader(); await p.evaluate(() => { const i = document.querySelector('.reader-flow .kr-content img'); i.scrollIntoView({ block: 'center' }); }); await p.waitForTimeout(500); await p.evaluate(() => document.querySelector('.reader-flow .kr-content img').click()); await p.waitForTimeout(600);
        // (Where a click on a picture does not open it — a computer —: from the gallery's grid, the picture over the grid.)
        if (!(await p.$('.lightbox'))) { await keyOn(p, 'g'); await p.waitForTimeout(500); await click('.gallery-grid button'); await p.waitForTimeout(600); } }, (w) => !w.lightbox && w.reader],
      ['book: nothing open — out, to the book\'s page', async () => { await reader(); }, (w) => !w.reader && /#\/(book\/|$)/.test(w.hash), true],
      ['settings: a search typed', async () => { await home(); await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForSelector('.settings-view input[type=search]'); await p.fill('.settings-view input[type=search]', 'font'); await p.waitForTimeout(300); await p.evaluate(() => document.activeElement?.blur?.()); }, (w) => w.search === '' && w.settings],
      ['settings: nothing open — the library', async () => { await home(); await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForSelector('.settings-view'); await p.waitForTimeout(300); }, (w) => w.library && w.hash === '#/', true],
      ['a book\'s page — the library', async () => { await home(); await p.evaluate((id) => { location.hash = `#/book/${id}`; }, id); await p.waitForTimeout(900); }, (w) => w.library && w.hash === '#/', true],
      ['the notes — the library', async () => { await home(); await p.evaluate(() => { location.hash = '#/notes'; }); await p.waitForTimeout(900); }, (w) => w.library && w.hash === '#/', true],
    ];
    for (const [name, open, expect, arrowToo] of rows) {
      for (const way of c.ways) {
        if (way === 'arrow' && !arrowToo) continue;
        await open();
        const before = await where(p);
        const pressed = await press(way);
        const w = await where(p);
        if (way === 'arrow' && !pressed) { ok(`${kind} · ${name} · arrow: not reachable (skipped)`, true); continue; }
        ok(`${kind} · ${name} · ${way}`, expect(w), { before, after: w });
      }
    }
    if (kind === 'pc') {
      // Esc's order, one press at a time: a layer (the contents) → the full screen → auto-scroll → the words selected →
      // «Next volume»'s question (come from another volume) → out of the book. (The full screen as the browser has it.)
      await reader();
      await p.evaluate((id) => sessionStorage.setItem('kr.fromVolume', JSON.stringify({ from: 'some-other-volume', to: id })), id);
      await reader();
      await p.evaluate(() => { const e = document.querySelector('.reader-flow .kr-content p:nth-of-type(3)'); const r = document.createRange(); r.selectNodeContents(e); getSelection().removeAllRanges(); getSelection().addRange(r); });
      await keyOn(p, 'a'); await p.waitForSelector('.autoscroll-hud');
      await p.evaluate(() => document.documentElement.requestFullscreen?.().catch(() => undefined)); await p.waitForTimeout(400);
      const full = await p.evaluate(() => !!document.fullscreenElement);
      // (The words selected again: starting auto-scroll may let them go.)
      await p.evaluate(() => { const e = document.querySelector('.reader-flow .kr-content p:nth-of-type(3)'); const r = document.createRange(); r.selectNodeContents(e); getSelection().removeAllRanges(); getSelection().addRange(r); });
      await keyOn(p, 'c'); await p.waitForSelector('.panel.open');
      const state = () => p.evaluate(() => ({ panel: !!document.querySelector('.panel.open'), full: !!document.fullscreenElement, auto: !!document.querySelector('.autoscroll-hud'), words: !getSelection().isCollapsed, ask: !!document.querySelector('.sheet.vol-back'), reader: !!document.querySelector('.reader-view'), hash: location.hash }));
      const seq = [await state()];
      for (let i = 0; i < (full ? 5 : 4); i++) { await p.keyboard.press('Escape'); await p.waitForTimeout(600); seq.push(await state()); }
      const st = (i) => seq[i];
      let k = 1;
      const okOrder = !st(k).panel && st(k).auto && (full ? st(k).full : true) && st(k).words
        && (full ? (k++, !st(k).full && st(k).auto) : true)
        && (k++, !st(k).auto && st(k).words)
        && (k++, !st(k).words && !st(k).ask && st(k).reader)
        && (k++, st(k).ask && st(k).reader);
      ok(`pc · Esc's order: layer → ${full ? 'full screen → ' : ''}auto-scroll → selection → «Next volume»'s question`, okOrder, { full, seq });
      await p.click('.sheet.vol-back .vol-back-home'); await p.waitForTimeout(900);
      ok('pc · … and from the question, out (Main page)', (await where(p)).library);
      // Esc while typing in a field: the field's only — a search emptied, never a step back.
      await reader(); await keyOn(p, 'c'); await p.waitForSelector('.panel.open');
      const field = await p.$('.panel.open input[type=search], .panel.open input[type=text]');
      if (!field) { await p.evaluate(() => { const i = document.createElement('input'); i.type = 'search'; i.className = 'kr-test-field'; document.querySelector('.panel.open .panel-body').prepend(i); }); }
      const sel = field ? '.panel.open input[type=search], .panel.open input[type=text]' : '.kr-test-field';
      await p.fill(sel, 'lamp'); await p.focus(sel); await p.keyboard.press('Escape'); await p.waitForTimeout(500);
      const f1 = await p.evaluate((sel) => ({ v: document.querySelector(sel)?.value, panel: !!document.querySelector('.panel.open') }), sel);
      await p.focus(sel); await p.keyboard.press('Escape'); await p.waitForTimeout(500);
      const f2 = await p.evaluate((sel) => ({ focused: document.activeElement === document.querySelector(sel), panel: !!document.querySelector('.panel.open') }), sel);
      ok('pc · Esc typing in a field: the search emptied, the panel stays; again: the field left, the panel stays', f1.v === '' && f1.panel && !f2.focused && f2.panel, { f1, f2 });
      await p.keyboard.press('Escape'); await p.waitForTimeout(500);
      ok('pc · … the next Esc (out of the field) closes the panel', !(await where(p)).panel);
      // «Back twice to leave a book»: Esc is guarded (a reminder, stays; a second within 2 s leaves); the arrow is not.
      await p.evaluate(() => { const v = JSON.parse(localStorage.getItem('kr.visual')); v.backTwiceLeave = true; localStorage.setItem('kr.visual', JSON.stringify(v)); });
      await home(); await p.reload(); await p.waitForSelector('.library-view');
      await reader(); await p.keyboard.press('Escape'); await p.waitForTimeout(500);
      const t1 = await where(p); const toast1 = await p.evaluate(() => [...document.querySelectorAll('.toast')].map((x) => x.textContent).join('|'));
      await p.keyboard.press('Escape'); await p.waitForTimeout(900);
      const t2 = await where(p);
      ok('pc · Back twice on: Esc once shows the reminder and stays; twice leaves', t1.reader && /again/i.test(toast1) && !t2.reader, { t1: t1.hash, toast1, t2: t2.hash });
      await reader(); await p.click('.view .topbar button[data-icon="back"]'); await p.waitForTimeout(900);
      ok('pc · Back twice on: the arrow leaves at once', !(await where(p)).reader);
      await p.evaluate(() => { const v = JSON.parse(localStorage.getItem('kr.visual')); v.backTwiceLeave = false; localStorage.setItem('kr.visual', JSON.stringify(v)); });
    }
    ok(`${kind}: no page errors`, errors.length === 0, errors);
    await br.close();
  }
  server.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
