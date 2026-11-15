// «Save to device» (another app shares a file to Kurokawa Tools; the pretend phone of tests/filesphone-fixture.cjs):
// the plugin's «browser» channel also says «files were shared in» — { kind: 'shared', n } and no links —, which the
// browser's link handler walked as a page's links: «e.links is not iterable» in a red toast. Read once at the door now
// (downloads/browserEvents.ts), so it and other odd messages pass quietly. The sheet: one .ass file of 2.4 MB, its
// name cut in the middle on one line, its size at the end; «Save here» saves without an error; the phone's answers
// read once too (a name missing, the saved/failed lists missing). Made-up data only.
// Run: NODE_PATH=$(npm root -g) node tests/sharedsave.cjs   (KT_SHOTS=<dir>: a screenshot of the sheet)
const { chromium } = require('playwright'); const F = require('./filesphone-fixture.cjs'); const path = require('node:path');
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const NAME = '[LazySano] Seitokai ni mo Ana wa Aru! - 07 (1080p) [Arabic Karaoke Signs Final v3].ass';

async function run(browser, port, z, variant) {
  const L = (s) => `[${variant}] ${s}`;
  const { page: p, errors } = await F.open(browser, { lang: 'en', pc: false, z });
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
  const row = await p.$eval('.sheet .shared-row', (r) => { const rb = r.getBoundingClientRect(); const n = r.querySelector('.files-name'); const sz = r.querySelector('.shared-size'); const nb = n.getBoundingClientRect(); const sb = sz.getBoundingClientRect(); return { h: Math.round(rb.height), name: n.getAttribute('title'), mid: n.classList.contains('mid'), headCut: n.querySelector('.mid-head').scrollWidth > n.querySelector('.mid-head').clientWidth, tail: n.querySelector('.mid-tail').textContent, size: sz.textContent, sizeEnd: Math.round(rb.right - sb.right), sameLine: Math.abs((nb.top + nb.bottom) / 2 - (sb.top + sb.bottom) / 2) < 6 }; });
  console.log(L('row:'), JSON.stringify(row));
  if (variant === 'plain') {
    ok(L('one line: the name cut in the middle, its end («….ass») kept'), row.h < 64 && row.mid && row.headCut && /\.ass$/.test(row.tail), row);
    ok(L('the size at the row\'s end, on the name\'s line'), /2\.4\s*MB/.test(row.size) && row.sizeEnd < 24 && row.sameLine, row);
  } else ok(L('a file the sending app gave no name: its link\'s last part, no size'), row.name === 'HOREMAJO_03_ED.ass' && row.size === '', row);
  if (process.env.KT_SHOTS && variant === 'plain') await p.screenshot({ path: path.join(process.env.KT_SHOTS, 'save-to-device-sheet.png') });
  await p.locator('.sheet .btn.primary').last().click(); await p.waitForTimeout(900);
  const after = await p.$$eval('.toast', (ts) => ts.map((t) => [t.textContent, t.className]));
  ok(L('«Save here»: saved, no red toast'), (await p.evaluate(() => window.__saved)) === 1 && !after.some(([, c]) => /error/.test(c)) && !(await p.$('.sheet .shared-row')), after);
  // (A page's links without its list: the grabber opens empty, no error.)
  await p.evaluate(() => { for (const f of window.__browser) f({ kind: 'links', url: 'https://x.test/' }); }); await p.waitForTimeout(900);
  ok(L('a «links» message without its list: no error'), !(await p.$$eval('.toast', (ts) => ts.map((t) => t.className + t.textContent))).some((x) => /error|iterable/.test(x)) && !errors.some((e) => /iterable/.test(e)));
  ok(L('no page errors'), !errors.filter((e) => !/favicon/.test(e)).length, errors);
  await p.close();
}

(async () => {
  const z = await F.zipListing(); const web = await F.serve(); const port = web.address().port; const browser = await chromium.launch();
  await run(browser, port, z, 'plain'); await run(browser, port, z, 'odd answers');
  await browser.close(); web.close();
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
