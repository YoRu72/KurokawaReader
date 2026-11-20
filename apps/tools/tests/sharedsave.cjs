// «Save to device» (another app shares a file to Kurokawa Tools; the pretend phone of tests/filesphone-fixture.cjs):
// the plugin's «browser» channel also says «files were shared in» — { kind: 'shared', n } and no links —, which the
// browser's link handler walked as a page's links: «e.links is not iterable» in a red toast. Read once at the door now
// (downloads/browserEvents.ts), so it and other odd messages pass quietly. The sheet: one .ass file of 2.4 MB, its
// name cut in the middle on one line, its size at the end; «Save here» saves without an error; the phone's answers
// read once too (a name missing, the saved/failed lists missing). Made-up data only.
// Run: NODE_PATH=$(npm root -g) node tests/sharedsave.cjs   (KT_SHOTS=<dir>: a screenshot of the sheet)
const LANG = process.argv[2] === 'ar' ? 'ar' : 'en';
const { chromium } = require('playwright'); const F = require('./filesphone-fixture.cjs'); const path = require('node:path');
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const NAME = '[LazySano] Seitokai ni mo Ana wa Aru! - 07 (1080p) [Arabic Karaoke Signs Final v3].ass';

async function run(browser, port, z, variant) {
  const L = (s) => `[${variant}] ${s}`;
  const { page: p, errors } = await F.open(browser, { lang: LANG, pc: false, z });
  await p.addInitScript(([NAME, variant, K]) => {
    const kt = window.Capacitor.Plugins.KurokawaTools; window.__browser = []; window.__saved = 0;
    const orig = kt.addListener; kt.addListener = async (ev, fn) => { if (ev === 'browser') window.__browser.push(fn); return orig(ev, fn); };
    kt.sharedPending = async () => (variant === 'plain' ? { items: [{ uri: 'content://com.whatsapp.provider/item/77', name: NAME, size: 2516582, mime: 'text/x-ssa' }] } : { items: [{ uri: 'content://media/external/file/HOREMAJO_03_ED.ass', name: null, size: null }, null, 'junk'] });
    kt.sharedSave = async (o) => { window.__saved++; window.__savedTo = o.dir; return variant === 'plain' ? { saved: [`${o.dir}/${NAME}`], failed: [], dir: o.dir } : {}; };
    kt.sharedClear = async () => {};
  }, [NAME, variant, F.K]);
  await p.goto(`http://localhost:${port}/#/files?p=${encodeURIComponent(F.K)}&save=1`); await p.waitForSelector('.sheet .shared-row', { timeout: 15000 }); await p.waitForTimeout(1200);
  // What MainActivity's sharedIn sends, on the same channel as the browser's messages (and some odd ones).
  await p.evaluate(() => { for (const f of window.__browser) { f({ kind: 'shared', n: 1 }); f({ kind: 'nothing-known' }); f(null); f({ links: 'not a list' }); } });
  await p.waitForTimeout(900);
  const toasts = await p.$$eval('.toast', (ts) => ts.map((t) => t.textContent));
  ok(L('the «shared» message on the browser channel: no «not iterable» error'), !toasts.some((x) => /iterable|undefined|null/i.test(x)) && !errors.some((e) => /iterable/.test(e)), toasts);
  await p.evaluate(() => document.querySelectorAll('.sheet').forEach((s) => { if (!s.querySelector('.shared-row')) s.querySelector('.sheet-head button[data-icon="close"]')?.click(); }));
  await p.waitForTimeout(300);
  const row = await p.$eval('.sheet .shared-row', (r) => { const rb = r.getBoundingClientRect(); const n = r.querySelector('.files-name'); const sz = r.querySelector('.shared-size'); const nb = n.getBoundingClientRect(); const sb = sz.getBoundingClientRect(); return { h: Math.round(rb.height), name: n.getAttribute('title'), mid: n.classList.contains('mid'), headCut: n.querySelector('.mid-head').scrollWidth > n.querySelector('.mid-head').clientWidth, tail: n.querySelector('.mid-tail').textContent, size: sz.textContent, sizeEnd: Math.round(getComputedStyle(r).direction === 'rtl' ? sb.left - rb.left : rb.right - sb.right), sameLine: Math.abs((nb.top + nb.bottom) / 2 - (sb.top + sb.bottom) / 2) < 6 }; });
  console.log(L('row:'), JSON.stringify(row));
  if (variant === 'plain') {
    ok(L('one line: the name cut in the middle, its end («….ass») kept'), row.h < 64 && row.mid && row.headCut && /\.ass$/.test(row.tail), row);
    ok(L('the size near the row\'s end (the remove button after it), on the name\'s line'), /2\.4\s*MB/.test(row.size) && row.sizeEnd < 80 && row.sameLine, row);
  } else ok(L('a file the sending app gave no name: its link\'s last part, no size'), row.name === 'HOREMAJO_03_ED.ass' && row.size === '', row);
  if (process.env.KT_SHOTS && variant === 'plain') await p.screenshot({ path: path.join(process.env.KT_SHOTS, 'save-to-device-sheet-' + LANG + '.png') });
  await p.locator('.sheet .btn.primary').last().click(); await p.waitForTimeout(900);
  const after = await p.$$eval('.toast', (ts) => ts.map((t) => [t.textContent, t.className]));
  ok(L('«Save here»: saved, no red toast'), (await p.evaluate(() => window.__saved)) === 1 && !after.some(([, c]) => /error/.test(c)) && !(await p.$('.sheet .shared-row')), after);
  // (A page's links without its list: the grabber opens empty, no error.)
  await p.evaluate(() => { for (const f of window.__browser) f({ kind: 'links', url: 'https://x.test/' }); }); await p.waitForTimeout(900);
  ok(L('a «links» message without its list: no error'), !(await p.$$eval('.toast', (ts) => ts.map((t) => t.className + t.textContent))).some((x) => /error|iterable/.test(x)) && !errors.some((e) => /iterable/.test(e)));
  ok(L('no page errors'), !errors.filter((e) => !/favicon/.test(e)).length, errors);
  await p.close();
}

