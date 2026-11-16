// The smaller Files features of 0.21.0, one section each, on the pretend phone (tests/filesphone-fixture.cjs) at 360 px and,
// where it matters, a computer's width; English and Arabic. Sections: foldersize, scroller, gallery, editor.
// Run: NODE_PATH=$(npm root -g) node tests/filesextras.cjs [en|ar] [section ...]
const { chromium } = require('playwright'); const F = require('./filesphone-fixture.cjs'); const { K } = F; const path = require('node:path');
let fails = 0; const ok = (what, cond, x) => { console.log((cond ? 'ok   ' : 'FAIL ') + what + (cond || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 300))); if (!cond) fails++; };
const shot = (p, name) => (process.env.KT_SHOTS ? p.screenshot({ path: path.join(process.env.KT_SHOTS, name) }) : null);
const langs = process.argv[2] === 'ar' ? ['ar'] : process.argv[2] === 'en' ? ['en'] : ['en', 'ar'];
const only = process.argv.slice(3);
const want = (s) => !only.length || only.includes(s);
const W = { en: { calc: 'Calculate size', again: 'Calculate again', unknown: 'Folders without a known size', all: 'Calculate sizes', props: 'Properties', sortBy: 'Sort by' }, ar: { calc: 'احسب الحجم', again: 'أعد الحساب', unknown: 'مجلدات لم يُعلم حجمها', all: 'احسب الأحجام', props: 'الخصائص', sortBy: '' } };

/** The page on the pretend phone with a counted filesList (and an optional pause per listing). */
async function page(browser, port, z, lang, o = {}) {
  const { page: p, errors } = await F.open(browser, { lang, pc: !!o.pc, z, many: o.many ?? 0, width: 360, height: 780 });
  await p.addInitScript(() => {
    const kt = window.Capacitor.Plugins.KurokawaTools; const orig = kt.filesList; window.__lists = 0; window.__listPause = 0;
    // (File bytes for the editor: window.__bytes[path] = Uint8Array; uriRead honours max and offset, uriWrite stores.)
    window.__bytes = {}; window.__writes = []; const b64 = (u) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
    kt.uriRead = async ({ path, max = 4000000, offset = 0 }) => { const u = window.__bytes[path]; if (!u) throw new Error('missing'); const part = u.subarray(offset, Math.min(u.length, offset + max)); return { b64: b64(part), size: u.length, whole: offset + max >= u.length }; };
    kt.uriWrite = async ({ path, b64: d }) => { const bin = atob(d); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); window.__bytes[path] = u; window.__writes.push(path); return { size: u.length }; };
    kt.appsFor = async () => ({ apps: [] });
    window.__thumbs = []; kt.filesThumb = async (o) => { window.__thumbs.push(o.path); if (!/\.(jpe?g|mp4)$/.test(o.path)) return { url: null }; const c = document.createElement('canvas'); c.width = 8; c.height = 8; const g = c.getContext('2d'); g.fillStyle = 'hsl(' + (o.path.length * 37 % 360) + ',55%,55%)'; g.fillRect(0, 0, 8, 8); return { url: c.toDataURL() }; };
    kt.filesList = async (o) => { window.__lists++; if (window.__listPause) await new Promise((r) => setTimeout(r, window.__listPause)); return orig(o); };
  });
  if (o.seed) await p.addInitScript(o.seed, K);
  await p.goto(`http://localhost:${port}/#/files?p=${encodeURIComponent(o.at ?? K)}`); await p.waitForSelector('.files-row'); await p.waitForTimeout(400);
  return { p, errors };
}
const rowOf = (p, name) => p.locator('.files-row', { has: p.locator(`.files-name[title="${name}"]`) });
const menu = async (p, name) => { await rowOf(p, name).locator('button.icon-btn[data-icon="more"]').click(); await p.waitForSelector('.sheet .dest-row'); };
const meta = (p, name) => rowOf(p, name).locator('.src').first().textContent();

