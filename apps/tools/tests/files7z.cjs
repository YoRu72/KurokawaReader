// 7z creation on a computer: the Compress sheet (PC layout, 1280x800) with the shells' bridge pretended; English and Arabic.
// (The shells' own 7z code: tests/archive7z.cjs, and the Rust side's pure parts in desktop-tauri/src-tauri/src/sevenparse.rs.)
// Run: NODE_PATH=$(npm root -g) node tests/files7z.cjs [en|ar]
const { chromium } = require('playwright'); const path = require('node:path');
const { page, rowOf, menu, pasteTo, F, K, SD, P } = require('./filesextras-lib.cjs');
let fails = 0; const ok = (what, cond, x) => { console.log((cond ? 'ok   ' : 'FAIL ') + what + (cond || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 300))); if (!cond) fails++; };
const shot = (p, name) => (process.env.KT_SHOTS ? p.screenshot({ path: path.join(process.env.KT_SHOTS, name) }) : null);
const langs = process.argv[2] === 'ar' ? ['ar'] : process.argv[2] === 'en' ? ['en'] : ['en', 'ar'];
// ---- 7z on a computer: the compress sheet offers 7Z with a level and an optional password, and says what the password locks
async function sevenz(browser, port, z, lang) {
  const L = (s) => `[${lang}-7z] ${s}`; const ar = lang === 'ar'; const sfx = ar ? '-ar' : '';
  const { p, errors } = await page(browser, port, z, lang, { pc: true, seed: (k) => { window.__put(k + '/Docs', true); window.__put(k + '/Docs/report.txt', false, 3000); window.__put(k + '/Docs/notes.txt', false, 1200); },
    at: K + '/Docs' });
  // (The pretend computer's archive bridge: only what the compress sheet calls.)
  await p.addInitScript(() => { window.__mk = []; window.kurokawaTools = { archiveList: async () => ({ entries: [] }), archiveExtract: async () => ({}), archiveCancel: async () => undefined, onArchiveProgress: () => () => undefined, pickFile: async () => [], pathInfo: async () => ({ exists: false }),
    pathInfo: async (q) => ({ exists: (window.__exists || []).includes(q) }), archiveCreate: async (o) => { window.__mk.push(o); if (window.__fail) throw new Error(window.__fail); return { files: o.inputs.length, path: o.out, size: 10 }; } }; });
  await p.reload(); await p.waitForSelector('.files-row'); await p.waitForTimeout(400);
  const pickOne = async (label, option) => { await p.locator('.sheet button.pick, .sheet .chip-row button').filter({ hasText: label }).first().click(); await p.waitForTimeout(200); await p.locator('.sheet button, .sheet .dest-row').filter({ hasText: option }).last().click(); await p.waitForTimeout(200); };
  await menu(p, 'report.txt'); await p.locator('.sheet button', { hasText: /^\s*(Compress|ضغط)/ }).first().click(); await p.waitForTimeout(400);
  const txt = () => p.evaluate(() => document.querySelector('.sheet')?.textContent ?? '');
  const shown = (sel) => p.evaluate((q) => [...document.querySelectorAll(q)].some((e) => e.offsetParent !== null), '.sheet ' + sel);
  const sheet1 = await txt();
  ok(L('the sheet offers ZIP and 7Z only (no tar, no volumes, no comment, no delete-after)'), /ZIP/.test(sheet1) && !/TAR/.test(sheet1) && !(await shown('.check-row')), sheet1.slice(0, 200));
  ok(L('ZIP: no password field and a line saying a computer\'s ZIP has no password'), !(await shown('input[type=password]')) && (await p.locator('.sheet .hint').filter({ hasText: ar ? 'على الحاسوب بكلمة' : 'has no password' }).count()) === 1, sheet1.slice(0, 300));
  await shot(p, 'extras-7z-zip-pc' + sfx + '.png');
  // choose 7Z
  await p.locator('.sheet .pick-btn').first().click(); await p.waitForTimeout(250);
  await p.locator('.sheet button, .sheet .dest-row').filter({ hasText: /^\s*7Z\s*$/ }).last().click(); await p.waitForTimeout(300);
  ok(L('7Z: the level and the password appear, with the note on what is locked'), (await shown('input[type=password]')) && (await shown('.files-7z-note')) && (await p.locator('.sheet .pick-btn').count()) === 2 && (await p.locator('.sheet .field > span').allTextContents()).length >= 4, (await txt()).slice(0, 300));
  const note = await p.locator('.files-7z-note').textContent();
  ok(L('the note says the file names are locked as well'), ar ? /أسماء ملفاته/.test(note) : /file names/.test(note), note);
  await p.fill('.sheet input[type=password]', 'sesame');
  // level: Best
  await p.locator('.sheet .pick-btn').nth(1).click(); await p.waitForTimeout(250);
  const opts = await p.locator('.sheet .dest-row, .sheet .sheet button').allTextContents().catch(() => []);
  await p.locator('.sheet button, .sheet .dest-row').filter({ hasText: ar ? 'الأفضل' : 'Best' }).last().click(); await p.waitForTimeout(300);
  await shot(p, 'extras-7z-pc' + sfx + '.png');
  // geometry: nothing overlaps, nothing is cut off to the side, the footer does not cover the last row
  const geo = await p.evaluate(() => { const sh = document.querySelector('.sheet'); const r = sh.getBoundingClientRect(); const kids = [...sh.querySelectorAll('.field, .chip-row, .hint, .chip-row button')].filter((e) => e.offsetParent !== null).map((e) => e.getBoundingClientRect()); const gaps = [...sh.querySelectorAll('.field')].filter((e) => e.offsetParent !== null).map((e) => e.getBoundingClientRect()); const gp = gaps.slice(1).map((r, i) => Math.round(r.top - gaps[i].bottom)); const bad = []; for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) { const a = kids[i], b = kids[j]; if (a.width && b.width && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1 && !(a.left <= b.left && a.right >= b.right && a.top <= b.top && a.bottom >= b.bottom) && !(b.left <= a.left && b.right >= a.right && b.top <= a.top && b.bottom >= a.bottom)) bad.push([i, j]); } return { bad, gp, over: sh.scrollWidth > sh.clientWidth + 1, w: r.width }; });
  ok(L('the sheet: no overlapping controls, no sideways overflow'), !geo.bad.length && !geo.over, geo);
  ok(L('the four fields are labelled and equally spaced (gaps ' + geo.gp.join(',') + ')'), geo.gp.length === 3 && Math.max(...geo.gp) - Math.min(...geo.gp) <= 2 && Math.min(...geo.gp) >= 6, geo.gp);
  await p.locator('.sheet button.primary').click(); await p.waitForTimeout(500);
  const mk = await p.evaluate(() => window.__mk);
  ok(L('Compress sends the 7z request: format, Best (9) and the password'), mk.length === 1 && mk[0].format === '7z' && mk[0].level === 9 && mk[0].password === 'sesame' && /\.7z$/.test(mk[0].out), mk);
  // a zip afterwards sends no 7z options and no password even if one was typed before
  await p.evaluate(() => { window.__mk = []; });
  await menu(p, 'notes.txt'); await p.locator('.sheet button', { hasText: /^\s*(Compress|ضغط)/ }).first().click(); await p.waitForTimeout(300);
  await p.locator('.sheet button.primary').click(); await p.waitForTimeout(500);
  const mk2 = await p.evaluate(() => window.__mk);
  ok(L('ZIP on the computer: no format key, no password'), mk2.length === 1 && !('format' in mk2[0]) && !('password' in mk2[0]) && /\.zip$/.test(mk2[0].out), mk2);
  // ---- a name that is taken: asked as everywhere else (keep both / replace / cancel); the same for ZIP; nothing replaced silently
  const compress = async (name, seven) => { await menu(p, name); await p.locator('.sheet button', { hasText: /^\s*(Compress|ضغط)/ }).first().click(); await p.waitForTimeout(350);
    if (seven) { await p.locator('.sheet .pick-btn').first().click(); await p.waitForTimeout(250); await p.locator('.sheet button, .sheet .dest-row').filter({ hasText: /^\s*7Z\s*$/ }).last().click(); await p.waitForTimeout(300); }
    const target = await p.evaluate(() => document.querySelector('.sheet input[type=text], .sheet input:not([type])')?.value ?? ''); await p.locator('.sheet button.primary').click(); await p.waitForTimeout(500); return target; };
  for (const fmt of ['7z', 'zip']) {
    await p.evaluate(() => { window.__mk = []; window.__exists = []; });
    await compress('report.txt', fmt === '7z'); const first = (await p.evaluate(() => window.__mk))[0]; ok(L(`${fmt}: a free name goes straight through, no question`), !!first && !(await p.locator('.files-clash-both').count()), first);
    await p.evaluate((o) => { window.__mk = []; window.__exists = [o]; }, first.out);
    await compress('report.txt', fmt === '7z'); await p.waitForSelector('.files-clash-both', { timeout: 3000 });
    ok(L(`${fmt}: the name is taken: asked (keep both / replace / cancel), nothing sent yet`), (await p.locator('.files-clash-replace').count()) === 1 && (await p.evaluate(() => window.__mk.length)) === 0);
    if (fmt === '7z') await shot(p, 'extras-7z-clash-pc' + sfx + '.png');
    await p.keyboard.press('Escape'); await p.waitForTimeout(400);
    ok(L(`${fmt}: cancel (closing the question): nothing is made`), (await p.evaluate(() => window.__mk.length)) === 0);
    await compress('report.txt', fmt === '7z'); await p.waitForSelector('.files-clash-both'); await p.locator('.files-clash-both').click(); await p.waitForTimeout(500);
    let mk3 = await p.evaluate(() => window.__mk); ok(L(`${fmt}: keep both: a new name ("… (2)"), the old one untouched, no replace flag`), mk3.length === 1 && mk3[0].out !== first.out && /\(2\)\.(7z|zip)$/.test(mk3[0].out) && !mk3[0].replace, mk3);
    await p.evaluate(() => { window.__mk = []; });
    await compress('report.txt', fmt === '7z'); await p.waitForSelector('.files-clash-both'); await p.locator('.files-clash-replace').click(); await p.waitForTimeout(500);
    mk3 = await p.evaluate(() => window.__mk); ok(L(`${fmt}: replace: the same name, with replace asked for`), mk3.length === 1 && mk3[0].out === first.out && (fmt === 'zip' || mk3[0].replace === true), mk3);  // (a computer's ZIP always writes over the name it is given: asking is the UI's part)
  }
  // ---- failures are said in words, never as a code
  for (const code of ['sevenZipExists', 'sevenZipOutInside', 'sevenZipSameName', 'sevenZipMissing', 'sevenZipNoFolder', 'sevenZipFailed', 'notFound x.txt', '7z exit 2']) {
    await p.evaluate((c) => { window.__mk = []; window.__exists = []; window.__fail = c; document.querySelectorAll('.toast').forEach((x) => x.remove()); }, code);
    await compress('report.txt', true); await p.waitForTimeout(400);
    const tt = await p.evaluate(() => [...document.querySelectorAll('.toast')].map((x) => x.textContent).join(' | '));
    ok(L(`error «${code}» is said in words`), tt.length > 8 && !/sevenZip|7z exit|notFound/.test(tt) && !/files7zErr/.test(tt), tt);
  }
  await p.evaluate(() => { window.__fail = null; });
  ok(L('no page errors'), !errors.filter((x) => !/favicon/.test(x)).length, errors); await p.close();
  // the phone keeps its own sheet: no 7z level names of the computer, a comment and volumes are there
  const ph = await page(browser, port, z, lang, { at: K });
  await ph.p.locator('.files-row button.icon-btn[data-icon="more"]').first().click().catch(() => undefined); await ph.p.waitForTimeout(300);
  await ph.p.locator('.sheet button', { hasText: /^\s*(Compress|ضغط)/ }).first().click().catch(() => undefined); await ph.p.waitForTimeout(400);
  const pt = await ph.p.evaluate(() => document.querySelector('.sheet')?.textContent ?? '');
  ok(L('the phone: its own options (split into volumes, a comment) and no computer-only note'), (await ph.p.locator('.sheet .chip-row button').count()) === 3 && (await ph.p.locator('.sheet input[type=checkbox]').count()) === 1 && (await ph.p.locator('.files-7z-note').count()) === 0, pt.slice(0, 200)); await ph.p.close();
}


(async () => {
  const z = await F.zipListing(); const srv = await F.serve(); const port = srv.address().port; const browser = await chromium.launch();
  try { for (const lang of langs) { await sevenz(browser, port, z, lang); } }
  catch (e) { ok('the test ran to its end: ' + String(e && e.message).split('\n')[0], false); }
  finally { await browser.close(); srv.close(); }
  console.log(fails ? `\n${fails} failed` : '\nall ok'); process.exit(fails ? 1 : 0);
})();
