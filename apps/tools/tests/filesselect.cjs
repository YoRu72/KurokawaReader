// Files on a phone (360x800), choosing and acting: a long press chooses the row and shows the bottom bar of five equal slots at once
// (Copy, Cut, Delete, Rename — or Archive for several —, More) in the tab bar's place, with the one-bar header's count / select all /
// invert; dragging on from the long press chooses the rows passed; a tap on the icon toggles; «More» lists only what applies (folder,
// archive, image); Copy / Cut -> the paste bar -> another folder -> Paste runs the job once (a double tap too); Delete asks once;
// Back: the More sheet, then the choosing, then the paste bar; the FAB hides while choosing or while the paste bar is up; the last
// row's date is never covered; a computer (1280 px) keeps its own bar.
// Run: NODE_PATH=$(npm root -g) node tests/filesselect.cjs [en|ar]   (no argument: both)
const { chromium } = require('playwright'); const path = require('node:path'); const fs = require('node:fs'); const esbuild = require('esbuild');
const F = require('./filesphone-fixture.cjs'); const { K, ZIP } = F;
const OUT = '/tmp/claude-0/-home-claude/31db5f1c-a6c2-54e2-a5c4-2730cae2d727/scratchpad/t022/'; fs.mkdirSync(OUT, { recursive: true });
let fails = 0; const ok = (what, cond, x) => { console.log((cond ? 'ok   ' : 'FAIL ') + what + (cond || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!cond) fails++; };
const strings = (lang) => { const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src/i18n', `${lang}.ts`)], bundle: true, write: false, format: 'cjs', platform: 'node' }); const m = { exports: {} }; new Function('module', 'exports', out.outputFiles[0].text)(m, m.exports); return { ...m.exports.en, ...m.exports[lang] }; };
const fill = (s, o) => s.replace(/\{(\w+)\}/g, (_, k) => o[k]);

async function phoneSuite(browser, port, z, lang) {
  const S = { ...strings('en'), ...strings(lang) }; const L = (s) => `[${lang}] ${s}`;
  const { page: p, errors } = await F.open(browser, { lang, z, many: 40, width: 360, height: 800, dense: true });
  const goTo = async (q) => { await p.evaluate((h) => { location.hash = h; }, `#/files?p=${encodeURIComponent(q)}`); await p.waitForTimeout(500); };
  const row = (name) => p.locator(`.files-row:has(.files-name[title="${name.replace(/"/g, '\\"')}"])`).first();
  const holdAt = async (name, then) => { await row(name).evaluate((r) => r.scrollIntoView({ block: 'center' })); await p.waitForTimeout(100); const b = await row(name).boundingBox(); await p.mouse.move(b.x + 120, b.y + b.height / 2); await p.mouse.down(); await p.waitForTimeout(650); if (then) await then(b); await p.mouse.up(); await p.waitForTimeout(250); };
  const hold = (name) => holdAt(name);
  const tap = async (name) => { await row(name).locator('.files-main').click(); await p.waitForTimeout(150); };
  const slots = () => p.$$eval('.files-selbar.phone-sel .sel-slot', (e) => e.map((x) => ({ id: x.dataset.slot, w: Math.round(x.getBoundingClientRect().width), h: Math.round(x.getBoundingClientRect().height) })));
  const barOn = () => p.evaluate(() => { const b = document.querySelector('.files-selbar.phone-sel'); return !!b && !b.hidden && b.getClientRects().length > 0; });
  const vis = (sel) => p.evaluate((s) => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0; }, sel);
  const picked = () => p.$$eval('.files-row.picked', (e) => e.length);
  const rows = () => p.$$eval('.dest-row', (e) => e.map((x) => x.textContent.trim()));
  const back = async () => { await p.evaluate(() => window.__back()); await p.waitForTimeout(400); };
  const has = (q) => p.evaluate((x) => window.__tree.has(x), q);
  const kidsOf = (d) => p.evaluate((x) => [...window.__tree.keys()].filter((k) => k.replace(/\/[^/]*$/, '') === x).map((k) => k.split('/').pop()), d);
  const clip = () => p.evaluate(() => { const b = document.querySelector('.files-view .files-clipbar'); return !!b && !b.hidden && b.getClientRects().length > 0; });
  const closeSheet = async () => { await p.evaluate(() => { const b = document.querySelector('.sheet .btn, .sheet-close, [data-sheet-close]'); if (b) b.click(); }); await p.waitForTimeout(250); };
  const shot = (name) => p.screenshot({ path: `${OUT}${name}.png` });

  await p.goto(`http://localhost:${port}/#/files?p=${encodeURIComponent(K)}`); await p.waitForSelector('.files-row'); await p.waitForTimeout(600);
  // 1. the bar at once, for one, then three
  ok(L('no bar before choosing'), !(await barOn()));
  await hold('Song.mp3');
  ok(L('a long press: the bar is there at once'), await barOn());
  let sl = await slots();
  ok(L('one chosen: Copy, Cut, Delete, Rename, More'), sl.map((x) => x.id).join() === 'copy,cut,delete,rename,more', sl);
  ok(L('five equal slots, 48 px or more high'), sl.length === 5 && new Set(sl.map((x) => x.w)).size <= 2 && Math.max(...sl.map((x) => x.w)) - Math.min(...sl.map((x) => x.w)) <= 1 && sl.every((x) => x.h >= 48), sl);
  ok(L('the tab bar is out of the way and the FAB hidden'), !(await vis('.bottom-nav')) && !(await vis('.files-fab')));
  const head = await p.evaluate(() => document.querySelector('.files-selhead')?.innerText ?? '');
  ok(L('the header: the count'), head.includes(fill(S.filesSelCount, { n: '1' })), head);
  ok(L('the header: close, select all, invert'), (await p.$$eval('.files-selhead .icon-btn', (e) => e.length)) === 3);
  ok(L('the one-bar header is replaced'), !(await vis('.topbar .files-head')));
  if (lang === 'en') await p.emulateMedia({ colorScheme: 'dark' });
  await p.waitForTimeout(800); await shot(lang === 'en' ? 'F2b-select-en-dark' : 'sel-ar');
  await tap('photo.jpg'); await row('Sub').locator('.files-ic').click(); await p.waitForTimeout(200);
  sl = await slots();
  ok(L('icon tap toggled the row; three chosen: Archive instead of Rename'), (await picked()) === 3 && sl.map((x) => x.id).join() === 'copy,cut,delete,archive,more', { n: await picked(), sl });
  await row('Sub').locator('.files-ic').click(); await p.waitForTimeout(150);
  ok(L('a second icon tap lets it go'), (await picked()) === 2);
  ok(L('the icon tap did not open the folder'), (await p.evaluate(() => location.hash)).includes(encodeURIComponent(K)) && !(await p.evaluate(() => location.hash)).includes('Sub'));
  // 2. More: only what applies
  await p.click('.files-selbar [data-slot="more"]'); await p.waitForTimeout(350);
  const multi = await rows(); ok(L('More for two: a sheet of actions'), multi.length >= 1 && multi.every((x) => x.length > 0), multi);
  await back(); ok(L('Back closes the More sheet first, the choosing stays'), (await rows()).length === 0 && (await picked()) === 2 && (await barOn()));
  await back(); ok(L('Back again ends the choosing'), !(await barOn()) && (await picked()) === 0 && (await vis('.bottom-nav')));
  const moreOf = async (name) => { await hold(name); await p.click('.files-selbar [data-slot="more"]'); await p.waitForTimeout(350); const r = await rows(); if (lang === 'ar' && name === 'photo.jpg') { await p.emulateMedia({ colorScheme: 'light' }); await shot('F2b-more-ar-light'); } await back(); await back(); return r; };
  const imgRows = await moreOf('photo.jpg'); const dirRows = await moreOf('Sub'); const zipRows = await moreOf(ZIP);
  ok(L('an image: Open with, Open as, Share, Properties — and not Copy/Delete/Rename (they are slots)'), [S.openWith, S.filesOpenAs, S.share, S.properties].every((x) => imgRows.some((r) => r.includes(x))) && ![S.filesCopy, S.delete, S.rename].some((x) => imgRows.some((r) => r === x)), imgRows);
  ok(L('a folder: no Open with / Open as; Hide folder, .nomedia, Properties'), ![S.openWith, S.filesOpenAs].some((x) => dirRows.some((r) => r.includes(x))) && [S.filesHideFolder, S.properties].every((x) => dirRows.some((r) => r.includes(x))), dirRows);
  ok(L('an archive: Open as archive and the archive ways'), zipRows.some((r) => r.includes(S.filesOpenAsArchive)) && zipRows.some((r) => r.includes(S.extractHere) || r.includes(S.extractTo)), zipRows);
  // 3. Delete asks once
  await hold('broken.bin'); await p.click('.files-selbar [data-slot="delete"]'); await p.waitForTimeout(400);
  const asked = await p.evaluate(() => [...document.querySelectorAll('.sheet, [role="dialog"]')].filter((e) => e.getClientRects().length).length);
  ok(L('Delete asks, once'), asked === 1, asked);
  if (lang === 'ar') { await p.emulateMedia({ colorScheme: 'light' }); await shot('F2b-delete-ar-light'); }
  await back(); await back(); await p.waitForTimeout(200);
  ok(L('nothing deleted when it is cancelled'), await has(`${K}/broken.bin`));
  if (await barOn()) await back();
  // 4. Copy -> paste bar -> another folder -> Paste, once
  await p.evaluate(() => { window.__slow = 250; });
  await hold('Song.mp3'); await p.click('.files-selbar [data-slot="copy"]'); await p.waitForTimeout(300);
  ok(L('Copy ends the choosing and the paste bar is there'), !(await barOn()) && (await clip()));
  ok(L('the FAB is hidden while the paste bar is up'), !(await vis('.files-fab')));
  if (lang === 'en') { await p.emulateMedia({ colorScheme: 'dark' }); await shot('F2b-paste-en-dark'); }
  await goTo(`${K}/Sub`); ok(L('the paste bar stays in another folder'), await clip());
  await p.dblclick('.files-clipbar .files-clip-paste'); await p.waitForTimeout(1500);
  const sub = await kidsOf(`${K}/Sub`);
  ok(L('Paste (double tap): the file is there once'), sub.filter((n) => /^Song/.test(n)).join() === 'Song.mp3' && await has(`${K}/Song.mp3`), sub);
  await goTo(K); await p.waitForTimeout(300);
  // 5. Cut -> Paste is a move; Back puts the clipboard down
  await hold('undated.bin'); await p.click('.files-selbar [data-slot="cut"]'); await p.waitForTimeout(300);
  await goTo(`${K}/Sub/Deeper`); await p.dblclick('.files-clipbar .files-clip-paste'); await p.waitForTimeout(1500);
  ok(L('Cut then Paste: moved, once'), (await has(`${K}/Sub/Deeper/undated.bin`)) && !(await has(`${K}/undated.bin`)));
  await goTo(K); await hold('photo.jpg'); await p.click('.files-selbar [data-slot="copy"]'); await p.waitForTimeout(250);
  ok(L('the paste bar is up again'), await clip());
  await back(); ok(L('Back with the paste bar: it only puts the clipboard down'), !(await clip()) && (await p.evaluate(() => location.hash)).includes(encodeURIComponent(K)));
  // 6. the FAB sheet: no Paste, no Clear
  await p.click('.files-fab'); await p.waitForTimeout(350); const fabRows = await rows();
  ok(L('the FAB sheet keeps New folder, Bookmark here; no Paste / Clear clipboard'), fabRows.some((r) => r.includes(S.newFolder)) && !fabRows.some((r) => r.includes(S.filesPaste) || r.includes(S.filesClipClear)), fabRows);
  await back();
  // 7. drag-choosing in a long folder, and the last row's date
  await goTo(`${K}/Many`); await p.waitForSelector('.files-row'); await p.waitForTimeout(500);
  await holdAt('file 000.txt', async (b) => { await p.mouse.move(b.x + 120, b.y + b.height * 4.2, { steps: 10 }); await p.waitForTimeout(150); });
  const dragged = await picked(); ok(L('drag from the long press chose the rows passed'), dragged >= 4, dragged);
  await row('file 001.txt').locator('.files-main').click(); await p.waitForTimeout(150);
  ok(L('tapping a chosen row lets it go'), (await picked()) === dragged - 1, await picked());
  await back(); await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await p.waitForTimeout(400);
  await p.evaluate(() => window.scrollTo(0, 1e6)); await p.waitForTimeout(500);
  const cover = await p.evaluate(() => { const ds = [...document.querySelectorAll('.files-row .files-date')]; const last = ds[ds.length - 1]; if (!last) return null; const r = last.getBoundingClientRect(); const hit = (s) => { const e = document.querySelector(s); if (!e || !e.getClientRects().length) return false; const q = e.getBoundingClientRect(); return !(r.right <= q.left || r.left >= q.right || r.bottom <= q.top || r.top >= q.bottom); }; return { fab: hit('.files-fab'), nav: hit('.bottom-nav'), inView: r.bottom <= innerHeight }; });
  ok(L('the last row\'s date is not under the FAB or the tab bar'), cover && !cover.fab && !cover.nav && cover.inView, cover);
  ok(L('no page errors'), errors.length === 0, errors);
  await p.close();
}

async function pcSuite(browser, port, z) {
  const { page: p, errors } = await F.open(browser, { lang: 'en', pc: true, z, many: 5 });
  await p.goto(`http://localhost:${port}/#/files?p=${encodeURIComponent(K)}`); await p.waitForSelector('.files-row'); await p.waitForTimeout(600);
  const b = await p.locator('.files-row').first().boundingBox(); await p.mouse.move(b.x + 120, b.y + b.height / 2); await p.mouse.down(); await p.waitForTimeout(650); await p.mouse.up(); await p.waitForTimeout(250);
  const st = await p.evaluate(() => ({ phoneBar: !!document.querySelector('.files-selbar.phone-sel'), head: getComputedStyle(document.querySelector('.files-selhead')).display, bar: !!document.querySelector('.files-selbar:not([hidden])'), cls: document.documentElement.classList.contains('files-selecting'), title: getComputedStyle(document.querySelector('.files-view .files-head')).display }));
  ok('[pc] 1280 px: the computer keeps its own bar, no phone bar or header', !st.phoneBar && st.head === 'none' && st.bar && !st.cls && st.title !== 'none', st);
  ok('[pc] no page errors', errors.length === 0, errors);
  await p.close();
}

(async () => {
  const z = await F.zipListing(); const srv = await F.serve(); const port = srv.address().port; const browser = await chromium.launch();
  const langs = process.argv[2] ? [process.argv[2]] : ['en', 'ar'];
  for (const lang of langs) await phoneSuite(browser, port, z, lang);
  if (langs.includes('en')) await pcSuite(browser, port, z);
  await browser.close(); srv.close();
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
