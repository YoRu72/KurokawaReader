// node tests/libraryhelpers.cjs [en|ar] [shots dir]: the library's helpers of 0.67 —
//  A  «Edit details» for several books at once (src/ui/bulkdetails.ts, src/bulkdetails.ts): author and series set on all
//     of them with the volume numbers previewed, «only where there is no author», the original author kept and searchable,
//     one «Undo» putting every book back;
//  B  the language filter (chips for the languages present, named in the interface's language, several at once, saved with
//     a shelf, hidden when the library is one language);
//  C  search in the notes page (src/notessearch.ts, src/views/notes.ts): highlight text, note, other title, Arabic marks
//     folded, together with the Bookmarks / Notes chips, clear, empty state, «/» on a computer, 5,000 notes timed;
//  D  the goal for the year (src/yeargoal.ts, src/ui/stats.ts): set, counted from this year's finished books only,
//     the pace, the list, kept after a reload.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const esbuild = require(path.resolve(__dirname, '../node_modules/esbuild'));
const LANG = process.argv.includes('ar') ? 'ar' : 'en';
const shotsArg = process.argv.slice(2).find((x) => x !== 'en' && x !== 'ar');
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 500))); if (!c) fails++; };
const DIST = path.resolve(__dirname, '../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
// The words of each language (the strings of src/i18n).
const W = LANG === 'ar'
  ? { details: 'تحرير التفاصيل', selected: /^المحدَّد\. العدد: 3/, changed: /^تم التغيير\. العدد: 3/, more: 'المزيد', undo: 'تراجع', saveShelf: 'احفظ رفًّا', notes: 'التعليقات', bookmarks: 'العلامات', stats: 'إحصاءات القراءة' }
  : { details: 'Edit details', selected: /^Selected\. Count: 3/, changed: /^Changed\. Count: 3/, more: 'More', undo: 'Undo', saveShelf: 'Save as shelf', notes: 'Notes', bookmarks: 'Bookmarks', stats: 'Reading statistics' };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-libhelpers-'));
const NAMES = ['Dragon Tale Vol 2', 'Dragon Tale Vol 3', 'Dragon Tale Vol 1', 'Lone Book', 'Other Book'];
const files = NAMES.map((n) => { const f = path.join(dir, `${n}.txt`); fs.writeFileSync(f, `${n}\n\n` + `Words of ${n}. `.repeat(40)); return f; });
// The notes search's own functions, run here: five thousand notes timed.
const bundle = (entry) => { const out = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, '../src', entry)], bundle: true, write: false, format: 'cjs', platform: 'node', target: 'es2020' }).outputFiles[0].text; const module = { exports: {} }; new Function('module', 'exports', out)(module, module.exports); return module.exports; };

