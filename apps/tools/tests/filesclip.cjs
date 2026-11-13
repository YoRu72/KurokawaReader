// The Files page's clipboard and archives, on a pretend phone (tests/filesphone-fixture.cjs: a tree the jobs really
// change, and a real zip read by the desktop's zip reader), in English and Arabic, on a phone (412×915) and a computer
// (1280×800): inside a zip the title is the archive's name (never «%2Fstorage%2F…»), rows show size and date with no
// dangling « · », long names keep their extension; entries copied there are extracted on Paste (to a hidden folder,
// then moved in — the name-taken question, «keep both» → «name (2)»); cut, rename, delete, new folder are not offered
// inside; the clipboard bar shows how many and what, Paste here (greyed with its reason inside an archive, into the
// folder itself, the same folder, a read-only one) and Cancel, and lives across folders and archives; outside archives:
// single and multi copy and cut, onto another storage, the same folder, apply-to-all, Cancel mid-way, one failure
// among others with a summary; a computer's Ctrl+C / Ctrl+X / Ctrl+V / Esc.
// Run: NODE_PATH=$(npm root -g) node tests/filesclip.cjs [en|ar] [phone|pc]   (no arguments: all four)
const { chromium } = require('playwright'); const path = require('node:path'); const esbuild = require('esbuild');
const F = require('./filesphone-fixture.cjs'); const { K, P, SD, ZIP, LONG, ARABIC } = F;
const OUT = process.env.KT_SHOTS || '/tmp/claude-0/-home-claude/31db5f1c-a6c2-54e2-a5c4-2730cae2d727/scratchpad/tfiles/';
let fails = 0; const ok = (what, cond, x) => { console.log((cond ? 'ok   ' : 'FAIL ') + what + (cond || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!cond) fails++; };
const strings = (lang) => { const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src/i18n', `${lang}.ts`)], bundle: true, write: false, format: 'cjs', platform: 'node' }); const m = { exports: {} }; new Function('module', 'exports', out.outputFiles[0].text)(m, m.exports); return { ...m.exports.en, ...m.exports[lang] }; };
const EN = strings('en');
const fill = (s, o) => s.replace(/\{(\w+)\}/g, (_, k) => o[k]);
const arcOf = (archive, inner = '') => `arc://${encodeURIComponent(archive)}${inner ? '/' + inner : ''}`;

async function suite(browser, port, z, lang, pc) {
  const S = { ...EN, ...strings(lang) }; const tag = `${lang}-${pc ? 'pc' : 'phone'}`; const L = (s) => `[${tag}] ${s}`;
  const { page: p, errors } = await F.open(browser, { lang, pc, z, many: 5 });
  const hash = (q) => `http://localhost:${port}/#/files?p=${encodeURIComponent(q)}`;
  const goTo = async (q) => { await p.evaluate((h) => { location.hash = h; }, `#/files?p=${encodeURIComponent(q)}`); await p.waitForTimeout(450); };
  const row = (name) => p.locator(`.files-row:has(.files-name[title="${name.replace(/"/g, '\\"')}"])`).first();
  const hold = async (name) => { await row(name).evaluate((r) => r.scrollIntoView({ block: 'center' })); await p.waitForTimeout(100); const b = await row(name).boundingBox(); await p.mouse.move(b.x + 80, b.y + b.height / 2); await p.mouse.down(); await p.waitForTimeout(650); await p.mouse.up(); await p.waitForTimeout(200); };
  const tap = async (name) => { await row(name).locator('.files-main').click(); await p.waitForTimeout(150); };
  const pick = async (...names) => { await hold(names[0]); for (const n of names.slice(1)) await tap(n); };
  const sel = (icon) => p.click(`.files-selbar button[data-icon="${icon}"]`);
  const bar = () => p.evaluate(() => { const b = document.querySelector('.files-view .files-clipbar'); if (!b || b.hidden || !b.getClientRects().length) return null; const pb = b.querySelector('.files-clip-paste'); return { name: b.querySelector('.files-clip-name')?.textContent ?? '', why: b.querySelector('.files-clip-why')?.textContent ?? '', blocked: !!b.querySelector('.files-clip-why.blocked'), disabled: pb.disabled, box: b.getBoundingClientRect().toJSON() }; });
  const has = (q) => p.evaluate((x) => window.__tree.has(x), q);
  const kidsOf = (d) => p.evaluate((x) => [...window.__tree.keys()].filter((k) => k.replace(/\/[^/]*$/, '') === x).map((k) => k.split('/').pop()), d);
  const calls = () => p.evaluate(() => window.__calls.slice());
  const settle = async (ms = 600) => p.waitForTimeout(ms);
  const back = async () => { if (pc) await p.click('.files-view .files-back'); else await p.evaluate(() => window.__back()); await p.waitForTimeout(500); };
  const shot = (name) => p.screenshot({ path: `${OUT}${tag}-${name}.png` });

  // ---- 1. inside the zip: the title, the breadcrumb, the rows
  await p.goto(hash(arcOf(`${K}/${ZIP}`))); await p.waitForSelector('.files-row'); await p.waitForTimeout(600);
  const title = (await p.textContent('.files-title')) ?? '';
  ok(L('inside the zip: the title is the archive\'s name, decoded'), title === ZIP && !/%2F/i.test(await p.evaluate(() => document.querySelector('.files-view').innerText)), title);
  ok(L('the breadcrumb names the archive'), (await p.$$eval('.files-crumbs .crumb', (e) => e.map((x) => x.textContent))).includes(ZIP));
  const metas = await p.$$eval('.files-row .files-main > small', (e) => e.map((x) => x.textContent));
  ok(L('no row ends in a dangling « · »'), metas.every((m) => !/·\s*$/.test(m) && !/^\s*·/.test(m)), metas);
  ok(L('every entry shows the date the zip keeps'), metas.every((m) => /2025/.test(m)), metas);
  const tail = await row(LONG).evaluate((r) => { const n = r.querySelector('.files-name'); const t = n.querySelector('.mid-tail'); const nb = n.getBoundingClientRect(), tb = t.getBoundingClientRect(), hb = n.querySelector('.mid-head'); return { tail: t.textContent, inside: tb.right <= nb.right + 1 && tb.left >= nb.left - 1 && tb.width > 0, cut: hb.scrollWidth > hb.clientWidth }; });
  ok(L('a long name: cut in its middle, the extension in sight'), tail.tail.endsWith('.ass') && tail.inside && (pc || tail.cut), tail);
  ok(L('an Arabic name reads right to left, isolated'), (await row(ARABIC).locator('.files-name').getAttribute('dir')) === 'rtl');
  ok(L('no «+» to make things inside an archive'), await p.$eval('.files-fab', (f) => f.hidden || getComputedStyle(f).display === 'none'));
  await shot('zip');
  // an entry's menu: reading actions; no rename or delete; cut greyed with its reason
  await row('notes.txt').locator('.icon-btn[data-icon="more"]').click(); await p.waitForSelector('.sheet');
  const rows = await p.$$eval('.sheet .dest-row', (e) => e.map((x) => ({ t: x.querySelector('.name')?.textContent, off: x.classList.contains('files-off') })));
  ok(L('the entry\'s menu: Copy, Extract here, Extract to, Open, Share; no Rename, no Delete'), [S.filesCopy, S.extractHere, S.extractTo, S.open, S.share].every((x) => rows.some((r) => r.t === x && !r.off)) && !rows.some((r) => r.t === S.rename || r.t === S.delete), rows);
  ok(L('Cut shown greyed, with why'), rows.some((r) => r.t === S.filesCut && r.off) && (await p.textContent('.sheet')).includes(S.arcNoCut));
  await p.keyboard.press('Escape'); await p.waitForTimeout(250); if (await p.$('.sheet')) { await p.click('.sheet .sheet-head button'); await p.waitForTimeout(250); }

  // ---- 2. three entries copied inside the zip: the bar, Paste greyed there
  await pick('notes.txt', 'Fonts', LONG);
  ok(L('inside an archive the selection offers no delete or rename'), !(await p.$('.files-selbar button[data-icon="trash"]')) && !(await p.$('.files-selbar button[data-icon="pen"]')));
  ok(L('…and Cut greyed'), await p.$eval('.files-selbar button[data-icon="scissors"]', (b) => b.disabled));
  await sel('copy'); await p.waitForTimeout(300);
  let b = await bar();
  ok(L('the clipboard bar: how many («العدد: 3» in Arabic)'), !!b && b.name === fill(S.filesClipCount, { n: lang === 'ar' ? '٣' : '3' }) || (!!b && b.name === fill(S.filesClipCount, { n: '3' })), b);
  ok(L('inside the archive Paste is greyed, the reason said'), !!b && b.disabled && b.blocked && b.why === S.arcNoPaste, b);
  if (pc) { const top = await p.$eval('.files-view .topbar', (e) => e.getBoundingClientRect().bottom); ok(L('a computer: the bar is a strip under the top bar'), !!b && b.box.top >= top - 1 && b.box.top < top + 80, { top, b }); }
  else { const nav = await p.$eval('.bottom-nav', (e) => e.getBoundingClientRect().top); ok(L('a phone: the bar floats above the bottom bar'), !!b && b.box.bottom <= nav && b.box.bottom > nav - 60, { nav, b }); }
  await shot('clipbar');
  // Ctrl+X inside the archive (a computer): a copy, said so
  if (pc) { await hold('Horemajo_03_OP_Karaoke.ass'); await p.keyboard.press('Control+x'); await p.waitForTimeout(250); const c = await p.evaluate(() => document.querySelector('.toast')?.textContent ?? ''); ok(L('Ctrl+X in an archive copies, and says so'), c === S.arcCutAsCopy && (await bar())?.name.length > 0, c); await pick('notes.txt', 'Fonts', LONG); await p.keyboard.press('Control+c'); await p.waitForTimeout(250); }

  // ---- 3. Back out of the zip: the folder that holds it; the bar is still there; Paste extracts
  await back();
  ok(L('Back from the archive\'s top: the folder that holds it'), decodeURIComponent(await p.evaluate(() => location.hash)).endsWith(`p=${K}`), await p.evaluate(() => location.hash));
  b = await bar(); ok(L('the clipboard survives leaving the archive; Paste here is offered'), !!b && !b.disabled && b.why === S.filesClipExtract, b);
  await p.click('.files-view .files-clip-paste'); await settle(1200);
  const here = await kidsOf(K);
  ok(L('Paste: the entries extracted here — a folder with what is inside it'), here.includes('notes.txt') && here.includes(LONG) && here.includes('Fonts') && (await has(`${K}/Fonts/sub/Noto.otf`)) && (await has(`${K}/Fonts/Arial (Bold).ttf`)), here);
  ok(L('…taken out to a hidden folder, then moved in by a job; the hidden folder gone'), (await calls()).some((c) => /^arcExtract:notes\.txt\|Fonts\/\|.*>.*\/\.kurokawa-extract-.*:replace$/.test(c)) && (await calls()).some((c) => /^move:notes\.txt\|Fonts\|/.test(c)) && !here.some((n) => n.startsWith('.kurokawa-extract-')), (await calls()).slice(-6));
  ok(L('no red message'), !(await p.$('.toast.error')));
  // ---- the same again: the name is taken — asked once, «apply to all», keep both → «name (2)»
  b = await bar(); ok(L('a copy stays on the clipboard for another paste'), !!b && !b.disabled, b);
  await p.click('.files-view .files-clip-paste'); await p.waitForSelector('.sheet .check-row input', { timeout: 5000 });
  ok(L('the name-taken question: replace, keep both, skip, and «apply to all»'), (await p.$$('.sheet .btn')).length >= 3 && (await p.textContent('.sheet')).includes(S.filesSameForRest));
  await shot('clash');
  await p.check('.sheet .check-row input'); await p.click(`.sheet .btn:has-text("${S.keepBoth}")`); await settle(1000);
  ok(L('keep both, for all: «notes (2).txt», asked once'), (await has(`${K}/notes (2).txt`)) && (await has(`${K}/Fonts (2)/Arial (Bold).ttf`)) && (await calls()).filter((c) => c.startsWith('answer:')).length === 1 && (await calls()).includes('answer:keepAll'), (await calls()).filter((c) => c.startsWith('answer')));
  await p.click('.files-view .files-clipbar .icon-btn[data-icon="close"]'); await p.waitForTimeout(250);
  ok(L('Cancel on the bar empties the clipboard'), !(await bar()));

  // ---- 4. outside archives: one copied into another folder; the bar stays
  await pick('undated.bin'); await sel('copy'); await p.waitForTimeout(200);
  b = await bar(); ok(L('one item: the bar names it'), !!b && b.name === 'undated.bin' && b.why === S.filesClipCopy, b);
  await tap('Sub'); await p.waitForTimeout(400); await p.click('.files-view .files-clip-paste'); await settle();
  ok(L('copied into another folder, the original kept'), (await has(`${K}/Sub/undated.bin`)) && (await has(`${K}/undated.bin`)));
  ok(L('…and the copy is still on the clipboard'), !!(await bar()));
  // the same folder: keep both → «undated (2).bin»
  await back(); await p.click('.files-view .files-clip-paste'); await settle();
  ok(L('pasted into its own folder: «undated (2).bin» beside it'), await has(`${K}/undated (2).bin`));
  const um = await row('undated.bin').locator('.files-main > small').textContent();
  ok(L('a row with no date: its size alone, no « · »'), !/·/.test(um) && um.trim().length > 0, um);
  await p.click('.files-view .files-clipbar .icon-btn[data-icon="close"]'); await p.waitForTimeout(200);
  // two cut onto another storage: moved, the clipboard emptied
  await pick('Song.mp3', 'photo.jpg'); await sel('scissors'); await p.waitForTimeout(200);
  b = await bar(); ok(L('two cut: how many, with the scissors'), !!b && /[2٢]/.test(b.name) && !!(await p.$('.files-view .files-clip-ic svg')) && (await p.evaluate(() => document.querySelector('.files-view .files-clipbar')?.dataset.op)) === 'move', b);
  ok(L('cut, then the same folder: Paste greyed, «already here»'), !!b && b.disabled && b.why === S.filesPasteSameFolder, b);
  await p.click(`.files-roots .chip:has-text("SD card")`); await p.waitForTimeout(450); await p.click('.files-view .files-clip-paste'); await settle();
  ok(L('moved onto the SD card: there, and gone from where they were'), (await has(`${SD}/Song.mp3`)) && (await has(`${SD}/photo.jpg`)) && !(await has(`${K}/Song.mp3`)));
  ok(L('…and the clipboard emptied after the move'), !(await bar()));
  // a folder cut, then its own subfolder: refused, with the reason
  await goTo(K); await pick('Sub'); await sel('scissors'); await tap('Sub'); await p.waitForTimeout(300);
  b = await bar(); ok(L('a folder into itself: Paste greyed, the reason said'), !!b && b.disabled && b.why === S.filesIntoItself, b);
  await tap('Deeper'); b = await bar(); ok(L('…and into a folder below it'), !!b && b.disabled && b.why === S.filesIntoItself, b);
  await goTo(`${P}/ReadOnly`); b = await bar(); ok(L('a folder that cannot be written to: Paste greyed'), !!b && b.disabled && b.why === S.filesPasteReadOnly, b);
  await p.click('.files-view .files-clipbar .icon-btn[data-icon="close"]'); await p.waitForTimeout(200);
  // two names taken, «apply to all» + skip: asked once, nothing replaced
  await goTo(K); await pick('notes.txt', 'undated.bin'); await sel('copy'); await goTo(`${K}/Sub`); await p.evaluate(() => { window.__calls.length = 0; });
  await p.click('.files-view .files-clip-paste'); await p.waitForSelector('.sheet .check-row input', { timeout: 5000 });
  await p.check('.sheet .check-row input'); await p.click(`.sheet .btn:has-text("${S.skip}")`); await settle();
  ok(L('skip, for all: asked once, nothing replaced'), (await calls()).filter((c) => c.startsWith('answer:')).join() === 'answer:skipAll' && !(await p.$('.sheet')), await calls());
  await p.click('.files-view .files-clipbar .icon-btn[data-icon="close"]'); await p.waitForTimeout(200);
  // Cancel mid-way: what was done stays, the rest is not done
  await goTo(`${K}/Many`); await hold('file 000.txt'); await sel('check'); await sel('copy'); await goTo(`${K}/Sub/Deeper`);
  await p.evaluate(() => { window.__slow = 300; }); await p.click('.files-view .files-clip-paste'); await p.waitForTimeout(800); await p.click('.files-job .icon-btn'); await settle(900); await p.evaluate(() => { window.__slow = 0; });
  const got = (await kidsOf(`${K}/Sub/Deeper`)).filter((n) => n.startsWith('file '));
  ok(L('Cancel mid-way: some copied, the rest not, «cancelled» said'), got.length >= 1 && got.length < 5 && (await p.evaluate(() => document.querySelector('.toast')?.textContent ?? '')) === S.filesCancelled, { got, toast: await p.evaluate(() => document.querySelector('.toast')?.textContent) });
  await p.click('.files-view .files-clipbar .icon-btn[data-icon="close"]'); await p.waitForTimeout(200);
  // one item fails: the others go through, a summary at the end
  await goTo(K); await pick('broken.bin', 'notes (2).txt'); await sel('copy'); await goTo(P); await p.click('.files-view .files-clip-paste'); await settle(900);
  const sum = await p.evaluate(() => document.querySelector('.sheet')?.textContent ?? '');
  ok(L('one failed: the other copied, the failure listed in a summary'), (await has(`${P}/notes (2).txt`)) && sum.includes('broken.bin') && sum.includes(S.filesSummaryTitle), sum);
  if (await p.$('.sheet')) { await p.click('.sheet .sheet-head button'); await p.waitForTimeout(250); }
  await p.click('.files-view .files-clipbar .icon-btn[data-icon="close"]'); await p.waitForTimeout(200);

  // ---- 5. a computer's keys
  if (pc) {
    await goTo(`${K}/Sub`); await p.click('.files-view .files-body', { position: { x: 5, y: 5 } }).catch(() => undefined);
    await p.keyboard.press('Control+a'); await p.keyboard.press('Control+c'); await p.waitForTimeout(250);
    ok(L('Ctrl+A, Ctrl+C: all of the folder on the clipboard'), !!(await bar()));
    await p.keyboard.press('Escape'); await p.waitForTimeout(200); ok(L('Esc empties the clipboard'), !(await bar()));
    await hold('in.txt'); await p.keyboard.press('Control+x'); await goTo(SD); await p.keyboard.press('Control+v'); await settle();
    ok(L('Ctrl+X, then Ctrl+V elsewhere: moved'), (await has(`${SD}/in.txt`)) && !(await has(`${K}/Sub/in.txt`)) && !(await bar()));
  }
  const errs = errors.filter((e) => !/favicon/.test(e)); ok(L('no page errors'), !errs.length, errs);
  await p.close();
}

(async () => {
  const z = await F.zipListing();
  ok('the zip\'s entries carry their dates (the desktop reader)', z.entries.every((e) => e.mtime > 0) && Math.abs(z.entries.find((e) => e.path === 'notes.txt').mtime - (F.WHEN + 7 * 60000)) <= 2000);
  const srv = await F.serve(); const port = srv.address().port; const browser = await chromium.launch();
  const langs = process.argv[2] ? [process.argv[2]] : ['en', 'ar']; const layouts = process.argv[3] ? [process.argv[3] === 'pc'] : [false, true];
  for (const lang of langs) for (const pc of layouts) await suite(browser, port, z, lang, pc);
  await browser.close(); srv.close();
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
