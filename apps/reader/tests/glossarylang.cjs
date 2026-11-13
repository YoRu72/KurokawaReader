// node tests/glossarylang.cjs [shots dir]: the glossary follows the language translated into (src/glossary.ts,
// src/ai.ts, src/ui/glossarysheet.ts), against a stand-in AI provider answered here (no network):
//  1. into Arabic with a name kept in English letters (as «Arabic» by mistake, and as English): the Arabic
//     translation does not get the English name, the model is told to write names in Arabic, and the glossary it is
//     given holds no Latin rendering;
//  2. the name finder's rendering in Latin letters for Arabic is asked again, then left out — not saved;
//  3. Arabic → Japanese → French: each language's own term used, the others' kept;
//  4. an old term without a language kept as it was, shown as «language not set»;
//  5. Retranslate one entry, the ticked ones, every one shown: the instructions edited are what is sent and are
//     remembered (the language kept as «{lang}»), reset to the default; Stop; Undo; renderings not in Arabic
//     refused and counted; a provider's error and no connection change nothing; only the paragraphs holding a
//     changed name are translated again;
//  6. the box in English and in Arabic (right to left), screenshots at 412×915.
// The book and every answer are made here.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os'); const { execFileSync } = require('child_process');
const DIST = path.resolve(__dirname, '../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const shots = process.argv[2] || path.join(os.tmpdir(), 'kr-glossarylang'); fs.mkdirSync(shots, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-glang-')); const book = path.join(work, 'names.epub');
execFileSync('python3', ['-c', `
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1], 'w'); z.writestr('mimetype', 'application/epub+zip', compress_type=zipfile.ZIP_STORED)
z.writestr('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
X = lambda body, title: '<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>%s</title></head><body>%s</body></html>' % (title, body)
z.writestr('OEBPS/c1.xhtml', X('<p>Keyaru met Flare at the gate.</p><p>The wind was cold that night.</p><p>Setsuna waited by the fire.</p>', 'One'))
z.writestr('OEBPS/c2.xhtml', X('<p>The road went on into the hills.</p>', 'Two'))
z.writestr('OEBPS/nav.xhtml', X('<nav epub:type="toc"><ol><li><a href="c1.xhtml">One</a></li><li><a href="c2.xhtml">Two</a></li></ol></nav>', 'Contents'))
z.writestr('OEBPS/content.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">kr-glossarylang-test</dc:identifier><dc:title>Names Story</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>')
z.close()`, book]);
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 600))); if (!c) fails++; };

// The stand-in model. A translation: the names as the glossary given gives them; else as the language named in
// the instructions writes them; else — told nothing — left in English letters (what a model does with a name it
// was not told about). The name finder: Latin «renderings» for Arabic at first (and for one name, again).
const AR = { Keyaru: 'كيارو', Flare: 'فلير', Setsuna: 'سيتسونا' }, AR2 = { Keyaru: 'كيارُو', Flare: 'فلِير', Setsuna: 'سيتسُونا' }, JA = { Keyaru: 'ケヤル', Flare: 'フレア', Setsuna: 'セツナ' };
const NAMES = ['Keyaru', 'Flare', 'Setsuna'];
function modelTranslate(system, text) {
  const gl = {}; for (const m of system.matchAll(/^- "(.+?)" → "(.+?)"$/gm)) gl[m[1]] = m[2];
  const lang = /as it is written in (\w+)/.exec(system)?.[1];
  let out = text; for (const n of NAMES) out = out.split(n).join(gl[n] ?? (lang === 'Arabic' ? AR[n] : lang === 'Japanese' ? JA[n] : n));
  return `[${lang ?? '?'}] ${out}`;
}

