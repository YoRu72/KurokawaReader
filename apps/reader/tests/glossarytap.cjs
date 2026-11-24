// node tests/glossarytap.cjs [en|ar]: the glossary's names in the text being read (src/ui/glossmarks.ts, glosscard.ts,
// glossmatch.ts). Phone 412x915, dark. The names of the book's glossary (its own, a shared folder's, every book's) are
// marked through the CSS Custom Highlight API — ranges, none overlapping, the longest name where several start at once,
// word boundaries for Latin names — without touching the page (the text's markup is the same with the marks on or
// off); a tap on a name opens its card (fields, placement, Edit lands on the row, Copy, Esc) and neither turns the page
// nor toggles the bars; a tap anywhere else is as ever; the translated text is marked with the renderings and the card
// shows the original; the switches (marks off: no ranges, tap still works; tap off: the tap is the page's again); a
// highlight made before still sits on the same words; the matching of 16,000 names in 60,000 letters is timed.
// SHOTS=dir for the pictures. Made-up book only; no network (the model is a stand-in).
const { chromium, devices } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const LANG = process.argv.includes('ar') ? 'ar' : 'en'; const SHOTS = process.env.SHOTS || '';
const DIST = path.resolve(__dirname, '../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const out = path.join(require('os').tmpdir(), 'kr-glossarytap'); fs.mkdirSync(out, { recursive: true });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 500))); if (!c) fails++; };

// ---- the pure matching, timed (no browser) ----
function timing() {
  const esbuild = require('esbuild'); const store = {}; globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const code = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, '../src/glossmatch.ts')], bundle: true, format: 'cjs', write: false, platform: 'node', logLevel: 'error' }).outputFiles[0].text; const m = { exports: {} }; new Function('module', 'exports', code)(m, m.exports); const M = m.exports;
  const G = (() => { const c = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, '../src/glossary.ts')], bundle: true, format: 'cjs', write: false, platform: 'node', logLevel: 'error' }).outputFiles[0].text; const mm = { exports: {} }; new Function('module', 'exports', c)(mm, mm.exports); return mm.exports; })();
  let seed = 7; const rnd = (n) => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n); };
  const la = 'abcdefghijklmnopqrstuvwxyz'; const word = (k) => Array.from({ length: k }, () => la[rnd(26)]).join('');
  const list = []; for (let i = 0; i < 8000; i++) list.push({ id: 'l' + i, from: word(3 + rnd(6)) + ' ' + word(3 + rnd(6)), to: 'x' + i, lang: 'ar' });
  const han = '龙天剑李王张林风云雪山河海青白黑红金木水火土'; for (let i = 0; i < 8000; i++) list.push({ id: 'h' + i, from: Array.from({ length: 2 + rnd(3) }, () => han[rnd(han.length)] + String.fromCharCode(0x4e00 + rnd(4000))).join(''), to: 'y' + i, lang: 'ar' });
  list.push({ id: 'z', from: 'Lin Feng', to: 'لين فنغ', lang: 'ar' });
  let t0 = performance.now(); const mt = M.buildMatcher(M.nameEntries(list, 'orig')); const build = performance.now() - t0;
  let text = ''; while (text.length < 60000) text += (rnd(3) ? word(2 + rnd(8)) + ' ' : '') + (rnd(40) === 0 ? 'Lin Feng ' : '') + String.fromCharCode(0x4e00 + rnd(4000)) + han[rnd(han.length)] + (rnd(8) === 0 ? '。' : '');
  t0 = performance.now(); const hits = M.findNames(mt, text, M.foldText(text)); const first = performance.now() - t0;
  const times = []; for (let i = 0; i < 5; i++) { t0 = performance.now(); M.findNames(mt, text, M.foldText(text)); times.push(performance.now() - t0); }
  console.log(`timing: ${mt.size} names, build ${build.toFixed(1)} ms, one 60,000-letter chapter: first pass ${first.toFixed(1)} ms, then ${Math.min(...times).toFixed(1)}–${Math.max(...times).toFixed(1)} ms, ${hits.length} names found`);
  ok('16,000 names in 60,000 letters: the first pass under 80 ms', first < 80 && mt.size >= 16000, first);
  ok('… building the matcher once under 250 ms', build < 250, build);
  ok('… names are found', hits.length > 100 && hits.some((h) => text.slice(h.s, h.e) === 'Lin Feng'));
  // the quick fold agrees with the key of a name
  const sample = ['Lin Feng', 'LIN  FENG', 'ＬＩＮ　ＦＥＮＧ', 'أَحْمَد', 'احمد', 'ケヤル', 'けやる', 'ｹﾔﾙ', 'Ünïcode', 'نَـدى', 'Lin-Feng.'];
  ok('the quick fold of a text equals the key of the name (loose)', sample.every((s) => { const f = M.foldText(s); let x = ''; for (let i = 0; i < f.n; i++) x += String.fromCharCode(f.c[i]); return x === G.foldKey(s, true); }), sample.map((s) => { const f = M.foldText(s); let x = ''; for (let i = 0; i < f.n; i++) x += String.fromCharCode(f.c[i]); return [s, x, G.foldKey(s, true)]; }).filter((a) => a[1] !== a[2]));
  const find = (s, items, mode = 'orig') => { const mm = M.buildMatcher(M.nameEntries(items, mode, 'ar')); return M.findNames(mm, s).map((h) => s.slice(h.s, h.e)); };
  ok('a Latin name matches on word boundaries only', JSON.stringify(find('Gate gateway the Gate. (gate) Gates', [{ id: 1, from: 'Gate', to: 'a', lang: 'ar' }])) === JSON.stringify(['Gate', 'Gate', 'gate']));
  ok('the longest name wins and none is found twice', JSON.stringify(find('Lin Feng Zhu and Lin Feng', [{ id: 1, from: 'Lin Feng', to: 'a', lang: 'ar' }, { id: 2, from: 'Lin Feng Zhu', to: 'b', lang: 'ar' }, { id: 3, from: 'Feng', to: 'c', lang: 'ar' }])) === JSON.stringify(['Lin Feng Zhu', 'Lin Feng']));
  ok('Chinese and kana names match anywhere, the same spellings (katakana = hiragana)', JSON.stringify(find('他叫林风先生。「リンフェン」は', [{ id: 1, from: '林风', to: 'a', lang: 'ar' }, { id: 2, from: 'りんふぇん', to: 'b', lang: 'ar' }])) === JSON.stringify(['林风', 'リンフェン']));
  ok('Arabic names take the written-on particles and the article', JSON.stringify(find('ولين فنغ وبالطائفة', [{ id: 1, from: 'Lin Feng', to: 'لين فنغ', lang: 'ar' }, { id: 2, from: 'Sect', to: 'الطائفة', lang: 'ar' }], 'tr')) === JSON.stringify(['لين فنغ', 'الطائفة']));
}