async function foldersize(browser, port, z, lang) {
  const L = (s) => `[${lang}-size] ${s}`; const w = W[lang];
  const { p, errors } = await page(browser, port, z, lang);
  // Sub holds in.txt (10 B) and Deeper/deep.txt (10 B): 2 files, 1 folder, 20 B.
  ok(L('before: the folder row shows no size'), !/20/.test(await meta(p, 'Sub')));
  await menu(p, 'Sub'); ok(L('the folder menu offers Calculate size'), (await p.locator('.sheet .dest-row', { hasText: w.calc }).count()) === 1);
  await p.locator('.sheet .dest-row', { hasText: w.calc }).click(); await p.waitForSelector('.files-props'); await p.waitForTimeout(800);
  const props = await p.textContent('.files-props');
  ok(L('properties: counted bytes, files and folders'), /20 B/.test(props) && /(2 files|ملفان)/.test(props) && /(1 folder|مجلد واحد)/.test(props), props);
  ok(L('properties: the button now offers to calculate again'), (await p.locator('.sheet .files-size-go', { hasText: w.again }).count()) === 1);
  const lists = await p.evaluate(() => window.__lists);
  await shot(p, `extras-folder-size${lang === 'ar' ? '-ar' : ''}.png`);
  await p.click('.sheet .sheet-head button[aria-label]'); await p.waitForTimeout(300);
  ok(L('the row shows the folder size once known'), /20 B|٢٠/.test(await meta(p, 'Sub')), await meta(p, 'Sub'));
  // cached: properties again counts nothing
  await menu(p, 'Sub'); await p.locator('.sheet .dest-row', { hasText: w.props }).click(); await p.waitForSelector('.files-props'); await p.waitForTimeout(500);
  ok(L('cached: properties show the size at once, without listing again'), /20 B/.test(await p.textContent('.files-props')) && (await p.evaluate(() => window.__lists)) - lists <= 1);
  await p.click('.sheet .sheet-head button[aria-label]'); await p.waitForTimeout(300);
  // the folder's date changes: the cache is let go
  await p.evaluate((k) => { window.__put(k + '/Sub', true, 0, 1770000000000); }, K); await p.evaluate(() => document.querySelector('.files-view') && null);
  await p.click('.topbar-actions .icon-btn[data-icon="more"]'); await p.locator('.sheet .dest-row', { hasText: /Refresh|تحديث/ }).click(); await p.waitForTimeout(500);
  ok(L('the folder changed: its old size is not shown'), !/20 B/.test(await meta(p, 'Sub')), await meta(p, 'Sub'));
  // sort by size: unknown folders said, Calculate sizes does them all
  await p.click('.topbar-actions .icon-btn[data-icon="sort"]'); await p.locator('.sheet .dest-row').nth(2).click(); await p.waitForTimeout(400);
  const note = await p.locator('.files-sizenote').textContent();
  ok(L('sort by size says some folders are unknown'), new RegExp(w.unknown).test(note) && /[0-9٠-٩]/.test(note), note);
  await shot(p, `extras-folder-size-sort${lang === 'ar' ? '-ar' : ''}.png`);
  await p.locator('.files-sizenote .btn', { hasText: w.all }).click(); await p.waitForTimeout(1200);
  ok(L('after Calculate sizes the note is gone and the rows show sizes'), (await p.locator('.files-sizenote').isHidden()) && /B/.test(await meta(p, 'Sub')), await meta(p, 'Sub'));
  ok(L('no page errors'), !errors.filter((x) => !/favicon/.test(x)).length, errors); await p.close();
}

async function bigsize(browser, port, z, lang) {
  const L = (s) => `[${lang}-size5000] ${s}`; const w = W[lang];
  const { p, errors } = await page(browser, port, z, lang);
  // 5,000 files in 50 folders of 100, and a deep chain of 30 folders for Cancel.
  await p.evaluate((k) => { window.__put(k + '/Big', true); for (let d = 0; d < 50; d++) { window.__put(`${k}/Big/d${d}`, true); for (let i = 0; i < 100; i++) window.__put(`${k}/Big/d${d}/f${i}.bin`, false, 1000); }
    let cur = k + '/Chain'; window.__put(cur, true); for (let i = 0; i < 30; i++) { cur += '/c' + i; window.__put(cur, true); window.__put(cur + '/x.bin', false, 5); } }, K);
  await p.click('.topbar-actions .icon-btn[data-icon="more"]'); await p.locator('.sheet .dest-row', { hasText: /Refresh|تحديث/ }).click(); await p.waitForTimeout(500);
  // frames keep coming while it counts
  await p.evaluate(() => { window.__gap = 0; let last = performance.now(); const tick = () => { const n = performance.now(); window.__gap = Math.max(window.__gap, n - last); last = n; window.__raf = requestAnimationFrame(tick); }; tick(); window.__lists = 0; });
  await menu(p, 'Big'); await p.locator('.sheet .dest-row', { hasText: w.calc }).click(); await p.waitForSelector('.files-props'); await p.waitForFunction(() => /5,?000|٥٬?٠٠٠/.test(document.querySelector('.files-props')?.textContent ?? ''), null, { timeout: 15000 });
  const t = await p.textContent('.files-props');
  ok(L('5,000 files and 50 folders counted'), /5,?000 files|٥٬?٠٠٠ ملف/.test(t) && /50 folders|٥٠ مجلد/.test(t) && /4\.8|5(\.0)? ?MB|MB/.test(t), t);
  const calls = await p.evaluate(() => window.__lists); ok(L(`work budget: 51 listings for 51 folders (${calls})`), calls <= 54, calls);
  const gap = await p.evaluate(() => window.__gap); ok(L(`the page stayed free: longest frame gap ${Math.round(gap)} ms`), gap < 400, gap);
  await p.click('.sheet .sheet-head button[aria-label]'); await p.waitForTimeout(300);
  // Cancel mid-way
  await p.evaluate(() => { window.__listPause = 120; }); await menu(p, 'Chain'); await p.locator('.sheet .dest-row', { hasText: w.calc }).click(); await p.waitForSelector('.files-size-stop'); await p.waitForTimeout(500);
  await shot(p, `extras-folder-size-running${lang === 'ar' ? '-ar' : ''}.png`);
  await p.click('.files-size-stop'); await p.waitForTimeout(600); const before = await p.evaluate(() => window.__lists); await p.waitForTimeout(500);
  ok(L('Cancel: counting stops'), (await p.evaluate(() => window.__lists)) - before <= 1);
  ok(L('Cancel: the button offers to calculate again from nothing'), (await p.locator('.sheet .files-size-go', { hasText: w.calc }).count()) === 1);
  await p.click('.sheet .sheet-head button[aria-label]'); await p.waitForTimeout(300);
  ok(L('Cancel: the cancelled folder shows no size'), !/MB|KB|[0-9] B/.test((await meta(p, 'Chain')).replace(/\d+ (items?|عنصر)/, '')), await meta(p, 'Chain'));
  const e = errors.filter((x) => !/favicon/.test(x)); ok(L('no page errors'), !e.length, e); await p.close();
}