(async () => {
  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'en' }); const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  const asked = []; const st = { retr: 0, slow: 0, fail: 0, latin: new Set(), second: false, gotRetr: 0 };
  await p.route('https://ai.test/v1/chat/completions', async (r) => {
    const body = JSON.parse(r.request().postData()); const system = body.messages[0].content; const user = body.messages[1].content;
    const kind = /Target language:/.test(system) ? 'retr' : /translation glossary|were not written in/.test(system) ? 'find' : 'tr';
    asked.push({ kind, system, user });
    if (kind === 'retr' && st.fail) return r.fulfill({ status: 401, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: '{"error":{"message":"invalid key"}}' });
    let content;
    if (kind === 'find') {
      // (First: Keyaru and Setsuna in Latin letters, Flare in Arabic; asked again: Setsuna in Arabic, Keyaru still Latin.)
      content = JSON.stringify(/were not written in/.test(system) ? [{ from: 'Setsuna', to: 'سيتسونا', kind: 'person' }, { from: 'Keyaru', to: 'Keyaru', kind: 'person' }] : [{ from: 'Keyaru', to: 'Keyaru', kind: 'person' }, { from: 'Flare', to: 'فلير', kind: 'person' }, { from: 'Setsuna', to: 'Setsuna', kind: 'person' }]);
    } else if (kind === 'retr') {
      st.gotRetr++;
      if (st.slow) await new Promise((res) => setTimeout(res, st.slow));
      const items = JSON.parse(user); const map = st.second ? AR2 : AR;
      content = JSON.stringify(items.map((x) => ({ from: x.from, to: st.latin.has(x.from) ? x.from : map[x.from] ?? `اسم ${x.from.replace(/\D/g, '')}` })));
    } else content = JSON.stringify(JSON.parse(user).map((x) => modelTranslate(system, x)));
    await r.fulfill({ headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ choices: [{ message: { content } }] }) });
  });
  await p.route('https://ai.test/**', (r) => r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, GET' } }) : r.fallback());
  const setVisual = (o) => p.evaluate((o) => { const v = JSON.parse(localStorage.getItem('kr.visual') || '{}'); Object.assign(v, o); localStorage.setItem('kr.visual', JSON.stringify(v)); }, o);
  await p.goto(`http://localhost:${port}/`);
  await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); });
  await setVisual({ aiProvider: 'custom', aiBaseUrl: 'https://ai.test/v1', aiKey: 'k', aiModel: 'm', aiTarget: 'ar', aiTask: 'translate', aiAutoGlossary: true, aiPrefetch: false, aiParallel: 1 });
  await p.reload(); await p.waitForSelector('.library-view');
  await p.setInputFiles('input[type=file]', [book]); await p.waitForSelector('.book-card', { timeout: 60000 }); await p.waitForTimeout(1000);
  const id = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result[0].id); }; }));
  // The glossary as a reader might have it: «Keyaru» kept as Arabic in English letters (the bug), and as English;
  // an old term made before languages were kept; forty more for every book (for Retranslate's batches).
  const seed = [
    { id: 'tk-ar', from: 'Keyaru', to: 'Keyaru', lang: 'ar', kind: 'person', book: id, auto: true },
    { id: 'tk-en', from: 'Keyaru', to: 'Keyaru', lang: 'en', kind: 'person', book: id },
    { id: 'tk-ja', from: 'Keyaru', to: 'ケヤルガ', lang: 'ja', kind: 'person', book: id },
    { id: 'tk-fr', from: 'Keyaru', to: 'Kéyaru', lang: 'fr', kind: 'person', book: id },
    { id: 'old1', from: 'Old Gate', to: 'Old Gate', kind: 'place', book: id },
    ...Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, from: `Name${String(i).padStart(2, '0')}`, to: `Name${String(i).padStart(2, '0')}`, lang: 'ar', kind: 'person' })),
  ];
  await p.evaluate((s) => localStorage.setItem('kr.glossary', JSON.stringify(s)), seed);
  const gloss = () => p.evaluate(() => JSON.parse(localStorage.getItem('kr.glossary') || '[]'));
  const byId = async (i) => (await gloss()).find((x) => x.id === i);
  const trTexts = () => p.$$eval('.kr-chapter p.kr-translated', (e) => e.map((x) => x.textContent));
  /** The book opened (again) and translated into the language chosen now. */
  async function openTranslated(minDone = 3) {
    await p.reload(); await p.waitForSelector('.library-view, .kr-chapter');
    await p.evaluate((i) => { location.hash = `#/read/${i}`; }, id); await p.waitForSelector('.kr-chapter', { timeout: 30000 }); await p.waitForTimeout(1500);
    if (await p.$('.tr-pill:not([hidden]) .tr-toggle')) await p.click('.tr-pill .tr-toggle');
    else await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'translate' })));
    await p.waitForSelector('.tr-pill', { timeout: 10000 });
    await p.waitForFunction((n) => document.querySelectorAll('.kr-chapter p.kr-translated').length >= n, minDone, { timeout: 20000 });
    await p.waitForTimeout(400);
  }

  // ---- 1, 2: into Arabic ----
  await openTranslated();
  const ar1 = await trTexts(); console.log('into Arabic:', JSON.stringify(ar1));
  ok('into Arabic: no English name in the translation', ar1.length >= 3 && ar1.every((x) => !/Keyaru|Flare|Setsuna/.test(x)), ar1);
  ok('… the name rendered in Arabic', ar1.some((x) => x.includes('كيارو')), ar1);
  const tr1 = asked.find((a) => a.kind === 'tr' && /Keyaru/.test(a.user));
  ok('the model told to write names in Arabic, in the Arabic script', !!tr1 && /as it is written in Arabic in the Arabic script/.test(tr1.system), tr1?.system);
  ok('… and given no Latin rendering of the name in the glossary', !!tr1 && !/"Keyaru" → "Keyaru"/.test(tr1.system), tr1?.system);
  const find1 = asked.find((a) => a.kind === 'find');
  ok('the name finder asked for Arabic by name and its script', !!find1 && /translation into Arabic \(language code ar\)/.test(find1.system) && /Arabic script/.test(find1.system), find1?.system.slice(0, 300));
  ok('… a Latin rendering asked for again', asked.some((a) => a.kind === 'find' && /were not written in Arabic/.test(a.system)));
  const g1 = await gloss(); console.log('found:', JSON.stringify(g1.filter((x) => x.auto && x.id !== 'tk-ar').map((x) => [x.from, x.to, x.lang])));
  ok('the finder\'s Latin rendering for Arabic not saved («Keyaru» left out)', !g1.some((x) => x.from === 'Keyaru' && x.to === 'Keyaru' && x.lang === 'ar' && x.id !== 'tk-ar'), g1.filter((x) => x.from === 'Keyaru'));
  ok('… the ones in Arabic saved under Arabic (Flare; Setsuna once asked again)', g1.some((x) => x.from === 'Flare' && x.to === 'فلير' && x.lang === 'ar') && g1.some((x) => x.from === 'Setsuna' && x.to === 'سيتسونا' && x.lang === 'ar'), g1.filter((x) => x.auto));
  ok('the English and the mis-picked terms still kept as they were', (await byId('tk-en'))?.to === 'Keyaru' && (await byId('tk-ar'))?.to === 'Keyaru');

  // ---- 5: Retranslate one entry (the mis-picked one), the instructions edited ----
  await p.click('.tr-pill button[aria-label="More"]'); await p.locator('.sheet .dest-row', { hasText: 'Translation glossary' }).click();
  await p.waitForSelector('.gloss-sheet .gloss-row[data-id="tk-ar"]');
  await p.waitForTimeout(700); await p.locator('.gloss-row[data-id="tk-ar"]').scrollIntoViewIfNeeded(); await p.screenshot({ path: path.join(shots, 'glossary-en.png') });
  ok('the mis-picked term shown as not written in Arabic', /Not written in Arabic/.test(await p.textContent('.gloss-row[data-id="tk-ar"]')));
  ok('the old term shown with its language not set', /Language not set/.test(await p.$eval('.gloss-row[data-id="old1"] .gloss-lang', (e) => e.selectedOptions[0]?.textContent)));
  await p.click('.gloss-row[data-id="tk-ar"] button[aria-label="Retranslate this entry"]');
  await p.waitForSelector('.gloss-retr-sheet .gloss-retr-prompt');
  const def = await p.inputValue('.gloss-retr-prompt');
  ok('the box prefilled with the default naming the language chosen', /into Arabic/.test(def) && /Arabic script/.test(def), def);
  ok('… one entry', /Entries: 1/.test(await p.textContent('.gloss-retr-info')));
  await p.waitForTimeout(800); await p.screenshot({ path: path.join(shots, 'retranslate-en.png') });   // (the sheet's rise over)
  const edited = def + ' Prefer classical forms. MARK-ONE';
  await p.fill('.gloss-retr-prompt', edited);
  const before1 = asked.length; await p.click('.gloss-retr-go');
  await p.waitForSelector('.gloss-retr-report .gloss-retr-line');
  const r1 = asked.slice(before1).find((a) => a.kind === 'retr');
  ok('the instructions as edited are what is sent', !!r1 && r1.system.startsWith(edited.trim()) && /Target language: Arabic \(language code ar\)/.test(r1.system), r1?.system);
  const kept = await p.evaluate(() => JSON.parse(localStorage.getItem('kr.visual') || '{}').aiGlossPrompt);
  ok('… remembered (the language kept as «{lang}»)', /MARK-ONE/.test(kept) && /\{lang\}/.test(kept) && !/Arabic/.test(kept), kept);
  ok('the entry now in Arabic', (await byId('tk-ar'))?.to === 'كيارو' && (await byId('tk-ar'))?.lang === 'ar');
  ok('… its English twin untouched', (await byId('tk-en'))?.to === 'Keyaru' && (await byId('tk-en'))?.lang === 'en');
  ok('… the report says one changed', /Renderings changed: 1/.test(await p.textContent('.gloss-retr-report')));
  await p.click('.gloss-retr-cancel');   // (Close.)
  await p.waitForSelector('.gloss-retr-sheet', { state: 'detached' });

  // ---- Selected: two ticked, one answer in Latin refused and counted; Undo ----
  st.second = true; st.latin = new Set(['Setsuna']);
  await p.waitForSelector('.gloss-row[data-id="tk-en"] .gloss-sel');
  await p.check('.gloss-row[data-id="tk-en"] .gloss-sel');
  const setsuna = (await gloss()).find((x) => x.from === 'Setsuna'); await p.check(`.gloss-row[data-id="${setsuna.id}"] .gloss-sel`);
  ok('the bar counts the ones ticked', (await p.textContent('.gloss-retr-sel')).includes('2'));
  await p.click('.gloss-retr-sel'); await p.waitForSelector('.gloss-retr-sheet .gloss-retr-prompt');
  const again = await p.inputValue('.gloss-retr-prompt');
  ok('the box opens with the instructions remembered, the language named', /MARK-ONE/.test(again) && /into Arabic/.test(again), again);
  const before2 = asked.length; await p.click('.gloss-retr-go'); await p.waitForSelector('.gloss-retr-report .gloss-retr-line');
  const rep2 = await p.textContent('.gloss-retr-report'); console.log('selected:', rep2);
  ok('the edited instructions sent again', asked.slice(before2).some((a) => a.kind === 'retr' && /MARK-ONE/.test(a.system)));
  ok('a rendering not in Arabic refused and counted', /Refused, not written in Arabic: 1/.test(rep2), rep2);
  ok('… that entry keeps its old rendering', (await gloss()).find((x) => x.id === setsuna.id)?.to === 'سيتسونا');
  ok('the English term retranslated into Arabic: its Arabic twin changed, the English one kept', (await byId('tk-ar'))?.to === 'كيارُو' && (await byId('tk-en'))?.to === 'Keyaru');
  await p.click('.gloss-retr-undo2'); await p.waitForTimeout(200);
  ok('Undo: the glossary back as it was', (await byId('tk-ar'))?.to === 'كيارو' && (await byId('tk-en'))?.to === 'Keyaru');
  await p.click('.gloss-retr-cancel'); await p.waitForSelector('.gloss-retr-sheet', { state: 'detached' });

  // ---- All shown (every book's forty), in batches; reset to the default; Stop; Undo ----
  st.latin = new Set(); st.second = false;
  await p.locator('.gloss-places .chip', { hasText: 'Every book' }).click(); await p.waitForSelector('.gloss-row[data-id="n0"]');
  const shown = await p.$$eval('.gloss-list .gloss-row', (e) => e.length);
  await p.click('.gloss-retr-all'); await p.waitForSelector('.gloss-retr-sheet .gloss-retr-prompt');
  ok('all shown: every entry of the place shown', (await p.textContent('.gloss-retr-info')).includes(`Entries: ${shown}`) && shown === 40, shown);
  await p.click('.gloss-retr-reset');
  const reset = await p.inputValue('.gloss-retr-prompt');
  ok('reset to the default', reset === def, reset);
  st.slow = 1500; const got0 = st.gotRetr; await p.click('.gloss-retr-go');
  await p.waitForFunction(() => /Retranslating/.test(document.querySelector('.gloss-retr-status')?.textContent || ''));
  while (st.gotRetr < got0 + 1) await p.waitForTimeout(50);
  ok('while asked, the old renderings stay', (await byId('n0'))?.to === 'Name00');
  ok('the progress shown', /0 of 40/.test(await p.textContent('.gloss-retr-status')) && await p.isVisible('.gloss-retr-sheet .progress-bar'));
  while (st.gotRetr < got0 + 2) await p.waitForTimeout(50);   // (the first batch answered; the second asked)
  await p.click('.gloss-retr-cancel');
  await p.waitForSelector('.gloss-retr-report .gloss-retr-line', { timeout: 10000 });
  const rep3 = await p.textContent('.gloss-retr-report'); console.log('stopped:', rep3);
  const g3 = await gloss(); const changed3 = g3.filter((x) => /^n\d/.test(x.id) && /^اسم/.test(x.to)).length;
  ok('Stop: the batch answered kept (30), the one asked when stopped not used', changed3 === 30 && /Stopped/.test(rep3) && /Renderings changed: 30/.test(rep3), [changed3, rep3]);
  ok('… the remembered instructions now the default again', !(await p.evaluate(() => JSON.parse(localStorage.getItem('kr.visual') || '{}').aiGlossPrompt)));
  await p.click('.gloss-retr-cancel'); await p.waitForSelector('.gloss-retr-sheet', { state: 'detached' });
  ok('Undo offered on the glossary too', await p.isVisible('.gloss-retr-bar .gloss-retr-undo'));
  await p.click('.gloss-retr-bar .gloss-retr-undo'); await p.waitForTimeout(200);
  ok('… and the whole run undone', (await gloss()).filter((x) => /^n\d/.test(x.id)).every((x) => /^Name/.test(x.to)));
  st.slow = 0;

  // ---- A provider's error, no connection: nothing changed ----
  const snap = JSON.stringify(await gloss());
  st.fail = 1; await p.click('.gloss-row[data-id="n1"] button[aria-label="Retranslate this entry"]'); await p.waitForSelector('.gloss-retr-go'); await p.click('.gloss-retr-go');
  await p.waitForSelector('.gloss-retr-error', { timeout: 10000 });
  ok('a provider\'s error: said plainly, nothing changed', /The AI service failed/.test(await p.textContent('.gloss-retr-error')) && JSON.stringify(await gloss()) === snap);
  await p.click('.gloss-retr-cancel'); st.fail = 0;
  await ctx.setOffline(true);
  await p.click('.gloss-row[data-id="n1"] button[aria-label="Retranslate this entry"]'); await p.waitForSelector('.gloss-retr-go'); const n4 = asked.length; await p.click('.gloss-retr-go');
  await p.waitForSelector('.toast.error'); const off = await p.textContent('.toast.error');
  ok('offline: said plainly, nothing asked, nothing changed', /offline/i.test(off) && asked.length === n4 && JSON.stringify(await gloss()) === snap, off);
  await ctx.setOffline(false); await p.click('.gloss-retr-cancel');

  // ---- Only the paragraphs holding a changed name translated again ----
  await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim').forEach((e) => e.remove()));
  await p.click('.tr-pill .tr-toggle'); await p.waitForTimeout(300);   // off
  const n5 = asked.length; await p.click('.tr-pill .tr-toggle');
  await p.waitForFunction(() => document.querySelectorAll('.kr-chapter p.kr-translated').length >= 3, null, { timeout: 15000 }); await p.waitForTimeout(800);
  const sent5 = asked.slice(n5).filter((a) => a.kind === 'tr').flatMap((a) => JSON.parse(a.user)); console.log('sent again:', JSON.stringify(sent5));
  ok('a changed name: only its paragraph translated again (the glossary stamp in the key)', sent5.some((x) => /Keyaru/.test(x)) && !sent5.some((x) => /wind was cold/.test(x)), sent5);

  // ---- 3: Arabic → Japanese → French ----
  await setVisual({ aiTarget: 'ja', aiAutoGlossary: false }); const n6 = asked.length;
  await openTranslated();
  const ja = await trTexts(); console.log('into Japanese:', JSON.stringify(ja));
  const tr6 = asked.slice(n6).find((a) => a.kind === 'tr' && /Keyaru/.test(a.user));
  ok('into Japanese: the Japanese term used, no Arabic one given or used', ja.some((x) => x.includes('ケヤルガ')) && !ja.some((x) => /[؀-ۿ]/.test(x)) && !!tr6 && /"Keyaru" → "ケヤルガ"/.test(tr6.system) && !/كيار/.test(tr6.system), [ja, tr6?.system]);
  ok('… names without a Japanese term written in Japanese (Flare, Setsuna)', ja.some((x) => x.includes('フレア')) && ja.some((x) => x.includes('セツナ')), ja);
  await setVisual({ aiTarget: 'fr' }); const n7 = asked.length;
  await openTranslated();
  const fr = await trTexts(); console.log('into French:', JSON.stringify(fr));
  const tr7 = asked.slice(n7).find((a) => a.kind === 'tr' && /Keyaru/.test(a.user));
  ok('into French: the French term, nothing Arabic or Japanese', fr.some((x) => x.includes('Kéyaru')) && !fr.some((x) => /[؀-ۿ぀-ヿ]/.test(x)) && /"Keyaru" → "Kéyaru"/.test(tr7?.system || '') && /in Latin letters/.test(tr7?.system || ''), [fr, tr7?.system]);
  const g8 = await gloss();
  ok('every language\'s terms kept through the switches', ['tk-ar', 'tk-en', 'tk-ja', 'tk-fr'].every((i) => g8.some((x) => x.id === i)) && g8.some((x) => x.from === 'Flare' && x.lang === 'ar'));
  ok('the old term without a language kept as it was', JSON.stringify(g8.find((x) => x.id === 'old1')) === JSON.stringify(seed.find((x) => x.id === 'old1')));

  // ---- 6: the box in Arabic, right to left ----
  await setVisual({ aiTarget: 'ar' }); await p.evaluate(() => localStorage.setItem('kr.lang', 'ar'));
  await p.reload(); await p.evaluate((i) => { location.hash = `#/read/${i}`; }, id); await p.waitForSelector('.kr-chapter', { timeout: 30000 }); await p.waitForTimeout(1500);
  if (!(await p.$('.tr-pill'))) await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'translate' })));
  await p.waitForSelector('.tr-pill'); await p.click('.tr-pill button:nth-last-child(2)');   // (More)
  await p.locator('.sheet .dest-list .dest-row').nth(2).click(); await p.waitForSelector('.gloss-sheet .gloss-row[data-id="tk-ar"]');
  await p.click('.gloss-row[data-id="tk-ar"] button[aria-label="أعِد ترجمة هذا المدخل"]');
  await p.waitForSelector('.gloss-retr-sheet .gloss-retr-prompt');
  const arUi = await p.evaluate(() => ({ dir: document.documentElement.dir, title: document.querySelector('.gloss-retr-sheet h3')?.textContent, info: document.querySelector('.gloss-retr-info')?.textContent, box: document.querySelector('.gloss-retr-prompt')?.value, go: document.querySelector('.gloss-retr-go')?.textContent, over: [...document.querySelectorAll('.gloss-retr-sheet *')].some((e) => { const r = e.getBoundingClientRect(); return r.width && (r.right > innerWidth + 1 || r.left < -1); }) }));
  console.log('Arabic:', JSON.stringify(arUi));
  ok('the box in Arabic, right to left, the language named in Arabic', arUi.dir === 'rtl' && arUi.title === 'إعادة ترجمة المسرد' && /العدد: [1١]/.test(arUi.info) && /إلى العربية/.test(arUi.box) && /MARK|Prefer/.test(arUi.box) === false, arUi);
  ok('… nothing past the screen\'s edges', !arUi.over);
  await p.waitForTimeout(800); await p.screenshot({ path: path.join(shots, 'retranslate-ar.png') });
  ok('no page errors', !errors.length, errors);
  await b.close(); server.close(); fs.rmSync(work, { recursive: true, force: true });
  console.log(`screenshots: ${shots}`);
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
