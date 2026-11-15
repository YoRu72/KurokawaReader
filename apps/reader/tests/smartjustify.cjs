// node tests/smartjustify.cjs: text spacing (src/ui/smartjustify.ts, src/settings.ts align / hyphenate,
// src/styles/reader.css, src/formats/titles.ts) on an imitated phone (360×780, touch) at a large size:
//  1. the owner's case reproduced: «"If—that is, hypothetically speaking…"» in a narrow, indented column at 30 px — under
//     plain «Justified» its first line is stretched with gaps far wider than a word space (the river);
//  2. by default («Smart justify», book formatting on) no gap between words on the screen is wider than the word space
//     and 0.8 em: that paragraph set ragged, the ordinary ones still justified; after a size change, the same;
//  3. only the paragraphs near the screen are looked at (spaces measured ≪ the chapter's), the rest not at all;
//  4. «Book's own»: what the book justifies is justified (and bounded), what it sets at the start is at the start;
//     «Start» ragged; «Centred» centred (its last line too); hyphenation on and off; word spacing, letter spacing and
//     the first-line indent reach the text; a book without a language that reads as English is hyphenated as English
//     with an Arabic interface;
//  5. the controls in the Visual Options: alignment (five choices, not locked by book formatting) and hyphenation, each
//     undone and redone by the options' Undo / Redo;
//  6. an old profile (book formatting on, «Natural» stored) comes to «Smart justify» once.
// Screenshots (deviceScaleFactor 2) in KR_SHOTS when given: before (plain justify) and after (smart) of the case, the options.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const SHOTS = process.env.KR_SHOTS ? path.resolve(process.env.KR_SHOTS) : null;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 600))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-smartjustify-'));
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const CASE = '“If—that is, hypothetically speaking…” Mira began, and the extraordinarily uncomfortable silence of the lantern room returned at once.';
const WORDS = 'the keeper climbed stairs of old tower at dusk and lit lamp as his father had done before him boats came home across harbour while gulls cried over grey water a lantern swung in wind she remembered nothing except morning bells ringing twice beyond quiet streets where children slept under patched blankets merchants counted silver coins by candlelight'.split(' ');
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const sentence = () => { const n = 8 + Math.floor(rnd() * 14); const w = Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]); w[0] = w[0][0].toUpperCase() + w[0].slice(1); return w.join(' ') + (rnd() < 0.2 ? ', and then ' + WORDS[Math.floor(rnd() * WORDS.length)] + '.' : '.'); };
const prose = (k) => Array.from({ length: k }, sentence).join(' ');
async function makeEpub(file, { id, title, lang, css, xhtml }) {
  const JSZip = require(path.resolve(__dirname, '../node_modules/jszip')); const z = new JSZip();
  z.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  z.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  z.file('OEBPS/c1.xhtml', `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"${lang ? ` xml:lang="${lang}"` : ''}><head><title>t</title>${css ? '<link rel="stylesheet" type="text/css" href="s.css"/>' : ''}</head><body>${xhtml}</body></html>`);
  if (css) z.file('OEBPS/s.css', css);
  z.file('OEBPS/nav.xhtml', '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="c1.xhtml">One</a></li></ol></nav></body></html>');
  z.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">${id}</dc:identifier><dc:title>${title}</dc:title>${lang ? `<dc:language>${lang}</dc:language>` : ''}</metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>${css ? '<item id="s" href="s.css" media-type="text/css"/>' : ''}</manifest><spine><itemref idref="c1"/></spine></package>`);
  fs.writeFileSync(file, await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

const allBooks = (p) => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result); }; }));
async function importFile(p, file, re) {
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.waitForTimeout(500);
  await p.setInputFiles('.library-view input[type=file]', [file]);
  for (let i = 0; i < 200; i++) {
    const b = (await allBooks(p)).find((x) => new RegExp(re, 'i').test(x.title)); if (b) return b;
    await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); s?.querySelector('.sheet-actions button, button.btn')?.click(); });
    await p.waitForTimeout(250);
  }
  throw new Error('not imported ' + file);
}
async function openReader(p, id) {
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view');
  await p.evaluate((id) => { location.hash = `#/read/${id}`; }, id);
  await p.waitForSelector('.reader-flow .kr-content >> visible=true', { timeout: 60000 }); await p.waitForTimeout(1200);
}
const setVisual = (p, v) => p.evaluate((v) => { const cur = JSON.parse(localStorage.getItem('kr.visual') || '{}'); localStorage.setItem('kr.visual', JSON.stringify({ ...cur, ...v })); }, v);
/** Every paragraph near the screen: its widest gap between words on the screen, the widest allowed, its alignment. Measured
 *  here on its own (not with the app's code): each ordinary space's box, against the space of the paragraph's face. */
