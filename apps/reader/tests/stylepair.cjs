// node tests/stylepair.cjs: the interface and the book page as a pair (src/readertheme/field.ts pairField,
// src/readertheme/pagetheme.ts):
//  1. every style's page theme, dark and light (the reader's own styles included): body text at 7:1 or more on its
//     page, links at 4.5:1 or more;
//  2. separate by default: a style chosen leaves the reading theme as it was;
//  3. «Use for the book page too»: the reading theme becomes the style's page — that and only that (no other setting
//     moves, the style stays) —, written once: one step, undone from its snackbar and redone from the options' bar;
//  4. «Keep the book page matched»: on, the page follows a style chosen, in the same single write — one step of Undo,
//     the gallery drawn again as it is —; off, it stays;
//  5. a book with its own reading theme keeps it; the night theme still wins in its hours (a fixed clock);
//  6. «Keep the interface matched to the page» is the interface's «Follow the page»;
//  in English on a phone and in Arabic on a computer. Only loopback and made-up data.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const ROOT = path.resolve(__dirname, '..');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.join(ROOT, 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 500))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-pair-'));

// The derivation and the styles, from their sources.
const esbuild = require(path.join(ROOT, 'node_modules/esbuild'));
const mod = (() => { const out = esbuild.buildSync({ stdin: { contents: "import * as T from './src/theme/themes'; import * as G from './src/readertheme/pagetheme'; import * as D from './src/readertheme/defs'; import * as C from './src/theme/custom'; module.exports = { T, G, D, C };", resolveDir: ROOT, loader: 'ts' }, bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent' }); const m = { exports: {} }; new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require); return m.exports; })();
const { T, G, D, C } = mod;

async function makeEpub(file) {
  const JSZip = require(path.join(ROOT, 'node_modules/jszip')); const z = new JSZip();
  z.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  z.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  z.file('OEBPS/c1.xhtml', `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head><body><h1>One</h1>${'<p>The river ran past the old city, and the people read their books.</p>'.repeat(30)}</body></html>`);
  z.file('OEBPS/nav.xhtml', '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Nav</title></head><body><nav epub:type="toc"><ol><li><a href="c1.xhtml">One</a></li></ol></nav></body></html>');
  z.file('OEBPS/content.opf', '<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">pair-1</dc:identifier><dc:title>Pair Test</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>');
  fs.writeFileSync(file, await z.generateAsync({ type: 'nodebuffer' }));
}

(async () => {
  // ---- 1. Contrast of every page theme.
  for (const d of [D.PAPER_INK, D.MIDNIGHT_STACKS, D.READING_ROOM]) T.registerTheme(d);
  const my = C.toDef(C.fromBase(T.themeById('midnight-stacks'), 'default', 'Mine'));
  const defs = [...D.READER_ORDER.map((id) => T.THEMES.find((d) => d.id === id)), my];
  const low = [];
  for (const d of defs) for (const m of (d.classic ? ['dark', 'light'] : T.modesOf(d))) {
    const p = G.pageThemeOf(d, m); const bg = T.parseColor(p.bg);
    const body = T.contrast(T.parseColor(p.fg), bg), link = T.contrast(T.parseColor(p.link), bg);
    if (body < 7 || link < 4.5) low.push({ id: d.id, m, body: body.toFixed(2), link: link.toFixed(2) });
  }
  ok(`every style's page theme (${defs.length} styles, a style of one's own among them), dark and light: body text ≥ 7:1, links ≥ 4.5:1`, !low.length, low);

  // ---- In the app.
  const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}/`;
  const epub = path.join(TMP, 'pair.epub'); await makeEpub(epub);
  const br = await chromium.launch(); const errors = [];
  const PAGE_KEYS = ['myThemes', 'theme', 'myTheme', 'customBg', 'customFg', 'linkOverride', 'selOverride', 'fgOverride', 'bgOverride'];
  for (const [lang, pc] of [['en', false], ['ar', true]]) {
    const tag = `(${lang}, ${pc ? 'computer' : 'phone'})`;
    const ctx = await br.newContext({ viewport: pc ? { width: 1280, height: 800 } : { width: 360, height: 800 }, isMobile: !pc, hasTouch: !pc, locale: lang, serviceWorkers: 'block' });
    ctx.setDefaultTimeout(20000);
    await ctx.addInitScript((l) => {
      if (location.protocol !== 'http:') return;
      // (Writes of the settings counted: one change, one write.)
      const set = Storage.prototype.setItem; window.__writes = 0; Storage.prototype.setItem = function (k, v) { if (k === 'kr.visual') window.__writes++; return set.call(this, k, v); };
      if (sessionStorage.getItem('kr.t')) return; sessionStorage.setItem('kr.t', '1');
      localStorage.setItem('kr.lang', l); localStorage.setItem('kr.update.lastCheck', String(Date.now()));
      localStorage.setItem('kr.visual', JSON.stringify({ uiMode: 'dark' }));
    }, lang);
    const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(base); await p.waitForSelector('.library-view');
    // A book of its own reading theme.
    await p.setInputFiles('.library-view input[type=file]', [epub]);
    let id = null; for (let i = 0; i < 200 && !id; i++) { id = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result[0]?.id ?? null); }; })); if (!id) await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); s?.querySelector('.sheet-actions button, button.btn')?.click(); }); if (!id) await p.waitForTimeout(250); }
    const vis = () => p.evaluate(() => JSON.parse(localStorage.getItem('kr.visual') || '{}'));
    const settings = async () => {
      await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForSelector('.style-pair', { state: 'attached' });
      await p.evaluate(() => { const card = document.querySelector('.style-pair').closest('.card'); card.classList.remove('collapsed'); document.querySelector(`[data-sec="${card.id}"]`)?.click(); });
      await p.waitForSelector('.style-pair .tg-card[data-theme="paper-ink"] .tg-pick');
    };
    const pick = async (sid) => { await p.click(`.tg-card[data-theme="${sid}"] .tg-pick`); await p.waitForFunction((sid) => document.documentElement.dataset.theme === sid, sid); await p.waitForSelector('.style-pair'); };
    const flip = async (cls) => { await p.evaluate((cls) => document.querySelector(`.style-pair input.${cls}`).click(), cls); await p.waitForSelector('.style-pair'); };
    const readerTheme = async () => { await p.evaluate((id) => { location.hash = `#/read/${id}`; }, id); await p.waitForSelector('.reader-flow .kr-content p'); const r = await p.evaluate(() => { const e = document.querySelector('.reader'); return { theme: e.dataset.theme, bg: getComputedStyle(e).backgroundColor }; }); await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); return r; };

    await settings();
    ok(`the pair is shown: the interface and the book page side by side, the reading-theme choice beside the styles ${tag}`, await p.evaluate(() => !!document.querySelector('.style-pair .pair-preview .tg-mini') && !!document.querySelector('.style-pair .pair-page-mini') && !!document.querySelector('.pair-page .theme-swatches button') && !!document.querySelector('.pair-app .tg-grid')));
    // 2. Separate by default.
    await pick('reading-room');
    let v = await vis();
    ok(`separate by default: a style chosen, the reading theme as it was ${tag}`, v.uiStyle === 'reading-room' && v.pageFollowsStyle !== true && (v.theme === undefined || v.theme === 'grey') && !v.myTheme, v);
    // 3. Use for the book page too.
    const before = await vis(); await p.evaluate(() => { window.__writes = 0; });
    await p.click('.pair-use'); await p.waitForSelector('.style-pair');
    v = await vis(); const writes = await p.evaluate(() => window.__writes);
    const moved = Object.keys({ ...before, ...v }).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(v[k]));
    const page = G.pageThemeOf(T.themeById('reading-room'), 'dark');
    ok(`«Use for the book page too»: the reading theme is the style's page, under its name, and nothing else moved ${tag}`, v.theme === 'custom' && v.myTheme === 'style-reading-room-dark' && v.customBg === page.bg && v.customFg === page.fg && v.uiStyle === 'reading-room' && moved.every((k) => PAGE_KEYS.includes(k)), { moved, v: { theme: v.theme, myTheme: v.myTheme } });
    ok(`… in one write (one step of Undo) ${tag}`, writes === 1, writes);
    ok(`… an ordinary theme of one's own, to adjust in Visual Options ${tag}`, (v.myThemes || []).some((m) => m.id === 'style-reading-room-dark' && m.bg === page.bg));
    // Its Undo (the snackbar) and Redo (the options' bar on this page): the one step back and again (src/ui/optionsundo.ts).
    const histBtn = (what) => p.evaluate((what) => document.querySelector(`.opt-history [data-icon="${what}"]`).click(), what);
    const mineNow = () => p.evaluate(() => JSON.parse(localStorage.getItem('kr.visual') || '{}').myTheme ?? null);
    await p.waitForSelector('.toast .toast-action'); await p.click('.toast .toast-action');
    await p.waitForFunction((m) => (JSON.parse(localStorage.getItem('kr.visual') || '{}').myTheme ?? null) === m, before.myTheme ?? null);
    v = await vis();
    ok(`… its Undo (the snackbar) puts the page back as it was, the style kept ${tag}`, v.theme === before.theme && v.uiStyle === 'reading-room' && !(v.myThemes || []).some((m) => m.id === 'style-reading-room-dark'), v);
    await histBtn('redo'); await p.waitForFunction(() => JSON.parse(localStorage.getItem('kr.visual') || '{}').myTheme === 'style-reading-room-dark');
    ok(`… Redo (the options' bar) does it again ${tag}`, (await mineNow()) === 'style-reading-room-dark' && (await vis()).theme === 'custom');
    const r1 = await readerTheme();
    ok(`… and the open book shows it ${tag}`, r1.theme === 'custom', r1);
    // 4. Linked.
    await settings(); await flip('pair-linked'); await pick('midnight-stacks');
    v = await vis();
    ok(`kept matched: a style chosen brings its page too ${tag}`, v.pageFollowsStyle === true && v.myTheme === 'style-midnight-stacks-dark' && v.uiStyle === 'midnight-stacks');
    await p.evaluate(() => { window.__writes = 0; }); await pick('paper-ink');
    ok(`… in one write ${tag}`, (await p.evaluate(() => window.__writes)) === 1 && (await vis()).myTheme?.startsWith('style-paper-ink-'));
    // Linked: the style and its page are one step — Undo takes both back, Redo brings both again; Settings drawn as they are.
    await histBtn('undo'); await p.waitForFunction(() => document.documentElement.dataset.theme === 'midnight-stacks');
    v = await vis();
    ok(`… one step: Undo takes the style and its page back together ${tag}`, v.uiStyle === 'midnight-stacks' && v.myTheme === 'style-midnight-stacks-dark' && !!(await p.$('.style-pair .tg-card.on[data-theme="midnight-stacks"]')), v);
    await histBtn('redo'); await p.waitForFunction(() => document.documentElement.dataset.theme === 'paper-ink');
    ok(`… and Redo both again ${tag}`, (await vis()).uiStyle === 'paper-ink' && (await mineNow())?.startsWith('style-paper-ink-'));
    await flip('pair-linked'); const keep = (await vis()).myTheme; await pick('reading-room');
    v = await vis();
    ok(`switched off: the page stays as it is when the style changes ${tag}`, v.pageFollowsStyle === false && v.myTheme === keep && v.uiStyle === 'reading-room');
    // 5. A book of its own theme; the night theme in its hours.
    await p.evaluate((id) => { localStorage.setItem('kr.bookVisual', JSON.stringify({ [id]: { theme: 'sepia' } })); }, id);
    await p.reload(); await settings(); await flip('pair-linked'); await pick('obsidian');
    const r2 = await readerTheme();
    ok(`a book with its own reading theme keeps it under the linked page ${tag}`, r2.theme === 'sepia', r2);
    await p.evaluate(() => localStorage.removeItem('kr.bookVisual'));
    await p.clock.setFixedTime(new Date('2026-03-01T23:00:00'));
    await p.evaluate(() => { const v = JSON.parse(localStorage.getItem('kr.visual')); localStorage.setItem('kr.visual', JSON.stringify({ ...v, nightSchedule: true, nightFrom: '22:00', nightTo: '06:00', nightTheme: 'black' })); });
    await p.reload(); await settings(); await pick('paper-ink');
    const r3 = await readerTheme();
    ok(`the night theme wins in its hours, the linked page or not ${tag}`, r3.theme === 'black', r3);
    // 6. The interface matched to the page.
    await settings(); const m0 = (await vis()).uiMode; await flip('pair-follow'); const m1 = (await vis()).uiMode;
    ok(`«Keep the interface matched to the page» is «Follow the page» ${tag}`, m0 !== 'page' && m1 === 'page');
    ok(`the pair's words are the interface language's ${tag}`, (await p.evaluate(() => document.querySelector('.pair-app h4').textContent)).includes(lang === 'ar' ? 'واجهةُ التطبيق' : 'App interface'));
    await ctx.close();
  }
  ok('no page errors', !errors.length, errors);
  console.log(fails ? `${fails} FAILED` : 'all passed');
  await br.close(); server.close(); fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
