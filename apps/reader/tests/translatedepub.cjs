// node tests/translatedepub.cjs [en|ar]: «Save the translation as EPUB» (src/ui/trepubsheet.ts, src/translatedepub.ts) on a phone (412×915, dark),
// against a stand-in provider answered here — no real service is reached. A made-up 3-chapter book (a cover, a picture, a contents) has two
// chapters translated into Arabic through the real translate-ahead path; then the saved file is opened (unzipped here) and read:
//  · 0 saved: the action is there but off, with one line why;
//  · «Translation only»: mimetype first and stored, container.xml, the OPF (dc:language ar, the title and its brackets, the original title kept
//    as another title, rtl page direction), a spine of 3 with the untranslated chapter in the original (lang en, dir ltr), dir=rtl and lang=ar on
//    the translated content, the cover and the picture, the contents' 3 entries, the machine-translation note on the first page;
//  · «with the original beneath»: each translated paragraph followed by its original with its own lang and dir;
//  · «Leave them out»: a spine of 2; the glossary at the end: the last spine item lists the terms by kind;
//  · «Add it to my library»: a new book with the title rule, the source's series and volume, none of its highlights or saved translations;
//  · «Translate them first» closes the sheet and the whole book is translated.
// SHOTS=dir for the pictures.
const { chromium, devices } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const LANG = process.argv[2] === 'ar' ? 'ar' : 'en'; const SHOTS = process.env.SHOTS || ''; const AR = LANG === 'ar';
const DIST = path.resolve(__dirname, '../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const out = path.join(require('os').tmpdir(), 'kr-translatedepub-' + LANG); fs.mkdirSync(out, { recursive: true });
const JSZip = require(path.resolve(__dirname, '../node_modules/jszip'));
// The made-up book: three chapters (the first with a picture and the glossary's name), a cover, a contents.
const MAKE = `import zipfile, sys, base64
out = sys.argv[1]
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
z = zipfile.ZipFile(out, 'w'); z.writestr('mimetype', 'application/epub+zip', compress_type=zipfile.ZIP_STORED)
z.writestr('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
X = lambda body: '<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body>' + body + '</body></html>'
z.writestr('OEBPS/c1.xhtml', X('<h1>The Mist Gate</h1><p>Lin Feng stood before the old mist gate and said nothing for a long while.</p><p><img src="pic.png" alt="a gate"/></p><p>The gate hummed a low tune, and the tune drifted far into the night.</p>'))
z.writestr('OEBPS/c2.xhtml', X('<h1>The Hill Road</h1><p>Then he walked on, alone, along the road that climbs into the hills.</p><p>The wind carried the smell of rain across the empty fields.</p>'))
z.writestr('OEBPS/c3.xhtml', X('<h1>The Lantern Inn</h1><p>At dusk he reached a small inn where a single lantern burned by the door.</p><p>The innkeeper asked no questions and set a bowl of rice before him.</p>'))
z.writestr('OEBPS/pic.png', PNG); z.writestr('OEBPS/cover.png', PNG)
z.writestr('OEBPS/nav.xhtml', X('<nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc"><ol><li><a href="c1.xhtml">The Mist Gate</a></li><li><a href="c2.xhtml">The Hill Road</a></li><li><a href="c3.xhtml">The Lantern Inn</a></li></ol></nav>'))
z.writestr('OEBPS/content.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf"><dc:identifier id="id">kr-tre-1</dc:identifier><dc:title>Mist Gate Vol. 2</dc:title><dc:creator>A. Writer</dc:creator><dc:language>en</dc:language><meta name="cover" content="cover"/></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/><item id="c3" href="c3.xhtml" media-type="application/xhtml+xml"/><item id="pic" href="pic.png" media-type="image/png"/><item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/></spine></package>')
z.close()`;
const book = path.join(out, 'mist.epub'); execFileSync('python3', ['-c', MAKE, book]);
// The stand-in's Arabic for each paragraph (the key is the start of the English).
const AR_OF = [['The Mist Gate', 'بوابة الضباب'], ['Lin Feng stood', 'وقف لين فنغ أمام بوابة الضباب القديمة ولم ينطق بكلمة زمنًا طويلًا.'], ['The gate hummed', 'دندنت البوابة لحنًا خافتًا، وسار اللحن بعيدًا في الليل.'], ['The Hill Road', 'طريق التلال'], ['Then he walked', 'ثم مضى وحيدًا في الطريق الصاعد إلى التلال.'], ['The wind carried', 'حملت الريح رائحة المطر عبر الحقول الخالية.'], ['The Lantern Inn', 'نزل الفانوس'], ['At dusk', 'عند الغسق بلغ نزلًا صغيرًا يشتعل عند بابه فانوس وحيد.'], ['The innkeeper', 'لم يسأله صاحب النزل شيئًا ووضع أمامه وعاء أرز.']];
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const shot = async (p, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.evaluate(() => document.querySelectorAll('.toast').forEach((x) => x.remove())); await p.waitForFunction(() => document.getAnimations().length === 0, null, { timeout: 4000 }).catch(() => undefined); await p.waitForTimeout(300); await p.screenshot({ path: path.join(SHOTS, name) }); } };
const TITLE_AR = 'Mist Gate Vol. 2 (العربية)';
(async () => {
  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const b = await chromium.launch(); const ctx = await b.newContext({ ...devices['Pixel 7'], viewport: { width: 412, height: 915 }, colorScheme: 'dark', locale: LANG, acceptDownloads: true }); const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  let trReqs = 0;
  await p.route('https://ai.test/v1/chat/completions', async (r) => {
    const body = JSON.parse(r.request().postData()); const system = body.messages[0].content; const user = body.messages[1].content;
    const names = /translation glossary/.test(system); let content;
    if (names) content = '[]'; else { trReqs++; content = JSON.stringify(JSON.parse(user).map((x) => (AR_OF.find(([k]) => x.startsWith(k)) ?? [0, 'ترجمة'])[1])); }
    await r.fulfill({ headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ choices: [{ message: { content } }] }) });
  });
  await p.route('https://ai.test/**', (r) => r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, GET' } }) : r.fallback());
  await p.goto(`http://localhost:${port}/`);
  await p.evaluate((lang) => { localStorage.setItem('kr.lang', lang); localStorage.setItem('kr.update.lastCheck', String(Date.now())); const v = JSON.parse(localStorage.getItem('kr.visual') || '{}'); Object.assign(v, { aiProvider: 'custom', aiBaseUrl: 'https://ai.test/v1', aiKey: 'k', aiModel: 'm', aiTarget: 'ar', aiTask: 'translate', aiPrefetch: false, aiParallel: 1, aiGatherNames: 'never', aiAutoStart: false }); localStorage.setItem('kr.visual', JSON.stringify(v));
    // (A name in the glossary before anything is translated: the paragraphs holding it are kept under the key that includes it.)
    localStorage.setItem('kr.glossary', JSON.stringify([{ id: 'g1', from: 'Lin Feng', to: 'لين فنغ', lang: 'ar', kind: 'person' }])); }, LANG);
  await p.reload(); await p.waitForSelector('.library-view');
  await p.setInputFiles('input[type=file]', [book]); await p.waitForSelector('.book-card', { timeout: 60000 }); await p.waitForTimeout(1200);
  const idb = (fn, arg) => p.evaluate(({ fn, arg }) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const db = r.result; new Function('db', 'arg', 'res', fn)(db, arg, res); }; }), { fn, arg });
  const books = () => idb('const q = db.transaction("books").objectStore("books").getAll(); q.onsuccess = () => res(q.result);');
  const meta = (key) => idb('const q = db.transaction("meta").objectStore("meta").get(arg); q.onsuccess = () => res(q.result === undefined ? null : q.result);', key);
  const src = (await books()).find((x) => /Mist Gate/.test(x.title)); ok('the made-up book is in the library', !!src);
  // The source's series and volume, and a highlight (neither the highlight nor the saved translations may reach the copy).
  await idb('const s = db.transaction("books", "readwrite").objectStore("books"); const g = s.get(arg); g.onsuccess = () => { const b = g.result; b.series = { name: "Mist Gate", index: 2 }; b.highlights = [{ id: "h1", cfi: "x", text: "a made-up highlight", color: "yellow", createdAt: 1 }]; s.put(b); }; s.transaction.oncomplete = () => res(1);', src.id);
  const closeAll = () => p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim').forEach((e) => (e.__close ? e.__close() : e.remove())));
  const openBook = async () => { await p.evaluate((i) => { location.hash = '#/'; setTimeout(() => { location.hash = `#/read/${i}`; }, 150); }, src.id); await p.waitForSelector('.kr-chapter', { timeout: 30000 }); await p.waitForTimeout(1500); };
  const openSaved = async () => { await closeAll(); await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'glossary' }))); await p.waitForSelector('.ai-sheet .ai-tab', { timeout: 10000 }); await p.click('.ai-tab[data-tab="saved"]'); await p.waitForSelector('.ai-sheet .ai-saved-count', { timeout: 5000 }); await p.waitForTimeout(500); };
  await openBook();

  /* ---------- 0 saved: off, with one line why ---------- */
  await openSaved(); await p.waitForSelector('.ai-epub', { timeout: 5000 });
  const off = await p.evaluate(() => ({ dis: document.querySelector('.ai-epub').disabled, why: document.querySelector('.ai-epub-why')?.textContent ?? '', whyShown: !document.querySelector('.ai-epub-why')?.hidden }));
  ok('nothing saved: the action is off and one line says why', off.dis && off.whyShown && off.why.length > 10, off);

  /* ---------- two chapters translated (the real translate-ahead path) ---------- */
  await p.click('.ai-tab[data-tab="translation"]'); await p.waitForSelector('.tr-ahead .field', { timeout: 8000 });
  await p.evaluate(() => { const f = document.querySelectorAll('.tr-ahead .field')[2]; const [a, c] = f.querySelectorAll('input'); a.value = '1'; c.value = '2'; f.querySelector('button').click(); });
  await p.waitForFunction(() => document.querySelectorAll('.tr-job').length === 0 && true, null, { timeout: 5000 }).catch(() => undefined);
  const nkeys = async () => Object.keys((await meta(`tr:${src.id}`)) ?? {}).length;
  for (let i = 0; i < 60 && (await nkeys()) < 6; i++) await p.waitForTimeout(500);
  ok('two chapters (six paragraphs) are saved', (await nkeys()) === 6, await nkeys());

  const grab = async (opts) => {
    await openSaved(); await p.waitForSelector('.ai-epub:not([disabled])', { timeout: 8000 }); await p.click('.ai-epub');
    await p.waitForSelector('.tre-sheet .tre-form:not([hidden])', { timeout: 60000 }); await p.waitForTimeout(300);
    if (opts.shot) await shot(p, opts.shot);
    if (opts.contents) await p.click(`.tre-contents button[data-v="${opts.contents}"]`);
    if (opts.missing) await p.click(`.tre-missing-seg button[data-v="${opts.missing}"]`);
    if (opts.glossary) await p.click('.tre-gloss .switch');
    if (opts.library) await p.click('.tre-lib .switch');
    const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 90000 }), p.click('.tre-save')]);
    const file = path.join(out, `out-${Date.now()}.epub`); await dl.saveAs(file); await p.waitForSelector('.tre-sheet', { state: 'detached', timeout: 20000 }).catch(() => undefined);
    const buf = fs.readFileSync(file); const zip = await JSZip.loadAsync(buf);
    const text = async (n) => zip.file(n) ? zip.file(n).async('string') : null;
    const opf = await text('OEBPS/content.opf'); const spine = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map((m) => m[1]);
    const chs = []; for (const id of spine) { const m = new RegExp(`<item id="${id}" href="([^"]+)"`).exec(opf); chs.push(await text('OEBPS/' + m[1])); }
    return { buf, zip, opf, spine, chs, name: dl.suggestedFilename(), text };
  };
  const dom = (html) => p.evaluate((h) => { const d = new DOMParser().parseFromString(h, 'application/xhtml+xml'); const root = d.documentElement; return { rootLang: root.getAttribute('lang'), rootDir: root.getAttribute('dir'), bodyDir: d.body?.getAttribute('dir') ?? null, blocks: [...d.body.querySelectorAll('p, h1')].map((e) => ({ tag: e.tagName.toLowerCase(), dir: e.getAttribute('dir'), lang: e.getAttribute('lang'), cls: e.getAttribute('class'), text: e.textContent.trim(), kids: [...e.children].map((c) => ({ tag: c.tagName.toLowerCase(), cls: c.getAttribute('class'), dir: c.getAttribute('dir'), lang: c.getAttribute('lang'), text: c.textContent.trim() })) })), imgs: [...d.querySelectorAll('img')].map((i) => i.getAttribute('src')), parseError: !!d.querySelector('parsererror') }; }, html);

  /* ---------- «Translation only» ---------- */
  // the sheet itself, first look
  await openSaved(); await p.waitForSelector('.ai-epub:not([disabled])'); await p.click('.ai-epub'); await p.waitForSelector('.tre-sheet .tre-form:not([hidden])', { timeout: 60000 }); await p.waitForTimeout(300);
  const sheetInfo = await p.evaluate(() => { const s = document.querySelector('.tre-sheet'); const r = (e) => e.getBoundingClientRect(); const acts = [...s.querySelectorAll('.sheet-actions > button')];
    return { title: s.querySelector('.sheet-head h3').textContent, miss: s.querySelector('.tre-missing .label')?.textContent ?? '', seg: [...s.querySelectorAll('.tre-contents button')].map((x) => [x.dataset.v, x.getAttribute('aria-pressed'), Math.round(r(x).height), x.scrollWidth <= x.clientWidth + 1]), keep: [...s.querySelectorAll('.tre-missing-seg button')].map((x) => [x.dataset.v, x.getAttribute('aria-pressed')]),
      first: !!s.querySelector('.tre-first'), switches: [...s.querySelectorAll('.tr-opt')].map((x) => [x.classList.contains('tre-gloss') ? 'gloss' : 'lib', x.querySelector('input').checked, x.querySelector('input').type]), acts: acts.map((x) => [Math.round(r(x).width), Math.round(r(x).height)]), overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth, lang: s.querySelector('.tre-lang')?.textContent ?? null }; });
  console.log('sheet:', JSON.stringify(sheetInfo));
  ok('the sheet: titled, «Translation only» chosen first, the other offered', sheetInfo.title.length > 5 && sheetInfo.seg.length === 2 && sheetInfo.seg[0][0] === 'only' && sheetInfo.seg[0][1] === 'true' && sheetInfo.seg[1][1] === 'false' && sheetInfo.seg.every((x) => x[2] >= 40 && x[3]), sheetInfo);
  ok('one chapter not translated yet, said with its count; «Leave them in the original» is the default', /1/.test(sheetInfo.miss) && sheetInfo.keep.length === 2 && sheetInfo.keep[0][0] === 'original' && sheetInfo.keep[0][1] === 'true' && sheetInfo.first, sheetInfo);
  ok('two switches (glossary, library), both off; one language shown as a line', sheetInfo.switches.length === 2 && sheetInfo.switches.every((x) => x[1] === false && x[2] === 'checkbox') && !!sheetInfo.lang, sheetInfo);
  ok('Cancel and Save as wide as each other (or stacked at full width), targets at least 40 px, nothing off the page', sheetInfo.acts.length === 2 && sheetInfo.acts.every((x) => x[1] >= 40) && (Math.abs(sheetInfo.acts[0][0] - sheetInfo.acts[1][0]) <= 1) && !sheetInfo.overflowX, sheetInfo);
  await shot(p, `S3b-export-${LANG}.png`);
  await p.click('.tre-cancel'); await p.waitForSelector('.tre-sheet', { state: 'detached', timeout: 5000 }); ok('Cancel closes the sheet and saves nothing', true);

  const e1 = await grab({});
  ok('the file name is the title and the language code', e1.name === 'Mist Gate Vol. 2 - ar.epub', e1.name);
  const first = Buffer.from(e1.buf.subarray(0, 60)); ok('mimetype is the first entry, stored (not compressed)', first.readUInt16LE(8) === 0 && first.slice(30, 38).toString() === 'mimetype' && e1.buf.slice(38, 58).toString() === 'application/epub+zip');
  ok('META-INF/container.xml points at the package', /full-path="OEBPS\/content.opf"/.test(await e1.text('META-INF/container.xml')));
  ok('dc:language is ar; the page direction is right to left', /<dc:language>ar<\/dc:language>/.test(e1.opf) && /page-progression-direction="rtl"/.test(e1.opf));
  const titles = [...e1.opf.matchAll(/<dc:title>([^<]*)<\/dc:title>/g)].map((m) => m[1]);
  ok('the title is the shown title with the language\'s name in brackets; the original title is kept as another', titles[0] === TITLE_AR && titles.includes('Mist Gate Vol. 2') && /<dc:creator>A\. Writer<\/dc:creator>/.test(e1.opf), titles);
  ok('a spine of 3 chapters', e1.spine.length === 3 && e1.chs.every((c) => !!c), e1.spine);
  const d = await Promise.all(e1.chs.map(dom));
  ok('every chapter is well-formed XHTML', d.every((x) => !x.parseError));
  ok('the translated chapters: dir=rtl and lang=ar, their paragraphs in Arabic', d[0].rootDir === 'rtl' && d[0].rootLang === 'ar' && d[1].rootDir === 'rtl' && d[0].blocks.some((x) => x.dir === 'rtl' && x.lang === 'ar' && /وقف لين فنغ/.test(x.text)) && d[1].blocks.some((x) => /ثم مضى وحيدًا/.test(x.text)), d[0].blocks);
  ok('the untranslated chapter stays in the original (lang en, dir ltr, English text)', d[2].rootLang === 'en' && d[2].rootDir === 'ltr' && d[2].blocks.some((x) => /At dusk he reached/.test(x.text)) && !d[2].blocks.some((x) => /[؀-ۿ]/.test(x.text)), d[2]);
  ok('the first page carries the machine-translation note, in its own language and direction', d[0].blocks.some((x) => /kr-mt-note/.test(x.cls ?? '') && x.lang && x.dir), d[0].blocks[0]);
  ok('a heading translated keeps the original title beneath (the titles setting «both»)', d[0].blocks.some((x) => x.tag === 'h1' && /بوابة الضباب/.test(x.text) && x.kids.some((k) => /kr-tr-sub/.test(k.cls ?? '') && k.text === 'The Mist Gate' && k.lang === 'en')), d[0].blocks.find((x) => x.tag === 'h1'));
  const names = Object.keys(e1.zip.files);
  ok('the cover and the picture are carried over', names.some((n) => /^OEBPS\/cover\./.test(n)) && /properties="cover-image"/.test(e1.opf) && names.some((n) => /^OEBPS\/images\/img\d+\.png$/.test(n)) && d[0].imgs.length === 1 && /^images\//.test(d[0].imgs[0]), { names, imgs: d[0].imgs });
  const nav = await e1.text('OEBPS/nav.xhtml'); const navLabels = [...nav.matchAll(/<li><a href="[^"]+">([^<]*)<\/a><\/li>/g)].map((m) => m[1]);
  ok('the contents follow the original: 3 entries, the translated chapters\' titles in Arabic, the third as it was', navLabels.length === 3 && navLabels[0] === 'بوابة الضباب' && navLabels[1] === 'طريق التلال' && navLabels[2] === 'The Lantern Inn', navLabels);
  ok('no fonts embedded', !names.some((n) => /fonts\//.test(n)));
  ok('the original of a translated paragraph is not in «Translation only» (no ruby, no original text)', !/Lin Feng stood before/.test(e1.chs[0]));

  /* ---------- «Translation with the original beneath» ---------- */
  const e2 = await grab({ contents: 'both' }); const d2 = await dom(e2.chs[0]);
  const lines = d2.blocks.filter((x) => x.kids.some((k) => /kr-tr-line/.test(k.cls ?? '')) && x.kids.some((k) => /kr-tr-orig/.test(k.cls ?? '')));
  ok('each translated paragraph is followed by its original', lines.length >= 2 && lines.every((x) => x.kids.findIndex((k) => /kr-tr-line/.test(k.cls)) < x.kids.findIndex((k) => /kr-tr-orig/.test(k.cls))), d2.blocks);
  ok('the original carries its own language and direction (en, ltr); the translation its own (ar, rtl)', lines.every((x) => { const o = x.kids.find((k) => /kr-tr-orig/.test(k.cls)); const tr = x.kids.find((k) => /kr-tr-line/.test(k.cls)); return o.lang === 'en' && o.dir === 'ltr' && tr.lang === 'ar' && tr.dir === 'rtl'; }) && lines.some((x) => /Lin Feng stood before/.test(x.kids.find((k) => /kr-tr-orig/.test(k.cls)).text)), lines);

  /* ---------- «Leave them out» and the glossary at the end ---------- */
  const e3 = await grab({ missing: 'leave' }); ok('«Leave them out»: a spine of 2, the third chapter gone from the contents too', e3.spine.length === 2 && !/The Lantern Inn/.test(await e3.text('OEBPS/nav.xhtml')), e3.spine);
  const e4 = await grab({ glossary: true }); const last = e4.chs[e4.chs.length - 1]; const dg = await dom(last);
  ok('the glossary at the end: the last spine item lists the terms (original → rendering)', e4.spine.length === 4 && /Lin Feng/.test(last) && /لين فنغ/.test(last) && /→/.test(last) && dg.rootDir === 'rtl', last.slice(0, 400));

  /* ---------- «Add it to my library» ---------- */
  const before = (await books()).length; await grab({ library: true });
  let all = []; for (let i = 0; i < 40; i++) { all = await books(); if (all.length > before) break; await p.waitForTimeout(250); }
  const nb = all.find((x) => x.id !== src.id && /العربية/.test(x.title)); ok('a new book is in the library', all.length === before + 1 && !!nb, all.map((x) => x.title));
  ok('…titled by the rule, the original title kept as another, the same series and volume, in Arabic', nb && nb.title === TITLE_AR && (nb.titles ?? []).includes('Mist Gate Vol. 2') && nb.series && nb.series.name === 'Mist Gate' && nb.series.index === 2 && nb.language === 'ar', nb && { title: nb.title, titles: nb.titles, series: nb.series, language: nb.language });
  ok('…with nothing else copied: no highlights, no saved translations', nb && (nb.highlights ?? []).length === 0 && ((await meta(`tr:${nb.id}`)) === null || Object.keys(await meta(`tr:${nb.id}`)).length === 0));

  /* ---------- «Translate them first» ---------- */
  const t0 = trReqs; await openSaved(); await p.waitForSelector('.ai-epub:not([disabled])'); await p.click('.ai-epub'); await p.waitForSelector('.tre-sheet .tre-form:not([hidden])', { timeout: 60000 });
  await p.click('.tre-first'); await p.waitForSelector('.tre-sheet', { state: 'detached', timeout: 5000 }); ok('«Translate them first» closes the sheet', true);
  for (let i = 0; i < 60 && (await nkeys()) < 9; i++) await p.waitForTimeout(500);
  ok('…and the whole book is translated (the third chapter now saved)', (await nkeys()) === 9 && trReqs > t0, { keys: await nkeys(), reqs: trReqs - t0 });
  await openSaved(); await p.waitForSelector('.ai-epub:not([disabled])'); await p.click('.ai-epub'); await p.waitForSelector('.tre-sheet .tre-form:not([hidden])', { timeout: 60000 });
  ok('everything translated: no «not translated yet» row', !(await p.$('.tre-missing')));
  await p.click('.tre-cancel');

  ok('no page errors', errors.length === 0, errors.slice(0, 3));
  console.log(fails ? `${fails} FAILED` : 'all passed');
  await b.close(); server.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
