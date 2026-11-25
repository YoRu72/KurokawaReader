// node tests/aitranslateflow.cjs [en|ar]: the AI translator's two new ways in (src/ui/gather.ts, src/ui/translator.ts) on a phone
// (412×915, dark), against a stand-in provider answered here — no real service is ever reached.
//  A «Would you like to gather the terms?»: the question appears once and not again in the session; closed unanswered it starts nothing;
//    «Translate without», «Gather, then translate» and «Don't ask again for this book» each do what they say; the last one persists
//    across reopening the book and is undone in Glossary options; the glossary of a former volume is named, the primary action
//    reads «Check this volume for new terms», only the NEW names are added (3 found, 2 held already → 1) and said with a counted
//    message and a «Show» that opens the Glossary tab; nothing new is said too; a failing gather still lets the translation run.
//  B Starting by itself: off by default → no request when a book opens; on → one translation request for the chapter shown, none when
//    its translation is saved, none when the book's language is the target; the book's own «Never» wins, its «Always» wins over an
//    off setting; the names gathered first by themselves (never a question), «Don't gather» wins; Stop ends it for the session.
// SHOTS=dir for the pictures.
const { chromium, devices } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const LANG = process.argv[2] === 'ar' ? 'ar' : 'en'; const SHOTS = process.env.SHOTS || ''; const AR = LANG === 'ar';
const DIST = path.resolve(__dirname, '../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const out = path.join(require('os').tmpdir(), 'kr-aitranslateflow-' + LANG); fs.mkdirSync(out, { recursive: true });
// Made-up books: a chapter with a name in it (the language written in the file's metadata).
const MAKE = `import zipfile, sys
out, title, ident, lang = sys.argv[1:5]
z = zipfile.ZipFile(out, 'w'); z.writestr('mimetype', 'application/epub+zip', compress_type=zipfile.ZIP_STORED)
z.writestr('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
X = lambda body: '<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body>' + body + '</body></html>'
z.writestr('OEBPS/c1.xhtml', X('<h1>The Gate of ' + ident + '</h1><p>Lin Feng looked at the old gate of the Azure Sect for a long, long time before he spoke, and ' + ident + ' watched him.</p><p>The gate sang its old song, and the song went on into the night while he waited.</p><p>Then he walked on, alone, along the road into the hills.</p>'))
z.writestr('OEBPS/nav.xhtml', X('<nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc"><ol><li><a href="c1.xhtml">The Gate</a></li></ol></nav>'))
z.writestr('OEBPS/content.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">kr-flow-' + ident + '</dc:identifier><dc:title>' + title + '</dc:title><dc:language>' + lang + '</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>')
z.close()`;
const BOOKS = [['Gate Story Vol. 1', 'v1', 'en'], ['Gate Story Vol. 2', 'v2', 'en'], ['Gate Story Vol. 3', 'v3', 'en'], ['Mango Road', 'ta', 'en'], ['Pebble Hills', 'tb', 'en'], ['Quartz Bay', 'tc', 'en'], ['Ember Isle', 'te', 'en'], ['Violet Pass', 'af', 'en'], ['Cedar Mist', 'ag', 'en'], ['Harbor Lamp', 'ah', 'ar'], ['Willow Crest', 'an', 'en'], ['Tundra Song', 'ak', 'en'], ['Lotus Court', 'as', 'en']];
const files = BOOKS.map(([title, ident, lang]) => { const f = path.join(out, `${ident}.epub`); execFileSync('python3', ['-c', MAKE, f, title, ident, lang]); return f; });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const shot = async (p, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.waitForFunction(() => document.getAnimations().length === 0, null, { timeout: 4000 }).catch(() => undefined); await p.waitForTimeout(250); await p.screenshot({ path: path.join(SHOTS, name) }); } };
const T = { title: AR ? 'أتودّ جمع المصطلحات؟' : 'Would you like to gather the terms?', go: AR ? 'جمع المصطلحات ثم الترجمة' : 'Gather, then translate', check: AR ? 'فحص المجلد بحثًا عن مصطلحات جديدة' : 'Check this volume for new terms', skip: AR ? 'الترجمة بلا جمع' : 'Translate without', never: AR ? 'عدم السؤال ثانيةً عن هذا الكتاب' : "Don't ask again for this book", newTerms: AR ? 'أُضيفت مصطلحات جديدة. العدد: 1' : 'New terms added. Count: 1', noNew: AR ? 'لا مصطلحات جديدة: المسرد يشمل هذا الجزء' : 'No new terms: the glossary already covers this part', failed: AR ? 'تعذّر جمع المصطلحات' : 'could not be gathered', inUse: AR ? 'قيد الاستعمال' : 'is in use' };
(async () => {
  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const b = await chromium.launch(); const ctx = await b.newContext({ ...devices['Pixel 7'], viewport: { width: 412, height: 915 }, ...(process.env.DSF ? { deviceScaleFactor: +process.env.DSF } : {}), colorScheme: 'dark', locale: LANG }); const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  // The stand-in service: the names of a passage (what it finds is set by `found`; `failNames` makes it fail), and translations (`delay`).
  const reqs = []; let found = [{ from: 'Lin Feng', to: 'لين فنغ', kind: 'person' }]; let failNames = false; let delay = 0;
  await p.route('https://ai.test/v1/chat/completions', async (r) => {
    const body = JSON.parse(r.request().postData()); const system = body.messages[0].content; const user = body.messages[1].content; const names = /translation glossary/.test(system);
    reqs.push({ kind: names ? 'names' : 'tr', user });
    if (names && failNames) return r.fulfill({ status: 400, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ error: { message: 'made-up failure' } }) });
    if (delay && !names) await new Promise((res) => setTimeout(res, delay));
    const content = names ? JSON.stringify(found) : JSON.stringify(JSON.parse(user).map((x) => `AR(${x})`));
    await r.fulfill({ headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ choices: [{ message: { content } }] }) });
  });
  await p.route('https://ai.test/**', (r) => r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, GET' } }) : r.fallback());
  const count = (k) => reqs.filter((x) => x.kind === k).length;
  const setVisual = (o) => p.evaluate((o) => { const v = JSON.parse(localStorage.getItem('kr.visual') || '{}'); Object.assign(v, o); localStorage.setItem('kr.visual', JSON.stringify(v)); }, o);
  const fresh = async () => { await p.reload(); await p.waitForSelector('.library-view'); await p.waitForTimeout(500); };   // (a new session: what was asked is forgotten)
  await p.goto(`http://localhost:${port}/`);
  await p.evaluate((lang) => { localStorage.setItem('kr.lang', lang); localStorage.setItem('kr.update.lastCheck', String(Date.now())); const v = JSON.parse(localStorage.getItem('kr.visual') || '{}'); Object.assign(v, { aiProvider: 'custom', aiBaseUrl: 'https://ai.test/v1', aiKey: 'k', aiModel: 'm', aiTarget: 'ar', aiTask: 'translate', aiPrefetch: false, aiParallel: 1 }); localStorage.setItem('kr.visual', JSON.stringify(v)); }, LANG);
  await p.reload(); await p.waitForSelector('.library-view');
  await p.setInputFiles('input[type=file]', files); await p.waitForSelector('.book-card', { timeout: 60000 });
  await p.waitForFunction((n) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').count(); q.onsuccess = () => res(q.result >= n); }; }), BOOKS.length, { timeout: 60000 }); await p.waitForTimeout(1000);
  const ids = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(Object.fromEntries(q.result.map((x) => [x.title, x.id]))); }; }));
  ok('the made-up books are in the library', BOOKS.every(([t]) => !!ids[t]), Object.keys(ids));
  const meta = (key) => p.evaluate((key) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const db = r.result; const name = [...db.objectStoreNames].find((n) => /meta/i.test(n)); if (!name) return res('(no meta store)'); const q = db.transaction(name).objectStore(name).get(key); q.onsuccess = () => res(q.result === undefined ? null : (q.result && typeof q.result === 'object' && 'value' in q.result ? q.result.value : q.result)); }; }), key);
  const closeAll = () => p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim').forEach((e) => (e.__close ? e.__close() : e.remove())));
  const openBook = async (t) => { await p.evaluate((i) => { location.hash = '#/'; setTimeout(() => { location.hash = `#/read/${i}`; }, 150); }, ids[t]); await p.waitForSelector('.kr-chapter', { timeout: 30000 }); await p.waitForTimeout(1500); };
  const leave = async () => { await closeAll(); await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.waitForTimeout(400); };
  // The bar's button — or, the first time, the reader's translate command (builds the bar).
  const press = async () => { if (await p.$('.tr-pill:not([hidden]) .tr-toggle')) await p.click('.tr-pill .tr-toggle'); else await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'translate' }))); };
  const quiet = async (ms = 2200) => { await p.waitForTimeout(ms); };
  const sheet = () => p.$('.gather-sheet');
  const waitSheet = () => p.waitForSelector('.gather-sheet .gather-go', { timeout: 15000 });
  const waitTr = (n = 1) => p.waitForFunction(() => document.querySelectorAll('.kr-chapter .kr-translated').length >= 2, null, { timeout: 20000 }).then(() => true, () => false);

  /* ---------- A: the question ---------- */
  await openBook('Mango Road');
  const before0 = reqs.length; await press(); await waitSheet();
  ok('a translation started with the setting on «Ask»: the question appears, nothing asked of the service yet', !!(await sheet()) && reqs.length === before0);
  const q = await p.evaluate(() => { const s = document.querySelector('.gather-sheet'); const r = (e) => e.getBoundingClientRect(); const row = [...s.querySelectorAll('.gather-acts-row .btn')]; const nv = s.querySelector('.gather-never'); const seg = [...s.querySelectorAll('.gather-scope button')];
    const rowR = r(s.querySelector('.gather-acts-row')), segR = r(s.querySelector('.gather-scope'));
    return { edges: [Math.round(rowR.left - segR.left), Math.round(rowR.right - segR.right)], title: s.querySelector('.sheet-head h3').textContent, btns: row.map((x) => [Math.round(r(x).width), Math.round(r(x).height), x.textContent]), never: [Math.round(r(nv).width), Math.round(r(nv).height), nv.textContent], scope: seg.map((x) => [x.textContent, x.getAttribute('aria-pressed'), Math.round(r(x).height)]), cost: !!s.querySelector('.gather-cost'), why: !!s.querySelector('.gather-why'), over: s.scrollWidth > s.clientWidth + 1, order: [...s.querySelectorAll('.sheet-actions button')].map((x) => x.className.match(/gather-(go|skip|never)/)?.[1]), vol: !!s.querySelector('.gather-volume') }; });
  console.log('question:', JSON.stringify(q));
  ok('titled «Would you like to gather the terms?», no explanation line (the owner removed it)', q.title === T.title && !q.why);
  ok('the three actions in their order: gather, translate without, don\'t ask again', q.order.join() === 'go,skip,never' && q.btns[0][2] === T.go && q.btns[1][2] === T.skip && q.never[2] === T.never, q);
  ok('the two buttons as wide as each other, every target at least 40 px high', Math.abs(q.btns[0][0] - q.btns[1][0]) <= 1 && q.btns.every((x) => x[1] >= 40) && q.never[1] >= 40 && q.scope.every((x) => x[2] >= 40), q);
  ok('the scope: this chapter chosen first, the whole book offered; no cost line (the owner removed it)', q.scope.length === 2 && q.scope[0][1] === 'true' && q.scope[1][1] === 'false' && !q.cost && !q.over, q.cost);
  ok('the two-button row has the same left and right edges as the scope row above it', Math.abs(q.edges[0]) <= 1 && Math.abs(q.edges[1]) <= 1, q.edges);
  const ws = await p.evaluate(() => { const s = document.querySelector('.gather-sheet'); const f = (e) => { const c = getComputedStyle(e); return Math.round(parseFloat(c.wordSpacing) / parseFloat(getComputedStyle(document.body).fontSize) * 100) / 100; }; return [f(s.querySelector('.sheet-head h3')), f(s.querySelector('.gather-go')), f(s.querySelector('.gather-never')), f(s.querySelector('.gather-scope button'))]; });
  ok(AR ? 'Arabic: the sheet\'s title and buttons keep the interface word spacing (.16em of the page size) inside the reading view' : 'English: no word spacing on the sheet', AR ? ws.every((x) => Math.abs(x - 0.16) <= 0.01) : ws.every((x) => x === 0), ws);
  ok('no glossary of a former volume: no such line', !q.vol);
  await shot(p, `S3-gather-${LANG}.png`);
  await p.keyboard.press('Escape'); await quiet(1500);
  ok('Esc: nothing starts (no request, bar off)', !(await sheet()) && reqs.length === before0 && (await p.$eval('.tr-pill .tr-toggle', (e) => e.getAttribute('aria-pressed'))) === 'false');
  await press(); await waitSheet(); ok('closed unanswered, it is asked again', true);
  await p.click('.gather-skip'); ok('«Translate without»: the translation runs', await waitTr());
  ok('…with no names asked for', count('names') === 0 && count('tr') >= 1);
  const nTr = count('tr'); await p.click('.tr-pill .tr-toggle'); await p.waitForTimeout(400); await press(); await p.waitForTimeout(1500);
  ok('the same chapter again in this session: not asked twice', !(await sheet()));
  ok('the book stays on «Ask»', (await meta(`trGather:${ids['Mango Road']}`)) === null);
  void nTr;

  /* ---------- A: gather, then translate (the book stays on Ask) ---------- */
  await leave(); await fresh(); await openBook('Pebble Hills'); await press(); await waitSheet(); const rB = reqs.length; await p.click('.gather-go');
  ok('«Gather, then translate»: the names asked first, then the translation', await waitTr() && reqs.slice(rB).map((x) => x.kind).join() === 'names,tr', reqs.slice(rB).map((x) => x.kind));
  const g1 = await p.evaluate(() => JSON.parse(localStorage.getItem('kr.glossary') || '[]'));
  ok('the name found is in this book\'s glossary', g1.some((x) => x.from === 'Lin Feng' && !!x.book), g1);
  ok('the book stays on «Ask» (nothing ticked, nothing remembered)', (await meta(`trGather:${ids['Pebble Hills']}`)) === null);

  /* ---------- A: don't ask again ---------- */
  await leave(); await fresh(); await openBook('Quartz Bay'); const nm = count('names'); await press(); await waitSheet(); await p.click('.gather-never');
  ok('«Don\'t ask again»: the translation runs, no names gathered now', await waitTr() && count('names') === nm);
  await p.waitForTimeout(500); ok('…kept with the book as «Don\'t gather»', (await meta(`trGather:${ids['Quartz Bay']}`)) === 'never', await meta(`trGather:${ids['Quartz Bay']}`));
  await leave(); await fresh(); await openBook('Quartz Bay'); await p.click('.tr-pill .tr-toggle').catch(() => undefined); await p.waitForTimeout(300);
  await p.evaluate(() => { const on = document.querySelector('.tr-pill .tr-toggle')?.getAttribute('aria-pressed') === 'true'; if (on) document.querySelector('.tr-pill .tr-toggle').click(); }); await p.waitForTimeout(300);
  await press(); await p.waitForTimeout(1500);
  ok('reopened: not asked any more', !(await sheet()));
  // Undone in Glossary options.
  await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'glossary' }))); await p.waitForSelector('.ai-sheet .gloss-opts summary', { timeout: 10000 }); await p.click('.ai-sheet .gloss-opts summary');
  await p.waitForSelector('.gloss-gather-mode button', { timeout: 8000 });
  const modes = await p.$$eval('.gloss-gather-mode button', (e) => e.map((x) => [x.textContent, x.getAttribute('aria-pressed'), x.dataset.v]));
  ok('Glossary options: «Before translating» with three choices, «Don\'t gather» pressed', modes.length === 3 && modes.find((x) => x[2] === 'never')[1] === 'true' && modes.map((x) => x[2]).join() === 'ask,always,never', modes);
  await p.click('.gloss-gather-mode button[data-v="ask"]'); await p.waitForTimeout(400);
  ok('set back to «Ask»: kept with the book', (await meta(`trGather:${ids['Quartz Bay']}`)) === 'ask');
  await leave();
  await p.evaluate((id) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const tx = r.result.transaction('meta', 'readwrite'); const st = tx.objectStore('meta'); for (const k of ['tr', 'trs', 'trKeep', 'glossScan']) st.delete(`${k}:${id}`); st.delete(`glossScan:${id}:ar`); tx.oncomplete = () => res(); }; }), ids['Quartz Bay']);
  await fresh(); await openBook('Quartz Bay'); await p.evaluate(() => document.querySelector('.tr-pill .tr-toggle')?.getAttribute('aria-pressed') === 'true' && document.querySelector('.tr-pill .tr-toggle').click()); await p.waitForTimeout(300);
  await press(); await p.waitForSelector('.gather-sheet', { timeout: 15000 }).then(() => ok('and the question is asked again', true), () => ok('and the question is asked again', false));
  await closeAll();

  /* ---------- A: the glossary of a former volume; only new names; counted ---------- */
  await leave(); await fresh();
  await p.evaluate(([a, b]) => {
    localStorage.setItem('kr.glossaryFolders', JSON.stringify([{ id: 'f1', name: 'Gate Story' }]));
    localStorage.setItem('kr.glossary', JSON.stringify([{ id: 't1', from: 'Lin Feng', to: 'لين فنغ', folder: 'f1', kind: 'person', lang: 'ar' }, { id: 't2', from: 'Iron Palm', to: 'كفّ الحديد', folder: 'f1', kind: 'skill', lang: 'ar' }]));
    localStorage.setItem('kr.glossaryLinks', JSON.stringify({ [a]: ['f1'], [b]: ['f1'] })); localStorage.setItem('kr.glossaryDest', JSON.stringify({ [b]: { to: 'f1', addNew: true } }));
    localStorage.setItem('kr.glossaryVol', JSON.stringify({ [b]: { choice: 'share', from: a } }));
  }, [ids['Gate Story Vol. 1'], ids['Gate Story Vol. 2']]);
  found = [{ from: 'Lin Feng', to: 'لين فنغ', kind: 'person' }, { from: 'Iron Palm', to: 'كفّ الحديد', kind: 'skill' }, { from: 'Azure Sect', to: 'الطائفة اللازوردية', kind: 'group' }];
  await openBook('Gate Story Vol. 2'); await press(); await waitSheet();
  const v = await p.evaluate(() => ({ line: document.querySelector('.gather-volume')?.textContent ?? '', go: document.querySelector('.gather-go').textContent, skip: document.querySelector('.gather-skip').textContent }));
  console.log('volume:', JSON.stringify(v));
  ok('the former volume\'s glossary is named', v.line.includes('Gate Story Vol. 1') && v.line.includes(T.inUse), v);
  ok('the primary action reads «Check this volume for new terms»', v.go === T.check, v);
  if (!AR) await shot(p, 'S3-gather-volume.png');
  await p.click('.gather-go'); await p.waitForSelector('.toast.has-action', { timeout: 25000 });
  const msg = await p.$eval('.toast .toast-text', (e) => e.textContent); console.log('toast:', msg);
  ok('three found, two held already: only the new one added, said with a count', msg.includes(T.newTerms) || msg === T.newTerms, msg);
  const g2 = await p.evaluate(() => JSON.parse(localStorage.getItem('kr.glossary') || '[]'));
  ok('the glossary holds 3 terms, the new one in the shared folder, the old ones not doubled', g2.length === 3 && g2.filter((x) => x.from === 'Lin Feng').length === 1 && g2.find((x) => x.from === 'Azure Sect')?.folder === 'f1', g2.map((x) => [x.from, x.folder]));
  if (!AR) await shot(p, 'S3-new-terms-pill.png');
  await p.click('.toast .toast-action'); await p.waitForSelector('.ai-sheet .ai-tab[data-tab="glossary"][aria-selected="true"]', { timeout: 8000 });
  ok('«Show» opens the Glossary tab', true); await closeAll();
  // The next volume shares the same glossary and finds nothing new.
  await leave(); await fresh();
  await p.evaluate(([a, c]) => { const l = JSON.parse(localStorage.getItem('kr.glossaryLinks')); l[c] = ['f1']; localStorage.setItem('kr.glossaryLinks', JSON.stringify(l)); const d = JSON.parse(localStorage.getItem('kr.glossaryDest')); d[c] = { to: 'f1', addNew: true }; localStorage.setItem('kr.glossaryDest', JSON.stringify(d)); const v = JSON.parse(localStorage.getItem('kr.glossaryVol')); v[c] = { choice: 'share', from: a }; localStorage.setItem('kr.glossaryVol', JSON.stringify(v)); }, [ids['Gate Story Vol. 1'], ids['Gate Story Vol. 3']]);
  await openBook('Gate Story Vol. 3'); await press(); await waitSheet(); await p.click('.gather-go'); await p.waitForSelector('.toast', { timeout: 25000 });
  const msg2 = await p.$eval('.toast .toast-text', (e) => e.textContent);
  ok('nothing new: said so', msg2 === T.noNew, msg2);
  ok('…and nothing added', (await p.evaluate(() => JSON.parse(localStorage.getItem('kr.glossary') || '[]').length)) === 3);

  /* ---------- A: a failing gather still lets the translation run ---------- */
  await leave(); await fresh(); failNames = true; found = [{ from: 'Lin Feng', to: 'لين فنغ', kind: 'person' }];
  await openBook('Ember Isle'); await press(); await waitSheet(); const trBefore = count('tr'); await p.click('.gather-go');
  await p.waitForSelector('.gather-failed', { timeout: 30000 });
  const fl = await p.evaluate(() => ({ text: document.querySelector('.gather-failed').textContent, btn: [...document.querySelectorAll('.gather-sheet .sheet-actions button')].map((x) => x.textContent) }));
  ok('failed: said in one line, with «Translate without» offered', fl.text.includes(T.failed) && fl.btn.length === 1 && fl.btn[0] === T.skip, fl);
  ok('…the translation not started behind it', count('tr') === trBefore);
  await p.click('.gather-skip'); ok('«Translate without»: the translation runs', await waitTr() && count('tr') > trBefore); failNames = false;

  /* ---------- B: starting by itself ---------- */
  await leave(); await fresh(); found = [{ from: 'Lin Feng', to: 'لين فنغ', kind: 'person' }];
  let r0 = reqs.length; await openBook('Violet Pass'); await quiet(2500);
  ok('the setting off (the default): no request when a book opens, no question, no bar', reqs.length === r0 && !(await sheet()) && !(await p.$('.tr-pill')));
  await leave(); await setVisual({ aiAutoStart: true, aiAutoGather: false }); await fresh();
  r0 = reqs.length; await openBook('Cedar Mist'); ok('on: the chapter shown is translated', await waitTr()); await quiet(800);
  ok('…by exactly one request, no names asked for, no question', count('tr') - 0 >= 1 && reqs.slice(r0).filter((x) => x.kind === 'tr').length === 1 && reqs.slice(r0).every((x) => x.kind === 'tr') && !(await sheet()), reqs.slice(r0).map((x) => x.kind));
  ok('…the bar shows it, with its button to stop', !!(await p.$('.tr-pill .tr-toggle')) && (await p.$eval('.tr-pill .tr-toggle', (e) => e.getAttribute('aria-pressed'))) === 'true');
  await leave(); await fresh(); r0 = reqs.length; await openBook('Cedar Mist'); await quiet(2500);
  ok('its translation saved: nothing asked again, the chapter simply shown translated', reqs.length === r0 && (await p.$$eval('.kr-chapter .kr-translated', (e) => e.length)) >= 2);
  await leave(); await fresh(); r0 = reqs.length; await openBook('Harbor Lamp'); await quiet(2500);
  ok('a book already in the target language: nothing asked', reqs.length === r0 && !(await p.$('.tr-pill.on, .tr-pill .tr-toggle.on')));
  // The book's own choice, in the AI sheet's Translation tab.
  const bookRow = async (v) => { await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'glossary' }))); await p.waitForSelector('.ai-sheet .ai-tab', { timeout: 10000 }); await p.click('.ai-sheet .ai-tab[data-tab="translation"]'); await p.waitForSelector('.tr-auto-book button', { timeout: 8000 }); await p.click(`.tr-auto-book button[data-v="${v}"]`); await p.waitForTimeout(300); };
  await leave(); await fresh(); await setVisual({ aiAutoStart: false }); await fresh();
  await openBook('Willow Crest'); await bookRow('never'); await closeAll(); await leave(); await setVisual({ aiAutoStart: true }); await fresh();
  r0 = reqs.length; await openBook('Willow Crest'); await quiet(2500);
  ok('the setting on, the book on «Never»: nothing starts', reqs.length === r0 && !(await p.$('.tr-pill .tr-toggle.on')));
  ok('…«Never» is kept with the book', (await meta(`trAuto:${ids['Willow Crest']}`)) === 'never');
  await bookRow('always'); await closeAll(); await leave(); await setVisual({ aiAutoStart: false }); await fresh();
  r0 = reqs.length; await openBook('Willow Crest'); ok('the setting off, the book on «Always»: it starts', await waitTr());
  ok('…by one request for the chapter shown', reqs.slice(r0).filter((x) => x.kind === 'tr').length === 1, reqs.slice(r0).map((x) => x.kind));
  // The settings rows themselves.
  await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'glossary' }))); await p.waitForSelector('.ai-sheet .ai-tab', { timeout: 10000 }); await p.click('.ai-sheet .ai-tab[data-tab="translation"]'); await p.waitForSelector('.tr-auto-start', { timeout: 8000 });
  const sw = await p.evaluate(() => ({ start: document.querySelector('.tr-auto-start input').checked, gatherShown: !document.querySelector('.tr-auto-sub').hidden, def: [...document.querySelectorAll('.tr-gather-default button')].map((x) => [x.dataset.v, x.getAttribute('aria-pressed')]), book: [...document.querySelectorAll('.tr-auto-book button')].map((x) => [x.dataset.v, x.getAttribute('aria-pressed')]) }));
  ok('the AI settings: «Start by itself» off, its gather switch hidden, «Before translating» on «Ask», the book on «Always»', !sw.start && !sw.gatherShown && sw.def.find((x) => x[1] === 'true')[0] === 'ask' && sw.book.find((x) => x[1] === 'true')[0] === 'always', sw);
  await p.click('.tr-auto-start'); await p.waitForTimeout(300); // (the gather switch: on unless it was switched off — an earlier step did, so look at the stored value)
  const sw2 = await p.evaluate(() => ({ start: document.querySelector('.tr-auto-start input').checked, sub: !document.querySelector('.tr-auto-sub').hidden, gather: document.querySelector('.tr-auto-gather input').checked }));
  ok('switched on: the gather switch appears (showing what is stored)', sw2.start && sw2.sub && sw2.gather === ((await p.evaluate(() => JSON.parse(localStorage.getItem('kr.visual')).aiAutoGather)) !== false), sw2);
  await p.evaluate(() => document.querySelector('.ai-sheet .sheet-body')?.scrollTo(0, 0)); await p.locator('.tr-auto-start').scrollIntoViewIfNeeded(); if (!AR) await shot(p, 'S3-auto-settings.png');
  await p.click('.tr-gather-default button[data-v="never"]'); await p.waitForTimeout(300);
  ok('the default «Don\'t gather» kept in the settings', (await p.evaluate(() => JSON.parse(localStorage.getItem('kr.visual')).aiGatherNames)) === 'never');
  await p.click('.tr-gather-default button[data-v="ask"]'); await closeAll();
  // Gathered by itself first (never a question); «Don't gather» wins.
  await leave(); await setVisual({ aiAutoStart: true, aiAutoGather: true, aiGatherNames: 'ask' }); await fresh();
  r0 = reqs.length; await openBook('Tundra Song'); await waitTr(); await quiet(500);
  const seq = reqs.slice(r0).map((x) => x.kind);
  ok('the names gathered by themselves first, then the chapter translated, no question', seq[0] === 'names' && seq.filter((k) => k === 'tr').length === 1 && !(await sheet()), seq);
  await leave(); await setVisual({ aiAutoStart: false }); await fresh(); await openBook('Lotus Court');
  await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'glossary' }))); await p.waitForSelector('.ai-sheet .gloss-opts summary', { timeout: 10000 }); await p.click('.ai-sheet .gloss-opts summary'); await p.waitForSelector('.gloss-gather-mode button'); await p.click('.gloss-gather-mode button[data-v="never"]'); await p.waitForTimeout(300); await closeAll();
  await leave(); await setVisual({ aiAutoStart: true }); await fresh();
  r0 = reqs.length; await openBook('Lotus Court'); await waitTr(); await quiet(500);
  const seq2 = reqs.slice(r0).map((x) => x.kind);
  ok('«Don\'t gather» for the book wins: no names, the chapter translated', seq2.length === 1 && seq2[0] === 'tr', seq2);
  // Stop ends it for the session.
  await leave(); await setVisual({ aiAutoStart: true, aiAutoGather: false }); await fresh(); delay = 2500;
  await p.evaluate(() => { const l = JSON.parse(localStorage.getItem('kr.visual') || '{}'); void l; });
  const stopBook = 'Violet Pass'; r0 = reqs.length; await openBook(stopBook);
  await p.waitForFunction((n) => true, 0); for (let i = 0; i < 40 && reqs.length === r0; i++) await p.waitForTimeout(250);
  ok('on, a slow service: the translation is under way', reqs.length === r0 + 1 && (await p.$eval('.tr-pill .tr-toggle', (e) => e.getAttribute('aria-pressed'))) === 'true');
  await p.click('.tr-pill .tr-toggle'); await p.waitForTimeout(400); delay = 0;
  ok('Stop: the bar is off', (await p.$eval('.tr-pill .tr-toggle', (e) => e.getAttribute('aria-pressed'))) === 'false');
  const rs = reqs.length; await leave(); await openBook(stopBook); await quiet(3000);
  ok('…and the book is not started again by itself in this session', reqs.length === rs && !(await p.$('.tr-pill .tr-toggle.on')));
  ok('no page errors', errors.length === 0, errors.slice(0, 3));
  await b.close(); server.close();
  console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
