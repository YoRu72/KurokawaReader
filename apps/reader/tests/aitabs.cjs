// node tests/aitabs.cjs [en|ar]: the AI sheet's tabs (src/ui/aisheet.ts) on a phone (412×915, dark) — Translation,
// Glossary, Names found, Saved translations switched without closing the sheet, each keeping its state; arrow keys;
// every way in lands on its tab; the book's glossary shown as a folder named after the book (renamed with it), its
// files only those that hold terms; names found filed by kind (an answer in the old form too); a former volume's
// glossary taken by itself (identical titles) with Undo, then offered (Change: share / copy / start empty); sharing
// stopped keeps a copy. Arabic: the tabs in right-to-left order, none clipped. SHOTS=dir for the pictures.
const { chromium, devices } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const LANG = process.argv[2] === 'ar' ? 'ar' : 'en'; const SHOTS = process.env.SHOTS || '';
const DIST = path.resolve(__dirname, '../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const out = path.join(require('os').tmpdir(), 'kr-aitabs'); fs.mkdirSync(out, { recursive: true });
// Two volumes of one series (made here: a chapter with a name in it).
const MAKE = `import zipfile, sys
out, title, ident = sys.argv[1], sys.argv[2], sys.argv[3]
z = zipfile.ZipFile(out, 'w'); z.writestr('mimetype', 'application/epub+zip', compress_type=zipfile.ZIP_STORED)
z.writestr('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
X = lambda body: '<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body>' + body + '</body></html>'
z.writestr('OEBPS/c1.xhtml', X('<h1>The Gate</h1><p>Lin Feng looked at the old gate of the Azure Sect for a long, long time before he spoke.</p><p>The gate sang its old song, and the song went on into the night while he waited.</p><p>Then he walked on, alone, along the road into the hills.</p>'))
z.writestr('OEBPS/nav.xhtml', X('<nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc"><ol><li><a href="c1.xhtml">The Gate</a></li></ol></nav>'))
z.writestr('OEBPS/content.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">' + ident + '</dc:identifier><dc:title>' + title + '</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>')
z.close()`;
const v1 = path.join(out, 'gate1.epub'), v2 = path.join(out, 'gate2.epub');
execFileSync('python3', ['-c', MAKE, v1, 'Gate Story Vol. 1', 'kr-aitabs-1']); execFileSync('python3', ['-c', MAKE, v2, 'Gate Story Vol. 2', 'kr-aitabs-2']);
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const shot = async (p, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, name) }); } };
(async () => {
  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const b = await chromium.launch(); const ctx = await b.newContext({ ...devices['Pixel 7'], viewport: { width: 412, height: 915 }, colorScheme: 'dark', locale: LANG }); const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  // The model: the names of a passage with their kinds; the second time in the old form (no kinds); translations.
  let finds = 0;
  await p.route('https://ai.test/v1/chat/completions', async (r) => {
    const body = JSON.parse(r.request().postData()); const system = body.messages[0].content; const user = body.messages[1].content; let content;
    if (/translation glossary/.test(system)) {
      finds++;
      content = finds === 1 ? JSON.stringify({ groups: [{ from: 'Azure Sect', to: 'الطائفة اللازوردية', kind: 'organization' }], citations: [{ from: 'The gate sang its old song', to: 'غنّت البوابة أغنيتها القديمة' }] })
        : JSON.stringify([{ from: 'Old Road', to: 'الطريق القديم' }]);
    } else { const items = JSON.parse(user); content = JSON.stringify(items.map((x) => `AR(${x})`)); }
    await r.fulfill({ headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ choices: [{ message: { content } }] }) });
  });
  await p.route('https://ai.test/**', (r) => r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, GET' } }) : r.fallback());
  await p.goto(`http://localhost:${port}/`);
  await p.evaluate((lang) => { localStorage.setItem('kr.lang', lang); localStorage.setItem('kr.update.lastCheck', String(Date.now())); const v = JSON.parse(localStorage.getItem('kr.visual') || '{}'); Object.assign(v, { aiProvider: 'custom', aiBaseUrl: 'https://ai.test/v1', aiKey: 'k', aiModel: 'm', aiTarget: 'ar', aiTask: 'translate', aiGatherNames: 'never' }); localStorage.setItem('kr.visual', JSON.stringify(v)); }, LANG);
  await p.reload(); await p.waitForSelector('.library-view');
  await p.setInputFiles('input[type=file]', [v1, v2]); await p.waitForSelector('.book-card', { timeout: 60000 }); await p.waitForFunction(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').count(); q.onsuccess = () => res(q.result >= 2); }; }), null, { timeout: 30000 }); await p.waitForTimeout(1000);
  const ids = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(Object.fromEntries(q.result.map((x) => [x.title, x.id]))); }; }));
  const id1 = ids['Gate Story Vol. 1'], id2 = ids['Gate Story Vol. 2']; ok('two volumes in the library', !!id1 && !!id2, ids);
  // Volume 1 has a glossary: a character and a skill.
  await p.evaluate((i) => localStorage.setItem('kr.glossary', JSON.stringify([{ id: 'g1', from: 'Lin Feng', to: 'لين فنغ', book: i, kind: 'person', lang: 'ar' }, { id: 'g2', from: 'Iron Palm', to: 'كفّ الحديد', book: i, kind: 'skill', lang: 'ar' }, { id: 'g3', from: 'Wen Yu', to: 'ون يو', book: i, kind: 'person', lang: 'ar' }])), id1);
  const store = () => p.evaluate(() => ({ t: JSON.parse(localStorage.getItem('kr.glossary') || '[]'), f: JSON.parse(localStorage.getItem('kr.glossaryFolders') || '[]'), l: JSON.parse(localStorage.getItem('kr.glossaryLinks') || '{}'), v: JSON.parse(localStorage.getItem('kr.glossaryVol') || '{}') }));
  await p.evaluate((i) => { location.hash = `#/read/${i}`; }, id2); await p.waitForSelector('.kr-chapter', { timeout: 30000 }); await p.waitForTimeout(1200);
  const closeAll = () => p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim').forEach((e) => (e.__close ? e.__close() : e.remove())));

  if (LANG === 'ar') {
    await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'translate' }))); await p.waitForSelector('.tr-pill', { timeout: 10000 }); await p.waitForTimeout(600);
    await closeAll(); await p.click('.tr-pill button[aria-label="المزيد"], .tr-pill button[title="المزيد"]').catch(() => undefined);
    await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim').forEach((e) => e.remove()));
    await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'glossary' }))); await p.waitForSelector('.ai-sheet .ai-tab', { timeout: 8000 });
    const run = async () => {
      const tabs = await p.$$eval('.ai-sheet .ai-tab', (e) => e.map((x) => { const r = x.getBoundingClientRect(); return { x: r.left, h: r.height, clip: x.scrollWidth > x.clientWidth + 1, text: x.textContent }; }));
      return tabs;
    };
    await p.waitForTimeout(800); const tabs = await run(); console.log('tabs:', JSON.stringify(tabs.map((x) => x.text)));
    ok('Arabic: four tabs, in right-to-left order', tabs.length === 4 && tabs[0].x > tabs[1].x && tabs[1].x > tabs[2].x, tabs);
    ok('Arabic: none clipped, each at least 40 px high', tabs.every((x) => !x.clip && x.h >= 40), tabs);
    ok('Arabic: the files named in Arabic', await p.$$eval('.gloss-file-name', (e) => e.some((x) => x.textContent === 'الشخصيات') && e.some((x) => x.textContent === 'المهارات')));
    ok('Arabic: counts as «العدد: n»', await p.$$eval('.gloss-file-count', (e) => e.some((x) => /^العدد: \d+$/.test(x.textContent))));
    ok('no horizontal page scroll', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await shot(p, 'R8-tabs-ar.png');
    ok('no page errors', !errors.length); if (errors.length) console.log(errors);
    await b.close(); server.close(); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
  }

  // The translation turned on for volume 2 (no glossary): volume 1's taken by itself — the titles' series identical —,
  // a notice with Undo.
  const btn = await p.$('button[aria-label="AI chapter translation"]');
  if (btn) await btn.click({ force: true }); else await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'translate' })));
  await p.waitForSelector('.tr-pill', { timeout: 10000 });
  await p.waitForFunction(() => /Using the glossary of/.test(document.querySelector('.toast')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => undefined);
  let s = await store(); console.log('after on:', JSON.stringify({ l: s.l, v: s.v, f: s.f }));
  ok('automatically: volume 1\'s glossary shared with volume 2, a notice said so', (s.l[id2] ?? []).length === 1 && (s.l[id1] ?? []).includes(s.l[id2][0]) && s.v[id2]?.choice === 'share' && /Using the glossary of/.test(await p.$eval('.toast', (e) => e.textContent).catch(() => '')));
  ok('… the shared folder named after the series', s.f.length === 1 && s.f[0].name === 'Gate Story', s.f);
  await p.click('.toast .toast-action'); await p.waitForTimeout(300); s = await store();
  ok('Undo: volume 2 back without a glossary, no choice kept', !(s.l[id2] ?? []).length && !s.v[id2] && s.t.every((x) => x.book === id1 && !x.folder), s);
  await closeAll();

  // The pill's More → Glossary: the AI sheet on its Glossary tab; the former volume's glossary taken again by itself,
  // said in the tab, with Change and Undo.
  await p.click('.tr-pill button[aria-label="More"]'); await p.locator('.sheet .dest-row', { hasText: 'Glossary' }).first().click();
  await p.waitForSelector('.ai-sheet .ai-tab[aria-selected="true"][data-tab="glossary"]', { timeout: 6000 });
  ok('More → Glossary: the AI sheet, on its Glossary tab', true);
  await p.waitForSelector('.gloss-vol.notice', { timeout: 6000 }).catch(() => undefined);
  ok('the tab says which glossary is used, with Change and Undo', !!(await p.$('.gloss-vol.notice .gloss-vol-change')) && !!(await p.$('.gloss-vol.notice .gloss-vol-undo')));
  await p.click('.gloss-vol-change'); await p.waitForSelector('.gloss-vol.card', { timeout: 4000 });
  const choice = await p.$$eval('.gloss-vol-btns .btn', (e) => e.map((x) => ({ t: x.textContent, w: Math.round(x.getBoundingClientRect().width) })));
  console.log('choices:', JSON.stringify(choice));
  ok('Change: the three choices — share, copy, start empty — of equal width', choice.length === 3 && /Share/.test(choice[0].t) && /Copy/.test(choice[1].t) && /empty/.test(choice[2].t) && Math.max(...choice.map((x) => x.w)) - Math.min(...choice.map((x) => x.w)) <= 2, choice);
  ok('… the card names the volume and how many terms', /Gate Story Vol\. 1/.test(await p.$eval('.gloss-vol-title', (e) => e.textContent)) && /3/.test(await p.$eval('.gloss-vol-title', (e) => e.textContent)));
  await p.click('.gloss-vol-share'); await p.waitForTimeout(300); s = await store();
  ok('Share it: one glossary for both volumes', (s.l[id2] ?? []).length === 1 && (s.l[id1] ?? []).includes(s.l[id2][0]) && s.v[id2]?.choice === 'share');
  const head = await p.$eval('.gloss-head', (e) => e.textContent); console.log('head:', head);
  ok('the shared folder\'s header: the series, its volumes, shared with volume 1', /Gate Story/.test(head) && /Volumes: .*1.*2/.test(head) && /Shared with: .*Gate Story Vol\. 1/.test(head));
  const files = await p.$$eval('.gloss-file[data-kind]', (e) => e.map((x) => [x.dataset.kind, x.querySelector('.gloss-file-count')?.textContent]));
  console.log('files:', JSON.stringify(files));
  ok('the files: only the kinds that hold terms, each counted', JSON.stringify(files) === JSON.stringify([['person', 'Count: 2'], ['skill', 'Count: 1']]), files);
  ok('… then «New file»', !!(await p.$('.gloss-files .gloss-new-file')));
  await shot(p, 'R8-tabs-glossary-folder.png');
  await p.click('.gloss-file[data-kind="person"]'); await p.waitForSelector('.gloss-row');
  const rows = await p.$$eval('.gloss-row .gloss-from', (e) => e.map((x) => x.value)); ok('a file opened: its terms', rows.join() === 'Lin Feng,Wen Yu', rows);
  await shot(p, 'R8-file-characters.png');
  await p.fill('.gloss-search', 'palm'); await p.waitForSelector('.gloss-hit', { timeout: 4000 });
  ok('the search looks through the whole folder (results by file; the match marked)', (await p.$$eval('.gloss-hit .gloss-hit-from', (e) => e.map((x) => x.textContent))).join() === 'Iron Palm' && (await p.$eval('.gloss-hit .gloss-mark', (e) => e.textContent)) === 'Palm');
  await p.click('.gloss-hit'); await p.waitForSelector('.gloss-row .gloss-from');
  ok('a result tapped opens its file for editing, the search cleared', (await p.$eval('.gloss-search', (e) => e.value)) === '' && (await p.$eval('.gloss-file-now b', (e) => e.textContent)) === 'Skills' && (await p.$$eval('.gloss-row .gloss-from', (e) => e.map((x) => x.value))).includes('Iron Palm'));
  await p.click('.gloss-back'); await p.waitForSelector('.gloss-files');

  // Tabs: switched without closing the sheet; each keeps its state; arrow keys; the row fits the phone.
  await p.evaluate(() => { document.querySelector('.ai-sheet').__mark = 1; });
  await p.click('.ai-tab[data-tab="translation"]'); await p.waitForSelector('.ai-panel[data-tab="translation"]:not([hidden]) textarea', { timeout: 6000 });
  await p.fill('.ai-panel[data-tab="translation"] textarea', 'Keep the names as the glossary has them.');
  await p.click('.ai-tab[data-tab="glossary"]'); await p.click('.ai-tab[data-tab="translation"]');
  ok('switched without closing; the Translation tab\'s text kept', await p.evaluate(() => document.querySelector('.ai-sheet').__mark === 1 && document.querySelector('.ai-panel[data-tab="translation"] textarea').value === 'Keep the names as the glossary has them.'));
  const tabBox = await p.$$eval('.ai-sheet .ai-tab', (e) => e.map((x) => ({ h: x.getBoundingClientRect().height, clip: x.scrollWidth > x.clientWidth + 1 })));
  ok('four tabs, none clipped, each at least 40 px high', tabBox.length === 4 && tabBox.every((x) => !x.clip && x.h >= 40), tabBox);
  ok('the model row: «Browse models» within the sheet', await p.evaluate(() => { const r = [...document.querySelectorAll('.ai-panel[data-tab="translation"] .ai-input-row .btn')].map((x) => x.getBoundingClientRect()); const s = document.querySelector('.ai-sheet').getBoundingClientRect(); return r.every((x) => x.right <= s.right - 8 && x.left >= s.left); }));
  await shot(p, 'R8-tabs-translation.png');
  await p.focus('.ai-tab[data-tab="translation"]'); await p.keyboard.press('ArrowRight');
  ok('arrow keys: the next tab', await p.$eval('.ai-tab[aria-selected="true"]', (e) => e.dataset.tab) === 'glossary');
  await p.keyboard.press('End'); ok('End: the last tab', await p.$eval('.ai-tab[aria-selected="true"]', (e) => e.dataset.tab) === 'saved');
  await p.waitForFunction(() => /\d/.test(document.querySelector('.ai-saved')?.textContent ?? ''), null, { timeout: 4000 }).catch(() => undefined);
  ok('Saved translations: this book\'s count, the keep switch', /Saved translations for this book: \d+/.test(await p.$eval('.ai-saved', (e) => e.textContent)) && !!(await p.$('.ai-panel[data-tab="saved"] .switch input')));
  ok('the tab row stays put while a panel scrolls', await p.evaluate(() => { const row = document.querySelector('.ai-tabs'); const body = document.querySelector('.ai-sheet .sheet-body'); return row.parentElement === document.querySelector('.ai-sheet') && !body.contains(row); }));

  // Names found: filed by kind (an answer grouped by kind read too), accepted into the shared glossary; an answer in
  // the old form (no kinds) still read — into «Terms».
  await p.click('.ai-tab[data-tab="names"]'); await p.click('.names-find'); await p.waitForSelector('.names-group', { timeout: 8000 });
  const groups = await p.$$eval('.names-group', (e) => e.map((x) => x.dataset.kind)); console.log('groups:', groups.join());
  ok('a detection answer with kinds: each name in its file', groups.join() === 'group,quote', groups);
  await shot(p, 'R8-names-found.png');
  await p.click('.names-accept-all'); await p.waitForTimeout(300); s = await store();
  const sect = s.t.find((x) => x.from === 'Azure Sect'), cit = s.t.find((x) => x.from === 'The gate sang its old song');
  ok('accepted: into the shared folder, with their kinds', sect?.kind === 'group' && cit?.kind === 'quote' && !!sect.folder && sect.folder === s.l[id2][0], { sect, cit });
  await p.click('.names-find'); await p.waitForSelector('.names-group[data-kind="term"]', { timeout: 8000 }).catch(() => undefined);
  ok('an answer in the old form: read, into «Terms»', !!(await p.$('.names-group[data-kind="term"]')));
  await p.click('.names-reject-all'); await p.waitForTimeout(200); s = await store();
  ok('rejected: nothing added', !s.t.some((x) => x.from === 'Old Road'));
  await p.click('.ai-tab[data-tab="glossary"]'); await p.waitForTimeout(300);
  const files2 = await p.$$eval('.gloss-file[data-kind]', (e) => e.map((x) => x.dataset.kind)); ok('the folder now lists Groups and Citations too', files2.join() === 'person,group,skill,quote', files2);
  // Volume 1 sees what volume 2 added (one glossary).
  ok('shared: what volume 2 added is there for volume 1', await p.evaluate((i) => { const l = JSON.parse(localStorage.getItem('kr.glossaryLinks'))[i] || []; return JSON.parse(localStorage.getItem('kr.glossary')).some((x) => x.from === 'Azure Sect' && l.includes(x.folder)); }, id1));

  // Stop sharing keeps a copy; the folder then named after the book, and renamed with it.
  p.once('dialog', (d) => void d.accept());
  await p.click('.gloss-stop-share'); await p.waitForTimeout(300); s = await store();
  ok('Stop sharing: volume 2 keeps its own copy', !(s.l[id2] ?? []).length && s.t.filter((x) => x.book === id2).length === 5, s.t.filter((x) => x.book === id2).length);
  ok('… the header now the book\'s title', /Gate Story Vol\. 2/.test(await p.$eval('.gloss-title', (e) => e.textContent)));
  await closeAll();
  await p.evaluate((i) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const st = r.result.transaction('books', 'readwrite').objectStore('books'); const q = st.get(i); q.onsuccess = () => { st.put({ ...q.result, title: 'Gate Story: The Second Gate' }).onsuccess = () => res(); }; }; }), id2);
  // (Written behind the app's back: the page loaded again, as after a rename made elsewhere — a synced device.)
  await p.reload(); await p.waitForSelector('.kr-chapter', { timeout: 30000 }); await p.waitForTimeout(1000);
  await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'glossary' })));
  await p.waitForSelector('.ai-sheet .ai-tab[aria-selected="true"][data-tab="glossary"]', { timeout: 6000 }); await p.waitForTimeout(500);
  ok('the reader\'s Glossary command: the Glossary tab; the folder renamed with the book', /The Second Gate/.test(await p.$eval('.gloss-title', (e) => e.textContent)));
  await closeAll();

  // A word picked in the book: the Glossary tab, a new line filled with it.
  await p.evaluate(() => { const el = [...document.querySelectorAll('.kr-chapter p')].find((x) => /looked/.test(x.textContent)); const tn = [...el.childNodes].find((n) => n.nodeType === 3 && /looked/.test(n.data)); const i = tn.data.indexOf('looked'); const r = document.createRange(); r.setStart(tn, i); r.setEnd(tn, i + 6); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  await p.waitForSelector('.sel-toolbar', { timeout: 6000 }).catch(() => undefined);
  const more = await p.$('.sel-toolbar .sel-row button:last-child');
  if (more) { await more.click(); await p.locator('.sheet li, .sheet button', { hasText: 'Add to the translation glossary' }).first().click(); }
  await p.waitForSelector('.ai-sheet .ai-tab[aria-selected="true"][data-tab="glossary"]', { timeout: 6000 }).catch(() => undefined);
  ok('a picked word: the Glossary tab, the add line filled', (await p.$eval('.gloss-row.fresh .gloss-from', (e) => e.value).catch(() => '')) === 'looked');
  await closeAll();

  // The pill's settings: the Translation tab.
  await p.click('.tr-pill button[aria-label="More"]'); await p.locator('.sheet .dest-row', { hasText: 'Customise' }).click();
  await p.waitForSelector('.ai-sheet .ai-tab[aria-selected="true"][data-tab="translation"]', { timeout: 6000 }).catch(() => undefined);
  await p.waitForSelector('.ai-panel[data-tab="translation"] .tr-options', { timeout: 6000 }).catch(() => undefined);
  ok('the pill\'s settings: the Translation tab, the translator\'s options in it', !!(await p.$('.ai-tab[aria-selected="true"][data-tab="translation"]')) && !!(await p.$('.ai-panel[data-tab="translation"] .tr-options')));
  ok('no old sheets left: one sheet open', (await p.$$('.sheet')).length === 1);
  await closeAll();

  // Settings: the Translation tab; the Glossary tab then every book's glossary and the books' glossaries.
  await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForTimeout(1200);
  await p.evaluate(() => [...document.querySelectorAll('button')].find((x) => /Provider, key, model, instructions/.test(x.textContent))?.click());
  await p.waitForSelector('.ai-sheet .ai-tab[aria-selected="true"][data-tab="translation"]', { timeout: 6000 }).catch(() => undefined);
  ok('Settings: the Translation tab', !!(await p.$('.ai-tab[aria-selected="true"][data-tab="translation"]')));
  await p.click('.ai-tab[data-tab="glossary"]'); await p.waitForSelector('.gloss-books .gloss-book', { timeout: 6000 }).catch(() => undefined);
  const bl = await p.$$eval('.gloss-book', (e) => e.map((x) => x.textContent)); console.log('books:', JSON.stringify(bl));
  ok('… the Glossary tab: every book\'s glossary, then the books that have one', /Every book/.test(await p.$eval('.gloss-title', (e) => e.textContent)) && bl.length === 2);
  ok('Settings: the choice for a former volume\'s glossary beside the AI options', await p.evaluate(() => !!document.querySelector('.view .gloss-vol-mode .pick-btn, main .gloss-vol-mode .pick-btn')));
  ok('no page errors', !errors.length); if (errors.length) console.log(errors);
  await b.close(); server.close();
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