// The sheet with repeats, a pick and a remove: three identical shares (one of them the same link again, one a new link
// of the same name and size) show as ONE row beside a second file; remove one (undo offered); a subset saved; none: Save off.
async function multi(browser, port, z) {
  const L = (s) => `[multi ${LANG}] ${s}`;
  const { page: p, errors } = await F.open(browser, { lang: LANG, pc: false, z });
  await p.addInitScript(() => {
    const kt = window.Capacitor.Plugins.KurokawaTools; window.__saves = []; window.__drops = [];
    const Z = 'Release-Pack-0.22.0-universal.zip';
    kt.sharedPending = async () => ({ items: [{ uri: 'content://x/a', name: Z, size: 7130000, mime: 'application/zip' }, { uri: 'content://x/a', name: Z, size: 7130000, mime: 'application/zip' }, { uri: 'content://x/a2', name: Z, size: 7130000, mime: 'application/zip' }, { uri: 'content://x/b', name: 'notes.txt', size: 2048, mime: 'text/plain' }] });
    kt.sharedSave = async (o) => { window.__saves.push(o.uris); return { saved: o.uris.map((u) => o.dir + '/' + u.slice(-1)), failed: [], dir: o.dir }; };
    kt.sharedClear = async () => {}; kt.sharedDrop = async (o) => { window.__drops.push(o.uris); };
  });
  await p.goto(`http://localhost:${port}/#/files?p=${encodeURIComponent(F.K)}&save=1`); await p.waitForSelector('.sheet .shared-row', { timeout: 15000 }); await p.waitForTimeout(800);
  const rows = () => p.$$eval('.sheet .shared-row', (rs) => rs.map((r) => ({ on: r.querySelector('.shared-pick').getAttribute('aria-checked'), h: Math.round(r.getBoundingClientRect().height) })));
  const head = () => p.$eval('.sheet-head h3', (h) => h.textContent); const saveBtn = () => p.$eval('.sheet .btn.primary', (b) => ({ t: b.textContent.trim(), dis: b.disabled }));
  let r = await rows(); ok(L('repeats show once: two rows (the zip, the text)'), r.length === 2 && r.every((x) => x.on === 'true' && x.h >= 48), r);
  ok(L('the title carries the count'), (LANG === 'ar' ? /العدد: 2/ : /\(2\)/).test(await head()), await head());
  ok(L('all selected: Save here has no count'), !/\d/.test((await saveBtn()).t), await saveBtn());
  const geo = await p.$eval('.sheet .shared-row', (row) => { const k = [...row.children].map((c) => c.getBoundingClientRect()).filter((b) => b.width); let touch = false; for (let i = 0; i < k.length; i++) for (let j = i + 1; j < k.length; j++) if (k[i].left < k[j].right && k[j].left < k[i].right) touch = true; return { touch, right: Math.round(row.getBoundingClientRect().right - Math.max(...k.map((b) => b.right))) }; });
  ok(L('controls do not overlap, inside the row'), !geo.touch && geo.right >= 0, geo);
  if (process.env.KT_SHOTS) await p.screenshot({ path: path.join(process.env.KT_SHOTS, 'save-to-device-pick-' + LANG + '.png') });
  await p.locator('.sheet .shared-row').nth(1).locator('.shared-pick').click(); await p.waitForTimeout(200);
  r = await rows(); ok(L('one row unticked; Save here carries the count'), r[1].on === 'false' && r[0].on === 'true' && /1/.test((await saveBtn()).t) && !(await saveBtn()).dis, [r, await saveBtn()]);
  await p.locator('.sheet .shared-row').nth(0).locator('.shared-pick').click(); await p.waitForTimeout(200);
  ok(L('none ticked: Save here is disabled'), (await saveBtn()).dis === true, await saveBtn());
  await p.locator('.sheet .shared-row').nth(1).locator('.shared-del').click(); await p.waitForTimeout(400);
  r = await rows(); ok(L('remove: the row goes, an undo is offered, nothing dropped for real yet'), r.length === 1 && !!(await p.$('.undo-snack')) && (await p.evaluate(() => window.__drops.length)) === 0, r);
  await p.locator('.sheet .shared-row').nth(0).locator('.shared-pick').click(); await p.waitForTimeout(200);
  ok(L('ticked again: Save here on, one file'), (await saveBtn()).dis === false, await saveBtn());
  await p.locator('.sheet .btn.primary').click(); await p.waitForTimeout(900);
  const sv = await p.evaluate(() => window.__saves);
  ok(L('Save here: only the ticked file is sent (the removed one stays out)'), sv.length === 1 && sv[0].length === 1 && sv[0][0] === 'content://x/a', sv);
  ok(L('no page errors'), !errors.filter((e) => !/favicon/.test(e)).length, errors);
  await p.close();
}

(async () => {
  const z = await F.zipListing(); const web = await F.serve(); const port = web.address().port; const browser = await chromium.launch();
  await run(browser, port, z, 'plain'); await run(browser, port, z, 'odd answers'); await multi(browser, port, z);
  await browser.close(); web.close();
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