async function scroller(browser, port, z, lang) {
  const L = (s) => `[${lang}-scroll] ${s}`;
  const { p, errors } = await page(browser, port, z, lang, { at: K + '/Many', many: 30 });
  await p.evaluate((k) => { for (let i = 0; i < 5000; i++) window.__put(`${k}/Many/zeta ${String(i).padStart(4, '0')}.txt`, false, 100 + i, 1700000000000 + i * 86400000); window.__calls.push('x'); }, K);
  await p.click('.topbar-actions .icon-btn[data-icon="more"]'); await p.locator('.sheet .dest-row', { hasText: /Refresh|تحديث/ }).click(); await p.waitForSelector('.files-row'); await p.waitForTimeout(600);
  // text size: names grow with the setting (chosen in Files settings)
  const fs = () => p.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.files-list .files-name')).fontSize));
  const setSize = async (label, from) => {
    await p.click('.topbar-actions .icon-btn[data-icon="more"]'); await p.locator('.sheet .dest-row', { hasText: /Files settings|إعدادات الملفات/ }).click(); await p.waitForSelector('.sheet .files-filters');
    await p.locator('.sheet .files-filters .pick-btn', { hasText: new RegExp(`^\\s*${from}\\s*$`) }).click(); await p.waitForTimeout(250);
    await p.locator('.sheet .dest-row, .sheet [role="option"], .sheet button', { hasText: new RegExp(`^\\s*${label}\\s*$`) }).last().click(); await p.waitForTimeout(500);
    await p.keyboard.press('Escape'); await p.waitForTimeout(300); await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  };
  const f0 = await fs(); const LB = lang === 'ar' ? { larger: 'أكبر', normal: 'عادي' } : { larger: 'Larger', normal: 'Normal' };
  await setSize(LB.larger, LB.normal);
  const f1 = await fs(); ok(L(`text size Larger: names ${f0}px -> ${f1}px`), f1 > f0 * 1.2 && /ts-larger/.test(await p.getAttribute('.files-list', 'class')), await p.getAttribute('.files-list', 'class'));
  await shot(p, `extras-text-size${lang === 'ar' ? '-ar' : ''}.png`);
  await setSize(LB.normal, LB.larger);
  ok(L('Normal: back to the first size'), (await fs()) === f0);
  // the handle shows on scrolling, and is dragged
  await p.evaluate(() => window.scrollBy(0, 600)); await p.waitForTimeout(400);
  const th = p.locator('.files-fast-thumb'); ok(L('the handle shows when scrolling a long list'), (await p.locator('.files-fast.on').count()) === 1);
  const box = await th.boundingBox(); const rtl = lang === 'ar';
  ok(L(`the handle is on the ${rtl ? 'left' : 'right'} edge`), rtl ? box.x < 40 : box.x > 360 - 60, box);
  const track = await p.evaluate(() => { const e = document.querySelector('.files-fast'); const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
  const mid = (track.top + track.bottom) / 2;
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await p.mouse.down(); await p.mouse.move(box.x + box.width / 2, mid, { steps: 6 }); await p.waitForTimeout(500);
  const bub = await p.textContent('.files-fast-bubble'); ok(L(`dragging: the bubble names the place ("${bub}")`), bub === 'Z' && (await p.locator('.files-fast.drag.bubble').count()) === 1, bub);
  await shot(p, `extras-fast-scroller${lang === 'ar' ? '-ar' : ''}.png`);
  await p.mouse.up(); await p.waitForTimeout(400);
  const top = await p.evaluate(() => { const edge = document.querySelector('.topbar').getBoundingClientRect().bottom; const r = [...document.querySelectorAll('.files-row')].find((x) => x.getBoundingClientRect().bottom > edge + 40); return r ? +/(\d{4})/.exec(r.querySelector('.files-name').title)?.[1] : -1; });
  ok(L(`dragged to the middle: the top row is near 2,500 (${top})`), top > 2200 && top < 2800, top);
  ok(L('windowed: only a few hundred rows in the page'), (await p.locator('.files-row').count()) < 700, await p.locator('.files-row').count());
  // by date the bubble says the month
  await p.evaluate(() => window.scrollTo(0, 0)); await p.click('.topbar-actions .icon-btn[data-icon="sort"]'); await p.locator('.sheet .dest-row').nth(1).click(); await p.waitForTimeout(500);
  await p.evaluate(() => window.scrollBy(0, 500)); await p.waitForTimeout(400); const b2 = await p.textContent('.files-fast-bubble'); ok(L(`by date: the bubble holds a month ("${b2}")`), /20\d\d|٢٠\d\d/.test(b2) || /\d{4}/.test(b2), b2);
  await p.evaluate(() => window.scrollTo(0, 0)); await p.click('.topbar-actions .icon-btn[data-icon="sort"]'); await p.locator('.sheet .dest-row').nth(2).click(); await p.waitForTimeout(500);
  await p.evaluate(() => window.scrollBy(0, 500)); await p.waitForTimeout(400); const b3 = await p.textContent('.files-fast-bubble'); ok(L(`by size: the bubble holds a size bucket ("${b3}")`), /KB|MB|B/.test(b3), b3);
  ok(L('no page errors'), !errors.filter((x) => !/favicon/.test(x)).length, errors); await p.close();
  // a computer: the page's scrollbar, the bubble only
  const { p: q, errors: e2 } = await page(browser, port, z, lang, { at: K + '/Many', pc: true, many: 30 });
  await q.evaluate((k) => { for (let i = 0; i < 300; i++) window.__put(`${k}/Many/zeta ${String(i).padStart(4, '0')}.txt`, false, 100 + i); }, K);
  await q.click('.topbar-actions .icon-btn[data-icon="more"]'); await q.locator('.sheet .dest-row, .menu-row', { hasText: /Refresh|تحديث/ }).first().click(); await q.waitForSelector('.files-row'); await q.waitForTimeout(500);
  await q.evaluate(() => window.scrollBy(0, 800)); await q.waitForTimeout(400);
  ok(L('PC: no handle, the bubble shows while scrolling'), (await q.locator('.files-fast-thumb').isHidden()) && (await q.locator('.files-fast.bubble').count()) === 1 && /\S/.test(await q.textContent('.files-fast-bubble')));
  await q.close(); ok(L('PC: no page errors'), !e2.filter((x) => !/favicon/.test(x)).length, e2);
}

const hold = async (cdp, x, y, ms = 700) => { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] }); await new Promise((r) => setTimeout(r, ms)); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); };
const pinch = async (cdp, y, a0, a1) => {
  const pts = (d) => [{ x: 180 - d / 2, y, id: 1 }, { x: 180 + d / 2, y, id: 2 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(a0) });
  for (let i = 1; i <= 8; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(a0 + ((a1 - a0) * i) / 8) }); await new Promise((r) => setTimeout(r, 30)); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};
