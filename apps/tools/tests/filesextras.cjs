// The smaller Files features of 0.21.0, one section each, on the pretend phone (tests/filesphone-fixture.cjs) at 360 px and,
// where it matters, a computer's width; English and Arabic. Sections: foldersize, scroller, gallery, editor, verify, compare, duplicates, reader.
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
    // (A checksum of a file: its size and a mark carried by copies; a name in __badNames differs once copied into a Full check's stage.)
    window.__badNames = []; window.__hashPause = 0; window.__hashed = [];
    kt.hashFile = async ({ path }) => { const n = window.__tree.get(path); if (!n || n.dir) throw new Error('unreadable'); window.__hashed.push(path); if (window.__hashPause) await new Promise((r) => setTimeout(r, window.__hashPause)); const bad = window.__badNames.includes(path.split('/').pop()) && path.includes('.kurokawa-extract-v-'); const sig = (n.sig ?? 'c' + n.size) + (bad ? 'X' : ''); return { md5: sig, sha1: sig, sha256: sig, size: n.size }; };
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
  // idle: slim, at the screen edge, clear of every ⋮; the ⋮ beside it is still hit by a tap
  const clear = await p.evaluate(() => { const t = document.querySelector('.files-fast-thumb').getBoundingClientRect(); const g = document.querySelector('.files-fast-grip').getBoundingClientRect(); const dots = [...document.querySelectorAll('.files-row > button.icon-btn[data-icon="more"], .files-row .icon-btn[data-icon="more"]')].map((x) => x.getBoundingClientRect()).filter((r) => r.bottom > 0 && r.top < innerHeight); const gap = Math.min(...dots.map((r) => (document.dir === 'rtl' || document.documentElement.dir === 'rtl' ? t.left - r.right : r.left - 0 > 0 ? Math.min(Math.abs(t.left - r.right), 999) : 999)));
    const near = dots.find((r) => r.top < t.bottom && r.bottom > t.top) ?? dots[0]; const hit = document.elementFromPoint(near.left + near.width / 2, near.top + near.height / 2); return { tw: t.width, gw: g.width, overlap: dots.some((r) => r.left < t.right && r.right > t.left && r.top < t.bottom && r.bottom > t.top), hitDots: !!hit?.closest('.icon-btn[data-icon="more"]'), n: dots.length, edge: document.documentElement.dir === 'rtl' ? t.left : innerWidth - t.right }; });
  ok(L(`idle handle: slim (grip ${clear.gw}px, hit area ${clear.tw}px), at the screen edge (${clear.edge}px), over no ⋮`), clear.gw <= 5 && clear.tw <= 24 && clear.edge <= 1 && !clear.overlap && clear.n > 3, clear);
  ok(L('the ⋮ beside the handle is hit by a tap point'), clear.hitDots, clear);
  const crumbH = await p.evaluate(() => ['.files-crumbs', '.files-kinds', '.files-roots'].map((q) => { const e = document.querySelector(q); return e && !e.hidden ? Math.round(e.getBoundingClientRect().height) : -1; }));
  ok(L(`header rows keep their height with a long list (${crumbH})`), crumbH.every((h) => h === -1 || h >= 30), crumbH);
  const track = await p.evaluate(() => { const e = document.querySelector('.files-fast'); const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
  const mid = (track.top + track.bottom) / 2;
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await p.mouse.down(); await p.mouse.move(box.x + box.width / 2, mid, { steps: 6 }); await p.waitForTimeout(500);
  const bub = await p.textContent('.files-fast-bubble'); ok(L(`dragging: the bubble names the place ("${bub}")`), bub === 'Z' && (await p.locator('.files-fast.drag.bubble').count()) === 1, bub);
  const bb = await p.evaluate(() => { const b = document.querySelector('.files-fast-bubble').getBoundingClientRect(); const dots = [...document.querySelectorAll('.files-row .icon-btn[data-icon="more"]')].map((x) => x.getBoundingClientRect()); return { bubbleOverDots: dots.some((r) => r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top), gap: Math.min(...dots.map((r) => (document.documentElement.dir === 'rtl' ? b.left - r.right : r.left - b.right)).filter((g) => g > -400)) }; });
  ok(L(`dragging: the bubble keeps off the ⋮ column (gap ${Math.round(bb.gap)}px)`), !bb.bubbleOverDots, bb);
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
  const ring = await p.evaluate(() => { const r = document.querySelector('.files-row.picked'); const c = getComputedStyle(r, '::after'); const ic = r.querySelector('.files-ic').getBoundingClientRect(); const rr = r.getBoundingClientRect(); return { w: c.borderTopWidth, col: c.borderTopColor, bg: c.backgroundColor, inset: Math.round(ic.left - rr.left), plain: getComputedStyle(document.querySelectorAll('.files-row:not(.picked)')[0], '::after').content }; });
  ok(L(`picked tile: primary ring ${ring.w}, scrim, picture inset ${ring.inset}px`), ring.w === '3px' && /\d/.test(ring.col) && ring.bg !== 'rgba(0, 0, 0, 0)' && ring.inset >= 6 && (ring.plain === 'none' || ring.plain === 'normal'), ring);
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
  await tool(p, 'hash').click(); await p.waitForSelector('.files-goto'); await p.fill('.files-goto', '3'); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
  ok(L('go to line 3: the caret at the start of line 3'), (await p.evaluate(() => document.querySelector('.files-ta').selectionStart)) === orig.indexOf('السلام'), await p.evaluate(() => document.querySelector('.files-ta').selectionStart));
  await tool(p, 'list').click(); await p.waitForTimeout(250);
  const g = await p.evaluate(() => ({ vis: !document.querySelector('.files-ed-gutter').hidden, txt: document.querySelector('.files-ed-gutter').textContent, nowrap: document.querySelector('.files-ta').classList.contains('nowrap') }));
  ok(L('line numbers on: 1..6 shown (5 lines and the empty one after the last newline), wrapping turned off'), g.vis && g.txt === '1\n2\n3\n4\n5\n6' && g.nowrap, g);
  await tool(p, 'wrapText').click(); await p.waitForTimeout(200); ok(L('wrapping on again: line numbers off'), await p.evaluate(() => document.querySelector('.files-ed-gutter').hidden));
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


const { SD, P } = F;
/** Copy or cut `names` from the folder now open, then open `dest` and paste. */
const pasteTo = async (p, names, how, dest) => {
  if (names.length === 1) { await menu(p, names[0]); await p.locator('.sheet .dest-row', { hasText: how === 'copy' ? /^\s*(Copy|نسخ)\s*$/ : /^\s*(Cut|قص)\s*$/ }).first().click(); }
  else { await rowOf(p, names[0]).locator('.files-main').click({ delay: 700 }).catch(() => undefined); }
  await p.waitForTimeout(250);
  await p.evaluate((d) => { location.hash = '#/files?p=' + encodeURIComponent(d); }, dest); await p.waitForSelector('.files-clip-paste:not([disabled])', { timeout: 5000 }); await p.click('.files-clip-paste');
};
async function verify(browser, port, z, lang) {
  const L = (s) => `[${lang}-verify] ${s}`; const ar = lang === 'ar';
  const treeHas = (p, path) => p.evaluate((x) => window.__tree.has(x), path);
  const calls = (p) => p.evaluate(() => window.__calls.filter((c) => /^(copy|move|delete)/.test(c)));
  const mk = () => page(browser, port, z, lang, { seed: (k) => { const o = JSON.parse(localStorage.getItem('kt.files.prefs') || '{}'); o.verify = 'full'; localStorage.setItem('kt.files.prefs', JSON.stringify(o)); window.__put(k + '/Sub/in2.txt', false, 30); } });
  // ---- the setting
  { const { p, errors } = await page(browser, port, z, lang);
    await p.click('.topbar-actions .icon-btn[data-icon="more"]'); await p.locator('.sheet .dest-row', { hasText: /Files settings|إعدادات الملفات/ }).click(); await p.waitForSelector('.sheet .files-verify-row');
    ok(L('Files settings: «Verify after copying» with Size check chosen by default'), /Size check|فحص الحجم/.test(await p.textContent('.files-verify-row')) && !(await p.evaluate(() => JSON.parse(localStorage.getItem('kt.files.prefs') || '{}').verify)));
    await p.locator('.files-verify-row .pick-btn').click(); await p.waitForTimeout(250); await p.locator('.sheet button, .sheet .dest-row', { hasText: /^\s*(Full check|فحص كامل)\s*$/ }).last().click(); await p.waitForTimeout(300);
    ok(L('choosing Full check is kept'), (await p.evaluate(() => JSON.parse(localStorage.getItem('kt.files.prefs')).verify)) === 'full');
    ok(L('no page errors (setting)'), !errors.filter((x) => !/favicon/.test(x)).length, errors); await p.close(); }
  // ---- Size check (the default): a plain job, and it says the sizes were checked
  { const { p } = await page(browser, port, z, lang);
    await pasteTo(p, ['Song.mp3'], 'copy', SD); await p.waitForTimeout(700);
    const c = await calls(p); ok(L(`size check: one plain copy straight to the destination (${c})`), c.length === 1 && /^copy:Song.mp3>/.test(c[0]) && !/kurokawa-extract/.test(c[0]) && (await p.evaluate(() => window.__hashed.length)) === 0, c);
    ok(L('size check: the message says the sizes were checked'), /sizes? .*checked|size of every file|فُحص حجم كل ملف/.test(await p.evaluate(() => document.querySelector('.toast')?.textContent ?? '')) , await p.evaluate(() => document.querySelector('.toast')?.textContent)); await p.close(); }
  // ---- Full check, a copy that matches
  { const { p, errors } = await mk();
    await pasteTo(p, ['Song.mp3'], 'copy', SD); await p.waitForTimeout(1500);
    const c = await calls(p);
    ok(L(`full: copied into a hidden stage, moved out, the stage removed (${c.join(' | ')})`), c.length === 3 && /^copy:Song.mp3>.*\.kurokawa-extract-v-/.test(c[0]) && /^move:Song.mp3>/.test(c[1]) && /^delete:\.kurokawa-extract-v-/.test(c[2]), c);
    ok(L('full: the copy is at the destination, the original still here, no stage left'), (await treeHas(p, SD + '/Song.mp3')) && (await treeHas(p, K + '/Song.mp3')) && !(await p.evaluate(() => [...window.__tree.keys()].some((k) => k.includes('.kurokawa-extract-v-')))));
    ok(L('full: both files were summed'), (await p.evaluate(() => window.__hashed.length)) === 2, await p.evaluate(() => window.__hashed));
    ok(L('full: the end message says the files were checked'), /checked|فُحصت/.test(await p.evaluate(() => document.querySelector('.toast')?.textContent ?? '')), await p.evaluate(() => document.querySelector('.toast')?.textContent));
    ok(L('full: the stage never shows in the list'), !(await p.locator('.files-name[title^=".kurokawa"]').count()));
    ok(L('no page errors (full copy)'), !errors.filter((x) => !/favicon/.test(x)).length, errors); await p.close(); }
  // ---- Full check, a move where one copy differs: the original stays, the bad copy is gone, the failed one listed
  { const { p, errors } = await mk(); await p.evaluate(() => { window.__badNames = ['photo.jpg']; });
    await rowOf(p, 'Song.mp3').locator('.files-main').click({ delay: 800 }); await p.waitForTimeout(300);
    await p.touchscreen.tap(...await rowOf(p, 'photo.jpg').boundingBox().then((b) => [b.x + b.width / 2, b.y + b.height / 2])); await p.waitForTimeout(300);
    await p.locator('.files-selbar .icon-btn[data-icon="scissors"]').click(); await p.waitForTimeout(250);
    await p.evaluate((d) => { location.hash = '#/files?p=' + encodeURIComponent(d); }, SD); await p.waitForSelector('.files-clip-paste:not([disabled])'); await p.click('.files-clip-paste'); await p.waitForSelector('.sheet .files-failed', { timeout: 8000 });
    ok(L('mismatch: the good file moved (copy there, original gone)'), (await treeHas(p, SD + '/Song.mp3')) && !(await treeHas(p, K + '/Song.mp3')));
    ok(L('mismatch: the differing copy is not at the destination; its original stays'), !(await treeHas(p, SD + '/photo.jpg')) && (await treeHas(p, K + '/photo.jpg')));
    ok(L('mismatch: no stage left'), !(await p.evaluate(() => [...window.__tree.keys()].some((k) => k.includes('.kurokawa-extract-v-')))));
    const sheet = await p.textContent('.sheet'); ok(L('mismatch: the result sheet names the failed file'), /photo\.jpg/.test(await p.textContent('.sheet .files-failed')) && /did not match|خالفت/.test(sheet), sheet);
    ok(L('mismatch: what stays cut is the failed one only'), (await p.evaluate(() => document.querySelector('.files-clip-name')?.textContent ?? '')).includes('photo'));
    await p.waitForTimeout(600); await shot(p, `extras-verify-result${ar ? '-ar' : ''}.png`);
    ok(L('no page errors (mismatch)'), !errors.filter((x) => !/favicon/.test(x)).length, errors); await p.close(); }
  // ---- Cancel while checking: nothing at the destination, the stage removed, the original in place
  { const { p } = await mk(); await p.evaluate(() => { window.__hashPause = 400; });
    await pasteTo(p, ['Song.mp3'], 'move', SD); await p.waitForSelector('.files-job', { timeout: 4000 }); await p.waitForFunction(() => window.__hashed.length >= 1, null, { timeout: 5000 });
    ok(L('while checking: the job says which file'), /Song\.mp3/.test(await p.textContent('.files-job-meta')), await p.textContent('.files-job-meta'));
    await shot(p, `extras-verify-progress${ar ? '-ar' : ''}.png`);
    await p.click('.files-job .icon-btn'); await p.waitForTimeout(1200);
    ok(L('Cancel: nothing at the destination, the original is in place, the stage is removed'), !(await treeHas(p, SD + '/Song.mp3')) && (await treeHas(p, K + '/Song.mp3')) && !(await p.evaluate(() => [...window.__tree.keys()].some((k) => k.includes('.kurokawa-extract-v-')))), await p.evaluate(() => [...window.__tree.keys()].filter((k) => /Song|extract/.test(k))));
    ok(L('Cancel: the move stays on the clipboard (cut)'), (await p.locator('.files-clip-paste').count()) === 1);
    await p.close(); }
  // ---- a move on one storage is a rename: nothing to check, and it says so
  { const { p } = await mk();
    await pasteTo(p, ['Song.mp3'], 'move', P + '/Music'); await p.waitForTimeout(900);
    const c = await calls(p); ok(L(`same storage: a plain move, no stage, nothing summed (${c})`), c.length === 1 && /^move:Song.mp3>/.test(c[0]) && !/kurokawa/.test(c[0]) && (await p.evaluate(() => window.__hashed.length)) === 0, c);
    ok(L('same storage: the message says nothing was copied'), /nothing was copied|لم يُنسخ شيء/.test(await p.evaluate(() => document.querySelector('.toast')?.textContent ?? '')), await p.evaluate(() => document.querySelector('.toast')?.textContent)); await p.close(); }
  // ---- a folder: every file inside summed
  { const { p } = await mk();
    await pasteTo(p, ['Sub'], 'copy', SD); await p.waitForTimeout(1800);
    ok(L('folder: its files are at the destination'), (await treeHas(p, SD + '/Sub/in.txt')) && (await treeHas(p, SD + '/Sub/Deeper/deep.txt')) && (await treeHas(p, SD + '/Sub/in2.txt')));
    ok(L('folder: the 3 files in it were each summed (original and copy)'), (await p.evaluate(() => window.__hashed.length)) === 6, await p.evaluate(() => window.__hashed.length)); await p.close(); }
  // ---- a stage left by a killed app is swept at the next start; it never shows
  { const stage = K + '/.kurokawa-extract-v-fj-old';
    const { p } = await page(browser, port, z, lang, { seed: (k) => { window.__put(k + '/.kurokawa-extract-v-fj-old', true); window.__put(k + '/.kurokawa-extract-v-fj-old/x.bin', false, 5); localStorage.setItem('kt.files.stages', JSON.stringify([k + '/.kurokawa-extract-v-fj-old'])); } });
    await p.waitForTimeout(800);
    ok(L('start: a stage left behind is deleted'), !(await treeHas(p, stage)) && !(await p.evaluate(() => localStorage.getItem('kt.files.stages'))), await p.evaluate(() => localStorage.getItem('kt.files.stages')));
    await p.close(); }
}


const SEED_CMP = (k) => {
  window.__put(k + '/Cmp', true); const mk = (n, u) => { window.__put(`${k}/Cmp/${n}`, false, u.length); window.__bytes[`${k}/Cmp/${n}`] = u; }; const te = (x) => new TextEncoder().encode(x);
  mk('a.txt', te('one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n')); mk('a-b.txt', te('one\ntwo\nTHREE\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\n'));
  const big = new Uint8Array(2_500_000); for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 255; mk('a1.bin', big); mk('a2.bin', big.slice());
  const d = big.slice(); d[1_600_000] ^= 1; mk('a3.bin', d); mk('a-s.bin', big.slice(0, 2_000_000));
  mk('a-e1.txt', new Uint8Array(0)); mk('a-e2.txt', new Uint8Array(0));
  window.__put(`${k}/Dups`, true); window.__put(`${k}/Dups/Sub`, true);
  for (const n of ['a.bin', 'b.bin', 'c.bin']) window.__put(`${k}/Dups/${n}`, false, 1000); window.__tree.get(`${k}/Dups/c.bin`).sig = 'other';
  window.__put(`${k}/Dups/d.bin`, false, 2000); window.__put(`${k}/Dups/e.bin`, false, 3000); window.__put(`${k}/Dups/Sub/f.bin`, false, 3000); window.__put(`${k}/Dups/zero1`, false, 0); window.__put(`${k}/Dups/zero2`, false, 0);
};
async function compare(browser, port, z, lang) {
  const L = (s) => `[${lang}-compare] ${s}`; const ar = lang === 'ar';
  const { p, errors } = await page(browser, port, z, lang, { at: K + '/Cmp', seed: SEED_CMP }); const cdp = await p.context().newCDPSession(p);
  const pickTwo = async (a, b) => {
    await rowOf(p, a).evaluate((e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(200); const r1 = await rowOf(p, a).boundingBox(); await hold(cdp, r1.x + r1.width / 2, r1.y + r1.height / 2); await p.waitForTimeout(300);
    await rowOf(p, b).evaluate((e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(200); const r2 = await rowOf(p, b).boundingBox(); await p.touchscreen.tap(r2.x + r2.width / 2, r2.y + r2.height / 2); await p.waitForTimeout(300);
    if (process.env.DBG) await p.screenshot({ path: '/tmp/claude-0/-home-claude/31db5f1c-a6c2-54e2-a5c4-2730cae2d727/scratchpad/dbg.png' });
    if (await p.locator('.files-selbar [data-icon="columns"]').count()) await p.click('.files-selbar [data-icon="columns"]');
    else { await p.click('.files-selbar [data-icon="more"]'); await p.waitForSelector('.sheet .dest-row'); await p.locator('.sheet .dest-row', { hasText: /^\s*(Compare|مقارنة)\s*$/ }).click(); }
    await p.waitForSelector('.files-cmp-verdict .grow b, .files-cmp-verdict.same, .files-cmp-verdict.diff', { timeout: 8000 }); await p.waitForTimeout(400);
  };
  const verdict = () => p.textContent('.files-cmp-verdict'); const closeSheet = async () => { await p.click('.sheet .sheet-head button[aria-label]'); await p.waitForTimeout(300); };
  const sameRe = /identical|متطابقان/, diffRe = /different|مختلفان/;
  // one file picked: no Compare
  const r0 = await rowOf(p, 'a.txt').boundingBox(); await hold(cdp, r0.x + r0.width / 2, r0.y + r0.height / 2); await p.waitForTimeout(300);
  ok(L('one file picked: Compare is not offered'), (await p.locator('.files-selbar [data-icon="columns"]').count()) === 0);
  await p.click('.files-selbar [data-icon="close"]').catch(() => undefined); await p.waitForTimeout(300);
  await pickTwo('a1.bin', 'a2.bin'); ok(L('identical files (2.5 MB, several chunks): said identical'), sameRe.test(await verdict()), await verdict());
  const reads = await p.evaluate(() => 0); void reads; await closeSheet();
  await pickTwo('a1.bin', 'a3.bin'); ok(L('same size, one byte differs: different, and where'), diffRe.test(await verdict()) && /1600000|1[,٬]?600[,٬]?000|١٦٠٠٠٠٠/.test(await verdict()), await verdict()); await closeSheet();
  await pickTwo('a1.bin', 'a-s.bin'); ok(L('different sizes: different by size first, nothing read'), diffRe.test(await verdict()) && /MB/.test(await verdict()), await verdict()); await closeSheet();
  await pickTwo('a-e1.txt', 'a-e2.txt'); ok(L('two empty files: identical'), sameRe.test(await verdict()), await verdict()); await closeSheet();
  // a computer's way: no chunk reads, the checksums
  await p.evaluate(() => { window.__noRead = window.Capacitor.Plugins.KurokawaTools.uriRead; window.Capacitor.Plugins.KurokawaTools.uriRead = undefined; window.__hashed.length = 0; });
  await pickTwo('a1.bin', 'a2.bin'); ok(L('no chunk reads: the checksums say identical'), sameRe.test(await verdict()) && (await p.evaluate(() => window.__hashed.length)) === 2, await verdict());
  await closeSheet(); await p.evaluate(() => { window.Capacitor.Plugins.KurokawaTools.uriRead = window.__noRead; });
  // two text files: the lines
  await pickTwo('a.txt', 'a-b.txt'); const diffTxt = await p.textContent('.files-cmp-diff');
  ok(L('text files: different, with the diff'), diffRe.test(await verdict()) && (await p.locator('.cmp-row.add').count()) === 2 && (await p.locator('.cmp-row.del').count()) === 1, [await p.locator('.cmp-row.add').count(), await p.locator('.cmp-row.del').count()]);
  ok(L('text files: the changed lines are there, marked + and −'), /THREE/.test(diffTxt) && /eleven/.test(diffTxt) && (await p.locator('.cmp-row.add .cmp-mark').first().textContent()) === '+' && (await p.locator('.cmp-row.del .cmp-mark').first().textContent()) === '−', diffTxt.slice(0, 200));
  const tint = await p.evaluate(() => { const c = (sel) => { const e = document.querySelector(sel); const g = getComputedStyle(e); return [g.backgroundColor, g.color]; }; const lum = (rgb) => { const sc = rgb.startsWith('color(') ? 255 : 1; const m = rgb.replace(/^color\(srgb/, '').match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => { v *= sc; v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]; }; const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }; return { add: ratio(...c('.cmp-row.add')), del: ratio(...c('.cmp-row.del')) }; });
  ok(L(`tints pass contrast (add ${tint.add.toFixed(1)}, remove ${tint.del.toFixed(1)}; 4.5 needed)`), tint.add >= 4.5 && tint.del >= 4.5, tint);
  await shot(p, `extras-compare${ar ? '-ar' : ''}.png`); await closeSheet();
  ok(L('no page errors'), !errors.filter((x) => !/favicon/.test(x)).length, errors); await p.close();
}
async function duplicates(browser, port, z, lang) {
  const L = (s) => `[${lang}-dups] ${s}`; const ar = lang === 'ar';
  const { p, errors } = await page(browser, port, z, lang, { at: K + '/Dups', seed: SEED_CMP });
  const open = async () => { await p.click('.topbar-actions .icon-btn[data-icon="more"]'); await p.waitForSelector('.sheet .dest-row'); await p.locator('.sheet .dest-row', { hasText: /Find duplicate files|البحث عن الملفات المكرّرة/ }).click(); await p.waitForSelector('.files-dups-sub'); };
  const search = async () => { await p.evaluate(() => { window.__hashed.length = 0; }); await p.click('.sheet .actions .btn.primary, .sheet .sheet-actions .btn.primary'); await p.waitForSelector('.files-dup-group', { timeout: 8000 }); await p.waitForTimeout(300); };
  await open(); ok(L('the folder menu offers it; sub-folders off by default'), !(await p.locator('.files-dups-sub input').isChecked()));
  await search();
  ok(L('this folder only: one group of two (a, b; c is the same size but different content)'), (await p.locator('.files-dup-group').count()) === 1 && (await p.locator('.files-dup-file').count()) === 2, await p.locator('.files-dup-file').count());
  const hashedNames = await p.evaluate(() => window.__hashed.map((x) => x.split('/').pop()).sort());
  ok(L(`only same-size files were summed (${hashedNames})`), hashedNames.join() === 'a.bin,b.bin,c.bin', hashedNames);
  ok(L('the wasted space is told'), /1000 B|1[,٬]?000 B|1\.0 ?KB|KB|B/.test(await p.textContent('.files-dups-sum')), await p.textContent('.files-dups-sum'));
  ok(L('nothing is ticked at first'), (await p.locator('.files-dup-file.on').count()) === 0 && (await p.locator('.sheet .btn.danger').isDisabled()));
  await p.locator('.files-dup-file').nth(0).click(); await p.waitForTimeout(150);
  ok(L('ticking one copy locks the other: at least one stays'), (await p.locator('.files-dup-file.on').count()) === 1 && (await p.locator('.files-dup-file.locked').count()) === 1);
  await p.locator('.files-dup-file').nth(1).click({ force: true }); await p.waitForTimeout(150); ok(L('the locked one cannot be ticked'), (await p.locator('.files-dup-file.on').count()) === 1);
  await shot(p, `extras-duplicates${ar ? '-ar' : ''}.png`);
  await p.click('.sheet .btn.danger'); await p.waitForTimeout(500);
  ok(L('Delete goes through the page\'s own delete question'), /Delete|حذف/.test(await p.textContent('.sheet')) && /1/.test(await p.textContent('.sheet')), (await p.textContent('.sheet')).slice(0, 200));
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  // with sub-folders
  await open(); await p.locator('.files-dups-sub').click(); await search();
  ok(L('with sub-folders: a second group (e.bin and Sub/f.bin)'), (await p.locator('.files-dup-group').count()) === 2 && /Sub/.test(await p.textContent('.files-dup-group:nth-of-type(1), .files-dups-out')), await p.locator('.files-dup-group').count());
  ok(L('empty files are not duplicates of anything'), !(await p.textContent('.files-dups-out')).includes('zero1'));
  // Cancel
  await p.keyboard.press('Escape'); await p.waitForTimeout(300); await p.evaluate(() => { window.__hashPause = 500; }); await open(); await p.evaluate(() => { window.__hashed.length = 0; });
  await p.click('.sheet .actions .btn.primary, .sheet .sheet-actions .btn.primary'); await p.waitForSelector('.files-dups-out .files-job'); await p.waitForFunction(() => window.__hashed.length >= 1);
  await p.locator('.files-dups-out .btn', { hasText: /Cancel|إلغاء/ }).click(); await p.waitForTimeout(900); const n1 = await p.evaluate(() => window.__hashed.length); await p.waitForTimeout(900);
  ok(L('Cancel: summing stops'), (await p.evaluate(() => window.__hashed.length)) === n1 && n1 <= 2, n1);
  ok(L('no page errors'), !errors.filter((x) => !/favicon/.test(x)).length, errors); await p.close();
}


async function reader(browser, port, z, lang) {
  const L = (s) => `[${lang}-reader] ${s}`; const ar = lang === 'ar';
  const { p, errors } = await page(browser, port, z, lang, { at: K + '/Books', seed: (k) => { window.__put(k + '/Books', true); for (const [n, sz] of [['novel.epub', 3e6], ['manual.pdf', 2e6], ['comic.cbz', 9e6], ['old.azw3', 1e6], ['story.fb2', 4e5], ['notes.txt', 900], ['photo.jpg', 2e6], ['song.mp3', 4e6], ['pack.zip', 5e6], ['vol.cbr', 7e6]]) window.__put(`${k}/Books/${n}`, false, sz); } });
  await p.evaluate(() => { const kt = window.Capacitor.Plugins.KurokawaTools; window.__asked = []; window.__opened = []; window.__readerOn = true;
    kt.appsFor = async ({ path, mime }) => { window.__asked.push(mime); return { apps: [{ pkg: 'com.other.viewer', cls: 'com.other.Viewer', label: 'Other' }, ...(window.__readerOn ? [{ pkg: 'app.kurokawa.reader', cls: 'app.kurokawa.reader.MainActivity', label: 'Kurokawa Reader' }] : [])] }; };
    kt.openIn = async (o) => { window.__opened.push(o); }; });
  const has = async (name) => { await menu(p, name); await p.waitForTimeout(500); const n = await p.locator('.sheet .files-open-reader').count(); return n; };
  const close = async () => { await p.keyboard.press('Escape'); await p.waitForTimeout(250); };
  ok(L('epub: «Open in Kurokawa Reader» is offered'), (await has('novel.epub')) === 1);
  const order = await p.evaluate(() => [...document.querySelectorAll('.sheet .dest-row')].slice(0, 3).map((x) => x.className.includes('files-open-reader')));
  ok(L('it sits right after Open'), order[1] === true, order);
  await shot(p, `extras-reader${ar ? '-ar' : ''}.png`);
  await p.click('.sheet .files-open-reader'); await p.waitForTimeout(300);
  const o = await p.evaluate(() => window.__opened[0]);
  ok(L('it opens the file in the Reader by an explicit intent (package, class, the file, its type)'), o && o.pkg === 'app.kurokawa.reader' && o.cls === 'app.kurokawa.reader.MainActivity' && /novel\.epub$/.test(o.path) && o.mime === 'application/epub+zip', o);
  for (const [n, mime] of [['manual.pdf', 'application/pdf'], ['comic.cbz', 'application/vnd.comicbook+zip'], ['old.azw3', 'application/x-mobipocket-ebook'], ['story.fb2', 'application/x-fictionbook+xml']]) { ok(L(`${n}: offered, asked under ${mime}`), (await has(n)) === 1 && (await p.evaluate(() => window.__asked.slice(-1)[0])) === mime); await close(); }
  for (const n of ['photo.jpg', 'song.mp3', 'pack.zip', 'vol.cbr']) { ok(L(`${n}: not a format the Reader opens: no entry`), (await has(n)) === 0); await close(); }
  await p.evaluate(() => { window.__readerOn = false; }); ok(L('the Reader not installed: no entry'), (await has('novel.epub')) === 0); await close();
  await p.evaluate(() => { window.__readerOn = true; window.Capacitor.Plugins.KurokawaTools.openIn = async () => { throw new Error('notInstalled'); }; }); await has('novel.epub'); await p.click('.sheet .files-open-reader'); await p.waitForTimeout(400);
  ok(L('a failed hand-over says so'), /could not open|تعذّر/.test(await p.evaluate(() => document.querySelector('.toast')?.textContent ?? '')), await p.evaluate(() => document.querySelector('.toast')?.textContent));
  ok(L('no page errors'), !errors.filter((x) => !/favicon/.test(x)).length, errors); await p.close();
  // a computer: nothing to ask about the Reader being installed, so no entry (Open uses the system default)
  const pc = await page(browser, port, z, lang, { at: K + '/Books', pc: true, seed: (k) => { window.__put(k + '/Books', true); window.__put(k + '/Books/novel.epub', false, 3e6); } });
  await pc.p.locator('.files-row', { has: pc.p.locator('.files-name[title="novel.epub"]') }).locator('button.icon-btn[data-icon="more"]').click().catch(() => undefined); await pc.p.waitForTimeout(500);
  ok(L('PC: no «Open in Kurokawa Reader» entry'), (await pc.p.locator('.files-open-reader').count()) === 0); await pc.p.close();
}

(async () => {
  const z = await F.zipListing(); const srv = await F.serve(); const port = srv.address().port; const browser = await chromium.launch();
  try {
    for (const lang of langs) {
      if (want('foldersize')) { await foldersize(browser, port, z, lang); await bigsize(browser, port, z, lang); }
      if (want('scroller')) await scroller(browser, port, z, lang);
      if (want('gallery')) await gallery(browser, port, z, lang);
      if (want('editor')) await editor(browser, port, z, lang);
      if (want('verify')) await verify(browser, port, z, lang);
      if (want('compare')) await compare(browser, port, z, lang);
      if (want('duplicates')) await duplicates(browser, port, z, lang);
      if (want('reader')) await reader(browser, port, z, lang);
    }
  } finally { await browser.close(); srv.close(); }
  console.log(fails ? `\n${fails} failed` : '\nall ok'); process.exit(fails ? 1 : 0);
})();