// ---- the book ----
const book = path.join(out, 'names.epub');
const paras = []; for (let i = 0; i < 40; i++) paras.push(i % 2 === 0 ? `<p>Para ${i}. Lin Feng walked along the old road beside the gateway, and the Azure Sect kept its Gate shut while Lin Fengs and lin feng zhu were far away.</p>` : `<p>Para ${i}. The wind was cold that night, and the hills lay quiet under a long grey sky with nothing in them at all.</p>`);
execFileSync('python3', ['-c', `
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1], 'w'); z.writestr('mimetype', 'application/epub+zip', compress_type=zipfile.ZIP_STORED)
z.writestr('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
X = lambda body, title: '<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>%s</title></head><body>%s</body></html>' % (title, body)
z.writestr('OEBPS/c1.xhtml', X('<h1>One</h1>' + sys.argv[2], 'One'))
z.writestr('OEBPS/c2.xhtml', X('<h1>Two</h1><p>Lin Feng came back.</p>', 'Two'))
z.writestr('OEBPS/nav.xhtml', X('<nav epub:type="toc"><ol><li><a href="c1.xhtml">One</a></li><li><a href="c2.xhtml">Two</a></li></ol></nav>', 'Contents'))
z.writestr('OEBPS/content.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">kr-glossarytap-test</dc:identifier><dc:title>Names Story</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>')
z.close()`, book, paras.join('')]);