const colsOf = (p) => p.evaluate(() => getComputedStyle(document.querySelector('.files-list .files-chunk') ?? document.querySelector('.files-list')).gridTemplateColumns.split(' ').length);
const SEED_PICS = (k) => { window.__put(k + '/Pics', true); for (let i = 0; i < 80; i++) window.__put(`${k}/Pics/IMG_${String(i).padStart(4, '0')}.jpg`, false, 2e6 + i); for (let i = 0; i < 6; i++) window.__put(`${k}/Pics/clip ${i}.mp4`, false, 9e6); window.__put(`${k}/Pics/${'ملاحظات'}.txt`, false, 40); };

async function gallery(browser, port, z, lang) {
  const L = (s) => `[${lang}-gallery] ${s}`; const rtl = lang === 'ar';
  const { p, errors } = await page(browser, port, z, lang, { at: K + '/Pics', seed: SEED_PICS });
  const cdp = await p.context().newCDPSession(p); const btn = '.topbar-actions .icon-btn[data-icon="grid"], .topbar-actions .icon-btn[data-icon="list"], .topbar-actions .icon-btn[data-icon="images"]';
  const view = () => p.evaluate(() => JSON.parse(localStorage.getItem('kt.files.prefs')).view);
  await p.click(btn); await p.waitForTimeout(300); await p.click(btn); await p.waitForTimeout(700);
  ok(L('the button cycled list -> grid -> gallery'), (await view()) === 'gallery' && (await p.locator('.files-list.gallery').count()) === 1, await view());
  const c0 = await colsOf(p); ok(L(`gallery: dense columns (${c0}) between 3 and 6 at 360 px`), c0 >= 3 && c0 <= 6, c0);
  const sq = await p.evaluate(() => { const r = document.querySelector('.files-row').getBoundingClientRect(); return [r.width, r.height]; }); ok(L(`tiles are square (${sq.map(Math.round)})`), Math.abs(sq[0] - sq[1]) < 2, sq);
  ok(L('pictures fill their tiles (thumbnails placed)'), (await p.locator('.files-ic.has-img').count()) > 10, await p.locator('.files-ic.has-img').count());
  ok(L('a picture tile shows no name; the text tile does'), (await p.locator('.files-row:has(.files-ic.has-img) .files-main').first().isHidden()) && (await p.locator('.files-row:not(:has(.files-ic.has-img)) .files-main').first().isVisible()));
  // selection: a long press selects; another tap adds with an order badge inside its tile
  const t1 = await p.locator('.files-row').nth(0).boundingBox(); const t2 = await p.locator('.files-row').nth(1).boundingBox();
  await hold(cdp, t1.x + t1.width / 2, t1.y + t1.height / 2); await p.waitForTimeout(300);
  await p.touchscreen.tap(t2.x + t2.width / 2, t2.y + t2.height / 2); await p.waitForTimeout(300);
  ok(L('selection: two tiles picked, in order badges'), (await p.locator('.files-row.picked').count()) === 2 && (await p.locator('.files-check.order').count()) === 2, await p.locator('.files-row.picked').count());
  const bd = await p.evaluate(() => { const b = document.querySelector('.files-check.order').getBoundingClientRect(); const r = b && document.querySelector('.files-row.picked').getBoundingClientRect(); return { b: [b.left, b.right], r: [r.left, r.right] }; });
  ok(L(`order badge inside its tile, on the ${rtl ? 'left' : 'right'}`), bd.b[0] >= bd.r[0] - 1 && bd.b[1] <= bd.r[1] + 1 && (rtl ? bd.b[0] - bd.r[0] < 20 : bd.r[1] - bd.b[1] < 20), bd);
  await shot(p, `extras-gallery${rtl ? '-ar' : ''}.png`);
  await p.evaluate(() => document.querySelector('.files-selbar .icon-btn')?.click()); await p.waitForTimeout(200);
  // pinch: spread = bigger pictures = fewer columns; pinch in = more columns; kept for this kind of folder
  await p.evaluate(() => { document.querySelectorAll('.files-row.picked').forEach(() => 0); });
  await pinch(cdp, 400, 60, 260); await p.waitForTimeout(600);
  const c1 = await colsOf(p); ok(L(`spread: fewer columns (${c0} -> ${c1})`), c1 < c0 || c1 === 3, [c0, c1]);
  await pinch(cdp, 400, 260, 50); await p.waitForTimeout(600);
  const c2 = await colsOf(p); ok(L(`pinch in: more columns (${c1} -> ${c2})`), c2 > c1 && c2 <= 6, [c1, c2]);
  const kept = await p.evaluate(() => JSON.parse(localStorage.getItem('kt.files.prefs')).cols); ok(L('the choice is kept for this kind of folder (gallery, pictures)'), kept && kept['gallery:media'] === c2, kept);
  // a folder of other things has its own count
  await p.evaluate((k) => { location.hash = '#/files?p=' + encodeURIComponent(k) + '&t=5'; }, K); await p.waitForSelector('.files-row'); await p.waitForTimeout(500);
  ok(L('another kind of folder keeps its own columns'), (await p.locator('.files-list.cols').count()) === 0);
  await p.evaluate((k) => { location.hash = '#/files?p=' + encodeURIComponent(k + '/Pics') + '&t=6'; }, K); await p.waitForSelector('.files-row'); await p.waitForTimeout(500);
  ok(L('back in the pictures folder: its columns are as pinched'), (await colsOf(p)) === c2);
  ok(L('no page errors'), !errors.filter((x) => !/favicon/.test(x)).length, errors); await p.close();
  // 5,000 pictures: windowed, thumbnails only for what is near
  const big = await page(browser, port, z, lang, { at: K + '/Big', seed: (k) => { window.__put(k + '/Big', true); for (let i = 0; i < 5000; i++) window.__put(`${k}/Big/p${String(i).padStart(4, '0')}.jpg`, false, 1e6); }, many: 0 });
  await big.p.evaluate(() => { const o = JSON.parse(localStorage.getItem('kt.files.prefs')); o.view = 'gallery'; localStorage.setItem('kt.files.prefs', JSON.stringify(o)); });
  await big.p.evaluate((k) => { location.hash = '#/files?p=' + encodeURIComponent(k + '/Big') + '&t=9'; }, K); await big.p.waitForTimeout(900);
  const rows = await big.p.locator('.files-row').count(); const th = await big.p.evaluate(() => window.__thumbs.length);
  ok(L(`5,000 pictures: ${rows} rows in the page, ${th} thumbnails asked`), rows < 700 && th < 400, [rows, th]); await big.p.close();
  // a computer: Ctrl + wheel in the grid
  const pc = await page(browser, port, z, lang, { at: K + '/Pics', seed: SEED_PICS, pc: true });
  await pc.p.click(btn); await pc.p.waitForTimeout(500); const g0 = await colsOf(pc.p);
  await pc.p.mouse.move(500, 400); await pc.p.keyboard.down('Control'); await pc.p.mouse.wheel(0, 120); await pc.p.waitForTimeout(400); await pc.p.keyboard.up('Control'); const g1 = await colsOf(pc.p);
  ok(L(`PC: Ctrl + wheel changes the columns in the grid (${g0} -> ${g1})`), g1 === g0 + 1, [g0, g1]);
  await pc.p.close();
}

