// The phone's Files list, rebuilt for density (F2a): compact rows (a dozen and more in sight), the date at the row's end
// (right in English, left in Arabic), «N items» / «Empty» (nothing when the count is unknown), a «..» row that goes up and
// is no part of the selection, the header's folders-above drop-down, the density setting kept, and the computer's rows
// as they were. Run: NODE_PATH=$(npm root -g) node tests/filesrows.cjs [en|ar] [--shots]
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs'); const F = require('./filesphone-fixture.cjs'); const { K } = F;
const SHOTS = process.argv.includes('--shots') ? process.env.KT_SHOTS || '/tmp' : null;
let fails = 0; const ok = (what, cond, x) => { console.log((cond ? 'ok   ' : 'FAIL ') + what + (cond || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!cond) fails++; };
const WELL = ['Download', 'DCIM', 'Pictures', 'Music', 'Movies', 'Documents', 'Android', 'Alarms', 'Books', 'Podcasts', 'Recordings'];
async function run(browser, port, lang, pc, z) {
  const L = (s) => `[${lang}-${pc ? 'pc' : 'phone'}] ${s}`;
  const { page: p, errors } = await F.open(browser, { lang, pc, z, width: 360, height: 800, dense: true });
  await p.addInitScript(() => { const P = window.Capacitor.Plugins; const k = P.KurokawaTools; P.KurokawaTools = new Proxy(k, { get: (t, n) => (n === 'filesList' ? async (a) => { const r = await t.filesList(a); for (const e of r.entries) if (e.name === 'nocount') delete e.count; return r; } : t[n]) }); });
  await p.emulateMedia({ colorScheme: lang === 'en' && !pc ? 'dark' : 'light' });
  await p.addInitScript(() => { if (sessionStorage.getItem('kComfy')) { const v = JSON.parse(localStorage.getItem('kt.files.prefs') || '{}'); v.density = 'comfortable'; localStorage.setItem('kt.files.prefs', JSON.stringify(v)); } });
  await p.goto(`http://localhost:${port}/#/search`); await p.waitForTimeout(600);
  await p.evaluate(({ K, WELL }) => { for (const n of WELL) window.__put(`${K}/${n}`, true); window.__put(`${K}/Emptied`, true); window.__put(`${K}/nocount`, true); window.__put(`${K}/${'Download'}/a.txt`, false, 10); window.__put(`${K}/today.txt`, false, 4096, Date.now()); for (let i = 0; i < 6; i++) window.__put(`${K}/note ${i}.txt`, false, 100 * i, 1760000000000 + i * 86400000); }, { K, WELL });
  await p.click('[data-dest="files"]'); await p.waitForSelector('.files-row'); await p.waitForTimeout(600);
  const rtl = lang === 'ar'; const rowOf = (n) => p.locator(`.files-row:has(.files-name[title="${n}"])`).first();
  const view = async () => { if (await p.$('.files-list.grid')) { await p.click('.files-view .topbar [data-icon="list"]'); await p.waitForTimeout(300); } };
  await view();
  if (!pc) {
    const h = await p.$eval('.files-row', (r) => r.getBoundingClientRect().height);
    ok(L('compact rows are 56 px high'), Math.abs(h - 56) < 1, h);
    const vis = await p.$$eval('.files-row', (rs) => rs.filter((r) => { const b = r.getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight; }).length);
    ok(L('a dozen rows or more in sight (800 px)'), vis >= 12, vis);
    const g = await p.evaluate((n) => { const r = [...document.querySelectorAll('.files-row')].find((x) => x.querySelector('.files-name')?.title === n); const d = r.querySelector('.files-date'); const rb = r.getBoundingClientRect(), db = d.getBoundingClientRect(); return { txt: d.textContent, atEnd: document.dir === 'rtl' || document.documentElement.dir === 'rtl' ? db.left - rb.left : rb.right - db.right, more: !!r.querySelector('[data-icon="more"]'), digits: /[٠-٩]/.test(d.textContent) }; }, 'note 1.txt');
    ok(L('the date sits at the row end'), g.atEnd >= 0 && g.atEnd < 16 && g.txt.length > 0 && !g.digits, g);
    ok(L('no ⋮ on a compact row'), !g.more);
    const hd = await p.evaluate(() => { const b = document.querySelector('.files-view .topbar').getBoundingClientRect(), t = document.querySelector('.files-title').getBoundingClientRect(), hh = document.querySelector('.files-head').getBoundingClientRect(), ps = document.querySelector('.files-path').getBoundingClientRect(); return { bh: Math.round(b.height), tTop: t.top >= b.top, hw: Math.round(hh.width), pathLine: ps.height > 0 && ps.bottom <= b.bottom, txt: document.querySelector('.files-path').textContent, scrollW: document.documentElement.scrollWidth }; });
    ok(L('header: 56 px bar, title block >= 140 px, second line present, nothing clipped'), hd.bh >= 56 && hd.tTop && hd.hw >= 140 && hd.pathLine && hd.txt.length > 0 && hd.scrollW <= 360, hd);
    ok(L('an older date shows a 4-digit year'), /2025/.test(await rowOf('note 1.txt').locator('.files-date').textContent()));
    const sec = await rowOf('Emptied').locator('.files-main small').textContent(); ok(L('an empty folder says «Empty»'), sec.trim() === (rtl ? 'فارغ' : 'Empty'), sec);
    ok(L('a folder with entries says its count'), /1|واحد/.test(await rowOf('Download').locator('.files-main small').textContent()));
    ok(L('an unknown count shows nothing'), (await rowOf('nocount').locator('.files-main small').textContent()).trim() === '');
    ok(L('a file shows its size'), /KB|ك/i.test(await rowOf('today.txt').locator('.files-main small').textContent()));
    const td = await rowOf('today.txt').locator('.files-date').textContent(); ok(L('today shows the time'), /\d{1,2}:\d{2}/.test(td), td);
    ok(L('well-known folders carry a glyph'), (await p.$$eval('.files-row .files-ic svg path[transform]', (e) => e.length)) >= 8);
    ok(L('no «..» at the top of a storage'), (await p.$$('.files-uprow')).length === 0);
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `F2a-phone-${lang}-${lang === 'en' ? 'dark' : 'light'}.png`) });
    // the drop-down
    await p.click('.files-row:has(.files-name[title="Sub"]) .files-main'); await p.waitForTimeout(500);
    ok(L('«..» present inside a folder, first'), (await p.$$('.files-uprow')).length === 1 && await p.$eval('.files-list > :first-child', (e) => e.classList.contains('files-uprow')));
    ok(L('the header names the folder, the path under it (LTR)'), (await p.textContent('.files-title')).includes('Sub') && (await p.$eval('.files-path', (e) => e.textContent)).includes('Kurokawa') && (await p.$eval('.files-path', (e) => getComputedStyle(e.firstElementChild).direction)) === 'ltr');
    { const g = await p.evaluate(() => { const r = (q) => document.querySelector(q).getBoundingClientRect(); const a = r('.files-title'), b = r('.files-path'), h = r('.files-head'), bar = r('.topbar'); return { ta: a.left, tr: a.right, pl: b.left, pr: b.right, hc: (h.top + h.bottom) / 2, bc: (bar.top + bar.bottom) / 2, w: innerWidth }; });
      ok(L('the title and the path line start on the same side (the page\'s start), one block centred in the bar'), (rtl ? Math.abs(g.tr - g.pr) <= 2 : Math.abs(g.ta - g.pl) <= 2) && Math.abs(g.hc - g.bc) <= 3, g); }
    await p.click('.files-head'); await p.waitForTimeout(250);
    ok(L('a tap on the header opens the folders above, storage first'), (await p.$$eval('.files-crumbs.open .crumb', (e) => e.length)) >= 2);
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'F2a-ancestors.png') });
    await p.click('.files-crumbs.open .crumb:nth-child(1)'); await p.waitForTimeout(500);
    ok(L('an ancestor navigates and the drop-down closes'), (await p.$$('.files-crumbs.open')).length === 0 && (await p.$$('.files-row')).length > 5 && (await p.$$('.files-uprow')).length === 0 && (await p.textContent('.files-title')) === 'Kurokawa');
    await p.click('.files-row:has(.files-name[title="Sub"]) .files-main'); await p.waitForTimeout(500);
    await p.click('.files-uprow'); await p.waitForTimeout(500);
    ok(L('«..» goes up'), (await p.$$('.files-row .files-name[title="Sub"]')).length === 1 && (await p.$$('.files-uprow')).length === 0);
    // «..» is no part of the selection
    await p.click('.files-row:has(.files-name[title="Sub"]) .files-main'); await p.waitForTimeout(400);
    const b = await rowOf('in.txt').boundingBox(); await p.mouse.move(b.x + 80, b.y + 20); await p.mouse.down(); await p.waitForTimeout(650); await p.mouse.up(); await p.waitForTimeout(200);
    ok(L('selecting: the count counts rows only, «..» stays inert'), /1|واحد/.test(await p.textContent('.files-selcount')) && !(await p.$eval('.files-uprow', (e) => e.classList.contains('picked'))) && (await p.$$('.files-uprow .files-check')).length === 0);
    await p.evaluate(() => window.__back()); await p.waitForTimeout(400);
    // the density setting: comfortable brings the old row and its ⋮ back, and is kept
    await p.evaluate(() => sessionStorage.setItem('kComfy', '1')); await p.reload(); await p.waitForTimeout(700);
    if (!(await p.$('.files-row'))) await p.click('[data-dest="files"]'); await p.waitForSelector('.files-row'); await view();
    const hc = await p.$eval('.files-row', (r) => r.getBoundingClientRect().height); ok(L('comfortable: the old row (taller) with its ⋮'), hc > 56 && !!(await p.$('.files-row .icon-btn[data-icon="more"]')), hc);
    ok(L('comfortable: no date cell at the end'), await p.$eval('.files-row', (r) => !r.querySelector('.files-date')));
  } else {
    const r = await p.$eval('.files-row', (e) => ({ h: Math.round(e.getBoundingClientRect().height), dense: !!e.closest('.dense') }));
    ok(L('the computer has its own details row (32 px, not the phone\'s dense one, no ⋮ on the row)'), !r.dense && r.h === 32 && !!(await p.$('.files-row.d-row')) && !(await p.$('.files-row .icon-btn[data-icon="more"]')) && (await p.$$('.files-uprow')).length === 0, r);
    ok(L('the computer keeps its crumbs and its title lines'), (await p.$eval('.files-crumbs', (e) => getComputedStyle(e).position)) !== 'fixed' && (await p.$eval('.files-strip', (e) => getComputedStyle(e).display)) === 'contents' && (await p.$eval('.files-path', (e) => getComputedStyle(e).display)) === 'none');
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'F2a-pc.png') });
  }
  ok(L('no page errors'), errors.length === 0, errors.slice(0, 3));
  await p.close();
}
(async () => {
  const langs = process.argv.includes('ar') ? ['ar'] : process.argv.includes('en') ? ['en'] : ['en', 'ar'];
  const z = await F.zipListing(); const server = await F.serve(); const port = server.address().port;
  const browser = await chromium.launch();
  for (const lang of langs) { await run(browser, port, lang, false, z); }
  await run(browser, port, 'en', true, z);
  await browser.close(); server.close(); console.log(fails ? `${fails} FAILED` : 'all ok'); process.exit(fails ? 1 : 0);
})();
