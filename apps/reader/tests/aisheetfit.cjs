// node tests/aisheetfit.cjs [en|ar]: the AI sheet fits a phone (src/ui/aisheet.ts, glossarysheet.ts, aisettings.ts; styles in
// src/styles/base.css). Widths 320, 360 and 412 (dark), two made-up books — one with a 60+ character Japanese title, one
// with a 90 letter Latin title without spaces — and a shared folder with a long name, on each of the three tabs
// (Translation, Glossary, Names found): the page, the sheet and its scrolling body never scroll sideways; nothing inside the
// sheet reaches past the sheet's edges (the tab row, which scrolls sideways on purpose, apart); the chosen tab is whole inside
// the tab row; the sheet keeps one height across the tabs; the model field is at least 120 px wide at 360; no tap target under
// 40 px. SHOTS=dir writes the 360×800 pictures (BEFORE=1 names the glossary one «…-before-…»). No network; the model is not asked.
const { chromium, devices } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const LANG = process.argv.includes('ar') ? 'ar' : 'en'; const SHOTS = process.env.SHOTS || ''; const BEFORE = !!process.env.BEFORE;
const DIST = path.resolve(__dirname, '../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const out = path.join(require('os').tmpdir(), 'kr-aisheetfit'); fs.mkdirSync(out, { recursive: true });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 700))); if (!c) fails++; };
const CJK = '突然住む家を失った憧れの女子達との秘密の同棲生活が始まったんだが？'.repeat(2); // 64 characters
const LATIN = 'Abcdefghij'.repeat(9); // 90 letters, no space
const FOLDER = '共に暮らす姉妹たちの長い長い名前の共有フォルダー、続きの巻に使うための名前'; // a shared folder with a long name
const MAKE = `import zipfile, sys
out, title, ident = sys.argv[1], sys.argv[2], sys.argv[3]
z = zipfile.ZipFile(out, 'w'); z.writestr('mimetype', 'application/epub+zip', compress_type=zipfile.ZIP_STORED)
z.writestr('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
X = lambda body: '<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body>' + body + '</body></html>'
z.writestr('OEBPS/c1.xhtml', X('<h1>One</h1><p>Lin Feng looked at the old gate of the Azure Sect for a long, long time before he spoke.</p><p>Then he walked on, alone, along the road into the hills.</p>'))
z.writestr('OEBPS/nav.xhtml', X('<nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc"><ol><li><a href="c1.xhtml">One</a></li></ol></nav>'))
z.writestr('OEBPS/content.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">' + ident + '</dc:identifier><dc:title>' + title + '</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>')
z.close()`;
const bookA = path.join(out, 'a.epub'), bookB = path.join(out, 'b.epub');
execFileSync('python3', ['-c', MAKE, bookA, CJK, 'kr-aisheetfit-a']); execFileSync('python3', ['-c', MAKE, bookB, LATIN, 'kr-aisheetfit-b']);

// What is measured inside the page, once the sheet is open on a tab.
const MEASURE = () => {
  const sh = document.querySelector('.ai-sheet'); if (!sh) return { err: 'no sheet' };
  const body = sh.querySelector('.sheet-body'); const row = sh.querySelector('.ai-tabs'); const sr = sh.getBoundingClientRect(); const bad = []; const small = [];
  for (const el of sh.querySelectorAll('*')) {
    if (el.closest('.ai-tabs')) continue; if (!el.getClientRects().length) continue; if (el.ownerSVGElement) continue;
    const r = el.getBoundingClientRect(); if (!r.width && !r.height) continue;
    if (r.right > sr.right + 0.5 || r.left < sr.left - 0.5) bad.push(`${el.tagName.toLowerCase()}.${String(el.className.baseVal ?? el.className).slice(0, 40)} ${Math.round(r.left)}..${Math.round(r.right)} «${(el.textContent || '').slice(0, 24)}»`);
    if (el.matches('button, a.btn, .chip, select, input:not([type=checkbox]):not([type=radio]), textarea, summary, .icon-btn, .dest-row') && !el.closest('[hidden]') && r.height < 39.5) small.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 30)} h${Math.round(r.height)} «${(el.textContent || el.value || '').slice(0, 20)}»`);
  }
  const doc = document.documentElement; const act = sh.querySelector('.sheet-actions');
  const before = body.scrollLeft; body.scrollLeft = 40; const pans = body.scrollLeft !== before; body.scrollLeft = before;
  const on = row.querySelector('.ai-tab[aria-selected=true]'); const rr = row.getBoundingClientRect(); const tr = on.getBoundingClientRect();
  const model = sh.querySelector('.ai-input-row input[type=text]');
  return {
    docW: doc.scrollWidth, docC: doc.clientWidth, shW: sh.scrollWidth, shC: sh.clientWidth, bodyW: body.scrollWidth, bodyC: body.clientWidth, pans,
    bad: bad.slice(0, 6), small: small.slice(0, 8), height: Math.round(sr.height), tabIn: tr.left >= rr.left - 0.5 && tr.right <= rr.right + 0.5, tabAt: [Math.round(tr.left), Math.round(tr.right), Math.round(rr.left), Math.round(rr.right)],
    rowW: row.scrollWidth, rowC: row.clientWidth, modelW: model && model.getClientRects().length ? Math.round(model.getBoundingClientRect().width) : 0, actW: act ? act.scrollWidth - act.clientWidth : 0,
  };
};

(async () => {
  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const b = await chromium.launch(); const ctx = await b.newContext({ ...devices['Pixel 7'], viewport: { width: 360, height: 800 }, deviceScaleFactor: 2, colorScheme: 'dark', locale: LANG }); const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`http://localhost:${port}/`);
  await p.evaluate((lang) => { localStorage.setItem('kr.lang', lang); localStorage.setItem('kr.update.lastCheck', String(Date.now())); const v = JSON.parse(localStorage.getItem('kr.visual') || '{}'); Object.assign(v, { aiProvider: 'gemini', aiKey: 'k'.repeat(18), aiModel: 'gemini-3.5-flash', aiTarget: 'ar', aiTask: 'translate', aiGatherNames: 'never' }); localStorage.setItem('kr.visual', JSON.stringify(v)); }, LANG);
  await p.reload(); await p.waitForSelector('.library-view');
  await p.setInputFiles('input[type=file]', [bookA, bookB]); await p.waitForFunction(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').count(); q.onsuccess = () => res(q.result >= 2); }; }), null, { timeout: 60000 }); await p.waitForTimeout(1000);
  const ids = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result.map((x) => ({ id: x.id, title: x.title }))); }; }));
  const idA = ids.find((x) => x.title === CJK)?.id, idB = ids.find((x) => x.title === LATIN)?.id; ok('two books with long titles in the library', !!idA && !!idB, ids);
  await p.evaluate(([a, bb, f]) => {
    localStorage.setItem('kr.glossaryFolders', JSON.stringify([{ id: 'F1', name: f }]));
    localStorage.setItem('kr.glossaryLinks', JSON.stringify({ [a]: ['F1'], [bb]: ['F1'] }));
    localStorage.setItem('kr.glossary', JSON.stringify([
      { id: 't1', from: 'Lin Feng', to: 'لين فنغ', lang: 'ar', kind: 'person', book: a }, { id: 't2', from: 'Azure Sect', to: 'الطائفة', lang: 'ar', kind: 'group', book: a },
      { id: 't3', from: 'Lin Feng', to: 'لين فنغ', lang: 'ar', kind: 'person', book: bb }, { id: 't4', from: 'Gate', to: 'البوابة', lang: 'ar', kind: 'place', folder: 'F1' }]));
  }, [idA, idB, FOLDER]);
  const settle = () => p.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => 0)))).then(() => p.waitForTimeout(250));
  const closeAll = () => p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim').forEach((e) => (e.__close ? e.__close() : e.remove())));
  const openBook = async (id) => { await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.evaluate((i) => { location.hash = `#/read/${i}`; }, id); await p.waitForSelector('.kr-chapter p', { timeout: 30000 }); await p.waitForTimeout(700); };
  const tabTo = async (k) => { await p.evaluate((x) => document.querySelector(`.ai-tab[data-tab="${x}"]`).click(), k); await p.waitForFunction((x) => { const el = document.querySelector(`.ai-panel[data-tab="${x}"]`); return el && !el.hidden && el.children.length > 0; }, k, { timeout: 8000 }); await p.waitForTimeout(450); };
  const names = { translation: 'translation', glossary: 'glossary', names: 'names' };
  for (const [bn, id] of [['CJK title', idA], ['Latin title', idB]]) {
    await openBook(id);
    for (const w of [320, 360, 412]) {
      await p.setViewportSize({ width: w, height: 800 }); await closeAll(); await p.waitForTimeout(200);
      await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'glossary' }))); await p.waitForSelector('.ai-sheet .ai-tab', { timeout: 8000 });
      const heights = [];
      for (const k of ['translation', 'glossary', 'names']) {
        await tabTo(k); await settle();
        const views = k === 'glossary' ? ['book', 'folder'] : ['-'];
        for (const v of views) {
          if (v === 'folder') { await p.evaluate(() => { const c = [...document.querySelectorAll('.gloss-places .chip')].find((x) => x.textContent.includes('📁')); c && c.click(); }); await p.waitForTimeout(300); }
          const m = await p.evaluate(MEASURE); const tag = `${LANG} ${bn} ${w}px ${k}${v === '-' ? '' : ' (' + v + ')'}`;
          if (m.err) { ok(tag + ': sheet open', false, m); continue; }
          ok(tag + ': page, sheet and body never scroll sideways', m.docW <= m.docC && m.shW <= m.shC && m.bodyW <= m.bodyC && !m.pans, m);
          ok(tag + ': nothing reaches past the sheet', m.bad.length === 0, m.bad);
          ok(tag + ': the chosen tab is whole inside the row', m.tabIn, m.tabAt);
          ok(tag + ': the buttons below do not overflow', m.actW <= 1, m.actW);
          ok(tag + ': no tap target under 40 px', m.small.length === 0, m.small);
          if (v !== 'folder') heights.push(m.height);
          if (k === 'translation' && w === 360) ok(tag + ': the model field is at least 120 px wide', m.modelW >= 120, m.modelW);
          if (SHOTS && w === 360 && id === idA && !(v === 'folder')) { fs.mkdirSync(SHOTS, { recursive: true }); if (k === 'glossary' || LANG === 'en') await p.screenshot({ path: path.join(SHOTS, `G1-${k}${BEFORE ? '-before' : ''}-${LANG}.png`) }); }
        }
        if (k === 'glossary') { await p.evaluate(() => { const c = document.querySelector('.gloss-places .chip'); c && c.click(); }); }
      }
      ok(`${LANG} ${bn} ${w}px: one sheet height across the tabs`, heights.length === 3 && new Set(heights).size === 1, heights);
    }
  }
  ok('no page errors', errors.length === 0, errors);
  await b.close(); server.close(); console.log(fails ? `\n${fails} FAILED` : '\nall ok'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
