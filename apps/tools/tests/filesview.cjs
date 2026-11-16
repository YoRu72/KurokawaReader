// The list/grid button in the Files header, on the pretend phone (tests/filesphone-fixture.cjs): one tap switches the
// folder in place (the address unchanged, the same page), the button shows the view a tap leads to and is named by what
// it does, the choice is kept in the page's settings, the pictures are asked again at the new size, the row that was in
// sight stays in sight, the button keeps its keyboard focus — on a phone, a computer (also two panes), in the picker and
// inside a zip; in English and Arabic.
// Run: NODE_PATH=$(npm root -g) node tests/filesview.cjs [en|ar]
const { chromium } = require('playwright'); const F = require('./filesphone-fixture.cjs'); const { K, ZIP } = F;
let fails = 0; const ok = (what, cond, x) => { console.log((cond ? 'ok   ' : 'FAIL ') + what + (cond || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!cond) fails++; };
const LABEL = { en: { grid: 'Switch to grid view', list: 'Switch to list view', gallery: 'Switch to gallery view' }, ar: { grid: 'التبديل إلى عرض الشبكة', list: 'التبديل إلى عرض القائمة', gallery: 'التبديل إلى عرض المعرض' } };
const BTN = '.files-view .topbar-actions .icon-btn[data-icon="grid"], .files-view .topbar-actions .icon-btn[data-icon="list"], .files-view .topbar-actions .icon-btn[data-icon="images"]';
// (The button cycles list -> grid -> gallery -> list; `toList` taps on until the list is back.)
const toList = async (p, how = 'click') => { for (let i = 0; i < 3 && (await p.evaluate((sel) => document.querySelector(sel)?.dataset.icon, BTN)) !== 'grid'; i++) { if (how === 'key') await p.keyboard.press('Enter'); else await p.click(BTN); await p.waitForTimeout(350); } };
const shot = (p, name) => (process.env.KT_SHOTS ? p.screenshot({ path: require('node:path').join(process.env.KT_SHOTS, name) }) : null);

async function prime(p) {
  await p.addInitScript(() => {
    const kt = window.Capacitor.Plugins.KurokawaTools; window.__thumbs = [];
    kt.filesThumb = async (o) => { window.__thumbs.push(o.path.split('/').pop() + '@' + o.px); const c = document.createElement('canvas'); c.width = 8; c.height = 8; c.getContext('2d').fillRect(0, 0, 8, 8); return { url: /\.jpg$/.test(o.path) ? c.toDataURL() : null }; };
  });
}
const state = (p) => p.evaluate((sel) => { const b = document.querySelector(sel); const l = document.querySelector('.files-view .files-list'); return { icon: b?.dataset.icon, label: b?.getAttribute('aria-label'), cls: l?.className, view: JSON.parse(localStorage.getItem('kt.files.prefs') || '{}').view, hash: location.hash, same: !!window.__listRef && window.__listRef === l }; }, BTN);

async function cycle(p, L, lang, what) {
  await p.evaluate(() => { window.__listRef = document.querySelector('.files-view .files-list'); });
  let s = await state(p); ok(L(`${what}: starts as a list, the button offers the grid`), /\blist\b/.test(s.cls) && s.icon === 'grid' && s.label === LABEL[lang].grid, s);
  const hash0 = s.hash;
  await p.click(BTN); await p.waitForTimeout(350); s = await state(p);
  ok(L(`${what}: one tap: the grid, in place (same page, same address)`), /\bgrid\b/.test(s.cls) && s.hash === hash0 && s.same, s);
  ok(L(`${what}: the button now offers the gallery, named so`), s.icon === 'images' && s.label === LABEL[lang].gallery, s);
  ok(L(`${what}: the choice kept`), s.view === 'grid', s);
  await p.click(BTN); await p.waitForTimeout(350); s = await state(p);
  ok(L(`${what}: tapped again: the gallery (a grid of square tiles), the button offers the list`), /\bgallery\b/.test(s.cls) && s.icon === 'list' && s.label === LABEL[lang].list && s.view === 'gallery', s);
  await p.click(BTN); await p.waitForTimeout(350); s = await state(p);
  ok(L(`${what}: tapped again: the list, the button as at first`), /\blist\b/.test(s.cls) && s.icon === 'grid' && s.view === 'list', s);
}

async function phone(browser, port, z, lang) {
  const L = (s) => `[${lang}-phone] ${s}`; const { page: p, errors } = await F.open(browser, { lang, pc: false, z, many: 120, width: 360, height: 780 }); await prime(p);
  await p.goto(`http://localhost:${port}/#/files?p=${encodeURIComponent(K)}`); await p.waitForSelector('.files-row'); await p.waitForTimeout(500);
  await cycle(p, L, lang, 'folder');
  // pictures: asked at the list's size, again at the grid's
  ok(L('thumbnails asked at the list size (96)'), (await p.evaluate(() => window.__thumbs)).includes('photo.jpg@96'), await p.evaluate(() => window.__thumbs));
  await p.click(BTN); await p.waitForTimeout(500);
  ok(L('… and again at the grid size (240)'), (await p.evaluate(() => window.__thumbs)).includes('photo.jpg@240'), await p.evaluate(() => window.__thumbs));
  await shot(p, 'view-button-grid.png');
  await toList(p); await shot(p, 'view-button-list.png');
  // keyboard: focus stays on the button
  await p.focus(BTN); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
  ok(L('keyboard: the button keeps the focus after the switch'), await p.evaluate((sel) => document.activeElement === document.querySelector(sel), BTN));
  await toList(p, 'key');
  // the scroll: a long folder, the row in sight stays in sight
  await p.evaluate((k) => { location.hash = '#/files?p=' + encodeURIComponent(k + '/Many') + '&t=2'; }, K); await p.waitForSelector('.files-row'); await p.waitForTimeout(500);
  await p.evaluate(() => { window.scrollTo(0, 1500); document.querySelector('.files-body').scrollTop = 1500; }); await p.waitForTimeout(300);
  const seen = () => p.evaluate(() => { const edge = document.querySelector('.topbar').getBoundingClientRect().bottom; const r = [...document.querySelectorAll('.files-row')].find((x) => x.getBoundingClientRect().bottom > edge + 1); return r ? { name: r.querySelector('.files-name').title, top: Math.round(r.getBoundingClientRect().top) } : null; });
  const before = await seen(); await p.click(BTN); await p.waitForTimeout(500); const after = await seen();
  const inView = await p.evaluate((n) => { const r = [...document.querySelectorAll('.files-row')].find((x) => x.querySelector('.files-name').title === n); if (!r) return false; const b = r.getBoundingClientRect(); return b.bottom > 0 && b.top < innerHeight; }, before.name);
  ok(L('long folder: the row that was at the top is still in sight after the switch'), !!before && inView, { before, after });
  await toList(p);
  const e = errors.filter((x) => !/favicon/.test(x)); ok(L('no page errors'), !e.length, e); await p.close();
}

async function archive(browser, port, z, lang) {
  const L = (s) => `[${lang}-zip] ${s}`; const { page: p, errors } = await F.open(browser, { lang, pc: false, z }); await prime(p);
  await p.goto(`http://localhost:${port}/#/files?p=${encodeURIComponent(K)}`); await p.waitForSelector('.files-row'); await p.waitForTimeout(400);
  await p.locator(`.files-row:has(.files-name[title="${ZIP}"]) .files-main`).first().click(); await p.waitForTimeout(700);
  await p.waitForSelector('.files-row'); await cycle(p, L, lang, 'inside a zip');
  const e = errors.filter((x) => !/favicon/.test(x)); ok(L('no page errors'), !e.length, e); await p.close();
}

async function picker(browser, port, z, lang) {
  const L = (s) => `[${lang}-picker] ${s}`; const { page: p, errors } = await F.open(browser, { lang, pc: false, z }); await prime(p);
  await p.addInitScript(() => { const kt = window.Capacitor.Plugins.KurokawaTools; kt.pickRequest = async () => ({ request: JSON.stringify({ id: 'r2', action: 'android.intent.action.GET_CONTENT', multiple: true, mimes: ['*/*'], caller: 'Aegisub Mobile' }) }); kt.pickDone = async () => undefined; });
  await p.goto(`http://localhost:${port}/#/`); await p.waitForTimeout(800); await p.evaluate(() => { location.hash = '#/pick?t=1'; }); await p.waitForSelector('.files-view.picker .files-row', { timeout: 15000 }); await p.waitForTimeout(500);
  await cycle(p, L, lang, 'picker');
  const e = errors.filter((x) => !/favicon/.test(x)); ok(L('no page errors'), !e.length, e); await p.close();
}

async function pc(browser, port, z, lang) {
  const L = (s) => `[${lang}-pc] ${s}`; const { page: p, errors } = await F.open(browser, { lang, pc: true, z }); await prime(p);
  await p.goto(`http://localhost:${port}/#/files?p=${encodeURIComponent(K)}`); await p.waitForSelector('.files-row'); await p.waitForTimeout(500);
  await cycle(p, L, lang, 'computer');
  await p.close();
  // two panes: the other pane follows, and its own button too
  const d = await F.open(browser, { lang, pc: true, z }); await prime(d.page); const q = d.page;
  await q.addInitScript((k) => { const pr = JSON.parse(localStorage.getItem('kt.files.prefs') || '{}'); localStorage.setItem('kt.files.prefs', JSON.stringify({ ...pr, dual: true, lastB: k })); }, K);
  await q.goto(`http://localhost:${port}/#/files?p=${encodeURIComponent(K)}`); await q.waitForSelector('.files-dual .files-row'); await q.waitForTimeout(500);
  const st = () => q.$$eval('.files-dual > .files-view', (vs) => vs.map((v) => ({ cls: v.querySelector('.files-list').className, icon: v.querySelector('.topbar-actions .icon-btn[data-icon="grid"], .topbar-actions .icon-btn[data-icon="list"], .topbar-actions .icon-btn[data-icon="images"]').dataset.icon })));
  await q.click('.files-dual > .files-view >> nth=0 >> .topbar-actions .icon-btn[data-icon="grid"]'); await q.waitForTimeout(500); const s = await st();
  ok(L('two panes: both lists are grids, both buttons offer the gallery'), s.length === 2 && s.every((x) => /\bgrid\b/.test(x.cls) && x.icon === 'images'), s);
  await q.close();
  const e = [...errors, ...d.errors].filter((x) => !/favicon/.test(x)); ok(L('no page errors'), !e.length, e);
}
(async () => {
  const z = await F.zipListing(); const srv = await F.serve(); const port = srv.address().port; const browser = await chromium.launch();
  for (const lang of process.argv[2] ? [process.argv[2]] : ['en', 'ar']) { await phone(browser, port, z, lang); await archive(browser, port, z, lang); await picker(browser, port, z, lang); await pc(browser, port, z, lang); }
  await browser.close(); srv.close(); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