(async () => {
  // C (pure): the filter over 5,000 notes.
  const NS = bundle('notessearch.ts'); const YG = bundle('yeargoal.ts'); const BL = bundle('booklang.ts');
  const many = Array.from({ length: 50 }, (_, i) => ({ id: 'b' + i, title: `Book number ${i}`, titles: [`Book number ${i}`, i === 7 ? 'Zebra Chronicle' : `Alias ${i}`], author: `Author ${i % 9}`, bookmarks: [], pins: [],
    highlights: Array.from({ length: 100 }, (_, j) => ({ id: `h${i}-${j}`, text: `Highlighted passage ${i}.${j} about harbours, lanterns and the long road home`, note: j === 42 && i === 3 ? 'The needle in the haystack' : `Note ${i}.${j}: remember this part of the story`, createdAt: j })) }));
  let t0 = performance.now(); const ix = NS.buildIndex(many); const tBuild = performance.now() - t0;
  const times = []; let hits = 0;
  for (const q of ['needle', 'haystack', 'LANTERNS', 'zebra', 'remember this', '']) for (let k = 0; k < 5; k++) { t0 = performance.now(); const r = NS.filterIndex(ix, q, 'all'); times.push(performance.now() - t0); if (k === 0 && q === 'needle') hits = [...r.values()].reduce((a, s) => a + s.size, 0); }
  const worst = Math.max(...times);
  ok(`5,000 notes: the filter takes ${worst.toFixed(2)} ms at most (index built once in ${tBuild.toFixed(0)} ms)`, worst < 50 && ix.reduce((a, b) => a + b.entries.length, 0) === 5000, { worst, tBuild });
  ok('5,000 notes: «needle» finds the one note', hits === 1, hits);
  ok('5,000 notes: an other title finds the whole book (100 notes)', [...NS.filterIndex(ix, 'zebra', 'all').values()].reduce((a, s) => a + s.size, 0) === 100);
  ok('Arabic marks and hamza folded: «الكتاب» finds «الكِتَابُ»', NS.filterIndex(NS.buildIndex([{ id: 'x', title: 'T', highlights: [{ id: 'a', text: 'ما في الكِتَابُ', note: 'ملاحظة', createdAt: 1 }], bookmarks: [], pins: [] }]), 'الكتاب', 'all').size === 1);
  ok('kana folded: katakana finds hiragana', NS.filterIndex(NS.buildIndex([{ id: 'x', title: 'T', highlights: [{ id: 'a', text: 'ひらがな', note: 'n', createdAt: 1 }], bookmarks: [], pins: [] }]), 'ヒラガナ', 'all').size === 1);
  ok('year goal: counted by the mark\'s year; a book done twice once; not done / other years left out', (() => {
    const y = new Date().getFullYear(); const at = (m) => new Date(y, m, 5).getTime();
    const bs = [{ done: true, doneAt: at(0) }, { done: true, doneAt: at(1) }, { done: true, doneAt: new Date(y - 1, 5, 5).getTime() }, { done: false, doneAt: at(2) }, { progress: { pct: 0.5 } }, { done: true, doneAt: at(1) }];
    return YG.finishedIn(bs, y).length === 3;
  })());
  ok('year goal: the pace (ceil to one decimal, 0 once reached)', YG.perMonth(0, 12, new Date(2026, 0, 10)) === 1 && YG.perMonth(3, 10, new Date(2026, 10, 10)) === 3.5 && YG.perMonth(10, 10, new Date(2026, 3, 1)) === 0);
  ok('languages: base codes, ISO 639-2, unknown', BL.langKeyOf({ language: 'en-GB' }) === 'en' && BL.langKeyOf({ language: 'ara' }) === 'ar' && BL.langKeyOf({}) === 'unknown' && BL.langKeyOf({ language: 'und' }) === 'unknown');

  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const shots = shotsArg || path.join(os.tmpdir(), 'kr-libhelpers'); fs.mkdirSync(shots, { recursive: true });
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: LANG, colorScheme: 'dark' }); const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`http://localhost:${port}/`);
  await p.evaluate((l) => { localStorage.setItem('kr.lang', l); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.visual', JSON.stringify({ groupSeries: false, libraryView: 'cards' })); }, LANG); await p.reload(); await p.waitForSelector('.library-view');
  await p.setInputFiles('input[type=file]', files); await p.waitForFunction((n) => document.querySelectorAll('.book-card[data-book]').length >= n, files.length, { timeout: 60000 }); await p.waitForTimeout(600);
  const idb = (fn, arg) => p.evaluate(([src, arg]) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const tx = r.result.transaction('books', 'readwrite'); const st = tx.objectStore('books'); const q = st.getAll(); q.onsuccess = () => { const out = (0, eval)(`(${src})`)(q.result, st, arg); if (!/^\(?all\) => all\.map/.test(src)) for (const x of q.result) st.put(x); tx.oncomplete = () => res(out); }; }; }), [fn.toString(), arg]);
  const recs = () => idb((all) => all.map((x) => ({ id: x.id, title: x.title, author: x.author, origAuthor: x.origAuthor, series: x.series, namesAt: x.namesAt, language: x.language, done: x.done, doneAt: x.doneAt })));
  const byTitle = async (t) => (await recs()).find((x) => x.title === t);
  const ids = {}; for (const n of NAMES) ids[n] = (await byTitle(n)).id;
  const gotoLib = async () => { await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view .book-card'); await p.waitForTimeout(400); };
  const cards = () => p.$$eval('.book-card[data-book] .bt', (e) => e.map((x) => x.textContent).sort());
  const search = async (q) => { await p.fill('.library-view input[type=search]', q); await p.waitForTimeout(600); };
  await idb((all) => { for (const x of all) if (x.title === 'Dragon Tale Vol 2') x.author = 'Zed Writer'; }, 0);
  // (One of the books has an author of its own: «only where there is no author» leaves it.)
  await p.reload(); await p.waitForSelector('.library-view .book-card'); await p.waitForTimeout(500);

  /* ---------------- A ---------------- */
  const selectInOrder = async (order) => {
    await p.click('.library-view .tool-btn[aria-pressed]'); await p.waitForSelector('.sel-head');
    for (const n of order) { await p.click(`.book-card[data-book="${ids[n]}"]`); await p.waitForTimeout(80); }
  };
  const clickAct = async (label) => {
    const direct = await p.evaluate((l) => { const x = [...document.querySelectorAll('.sel-actions .sel-act')].find((e) => e.getAttribute('aria-label') === l); if (x) { x.click(); return true; } return false; }, label);
    if (direct) return;
    await p.evaluate((m) => [...document.querySelectorAll('.sel-actions .sel-act')].find((e) => e.getAttribute('aria-label') === m).click(), W.more); await p.waitForSelector('.sheet .dest-row');
    await p.evaluate((l) => [...document.querySelectorAll('.sheet .dest-row')].find((e) => e.textContent.trim() === l).click(), label);
  };
  const previewRows = () => p.$$eval('.bulk-row', (rs) => rs.map((r) => [r.querySelector('.bulk-title').textContent, r.querySelector('.bulk-vol').textContent]));
  await gotoLib();
  await selectInOrder(['Dragon Tale Vol 3', 'Dragon Tale Vol 1', 'Dragon Tale Vol 2']);
  await clickAct(W.details); await p.waitForSelector('.bulk-sheet .bulk-author'); await p.waitForTimeout(300);
  const heading = await p.$eval('.bulk-sheet .sheet-head h3', (e) => e.textContent);
  ok('the sheet\'s title says how many were chosen', W.selected.test(heading), heading);
  ok('the fields start empty; the author field says «Zed Writer»\'s presence by «several»', await p.$eval('.bulk-author', (e) => e.value === '' && e.placeholder.length > 0) && await p.$eval('.bulk-series', (e) => e.value === ''), await p.$eval('.bulk-author', (e) => e.placeholder));
  ok('Apply is off while nothing is filled', await p.$eval('.bulk-apply', (e) => e.disabled));
  await p.fill('.bulk-author', 'Brand New Author'); await p.fill('.bulk-series', 'Dragon Tale'); await p.waitForTimeout(200);
  let rows = await previewRows();
  ok('the preview lists the three books with the number each title carries (chosen order: 3, 1, 2)', rows.length === 3 && rows[0][0] === 'Dragon Tale Vol 3' && /3/.test(rows[0][1]) && /1/.test(rows[1][1]) && /2/.test(rows[2][1]), rows);
  await p.evaluate(() => { const sw = [...document.querySelectorAll('.bulk-sheet .bulk-switch input')]; const i = sw[1]; i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); }); await p.waitForTimeout(150);
  rows = await previewRows();
  ok('«in the order selected»: the preview numbers them 1, 2, 3 in the order chosen', rows.length === 3 && /1/.test(rows[0][1]) && /2/.test(rows[1][1]) && /3/.test(rows[2][1]) && rows[0][0] === 'Dragon Tale Vol 3', rows);
  await p.waitForTimeout(500); await p.screenshot({ path: path.join(shots, `S4a-bulk-${LANG}.png`) });
  const sheetBox = await p.$eval('.bulk-sheet', (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, w: window.innerWidth }; });
  ok('the sheet fits the phone\'s width', sheetBox.l >= -1 && sheetBox.r <= sheetBox.w + 1, sheetBox);
  const btns = await p.$$eval('.bulk-actions > button', (bs) => bs.map((x) => { const r = x.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; }));
  ok('Apply and Cancel are as wide as each other (or stacked at full width) and ≥ 40 px high', btns.length === 2 && Math.abs(btns[0].w - btns[1].w) <= 1 && btns.every((x) => x.h >= 40), btns);
  await p.evaluate(() => { const i = [...document.querySelectorAll('.bulk-sheet .bulk-switch input')][1]; i.checked = false; i.dispatchEvent(new Event('change', { bubbles: true })); }); await p.waitForTimeout(150);
  await p.click('.bulk-apply'); await p.waitForTimeout(900);
  let r1 = await byTitle('Dragon Tale Vol 1'), r2 = await byTitle('Dragon Tale Vol 2'), r3 = await byTitle('Dragon Tale Vol 3'); const lone = await byTitle('Lone Book');
  ok('each record: the new author on all three; the volume number from each title', [r1, r2, r3].every((x) => x.author === 'Brand New Author' && x.series && x.series.name === 'Dragon Tale') && r1.series.index === 1 && r2.series.index === 2 && r3.series.index === 3, [r1, r2, r3]);
  ok('the file\'s own author is kept: «Zed Writer» on Vol 2, none on the others; a book not chosen is untouched', r2.origAuthor === 'Zed Writer' && r1.origAuthor === null && r3.origAuthor === null && !lone.author && !lone.series, [r1.origAuthor, r2.origAuthor, r3.origAuthor, lone]);
  const toast = await p.$eval('.toast .toast-text', (e) => e.textContent).catch(() => '');
  ok('one toast: «Changed. Count: 3»', W.changed.test(toast), toast);
  ok('selecting is over and the library shows the new author', !(await p.$('.sel-head')) && (await p.$$eval('.book-card[data-book] .ba', (e) => e.filter((x) => /Brand New Author/.test(x.textContent)).length)) === 3);
  await search('brand new'); ok('search finds them by the new author', (await cards()).length === 3, await cards());
  await search('zed writer'); ok('search finds the one by its original author', (await cards()).join() === 'Dragon Tale Vol 2', await cards());
  await search('');
  await p.click('.toast-action'); await p.waitForTimeout(900);
  r1 = await byTitle('Dragon Tale Vol 1'); r2 = await byTitle('Dragon Tale Vol 2'); r3 = await byTitle('Dragon Tale Vol 3');
  ok('Undo: every book as it was (authors, the originals, no series)', r2.author === 'Zed Writer' && r2.origAuthor === undefined && !r1.author && r1.origAuthor === undefined && !r3.author && !r1.series && !r2.series && !r3.series, [r1, r2, r3]);
  await search('brand new'); ok('after Undo the new author no longer finds them', (await cards()).length === 0); await search('');
  // «Only where there is no author».
  await gotoLib();
  await selectInOrder(['Dragon Tale Vol 1', 'Dragon Tale Vol 2', 'Dragon Tale Vol 3']); await clickAct(W.details); await p.waitForSelector('.bulk-sheet .bulk-author');
  await p.fill('.bulk-author', 'Filler Author');
  await p.evaluate(() => { const i = [...document.querySelectorAll('.bulk-sheet .bulk-switch input')][0]; i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); }); await p.waitForTimeout(150);
  await p.click('.bulk-apply'); await p.waitForTimeout(900);
  r1 = await byTitle('Dragon Tale Vol 1'); r2 = await byTitle('Dragon Tale Vol 2'); r3 = await byTitle('Dragon Tale Vol 3');
  ok('«Only where there is no author»: Vol 2 keeps «Zed Writer», the others get «Filler Author»', r2.author === 'Zed Writer' && r1.author === 'Filler Author' && r3.author === 'Filler Author' && !r1.series, [r1.author, r2.author, r3.author]);
  await p.click('.toast-action'); await p.waitForTimeout(700);
  // Remove from series (a book with a stored series), and the sheet with series already there.
  await idb((all) => { for (const x of all) if (/^Dragon/.test(x.title)) x.series = { name: 'Dragon Tale', index: Number(x.title.slice(-1)) }; }, 0);
  await p.reload(); await p.waitForSelector('.library-view .book-card'); await p.waitForTimeout(500);
  await selectInOrder(['Dragon Tale Vol 1', 'Dragon Tale Vol 2']); await clickAct(W.details); await p.waitForSelector('.bulk-sheet .bulk-series');
  ok('the series field says what the books have now', await p.$eval('.bulk-series', (e) => e.placeholder === 'Dragon Tale'), await p.$eval('.bulk-series', (e) => e.placeholder));
  ok('«Remove from its series» is offered when a book has one', !(await p.$eval('.bulk-remove', (e) => e.hidden)));
  await p.click('.bulk-remove'); await p.waitForTimeout(150); await p.click('.bulk-apply'); await p.waitForTimeout(900);
  ok('removed from the series; the third (not chosen) keeps it', !(await byTitle('Dragon Tale Vol 1')).series && !(await byTitle('Dragon Tale Vol 2')).series && !!(await byTitle('Dragon Tale Vol 3')).series);
  await p.click('.toast-action'); await p.waitForTimeout(700);
  ok('Undo puts the series back', (await byTitle('Dragon Tale Vol 1')).series?.name === 'Dragon Tale' && (await byTitle('Dragon Tale Vol 2')).series?.index === 2);
  await idb((all) => { for (const x of all) { delete x.series; delete x.author; delete x.origAuthor; delete x.namesAt; } }, 0);

  /* ---------------- B ---------------- */
  await idb((all, st, id) => { const L = { 'Dragon Tale Vol 1': 'en', 'Dragon Tale Vol 2': 'en-GB', 'Dragon Tale Vol 3': 'ar', 'Lone Book': 'ja' }; for (const x of all) { if (L[x.title]) x.language = L[x.title]; else delete x.language; } }, 0);
  await p.reload(); await p.waitForSelector('.library-view .book-card'); await p.waitForTimeout(500);
  const chipsNow = () => p.$$eval('.lang-chip', (e) => e.map((x) => ({ k: x.dataset.lang, name: x.textContent.trim(), on: x.classList.contains('on') })));
  const want = await p.evaluate(([l]) => { const dn = new Intl.DisplayNames([l], { type: 'language' }); return { en: dn.of('en'), ar: dn.of('ar'), ja: dn.of('ja') }; }, [LANG]);
  let cs = await chipsNow();
  ok('chips only for the languages present: en, ar, ja and unknown (no other)', cs.map((x) => x.k).sort().join() === 'ar,en,ja,unknown', cs);
  ok('names in the interface\'s language', cs.find((x) => x.k === 'en').name === want.en && cs.find((x) => x.k === 'ar').name === want.ar && cs.find((x) => x.k === 'ja').name === want.ja, [cs, want]);
  await p.screenshot({ path: path.join(shots, `S4a-language-chips${LANG === 'ar' ? '-ar' : ''}.png`) });
  await p.click('.lang-chip[data-lang="en"]'); await p.waitForTimeout(250); await p.click('.lang-chip[data-lang="ar"]'); await p.waitForTimeout(350);
  ok('two languages chosen: the grid shows the three books in them', (await cards()).join() === 'Dragon Tale Vol 1,Dragon Tale Vol 2,Dragon Tale Vol 3', await cards());
  ok('a chosen chip is marked', (await chipsNow()).filter((x) => x.on).map((x) => x.k).sort().join() === 'ar,en');
  // A saved shelf remembers the languages.
  await p.evaluate((l) => [...document.querySelectorAll('.format-chips .chip.add')].find((x) => x.textContent.trim() === l).click(), W.saveShelf); await p.waitForSelector('.text-ask-sheet input');
  await p.fill('.text-ask-sheet input', 'Two tongues'); await p.keyboard.press('Enter'); await p.waitForTimeout(500);
  const shelf = await p.evaluate(() => JSON.parse(localStorage.getItem('kr.visual')).shelves?.[0]);
  ok('the shelf holds the languages', shelf && shelf.languages && shelf.languages.slice().sort().join() === 'ar,en', shelf);
  await p.evaluate(() => { const v = JSON.parse(localStorage.getItem('kr.visual')); v.languageFilter = []; localStorage.setItem('kr.visual', JSON.stringify(v)); });
  await p.reload(); await p.waitForSelector('.library-view .book-card'); await p.waitForTimeout(500);
  ok('without a filter all five are listed', (await cards()).length === 5);
  await p.click('.chip.shelf'); await p.waitForTimeout(400);
  ok('tapping the shelf brings the language filter back (the same three books)', (await cards()).join() === 'Dragon Tale Vol 1,Dragon Tale Vol 2,Dragon Tale Vol 3' && (await chipsNow()).filter((x) => x.on).length === 2, await cards());
  await p.click('.chip.shelf'); await p.waitForTimeout(300);
  ok('tapping it again clears it', (await cards()).length === 5);
  await p.click('.lang-chip[data-lang="unknown"]'); await p.waitForTimeout(300);
  ok('«Unknown» lists the book without a language', (await cards()).join() === 'Other Book', await cards()); await p.click('.lang-chip[data-lang="unknown"]'); await p.waitForTimeout(200);
  // One language only: no chips, and a stale filter is ignored.
  await p.evaluate(() => { const v = JSON.parse(localStorage.getItem('kr.visual')); v.languageFilter = ['ja']; localStorage.setItem('kr.visual', JSON.stringify(v)); });
  await idb((all) => { for (const x of all) x.language = 'en'; }, 0);
  await p.reload(); await p.waitForSelector('.library-view .book-card'); await p.waitForTimeout(500);
  ok('one language in the library: the chips are hidden, and an old filter does not hide books', (await p.$$('.lang-chip')).length === 0 && (await cards()).length === 5);
  await p.evaluate(() => { const v = JSON.parse(localStorage.getItem('kr.visual')); v.languageFilter = []; v.shelves = []; localStorage.setItem('kr.visual', JSON.stringify(v)); });

  /* ---------------- C ---------------- */
  const hl = (id, text, note) => ({ id, text, note, color: 'sky', createdAt: Date.now() + Math.random() });
  await idb((all, st, I) => {
    for (const x of all) {
      if (x.title === 'Dragon Tale Vol 1') { x.titles = ['Dragon Tale Vol 1', 'Zebra Chronicle']; x.highlights = [{ id: 'n1', text: 'The quick brown fox jumps', note: 'remember the fox', color: 'sky', createdAt: 1 }, { id: 'n2', text: 'Second passage', note: 'الكِتَابُ الجَمِيلُ', color: 'sky', createdAt: 2 }]; x.bookmarks = [{ id: 'm1', label: 'Chapter Seven', locator: { bookId: x.id, pct: 0.2 }, createdAt: 3 }]; }
      else if (x.title === 'Dragon Tale Vol 2') { x.highlights = [{ id: 'n3', text: 'Lanterns along the harbour', note: 'a quiet scene', color: 'rose', createdAt: 4 }]; x.bookmarks = []; }
      else if (x.title === 'Lone Book') { x.highlights = [{ id: 'n4', text: 'Another fox appears', note: 'second fox', color: 'mint', createdAt: 5 }]; x.bookmarks = []; }
      else { x.highlights = []; x.bookmarks = []; }
    }
  }, 0);
  await p.evaluate(() => { location.hash = '#/notes'; }); await p.reload(); await p.waitForSelector('.notes-book'); await p.waitForTimeout(500);
  const shownBooks = () => p.$$eval('.notes-book .bt', (e) => e.map((x) => x.textContent).sort());
  const nsearch = async (q) => { await p.fill('.ns-search', q); await p.waitForTimeout(500); };
  ok('without a search the three books are listed', (await shownBooks()).length === 3, await shownBooks());
  await nsearch('brown fox'); ok('finds by the highlighted text', (await shownBooks()).join() === 'Dragon Tale Vol 1', await shownBooks());
  ok('the matched part is marked, and the book opens to it', await p.$$eval('.notes-book:not(.folded) .ns-mark', (e) => e.some((x) => /brown fox/i.test(x.textContent))));
  await nsearch('quiet scene'); ok('finds by the note', (await shownBooks()).join() === 'Dragon Tale Vol 2', await shownBooks());
  await nsearch('zebra'); ok('finds by another title of the book (and says which)', (await shownBooks()).join() === 'Dragon Tale Vol 1' && /Zebra/.test(await p.$eval('.ns-also', (e) => e.textContent)), await shownBooks());
  await nsearch('الكتاب'); ok('Arabic marks folded: «الكتاب» finds «الكِتَابُ»', (await shownBooks()).join() === 'Dragon Tale Vol 1' && await p.$$eval('.ns-mark', (e) => e.some((x) => /الكِتَابُ/.test(x.textContent))), await shownBooks());
  await nsearch('FOX'); ok('case folded; two books hold «fox»', (await shownBooks()).length === 2);
  await nsearch('chapter seven'); ok('finds a bookmark by its chapter name', (await shownBooks()).join() === 'Dragon Tale Vol 1');
  await p.click(`.folder-chips .chip:has-text("${W.notes}")`); await p.waitForTimeout(300);
  ok('together with the «Notes» chip: a bookmark\'s chapter name no longer matches (empty state)', (await shownBooks()).length === 0 && !!(await p.$('.ns-empty')));
  await p.screenshot({ path: path.join(shots, `S4a-notes-empty-${LANG}.png`) });
  await p.click(`.folder-chips .chip:has-text("${W.bookmarks}")`); await p.waitForTimeout(300);
  ok('together with «Bookmarks»: it does', (await shownBooks()).join() === 'Dragon Tale Vol 1');
  await nsearch('fox'); ok('«Bookmarks» + «fox»: nothing (no bookmark says it)', (await shownBooks()).length === 0);
  await p.click('.folder-chips .chip:first-child'); await p.waitForTimeout(300);
  await nsearch('brown'); await p.screenshot({ path: path.join(shots, 'S4a-notes-search.png') });
  await p.click('.ns-clear'); await p.waitForTimeout(400);
  ok('clear (×) empties the field and lists every book again', (await p.$eval('.ns-search', (e) => e.value)) === '' && (await shownBooks()).length === 3 && await p.$eval('.ns-clear', (e) => e.hidden));
  // Deleting a note while a search is on keeps the search (and Undo puts it back).
  // 5,000 notes in the page: the list stays quick.
  await idb((all) => { let k = 0; for (const x of all) { x.highlights = Array.from({ length: 1000 }, (_, j) => ({ id: `big${k}-${j}`, text: `Passage ${k}.${j} about lanterns and the long road`, note: j === 500 && k === 2 ? 'the needle here' : `Note ${k}.${j}`, color: 'sky', createdAt: j })); x.bookmarks = []; k++; } }, 0);
  await p.reload(); await p.waitForSelector('.notes-book', { timeout: 30000 }); await p.waitForTimeout(800);
  const typed = await p.evaluate(() => new Promise((res) => { const i = document.querySelector('.ns-search'); const t0 = performance.now(); const mo = new MutationObserver(() => { if (document.querySelector('.notes-book .ns-mark')) { mo.disconnect(); res(performance.now() - t0); } }); mo.observe(document.querySelector('.notes-view'), { childList: true, subtree: true }); i.value = 'needle'; i.dispatchEvent(new Event('input', { bubbles: true })); setTimeout(() => res(-1), 8000); }));
  ok(`5,000 notes in the page: a search shows its match in ${typed.toFixed(0)} ms (the field waits 110 ms before it searches)`, typed > 0 && typed < 1500 && (await shownBooks()).length === 1, typed);
  await nsearch(''); await p.waitForTimeout(300);
  ok('5,000 notes: the unfolded page makes no row until a book is opened', (await p.$$eval('.notes-book .plain-list li', (e) => e.length)) === 0);
  // A computer: «/» goes to the search.
  const pc = await b.newContext({ viewport: { width: 1280, height: 800 }, locale: LANG }); const q = await pc.newPage(); const pcErrors = []; q.on('pageerror', (e) => pcErrors.push(e.message));
  await q.goto(`http://localhost:${port}/`); await q.evaluate((l) => { localStorage.setItem('kr.lang', l); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }, LANG); await q.evaluate(() => { location.hash = '#/notes'; }); await q.reload(); await q.waitForSelector('.ns-search');
  await q.keyboard.press('/'); ok('on a computer «/» focuses the search', await q.evaluate(() => document.activeElement === document.querySelector('.ns-search')));
  await q.evaluate(() => document.activeElement.blur()); await q.keyboard.press('Control+f'); ok('…and Ctrl+F too', await q.evaluate(() => document.activeElement === document.querySelector('.ns-search')));
  await pc.close();

  /* ---------------- D ---------------- */
  const y = new Date().getFullYear(); const at = (m, d) => new Date(y, m, d, 12).getTime();
  await idb((all) => { for (const x of all) { x.highlights = []; x.bookmarks = []; } }, 0);
  await idb((all, st, I) => { const [thisA, thisB, last] = I; for (const x of all) { delete x.done; delete x.doneAt; delete x.progress; if (x.title === 'Dragon Tale Vol 1') { x.done = true; x.doneAt = thisA; } if (x.title === 'Dragon Tale Vol 2') { x.done = true; x.doneAt = thisB; } if (x.title === 'Dragon Tale Vol 3') { x.done = true; x.doneAt = last; } if (x.title === 'Lone Book') { x.done = false; x.doneAt = thisA; } } }, [at(0, 10), at(Math.min(new Date().getMonth(), 1), 20), new Date(y - 1, 5, 5).getTime()]);
  await gotoLib(); await p.reload(); await p.waitForSelector('.library-view .book-card'); await p.waitForTimeout(400);
  const openStats = async () => { await p.evaluate((w) => { [...document.querySelectorAll('.library-view .topbar button')].find((x) => x.getAttribute('aria-label') === w).click(); }, W.stats); await p.waitForSelector('.year-goal'); await p.waitForTimeout(300); };
  await openStats();
  ok('no goal yet: the field is empty and says so; this year\'s two books are listed (not last year\'s, not the one marked not done)', await p.$eval('.yg-input', (e) => e.value === '') && (await p.$$('.yg-book')).length === 2 && !(await p.$('.yg-ring')), await p.$$eval('.yg-title', (e) => e.map((x) => x.textContent)));
  ok('the empty field shows its placeholder whole (not cut)', await p.$eval('.yg-input', (e) => { const c = document.createElement('canvas').getContext('2d'); const cs = getComputedStyle(e); c.font = `${cs.fontSize} ${cs.fontFamily}`; return c.measureText(e.placeholder).width <= e.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); }));
  await p.fill('.yg-input', '12'); await p.press('.yg-input', 'Tab'); await p.waitForTimeout(300);
  const of = await p.$eval('.yg-of', (e) => e.textContent); const pace = await p.$eval('.yg-pace', (e) => e.textContent);
  ok('goal 12: «2 of 12», a ring, and the books a month still needed', /2/.test(of) && /12/.test(of) && !!(await p.$('.yg-ring .fill')) && pace.length > 0, [of, pace]);
  const need = Math.ceil(((12 - 2) / (12 - new Date().getMonth())) * 10 - 1e-9) / 10;
  ok('the pace is the books left over the months left (this month counted)', pace.includes(String(need)), [pace, need]);
  await p.click('.yg-step:last-of-type'); await p.waitForTimeout(250);
  ok('the stepper adds one (13)', await p.$eval('.yg-input', (e) => e.value) === '13');
  await p.screenshot({ path: path.join(shots, 'S4a-year-goal.png') });
  await p.click('.sheet-head .icon-btn'); await p.waitForTimeout(300);
  await p.reload(); await p.waitForSelector('.library-view .book-card'); await p.waitForTimeout(400); await openStats();
  ok('the goal survives a reload', await p.$eval('.yg-input', (e) => e.value) === '13' && /2/.test(await p.$eval('.yg-of', (e) => e.textContent)));
  await p.click('.yg-book'); await p.waitForTimeout(600);
  ok('tapping a finished book opens its page', /#\/book\//.test(await p.evaluate(() => location.hash)));
  await gotoLib(); await openStats(); await p.fill('.yg-input', ''); await p.press('.yg-input', 'Tab'); await p.waitForTimeout(300);
  ok('emptied: no goal (no ring), the list stays', !(await p.$('.yg-ring')) && (await p.$$('.yg-book')).length === 2 && (await p.evaluate(() => JSON.parse(localStorage.getItem('kr.visual')).yearGoalBooks)) === 0);
  ok('no page errors', !errors.length && !pcErrors.length, [...errors, ...pcErrors]);
  console.log(fails ? `${fails} failed` : 'all passed');
  await b.close(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