const gaps = (p, needle, near = 0) => p.evaluate(([needle, near]) => {
  const c = document.createElement('canvas').getContext('2d'); const rg = document.createRange();
  const out = [];
  for (const el of document.querySelectorAll('.reader-flow .kr-content p')) {
    const b = el.getBoundingClientRect(); if (b.bottom < -near * innerHeight || b.top > innerHeight * (1 + near) || !el.textContent.trim()) continue;
    if (needle && !el.textContent.includes(needle)) continue;
    const cs = getComputedStyle(el); const size = parseFloat(cs.fontSize);
    c.font = `${cs.fontStyle} ${cs.fontWeight} ${size}px ${cs.fontFamily}`;
    const space = c.measureText(' ').width + (parseFloat(cs.wordSpacing) || 0) + (parseFloat(cs.letterSpacing) || 0);
    let max = 0; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) for (let i = 1; i < n.data.length - 1; i++) {
      if (n.data[i] !== ' ' || /\s/.test(n.data[i - 1]) || /\s/.test(n.data[i + 1])) continue;
      rg.setStart(n, i); rg.setEnd(n, i + 1); max = Math.max(max, rg.getBoundingClientRect().width);
    }
    out.push({ text: el.textContent.slice(0, 24), max: Math.round(max * 10) / 10, limit: Math.round((space + 0.8 * size) * 10) / 10, space: Math.round(space * 10) / 10, size, align: cs.textAlign, rag: el.hasAttribute('data-kr-rag'), indent: cs.textIndent, hyphens: cs.hyphens, wordSpacing: cs.wordSpacing, letterSpacing: cs.letterSpacing, lang: el.closest('[lang]')?.getAttribute('lang') ?? '' });
  }
  return out;
}, [needle, near]);
const reloadLib = async (p) => { await p.evaluate(() => { location.hash = '#/'; }); await p.reload(); await p.waitForSelector('.library-view'); };
const toCase = (p) => p.evaluate((n) => { const el = [...document.querySelectorAll('.reader-flow .kr-content p')].find((x) => x.textContent.includes(n)); el?.scrollIntoView({ block: 'center' }); }, 'hypothetically');

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const en = path.join(TMP, 'case.epub'), bk = path.join(TMP, 'own.epub'), nolang = path.join(TMP, 'nolang.epub');
  const paras = Array.from({ length: 240 }, (_, i) => i === 6 ? `<p>${CASE}</p>` : `<p>[${i}] ${prose(3)}</p>`).join('');
  await makeEpub(en, { id: 'kr-sj-case', title: 'Lantern Room', lang: 'en', xhtml: '<h2>One</h2>' + paras });
  await makeEpub(bk, { id: 'kr-sj-own', title: 'Own Alignment', lang: 'en', css: 'p { text-align: justify; } p.left { text-align: left; }', xhtml: '<h2>Own</h2>' + Array.from({ length: 30 }, (_, i) => i === 3 ? `<p>${CASE}</p>` : i % 4 === 1 ? `<p class="left">[L${i}] ${prose(2)}</p>` : `<p>[J${i}] ${prose(3)}</p>`).join('') });
  await makeEpub(nolang, { id: 'kr-sj-nolang', title: 'No Language', lang: '', xhtml: '<h2>Plain</h2>' + Array.from({ length: 20 }, (_, i) => `<p>[N${i}] ${prose(3)}</p>`).join('') });

  const br = await chromium.launch(); const errors = [];
  const ctx = await br.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'en' });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(() => { window.__rangeRects = 0; const g = Range.prototype.getBoundingClientRect; Range.prototype.getBoundingClientRect = function () { window.__rangeRects++; return g.call(this); }; });
  await p.goto(base);
  await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.visual', JSON.stringify({ readingMode: 'continuous', bookPage: 'never', fontSize: 30, margin: 22 })); });
  await reloadLib(p);
  const book = await importFile(p, en, 'Lantern Room');

  // 6 (first, on a fresh profile): defaults.
  const fresh = await p.evaluate(() => JSON.parse(localStorage.getItem('kr.visual') || '{}'));
  ok('a fresh profile: «Smart justify» and hyphenation by default (book formatting on)', (fresh.align ?? 'smart') === 'smart', fresh.align);

  // 1. The river, under plain «Justified».
  await setVisual(p, { align: 'justify' }); await reloadLib(p);
  await openReader(p, book.id); await toCase(p); await p.waitForTimeout(500);
  const before = (await gaps(p, 'hypothetically'))[0];
  ok('the case reproduced: under plain «Justified» a gap is far wider than a word space and 0.8 em', !!before && before.align === 'justify' && before.max > before.limit && before.indent !== '0px', before);
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'spacing-before-justify.png') });

  // 2. «Smart justify».
  await setVisual(p, { align: 'smart' }); await reloadLib(p);
  await p.evaluate(() => { window.__rangeRects = 0; });
  await openReader(p, book.id); await toCase(p); await p.waitForTimeout(800);
  const after = await gaps(p);
  const theCase = after.find((x) => x.text.includes('If'));
  ok('smart justify: the case is set ragged, its widest gap bounded', !!theCase && theCase.rag && theCase.align === 'start' && theCase.max <= theCase.limit, theCase);
  ok('smart justify: no paragraph on the screen has a gap wider than a word space and 0.8 em', after.length >= 2 && after.every((x) => x.max <= x.limit + 0.5), after.filter((x) => x.max > x.limit + 0.5));
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'spacing-after-smart.png') });
  // 3. Only paragraphs near the screen measured.
  const measured = await p.evaluate(() => window.__rangeRects - 0);
  const total = await p.evaluate(() => [...document.querySelectorAll('.reader-flow .kr-content p')].reduce((a, e) => a + (e.textContent.match(/ /g) || []).length, 0));
  ok('only the paragraphs near the screen are measured (spaces measured ≪ the chapter\'s)', measured > 0 && measured < total / 3, { measured, total });
  // 5. The controls: alignment and hyphenation, with Undo / Redo.
  await p.keyboard.press('Control+Shift+v'); await p.waitForSelector('.panel.open .opt-history', { timeout: 10000 }).catch(() => {});
  let panel = await p.$('.panel.open .options-grid');
  if (!panel) { await p.evaluate(() => document.querySelector('.reader-flow')?.click()); await p.waitForTimeout(400); const b = await p.$('[data-act="options"], button[aria-label="Visual options"]'); if (b) await b.click(); await p.waitForSelector('.panel.open .options-grid', { timeout: 10000 }); panel = await p.$('.panel.open .options-grid'); }
  const seg = await p.evaluate(() => { const f = [...document.querySelectorAll('.panel.open .options-grid .field, .panel.open .options-grid .row')].find((x) => x.querySelector('.label')?.textContent.includes('Alignment')); if (!f) return null; f.scrollIntoView({ block: 'center' }); return [...f.querySelectorAll('.segmented button')].map((b) => ({ t: b.textContent, on: b.getAttribute('aria-pressed'), dis: b.disabled })); });
  ok('the alignment control: Book\'s own, Smart justify, Justified, Natural, Centred — Smart chosen, none locked under book formatting', !!seg && seg.length === 5 && seg[1].on === 'true' && seg.every((b) => !b.dis) && /Book/.test(seg[0].t) && /Smart/.test(seg[1].t), seg);
  if (SHOTS) { await p.evaluate(() => [...document.querySelectorAll('.panel.open .options-grid .field, .panel.open .options-grid .row')].find((x) => x.querySelector('.label')?.textContent.includes('Alignment')).scrollIntoView({ block: 'start' })); await p.waitForTimeout(300); await p.screenshot({ path: path.join(SHOTS, 'text-settings.png') }); }
  const clickSeg = (label) => p.evaluate((label) => { const f = [...document.querySelectorAll('.panel.open .options-grid .field, .panel.open .options-grid .row')].find((x) => x.querySelector('.label')?.textContent.includes('Alignment')); [...f.querySelectorAll('.segmented button')].find((b) => b.textContent === label).click(); }, label);
  const stored = () => p.evaluate(() => JSON.parse(localStorage.getItem('kr.visual')));
  await clickSeg('Natural'); await p.waitForTimeout(300);
  const s1 = await stored(); const ragged = (await gaps(p)).every((x) => x.align === 'start');
  await p.click('.panel.open .panel-head .opt-history [data-icon="undo"]'); await p.waitForTimeout(300);
  const s2 = await stored();
  await p.click('.panel.open .panel-head .opt-history [data-icon="redo"]'); await p.waitForTimeout(300);
  const s3 = await stored();
  ok('alignment «Natural»: the text at the start; Undo brings Smart back; Redo Natural again', s1.align === 'start' && ragged && s2.align === 'smart' && s3.align === 'start', [s1.align, ragged, s2.align, s3.align]);
  await p.click('.panel.open .panel-head .opt-history [data-icon="undo"]'); await p.waitForTimeout(300);
  const hy = await p.evaluate(() => { const f = [...document.querySelectorAll('.panel.open .options-grid label, .panel.open .options-grid .row')].find((x) => x.textContent.trim().startsWith('Hyphenation')); const c = f?.querySelector('input[type=checkbox]'); if (!c) return null; const was = c.checked; c.click(); return was; });
  const h1 = await stored(); const hyOff = (await gaps(p))[0]?.hyphens;
  await p.click('.panel.open .panel-head .opt-history [data-icon="undo"]'); await p.waitForTimeout(300);
  const h2 = await stored(); const hyOn = (await gaps(p))[0]?.hyphens;
  ok('hyphenation: on by default, turned off (hyphens manual), and back on with Undo (hyphens auto)', hy === true && h1.hyphenate === false && hyOff === 'manual' && h2.hyphenate === true && hyOn === 'auto', { hy, off: h1.hyphenate, hyOff, on: h2.hyphenate, hyOn });
  // A size change in the panel (30 → 19 px, the default size): judged again; most paragraphs justified there.
  for (let i = 0; i < 11; i++) await p.evaluate(() => { const f = [...document.querySelectorAll('.panel.open .options-grid .field')].find((x) => x.querySelector('.label')?.textContent.trim().startsWith('Font size')); f.querySelector('.stepper button[aria-label="−"]').click(); });
  await p.keyboard.press('Escape'); await p.waitForTimeout(400); await toCase(p); await p.waitForTimeout(800);
  const after2 = await gaps(p, null, 0.5);
  ok('after a size change (30 → 19 px) the gaps on the screen are still bounded', after2.length >= 4 && after2[0].size === 19 && after2.every((x) => x.max <= x.limit + 0.5), after2.filter((x) => x.max > x.limit + 0.5).concat(after2.slice(0, 1)));
  // (This browser does not hyphenate — Chromium on Linux has no dictionaries —: more paragraphs here have a river than on a
  // phone, which does.)
  ok('at 19 px the paragraphs without a river are still justified, those with one set ragged', after2.some((x) => !x.rag && x.align === 'justify') && after2.every((x) => x.rag === (x.align === 'start')), after2.map((x) => [x.align, x.rag, Math.round((x.max - x.space) / x.size * 100) / 100]));
  await p.click('.reader-flow', { position: { x: 180, y: 390 } }).catch(() => {});

  // 4. Spacing reaches the text; centred; Book's own.
  await setVisual(p, { align: 'center', wordSpacing: 0.1, letterSpacing: 0.02, indent: 1.5 }); await reloadLib(p);
  await openReader(p, book.id);
  const cen = (await gaps(p))[1];
  ok('centred; word spacing, letter spacing and the first-line indent reach the text', !!cen && cen.align === 'center' && Math.abs(parseFloat(cen.wordSpacing) - 0.1 * cen.size) < 0.2 && Math.abs(parseFloat(cen.letterSpacing) - 0.02 * cen.size) < 0.1 && Math.abs(parseFloat(cen.indent) - 1.5 * cen.size) < 1, cen);
  await setVisual(p, { align: 'book', wordSpacing: 0, letterSpacing: 0, indent: 0 }); await reloadLib(p);
  const own = await importFile(p, bk, 'Own Alignment'); await openReader(p, own.id); await toCase(p); await p.waitForTimeout(800);
  const o = await gaps(p);
  const oCase = o.find((x) => x.text.includes('If')), oJ = o.filter((x) => x.text.startsWith('[J')), oL = o.filter((x) => x.text.startsWith('[L'));
  ok('«Book\'s own»: what the book justifies justified (the case set ragged, bounded), what it sets left at the start', !!oCase && oCase.rag && oCase.max <= oCase.limit && oJ.some((x) => x.align === 'justify') && oL.length > 0 && oL.every((x) => x.align === 'start'), { oCase, oJ: oJ.map((x) => x.align), oL: oL.map((x) => x.align) });

  // A book with no language that reads as English, with an Arabic interface: hyphenated as English.
  await p.evaluate(() => localStorage.setItem('kr.lang', 'ar')); await setVisual(p, { align: 'smart' }); await reloadLib(p);
  const nl = await importFile(p, nolang, 'No Language'); await openReader(p, nl.id);
  const n0 = (await gaps(p))[1];
  ok('a book without a language that reads as English, Arabic interface: lang «en», hyphens auto', !!n0 && n0.lang === 'en' && n0.hyphens === 'auto', n0);
  await p.evaluate(() => localStorage.setItem('kr.lang', 'en'));

  // 6. An old profile: book formatting on, «Natural» stored → Smart justify, once.
  await p.evaluate(() => { localStorage.removeItem('kr.alignMigrated'); localStorage.setItem('kr.visual', JSON.stringify({ ...JSON.parse(localStorage.getItem('kr.visual')), align: 'start', bookFormat: true })); });
  await reloadLib(p);
  const m1 = await stored();
  await p.evaluate(() => { localStorage.setItem('kr.visual', JSON.stringify({ ...JSON.parse(localStorage.getItem('kr.visual')), align: 'start' })); }); await reloadLib(p);
  const m2 = await stored();
  ok('an old profile (book formatting on, «Natural» stored) comes to Smart justify once; chosen again, Natural stays', m1.align === 'smart' && m2.align === 'start', [m1.align, m2.align]);

  ok('no page errors', errors.length === 0, errors);
  await br.close(); server.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