const enc = (s) => new TextEncoder().encode(s);
/** Files for the editor tests, written into the page's tree and byte store. */
const SEED_TEXT = (k) => {
  const put = (n, bytes) => { window.__put(`${k}/${n}`, false, bytes.length); window.__bytes[`${k}/${n}`] = bytes; }; const te = (s) => new TextEncoder().encode(s);
  put('notes.txt', te('alpha beta\ngamma alpha\nالسلام عليكم\nAlpha END\nlast line\n'));
  put('crlf.txt', te('one\r\ntwo\r\nthree\r\n')); put('mixed.txt', te('one\r\ntwo\nthree\r\n'));
  put('arabic.txt', new Uint8Array([0xE3, 0xD1, 0xCD, 0xC8, 0xC7, 0x0D, 0x0A, 0xE3, 0xD1, 0xCD, 0xC8, 0xC7])); put('sjis.txt', new Uint8Array([0x93, 0xFA, 0x96, 0x7B, 0x8C, 0xEA, 0x0A]));
  put('sub.ass', te('[Script Info]\nTitle: اختبار\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,مرحبا بالعالم\n'));
  const lines = []; for (let i = 1; i <= 5000; i++) lines.push(`line ${i} needle${i % 7 === 0 ? ' hit' : ''}`); put('five.txt', te(lines.join('\n') + '\n'));
  const big = new Uint8Array(6_000_000); for (let i = 0; i < big.length; i++) big[i] = i % 64 === 63 ? 10 : 97 + (i % 26); window.__put(`${k}/big.txt`, false, big.length); window.__bytes[`${k}/big.txt`] = big;
};
const ED = '.files-editor';
const openText = async (p, name, chooser = false) => {
  if (!chooser) { await rowOf(p, name).locator('.files-main').click(); }
  else { await menu(p, name); await p.locator('.sheet .dest-row', { hasText: /Open with|افتح بواسطة/ }).click(); await p.waitForTimeout(500); await p.locator('.sheet button, .sheet .dest-row, .sheet [role="button"]', { hasText: /Kurokawa text editor|محرّر النصوص في كوروكاوا/ }).first().click(); await p.waitForTimeout(200); const once = p.locator('.sheet button', { hasText: /Just once|هذه المرّة فقط/ }); if (await once.count()) await once.first().click(); }
  await p.waitForSelector(`${ED} .files-ta`); await p.waitForTimeout(500);
};
const closeEditor = async (p) => { await p.keyboard.press('Escape'); await p.waitForTimeout(250); const d = p.locator('.unsaved-sheet [data-answer="discard"]'); if (await d.count()) { await d.click(); await p.waitForTimeout(250); } };
const tav = (p) => p.inputValue(`${ED} .files-ta`);
const bytesOf = (p, name) => p.evaluate(([k, n]) => [...window.__bytes[`${k}/${n}`]], [K, name]);
const status = (p) => p.textContent(`${ED} .files-ed-status`);
const tool = (p, ic) => p.locator(`${ED} .files-ed-tools .icon-btn[data-icon="${ic}"]`);
const moreAct = async (p, re) => { await tool(p, 'more').click(); await p.waitForSelector('.sheet .dest-row'); await p.locator('.sheet .dest-row', { hasText: re }).click(); await p.waitForTimeout(350); };
const pickOpt = async (p, re) => { await p.locator('.sheet .dest-row, .sheet [role="option"], .sheet button', { hasText: re }).last().click(); await p.waitForTimeout(450); };