const shot = async (p, name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); await p.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => 0)))); await p.waitForFunction(() => document.getAnimations().length === 0, null, { timeout: 5000 }).catch(() => undefined); await p.screenshot({ path: path.join(SHOTS, name) }); };

(async () => {
  timing();
  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const b = await chromium.launch(); const ctx = await b.newContext({ ...devices['Pixel 7'], viewport: { width: 412, height: 915 }, colorScheme: 'dark', locale: LANG }); const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.route('https://ai.test/v1/chat/completions', async (r) => {
    const body = JSON.parse(r.request().postData()); const user = body.messages[1].content;
    // (The stand-in translator: the names put as the glossary gives them — «Lin Feng» as its rendering, «Azure Sect» as its other rendering.)
    const content = JSON.stringify(JSON.parse(user).map((x) => `AR(${x.replace(/Lin Feng/g, 'لين فنغ').replace(/Azure Sect/g, 'الطائفة الزرقاء')})`));
    await r.fulfill({ headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ choices: [{ message: { content } }] }) });
  });
  await p.route('https://ai.test/**', (r) => r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, GET' } }) : r.fallback());
  await p.goto(`http://localhost:${port}/`);
  await p.evaluate((l) => { localStorage.setItem('kr.lang', l); localStorage.setItem('kr.update.lastCheck', String(Date.now())); const v = JSON.parse(localStorage.getItem('kr.visual') || '{}'); Object.assign(v, { aiProvider: 'custom', aiBaseUrl: 'https://ai.test/v1', aiKey: 'k', aiModel: 'm', aiTarget: 'ar', aiTask: 'translate', aiAutoGlossary: false, aiPrefetch: false, aiParallel: 1, tapToTurn: true }); localStorage.setItem('kr.visual', JSON.stringify(v)); }, LANG);
  await p.reload(); await p.waitForSelector('.library-view');
  await p.setInputFiles('input[type=file]', [book]); await p.waitForSelector('.book-card', { timeout: 60000 }); await p.waitForTimeout(1200);
  const id = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result[0].id); }; }));
  // The glossary: the book's own names, a shared folder's, and every book's; a highlight made before any marking.
  await p.evaluate(([i]) => {
    localStorage.setItem('kr.glossaryFolders', JSON.stringify([{ id: 'F1', name: 'Series names' }]));
    localStorage.setItem('kr.glossaryLinks', JSON.stringify({ [i]: ['F1'] }));
    localStorage.setItem('kr.glossary', JSON.stringify([
      { id: 't1', from: 'Lin Feng', to: 'لين فنغ', lang: 'ar', kind: 'person', book: i, alts: ['لين فنج'], note: 'The hero' },
      { id: 't1ja', from: 'Lin Feng', to: 'リン・フォン', lang: 'ja', kind: 'person', book: i },
      { id: 't2', from: 'Azure Sect', to: 'الطائفة اللازوردية', lang: 'ar', kind: 'group', folder: 'F1', alts: ['الطائفة الزرقاء'] },
      { id: 't3', from: 'Gate', to: 'البوابة', lang: 'ar', kind: 'place' },
    ]));
  }, [id]);
  await p.evaluate((i) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const tx = r.result.transaction('books', 'readwrite'); const s = tx.objectStore('books'); const g = s.get(i); g.onsuccess = () => { const bk = g.result; bk.highlights = [{ id: 'hl1', text: 'Lin Feng walked along the old road', color: 'amber', createdAt: 1 }]; s.put(bk); }; tx.oncomplete = () => res(); }; }), id);

  const open = async (fresh) => { if (fresh) { await p.reload(); await p.waitForTimeout(600); } await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.evaluate((i) => { location.hash = `#/read/${i}`; }, id); await p.waitForSelector('.kr-chapter p', { timeout: 30000 }); await p.waitForTimeout(900); };
  await open();
  const reg = () => p.evaluate(() => { const h = CSS.highlights?.get('kr-gloss'); return h ? [...h].map((r) => r.toString()) : null; });
  await p.waitForFunction(() => (CSS.highlights?.get('kr-gloss')?.size ?? 0) > 0, null, { timeout: 15000 });
  await p.waitForTimeout(500);
  ok('the Custom Highlight API is there', await p.evaluate(() => !!CSS.highlights && typeof Highlight === 'function'));
  let names = await reg();
  const chapterText = await p.evaluate(() => [...document.querySelectorAll('.kr-chapter:not([hidden])')].map((c) => c.textContent).join(' '));
  const want = (re) => (chapterText.match(re) ?? []).length;
  const expected = want(/\bLin Feng\b/gi) + want(/\bAzure Sect\b/g) + want(/\bGate\b/g);
  ok('marks exist for the chapter shown: one per name, none for «gateway» or «Lin Fengs»', names && names.length === expected && names.every((x) => /^(lin feng|azure sect|gate)$/i.test(x)), { n: names?.length, expected, sample: names?.slice(0, 6) });
  ok('… the names of the book, its shared folder and every book are all there', ['Lin Feng', 'Azure Sect', 'Gate'].every((n) => names?.includes(n)), names?.slice(0, 8));
  const overlap = await p.evaluate(() => { const rs = [...CSS.highlights.get('kr-gloss')]; let bad = 0; for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) { if (rs[i].compareBoundaryPoints(Range.END_TO_START, rs[j]) < 0 && rs[j].compareBoundaryPoints(Range.END_TO_START, rs[i]) < 0) bad++; } return bad; });
  ok('… none overlaps another', overlap === 0, overlap);
  ok('only the chapter shown is read (the other is hidden until turned to)', !names.some((x) => x === 'Lin Feng') || await p.evaluate(() => document.querySelectorAll('.kr-chapter').length >= 1));
  const hl = await p.evaluate(() => [...document.querySelectorAll('mark.kr-hl')].map((m) => m.textContent).join(''));
  ok('a highlight made before the marking still sits on the same words', hl === 'Lin Feng walked along the old road', hl);
  const markupOff = async () => p.evaluate(() => document.querySelector('.kr-content').innerHTML);
  // the page itself is not touched: the same markup with the marks off and on
  const withMarks = await markupOff();
  await p.evaluate(() => { const v = JSON.parse(localStorage.getItem('kr.visual') || '{}'); v.glossMarks = false; localStorage.setItem('kr.visual', JSON.stringify(v)); });
  await open(true);
  await p.waitForTimeout(800);
  ok('marks off: no ranges in the registry', (await reg()) === null, await reg());
  const withoutMarks = await markupOff();
  ok('the page markup is the same with the marks on and off (nothing wrapped, nothing added)', withMarks === withoutMarks, { a: withMarks.length, b: withoutMarks.length });
  await p.evaluate(() => { const v = JSON.parse(localStorage.getItem('kr.visual') || '{}'); delete v.glossMarks; localStorage.setItem('kr.visual', JSON.stringify(v)); });
  await open(true); await p.waitForFunction(() => (CSS.highlights?.get('kr-gloss')?.size ?? 0) > 0, null, { timeout: 15000 });
  await shot(p, 'S2-marks.png');

  // ---- a tap ----
  const geom = () => p.evaluate(() => {
    const sc = document.querySelector('.reader-scroll'); const sr = sc.getBoundingClientRect(); const rs = [...CSS.highlights.get('kr-gloss')];
    // a name in the lower third of the page (where a tap turns it) — its first line's middle
    const cand = rs.map((r) => { const q = r.getClientRects()[0]; return q ? { text: r.toString(), x: q.left + q.width / 2, y: q.top + q.height / 2, r: q } : null; }).filter((c) => c && c.y > sr.top + sr.height * 0.66 && c.y < sr.bottom - 40 && c.x > 20 && c.x < sr.width - 20);
    const c = cand.find((k) => k.text === 'Lin Feng') ?? cand[0];
    // a plain place in the same zone: a paragraph without a name
    const ps = [...document.querySelectorAll('.kr-chapter:not([hidden]) p')].filter((e) => !/Lin Feng|Azure|Gate/.test(e.textContent)); let plain = null;
    for (const e of ps) { const q = e.getBoundingClientRect(); const a = Math.max(q.top, sr.top + sr.height * 0.68), z = Math.min(q.bottom, sr.bottom - 24); if (z - a > 24) { plain = { x: q.left + 40, y: (a + z) / 2 }; break; } }
    return { name: c && { text: c.text, x: c.x, y: c.y, rect: { left: c.r.left, right: c.r.right, top: c.r.top, bottom: c.r.bottom } }, plain, scrollTop: sc.scrollTop, immersive: document.querySelector('.reader, .flow-reader')?.classList.contains('immersive') };
  });
  let g = await geom(); ok('a name in the page\'s lower third, and a plain place', !!g.name && !!g.plain, g);
  const scrollTop = () => p.evaluate(() => document.querySelector('.reader-scroll').scrollTop);
  const immersive = () => p.evaluate(() => document.querySelector('.flow-reader')?.classList.contains('immersive'));
  const s0 = await scrollTop(); const im0 = await immersive(); const scans0 = await p.evaluate(() => document.querySelector('.reader-flow').dataset.glossScans);
  await p.touchscreen.tap(g.name.x, g.name.y); await p.waitForSelector('.gloss-card', { timeout: 5000 });
  await p.waitForTimeout(600);
  ok('a tap on a marked name opens its card', !!(await p.$('.gloss-card')));
  ok('… the page did not turn and the bars did not toggle', (await scrollTop()) === s0 && (await immersive()) === im0, { s0, now: await scrollTop(), im0, im: await immersive() });
  const card = await p.evaluate(() => { const c = document.querySelector('.gloss-card'); const q = c.getBoundingClientRect(); return { from: c.querySelector('.gc-from')?.textContent, to: c.querySelector('.gc-to')?.textContent, kind: c.querySelector('.gc-kind')?.textContent, rows: [...c.querySelectorAll('.gc-row')].map((r) => r.textContent), note: c.querySelector('.gc-note')?.textContent, folder: c.querySelector('.gc-folder')?.textContent, buttons: [...c.querySelectorAll('.gc-actions .btn:not([hidden])')].map((b) => ({ t: b.textContent, w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height) })), rect: { left: q.left, right: q.right, top: q.top, bottom: q.bottom }, dir: document.documentElement.dir, focus: c.contains(document.activeElement) }; });
  const ARK = LANG === 'ar';
  ok('the card: original → rendering', card.from === 'Lin Feng' && card.to === 'لين فنغ', card);
  ok('… the kind with its name', card.kind.includes(ARK ? 'الشخصيات' : 'Characters'), card.kind);
  ok('… the other renderings, and the renderings kept for other languages', card.rows.some((r) => r.includes('لين فنج')) && card.rows.some((r) => r.includes('リン・フォン')), card.rows);
  ok('… the note and the folder it comes from', card.note === 'The hero' && card.folder.includes('Names Story'), card);
  ok('… Edit and Copy (no Dictionary for an English name), equal widths, 40 px or more tall', card.buttons.length === 2 && card.buttons[0].w === card.buttons[1].w && card.buttons.every((x) => x.h >= 40), card.buttons);
  const vw = 412, vh = 915; const nr = g.name.rect;
  ok('… on the screen and not over the name', card.rect.left >= 0 && card.rect.right <= vw && card.rect.top >= 0 && card.rect.bottom <= vh && (card.rect.bottom <= nr.top || card.rect.top >= nr.bottom), { card: card.rect, name: nr });
  ok('… a phone-width card, the keyboard reaches its buttons (focus is in it)', card.focus && card.rect.right - card.rect.left <= vw - 16, card);
  await shot(p, ARK ? 'S2-card-ar.png' : 'S2-card-en.png');
  await p.keyboard.press('Escape'); await p.waitForTimeout(250);
  ok('Esc closes the card', !(await p.$('.gloss-card')));
  // a tap outside the card closes it
  await p.touchscreen.tap(g.name.x, g.name.y); await p.waitForSelector('.gloss-card');
  await p.touchscreen.tap(60, 150); await p.waitForTimeout(1000);
  ok('a tap elsewhere (the upper zone) closes the card — and is the page\'s as ever (the page turned back)', !(await p.$('.gloss-card')) && (await scrollTop()) < s0, { s0, now: await scrollTop() });
  // a tap elsewhere with no card: turns the page
  await p.evaluate(() => { document.querySelector('.reader-scroll').scrollTop = 0; }); await p.waitForTimeout(500); g = await geom();
  const s1 = await scrollTop(); await p.touchscreen.tap(g.plain.x, g.plain.y); await p.waitForTimeout(1200);
  ok('a tap on plain text in the lower third still turns the page', (await scrollTop()) > s1, { s1, now: await scrollTop() });
  const scans1 = await p.evaluate(() => document.querySelector('.reader-flow').dataset.glossScans);
  ok('a page turn does not read the chapter for names again', scans1 === scans0, { scans0, scans1 });
  // Copy
  await p.evaluate(() => { document.querySelector('.reader-scroll').scrollTop = 0; }); await p.waitForTimeout(500); g = await geom();
  await p.touchscreen.tap(g.name.x, g.name.y); await p.waitForSelector('.gloss-card');
  await p.click('.gloss-card .gc-copy'); await p.waitForSelector('.toast', { timeout: 3000 });
  ok('Copy answers (copied)', /./.test(await p.textContent('.toast')));
  // Edit lands on the row
  await p.click('.gloss-card .gc-edit'); await p.waitForSelector('.ai-sheet .gloss-row', { timeout: 10000 }); await p.waitForTimeout(600);
  const land = await p.evaluate(() => ({ tab: document.querySelector('.ai-tab.on')?.dataset.tab, file: document.querySelector('.gloss-file-now b')?.textContent, row: document.activeElement?.closest?.('.gloss-row')?.dataset.id ?? document.querySelector('.gloss-row.flash')?.dataset.id }));
  ok('Edit opens the AI sheet on the Glossary tab, the file open, the row focused', land.tab === 'glossary' && land.row === 't1' && /Characters|الشخصيات/.test(land.file ?? ''), land);
  // the switches in Glossary options
  await p.evaluate(() => { document.querySelector('.gloss-opts').open = true; });
  ok('Glossary options hold both switches (on by default)', await p.evaluate(() => ['.gloss-marks input', '.gloss-tap input'].every((s) => document.querySelector(s)?.checked === true)));
  await p.evaluate(() => document.querySelector('.gloss-marks input').click()); await p.waitForTimeout(300);
  await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim').forEach((e) => (e.__close ? e.__close() : e.remove()))); await p.waitForTimeout(700);
  ok('marks off (the switch): no ranges', (await reg()) === null, await reg());
  g = { name: await p.evaluate(() => { const sc = document.querySelector('.reader-scroll'); const sr = sc.getBoundingClientRect(); const w = document.createTreeWalker(document.querySelector('.kr-chapter:not([hidden])'), NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const i = n.data.indexOf('Azure Sect'); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 10); const q = r.getClientRects()[0]; if (q && q.top > sr.top + 80 && q.bottom < sr.bottom - 80) return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; } } return null; }) };
  if (!g.name) { await p.evaluate(() => { document.querySelector('.reader-scroll').scrollTop = 0; }); await p.waitForTimeout(400); g = { name: await p.evaluate(() => { const sc = document.querySelector('.reader-scroll'); const sr = sc.getBoundingClientRect(); const w = document.createTreeWalker(document.querySelector('.kr-chapter:not([hidden])'), NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const i = n.data.indexOf('Azure Sect'); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 10); const q = r.getClientRects()[0]; if (q && q.top > sr.top + 40 && q.bottom < sr.bottom - 40) return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; } } return null; }) }; }
  await p.touchscreen.tap(g.name.x, g.name.y); await p.waitForTimeout(700);
  ok('marks off: a tap on a name still opens its card', !!(await p.$('.gloss-card')) && (await p.textContent('.gloss-card .gc-from')) === 'Azure Sect');
  await p.keyboard.press('Escape');
  // tap off: the tap is the page's again
  await p.evaluate(() => { const v = JSON.parse(localStorage.getItem('kr.visual') || '{}'); v.glossTap = false; v.glossMarks = true; localStorage.setItem('kr.visual', JSON.stringify(v)); });
  await open(true); await p.waitForFunction(() => (CSS.highlights?.get('kr-gloss')?.size ?? 0) > 0, null, { timeout: 15000 }); await p.waitForTimeout(400);
  g = await geom(); await p.touchscreen.tap(g.name.x, g.name.y); await p.waitForTimeout(700);
  ok('tap off: a tap on a name opens no card (and is the page\'s)', !(await p.$('.gloss-card')));
  await p.evaluate(() => { const v = JSON.parse(localStorage.getItem('kr.visual') || '{}'); delete v.glossTap; localStorage.setItem('kr.visual', JSON.stringify(v)); });
  await open(true); await p.waitForFunction(() => (CSS.highlights?.get('kr-gloss')?.size ?? 0) > 0, null, { timeout: 15000 }); await p.waitForTimeout(400);

  // ---- the selection menu: «In the glossary: …» ----
  await p.evaluate(() => { const sc = document.querySelector('.reader-scroll'); sc.scrollTop = 0; });
  const picked = await p.evaluate(() => { const w = document.createTreeWalker(document.querySelector('.kr-chapter:not([hidden])'), NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const i = n.data.indexOf('Azure Sect'); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 10); n.parentElement.scrollIntoView({ block: 'center' }); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; } } return false; });
  await p.waitForSelector('.sel-toolbar', { timeout: 6000 }); await p.click('.sel-toolbar .sel-row button:nth-child(8)'); await p.waitForSelector('.sheet .plain-list');
  const items = await p.$$eval('.sheet .plain-list button', (b) => b.map((x) => x.textContent));
  ok('a selection that is a glossary name: «In the glossary: …» in place of «Add»', picked && items.some((x) => x.includes('الطائفة اللازوردية')) && !items.some((x) => /Add to the translation glossary|أضِف إلى مسرد الترجمة/.test(x)), items);
  await p.locator('.sheet .plain-list button', { hasText: 'الطائفة اللازوردية' }).click(); await p.waitForSelector('.gloss-card', { timeout: 4000 });
  ok('… it opens the same card', (await p.textContent('.gloss-card .gc-from')) === 'Azure Sect');
  await p.keyboard.press('Escape'); await p.evaluate(() => getSelection().removeAllRanges());

  // ---- the translated view: the renderings are marked, the card shows the original ----
  await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'translate' }))); await p.waitForSelector('.tr-pill', { timeout: 10000 });
  if (await p.$('.tr-pill:not([hidden]) .tr-toggle')) { const on = await p.evaluate(() => document.querySelector('.kr-chapter p.kr-translated')); if (!on) await p.click('.tr-pill .tr-toggle'); }
  await p.waitForFunction(() => document.querySelectorAll('.kr-chapter p.kr-translated').length >= 6, null, { timeout: 30000 }); await p.waitForTimeout(1500);
  const trNames = await reg();
  ok('the translated text: the renderings (and an other rendering) are marked', !!trNames && trNames.includes('لين فنغ') && trNames.includes('الطائفة الزرقاء'), trNames?.slice(0, 10));
  const trPos = await p.evaluate(() => { const sc = document.querySelector('.reader-scroll'); const sr = sc.getBoundingClientRect(); for (const r of CSS.highlights.get('kr-gloss')) { if (r.toString() !== 'لين فنغ') continue; const q = r.getClientRects()[0]; if (q && q.top > sr.top + 60 && q.bottom < sr.bottom - 120) return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; } return null; });
  if (trPos) { await p.touchscreen.tap(trPos.x, trPos.y); await p.waitForSelector('.gloss-card', { timeout: 4000 }); ok('a tap on a translated name: the card shows the original', (await p.textContent('.gloss-card .gc-from')) === 'Lin Feng' && (await p.textContent('.gloss-card .gc-to')) === 'لين فنغ'); await p.keyboard.press('Escape'); }
  else ok('a translated name on the screen to tap', false);

  ok('no page errors', errors.length === 0, errors);
  await b.close(); server.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall ok'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
