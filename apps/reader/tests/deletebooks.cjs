// node tests/deletebooks.cjs: the library's delete dialog (src/ui/deletebooks.ts, src/devicefiles.ts) — with fake
// bridges recording what they are asked (an imitated Android app, an imitated computer app), and a plain web page:
//  1. web, the app's own copies only: no box (removing the book removes the copy), the notes said to go with it;
//     the books are held with «Undo» — undone, they come back exactly (notes, folder, tags, pins); not undone, they
//     are removed when the snackbar ends;
//  2. Android: own copy / a folder's document (SAF tree) / a file found by the Download scan / a read-only «Open
//     with» document / one already gone — the box shown (unticked), «device» wording, «deleted for good», the counts;
//     ticked: deleteDocument asked for exactly the two it may delete, with their uri (and tree); one that fails is
//     said in a snackbar whose «Show» lists where it lies; no «Undo» once files went;
//  3. Arabic: the counts as «العدد: …», right to left;
//  4. a computer (Windows): «computer» wording, the Recycle Bin; ticked: trashFile asked with the path, «Moved to the
//     Recycle Bin»; unticked: Ctrl+Z brings the book back, Ctrl+Shift+Z holds it again (src/ui/undo.ts);
//  5. a book found by a scan, deleted without the box: its file is not touched and nothing brings the book back.
// KR_PIN_SHOTS=<dir>: delete-dialog-phone.png, delete-dialog-phone-ar.png, delete-dialog-pc.png.
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
const H = require('./pins/harness.cjs');
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 500))); if (!c) fails++; };
const SHOTS = process.env.KR_PIN_SHOTS ? path.resolve(process.env.KR_PIN_SHOTS) : null;
const still = (p) => p.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming?.().iterations === Infinity));
const shot = async (p, name) => { if (SHOTS) { await still(p); fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, name) }); } };

const TREE = 'content://com.android.externalstorage.documents/tree/primary%3ABooks';
const SRC = {
  saf: { uri: `${TREE}/document/primary%3ABooks%2FRiver.epub`, tree: TREE },
  scan: { uri: 'file:///storage/emulated/0/Download/Harbor.pdf' },
  openWith: { uri: 'content://com.whatsapp.provider.media/item/42' },
  gone: { uri: `${TREE}/document/primary%3ABooks%2FGone.epub`, tree: TREE },
};
// An imitated Android app: canDeleteDocument says what a real one would; deleteDocument records, and fails for one.
const ANDROID = (src) => {
  window.__del = [];
  const can = { [src.saf.uri]: { can: true }, [src.scan.uri]: { can: true }, [src.openWith.uri]: { can: false }, [src.gone.uri]: { can: false, gone: true } };
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {
    App: { addListener: () => Promise.resolve({ remove() {} }), getLaunchUrl: async () => null, minimizeApp: async () => {} },
    Kurokawa: {
      canDeleteDocument: async (o) => can[o.uri] ?? { can: false },
      deleteDocument: async (o) => { window.__del.push(o); if (window.__failScan && o.uri.startsWith('file:')) throw new Error('EACCES'); return { deleted: true, gone: false }; },
    },
  } };
};
// An imitated computer app (Windows): trashFile records.
const DESKTOP = () => {
  window.__trash = [];
  window.kurokawaDesktop = { platform: 'win32', onOpenFile() {}, trashFile: async (p) => { window.__trash.push(p); return { ok: true, gone: false }; } };
};