async function editor(browser, port, z, lang) {
  const L = (s) => `[${lang}-editor] ${s}`; const ar = lang === 'ar';
  const { p, errors } = await page(browser, port, z, lang, { seed: SEED_TEXT });
  const num = (n) => (ar ? String(n).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[d]) : String(n));
  // ---- find and replace
  await openText(p, 'notes.txt');
  ok(L('opens as text, UTF-8 and LF told'), /UTF-8/.test(await status(p)) && /LF/.test(await status(p)) && !(await p.locator(`${ED} .btn.primary`).isEnabled()), await status(p));
  await tool(p, 'search').click(); await p.fill(`${ED} .files-find-in >> nth=0`, 'alpha'); await p.waitForTimeout(200);
  const cnt = async () => (await p.textContent(`${ED} .files-find-count`)).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
  ok(L('plain, any case: 3 matches counted'), (await cnt()) === (ar ? 'العدد: 3' : 'Matches: 3'), await cnt());
  await p.click(`${ED} .files-find-opt.case`); await p.waitForTimeout(150); ok(L('match case: 2'), (await cnt()) === (ar ? 'العدد: 2' : 'Matches: 2'), await cnt());
  await p.click(`${ED} .files-find-opt.case`); await p.fill(`${ED} .files-find-in >> nth=0`, 'alph'); await p.click(`${ED} .files-find-opt.word`); await p.waitForTimeout(150); ok(L('whole word: «alph» is not a word here: 0'), (await cnt()) === (ar ? 'العدد: 0' : 'Matches: 0'), await cnt());
  await p.click(`${ED} .files-find-opt.word`); await p.click(`${ED} .files-find-opt.rx`); await p.fill(`${ED} .files-find-in >> nth=0`, 'a.pha'); await p.waitForTimeout(150); ok(L('pattern a.pha: 3'), (await cnt()) === (ar ? 'العدد: 3' : 'Matches: 3'), await cnt());
  await p.fill(`${ED} .files-find-in >> nth=0`, '('); await p.waitForTimeout(150); ok(L('a broken pattern is said so, nothing replaced'), (await cnt()) === (ar ? 'النمط غير صالح' : 'Not a valid pattern') && (await p.locator(`${ED} .files-find .btn`, { hasText: ar ? 'استبدال الكل' : 'Replace all' }).isDisabled()));
  await p.click(`${ED} .files-find-opt.rx`); await p.fill(`${ED} .files-find-in >> nth=0`, 'alpha'); await p.fill(`${ED} .files-find-in >> nth=1`, 'OMEGA'); await p.waitForTimeout(150);
  const orig = await tav(p);
  await p.click(`${ED} .files-find-row.acts .btn.tonal >> nth=0`); await p.waitForTimeout(200); await p.click(`${ED} .files-find-row.acts .btn.tonal >> nth=0`); await p.waitForTimeout(250);
  ok(L('Replace: the first select, the second replaces one'), (await tav(p)).split('OMEGA').length === 2 && (await cnt()) === (ar ? 'العدد: 2' : 'Matches: 2'), [await tav(p), await cnt()]);
  await p.click(`${ED} .files-find-row.acts .btn.text`); await p.waitForTimeout(200); ok(L('Undo: back to the first text'), (await tav(p)) === orig);
  await p.click(`${ED} .files-find-row.acts .btn.tonal >> nth=1`); await p.waitForTimeout(250);
  ok(L('Replace all: three replaced, counted'), (await tav(p)).split('OMEGA').length === 4, await tav(p));
  await shot(p, `extras-editor-find${ar ? '-ar' : ''}.png`);
  await p.click(`${ED} .files-find-row.acts .btn.text`); await p.waitForTimeout(200); ok(L('Undo after Replace all'), (await tav(p)) === orig);
  ok(L('nothing written to the file yet'), (await p.evaluate(() => window.__writes.length)) === 0);
  // ---- go to line, line numbers, font size
  await tool(p, 'target').click(); await p.waitForSelector('.files-goto'); await p.fill('.files-goto', '3'); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
  ok(L('go to line 3: the caret at the start of line 3'), (await p.evaluate(() => document.querySelector('.files-ta').selectionStart)) === orig.indexOf('السلام'), await p.evaluate(() => document.querySelector('.files-ta').selectionStart));
  await tool(p, 'list').click(); await p.waitForTimeout(250);
  const g = await p.evaluate(() => ({ vis: !document.querySelector('.files-ed-gutter').hidden, txt: document.querySelector('.files-ed-gutter').textContent, nowrap: document.querySelector('.files-ta').classList.contains('nowrap') }));
  ok(L('line numbers on: 1..6 shown (5 lines and the empty one after the last newline), wrapping turned off'), g.vis && g.txt === '1\n2\n3\n4\n5\n6' && g.nowrap, g);
  await tool(p, 'scroll').click(); await p.waitForTimeout(200); ok(L('wrapping on again: line numbers off'), await p.evaluate(() => document.querySelector('.files-ed-gutter').hidden));
  const f0 = await p.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.files-ta')).fontSize)); await tool(p, 'more').click(); await p.waitForSelector('.files-fontrow'); await p.click('.files-fontrow .icon-btn[data-icon="zoomIn"]'); await p.waitForTimeout(150); await p.keyboard.press('Escape'); await p.waitForTimeout(250);
  const f1 = await p.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.files-ta')).fontSize)); ok(L(`font size up (${f0} -> ${f1})`), f1 > f0);
  await p.click(`${ED} .files-ta`); await p.fill(`${ED} .files-ta`, orig + 'tail\n'); await p.click(`${ED} .btn.primary`); await p.waitForTimeout(400);
  const w = await bytesOf(p, 'notes.txt'); ok(L('saved: the same UTF-8 with LF, plus the tail'), new TextDecoder().decode(new Uint8Array(w)) === orig + 'tail\n' && !w.includes(13), w.length);
  // ---- the unsaved guard through Back
  await p.fill(`${ED} .files-ta`, 'changed'); await p.evaluate(() => window.__back()); await p.waitForSelector('.unsaved-sheet'); ok(L('Back with unsaved text asks'), true); await p.click('.unsaved-sheet [data-answer="discard"]'); await p.waitForTimeout(300);
  // ---- line endings
  await openText(p, 'crlf.txt'); ok(L('CRLF file: told, not dirty'), /CRLF/.test(await status(p)) && !(await p.locator(`${ED} .btn.primary`).isEnabled()), await status(p));
  await p.fill(`${ED} .files-ta`, 'one\ntwo\nthree\nfour\n'); await p.click(`${ED} .btn.primary`); await p.waitForTimeout(300);
  ok(L('CRLF kept on save: every line still ends with CRLF'), new TextDecoder().decode(new Uint8Array(await bytesOf(p, 'crlf.txt'))) === 'one\r\ntwo\r\nthree\r\nfour\r\n');
  await moreAct(p, /Line endings|نهايات الأسطر/); await pickOpt(p, /^\s*LF/); ok(L('Line endings: LF chosen, Save enabled'), await p.locator(`${ED} .btn.primary`).isEnabled());
  await p.click(`${ED} .btn.primary`); await p.waitForTimeout(300); ok(L('converted to LF'), !(await bytesOf(p, 'crlf.txt')).includes(13)); await closeEditor(p);
  await openText(p, 'mixed.txt'); ok(L('mixed line endings: read-only with the notice'), (await p.evaluate(() => document.querySelector('.files-ta').readOnly)) && (await p.locator(`${ED} .files-ed-notice`).isVisible()));
  await moreAct(p, /Line endings|نهايات الأسطر/); await pickOpt(p, /CRLF/); ok(L('choosing an ending makes it editable'), !(await p.evaluate(() => document.querySelector('.files-ta').readOnly))); await closeEditor(p);
  // ---- character sets
  await openText(p, 'arabic.txt'); ok(L('Windows-1256 detected, Arabic read'), /Windows-1256/.test(await status(p)) && (await tav(p)).startsWith('مرحبا'), await status(p));
  await shot(p, `extras-editor-charset${ar ? '-ar' : ''}.png`);
  await moreAct(p, /Read the file again|إعادة قراءة الملف/); await pickOpt(p, /^\s*UTF-8\s*$/); ok(L('read again as UTF-8: not exact, so read-only'), await p.evaluate(() => document.querySelector('.files-ta').readOnly));
  await moreAct(p, /Read the file again|إعادة قراءة الملف/); await pickOpt(p, /Windows-1256/); ok(L('read again as Windows-1256: editable again'), !(await p.evaluate(() => document.querySelector('.files-ta').readOnly)));
  await moreAct(p, /Save with another|الحفظ بترميز آخر/); await pickOpt(p, /Shift_JIS/); await p.waitForTimeout(200); ok(L('Shift_JIS cannot be written: refused, nothing changed'), !(await p.locator(`${ED} .btn.primary`).isEnabled()));
  await moreAct(p, /Save with another|الحفظ بترميز آخر/); await pickOpt(p, /^\s*UTF-8\s*$/); ok(L('Save as UTF-8: Save enabled'), await p.locator(`${ED} .btn.primary`).isEnabled());
  await p.click(`${ED} .btn.primary`); await p.waitForTimeout(300); ok(L('written as UTF-8 (CRLF kept)'), new TextDecoder().decode(new Uint8Array(await bytesOf(p, 'arabic.txt'))) === 'مرحبا\r\nمرحبا'); await closeEditor(p);
  await openText(p, 'sjis.txt'); await moreAct(p, /Read the file again|إعادة قراءة الملف/); await pickOpt(p, /Shift_JIS/); ok(L('Shift_JIS read: 日本語, read-only (not written)'), (await tav(p)).startsWith('日本語') && (await p.evaluate(() => document.querySelector('.files-ta').readOnly)), await tav(p)); await closeEditor(p);
  // ---- subtitle file through the chooser: not monospace, each line its own direction
  await openText(p, 'sub.ass', true); const cs = await p.evaluate(() => { const c = getComputedStyle(document.querySelector('.files-ta')); return { bidi: c.unicodeBidi, mono: /mono|Menlo|Consolas/i.test(c.fontFamily) }; });
  ok(L('subtitle file: lines follow their own direction, not monospace'), cs.bidi === 'plaintext' && !cs.mono, cs); await closeEditor(p);
  // ---- 5,000 lines: find within a budget
  await openText(p, 'five.txt'); await tool(p, 'search').click(); const t0 = Date.now(); await p.fill(`${ED} .files-find-in >> nth=0`, 'needle'); await p.waitForTimeout(100);
  ok(L(`5,000 lines: 5,000 matches counted (${Date.now() - t0} ms incl. typing)`), (await cnt()) === (ar ? 'العدد: 5000' : 'Matches: 5000') && Date.now() - t0 < 2500, await cnt());
  await p.fill(`${ED} .files-find-in >> nth=0`, 'hit'); await p.waitForTimeout(150); ok(L('…and the lines with «hit»: 714'), (await cnt()) === (ar ? 'العدد: 714' : 'Matches: 714'), await cnt()); await closeEditor(p);
  // ---- a 6 MB file: read-only, a part at a time
  await openText(p, 'big.txt', true); ok(L('big file: read-only with the notice, first part shown'), (await p.evaluate(() => document.querySelector('.files-ta').readOnly)) && (await p.locator(`${ED} .files-ed-notice`).isVisible()) && (await tav(p)).length > 450000, (await tav(p)).length);
  const l1 = await tav(p); await p.click(`${ED} .files-part-next`); await p.waitForTimeout(400); const l2 = await tav(p);
  ok(L('the next part replaces the first (a part at a time), Previous appears'), l2 !== l1 && l2.length > 450000 && l2.length < 600000 && (await p.locator(`${ED} .files-part-prev`).count()) === 1, [l1.length, l2.length]);
  await p.click(`${ED} .files-part-prev`); await p.waitForTimeout(300); ok(L('Previous: the first part again'), (await tav(p)) === l1);
  let parts = 1; for (let i = 0; i < 20; i++) { const b = p.locator(`${ED} .files-part-next`); if (!(await b.count())) break; await b.click(); await p.waitForTimeout(150); parts++; }
  ok(L(`the last part reached after ${parts} parts: no Next`), parts >= 11 && parts <= 13 && (await p.locator(`${ED} .files-part-next`).count()) === 0, parts); await closeEditor(p);
  ok(L('no page errors'), !errors.filter((x) => !/favicon/.test(x)).length, errors); await p.close();
}

(async () => {
  const z = await F.zipListing(); const srv = await F.serve(); const port = srv.address().port; const browser = await chromium.launch();
  try {
    for (const lang of langs) {
      if (want('foldersize')) { await foldersize(browser, port, z, lang); await bigsize(browser, port, z, lang); }
      if (want('scroller')) await scroller(browser, port, z, lang);
      if (want('gallery')) await gallery(browser, port, z, lang);
      if (want('editor')) await editor(browser, port, z, lang);
    }
  } finally { await browser.close(); srv.close(); }
  console.log(fails ? `\n${fails} failed` : '\nall ok'); process.exit(fails ? 1 : 0);
})();
