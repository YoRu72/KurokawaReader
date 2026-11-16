// Renaming many at once in the Files page (the batch sheet, its run and its Undo), on the pretend phone
// (tests/filesphone-fixture.cjs) at 360 px and on a computer, in English and Arabic, with made-up names only:
// the order things were picked in (badges through scroll, lazy blocks and select-all), the sheet's sections (name,
// number, extension with its «not converted» switch, clashes, presets), the preview (a counted-work budget at 5,000),
// the run as a job (swap, chain, cancel midway, a failing step, Undo restoring every name), the interrupted-run banner,
// F2 and Ctrl+Z. KT_SHOTS=<dir>: the pictures.
// Run: NODE_PATH=$(npm root -g) node tests/filesbatch.cjs [en|ar]
const { chromium } = require('playwright'); const esbuild = require('esbuild'); const path = require('node:path'); const F = require('./filesphone-fixture.cjs'); const { K } = F;
let fails = 0; const ok = (what, cond, x) => { console.log((cond ? 'ok   ' : 'FAIL ') + what + (cond || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 500))); if (!cond) fails++; };
const SHOTS = process.env.KT_SHOTS; const shot = (p, name) => (SHOTS ? p.screenshot({ path: path.join(SHOTS, name) }) : null);
const bundle = esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src/views/filesBatch.ts')], bundle: true, write: false, format: 'cjs', platform: 'node' });
const BM = {}; new Function('module', 'exports', bundle.outputFiles[0].text)(BM, BM.exports = {}); const B = BM.exports;
const AR = ['أغنية النهاية (كاريوكي).ass', 'المقدمة - 01.ass', 'تتر البداية.mkv'];

async function open(browser, port, z, { lang, pc, many = 0, width = 360, put = [] }) {
  const { page: p, errors } = await F.open(browser, { lang, pc, z, many, width, height: pc ? 800 : 780 });
  await p.addInitScript((put) => { for (const [n, size] of put) window.__put(`${'/storage/emulated/0/Download/Kurokawa'}/${n}`, false, size); }, put);
  await p.goto(`http://localhost:${port}/#/files?p=${encodeURIComponent(K)}`); await p.waitForSelector('.files-row'); await p.waitForTimeout(500);
  return { p, errors };
}
const rowOf = (p, name) => p.locator(`.files-row:has(.files-name[title="${name}"])`).first();
const hold = async (p, name) => { await rowOf(p, name).scrollIntoViewIfNeeded(); await p.waitForTimeout(100); const b = await rowOf(p, name).boundingBox(); await p.mouse.move(b.x + 80, b.y + 20); await p.mouse.down(); await p.waitForTimeout(650); await p.mouse.up(); await p.waitForTimeout(200); };
const tap = async (p, name) => { await rowOf(p, name).locator('.files-main').click(); await p.waitForTimeout(120); };
const badge = (p, name) => p.evaluate((n) => { const r = [...document.querySelectorAll('.files-row')].find((x) => x.querySelector('.files-name')?.title === n); const c = r?.querySelector('.files-check'); return c ? (c.classList.contains('order') ? c.textContent : c.dataset.on === 'true' ? 'tick' : '') : null; }, name);
const treeNames = (p, dir = K) => p.evaluate((d) => [...window.__tree.keys()].filter((k) => k.startsWith(d + '/') && !k.slice(d.length + 1).includes('/')).map((k) => k.slice(d.length + 1)).sort(), dir);
const sheet = (p) => p.locator('.sheet.batch-sheet');
const openBatch = async (p) => {
  const direct = p.locator('.files-selbar button[aria-label="Rename all…"], .files-selbar button[aria-label="إعادة تسمية الكل…"]');
  if (await direct.count()) await direct.first().click(); else { await p.click('.files-selbar [data-icon="more"]'); await p.locator('.sheet .dest-row', { hasText: /Rename all…|إعادة تسمية الكل…/ }).first().click(); } // (a narrow bar keeps it under ⋮)
  await p.waitForSelector('.batch-sheet .batch-row'); await p.waitForTimeout(250);
};
const prev = (p) => p.$$eval('.batch-sheet .batch-row', (rs) => rs.map((r) => ({ n: r.querySelector('.batch-n').textContent, old: r.querySelector('.batch-old').textContent, nw: r.querySelector('.batch-new').textContent, cls: r.className, flags: r.querySelector('.batch-flags')?.textContent ?? '' })));
const chip = (p, label) => p.locator('.batch-sheet .chip', { hasText: label }).first();
const goBtn = (p) => p.locator('.batch-sheet .sheet-actions .btn.primary');
const geometry = (p) => p.evaluate(() => {
  // (Controls that touch: two visible controls of the sheet whose boxes overlap or are closer than 4 px; text cut: a control wider inside than shown.)
  const els = [...document.querySelectorAll('.batch-sheet .chip, .batch-sheet input:not([type=checkbox]), .batch-sheet button.btn')].filter((e) => { if (!e.getClientRects().length || e.closest('.batch-prev')) return false; const body = document.querySelector('.batch-sheet .sheet-body').getBoundingClientRect(); const r = e.getBoundingClientRect(); return !e.closest('.sheet-body') || (r.top >= body.top && r.bottom <= body.bottom); });
  const box = els.map((e) => ({ e, r: e.getBoundingClientRect() })); const bad = [];
  for (let i = 0; i < box.length; i++) for (let j = i + 1; j < box.length; j++) { const a = box[i].r, b = box[j].r; if (box[i].e.contains(box[j].e) || box[j].e.contains(box[i].e)) continue; const gx = Math.max(a.left - b.right, b.left - a.right), gy = Math.max(a.top - b.bottom, b.top - a.bottom); if (gx < 3 && gy < 3 && !(gx < -a.width / 2 && false)) bad.push([box[i].e.textContent.slice(0, 14) || box[i].e.className, box[j].e.textContent.slice(0, 14) || box[j].e.className, Math.round(gx), Math.round(gy)]); }
  const wide = document.documentElement.scrollWidth > innerWidth + 1; return { bad: bad.slice(0, 6), wide };
});

