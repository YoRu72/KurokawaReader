// Back in the Files page, on a pretend phone (tests/filesphone-fixture.cjs) and a computer, in English and Arabic:
// the phone's Back closes the open sheet first, then the selection, then walks up one folder at a time — inside a zip
// up its folders, then out to the folder that holds it — to the top of Files, and only then leaves Files for the page
// the reader came from (not always the downloads); the arrow in the bar does the same; a folder's scroll comes back
// with it; on a computer the browser's Back and Forward walk the folders.
// Run: NODE_PATH=$(npm root -g) node tests/filesback.cjs [en|ar]
const { chromium } = require('playwright'); const F = require('./filesphone-fixture.cjs'); const { K, ZIP } = F;
let fails = 0; const ok = (what, cond, x) => { console.log((cond ? 'ok   ' : 'FAIL ') + what + (cond || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!cond) fails++; };
const arcOf = (archive, inner = '') => `arc://${encodeURIComponent(archive)}${inner ? '/' + inner : ''}`;

async function phone(browser, port, z, lang) {
  const L = (s) => `[${lang}-phone] ${s}`; const { page: p, errors } = await F.open(browser, { lang, pc: false, z, many: 120 });
  const where = async () => { const h = await p.evaluate(() => location.hash); const m = /[?&]p=([^&]*)/.exec(h); return m ? decodeURIComponent(m[1]) : h; };
  const sysBack = async () => { await p.evaluate(() => window.__back()); await p.waitForTimeout(500); };
  const row = (name) => p.locator(`.files-row:has(.files-name[title="${name}"])`).first();
  const tap = async (name) => { await row(name).locator('.files-main').click(); await p.waitForTimeout(500); };
  await p.goto(`http://localhost:${port}/#/search`); await p.waitForTimeout(600);
  await p.click('[data-dest="files"]'); await p.waitForSelector('.files-row'); await p.waitForTimeout(500);
  ok(L('Files opens on its folder; no arrow at the top'), (await p.textContent('.files-title')) === 'Kurokawa' && await p.$eval('.files-view .files-back', (b) => b.hidden), await where());
  await tap('Sub'); await tap('Deeper');
  ok(L('down two folders'), (await where()) === `${K}/Sub/Deeper` && !(await p.$eval('.files-view .files-back', (b) => b.hidden)));
  await row('deep.txt').locator('.icon-btn[data-icon="more"]').click(); await p.waitForSelector('.sheet'); await sysBack();
  ok(L('Back closes the open sheet first, the folder stays'), !(await p.$('.sheet')) && (await where()) === `${K}/Sub/Deeper`);
  const b = await row('deep.txt').boundingBox(); await p.mouse.move(b.x + 80, b.y + 20); await p.mouse.down(); await p.waitForTimeout(650); await p.mouse.up(); await p.waitForTimeout(200);
  ok(L('(a selection made)'), await p.$eval('.files-view', (v) => v.classList.contains('selecting')));
  await sysBack(); ok(L('Back leaves the selection, the folder stays'), !(await p.$eval('.files-view', (v) => v.classList.contains('selecting'))) && (await where()) === `${K}/Sub/Deeper`);
  await sysBack(); ok(L('Back: up one folder'), (await where()) === `${K}/Sub`, await where());
  await sysBack(); ok(L('Back: up again, to the top of Files'), (await where()) === K, await where());
  // inside a zip: up its folders, then out to the folder holding it
  await tap(ZIP); await tap('Fonts'); await tap('sub');
  ok(L('inside the zip, two folders down'), (await where()) === arcOf(`${K}/${ZIP}`, 'Fonts/sub'), await where());
  ok(L('the title there: the folder\'s name'), (await p.textContent('.files-title')) === 'sub');
  await sysBack(); ok(L('Back inside the zip: its folder above'), (await where()) === arcOf(`${K}/${ZIP}`, 'Fonts'), await where());
  await sysBack(); ok(L('Back: the zip\'s top'), (await where()) === arcOf(`${K}/${ZIP}`), await where());
  await sysBack(); ok(L('Back from the zip\'s top: the folder that holds it'), (await where()) === K, await where());
  // the arrow in the bar does the same
  await tap('Sub'); await p.click('.files-view .files-back'); await p.waitForTimeout(500); ok(L('the arrow in the bar: up a folder'), (await where()) === K);
  // a folder's scroll comes back with it
  await tap('Many'); await p.evaluate(() => { window.scrollTo(0, 1500); document.querySelector('.files-body').scrollTop = 1500; }); await p.waitForTimeout(250);
  const y0 = await p.evaluate(() => Math.max(window.scrollY, document.querySelector('.files-body').scrollTop));
  await p.evaluate(() => { const r = [...document.querySelectorAll('.files-row')].find((x) => x.querySelector('.files-name')?.title === 'Inner'); r.querySelector('.files-main').click(); }); await p.waitForTimeout(500);
  await sysBack(); await p.waitForTimeout(300);
  const y1 = await p.evaluate(() => Math.max(window.scrollY, document.querySelector('.files-body').scrollTop));
  ok(L('back in a long folder: scrolled where it was'), y0 > 1000 && Math.abs(y1 - y0) < 40 && (await where()) === `${K}/Many`, { y0, y1 });
  await sysBack(); ok(L('(up to the top)'), (await where()) === K);
  await sysBack(); ok(L('Back at the top of Files: where the reader came from (Search), not the downloads'), /#\/search/.test(await p.evaluate(() => location.hash)), await p.evaluate(() => location.hash));
  const errs = errors.filter((e) => !/favicon/.test(e)); ok(L('no page errors'), !errs.length, errs);
  await p.close();
}
async function pc(browser, port, z, lang) {
  const L = (s) => `[${lang}-pc] ${s}`; const { page: p, errors } = await F.open(browser, { lang, pc: true, z });
  const where = async () => { const h = await p.evaluate(() => location.hash); const m = /[?&]p=([^&]*)/.exec(h); return m ? decodeURIComponent(m[1]) : h; };
  const tap = async (name) => { await p.locator(`.files-row:has(.files-name[title="${name}"]) .files-main`).first().click(); await p.waitForTimeout(500); };
  await p.goto(`http://localhost:${port}/#/files?p=${encodeURIComponent(K)}`); await p.waitForSelector('.files-row'); await p.waitForTimeout(500);
  await tap('Sub'); await tap('Deeper'); await tap('deep.txt').catch(() => undefined); await p.keyboard.press('Escape'); await p.waitForTimeout(300); if (await p.$('.sheet')) { await p.click('.sheet .sheet-head button'); await p.waitForTimeout(300); }
  await p.goBack(); await p.waitForTimeout(500); ok(L('the browser\'s Back: the folder before'), (await where()) === `${K}/Sub`, await where());
  await p.goBack(); await p.waitForTimeout(500); ok(L('…and the one before it'), (await where()) === K, await where());
  await p.goForward(); await p.waitForTimeout(500); ok(L('Forward: into the folder again'), (await where()) === `${K}/Sub`, await where());
  await p.keyboard.press('Alt+ArrowLeft'); await p.waitForTimeout(500); ok(L('Alt+←: up a folder'), (await where()) === K, await where());
  await tap(ZIP); await p.click('.files-view .files-back'); await p.waitForTimeout(500); ok(L('the arrow from a zip\'s top: the folder holding it'), (await where()) === K, await where());
  const errs = errors.filter((e) => !/favicon/.test(e)); ok(L('no page errors'), !errs.length, errs);
  await p.close();
}
(async () => {
  const z = await F.zipListing(); const srv = await F.serve(); const port = srv.address().port; const browser = await chromium.launch();
  for (const lang of process.argv[2] ? [process.argv[2]] : ['en', 'ar']) { await phone(browser, port, z, lang); await pc(browser, port, z, lang); }
  await browser.close(); srv.close(); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
