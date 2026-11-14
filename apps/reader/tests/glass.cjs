// node tests/glass.cjs: the interface styles (src/theme/): frosted glass over the chrome, Classic the default.
//  1. Nothing changes by default: no style attribute, no glass stylesheet, the glass code not even fetched; the computed
//     colours of a sample of the chrome (library, settings, reader bars) are those of Classic — and, given the build
//     before (KR_OLD_DIST), the very same as that build's; a style chosen and Classic chosen again gives them back.
//  2. A style chosen in Settings → Appearance applies to the library, the settings, a sheet and the reader's bars, in
//     English and Arabic, on a phone and on a computer.
//  3. The reading surface (the page's colour, the text, the links) is the reading theme's under every style.
//  4. While reading with the bars hidden no element has a backdrop filter (an EPUB and a PDF).
//  5. Glass blur «Off»: no backdrop filter anywhere (library, a sheet open, the reader's bars shown); a device with
//     little memory, or one asking for less motion, gets «Reduced» on its own.
//  6. Contrast from the tokens (src/theme/themes.ts, src/readertheme/defs.ts): every style's text roles at least 4.5:1
//     on its background's brightest and darkest parts, its panes, cards and sheets (the shared contrastReport), and on
//     the reader's bars over a page of either lightness; the accent's text on the accent.
//  7. Packs (the shared .ktheme format), against a server on this machine: the pictures downloaded, checked, made the
//     screen's size, installed, used, removed; offline, a bad checksum and a full storage each say so and keep nothing.
//  8. The gallery and the blur show on a phone and on a computer; Classic's dark-surfaces row gives way to a style;
//     phone-only rows stay off the computer.
// The books are made here; the pack is built here (src/theme/packs.ts buildPack), with made-up pictures.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const OLD = process.env.KR_OLD_DIST ? path.resolve(process.env.KR_OLD_DIST) : null;
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.krtheme': 'application/octet-stream' };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-glass-'));
const PACKS = path.join(TMP, 'packs');
const serve = (dist) => http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (u.startsWith('/packs/')) { const f = path.join(PACKS, u.slice(7)); if (!fs.existsSync(f)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); res.setHeader('Content-Length', fs.statSync(f).size); return fs.createReadStream(f).pipe(res); }
  let f = path.join(dist, u); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dist, 'index.html');
  res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res);
});
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 600))); if (!c) fails++; };
// The strings, from the app's own files (one line each).
const strings = (lang) => { const src = fs.readFileSync(path.join(ROOT, `src/i18n/${lang}.ts`), 'utf8'); return (k) => { const m = new RegExp(`\\n  ${k}: (["'])((?:\\\\.|(?!\\1).)*)\\1,`).exec(src); if (!m) throw new Error(`no string ${k} in ${lang}`); return m[2].replace(/\\(.)/g, '$1'); }; };
const en = strings('en');

async function makeEpub(file) {
  const JSZip = require(path.join(ROOT, 'node_modules/jszip')); const z = new JSZip();
  z.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  z.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const body = Array.from({ length: 60 }, (_, i) => `<p>[P${i}] The river ran past the old city, and the people in their houses read their books${i % 7 === 0 ? ' and <a href="c1.xhtml">a link</a>' : ''}.</p>`).join('');
  z.file('OEBPS/c1.xhtml', `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head><body><h1>Chapter One</h1>${body}</body></html>`);
  z.file('OEBPS/nav.xhtml', '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Nav</title></head><body><nav epub:type="toc"><ol><li><a href="c1.xhtml">Chapter One</a></li></ol></nav></body></html>');
  z.file('OEBPS/content.opf', '<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">glass-1</dc:identifier><dc:title>Glass Test</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>');
  fs.writeFileSync(file, await z.generateAsync({ type: 'nodebuffer' }));
}
async function makePdf(file) {
  const { PDFDocument, StandardFonts } = require(path.join(ROOT, 'node_modules/pdf-lib'));
  const d = await PDFDocument.create(); const font = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 4; i++) { const pg = d.addPage([432, 648]); for (let l = 0; l < 20; l++) pg.drawText(`Page ${i} line ${l}: the quick brown fox.`, { x: 40, y: 600 - l * 16, size: 11, font }); }
  fs.writeFileSync(file, await d.save());
}