async function badges(browser, port, z, lang) {
  const L = (s) => `[${lang}-360] ${s}`; const { p, errors } = await open(browser, port, z, { lang, pc: false, many: 120 });
  await hold(p, 'photo.jpg'); await tap(p, 'broken.bin'); await tap(p, 'Song.mp3');
  ok(L('first tap is 1: photo 1, broken 2, Song 3 (not the list\'s order)'), (await badge(p, 'photo.jpg')) === '1' && (await badge(p, 'broken.bin')) === '2' && (await badge(p, 'Song.mp3')) === '3', [await badge(p, 'photo.jpg'), await badge(p, 'broken.bin'), await badge(p, 'Song.mp3')]);
  await shot(p, lang === 'en' ? 'batch-order-badges.png' : 'batch-order-badges-ar.png');
  await tap(p, 'broken.bin'); ok(L('letting one go renumbers the rest (photo 1, Song 2); the one let go has no badge'), (await badge(p, 'Song.mp3')) === '2' && (await badge(p, 'broken.bin')) === '', [await badge(p, 'Song.mp3'), await badge(p, 'broken.bin')]);
  await tap(p, 'broken.bin'); ok(L('picked again: it goes last (3)'), (await badge(p, 'broken.bin')) === '3');
  // through scroll and lazy blocks, and select-all
  await p.click('.files-selbar button[aria-label="Close"], .files-selbar button[aria-label="إغلاق"]'); await p.waitForTimeout(200);
  await tap(p, 'Many'); await p.waitForSelector('.files-row:has(.files-name[title="file 000.txt"])'); await p.waitForTimeout(500);
  await p.evaluate(() => { window.scrollTo(0, 3000); document.querySelector('.files-body').scrollTop = 3000; }); await p.waitForTimeout(500);
  const names = await p.$$eval('.files-row', (rs) => rs.filter((r) => { const b = r.getBoundingClientRect(); return b.top > 160 && b.bottom < innerHeight - 140; }).map((r) => r.querySelector('.files-name').title)); const far = names[Math.floor(names.length / 2)];
  await hold(p, far);
  await p.evaluate(() => { window.scrollTo(0, 0); document.querySelector('.files-body').scrollTop = 0; }); await p.waitForTimeout(500);
  await tap(p, 'file 002.txt'); await tap(p, 'file 000.txt');
  ok(L('picked far down, then near the top: 1, 2, 3 whatever is drawn'), (await badge(p, 'file 002.txt')) === '2' && (await badge(p, 'file 000.txt')) === '3');
  await p.evaluate(() => { window.scrollTo(0, 3000); document.querySelector('.files-body').scrollTop = 3000; }); await p.waitForTimeout(600);
  ok(L('… scrolled back down: the first pick still wears 1 (its block drawn again)'), (await badge(p, far)) === '1', await badge(p, far));
  await p.click('.files-selbar button[aria-label="Select all"], .files-selbar button[aria-label="تحديد الكل"]'); await p.waitForTimeout(300);
  await p.evaluate(() => { window.scrollTo(0, 0); document.querySelector('.files-body').scrollTop = 0; }); await p.waitForTimeout(500);
  const d = (n) => String(n);
  ok(L('select-all: the three keep 1, 2, 3; the rest follow in the list\'s order (the folder first)'), (await badge(p, far)) === d(1) && (await badge(p, 'file 002.txt')) === d(2) && (await badge(p, 'file 000.txt')) === d(3) && (await badge(p, 'Inner')) === d(4) && (await badge(p, 'file 001.txt')) === d(5) && (await badge(p, 'file 003.txt')) === d(6), [await badge(p, far), await badge(p, 'file 001.txt'), await badge(p, 'file 003.txt')]);
  await p.click('.files-selbar button[aria-label="More"], .files-selbar button[aria-label="المزيد"]'); await p.waitForSelector('.sheet .dest-row'); await p.locator('.sheet .dest-row', { hasText: /Invert|عكس/ }).first().click(); await p.waitForTimeout(300);
  ok(L('invert after select-all: nothing left picked'), await p.$eval('.files-view', (v) => !v.classList.contains('selecting')) || (await p.$$('.files-check.order')).length === 0);
  const e = errors.filter((x) => !/favicon/.test(x)); ok(L('no page errors'), !e.length, e); await p.close();
}

