// node tests/booktitles.cjs [shots dir]: the book's titles and author are the reader's to set (src/booktitles.ts,
// src/ui/booknames.ts): rename keeping / dropping the old title, «Show this one», search by each title, the original
// and the author (with the «also:» line), a book without an author gaining one from the «Text as image» card
// sheet (and the card's lines changing the picture), an old record, an old backup's record, sort by shown title.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const esbuild = require(path.resolve(__dirname, '../node_modules/esbuild'));
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 400))); if (!c) fails++; };
const DIST = path.resolve(__dirname, '../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); res.end(fs.readFileSync(f)); });
// The pure parts (an old record, an old backup's record), run here.
const load = (file, mocks) => { const src = esbuild.transformSync(fs.readFileSync(path.resolve(__dirname, '../src', file), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2020' }).code; const module = { exports: {} }; new Function('require', 'exports', 'module', src)((n) => (mocks && n in mocks ? mocks[n] : require(n)), module.exports, module); return module.exports; };
let clock = 1000; const BT = load('booktitles.ts', { './db': { stampAfter: (p) => Math.max(Date.now(), (p ?? 0) + 1), db: {} }, './formats/types': { searchFormOf: (s) => s.toLowerCase() } });
(async () => {
  const old = { title: 'Old Title', author: 'Old Author' };
  ok('old record: titles = [title], no other titles', BT.titlesOf(old).join('|') === 'Old Title' && BT.otherTitles(old).length === 0 && BT.origTitleOf(old) === 'Old Title' && BT.origAuthorOf(old) === 'Old Author');
  const b1 = { title: 'Old Title', author: 'Old Author' }; BT.renameTo(b1, 'New', true);
  ok('rename keeps the old as another', b1.title === 'New' && b1.titles.join('|') === 'New|Old Title' && b1.origTitle === 'Old Title' && b1.origAuthor === 'Old Author');
  const b2 = { title: 'Old Title' }; BT.renameTo(b2, 'New', false); ok('rename without keeping drops it; no author is origAuthor null', b2.titles === undefined && b2.origAuthor === null && BT.origAuthorOf(b2) === undefined);
  BT.restoreTitle(b1); ok('back to the book\'s own title', b1.title === 'Old Title' && b1.titles.join('|') === 'Old Title|New');
  const inc = { title: 'Old', titles: ['Old', 'Zed'], namesAt: 50, author: 'A', origAuthor: null };
  const dev = { title: 'Mine', namesAt: 10 }; ok('an old backup record (no names) leaves the device\'s', BT.takeNames({ title: 'Mine', namesAt: 10 }, { title: 'X' }) === false);
  ok('a later record\'s names are taken', BT.takeNames(dev, inc) === true && dev.title === 'Old' && dev.titles.join() === 'Old,Zed' && dev.author === 'A' && dev.origAuthor === null);
  ok('an earlier record\'s names are not', BT.takeNames(dev, { title: 'Z', namesAt: 5 }) === false && dev.title === 'Old');

  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const shots = process.argv[2] || path.join(os.tmpdir(), 'kr-booktitles'); fs.mkdirSync(shots, { recursive: true });
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'en', colorScheme: 'dark' }); const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`http://localhost:${port}/`); await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.visual', JSON.stringify({ readingMode: 'continuous', snapStyle: 'card' })); }); await p.reload(); await p.waitForSelector('.library-view');
  await p.setInputFiles('input[type=file]', [path.resolve('public/samples/alice-in-wonderland.epub'), path.resolve('public/samples/maqamat-al-hariri.epub')]);
  await p.waitForFunction(() => document.querySelectorAll('.book-card').length >= 2, null, { timeout: 90000 }); await p.waitForTimeout(800);
  const idb = (fn, arg) => p.evaluate(([src, arg]) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const tx = r.result.transaction('books', 'readwrite'); const st = tx.objectStore('books'); const q = st.getAll(); q.onsuccess = () => { const out = (0, eval)(`(${src})`)(q.result, st, arg); tx.oncomplete = () => res(out); }; }; }), [fn.toString(), arg]);
  const books = () => idb((all) => all.map((x) => ({ id: x.id, title: x.title, titles: x.titles, origTitle: x.origTitle, author: x.author, origAuthor: x.origAuthor, fileName: x.fileName })));
  const alice = (await books()).find((x) => /alice/i.test(x.fileName)); const maq = (await books()).find((x) => /maqamat/i.test(x.fileName));
  const own = alice.title; console.log('alice:', own, '|', alice.author);
  const goBook = async (id) => { await p.evaluate((i) => { location.hash = `#/book/${i}`; }, id); await p.waitForSelector('.book-hero h1'); await p.waitForTimeout(400); };
  const edit = async () => { await p.evaluate(() => [...document.querySelectorAll('.book-tile')].find((x) => /^Edit$/.test(x.textContent.trim())).click()); await p.waitForSelector('.names-shown'); await p.waitForTimeout(200); };
  const flip = (sel) => p.evaluate((s) => { const i = document.querySelector(s); i.checked = !i.checked; i.dispatchEvent(new Event('change', { bubbles: true })); }, sel);
  const rec = async (id) => (await books()).find((x) => x.id === id);

  // 1. rename keeps the old title (switch ON by default), other titles added.
  await goBook(alice.id); await edit();
  ok('Edit: the keep switch appears only once the shown title changes', await p.$eval('.names-keep', (e) => e.hidden));
  await p.fill('.names-shown', 'TitleX'); await p.waitForTimeout(100);
  ok('Edit: keep switch shown, ON by default', !(await p.$eval('.names-keep', (e) => e.hidden)) && await p.$eval('.names-keep input', (e) => e.checked));
  for (const x of ['TitleY', 'TitleZ']) { await p.fill('.names-add', x); await p.keyboard.press('Enter'); await p.waitForTimeout(80); }
  await p.screenshot({ path: path.join(shots, 'R9-edit-title.png') });
  await p.click('.names-save'); await p.waitForTimeout(700);
  let r = await rec(alice.id);
  ok('rename (switch on): shown TitleX, the old one kept, then TitleY and TitleZ; the file\'s title kept', r.title === 'TitleX' && r.titles.join('|') === `TitleX|${own}|TitleY|TitleZ` && r.origTitle === own, r);
  ok('details: the shown title and «Other titles» (three lines)', await p.$eval('.book-hero h1', (e) => e.textContent) === 'TitleX' && (await p.$$('.book-other-titles .other-title')).length === 3);
  ok('details: the original title is shown while it differs', /Original title/.test(await p.$eval('.book-orig', (e) => e.textContent).catch(() => '')));
  await p.screenshot({ path: path.join(shots, 'R9-details-titles.png') });
  // 2. rename dropping the old.
  await edit(); await p.fill('.names-shown', 'TitleW'); await p.waitForTimeout(100); await p.evaluate(() => document.querySelector('.names-keep .switch').click()); await p.waitForTimeout(100);
  ok('switch turned off', !(await p.$eval('.names-keep input', (e) => e.checked)));
  await p.click('.names-save'); await p.waitForTimeout(700); r = await rec(alice.id);
  ok('rename (switch off): TitleX is gone', r.title === 'TitleW' && !r.titles.includes('TitleX') && r.titles.includes('TitleY'), r);
  // 3. Show this one.
  await edit(); const rowsBefore = await p.$$eval('.names-other', (e) => e.map((x) => x.value));
  const at = rowsBefore.indexOf('TitleZ'); await p.click(`.names-row:nth-child(${at + 1}) .names-show`); await p.waitForTimeout(150);
  ok('Show this one: the field takes it', await p.$eval('.names-shown', (e) => e.value) === 'TitleZ');
  await p.click('.names-save'); await p.waitForTimeout(700); r = await rec(alice.id);
  ok('Show this one: TitleZ first, TitleW still among the others', r.title === 'TitleZ' && r.titles[0] === 'TitleZ' && r.titles.includes('TitleW') && r.titles.includes('TitleY'), r);
  // Remove with Undo.
  await edit(); const n0 = (await p.$$('.names-other')).length; await p.click('.names-row:last-child .names-remove'); await p.waitForTimeout(150);
  ok('remove: the row goes, with an Undo', (await p.$$('.names-other')).length === n0 - 1 && await p.$('.toast button, .toast [role=button]') !== null);
  await p.evaluate(() => (document.querySelector('.toast button') || document.querySelector('.toast [role=button]')).click()); await p.waitForTimeout(150);
  ok('Undo: the row is back', (await p.$$('.names-other')).length === n0);
  // Back to the book's own title.
  await p.click('.names-back-title'); await p.waitForTimeout(100);
  ok('Back to the book\'s own title: the field has the file\'s title', await p.$eval('.names-shown', (e) => e.value) === own);
  await p.click('.names-cancel'); await p.waitForTimeout(300);
  // 4. The author, set from Edit.
  await edit(); await p.fill('.names-author', 'Zed Quillfeather'); await p.waitForTimeout(100);
  ok('author: «Back to the book\'s own» offered', !(await p.$eval('.names-back-author', (e) => e.hidden)));
  await p.click('.names-save'); await p.waitForTimeout(700); r = await rec(alice.id);
  ok('author set; the file\'s author kept', r.author === 'Zed Quillfeather' && r.origAuthor === alice.author, r);

  // 5. Search the library: each title, the original, the set author, the original author; the «also:» line.
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view .book-card'); await p.waitForTimeout(300);
  const find = async (q) => { await p.fill('.library-view input[type=search]', q); await p.waitForTimeout(500); return p.$$eval('.book-card', (els) => els.map((e) => ({ t: e.querySelector('.bt')?.textContent, also: e.querySelector('.lib-also')?.textContent ?? '' }))); };
  let f = await find('TitleY'); ok('search: another title (TitleY) finds the book, the «also:» line names it', f.length === 1 && f[0].t === 'TitleZ' && /also: .?TitleY/.test(f[0].also), f);
  await p.screenshot({ path: path.join(shots, 'R9-search-other-title.png') });
  f = await find('TITLEW'); ok('search: another title, case folded', f.length === 1 && /TitleW/.test(f[0].also), f);
  f = await find('TitleZ'); ok('search: the shown title: no «also:» line', f.length === 1 && f[0].also === '', f);
  const word = own.split(/\s+/).sort((a, c) => c.length - a.length)[0];
  await idb((all, st, a) => { for (const x of all) if (x.id === a) { x.titles = ['TitleZ']; st.put(x); } }, alice.id); await p.reload(); await p.waitForSelector('.library-view .book-card');
  f = await find(word); ok('search: the original title (not among the titles any more)', f.some((x) => x.t === 'TitleZ'), { word, f });
  f = await find('quillfeather'); ok('search: the set author', f.length === 1 && f[0].t === 'TitleZ', f);
  const oa = (alice.author || '').split(/\s+/).sort((a, c) => c.length - a.length)[0];
  if (oa) { f = await find(oa); ok('search: the original author', f.some((x) => x.t === 'TitleZ'), { oa, f }); }
  await find('');

  // 6. The card sheet: a book without an author gains one; the card's lines change the picture.
  await idb((all, st, a) => { for (const x of all) if (x.id === a) { delete x.author; delete x.origAuthor; delete x.titles; delete x.origTitle; delete x.namesAt; x.title = 'Plain Title'; st.put(x); } }, alice.id);
  await p.evaluate((i) => { location.hash = `#/read/${i}`; }, alice.id); await p.reload(); await p.waitForSelector('.kr-content'); await p.waitForTimeout(2500);
  await p.evaluate(() => { const c = document.querySelector('.kr-content'); const el = [...c.querySelectorAll('p')].find((x) => x.textContent.trim().length > 80); el.scrollIntoView({ block: 'center' }); const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  await p.waitForTimeout(500); await p.evaluate(() => document.dispatchEvent(new Event('selectionchange'))); await p.waitForTimeout(600);
  await p.click('.sel-toolbar button:has-text("Text as image")'); await p.waitForSelector('.snap-preview'); await p.waitForTimeout(600);
  const url = () => p.$eval('.snap-preview', (c) => c.toDataURL());
  ok('card fields: title prefilled from the book; empty author shows «Add an author»', await p.$eval('.textpic-title', (e) => e.value) === 'Plain Title' && await p.$eval('.textpic-author', (e) => e.value === '' && e.placeholder === 'Add an author'));
  const u0 = await url(); await p.fill('.textpic-author', 'Mallory Pen'); await p.waitForTimeout(700); const u1 = await url();
  ok('card: the author line changes the picture', u0 !== u1);
  await p.fill('.textpic-title', 'Card Only Title'); await p.waitForTimeout(700); const u2 = await url(); ok('card: the title line changes the picture', u2 !== u1);
  await p.fill('.textpic-author', ''); await p.waitForTimeout(700); const u3 = await url(); ok('card: an empty author line is left off (a different picture)', u3 !== u2);
  await p.fill('.textpic-author', 'Mallory Pen'); await p.waitForTimeout(900);
  ok('card: the same author again redraws the same picture', await url() === u2);
  await p.screenshot({ path: path.join(shots, 'R9-card-fields.png') });
  r = await rec(alice.id); ok('«Remember for this book» (on): the book gained the author; its title unchanged', r.author === 'Mallory Pen' && r.title === 'Plain Title' && r.origAuthor === null, r);
  await p.click('.textpic-use'); await p.waitForTimeout(700); r = await rec(alice.id);
  ok('«Use as the book\'s title»: shown title set, the former one kept as another', r.title === 'Card Only Title' && r.titles.includes('Plain Title'), r);
  await p.evaluate(() => document.querySelectorAll('.sheet').forEach((x) => x.remove()));
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view .book-card'); await p.waitForTimeout(400);
  ok('the library shows the new author and title', await p.$$eval('.book-card', (els) => els.some((e) => /Card Only Title/.test(e.querySelector('.bt')?.textContent) && /Mallory Pen/.test(e.querySelector('.ba')?.textContent))));

  // 7. An old record (no new fields) loads; sort follows the shown title.
  await idb((all, st, a) => { for (const x of all) { if (x.id === a.alice) { x.title = 'Zzz Last'; delete x.titles; delete x.origTitle; delete x.namesAt; } else { x.title = 'Aaa First'; delete x.titles; delete x.origTitle; delete x.namesAt; } st.put(x); } }, { alice: alice.id });
  await p.reload(); await p.waitForSelector('.library-view .book-card'); await p.waitForTimeout(500);
  const order = await p.$$eval('.book-card .bt', (e) => e.map((x) => x.textContent)); ok('sort «Title» follows the shown title', order.indexOf('Aaa First') >= 0 && order.indexOf('Aaa First') < order.indexOf('Zzz Last'), order);
  await goBook(maq.id); await edit(); ok('an old record opens in the editor with its title', await p.$eval('.names-shown', (e) => e.value) === 'Aaa First');
  ok('no page errors', !errors.length, errors);
  await b.close(); server.close(); console.log(fails ? `${fails} FAILED` : 'all ok'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
