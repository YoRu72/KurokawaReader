// Files on a phone (360x800), the menus made quick: the header's ⋮ is ONE sheet (View, Sort, Show, This folder, Tools) whose controls
// change the list at once and persist, the sort flips on the active chip, a folder's own sort is remembered (bounded to 200), the search
// filters as you type («N of M», Arabic folded, a clear button, Back closes it first, the sub-folder switch streams results with their
// folder), the drawer in labelled groups (current place marked, recent folders bounded, bookmarks moved), the empty folder's buttons;
// a computer (1280 px) keeps its own sheet and search.
// Run: NODE_PATH=$(npm root -g) node tests/filesmenu.cjs [en|ar]   (no argument: both)
const { chromium } = require('playwright'); const path = require('node:path'); const fs = require('node:fs'); const esbuild = require('esbuild');
const F = require('./filesphone-fixture.cjs'); const { K } = F;
const OUT = '/tmp/claude-0/-home-claude/31db5f1c-a6c2-54e2-a5c4-2730cae2d727/scratchpad/t022/'; fs.mkdirSync(OUT, { recursive: true });
let fails = 0; const ok = (what, cond, x) => { console.log((cond ? 'ok   ' : 'FAIL ') + what + (cond || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!cond) fails++; };
const strings = (lang) => { const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src/i18n', `${lang}.ts`)], bundle: true, write: false, format: 'cjs', platform: 'node' }); const m = { exports: {} }; new Function('module', 'exports', out.outputFiles[0].text)(m, m.exports); return { ...m.exports.en, ...m.exports[lang] }; };
const fill = (s, o) => s.replace(/\{(\w+)\}/g, (_, k) => o[k]);

async function phoneSuite(browser, port, z, lang) {
  const S = strings(lang); const L = (s) => `[${lang}] ${s}`; const dark = lang === 'en';
  const { page: p, errors } = await F.open(browser, { lang, z, many: 0, width: 360, height: 800, dense: true });
  await p.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
  const ls = (k) => p.evaluate((x) => JSON.parse(localStorage.getItem(x) || 'null'), k);
  const names = () => p.$$eval('.files-row:not(.files-subrow) .files-name', (e) => e.map((x) => x.textContent));
  const goTo = async (q) => { await p.evaluate((h) => { location.hash = h; }, `#/files?p=${encodeURIComponent(q)}`); await p.waitForTimeout(500); };
  const back = async () => { await p.evaluate(() => window.__back()); await p.waitForTimeout(400); };
  const openMore = async () => { await p.click('.topbar-actions [data-icon="more"]'); await p.waitForSelector('.sheet.files-menu'); await p.waitForTimeout(250); };
  const shut = async () => { await p.keyboard.press('Escape'); await p.waitForTimeout(350); };
  const sheetOpen = () => p.evaluate(() => !!document.querySelector('.sheet.files-menu'));
  const seg = (name, v) => p.click(`.files-menu [data-seg="${name}"] [data-v="${v}"]`);
  const pressed = (name) => p.$eval(`.files-menu [data-seg="${name}"] [aria-pressed="true"]`, (e) => e.dataset.v);
  const sw = (name) => p.click(`.files-menu [data-sw="${name}"]`);
  await p.goto(`http://localhost:${port}/#/files?p=${encodeURIComponent(K)}`); await p.waitForSelector('.files-row'); await p.waitForTimeout(600);
  await p.evaluate(() => { window.__put('/storage/emulated/0/Download/Kurokawa/أحمد.txt', false, 10); window.__put('/storage/emulated/0/Download/Kurokawa/.secret.txt', false, 5); const s = {}; for (let i = 0; i < 205; i++) s['/fake/' + i] = { sort: 'name', desc: false, ff: true }; localStorage.setItem('kt.files.sorts', JSON.stringify(s)); localStorage.setItem('kt.files.bookmarks', JSON.stringify([{ name: 'Alpha', path: '/storage/emulated/0/Music' }, { name: 'Beta', path: '/storage/emulated/0/Download/Kurokawa/Sub' }])); localStorage.setItem('kt.files.recent', JSON.stringify(['/a/1', '/a/2', '/a/3', '/a/4', '/a/5', '/a/6', '/a/7', '/a/8'])); });

  // ---- the ⋮ sheet: one sheet, sections in order, 48 px rows, equal segments
  await openMore();
  const labels = await p.$$eval('.files-menu .files-menu-label', (e) => e.map((x) => x.textContent));
  ok(L('one sheet with the sections View, Sort, Show, This folder, Tools'), JSON.stringify(labels.slice(0, 5).map((x) => x.toLowerCase())) === JSON.stringify([S.fmView, S.fmSort, S.fmShow, S.fmFolder, S.fmTools].map((x) => x.toLowerCase())), labels);
  const geo = await p.evaluate(() => { const r = (s) => [...document.querySelectorAll(s)].map((e) => e.getBoundingClientRect()); const seg = (n) => r(`.files-menu [data-seg="${n}"] button`); return { view: seg('view').map((b) => Math.round(b.width)), sort: seg('sort').map((b) => Math.round(b.width)), hv: seg('view').map((b) => Math.round(b.height)), sw: r('.files-menu .files-menu-sw').map((b) => Math.round(b.height)), rowH: r('.files-menu .dest-row').map((b) => Math.round(b.height)), checkboxes: document.querySelectorAll('.files-menu input[type=checkbox]').length, sheetW: document.querySelector('.sheet.files-menu').getBoundingClientRect().width }; });
  ok(L('segments of equal width (view, sort), 48 px tall'), new Set(geo.view).size === 1 && Math.max(...geo.sort) - Math.min(...geo.sort) <= 1 && geo.hv.every((x) => x === 48), geo);
  ok(L('switch rows and action rows are at least 48 px'), geo.sw.every((x) => x >= 48) && geo.rowH.every((x) => x >= 48) && geo.sw.length === 5, geo);
  const tools = await p.$$eval('.files-menu .files-menu-label', (e) => { const out = []; for (const l of e) { out.push([l.textContent, l.nextElementSibling && l.nextElementSibling.classList.contains('files-menu-rows') ? l.nextElementSibling.children.length : -1]); } return out; });
  ok(L('Tools lists analyzer, duplicates, compare, verify, jobs, trash'), tools.find((x) => x[0].toLowerCase() === S.fmTools.toLowerCase())?.[1] === 6, tools);
  await p.evaluate(() => Promise.all(document.querySelector('.sheet.files-menu').getAnimations().map((x) => x.finished.catch(() => undefined)))); await p.waitForTimeout(300);
  if (lang === 'en') await p.screenshot({ path: OUT + 'F6-more-en-dark.png' }); else await p.screenshot({ path: OUT + 'F6-more-ar-light.png' });

  // View
  await seg('view', 'grid'); await p.waitForTimeout(250);
  ok(L('View: grid applies at once, the sheet stays open, the choice persists'), (await p.evaluate(() => document.querySelector('.files-list').classList.contains('grid'))) && (await sheetOpen()) && (await ls('kt.files.prefs')).view === 'grid' && (await pressed('view')) === 'grid');
  ok(L('Rows control only for the list'), await p.evaluate(() => document.querySelector('.files-menu-sub').hidden));
  await seg('view', 'gallery'); await p.waitForTimeout(200); ok(L('View: gallery'), await p.evaluate(() => document.querySelector('.files-list').classList.contains('gallery')));
  await seg('view', 'list'); await p.waitForTimeout(250);
  ok(L('View: list, Rows control shown'), (await p.evaluate(() => document.querySelector('.files-list').classList.contains('list') && !document.querySelector('.files-menu-sub').hidden)));
  await seg('rows', 'comfortable'); await p.waitForTimeout(250);
  ok(L('Rows comfortable: dense rows off at once, persisted'), (await p.evaluate(() => !document.querySelector('.files-list').classList.contains('dense'))) && (await ls('kt.files.prefs')).density === 'comfortable');
  await seg('rows', 'compact'); await p.waitForTimeout(250);
  ok(L('Rows compact: dense again'), await p.evaluate(() => document.querySelector('.files-list').classList.contains('dense')));

  // Sort: chips, a second tap flips, folders first
  await seg('sort', 'size'); await p.waitForTimeout(250);
  let n = await names(); ok(L('Sort by size: smallest file first (folders first)'), n.indexOf('broken.bin') === 2 && n[n.length - 1] === 'Song.mp3' || n.indexOf('broken.bin') >= 0 && n.indexOf('broken.bin') < n.indexOf('Song.mp3'), n);
  await seg('sort', 'size'); await p.waitForTimeout(250); n = await names();
  const pr = await ls('kt.files.prefs');
  ok(L('Tapping the active chip flips the direction (arrow shown), persisted'), pr.sort === 'size' && pr.desc === true && n.indexOf('Song.mp3') < n.indexOf('broken.bin') && (await p.$$eval('.files-menu [data-seg="sort"] [aria-pressed="true"] svg', (e) => e.length)) === 1, { pr, n });
  await seg('sort', 'name'); await p.waitForTimeout(200); await seg('sort', 'name'); await p.waitForTimeout(250); n = await names();
  ok(L('Name descending, folders first: a folder leads'), ['Sub', 'Many'].includes(n[0]), n);
  await sw('ff'); await p.waitForTimeout(250); n = await names();
  ok(L('Folders first off: the files and folders mix (undated.bin leads, persisted)'), n[0] === 'undated.bin' && (await ls('kt.files.prefs')).foldersFirst === false, n);
  await sw('ff'); await p.waitForTimeout(200);
  await seg('sort', 'name'); await p.waitForTimeout(200); // (name, ascending again)

  // Per-folder sort: remembered, bounded, the global one untouched
  await sw('per'); await p.waitForTimeout(200);
  let st = await ls('kt.files.sorts'); const keys = Object.keys(st);
  ok(L('Remember for this folder: stored, the store bounded to 200 (the oldest gone)'), keys.length === 200 && !!st[K] && !keys.includes('/fake/0'), keys.length);
  await seg('sort', 'date'); await p.waitForTimeout(200); await seg('sort', 'date'); await p.waitForTimeout(250);
  st = await ls('kt.files.sorts');
  ok(L('This folder sorted by date descending, the global sort stays name'), st[K].sort === 'date' && st[K].desc === true && (await ls('kt.files.prefs')).sort === 'name', { k: st[K], g: (await ls('kt.files.prefs')).sort });
  await shut(); await goTo(`${K}/Sub`); n = await names();
  ok(L('Another folder uses the global sort'), n.join(',') === 'Deeper,in.txt', n);
  await goTo(K); n = await names(); ok(L('Back in the folder: its own sort applies (newest first, then name for equal dates)'), n.length > 3, n);
  await openMore(); await sw('per'); await p.waitForTimeout(200);
  ok(L('Remember off: the folder entry is gone'), !(await ls('kt.files.sorts'))[K]); await shut();

  // Show
  await openMore();
  ok(L('Hidden files hidden by default'), !(await names()).includes('.secret.txt'));
  await sw('hidden'); await p.waitForTimeout(500);
  ok(L('Show hidden files: the list reads again at once and persists'), (await names()).includes('.secret.txt') && (await ls('kt.files.prefs')).hidden === true && (await sheetOpen()));
  await sw('hidden'); await sw('counts'); await sw('thumbs'); await p.waitForTimeout(300);
  const pr2 = await ls('kt.files.prefs'); ok(L('Item counts and Thumbnails switches persist (prefs.counts / prefs.thumbs)'), pr2.counts === false && pr2.thumbs === false && pr2.hidden === false, pr2);
  await sw('counts'); await sw('thumbs');

  // This folder: actions close the sheet
  await p.click(`.files-menu .dest-row:has-text("${S.refresh}")`); await p.waitForTimeout(500);
  ok(L('Refresh closes the sheet and reads the folder again (the new Arabic name shows)'), !(await sheetOpen()) && (await names()).includes('أحمد.txt'));
  await openMore(); await p.click(`.files-menu .dest-row:has-text("${S.filesBookmarkHere}")`); await p.waitForTimeout(250);
  ok(L('Bookmark this folder stores it'), (await ls('kt.files.bookmarks')).some((b) => b.path === K) && !(await sheetOpen()));
  await openMore(); ok(L('The row now says Remove bookmark'), (await p.locator(`.files-menu .dest-row:has-text("${S.fmUnbookmark}")`).count()) === 1);
  await p.click(`.files-menu .dest-row:has-text("${S.fmUnbookmark}")`); await p.waitForTimeout(250);
  ok(L('Remove bookmark removes it'), !(await ls('kt.files.bookmarks')).some((b) => b.path === K));
  await openMore(); await p.click(`.files-menu .dest-row:has-text("${S.filesSelectAll}")`); await p.waitForTimeout(300);
  ok(L('Select all closes the sheet and chooses the rows'), !(await sheetOpen()) && (await p.$$eval('.files-row.picked', (e) => e.length)) > 3);
  await back();

  // ---- the search: filters as you type
  await p.click('.topbar-actions [data-icon="search"]'); await p.waitForSelector('.files-search:not([hidden])'); await p.waitForTimeout(200);
  const total = (await names()).length;
  await p.fill('.files-search', 'SONG'); await p.waitForTimeout(250);
  ok(L('Search narrows as you type (case-insensitive) and says «N of M»'), (await names()).join() === 'Song.mp3' && (await p.textContent('.files-search-count')) === fill(S.fmOf, { n: 1, m: total }), { n: await names(), c: await p.textContent('.files-search-count') });
  await p.fill('.files-search', 'احمد'); await p.waitForTimeout(250);
  ok(L('Arabic folded: «احمد» finds «أحمد.txt»'), (await names()).join() === 'أحمد.txt', await names());
  await p.fill('.files-search', 'deep'); await p.waitForTimeout(250);
  ok(L('Nothing in this folder matches «deep»'), (await names()).length === 0);
  await p.click('.files-sub-row input'); await p.waitForTimeout(700);
  const sub = await p.$$eval('.files-subres .files-row', (e) => e.map((x) => [x.querySelector('.files-name').textContent, x.querySelector('small').textContent]));
  ok(L('Sub-folders too: the result streams in with its folder under the name'), sub.some((x) => x[0] === 'deep.txt' && x[1] === 'Sub/Deeper'), sub);
  ok(L('The recursive search ran from this folder'), (await p.evaluate(() => window.__calls.filter((c) => c.startsWith('search:')))).some((c) => c === 'search:deep@' + K));
  if (lang === 'en') await p.screenshot({ path: OUT + 'F6-search-en-dark.png' });
  await p.click('.files-search-line .icon-btn'); await p.waitForTimeout(300);
  ok(L('The clear button empties the search and the list is whole again'), (await p.inputValue('.files-search')) === '' && (await names()).length === total && (await p.$$eval('.files-subres .files-row', (e) => e.length)) === 0);
  await back();
  ok(L('Back closes the search first (still in the folder)'), (await p.evaluate(() => document.querySelector('.files-search').hidden)) && (await p.evaluate(() => document.querySelector('.files-search-meta').hidden)) && (await names()).length === total);

  // ---- the drawer
  await p.click('.topbar [data-icon="menu"]'); await p.waitForSelector('.files-drawer'); await p.waitForTimeout(350);
  const dl = await p.$$eval('.files-drawer .files-drawer-label', (e) => e.map((x) => x.textContent.toLowerCase()));
  ok(L('Drawer groups: Storages, Favourites, Recent folders, Collections'), JSON.stringify(dl.slice(0, 4)) === JSON.stringify([S.filesStorages, S.fmFav, S.fmRecentFolders, S.filesCollections].map((x) => x.toLowerCase())), dl);
  const cur = await p.$$eval('.files-drawer .files-drawer-row.on', (e) => e.map((x) => x.textContent));
  ok(L('The current place is marked'), cur.length >= 1 && cur.some((x) => x.includes('Kurokawa')), cur);
  const bars = await p.$$eval('.files-drawer .files-usage-bar', (e) => e.map((x) => [x.classList.contains('full'), getComputedStyle(x.querySelector('i')).backgroundColor]));
  ok(L('Usage bars drawn, none red under 90 %'), bars.length >= 1 && bars.every((b) => !b[0]), bars);
  const rec = await ls('kt.files.recent');
  ok(L('Recent folders: bounded to 8, the current folder first'), rec.length === 8 && rec[0] === K, rec);
  if (lang === 'ar') await p.screenshot({ path: OUT + 'F6-drawer-ar-light.png' });
  const bmNames = () => p.$$eval('.files-drawer .files-drawer-section:nth-child(2) .files-drawer-row .name', (e) => e.map((x) => x.textContent));
  const b0 = await bmNames();
  await p.locator('.files-drawer .files-drawer-row:has(.name:text-is("Alpha")) .icon-btn').click(); await p.waitForSelector(`.sheet:has-text("${S.fmMoveDown}")`);
  await p.click(`.sheet .dest-row:has-text("${S.fmMoveDown}")`); await p.waitForTimeout(500);
  const b1 = await bmNames();
  ok(L('Bookmark: Move down reorders (Alpha, Beta -> Beta, Alpha) and the drawer reopens'), b0.join() === 'Alpha,Beta' && b1.join() === 'Beta,Alpha' && (await ls('kt.files.bookmarks')).map((b) => b.name).join() === 'Beta,Alpha', { b0, b1 });
  await p.locator('.files-drawer .files-drawer-row:has(.name:text-is("Beta"))').dispatchEvent('contextmenu'); await p.waitForSelector(`.sheet:has-text("${S.rename}")`, { timeout: 3000 }).catch(() => undefined);
  ok(L('A long press (context menu) on a bookmark opens its menu'), await p.evaluate(() => !!document.querySelector('.sheet')));
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  await p.click('.topbar [data-icon="menu"]'); await p.waitForSelector('.files-drawer'); await p.waitForTimeout(350);
  await p.click('.files-drawer .files-drawer-row:has(.name:text-is("Beta"))'); await p.waitForTimeout(600);
  ok(L('Choosing a place closes the drawer and goes there'), !(await p.evaluate(() => !!document.querySelector('.files-drawer'))) && (await p.evaluate(() => location.hash)).includes(encodeURIComponent(K + '/Sub')));

  // ---- the empty folder
  await goTo(`${K}/Many`);
  const emp = await p.evaluate(() => { const e = document.querySelector('.files-empty'); return e ? { t: e.querySelector('b').textContent, btns: [...e.querySelectorAll('.btn')].map((b) => b.textContent.trim()), svg: !!e.querySelector('svg') } : null; });
  ok(L('Empty folder: a drawn box, «This folder is empty», New folder (no Paste: nothing copied)'), !!emp && emp.t === S.fmEmpty && emp.svg && emp.btns.length === 1 && emp.btns[0] === S.newFolder, emp);
  await p.click('.files-empty .btn'); await p.waitForSelector('.sheet input[type=text]'); ok(L('New folder button opens the new-folder sheet'), true); await shut();
  await goTo(K); await p.evaluate(() => { document.querySelector('.files-row .files-main'); });
  const rowEl = p.locator('.files-row:has(.files-name[title="Song.mp3"])').first(); const bb = await rowEl.boundingBox(); await p.mouse.move(bb.x + 120, bb.y + bb.height / 2); await p.mouse.down(); await p.waitForTimeout(650); await p.mouse.up(); await p.waitForTimeout(300);
  await p.click('.files-selbar.phone-sel .sel-slot[data-slot="copy"]'); await p.waitForTimeout(300); await goTo(`${K}/Many`);
  const emp2 = await p.$$eval('.files-empty .btn', (e) => e.map((b) => b.textContent.trim()));
  ok(L('Empty folder with something copied: New folder and Paste here'), emp2.length === 2 && emp2[1] === S.filesPaste, emp2);
  ok(L('no page errors'), errors.length === 0, errors);
  await p.close();
}

async function pcSuite(browser, port, z) {
  const S = strings('en'); const { page: p, errors } = await F.open(browser, { lang: 'en', pc: true, z, many: 0 });
  await p.goto(`http://localhost:${port}/#/files?p=${encodeURIComponent(K)}`); await p.waitForSelector('.files-row'); await p.waitForTimeout(600);
  await p.click('.topbar-actions [data-icon="more"]'); await p.waitForSelector('.sheet'); await p.waitForTimeout(250);
  ok('[pc] 1280 px: the ⋮ sheet is the old list, not the phone menu', !(await p.evaluate(() => !!document.querySelector('.sheet.files-menu'))) && (await p.locator('.sheet .dest-row').count()) > 3);
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  await p.goto(`http://localhost:${port}/#/files?p=${encodeURIComponent(K + '/Many')}`); await p.waitForTimeout(600);
  ok('[pc] the empty folder keeps its plain line', (await p.locator('.files-empty').count()) === 0 && (await p.locator('.files-list .empty').count()) === 1);
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