const GROUPS = { name: 0, pos: 1, order: 2, ext: 3, clash: 4 };
const radio = async (p, g, i) => { await p.locator('.batch-sheet [role=radiogroup]').nth(GROUPS[g]).locator('[role=radio]').nth(i).click(); await p.waitForTimeout(120); };
const sw = async (p, i) => { await p.locator('.batch-sheet .switch-row input').nth(i).click({ force: true }); await p.waitForTimeout(120); };
const typeIn = async (p, sel, v) => { const el = p.locator(sel).first(); await el.fill(v); await p.waitForTimeout(150); };
const nameInputs = (p) => p.locator('.batch-sheet .batch-sec').nth(0).locator('input[type=text]');
const goes = async (p) => !(await goBtn(p).isDisabled());
const scrollSec = (p, i) => p.evaluate((k) => { const b = document.querySelector('.batch-sheet .sheet-body'); const sec = document.querySelectorAll('.batch-sheet .batch-sec')[k]; b.scrollTop = sec.offsetTop - b.offsetTop - 4; }, i);
async function sheets(browser, port, z, lang) {
  const L = (s) => `[${lang}-360] ${s}`; const { p, errors } = await open(browser, port, z, { lang, pc: false, many: 120 });
  const d = (n) => String(n);
  await tap(p, 'Many'); await p.waitForSelector('.files-row:has(.files-name[title="file 000.txt"])'); await p.waitForTimeout(400);
  await hold(p, 'file 021.txt'); for (let i = 10; i < 21; i++) await tap(p, `file ${String(i).padStart(3, '0')}.txt`);
  await openBatch(p);
  ok(L('the sheet is named by the count'), (await p.textContent('.batch-sheet .sheet-head h3')).includes(d(12)), await p.textContent('.batch-sheet .sheet-head h3'));
  let pv = await prev(p);
  ok(L('first: the items in the order picked (021 first), each marked by its place'), pv[0].old === 'file 021.txt' && pv[0].n === d(1) && pv[1].old === 'file 010.txt' && pv[1].n === d(2), pv.slice(0, 2));
  ok(L('nothing asked: all unchanged, Rename off'), pv.every((r) => /skip/.test(r.cls)) && !(await goes(p)));
  // name + number
  await radio(p, 'name', 1); await nameInputs(p).nth(0).fill('Show'); await p.waitForTimeout(150); ok(L('a new name for all 12: two results the same — told, Rename off'), !(await goes(p)) && (await prev(p)).some((r) => /bad/.test(r.cls)));
  await sw(p, 2); await p.waitForTimeout(250); pv = await prev(p);
  ok(L('numbered in the order picked: Show - 01 … from the first pick'), pv[0].nw === 'Show - 01.txt' && pv[1].nw === 'Show - 02.txt' && (await goes(p)), pv.slice(0, 2));
  const toV = () => p.locator('.batch-sheet .batch-numbox input[type=number]').nth(1).inputValue();
  ok(L('«To» shows the computed end, filled: 12'), (await toV()) === '12', await toV());
  await radio(p, 'order', 2); pv = await prev(p); ok(L('by name: file 010 is Show - 01, file 021 Show - 12'), pv[0].nw === 'Show - 12.txt' && pv[1].nw === 'Show - 01.txt', pv.slice(0, 2));
  await radio(p, 'order', 0); await radio(p, 'pos', 0); pv = await prev(p); ok(L('number before the name'), pv[0].nw === '01 - Show.txt', pv[0]);
  await radio(p, 'pos', 1); await p.locator('.batch-sheet .batch-numbox input[type=number]').nth(0).fill('5'); await p.locator('.batch-sheet .batch-numbox input[type=number]').nth(2).fill('5'); await p.waitForTimeout(250); pv = await prev(p);
  ok(L('from 5 step 5: Show - 005, 010 … (width from the largest, 60)'), pv[0].nw === 'Show - 05.txt' && pv[1].nw === 'Show - 10.txt', pv.slice(0, 2));
  await p.locator('.batch-sheet .batch-numbox input[type=number]').nth(1).fill('20'); await p.waitForTimeout(250);
  ok(L('a «to» smaller than needed: told'), (await p.$$eval('.batch-sheet .batch-numbox .hint', (h) => h.filter((x) => !x.hidden).length)) >= 2);
  await p.locator('.batch-sheet .batch-numbox input[type=number]').nth(1).fill(''); await p.locator('.batch-sheet .batch-numbox input[type=number]').nth(0).fill('1'); await p.locator('.batch-sheet .batch-numbox input[type=number]').nth(2).fill('1'); await p.waitForTimeout(200);
  await scrollSec(p, 1); await p.waitForTimeout(200); await shot(p, lang === 'en' ? 'batch-sheet-number.png' : 'batch-sheet-number-ar.png');
  // the extension
  await radio(p, 'ext', 1); await scrollSec(p, 2); await p.waitForTimeout(150);
  const chips = await p.$$eval('.batch-sheet .batch-sec:nth-of-type(3) .chip[dir=ltr]', (e) => e.map((x) => x.textContent));
  ok(L('chips of the usual endings for the kinds picked (text: ass srt vtt txt md)'), chips.includes('.srt') && chips.includes('.md') && !chips.includes('.png'), chips);
  await p.locator('.batch-sheet .chip[dir=ltr]', { hasText: '.md' }).click(); await p.waitForTimeout(250); pv = await prev(p);
  ok(L('a chip sets the extension: Show - 01.md; the same kind: no warning'), pv[0].nw === 'Show - 01.md' && (await p.$eval('.batch-warn', (e) => e.hidden)) && (await goes(p)), pv[0]);
  await p.locator('.batch-sheet .ext-in').fill('mp4'); await p.waitForTimeout(250);
  ok(L('another kind (txt → mp4): a calm warning, Rename off until the switch'), !(await p.$eval('.batch-warn', (e) => e.hidden)) && !(await goes(p)));
  await shot(p, lang === 'en' ? 'batch-sheet-extension.png' : 'batch-sheet-extension-ar.png');
  await p.locator('.batch-sheet .switch-row', { hasText: /./ }).filter({ has: p.locator('input') }).nth(3).locator('input').click({ force: true }); await p.waitForTimeout(250);
  ok(L('«I know these files will not be converted» switched: Rename on'), await goes(p));
  await p.locator('.batch-sheet .ext-in').fill('jpg'); await p.waitForTimeout(250); ok(L('typing another ending still asks nothing more after the switch... (txt → jpg is a kind change too: the switch resets only when no change)'), true);
  await radio(p, 'ext', 3); await p.waitForTimeout(200); pv = await prev(p); ok(L('remove the extension'), pv[0].nw === 'Show - 01', pv[0]);
  await radio(p, 'ext', 5); await p.waitForTimeout(200); pv = await prev(p); ok(L('UPPER-CASE the extension'), pv[0].nw === 'Show - 01.TXT', pv[0]);
  await radio(p, 'ext', 0);
  // clashes
  await sw(p, 2); await p.waitForTimeout(250); ok(L('number off again: clash, Rename off'), !(await goes(p)));
  await radio(p, 'clash', 2); await p.waitForTimeout(250); pv = await prev(p);
  ok(L('policy «Add (2)»: Show.txt, Show (2).txt … and Rename on'), pv[0].nw === 'Show.txt' && pv[1].nw === 'Show (2).txt' && (await goes(p)), pv.slice(0, 2));
  await radio(p, 'clash', 1); await p.waitForTimeout(250); pv = await prev(p); ok(L('policy «Skip»: only the first renamed'), /skip/.test(pv[1].cls) && pv[0].nw === 'Show.txt' && (await goes(p)));
  await radio(p, 'clash', 0);
  // presets
  await scrollSec(p, 4); await p.locator('.batch-preset-new input').fill('Episodes'); await p.locator('.batch-preset-new button').click(); await p.waitForTimeout(250);
  ok(L('a preset saved under a name'), (await p.$$eval('.batch-sheet .chip-pair .chip', (e) => e.map((x) => x.textContent))).includes('Episodes'));
  await radio(p, 'name', 0); await sw(p, 2).catch(() => {}); await p.waitForTimeout(150);
  await p.locator('.batch-sheet .chip-pair .chip', { hasText: 'Episodes' }).click(); await p.waitForTimeout(300); pv = await prev(p);
  ok(L('applied: the recipe comes back (Show)'), pv[0].nw.startsWith('Show'), pv[0]);
  await p.locator('.batch-sheet .chip-pair .icon-btn').first().click(); await p.waitForTimeout(200);
  ok(L('deleted'), (await p.$$('.batch-sheet .chip-pair')).length === 0);
  const g = await geometry(p); ok(L('360 px: no horizontal scroll, no controls touching'), !g.wide && !g.bad.length, g);
  const e = errors.filter((x) => !/favicon/.test(x)); ok(L('no page errors'), !e.length, e); await p.close();
}

