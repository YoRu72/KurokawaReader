// node tests/pins.cjs: pins in the library (src/pins.ts, src/views/library.ts) — on an imitated phone (touch, a long
// hold made with real touch events) and on a computer (right-click, P, Ctrl+Z):
//  1. a library from before pins (no 'pins' record) opens with none; the record is written at the first pin;
//  2. a long hold on a book chooses it (as before) and the bar's second action is Pin; pinned, the book comes first,
//     marked (named «Pinned»), with an «Undo» snackbar that takes it back; a folder's and a series' long hold open
//     their menu with Pin first; several books chosen are pinned at once;
//  3. «Move pin earlier» reorders; the pins' order holds across the sort and a reload; a search lists without pins;
//  4. per place: a book pinned in a folder and in a tag is first there and not on the main page; a tag renamed keeps
//     its pins; a book deleted is unpinned everywhere;
//  5. Back closes the folder's menu first and leaves the library where it was;
//  6. a backup carries the pins (folders by name), and restored into another library (other ids) they land on the
//     same books and folder;
//  7. Arabic: the mark named in Arabic, inside the cover, never over the format badge;
//  8. a computer: right-click menu with Pin (and its key, P), P on a focused card, Ctrl+Z / Ctrl+Shift+Z; a book moved
//     to a folder from the menu, undone from the snackbar and redone with Ctrl+Shift+Z (src/ui/moveundo.ts).
// KR_PIN_SHOTS=<dir>: the previews (phone, deviceScaleFactor 2) are saved there.
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path'); const os = require('os');
const H = require('./pins/harness.cjs');
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 500))); if (!c) fails++; };
const SHOTS = process.env.KR_PIN_SHOTS ? path.resolve(process.env.KR_PIN_SHOTS) : null;
const still = (p) => p.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming?.().iterations === Infinity));
const shot = async (p, name) => { if (SHOTS) { await still(p); fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, name) }); } };
const LIB = () => [
  H.book('b1', 'Autumn Letters'), H.book('b2', 'Blue Harbor', { extra: { tags: ['Poems'] } }), H.book('b3', 'Cedar Road'), H.book('b4', 'Distant Bells', { extra: { tags: ['Poems'] } }),
  H.book('b5', 'Evening Tide', { extra: { folderId: 'f1' } }), H.book('b6', 'Far Fields', { extra: { folderId: 'f1' } }),
  H.book('b7', 'Saga 1', { extra: { series: { name: 'Saga', index: 1 } } }), H.book('b8', 'Saga 2', { extra: { series: { name: 'Saga', index: 2 } } }),
];
const META = () => ({ folders: [{ id: 'f1', name: 'Essays', createdAt: 1 }, { id: 'f2', name: 'Drafts', createdAt: 2 }], tags: [{ name: 'Poems', createdAt: 1 }] });
const barShown = () => !!document.querySelector('.selection-bar:not([hidden])');
const sheetShown = () => !!document.querySelector('.sheet');