(async () => {
  const { server, url } = await H.serve();
  const b = await chromium.launch(); const errors = [];
  const phoneCtx = async (lang, init, arg) => { const ctx = await b.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: lang }); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message)); if (init) await p.addInitScript(init, arg); return { ctx, p }; };
  const ready = async (p) => { await p.reload(); await p.waitForSelector('.book-grid .book-card[data-book]'); };
  const choose = async (p, ids) => {
    if (!(await p.$('.selection-bar:not([hidden])'))) await p.click('.library-view [aria-label="Select"], .library-view [aria-label="تحديد"]');
    for (const id of ids) await p.click(`.book-card[data-book="${id}"]`);
  };
  const openDelete = async (p) => {
    const del = await p.evaluateHandle(() => [...document.querySelectorAll('.sel-act')].find((x) => x.querySelector('[data-icon="trash"]') || /Delete|حذف/.test(x.textContent)));
    if (del.asElement()) await del.asElement().click(); else { await p.click('.sel-act:last-child'); await p.waitForSelector('.sheet .dest-row'); await p.evaluate(() => [...document.querySelectorAll('.sheet .dest-row')].pop().click()); }
    await p.waitForSelector('.del-sheet .del-go');
  };
  const counts = (p) => p.$$eval('.del-sheet .del-count', (els) => Object.fromEntries(els.map((e) => [e.dataset.count, e.textContent.trim()])));

  /* ---------- 1. Web: the app's own copies, held with «Undo» ---------- */
  {
    const { ctx, p } = await phoneCtx('en');
    await H.open(p, url);
    await H.seed(p, [H.book('w1', 'Quiet Mornings', { highlights: [{ id: 'h1', text: 'a line', color: 'amber', createdAt: 1 }], extra: { folderId: 'fx', tags: ['Calm'] } }), H.book('w2', 'Loud Evenings')],
      { folders: [{ id: 'fx', name: 'Shelf', createdAt: 1 }], tags: [{ name: 'Calm', createdAt: 1 }], pins: { v: 1, places: { 'folder:fx': ['b:w1'], 'tag:Calm': ['b:w1'] } } });
    await ready(p);
    // (Into its folder: the book is listed there.)
    await p.click('.book-card[data-folder="fx"]'); await p.waitForSelector('.book-card[data-book="w1"]');
    const before = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').get('w1'); q.onsuccess = () => { res(q.result); r.result.close(); }; }; }));
    await choose(p, ['w1']); await openDelete(p);
    ok('web: no box — the app keeps its own copy only', !(await p.$('.del-sheet .del-box')) && Object.keys(await counts(p)).length === 0, await counts(p));
    const wd = await p.$$eval('.del-sheet .sheet-actions > .btn', (b) => b.map((x) => Math.round(x.getBoundingClientRect().width)));
    ok('the dialog\'s two buttons are as wide as each other (side by side or stacked)', wd.length === 2 && Math.abs(wd[0] - wd[1]) <= 1, wd);
    const text = await p.$eval('.del-sheet .sheet-body', (e) => e.textContent);
    ok('the dialog: the book named, that its notes go with it, that it cannot be undone', /Quiet Mornings/.test(text) && /notes or highlights/.test(text) && /cannot be undone/.test(text), text);
    await p.click('.del-sheet .del-go');
    await p.waitForFunction(() => !document.querySelector('.book-card[data-book="w1"]'));
    ok('deleted: gone from the library at once, a snackbar with «Undo»', (await p.$eval('.toast .toast-action', (e) => e.textContent).catch(() => '')) === 'Undo');
    ok('…but held: still in the database while «Undo» shows', (await H.bookIds(p)).includes('w1'));
    await p.click('.toast .toast-action');
    await p.waitForSelector('.book-card[data-book="w1"]');
    const after = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').get('w1'); q.onsuccess = () => { res(q.result); r.result.close(); }; }; }));
    ok('«Undo»: the book back exactly — notes, folder, tags', JSON.stringify(after) === JSON.stringify(before), { before, after });
    ok('…and its pins in the folder and the tag', JSON.stringify((await H.meta(p, 'pins')).places) === JSON.stringify({ 'folder:fx': ['b:w1'], 'tag:Calm': ['b:w1'] }), await H.meta(p, 'pins'));
    // Not undone: removed when the snackbar ends.
    await p.keyboard.press('Alt+ArrowLeft'); await p.waitForSelector('.book-card[data-book="w2"]');
    await choose(p, ['w2']); await openDelete(p); await p.click('.del-sheet .del-go');
    await p.waitForFunction(() => !document.querySelector('.book-card[data-book="w2"]'));
    ok('not undone: removed once the snackbar ends', await H.until(p, async () => !(await H.bookIds(p)).includes('w2'), 15000), await H.bookIds(p));
    ok('…and only it', (await H.bookIds(p)).join() === 'w1', await H.bookIds(p));
    await ctx.close();
  }

  /* ---------- 2. Android: the cases, the box, the bridge ---------- */
  const lib = () => [H.book('o1', 'Own Copy'), H.book('a1', 'River', { extra: { source: SRC.saf } }), H.book('a2', 'Shared Doc', { extra: { source: SRC.openWith } }), H.book('a3', 'Harbor', { extra: { source: SRC.scan } }), H.book('a4', 'Gone Book', { extra: { source: SRC.gone } })];
  {
    const { ctx, p } = await phoneCtx('en', ANDROID, SRC);
    await H.open(p, url); await H.seed(p, lib()); await ready(p);
    await choose(p, ['o1', 'a1', 'a2', 'a3', 'a4']); await openDelete(p);
    const box = await p.$('.del-sheet .del-box');
    ok('Android: the box shown, unticked', !!box && !(await box.isChecked()));
    const label = await p.$eval('.del-opt', (e) => e.textContent);
    ok('«device» wording, deleted for good, cannot be undone', /Also delete the file from the device/.test(label) && /deleted for good/.test(label) && /cannot be undone/.test(label), label);
    const c = await counts(p);
    ok('the counts: 1 kept inside the app, 2 can be deleted, 1 stays (read only), 1 already gone', /: 1 /.test(c.own) && /can be deleted: 2/.test(c.can) && /stay where they are: 1/.test(c.cannot) && /already gone.*: 1/.test(c.gone), c);
    await shot(p, 'delete-dialog-phone.png');
    // Cancelled: nothing asked, nothing removed.
    await p.click('.del-sheet .sheet-actions .btn:not(.del-go)'); await p.waitForFunction(() => !document.querySelector('.del-sheet'));
    ok('cancelled: nothing deleted, no bridge call', (await p.evaluate(() => window.__del.length)) === 0 && (await H.bookIds(p)).length === 5);
    // Ticked, with the scan's file failing.
    await p.evaluate(() => { window.__failScan = true; });
    if (!(await p.$('.selection-bar:not([hidden])'))) await choose(p, ['o1', 'a1', 'a2', 'a3', 'a4']);
    await openDelete(p); await p.check('.del-sheet .del-box'); await p.click('.del-sheet .del-go');
    await p.waitForSelector('.toast.error');
    const calls = await p.evaluate(() => window.__del);
    ok('the bridge asked to delete exactly the two it may, with uri and tree', JSON.stringify(calls.map((x) => x.uri).sort()) === JSON.stringify([SRC.saf.uri, SRC.scan.uri].sort()) && calls.find((x) => x.uri === SRC.saf.uri).tree === TREE && !('tree' in calls.find((x) => x.uri === SRC.scan.uri)), calls);
    ok('the books removed from the library at once (files went: no hold)', (await H.bookIds(p)).length === 0, await H.bookIds(p));
    const snack = await p.$eval('.toast.error', (e) => e.textContent);
    ok('the failure said, with «Show» and no «Undo»', /could not be deleted: 1/.test(snack) && /Show/.test(snack) && !/Undo/.test(snack), snack);
    await p.click('.toast .toast-action'); await p.waitForSelector('.sheet .del-where li');
    ok('«Show»: where the file lies', (await p.$eval('.sheet .del-where', (e) => e.textContent)).includes('/storage/emulated/0/Download/Harbor.pdf'));
    await ctx.close();
  }

  /* ---------- 3. Arabic ---------- */
  {
    const { ctx, p } = await phoneCtx('ar', ANDROID, SRC);
    await H.open(p, url, 'ar'); await H.seed(p, lib()); await ready(p);
    await choose(p, ['o1', 'a1', 'a2', 'a3', 'a4']); await openDelete(p);
    const c = await counts(p); const label = await p.$eval('.del-opt', (e) => e.textContent);
    ok('Arabic: right to left, the box in Arabic', (await p.evaluate(() => document.documentElement.dir)) === 'rtl' && /احذف الملفَّ من الجهاز أيضًا/.test(label), label);
    ok('Arabic: the counts as «العدد: …», in 0–9 (the default digits)', /العدد: 2/.test(c.can) && /العدد: 1/.test(c.cannot) && /العدد: 1/.test(c.own) && !/[٠-٩]/.test(c.can + c.cannot + c.own), c);
    await shot(p, 'delete-dialog-phone-ar.png');
    await ctx.close();
  }

  /* ---------- 4. A computer (Windows) ---------- */
  {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, locale: 'en' }); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
    await p.addInitScript(DESKTOP);
    await H.open(p, url); await H.seed(p, [H.book('d1', 'Linked Atlas', { extra: { source: { path: 'C:\\Books\\Linked Atlas.epub' } } }), H.book('d2', 'Copied Notes')]); await ready(p);
    await p.click('.book-card[data-book="d1"]', { button: 'right' }); await p.waitForSelector('.sheet.as-menu');
    await p.click('.sheet .sheet-actions .btn.danger'); await p.waitForSelector('.del-sheet .del-go');
    const label = await p.$eval('.del-opt', (e) => e.textContent);
    ok('a computer: «computer» wording, the Recycle Bin, restorable', /Also delete the file from the computer/.test(label) && /Recycle Bin/.test(label) && /restore/.test(label), label);
    ok('unticked by default', !(await p.isChecked('.del-sheet .del-box')));
    await shot(p, 'delete-dialog-pc.png');
    // Unticked: held; Ctrl+Z brings it back.
    await p.click('.del-sheet .del-go'); await p.waitForFunction(() => !document.querySelector('.book-card[data-book="d1"]'));
    await p.click('.library-hero'); await p.keyboard.press('Control+z');
    await p.waitForSelector('.book-card[data-book="d1"]');
    ok('unticked, then Ctrl+Z: the book back, nothing sent to the bin', (await p.evaluate(() => window.__trash.length)) === 0 && (await H.bookIds(p)).includes('d1'));
    // Redone (Ctrl+Shift+Z): held again, with «Undo» again; undone once more.
    await p.keyboard.press('Control+Shift+z'); await p.waitForFunction(() => !document.querySelector('.book-card[data-book="d1"]'));
    ok('Ctrl+Shift+Z: held again (still in the database), «Undo» shown', (await H.bookIds(p)).includes('d1') && (await p.$eval('.toast .toast-action', (e) => e.textContent).catch(() => '')) === 'Undo');
    await p.keyboard.press('Control+z'); await p.waitForSelector('.book-card[data-book="d1"]');
    // Ticked: to the Recycle Bin, said so, no «Undo».
    await p.click('.book-card[data-book="d1"]', { button: 'right' }); await p.waitForSelector('.sheet.as-menu');
    await p.click('.sheet .sheet-actions .btn.danger'); await p.waitForSelector('.del-sheet .del-go');
    await p.check('.del-sheet .del-box'); await p.click('.del-sheet .del-go');
    await p.waitForFunction(() => /Recycle Bin/.test(document.querySelector('.toast')?.textContent ?? ''));
    ok('ticked: trashFile asked with the path', JSON.stringify(await p.evaluate(() => window.__trash)) === JSON.stringify(['C:\\Books\\Linked Atlas.epub']));
    ok('«Moved to the Recycle Bin: 1», no «Undo»', !(await p.$('.toast .toast-action')) && /Moved to the Recycle Bin: 1/.test(await p.$eval('.toast', (e) => e.textContent)));
    ok('removed at once', (await H.bookIds(p)).join() === 'd2', await H.bookIds(p));
    await ctx.close();
  }

  /* ---------- 5. A book found by a scan, deleted without the box ---------- */
  {
    const { ctx, p } = await phoneCtx('en', ANDROID, SRC);
    await H.open(p, url); await H.seed(p, [H.book('a3', 'Harbor', { extra: { source: SRC.scan } }), H.book('o1', 'Own Copy')]); await ready(p);
    await choose(p, ['a3']); await openDelete(p); await p.click('.del-sheet .del-go');
    await p.waitForFunction(() => !document.querySelector('.book-card[data-book="a3"]'));
    await p.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    ok('removed from the library', await H.until(p, async () => !(await H.bookIds(p)).includes('a3')));
    ok('its file untouched (no bridge call)', (await p.evaluate(() => window.__del.length)) === 0);
    await ready(p);
    ok('nothing brings it back (no watched folders): still gone after a reload', !(await H.bookIds(p)).includes('a3') && !(await p.$('.book-card[data-book="a3"]')));
    await ctx.close();
  }
  ok('no page errors', errors.length === 0, errors);
  console.log(fails ? `${fails} failed` : 'all passed');
  await b.close(); server.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