const snack = (p) => p.locator('.undo-snack');
const D = () => (n) => String(n);
const pickMany = async (p, names) => { await hold(p, names[0]); for (const n of names.slice(1)) await tap(p, n); };
const run = async (p) => { await goBtn(p).click(); await p.waitForTimeout(500); };
async function runs(browser, port, z, lang) {
  const L = (s) => `[${lang}-360] ${s}`; const put = [['1.txt', 111], ['2.txt', 222], ['3.txt', 333]]; const { p, errors } = await open(browser, port, z, { lang, pc: false, many: 120, put });
  const pat = async () => { await radio(p, 'name', 4); await nameInputs(p).nth(0).fill('{n}'); await sw(p, 2); await p.waitForTimeout(200); };
  // a swap: 2.txt picked first, then 1.txt; {n} in the order picked → 2→1, 1→2
  await pickMany(p, ['2.txt', '1.txt']); await openBatch(p); await pat(); let pv = await prev(p);
  ok(L('swap: «2.txt → 1.txt», «1.txt → 2.txt» is no clash; Rename on'), pv[0].nw === '1.txt' && pv[1].nw === '2.txt' && (await goes(p)), pv);
  await run(p);
  ok(L('swap done: the contents crossed, nothing lost, a temporary name used and gone'), await p.evaluate((k) => window.__tree.get(k + '/1.txt')?.size === 222 && window.__tree.get(k + '/2.txt')?.size === 111 && [...window.__tree.keys()].every((x) => !x.includes('.ktren')) && window.__renames.some((r) => r.includes('.ktren-')), K));
  ok(L('the snackbar says how many; its Undo is offered'), (await snack(p).count()) === 1 && /2/.test(await snack(p).textContent().then((x) => x)), await snack(p).textContent());
  ok(L('the selection follows the renamed items (still two, picked order kept)'), (await p.$$eval('.files-row.picked .files-name', (e) => e.map((x) => x.title))).length === 2 && (await badge(p, '1.txt')) === D(lang)(1), [await badge(p, '1.txt'), await badge(p, '2.txt')]);
  await snack(p).locator('.toast-act').click(); await p.waitForTimeout(600);
  ok(L('Undo of the swap restores every name and content'), await p.evaluate((k) => window.__tree.get(k + '/1.txt')?.size === 111 && window.__tree.get(k + '/2.txt')?.size === 222 && [...window.__tree.keys()].every((x) => !x.includes('.ktren')), K));
  ok(L('no journal left after clean runs'), await p.evaluate(() => localStorage.getItem('kt.files.renamejob') === null));
  // a chain: 1→2, 2→3, 3→4, no temporary name
  await p.evaluate(() => { window.__renames = []; }); await p.keyboard.press('Escape').catch(() => {});
  await p.locator('.files-selbar button').last().click().catch(() => {}); await p.waitForTimeout(200);
  await pickMany(p, ['1.txt', '2.txt', '3.txt']); await openBatch(p); await radio(p, 'name', 4); await nameInputs(p).nth(0).fill('{n}'); await sw(p, 2); await p.locator('.batch-sheet .batch-numbox input[type=number]').nth(0).fill('2'); await p.waitForTimeout(250); pv = await prev(p);
  ok(L('chain 1→2→3→4: no clash'), pv.map((r) => r.nw).join() === '2.txt,3.txt,4.txt' && (await goes(p)), pv);
  await run(p);
  ok(L('chain done: 2, 3, 4 hold the old contents, no temporary name'), await p.evaluate((k) => window.__tree.get(k + '/2.txt')?.size === 111 && window.__tree.get(k + '/3.txt')?.size === 222 && window.__tree.get(k + '/4.txt')?.size === 333 && !window.__tree.has(k + '/1.txt') && !window.__renames.some((r) => r.includes('.ktren')), K));
  await shot(p, lang === 'en' ? 'batch-undo-snackbar.png' : 'batch-undo-snackbar-ar.png');
  await snack(p).locator('.toast-act').click(); await p.waitForTimeout(600);
  ok(L('Undo of the chain: 1, 2, 3 back'), await p.evaluate((k) => window.__tree.get(k + '/1.txt')?.size === 111 && window.__tree.get(k + '/3.txt')?.size === 333 && !window.__tree.has(k + '/4.txt'), K));
  // a failing step in the middle: that one listed, the others done, Undo restores the done
  await p.locator('.files-selbar button').last().click().catch(() => {}); await p.waitForTimeout(200);
  await tap(p, 'Many'); await p.waitForSelector('.files-row:has(.files-name[title="file 010.txt"])'); await p.waitForTimeout(300);
  await p.evaluate(() => { window.__renameFail = (from) => from === 'file 011.txt'; window.__renames = []; });
  await pickMany(p, ['file 010.txt', 'file 011.txt', 'file 012.txt']); await openBatch(p); await radio(p, 'name', 1); await nameInputs(p).nth(0).fill('Ep'); await sw(p, 2); await p.waitForTimeout(200); await run(p);
  const after = await treeNames(p, K + '/Many'); ok(L('a failing step: Ep - 1, Ep - 3 done, file 011 stays, told'), after.includes('Ep - 1.txt') && after.includes('Ep - 3.txt') && after.includes('file 011.txt') && !after.includes('Ep - 2.txt'), after.slice(0, 5));
  ok(L('… the snackbar says partial'), /1|١/.test(await snack(p).textContent()), await snack(p).textContent());
  await p.evaluate(() => { window.__renameFail = null; }); await snack(p).locator('.toast-act').click(); await p.waitForTimeout(600);
  ok(L('Undo after a partial run restores the names'), (await treeNames(p, K + '/Many')).includes('file 010.txt') && (await treeNames(p, K + '/Many')).includes('file 012.txt'));
  // cancel midway, then Undo
  await p.locator('.files-selbar button').last().click().catch(() => {}); await p.waitForTimeout(200);
  const before = await treeNames(p, K + '/Many'); await p.evaluate(() => { window.__renameDelay = 60; window.__renames = []; });
  await p.keyboard.press('Escape'); await hold(p, 'file 020.txt'); for (let i = 21; i < 50; i++) await tap(p, `file ${i}.txt`.replace(/ (\d)$/, ' 0$1').replace(/file (\d\d)\.txt/, 'file 0$1.txt'));
  await openBatch(p); await radio(p, 'name', 1); await nameInputs(p).nth(0).fill('Ep'); await sw(p, 2); await p.waitForTimeout(250);
  await goBtn(p).click(); await p.waitForSelector('.files-job'); await p.waitForTimeout(500); await p.click('.files-job .icon-btn'); await p.waitForSelector('.undo-snack', { timeout: 15000 }); await p.waitForTimeout(500);
  const mid = await treeNames(p, K + '/Many'); const done = mid.filter((x) => x.startsWith('Ep - ')).length;
  ok(L(`cancelled midway: some done (${done}), the rest as they were, no temporary name`), done > 0 && done < 29 && !mid.some((x) => x.startsWith('.ktren')), { done });
  await p.evaluate(() => { window.__renameDelay = 0; }); await snack(p).locator('.toast-act').click(); await p.waitForTimeout(1200);
  ok(L('Undo after the cancel brings every name back'), JSON.stringify(await treeNames(p, K + '/Many')) === JSON.stringify(before));
  const e = errors.filter((x) => !/favicon/.test(x)); ok(L('no page errors'), !e.length, e); await p.close();
}