(async () => {
  const { server, url } = await H.serve();
  const b = await chromium.launch();
  const errors = [];
  const phone = async (lang = 'en') => { const ctx = await b.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: lang }); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message)); return { ctx, p, cdp: await ctx.newCDPSession(p) }; };
  const ready = async (p) => { await p.reload(); await p.waitForSelector('.book-grid .book-card[data-book]'); };
  const actBtn = (p, label) => p.evaluateHandle((label) => [...document.querySelectorAll('.sel-act')].find((x) => x.textContent.trim() === label), label);
  const pinsOf = async (p) => (await H.meta(p, 'pins'))?.places ?? null;

  /* ---------- the phone ---------- */
  const { ctx, p, cdp } = await phone();
  await H.open(p, url); await H.seed(p, LIB(), META()); await ready(p);
  // 1. Migration from a library without pins.
  ok('a library from before pins: no pins record, nothing marked', (await H.meta(p, 'pins')) === null && !(await p.$('.pin-mark')), await H.meta(p, 'pins'));
  const series = await p.$eval('.book-card[data-series]', (e) => e.dataset.series);
  const start = await H.order(p);
  ok('the main page before: folders first, then by title', start.slice(0, 3).join() === 'f:f1,f:f2,b:b1', start);

  // 2. A long hold on a book: choosing, as before, with Pin second in the bar.
  await H.hold(p, cdp, '.book-card[data-book="b3"]', barShown);
  ok('a long hold chooses the book (as before)', /^1 selected/.test(await p.$eval('.sel-count', (e) => e.textContent)));
  const acts = await p.$$eval('.sel-act', (els) => els.map((e) => e.textContent.trim()));
  ok('the bar: Open, Pin, … — Pin the second action', acts[0] === 'Open' && acts[1] === 'Pin', acts);
  await shot(p, 'pin-select-phone.png');
  await (await actBtn(p, 'Pin')).click();
  await p.waitForFunction(() => document.querySelector('.book-grid > .book-card')?.dataset.book === 'b3');
  ok('pinned: first on the main page, before the folders, marked', (await H.order(p))[0] === 'b:b3*', await H.order(p));
  ok('the mark is named «Pinned»', (await p.$eval('.book-card[data-book="b3"] .pin-mark', (e) => e.getAttribute('aria-label'))) === 'Pinned');
  ok('the record written in its version-1 shape', JSON.stringify(await H.meta(p, 'pins')) === JSON.stringify({ v: 1, places: { main: ['b:b3'] } }), await H.meta(p, 'pins'));
  ok('a snackbar with «Undo»', (await p.$eval('.toast .toast-action', (e) => e.textContent).catch(() => '')) === 'Undo');
  await p.click('.toast .toast-action');
  await p.waitForFunction(() => !document.querySelector('.pin-mark'));
  ok('«Undo» unpins it', JSON.stringify(await pinsOf(p)) === '{}', await pinsOf(p));
  await H.hold(p, cdp, '.book-card[data-book="b3"]', barShown); await (await actBtn(p, 'Pin')).click(); await p.waitForSelector('.book-card[data-book="b3"] .pin-mark');
  // A folder's long hold: its menu, Pin first.
  await p.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 10000 });
  await H.hold(p, cdp, '.book-card[data-folder="f1"]', sheetShown);
  await p.waitForSelector('.sheet .plain-list li button');
  const rows = await p.$$eval('.sheet .plain-list li button', (els) => els.map((e) => e.textContent.trim()));
  ok("a folder's long hold: its menu, Pin first (rename and delete kept)", rows[0] === 'Pin' && rows.includes('Rename folder') && rows.includes('Delete folder'), rows);
  await shot(p, 'pin-menu-phone.png');
  // 5. Back closes the menu first, the library stays where it was.
  const lvl = await p.$eval('.library-view', (e) => e.dataset.level);
  await p.keyboard.press('Alt+ArrowLeft'); await p.waitForFunction(() => !document.querySelector('.sheet'));
  ok('Back closes the menu first, and only it', (await p.$eval('.library-view', (e) => e.dataset.level)) === lvl && (await p.$('.library-view')) !== null);
  await H.hold(p, cdp, '.book-card[data-folder="f1"]', sheetShown);
  await p.click('.sheet .plain-list li:first-child button');
  await p.waitForSelector('.book-card[data-folder="f1"] .pin-mark');
  ok('a pinned folder comes after the book pinned before it', (await H.order(p)).slice(0, 3).join() === 'b:b3*,f:f1*,f:f2', await H.order(p));
  await p.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 10000 });
  await p.$eval('.book-grid', (g) => g.scrollIntoView({ block: 'start' }));
  await shot(p, 'pin-library-phone.png');
  // A series' long hold: its menu, Pin first.
  await H.hold(p, cdp, `.book-card[data-series="${series}"]`, sheetShown);
  const srows = await p.$$eval('.sheet .dest-list .dest-row', (els) => els.map((e) => e.textContent.trim()));
  ok("a series' long hold: its menu, Pin first", srows[0] === 'Pin', srows);
  await p.click('.sheet .dest-list .dest-row.pin-row');
  await p.waitForSelector(`.book-card[data-series="${series}"] .pin-mark`);
  // Several chosen at once.
  await H.hold(p, cdp, '.book-card[data-book="b4"]', barShown);
  await p.click('.book-card[data-book="b1"]'); await p.waitForFunction(() => /^2 selected/.test(document.querySelector('.sel-count')?.textContent ?? ''));
  await (await actBtn(p, 'Pin')).click(); await p.waitForSelector('.book-card[data-book="b1"] .pin-mark');
  ok('two chosen, pinned at once (in the order listed), after the others', (await pinsOf(p)).main.join() === `b:b3,f:f1,s:${series},b:b1,b:b4`, await pinsOf(p));
  // 3. Reorder: Distant Bells one place earlier.
  await H.hold(p, cdp, '.book-card[data-book="b4"]', barShown);
  ok('a pinned book chosen: the bar offers Unpin', !!(await (await actBtn(p, 'Unpin')).asElement()));
  await (await actBtn(p, 'More')).click(); await p.waitForSelector('.sheet .dest-row');
  const more = await p.$$eval('.sheet .dest-row', (els) => els.map((e) => e.textContent.trim()));
  ok('«Move pin earlier» offered (not «later»: it is the last)', more.includes('Move pin earlier') && !more.includes('Move pin later'), more);
  await p.evaluate(() => [...document.querySelectorAll('.sheet .dest-row')].find((e) => e.textContent.trim() === 'Move pin earlier').click());
  await p.waitForFunction(() => document.querySelectorAll('.book-grid > .book-card')[3]?.dataset.book === 'b4');
  ok('moved earlier: …, Distant Bells, Autumn Letters', (await H.order(p)).slice(0, 5).join() === `b:b3*,f:f1*,s:${series}*,b:b4*,b:b1*`, await H.order(p));
  // (Esc is Back since 0.64 — src/ui/backstack.ts —: it lets the selection go itself, a moment after the key.)
  await p.keyboard.press('Escape').catch(() => {}); await p.waitForTimeout(300); if (await p.$('.selection-bar:not([hidden])')) await p.click('.sel-head [aria-label="Close"]');
  // The sort changed (newest added, reversed) and the app reloaded: the pins first, in their order.
  await p.evaluate(() => { localStorage.setItem('kr.sort', 'size'); localStorage.setItem('kr.sortDesc', '1'); }); await ready(p);
  ok('another sort, and a reload: the pins first, in their order', (await H.order(p)).slice(0, 5).join() === `b:b3*,f:f1*,s:${series}*,b:b4*,b:b1*`, await H.order(p));
  await p.evaluate(() => { localStorage.setItem('kr.sort', 'title'); localStorage.setItem('kr.sortDesc', '0'); }); await ready(p);
  // A search lists without pins.
  await p.fill('.library-view input[type=search]', 'e'); await p.waitForFunction(() => document.querySelector('.library-view')?.dataset.level?.endsWith('q'));
  const found = await H.order(p);
  ok('a search: no pins (listed by the sort, no mark)', found[0] === 'b:b1' && !found.some((x) => x.endsWith('*')), found);
  await p.$eval('.library-view input[type=search]', (e) => e.blur());
  await p.keyboard.press('Alt+ArrowLeft'); await p.waitForFunction(() => !document.querySelector('.library-view')?.dataset.level?.endsWith('q'));

  // 4. Per place: a folder.
  await p.click('.book-card[data-folder="f1"]'); await p.waitForFunction(() => document.querySelector('.library-view')?.dataset.level?.startsWith('f1|'));
  await p.waitForSelector('.book-grid .book-card[data-book="b6"]');
  await H.hold(p, cdp, '.book-card[data-book="b6"]', barShown); await (await actBtn(p, 'Pin')).click();
  await p.waitForSelector('.book-card[data-book="b6"] .pin-mark');
  ok('in a folder: its own pin first (Far Fields before Evening Tide)', (await H.order(p)).join() === 'b:b6*,b:b5', await H.order(p));
  ok('kept under the folder, not the main page', (await pinsOf(p))['folder:f1']?.join() === 'b:b6' && !(await pinsOf(p)).main.includes('b:b6'), await pinsOf(p));
  await p.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 10000 });
  await shot(p, 'pin-folder-phone.png');
  await p.keyboard.press('Alt+ArrowLeft'); await p.waitForFunction(() => document.querySelector('.library-view')?.dataset.level?.startsWith('||'));
  // A tag: Distant Bells is pinned on the main page; in the tag Blue Harbor is pinned.
  await p.click('.tag-chips .chip:has-text("Poems")'); await p.waitForFunction(() => document.querySelector('.library-view')?.dataset.level?.includes('|Poems|'));
  ok('in a tag: the main page\'s pins are not this place\'s (Blue Harbor first, nothing marked)', (await H.order(p)).join() === 'b:b2,b:b4', await H.order(p));
  await H.hold(p, cdp, '.book-card[data-book="b4"]', barShown); await (await actBtn(p, 'Pin')).click();
  await p.waitForSelector('.book-card[data-book="b4"] .pin-mark');
  ok('pinned in the tag: first there', (await H.order(p)).join() === 'b:b4*,b:b2', await H.order(p));
  // The tag renamed (its menu: a long hold on its chip): its pins go with it.
  await H.hold(p, cdp, '.tag-chips .chip:has-text("Poems")', sheetShown);
  await p.click('.sheet .plain-list li:nth-child(2) button'); await p.waitForSelector('.sheet input[type=text]'); // (the first row is Pin / Unpin)
  await p.fill('.sheet input[type=text]', 'Verse'); await p.click('.sheet .sheet-actions .btn.primary');
  await p.waitForFunction(() => document.querySelector('.library-view')?.dataset.level?.includes('|Verse|'));
  ok('a tag renamed keeps its pins', (await pinsOf(p))['tag:Verse']?.join() === 'b:b4' && !(await pinsOf(p))['tag:Poems'], await pinsOf(p));
  await p.keyboard.press('Alt+ArrowLeft'); await p.waitForFunction(() => document.querySelector('.library-view')?.dataset.level?.startsWith('||'));
  // A tag chip pinned from its menu (Pin first, then Rename, Delete): first among the chips, marked, kept in the main place;
  // renamed it keeps the pin; unpinned from the same menu, the pins are as they were.
  const mainBefore = (await pinsOf(p)).main.join();
  await H.hold(p, cdp, '.tag-chips .chip:has-text("Verse")', sheetShown);
  ok('a tag chip\'s menu: Pin, Rename, Delete', (await p.$$eval('.sheet .plain-list li button', (bs) => bs.map((b) => b.textContent.trim()))).join() === 'Pin,Rename tag,Delete tag', await p.$$eval('.sheet .plain-list li button', (bs) => bs.map((b) => b.textContent.trim())));
  await p.click('.sheet .plain-list li:first-child button'); await p.waitForFunction(() => !document.querySelector('.sheet'));
  await p.waitForSelector('.tag-chips .chip[data-pinned="1"]');
  ok('a pinned tag is kept in the main place as t:<name>', (await pinsOf(p)).main.includes('t:Verse'), await pinsOf(p));
  ok('a pinned tag chip is first of the tags and marked', await p.$eval('.tag-chips .chip[data-pinned="1"]', (c) => c.textContent.includes('Verse') && !!c.querySelector('svg') && c === [...c.parentElement.children].find((x) => !x.classList.contains('fav'))), await p.$$eval('.tag-chips .chip', (cs) => cs.map((c) => c.textContent.trim())));
  await shot(p, 'pin-tag-phone.png');
  await H.hold(p, cdp, '.tag-chips .chip:has-text("Verse")', sheetShown);
  ok('its menu now says Unpin', (await p.$eval('.sheet .plain-list li:first-child button', (b) => b.textContent.trim())) === 'Unpin');
  await p.click('.sheet .plain-list li:first-child button'); await p.waitForFunction(() => !document.querySelector('.sheet'));
  await p.waitForFunction(() => !document.querySelector('.tag-chips .chip[data-pinned="1"]'));
  ok('unpinned: the pins are as they were', (await pinsOf(p)).main.join() === mainBefore, await pinsOf(p));
  await p.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 10000 });

  // 6. A backup (the automatic one, made from Settings) carries them, by name.
  await p.goto(url + '#/settings'); await p.waitForSelector('.settings-body');
  await p.waitForFunction(() => [...document.querySelectorAll('.settings-body button')].some((x) => /Back up now/i.test(x.textContent)));
  await p.evaluate(() => [...document.querySelectorAll('.settings-body button')].find((x) => /Back up now/i.test(x.textContent)).click());
  await H.until(p, async () => !!(await H.meta(p, 'autobackup:index'))?.length);
  const idx = await H.meta(p, 'autobackup:index'); const text = await H.meta(p, idx[0].key); const man = JSON.parse(text);
  ok('the backup carries the pins: folders by name, books by their ids', man.libraryPins?.places?.main?.join() === `b:b3,f:Essays,s:${series},b:b4,b:b1` && man.libraryPins.places['folder:Essays']?.join() === 'b:b6' && man.libraryPins.places['tag:Verse']?.join() === 'b:b4', man.libraryPins);
  // Restored into another library: the same books and folder under other ids.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-pins-')); const file = path.join(tmp, 'KurokawaReader-backup.json'); fs.writeFileSync(file, text);
  {
    const o = await phone(); await H.open(o.p, url);
    const other = LIB().map((x) => ({ ...x, id: 'n' + x.id.slice(1), ...(x.folderId ? { folderId: 'g1' } : {}) }));
    await H.seed(o.p, other, { folders: [{ id: 'g1', name: 'Essays', createdAt: 1 }], pins: { v: 1, places: { main: ['b:n2'] } } }); await ready(o.p);
    await o.p.goto(url + '#/settings'); await o.p.waitForSelector('.settings-body');
    await o.p.setInputFiles('.settings-body input[type=file][accept^=".json"]', file);
    await o.p.waitForFunction(() => /Restored|restored/.test(document.querySelector('.settings-body')?.textContent ?? ''), null, { timeout: 20000 });
    const got = (await H.meta(o.p, 'pins'))?.places ?? {};
    ok('restored elsewhere: the device\'s pin kept first, the backup\'s mapped to this library\'s ids', got.main?.join() === `b:n2,b:n3,f:g1,s:${series},b:n4,b:n1` && got['folder:g1']?.join() === 'b:n6' && got['tag:Verse']?.join() === 'b:n4', got);
    await o.ctx.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  await p.goto(url); await p.waitForSelector('.book-grid .book-card[data-book]');
  // A book deleted: unpinned everywhere (once really removed — held for «Undo» until then).
  await H.hold(p, cdp, '.book-card[data-book="b4"]', barShown);
  await (await actBtn(p, 'More')).click(); await p.waitForSelector('.sheet .dest-row');
  await p.evaluate(() => [...document.querySelectorAll('.sheet .dest-row')].find((e) => e.textContent.trim() === 'Delete').click());
  await p.waitForSelector('.del-sheet'); await p.click('.del-sheet .del-go');
  await p.waitForFunction(() => !document.querySelector('.book-card[data-book="b4"]'));
  await p.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await H.until(p, async () => !JSON.stringify(await pinsOf(p)).includes('b:b4'));
  ok('a book deleted: unpinned from the main page and the tag', !JSON.stringify(await pinsOf(p)).includes('b:b4'), await pinsOf(p));
  await ctx.close();

  /* ---------- 7. Arabic ---------- */
  {
    const a = await phone('ar'); await H.open(a.p, url, 'ar');
    await H.seed(a.p, LIB(), { ...META(), pins: { v: 1, places: { main: ['b:b2', 'f:f1'] } } }); await ready(a.p);
    await a.p.waitForSelector('.book-card[data-book="b2"] .pin-mark');
    const g = await a.p.$eval('.book-card[data-book="b2"]', (el) => { const r = (s) => el.querySelector(s).getBoundingClientRect().toJSON(); return { dir: document.documentElement.dir, mark: r('.pin-mark'), fmt: [...el.querySelectorAll('.badges .badge')].find((x) => !x.classList.contains('pin-mark')).getBoundingClientRect().toJSON(), cover: r('.cover'), name: el.querySelector('.pin-mark').getAttribute('aria-label') }; });
    const apart = (x, y) => x.right <= y.left + 0.5 || y.right <= x.left + 0.5 || x.bottom <= y.top + 0.5 || y.bottom <= x.top + 0.5;
    ok('Arabic: right to left, the mark named «مثبَّت»', g.dir === 'rtl' && g.name === 'مثبَّت', g);
    ok('Arabic: the mark inside the cover, beside the format badge, not over it', apart(g.mark, g.fmt) && g.mark.left >= g.cover.left && g.mark.right <= g.cover.right && g.mark.top >= g.cover.top, g);
    ok('Arabic: the pinned first (the book, then the folder)', (await H.order(a.p)).slice(0, 2).join() === 'b:b2*,f:f1*', await H.order(a.p));
    await a.p.$eval('.book-grid', (g) => g.scrollIntoView({ block: 'start' }));
    await shot(a.p, 'pin-library-phone-ar.png');
    await a.ctx.close();
  }

  /* ---------- 8. A computer ---------- */
  {
    const ctx2 = await b.newContext({ viewport: { width: 1280, height: 860 }, locale: 'en' }); const q = await ctx2.newPage(); q.on('pageerror', (e) => errors.push(e.message));
    await H.open(q, url); await H.seed(q, LIB(), META()); await ready(q);
    ok('a computer: the pc layout', await q.evaluate(() => document.documentElement.classList.contains('pc')));
    await q.click('.book-card[data-book="b2"]', { button: 'right' }); await q.waitForSelector('.sheet.as-menu');
    const menu = await q.$$eval('.sheet .dest-row', (els) => els.map((e) => e.textContent.trim()));
    ok('right-click: the menu has Pin, with its key P (no touch hints)', menu.includes('PinP') && !menu.some((x) => /hold|tap/i.test(x)), menu);
    await q.evaluate(() => [...document.querySelectorAll('.sheet .dest-row')].find((e) => e.textContent.trim() === 'PinP').click());
    await q.waitForSelector('.book-card[data-book="b2"] .pin-mark');
    ok('pinned from the menu: first', (await H.order(q))[0] === 'b:b2*', await H.order(q));
    await q.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 10000 });
    await q.focus('.book-card[data-book="b3"]'); await q.keyboard.press('p');
    await q.waitForSelector('.book-card[data-book="b3"] .pin-mark');
    ok('P on a focused card pins it', (await H.order(q)).slice(0, 2).join() === 'b:b2*,b:b3*', await H.order(q));
    await q.click('.library-hero'); await q.keyboard.press('Control+z');
    await q.waitForFunction(() => !document.querySelector('.book-card[data-book="b3"] .pin-mark'));
    ok('Ctrl+Z undoes the last pin', (await pinsOf(q)).main.join() === 'b:b2', await pinsOf(q));
    await q.keyboard.press('Control+Shift+z'); await q.waitForSelector('.book-card[data-book="b3"] .pin-mark');
    ok('Ctrl+Shift+Z redoes it', (await pinsOf(q)).main.join() === 'b:b2,b:b3', await pinsOf(q));
    await q.keyboard.press('Control+z'); await q.waitForFunction(() => !document.querySelector('.book-card[data-book="b3"] .pin-mark'));
    await q.keyboard.press('Control+y'); await q.waitForSelector('.book-card[data-book="b3"] .pin-mark');
    ok('Ctrl+Y redoes too', (await pinsOf(q)).main.join() === 'b:b2,b:b3', await pinsOf(q));
    // Moved to a folder (the right-click menu's «Move to folder»): «Undo» puts it back, Ctrl+Shift+Z moves it again.
    const folderOf = (id) => q.evaluate((id) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const g = r.result.transaction('books').objectStore('books').get(id); g.onsuccess = () => { res(g.result?.folderId ?? null); r.result.close(); }; }; }), id);
    await q.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 10000 });
    await q.click('.book-card[data-book="b1"]', { button: 'right' }); await q.waitForSelector('.sheet.as-menu');
    await q.evaluate(() => [...document.querySelectorAll('.sheet .dest-row')].find((e) => e.textContent.trim() === 'Move to folder').click());
    await q.waitForFunction(() => [...document.querySelectorAll('.sheet .plain-list li button')].some((e) => e.textContent.trim() === 'Essays'));
    await q.evaluate(() => [...document.querySelectorAll('.sheet .plain-list li button')].find((e) => e.textContent.trim() === 'Essays').click());
    await q.waitForFunction(() => /Moved to “Essays”: 1/.test(document.querySelector('.toast')?.textContent ?? ''));
    ok('moved to a folder: said, with «Undo»', (await folderOf('b1')) === 'f1' && (await q.$eval('.toast .toast-action', (e) => e.textContent)) === 'Undo');
    await q.click('.toast .toast-action');
    ok('«Undo»: back in no folder, listed on the main page again', await H.until(q, async () => (await folderOf('b1')) === null && !!(await q.$('.book-card[data-book="b1"]'))));
    await q.click('.library-hero'); await q.keyboard.press('Control+Shift+z');
    ok('Ctrl+Shift+Z: moved again', await H.until(q, async () => (await folderOf('b1')) === 'f1' && !(await q.$('.book-card[data-book="b1"]'))));
    await ctx2.close();
  }
  ok('no page errors', errors.length === 0, errors);
  console.log(fails ? `${fails} failed` : 'all passed');
  await b.close(); server.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