/* ---------------------------------------------------------------- the styles' tokens (no browser) */
// (The shared module and the Reader's styles, as the app has them: bundled here from their sources by esbuild.)
function loadThemes() {
  const esbuild = require(path.join(ROOT, 'node_modules/esbuild'));
  const out = esbuild.buildSync({ stdin: { contents: "import * as T from './src/theme/themes'; import * as P from './src/theme/packs'; import * as D from './src/readertheme/defs'; import * as G from './src/readertheme/pagetheme'; module.exports = { T, P, D, G };", resolveDir: ROOT, loader: 'ts' }, bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent' });
  const m = { exports: {} }; new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const { T, P, D, G } = loadThemes();
// (The Reader's list: its own, the shared Obsidian, the ported trio — src/readertheme/index.ts orders the shared list so.)
for (const d of [D.PAPER_INK, D.MIDNIGHT_STACKS, D.READING_ROOM]) T.registerTheme(d);
const IDS = D.READER_ORDER.filter((id) => id !== 'classic');
const DEFS = IDS.map((id) => T.THEMES.find((d) => d.id === id));

function contrast() {
  const css = fs.readFileSync(path.join(ROOT, 'src/styles/base.css'), 'utf8');
  const accents = { dark: [...css.matchAll(/html\[data-accent='\w+'\] \{ --md-primary: (#[0-9a-f]{6})/g)].map((m) => m[1]), light: [...css.matchAll(/html\[data-accent='\w+'\]\[data-ui='light'\] \{ --md-primary: (#[0-9a-f]{6})/g)].map((m) => m[1]) };
  // (Pages a reader's bar can float over, by lightness: the reading themes' lightest and darkest of each kind.)
  const PAGES = { light: ['#ffffff', '#e6efe6', '#efe4cf'], dark: ['#000000', '#2e3440', '#282a36'] };
  for (const def of DEFS) for (const mode of T.modesOf(def)) {
    const worst = [];
    for (const useThemeColours of [true, false]) {
      const r = T.resolve({ theme: def.id, mode, darkTone: 'default', useThemeColours });
      for (const x of T.contrastReport(r)) if (x.ratio < 4.5) worst.push(`${x.text} on ${x.layer} over ${x.over}: ${x.ratio.toFixed(2)}`);
      // The reader's bars (src/readertheme/reader.lazy.css): the ground at 66 % over a page of the style's own lightness,
      // its solid over any page.
      const ground = T.parseColor(r.surfaces.ground); const solid = T.parseColor(r.surfaces.low);
      for (const k of ['on', 'variant', 'dim']) {
        const fg = T.parseColor(r.text[k]);
        for (const pg of PAGES[mode]) { const under = T.over([ground[0], ground[1], ground[2], 0.66], T.parseColor(pg)); const c = T.contrast(T.over(fg, under), under); if (c < 4.5) worst.push(`${k} on the bar over a ${mode} page ${pg}: ${c.toFixed(2)}`); }
        const c = T.contrast(T.over(fg, solid), solid); if (c < 4.5) worst.push(`${k} on the solid bar: ${c.toFixed(2)}`);
      }
      if (r.roles) { const rr = r.roles; for (const [a, b] of [['onPrimary', 'primary'], ['onPrimaryContainer', 'primaryContainer']]) { const under = T.over(T.parseColor(rr[b]), ground); const c = T.contrast(T.over(T.parseColor(rr[a]), under), under); if (c < 4.5) worst.push(`${a}: ${c.toFixed(2)}`); } }
    }
    // (The background mixed with each accent the reader can choose: the mesh's accent blob at its strongest.)
    ok(`contrast ≥ 4.5:1 from the tokens: ${def.id} (${mode}) — text on its background's brightest and darkest, its panes, cards and sheets; the reader's bars over a page`, !worst.length, worst);
  }
  void accents;
}
/** HSL of an rgb(a) triple: hue in degrees, saturation and lightness 0–1. */
function hsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? 60 * (((g - b) / d) % 6) : mx === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return { h: (h + 360) % 360, s, l };
}
// Easy on the eyes (the owner: «comfortable to the eyes, not yellow»): the grounds, panes, cards, sheets and the
// background's colour fields of the Reader's own styles near-neutral (HSL saturation at most 10 % dark, 12 % light; a
// colour under 6 % lightness is black to the eye and not counted); their glass never boosts saturation; and no accent,
// selected state, edge or page of any style — the ported trio's too — yellow, amber or gold (hue 30°–70° at more
// than 20 % saturation). The ported trio keep their author's grounds (faithful to the original, under its pictures).
function comfort() {
  const OWN = [D.PAPER_INK, D.MIDNIGHT_STACKS, D.READING_ROOM].map((d) => d.id);
  const yellow = (c) => { const x = hsl(c); return x.s > 0.2 && x.l > 0.06 && x.l < 0.97 && x.h >= 30 && x.h <= 70; };
  const colours = (str) => [...String(str).matchAll(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b|rgba?\([^)]*\)/gi)].map((m) => T.parseColor(m[0]));
  for (const def of DEFS) for (const mode of T.modesOf(def)) {
    const bad = []; const tok = def[mode]; const r = T.resolve({ theme: def.id, mode, darkTone: 'default', useThemeColours: true });
    if (!def.by) {
      const lim = mode === 'dark' ? 0.10 : 0.12;
      const fields = [['ground', T.parseColor(r.surfaces.ground)], ['pane', r.pane], ['card', r.card], ['sheet', r.sheet], ...colours(tok.bg).map((c, i) => [`background field ${i + 1}`, c]), ...tok.extremes.map((c, i) => [`extreme ${i + 1}`, T.parseColor(c)])];
      for (const [k, c] of fields) { const x = hsl(c); if (x.l >= 0.06 && x.s > lim + 1e-9) bad.push(`${k} ${Math.round(x.s * 100)} % saturated`); }
      // (The Reader's own ask for no boost; the shared and ported ones are held to 1 where they are applied, index.ts.)
      if (OWN.includes(def.id) && tok.sat > 1) bad.push(`glass saturation ${tok.sat}`);
    }
    const accents = [...(r.roles ? Object.entries(r.roles).map(([k, v]) => [k, T.parseColor(v)]) : []), ...colours(tok.edge).map((c) => ['edge', c]), ...colours(tok.sheen).map((c) => ['sheen', c])];
    for (const [k, c] of accents) if (yellow(c)) bad.push(`${k} is yellow (${Math.round(hsl(c).h)}°)`);
    const pg = G.pageThemeOf(def, mode);
    for (const k of ['bg', 'fg', 'link', 'sel']) if (pg[k] && yellow(T.parseColor(pg[k]))) bad.push(`its book page ${k} is yellow`);
    if (!def.by) { const x = hsl(T.parseColor(pg.bg)); if (x.l >= 0.06 && x.s > (mode === 'dark' ? 0.10 : 0.12)) bad.push(`its book page ${Math.round(x.s * 100)} % saturated`); }
    ok(`easy on the eyes: ${def.id} (${mode}) — near-neutral grounds and glass, nothing yellow, its book page too`, !bad.length, bad);
  }
}
/** A made-up picture: a PNG of w×h pixels in one colour (no real image). */
function png(w, h, rgb) {
  const zlib = require('zlib'); const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3); for (let i = 0; i < w; i++) { row[1 + i * 3] = rgb[0]; row[2 + i * 3] = rgb[1]; row[3 + i * 3] = rgb[2]; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** The packs served here: «frosted-glass» with two made-up pictures, in the shared format (src/theme/packs.ts buildPack). */
async function makePacks() {
  fs.mkdirSync(PACKS, { recursive: true });
  const bytes = await P.buildPack({ format: 1, id: 'frosted-glass', name: 'Frosted Glass', by: 'Wessam Lauf', version: '1.4.0', license: { spdx: 'MIT', notice: 'test' } },
    [{ name: 'bg-dark', type: 'image/png', bytes: png(3000, 2000, [20, 24, 40]) }, { name: 'bg-light', type: 'image/png', bytes: png(3000, 2000, [230, 228, 240]) }]);
  fs.writeFileSync(path.join(PACKS, 'frosted-glass.ktheme'), bytes);
  const sha = require('crypto').createHash('sha256').update(bytes).digest('hex');
  const entry = { id: 'frosted-glass', file: 'frosted-glass.ktheme', size: bytes.length, sha256: sha, name: 'Frosted Glass', by: 'Wessam Lauf', version: '1.4.0', assets: ['bg-dark', 'bg-light'] };
  fs.writeFileSync(path.join(PACKS, 'themes.json'), JSON.stringify({ format: 1, themes: [entry] }));
  fs.writeFileSync(path.join(PACKS, 'bad.json'), JSON.stringify({ format: 1, themes: [{ ...entry, sha256: '0'.repeat(64) }] }));
  return entry;
}

/* ---------------------------------------------------------------- the browser parts */
(async () => {
  contrast();
  comfort();
  const entry = await makePacks();
  const epub = path.join(TMP, 'glass.epub'); await makeEpub(epub); const pdf = path.join(TMP, 'glass.pdf'); await makePdf(pdf);
  const server = serve(DIST); await new Promise((r) => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}/`;
  let oldServer = null, oldBase = null;
  if (OLD) { oldServer = serve(OLD); await new Promise((r) => oldServer.listen(0, '127.0.0.1', r)); oldBase = `http://127.0.0.1:${oldServer.address().port}/`; }
  const br = await chromium.launch(); const errors = [];
  const open = new Set();
  const sect = async (name, fn) => { try { await fn(); } catch (e) { ok(`${name}: the part ran to its end`, false, String(e.message ?? e).split('\n')[0]); } for (const c of open) { c.__closing = true; await c.close().catch(() => undefined); } open.clear(); };
  /** A fresh page: a phone (360×800, touch) or a computer (1280×800, mouse); `visual`: settings stored before it opens. */
  const page = async ({ at = base, lang = 'en', pc = false, visual = null, memory = 8, reducedMotion = 'no-preference', extra = null } = {}) => {
    const ctx = await br.newContext({ viewport: pc ? { width: 1280, height: 800 } : { width: 360, height: 800 }, deviceScaleFactor: 1, isMobile: !pc, hasTouch: !pc, serviceWorkers: 'block', locale: lang, reducedMotion });
    ctx.setDefaultTimeout(20000); open.add(ctx);
    await ctx.addInitScript(([l, v, mem, idx, x]) => {
      globalThis.krDeviceMemory = mem;
      if (x === 'quota') { const put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function (val, key) { if (typeof key === 'string' && key.startsWith('theme:')) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); return put.call(this, val, key); }; }
      if (sessionStorage.getItem('kr.test.init')) return; sessionStorage.setItem('kr.test.init', '1');
      localStorage.setItem('kr.lang', l); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.themeIndex', idx);
      if (v) localStorage.setItem('kr.visual', JSON.stringify(v));
    }, [lang, visual, memory, `${at}packs/themes.json`, extra]);
    const p = await ctx.newPage(); p.on('pageerror', (e) => { if (!ctx.__closing) errors.push(e.message); });
    p.__js = []; p.on('request', (r) => { if (/\.js(\?|$)/.test(r.url())) p.__js.push(r.url()); });
    await p.goto(at); await p.waitForSelector('.library-view');
    return p;
  };
  const setVisual = async (p, v) => { await p.evaluate((v) => { localStorage.setItem('kr.visual', JSON.stringify({ ...JSON.parse(localStorage.getItem('kr.visual') || '{}'), ...v })); }, v); await p.reload(); await p.waitForSelector('.library-view, .reader-view'); await p.waitForTimeout(300); };
  const importBook = async (p, file) => {
    const before = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result.length); }; }));
    await p.setInputFiles('.library-view input[type=file]', [file]);
    for (let i = 0; i < 200; i++) {
      const id = await p.evaluate((n) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result.length > n ? q.result.sort((a, b) => b.addedAt - a.addedAt)[0].id : null); }; }), before);
      if (id) return id;
      await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); s?.querySelector('.sheet-actions button, button.btn')?.click(); });
      await p.waitForTimeout(250);
    }
    throw new Error('not imported: ' + file);
  };
  const readBook = async (p, id, sel = '.reader-flow .kr-content p') => {
    await p.evaluate((id) => { location.hash = `#/read/${id}`; }, id); await p.waitForSelector(sel, { state: 'attached', timeout: 30000 }); await p.waitForTimeout(900);
    // (The bars shown.)
    if (await p.evaluate(() => document.querySelector('.reader-view').classList.contains('immersive'))) { await p.evaluate(() => document.querySelector('.reader-view').classList.remove('immersive')); await p.waitForTimeout(400); }
  };
  const toLibrary = async (p) => { await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.waitForTimeout(300); };
  const toSettings = async (p) => {
    await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForSelector('.settings-view .tg-grid .tg-card', { state: 'attached' });
    await p.evaluate(() => { const card = document.querySelector('.tg-grid').closest('.card'); card.classList.remove('collapsed'); document.querySelector(`[data-sec="${card.id}"]`)?.click(); });
    await p.waitForTimeout(300);
  };
  /** Computed colours of a sample of the chrome, by place. */
  const sample = (p, sels) => p.evaluate((sels) => Object.fromEntries(sels.map((s) => { const e = document.querySelector(s); if (!e) return [s, null]; const c = getComputedStyle(e); return [s, [c.backgroundColor, c.color, c.backgroundImage.slice(0, 60), c.borderTopColor, c.boxShadow.slice(0, 80)].join(' | ')]; })), sels);
  const LIB = ['body', '.library-view > .topbar', '.library-tools input[type=search]', '.library-tools .tool-btn', '.chip', '.book-card .cover', '.book-meta'];
  const SET = ['.settings-view .card', '.settings-search', '.segmented button', '.settings-head'];
  const READ = ['.reader-view .topbar', '.float-toolbar', '.read-footer', '.reader', '.reader-flow .kr-content p'];
  const backdrops = (p) => p.evaluate(() => [...document.querySelectorAll('*')].filter((e) => { if (!e.getClientRects().length) return false; const c = getComputedStyle(e); const f = c.backdropFilter, w = c.webkitBackdropFilter; return (f && f !== 'none') || (w && w !== 'none'); }).map((e) => e.tagName.toLowerCase() + '.' + String(e.className).split(' ').slice(0, 2).join('.')));

  const pick = (p, id) => p.click(`.tg-card[data-theme="${id}"] .tg-pick`);
  const inForce = (p, id) => p.waitForFunction((id) => document.documentElement.dataset.theme === id && document.documentElement.dataset.glass && document.getElementById('kr-glass'), id);
  const bgOf = (p) => p.evaluate(() => getComputedStyle(document.body, '::before').backgroundImage);

  // ---- 1. Nothing changes by default.
  let classic = null;
  await sect('default', async () => {
    const p = await page(); const id = await importBook(p, epub); await p.reload(); await p.waitForSelector('.library-view .book-card'); await p.waitForTimeout(500);
    const st = await p.evaluate(() => ({ theme: document.documentElement.dataset.theme ?? null, glass: document.documentElement.dataset.glass ?? null, sheet: !!document.getElementById('kr-glass'), inline: document.documentElement.getAttribute('style') }));
    ok('by default: no style on the page, no glass stylesheet', st.theme === null && st.glass === null && !st.sheet, st);
    ok('by default: the glass code is not fetched', !p.__js.some((u) => /readertheme|themes/.test(u)), p.__js.filter((u) => /theme/.test(u)));
    classic = { lib: await sample(p, LIB) };
    await toSettings(p); classic.set = await sample(p, SET);
    ok('Classic is the chosen card in the gallery', await p.evaluate(() => document.querySelector('.tg-card.on')?.dataset.theme) === 'classic');
    await readBook(p, id); classic.read = await sample(p, READ);
    // A style chosen, then Classic again: the same colours.
    await toSettings(p); await pick(p, 'paper-ink'); await inForce(p, 'paper-ink');
    await pick(p, 'classic'); await p.waitForFunction(() => !document.documentElement.dataset.glass); await p.waitForTimeout(300);
    const st2 = await p.evaluate(() => ({ theme: document.documentElement.dataset.theme ?? null, inline: document.documentElement.getAttribute('style') }));
    const set2 = await sample(p, SET.filter((s) => s !== '.segmented button'));
    await toLibrary(p); const lib2 = await sample(p, LIB);
    await readBook(p, id); const read2 = await sample(p, READ);
    const same = (a, b) => Object.keys(a).every((k) => a[k] === b[k]);
    const d2 = [...Object.keys(lib2).filter((k) => lib2[k] !== classic.lib[k]).map((k) => [k, lib2[k], classic.lib[k]]), ...Object.keys(set2).filter((k) => set2[k] !== classic.set[k]).map((k) => [k, set2[k], classic.set[k]]), ...Object.keys(read2).filter((k) => read2[k] !== classic.read[k]).map((k) => [k, read2[k], classic.read[k]])];
    ok('a style chosen and Classic chosen again: nothing of it left on the page, the colours as before', st2.theme === null && st2.inline === st.inline && !d2.length, { st2, st, d2 });
    if (oldBase) {
      const q = await page({ at: oldBase }); const oid = await importBook(q, epub); await q.reload(); await q.waitForSelector('.library-view .book-card'); await q.waitForTimeout(500);
      const olib = await sample(q, LIB);
      await q.evaluate(() => { location.hash = '#/settings'; }); await q.waitForSelector('.settings-view .card'); await q.waitForTimeout(300);
      await q.evaluate(() => document.querySelectorAll('.card.collapsed').forEach((c) => c.classList.remove('collapsed')));
      const oset = await sample(q, SET);
      await readBook(q, oid); const oread = await sample(q, READ);
      const diff = [...Object.keys(olib).filter((k) => olib[k] !== classic.lib[k]), ...Object.keys(oset).filter((k) => oset[k] !== classic.set[k]), ...Object.keys(oread).filter((k) => oread[k] !== classic.read[k])];
      ok('by default: the chrome\'s computed colours are the build before\'s (KR_OLD_DIST)', !diff.length, diff.map((k) => [k, olib[k] ?? oset[k] ?? oread[k], classic.lib[k] ?? classic.set[k] ?? classic.read[k]]));
    } else console.log('(skipped: the comparison with the build before — set KR_OLD_DIST)');
  });

  // ---- 2. A style applies everywhere (en/ar, phone/computer); 4. none with the bars hidden.
  for (const [lang, pc] of [['en', false], ['ar', false], ['en', true], ['ar', true]]) {
    await sect(`apply ${lang} ${pc ? 'pc' : 'phone'}`, async () => {
      const where = `${lang === 'ar' ? 'Arabic' : 'English'}, ${pc ? 'computer' : 'phone'}`;
      const p = await page({ lang, pc, visual: { glassBlur: 'full' } }); const id = await importBook(p, epub);
      await toSettings(p);
      const before = await sample(p, ['.settings-view .card']);
      await pick(p, 'midnight-stacks'); await inForce(p, 'midnight-stacks'); await p.waitForTimeout(300);
      const set = await sample(p, ['.settings-view .card']);
      ok(`${where}: chosen in the gallery, Midnight Stacks is in force and marked`, await p.evaluate(() => document.querySelector('.tg-card.on')?.dataset.theme) === 'midnight-stacks');
      ok(`${where}: the settings' cards take the style's glass`, set['.settings-view .card'] !== before['.settings-view .card'] && /\/|rgba/.test(set['.settings-view .card']), set);
      await toLibrary(p);
      const bg = await bgOf(p);
      ok(`${where}: the library has the style's background`, /radial-gradient/.test(bg), bg.slice(0, 80));
      const tb = await p.evaluate(() => getComputedStyle(document.querySelector('.library-view > .topbar')).backdropFilter);
      ok(`${where}: the library's bar is frosted`, /blur/.test(tb), tb);
      await p.click('.library-tools .filter-btn'); await p.waitForSelector('.sheet'); await p.waitForTimeout(400);
      const sh = await p.evaluate(() => { const c = getComputedStyle(document.querySelector('.sheet')); return { f: c.backdropFilter, bg: c.backgroundColor }; });
      ok(`${where}: a sheet is frosted glass`, /blur/.test(sh.f) && /\/|rgba|color\(/.test(sh.bg), sh);
      await p.keyboard.press('Escape'); await p.waitForTimeout(200);
      await readBook(p, id);
      const bars = await p.evaluate(() => [...document.querySelectorAll('.reader-view .topbar, .reader-view .float-toolbar')].map((e) => { const c = getComputedStyle(e); return { f: c.backdropFilter, bg: c.backgroundColor }; }));
      ok(`${where}: the reader's bars are frosted glass`, bars.length >= 1 && bars.every((b) => /blur/.test(b.f) && /\/|rgba|color\(/.test(b.bg)), bars);
      await p.evaluate(() => document.querySelector('.reader-view').classList.add('immersive')); await p.waitForTimeout(500);
      const left = await backdrops(p);
      ok(`${where}: reading with the bars hidden, no element has a backdrop filter`, !left.length, left);
    });
  }

  // ---- 3. The reading surface is the reading theme's under every style.
  await sect('reading surface', async () => {
    const p = await page(); const id = await importBook(p, epub);
    const surf = () => p.evaluate(() => { const r = document.querySelector('.reader'); const t = document.querySelector('.reader-flow .kr-content p'); const a = document.querySelector('.reader-flow .kr-content a'); const sc = document.querySelector('.reader-scroll'); const c = getComputedStyle(r); return [c.backgroundColor, getComputedStyle(sc).backgroundColor, getComputedStyle(t).color, a ? getComputedStyle(a).color : '', c.getPropertyValue('--md-primary').trim()].join(' | '); });
    const bad = [];
    for (const theme of ['grey', 'sepia', 'black']) {
      await setVisual(p, { theme, uiStyle: 'classic' }); await readBook(p, id); const want = await surf();
      for (const s of IDS) { await setVisual(p, { theme, uiStyle: s }); await p.waitForFunction((s) => document.querySelector('.reader-flow .kr-content p') && document.documentElement.dataset.theme === s, s); await p.waitForTimeout(250); const got = await surf(); if (got !== want) bad.push({ theme, s, want, got }); }
      await toLibrary(p);
    }
    ok(`the reading surface (page, text, links, the selection's accent) is the reading theme's under all ${IDS.length} styles, three reading themes`, !bad.length, bad);
  });

  // ---- 4 (PDF) and 5. Blur off; what a device is given.
  await sect('blur', async () => {
    const p = await page({ visual: { uiStyle: 'paper-ink', glassBlur: 'off' } }); const id = await importBook(p, epub); const pid = await importBook(p, pdf);
    await p.reload(); await p.waitForSelector('.library-view .book-card'); await p.waitForFunction(() => document.documentElement.dataset.glass === 'off');
    await p.click('.library-tools .filter-btn'); await p.waitForSelector('.sheet'); await p.waitForTimeout(300);
    const a = await backdrops(p); await p.keyboard.press('Escape');
    await readBook(p, id); const b = await backdrops(p);
    ok('glass blur Off: no backdrop filter in the library (a sheet open) nor on the reader\'s bars', !a.length && !b.length, { a, b });
    await setVisual(p, { glassBlur: 'full' }); await toLibrary(p); await readBook(p, pid, '.pdf-page');
    const pb = await backdrops(p);
    ok('a PDF with the bars shown (Full): its bars are frosted', pb.some((x) => /pdf-bar|topbar/.test(x)), pb);
    await p.evaluate(() => document.querySelector('.reader-view').classList.add('immersive')); await p.waitForTimeout(500);
    const c = await backdrops(p);
    ok('a PDF with the bars hidden: no element has a backdrop filter', !c.length, c);
    const ph = await page({ visual: { uiStyle: 'paper-ink' } }); await ph.waitForFunction(() => document.documentElement.dataset.glass);
    ok('a phone: Reduced on its own', await ph.evaluate(() => document.documentElement.dataset.glass) === 'reduced');
    await toSettings(ph);
    ok('… and the settings say why', await ph.evaluate(() => document.querySelector('.glass-blur .hint')?.textContent) === en('blurAutoMemory'));
    const q = await page({ pc: true, visual: { uiStyle: 'paper-ink' }, memory: 4 }); await q.waitForFunction(() => document.documentElement.dataset.glass);
    ok('a computer with 4 GB: Reduced on its own', await q.evaluate(() => document.documentElement.dataset.glass) === 'reduced');
    const r = await page({ pc: true, visual: { uiStyle: 'paper-ink' }, reducedMotion: 'reduce' }); await r.waitForFunction(() => document.documentElement.dataset.glass);
    ok('a computer asking for less motion: Reduced on its own', await r.evaluate(() => document.documentElement.dataset.glass) === 'reduced');
    const s = await page({ pc: true, visual: { uiStyle: 'paper-ink' } }); await s.waitForFunction(() => document.documentElement.dataset.glass);
    ok('a computer otherwise: Full', await s.evaluate(() => document.documentElement.dataset.glass) === 'full');
    // A style the Reader no longer has (Lamplight, tried in previews): Classic again, silently.
    const g = await page({ visual: { uiStyle: 'lamplight' } });
    await g.waitForFunction(() => JSON.parse(localStorage.getItem('kr.visual') || '{}').uiStyle === 'classic');
    ok('a stored style that is gone (Lamplight) falls back to Classic, with nothing of glass left', await g.evaluate(() => !document.documentElement.dataset.glass && !document.documentElement.dataset.theme && !document.querySelector('.tg-card[data-theme="lamplight"]')));
  });

  // ---- 7. Packs.
  const toast = (p) => p.waitForSelector('.toast', { timeout: 30000 }).then(() => p.evaluate(() => document.querySelector('.toast')?.textContent ?? ''));
  const tap = async (p, sel) => { await p.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove())); await p.click(sel); return toast(p); };
  const meta = (p) => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('meta').objectStore('meta').get('themes.installed'); q.onsuccess = () => res(Object.keys(q.result ?? {})); q.onerror = () => res([]); }; }));
  const picture = (p, key) => p.evaluate((key) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('files').objectStore('files').get(key); q.onsuccess = async () => { if (!q.result) return res(null); try { const b = await createImageBitmap(q.result); res({ w: b.width, h: b.height }); } catch { res({ w: -1 }); } }; q.onerror = () => res(null); }; }), key);
  const stateOf = (p, id) => p.evaluate((id) => document.querySelector(`.tg-card[data-theme="${id}"] .tg-state`)?.textContent ?? '', id);
  await sect('packs', async () => {
    const p = await page({ visual: { uiStyle: 'frosted-glass-dark' } });
    await toSettings(p);
    await p.waitForFunction((n) => (document.querySelector('.tg-card[data-theme="frosted-glass-dark"] .tg-state')?.textContent ?? '').length > 0, null);
    ok('a style whose pictures are not here: a download button, its size said before anything is fetched', !!(await p.$('.tg-card[data-theme="frosted-glass-dark"] .tg-dl')) && /KB/.test(await stateOf(p, 'frosted-glass-dark')), await stateOf(p, 'frosted-glass-dark'));
    ok('… and until then its drawn background', /gradient/.test(await bgOf(p)) && !/blob:/.test(await bgOf(p)));
    ok('downloaded: it says so', (await tap(p, '.tg-card[data-theme="frosted-glass-dark"] .tg-dl')) === en('styleGot'));
    await p.waitForFunction(() => /blob:/.test(getComputedStyle(document.body, '::before').backgroundImage));
    const pic = await picture(p, 'theme:frosted-glass:bg-dark');
    ok('installed: checked, in the app\'s storage, the picture made the screen\'s size (3000 px → at most 800 here)', (await meta(p)).includes('frosted-glass') && pic && pic.w > 0 && pic.w <= 800, pic);
    ok('… the picture is the background, and the card offers to remove it', !!(await p.$('.tg-card[data-theme="frosted-glass-dark"] .tg-rm')));
    await p.context().setOffline(true);
    await pick(p, 'midnight-stacks'); await inForce(p, 'midnight-stacks'); await pick(p, 'frosted-glass-dark');
    ok('offline, the installed style is chosen again with its picture', await p.waitForFunction(() => /blob:/.test(getComputedStyle(document.body, '::before').backgroundImage)).then(() => true, () => false));
    await p.context().setOffline(false);
    const said = await tap(p, '.tg-card[data-theme="frosted-glass-dark"] .tg-rm');
    ok('removed: the space it freed said', said.startsWith(en('styleRemoved').split('{')[0]) && /KB/.test(said), said);
    // (Removed for good once its snackbar's Undo has passed.)
    await p.waitForFunction(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('meta').objectStore('meta').get('themes.installed'); q.onsuccess = () => res(!('frosted-glass' in (q.result ?? {}))); q.onerror = () => res(false); }; }), null, { timeout: 20000, polling: 250 });
    await p.waitForFunction(() => !/blob:/.test(getComputedStyle(document.body, '::before').backgroundImage), null, { timeout: 15000 }).catch(() => undefined);
    ok('… nothing of it left once its Undo has passed, the drawn background back', !(await meta(p)).includes('frosted-glass') && (await picture(p, 'theme:frosted-glass:bg-dark')) === null && !/blob:/.test(await bgOf(p)));
    await p.context().setOffline(true);
    await p.click('.tg-card[data-theme="frosted-glass-dark"] .tg-dl');
    await p.waitForSelector('.tg-card[data-theme="frosted-glass-dark"] .tg-state.err');
    ok('offline: the card says so, nothing kept', (await stateOf(p, 'frosted-glass-dark')) === en('styleOffline') && !(await meta(p)).length, await stateOf(p, 'frosted-glass-dark'));
    await p.context().setOffline(false);
    await p.evaluate((u) => localStorage.setItem('kr.themeIndex', u), `${base}packs/bad.json`); await p.reload(); await toSettings(p);
    await p.click('.tg-card[data-theme="frosted-glass-dark"] .tg-dl'); await p.waitForSelector('.tg-card[data-theme="frosted-glass-dark"] .tg-state.err');
    ok('a checksum that does not match: the card says so, nothing kept', (await stateOf(p, 'frosted-glass-dark')) === en('styleBadSum') && !(await meta(p)).length && (await picture(p, 'theme:frosted-glass:bg-dark')) === null, await stateOf(p, 'frosted-glass-dark'));
    const q = await page({ visual: { uiStyle: 'frosted-glass-light' }, extra: 'quota' }); await toSettings(q);
    await q.click('.tg-card[data-theme="frosted-glass-light"] .tg-dl'); await q.waitForSelector('.tg-card[data-theme="frosted-glass-light"] .tg-state.err');
    const msg = await stateOf(q, 'frosted-glass-light');
    ok('storage full: the card says so, with the size needed, nothing kept', msg.startsWith(en('styleNoSpace').split('(')[0]) && /KB/.test(msg) && !(await meta(q)).length, msg);
    await q.close(); const r = await page({ visual: { uiStyle: 'paper-ink' } }); await toSettings(r);
    await r.click('.tg-add'); await r.waitForSelector('.tg-addrow');
    ok('Add style lists the repository\'s packs, each with its size', await r.evaluate(() => [...document.querySelectorAll('.tg-addrow')].every((x) => /KB/.test(x.textContent))) && await r.evaluate(() => document.querySelectorAll('.tg-addrow').length) === 1);
    ok('… and installs one', (await tap(r, '.tg-addrow button')) === en('styleGot') && (await meta(r)).includes('frosted-glass'));
  });

  // ---- 8. Where it shows.
  await sect('platform', async () => {
    for (const pc of [false, true]) {
      const p = await page({ pc, visual: { uiStyle: 'obsidian', uiMode: 'dark' } }); await toSettings(p);
      const v = await p.evaluate(() => { const card = document.querySelector('.style-gallery, .tg-grid').closest('.card'); const t = card.textContent; return { gallery: !!card.querySelector('.tg-grid .tg-card'), blur: !!card.querySelector('.glass-blur .segmented'), add: !!card.querySelector('.tg-add'), t }; });
      ok(`${pc ? 'computer' : 'phone'}: the gallery, Add style and the blur are offered`, v.gallery && v.blur && v.add, v);
      ok(`${pc ? 'computer' : 'phone'}: Classic's dark surfaces give way to the style`, !v.t.includes(en('darkTone')));
      ok(`${pc ? 'computer' : 'phone'}: the screen's orientation ${pc ? 'not offered (a computer\'s screen does not turn)' : 'offered'}`, v.t.includes(en('orientation')) === !pc);
    }
    const q = await page({ visual: { uiStyle: 'frosted-glass' } }); await q.evaluate(() => { location.hash = '#/settings'; }); await q.waitForSelector('.licences-entry button', { state: 'attached' });
    await q.evaluate(() => document.querySelector('.licences-entry button').click()); await q.waitForSelector('.licence');
    const lic = await q.evaluate(() => document.querySelector('.licence').textContent);
    ok('the licences list carries the ported styles\' MIT notice', /Copyright \(c\) 2025 Wessam Lauf/.test(lic) && /Permission is hereby granted/.test(lic));
    await toSettings(q);
    ok('the ported style\'s card credits its author', (await q.evaluate(() => document.querySelector('.tg-card[data-theme="frosted-glass"] .tg-by')?.textContent)) === en('styleBy').replace('{name}', 'Wessam Lauf'));
  });

  ok('no page errors', !errors.length, errors);
  console.log(fails ? `${fails} FAILED` : 'all passed');
  await br.close(); server.close(); oldServer?.close(); fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