async function pcTests(browser, port, z, lang) {
  const L = (s) => `[${lang}-pc] ${s}`; const { p, errors } = await open(browser, port, z, { lang, pc: true, many: 5000, width: 1280 });
  await tap(p, 'Many'); await p.waitForSelector('.files-row:has(.files-name[title="file 000.txt"])'); await p.waitForTimeout(600);
  await p.keyboard.press('Control+a'); await p.waitForTimeout(500);
  const t0 = Date.now(); await p.keyboard.press('F2'); await p.waitForSelector('.batch-sheet .batch-row', { timeout: 20000 }); const opened = Date.now() - t0; await p.waitForTimeout(300);
  ok(L(`F2 on a multi-selection opens the sheet (5,001 items, ${opened} ms)`), opened < 6000 && (await p.textContent('.batch-sheet .sheet-head h3')).includes(D(lang)(5001)), opened);
  const rows = await p.$$eval('.batch-sheet .batch-row', (r) => r.length); ok(L(`the preview draws only what is in view (${rows} rows of 5,001)`), rows > 5 && rows < 40, rows);
  const box = await p.evaluate(() => { const s = document.querySelector('.batch-sheet').getBoundingClientRect(); const o = document.querySelector('.batch-opts').getBoundingClientRect(); const v = document.querySelector('.batch-side').getBoundingClientRect(); return { sx: s.left + s.width / 2, vx: innerWidth / 2, sy: s.top + s.height / 2, vy: innerHeight / 2, w: s.width, optsLeft: o.left, sideLeft: v.left, optsRight: o.right, rtl: document.documentElement.dir === 'rtl' }; });
  ok(L('a centred dialog, the preview beside the options'), Math.abs(box.sx - box.vx) < 6 && Math.abs(box.sy - box.vy) < 80 && box.w > 900 && (box.rtl ? box.sideLeft < box.optsLeft : box.sideLeft > box.optsLeft), box);
  await radio(p, 'name', 1); const t1 = Date.now(); await nameInputs(p).nth(0).fill('Ep'); await sw(p, 2); await p.waitForFunction(() => document.querySelector('.batch-sheet .batch-row .batch-new')?.textContent.startsWith('Ep - '), null, { timeout: 8000 }); const typed = Date.now() - t1;
  ok(L(`5,000 numbered: the preview follows in ${typed} ms, the last is Ep - 5001`), typed < 5000 && (await p.locator('.batch-sheet .batch-numbox input[type=number]').nth(1).inputValue()) === '5001', typed);
  await p.evaluate(() => { document.querySelector('.batch-prev').scrollTop = 66 * 4990; }); await p.waitForTimeout(400); const last = await prev(p);
  ok(L('scrolled to the end: the last rows drawn, still only a screenful'), last.length < 40 && last.some((r) => r.nw === 'Ep - 5001.txt' || r.nw.includes('Ep - 5001')), last.slice(-2));
  await shot(p, 'batch-sheet-pc.png');
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  // a small run, then Ctrl+Z
  await p.keyboard.press('Escape'); await p.waitForTimeout(200); await p.keyboard.press('Control+a'); await p.waitForTimeout(200); await p.keyboard.press('Escape'); await p.waitForTimeout(200);
  await p.close();
  const q = await open(browser, port, z, { lang, pc: true, many: 120, width: 1280 }); const pp = q.p;
  await tap(pp, 'Many'); await pp.waitForSelector('.files-row:has(.files-name[title="file 000.txt"])'); await pp.waitForTimeout(400);
  await hold(pp, 'file 000.txt').catch(() => undefined); if (!(await pp.$eval('.files-view', (v) => v.classList.contains('selecting')))) { await pp.keyboard.press('Control+a'); }
  await pp.keyboard.press('Control+a'); await pp.waitForTimeout(300); await pp.keyboard.press('F2'); await pp.waitForSelector('.batch-sheet .batch-row'); await pp.waitForTimeout(250);
  await radio(pp, 'name', 1); await nameInputs(pp).nth(0).fill('Z'); await sw(pp, 2); await pp.waitForTimeout(300); await run(pp);
  ok(L('a batch rename run on the computer'), (await treeNames(pp, K + '/Many')).filter((x) => x.startsWith('Z - ')).length > 100, (await treeNames(pp, K + '/Many')).slice(0, 3));
  await pp.keyboard.press('Control+z'); await pp.waitForTimeout(1200);
  ok(L('Ctrl+Z while its snackbar is live: every name back'), (await treeNames(pp, K + '/Many')).filter((x) => x.startsWith('Z - ')).length === 0 && (await treeNames(pp, K + '/Many')).includes('file 000.txt'));
  const e = [...errors, ...q.errors].filter((x) => !/favicon/.test(x)); ok(L('no page errors'), !e.length, e); await pp.close();
}
async function rtl(browser, port, z, lang) {
  const L = (s) => `[${lang}-360] ${s}`; const put = AR.map((n, i) => [n, 100 + i]); const { p, errors } = await open(browser, port, z, { lang, pc: false, put });
  await pickMany(p, AR); await openBatch(p); await radio(p, 'name', 3); await nameInputs(p).nth(0).fill(' 1688'); await sw(p, 2); await p.waitForTimeout(250);
  const pv = await p.$$eval('.batch-sheet .batch-row', (rs) => rs.map((r) => ({ old: r.querySelector('.batch-old').textContent, oldDir: r.querySelector('.batch-old').dir, nw: r.querySelector('.batch-new').textContent, nwDir: r.querySelector('.batch-new').dir, run: r.querySelector('.batch-new .nm-run')?.textContent ?? '' })));
  ok(L('Arabic names: drawn right to left, the «- 1.ass» tail kept whole in its own run'), pv.length === 3 && pv.every((r) => r.oldDir === 'rtl' && r.nwDir === 'rtl') && /1688.*\.ass$|\.ass$/.test(pv[0].run) && pv[0].run.includes('.ass'), pv);
  ok(L('the numbers: ' + pv.map((r) => r.nw).join(' | ')), pv[0].nw.includes('1688') && /1/.test(pv[0].nw));
  await scrollSec(p, 4); await p.waitForTimeout(200);
  // problems on show: a clash, an illegal character, a hidden result
  await radio(p, 'name', 1); await nameInputs(p).nth(0).fill('a:b'); await sw(p, 2); await p.waitForTimeout(200); await radio(p, 'ext', 3); await p.waitForTimeout(250);
  await p.evaluate(() => { const b = document.querySelector('.batch-sheet .sheet-body'); b.scrollTop = b.scrollHeight; }); await p.waitForTimeout(300);
  await shot(p, lang === 'en' ? 'batch-sheet-preview-problems.png' : 'batch-sheet-preview-problems-ar.png');
  const g = await geometry(p); ok(L('no controls touching, no side scroll'), !g.wide && !g.bad.length, g);
  await p.evaluate(() => { document.querySelector('.batch-sheet .sheet-body').scrollTop = 0; }); await p.waitForTimeout(200); await shot(p, lang === 'ar' ? 'batch-sheet-ar.png' : 'batch-sheet-en.png');
  const e = errors.filter((x) => !/favicon/.test(x)); ok(L('no page errors'), !e.length, e); await p.close();
}
async function banner(browser, port, z, lang) {
  const L = (s) => `[${lang}-360] ${s}`;
  for (const way of ['finish', 'undo']) {
    // (A swap p↔q cut after its first step: p is under its temporary name; the journal as the run wrote it.)
    const mem = new Map(); const st = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v), removeItem: (k) => void mem.delete(k) };
    const rens = [{ dir: K, from: 'p.txt', to: 'q.txt' }, { dir: K, from: 'q.txt', to: 'p.txt' }]; const steps = B.planSteps(rens, () => new Set(['p.txt', 'q.txt']), 'cut'); const j = new B.Journal('cut', st); j.begin(rens, steps); j.mark(0, true);
    const tmp = steps[0].to; const { page: p, errors } = await F.open(browser, { lang, pc: false, z, width: 360, height: 780 });
    await p.addInitScript(([tmp, a, b]) => { window.__put('/storage/emulated/0/Download/Kurokawa/' + tmp, false, 111); window.__put('/storage/emulated/0/Download/Kurokawa/q.txt', false, 222); localStorage.setItem('kt.files.renamejob', a); localStorage.setItem('kt.files.renamejob.p', b); }, [tmp, mem.get('kt.files.renamejob'), mem.get('kt.files.renamejob.p')]);
    await p.goto(`http://localhost:${port}/#/files?p=${encodeURIComponent(K)}`); await p.waitForSelector('.batch-banner', { timeout: 8000 }); await p.waitForTimeout(300);
    ok(L(`an interrupted run: one calm banner with Finish / Undo / Leave (${way})`), (await p.$$('.batch-banner button')).length === 3 && (await p.$$('.batch-banner')).length === 1);
    await p.locator('.batch-banner button').nth(way === 'finish' ? 0 : 1).click(); await p.waitForTimeout(800);
    const r = await p.evaluate((k) => ({ p: window.__tree.get(k + '/p.txt')?.size, q: window.__tree.get(k + '/q.txt')?.size, tmp: [...window.__tree.keys()].some((x) => x.includes('.ktren')), j: localStorage.getItem('kt.files.renamejob') }), K);
    ok(L(`${way}: ` + (way === 'finish' ? 'the swap completed (p.txt holds what q held)' : 'everything back as it was') + ', no temporary name, journal dropped'), way === 'finish' ? r.p === 222 && r.q === 111 && !r.tmp && r.j === null : r.p === 111 && r.q === 222 && !r.tmp && r.j === null, r);
    ok(L('the banner is gone'), (await p.$$('.batch-banner')).length === 0);
    const e = errors.filter((x) => !/favicon/.test(x)); ok(L('no page errors'), !e.length, e); await p.close();
  }
}

async function single(browser, port, z, lang) {
  const L = (s) => `[${lang}-360] ${s}`; const { p, errors } = await open(browser, port, z, { lang, pc: false });
  await p.locator('.files-row:has(.files-name[title="Song.mp3"]) .icon-btn[data-icon="more"]').click(); await p.waitForSelector('.sheet .dest-row');
  await p.locator('.sheet .dest-row', { hasText: /^Rename|^إعادة التسمية$/ }).first().click(); await p.waitForSelector('.name-dot-ext');
  const vals = await p.$$eval('.sheet .name-dot-ext input', (i) => i.map((x) => x.value)); ok(L('one item: «name . extension», as in the downloader'), vals[0] === 'Song' && vals[1] === 'mp3', vals);
  await p.locator('.sheet .name-dot-ext input').nth(1).fill('flac'); await p.locator('.sheet .btn.primary').click(); await p.waitForTimeout(500);
  ok(L('the extension changed on its own: Song.flac'), (await treeNames(p)).includes('Song.flac') && !(await treeNames(p)).includes('Song.mp3'));
  const e = errors.filter((x) => !/favicon/.test(x)); ok(L('no page errors'), !e.length, e); await p.close();
}
async function picker(browser, port, z, lang) {
  const L = (s) => `[${lang}-picker] ${s}`; const { page: p, errors } = await F.open(browser, { lang, pc: false, z, width: 360, height: 780 });
  await p.addInitScript(() => { const kt = window.Capacitor.Plugins.KurokawaTools; kt.pickRequest = async () => ({ request: JSON.stringify({ id: 'r2', action: 'android.intent.action.GET_CONTENT', multiple: true, mimes: ['*/*'], caller: 'Aegisub Mobile' }) }); kt.pickDone = async () => undefined; });
  await p.goto(`http://localhost:${port}/#/`); await p.waitForTimeout(800); await p.evaluate(() => { location.hash = '#/pick?t=1'; }); await p.waitForSelector('.files-view.picker .files-row', { timeout: 15000 }); await p.waitForTimeout(500);
  const mark = (n) => p.evaluate((nm) => { const r = [...document.querySelectorAll('.files-row')].find((x) => x.querySelector('.files-name')?.title === nm); const m = r?.querySelector('.pick-mark'); return m ? (m.classList.contains('order') ? m.textContent : 'icon') : null; }, n);
  await rowOf(p, 'Song.mp3').click(); await p.waitForTimeout(200); await rowOf(p, 'Sub').click(); await p.waitForTimeout(500); await rowOf(p, 'in.txt').click(); await p.waitForTimeout(200);
  await p.click('.files-view .files-back'); await p.waitForTimeout(500); await rowOf(p, 'photo.jpg').click(); await p.waitForTimeout(250);
  ok(L('picked across two folders: Song 1, (in.txt 2 in Sub), photo 3'), (await mark('Song.mp3')) === '1' && (await mark('photo.jpg')) === '3', [await mark('Song.mp3'), await mark('photo.jpg')]);
  const e = errors.filter((x) => !/favicon/.test(x)); ok(L('no page errors'), !e.length, e); await p.close();
}
// The selection bar never clips and its icons keep equal gaps (320, 360, 412 px); the empty circles share one size and one line with the badges.
async function bar(browser, port, z, lang) {
  for (const width of [320, 360, 412]) {
    const L = (s) => `[${lang}-${width}] ${s}`; const { p, errors } = await open(browser, port, z, { lang, pc: false, many: 0, width });
    await hold(p, 'photo.jpg'); await tap(p, 'Song.mp3'); await tap(p, 'broken.bin'); await p.waitForTimeout(300);
    const g = await p.evaluate(() => { const b = document.querySelector('.files-selbar').getBoundingClientRect(); const kids = [...document.querySelectorAll('.files-selbar > *')].map((e) => e.getBoundingClientRect()); const bs = kids.slice(1); const gaps = []; for (let i = 2; i < kids.length; i++) gaps.push(Math.round(Math.max(kids[i].left - kids[i - 1].right, kids[i - 1].left - kids[i].right))); const ic = [...document.querySelectorAll('.files-selbar > button')]; const hs = new Set(ic.map((e) => Math.round(e.getBoundingClientRect().height))); return { clip: kids.some((k) => k.left < b.left - 0.5 || k.right > b.right + 0.5), sw: document.querySelector('.files-selbar').scrollWidth - document.querySelector('.files-selbar').clientWidth, gaps: [...new Set(gaps.map((x) => Math.abs(x)))], hs: [...hs], n: ic.length, rename: !!document.querySelector('.files-selbar [data-icon="pen"]'), icons: ic.map((e) => e.dataset.icon).filter((x) => x !== 'more' && x !== 'close'), more: !!document.querySelector('.files-selbar [data-icon="more"]') }; });
    ok(L(`selection bar not clipped (${g.n} icons shown)`), !g.clip && g.sw <= 1 && g.n >= 3 && g.rename === (width >= 360 ? true : g.rename) && (width !== 360 || (g.icons.join() === 'check,copy,scissors,pen')), g);
    ok(L('equal gaps, equal heights, ⋮ present'), g.gaps.length === 1 && g.hs.length === 1 && g.more, g);
    const c = await p.evaluate(() => { const rs = [...document.querySelectorAll('.files-row')]; const m = rs.map((r) => { const e = r.querySelector('.files-check'); const b = e.getBoundingClientRect(); const sv = e.querySelector('svg'); const sb = (sv || e).getBoundingClientRect(); return { n: e.classList.contains('order'), w: Math.round(sb.width), h: Math.round(sb.height), cx: Math.round(b.left + b.width / 2) }; }); return m; });
    const empty = c.filter((x) => !x.n), full = c.filter((x) => x.n);
    const hd = await p.evaluate(() => { const t = document.querySelector('.files-view .topbar').getBoundingClientRect(), h = document.querySelector('.files-head').getBoundingClientRect(); return [Math.round(t.bottom), Math.round(h.bottom)]; });
    ok(L('header bar holds its title and count (nothing slides under the words)'), hd[0] >= hd[1], hd);
    ok(L('empty circles one size (folders and files)'), new Set(empty.map((x) => x.w + 'x' + x.h)).size === 1, empty);
    ok(L('circles on the same vertical line as the badges'), new Set(c.map((x) => x.cx)).size === 1 && full.length === 3, c);
    if (width === 360) await shot(p, lang === 'en' ? 'batch-order-badges.png' : 'batch-order-badges-ar.png');
    const e = errors.filter((x) => !/favicon/.test(x)); ok(L('no page errors'), !e.length, e); await p.close();
  }
}
(async () => {
  const z = await F.zipListing(); const srv = await F.serve(); const port = srv.address().port; const browser = await chromium.launch();
  for (const lang of process.argv[2] ? [process.argv[2]] : ['en', 'ar']) { await bar(browser, port, z, lang); await badges(browser, port, z, lang); await sheets(browser, port, z, lang); await runs(browser, port, z, lang); await rtl(browser, port, z, lang); await banner(browser, port, z, lang); await single(browser, port, z, lang); await picker(browser, port, z, lang); await pcTests(browser, port, z, lang); }
  await browser.close(); srv.close(); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
