// Coming back after Android ended the page's renderer (to free memory), on a pretend phone (360×800), in English and
// Arabic: the page loaded anew at its start (as MainActivity.recreate() does) is brought back once — the same Files
// folder, its scroll, the clipboard (no selection), the engine's job still running shown again with the name-taken
// question it waits on, and one calm line says what happened. A plain start afterwards opens as always, no line.
// Shots (F1-back*.png) go to the folder given as F1_SHOTS, if any.
// Run: NODE_PATH=$(npm root -g) node tests/filesrestore.cjs [en|ar]
const { chromium } = require('playwright'); const path = require('node:path'); const F = require('./filesphone-fixture.cjs'); const { K } = F;
let fails = 0; const ok = (what, cond, x) => { console.log((cond ? 'ok   ' : 'FAIL ') + what + (cond || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!cond) fails++; };
const SHOTS = process.env.F1_SHOTS || '';
const LINE = { en: 'Android closed the page to free memory; you are back where you were.', ar: 'أغلق أندرويد الصفحة ليحرّر الذاكرة، وها أنت ذا حيث كنت.' };

/** The native side's two answers: whether this load follows the renderer's end (once), and the jobs still running. */
function extra() {
  const base = window.Capacitor.Plugins.KurokawaTools;
  const over = {
    pageRestored: async () => { const g = sessionStorage.getItem('kt-test-gone') === '1'; sessionStorage.removeItem('kt-test-gone'); return { gone: g, crashed: false, at: g ? Date.now() : 0 }; },
    filesLive: async () => { const ids = Object.keys(JSON.parse(localStorage.getItem('kt.files.live') || '{}')); window.__liveAsked = (window.__liveAsked || 0) + 1; return { jobs: sessionStorage.getItem('kt-test-live') === '1' ? ids.map((id) => ({ id, asking: { id, status: 'conflict', from: '/a/Song.mp3', to: '/b/Song.mp3', size: 5, existingSize: 4, mtime: 1, existingMtime: 1, dir: false } })) : [] }; },
  };
  window.Capacitor.Plugins.KurokawaTools = new Proxy(base, { get: (t, k) => (k in over ? over[k] : t[k]) });
}

async function run(browser, port, z, lang) {
  const L = (s) => `[${lang}-phone] ${s}`;
  const { page: p, errors } = await F.open(browser, { lang, z, many: 150, width: 360, height: 800 }); await p.addInitScript(extra);
  const go = (h) => p.evaluate((x) => { location.hash = x; }, h);
  await p.goto(`http://localhost:${port}/index.html#/files?p=${encodeURIComponent(K)}`); await p.waitForSelector('.files-row');
  await p.evaluate(() => sessionStorage.setItem('kt-test-live', '1'));   // (the engine reports what really runs: the job below, while it runs)
  // a copy on the clipboard, a job that runs on (never ends), then into a long folder, scrolled down
  await p.click('.files-row:has(.files-name[title="Song.mp3"])', { button: 'right' }); await p.click('.files-selbar .icon-btn[data-icon="copy"]'); await p.waitForSelector('.files-clipbar:not([hidden])');
  await go(`/files?p=${encodeURIComponent(`${K}/Sub`)}`); await p.waitForSelector('.files-row:has(.files-name[title="in.txt"])');
  await p.evaluate(() => { window.__stuck = true; }); await p.click('.files-clip-paste'); await p.waitForFunction(() => Object.keys(JSON.parse(localStorage.getItem('kt.files.live') || '{}')).length === 1);
  await go(`/files?p=${encodeURIComponent(`${K}/Many`)}`); await p.waitForSelector('.files-row:has(.files-name[title="file 010.txt"])');
  await p.evaluate(() => { window.scrollTo(0, 1500); document.querySelector('.files-body').scrollTop = 1500; window.dispatchEvent(new Event('scroll')); });
  await p.waitForFunction(() => (JSON.parse(localStorage.getItem('kt.resume.files') || '{}').y ?? 0) >= 1000);
  // the renderer ends: the page loaded again at its start
  await p.evaluate(() => { sessionStorage.setItem('kt-test-gone', '1'); sessionStorage.setItem('kt-test-live', '1'); });
  await p.goto(`http://localhost:${port}/index.html`);
  await p.waitForFunction((k) => decodeURIComponent(location.hash).endsWith(`${k}/Many`), K, { timeout: 8000 }).catch(() => undefined);
  ok(L('back at the same folder'), (await p.evaluate(() => decodeURIComponent(location.hash))).endsWith(`${K}/Many`), await p.evaluate(() => location.hash));
  await p.waitForSelector('.files-row', { timeout: 8000 }).catch(() => undefined);
  await p.waitForFunction(() => Math.max(window.scrollY, document.querySelector('.files-body')?.scrollTop ?? 0) > 1000, null, { timeout: 4000 }).catch(() => undefined);
  ok(L('…scrolled where it was'), (await p.evaluate(() => Math.max(window.scrollY, document.querySelector('.files-body')?.scrollTop ?? 0))) > 1000);
  ok(L('the clipboard as it was, nothing selected'), !!(await p.$('.files-clipbar:not([hidden])')) && !(await p.$('.files-view.selecting')));
  await p.waitForSelector('.toast', { timeout: 4000 }).catch(() => undefined);
  ok(L('one calm line says what happened'), (await p.$$eval('.toast', (t) => t.map((x) => x.textContent))).includes(LINE[lang]), await p.$$eval('.toast', (t) => t.map((x) => x.textContent)));
  await p.waitForSelector('.files-job', { timeout: 4000 }).catch(() => undefined);
  ok(L('the job still running shows again'), (await p.$$eval('.files-job', (j) => j.length)) === 1 && !(await p.$eval('.files-jobs-btn', (b) => b.hidden)));
  ok(L('…and its waiting question is asked again'), !!(await p.$('.sheet .files-compare')));
  if (SHOTS && lang === 'en') { await p.keyboard.press('Escape').catch(() => undefined); await p.waitForFunction(() => !document.querySelector('.sheet')).catch(() => undefined); await p.evaluate(() => { window.scrollTo(0, 0); document.querySelector('.files-body').scrollTop = 0; for (const x of document.querySelectorAll('.toast')) x.style.animation = 'none'; }); if (await p.$('.toast')) await p.screenshot({ path: path.join(SHOTS, `F1-back${lang === 'ar' ? '-ar' : ''}.png`) }); }
  // a plain start: as always
  await p.evaluate(() => sessionStorage.removeItem('kt-test-live')); await p.goto(`http://localhost:${port}/index.html`); await p.waitForFunction(() => window.__liveAsked !== undefined || document.querySelector('.view'));
  await p.waitForSelector('.view'); await p.evaluate(() => new Promise((r) => setTimeout(r, 400)));
  ok(L('a plain start afterwards: no line, not taken anywhere'), !(await p.$$eval('.toast', (t) => t.map((x) => x.textContent))).includes(LINE[lang]) && !(await p.evaluate(() => location.hash.includes('Many'))));
  const errs = errors.filter((e) => !/favicon/.test(e)); ok(L('no page errors'), !errs.length, errs);
  await p.close();
}
(async () => {
  const z = await F.zipListing(); const srv = await F.serve(); const port = srv.address().port; const browser = await chromium.launch();
  for (const lang of process.argv[2] ? [process.argv[2]] : ['en', 'ar']) await run(browser, port, z, lang);
  await browser.close(); srv.close(); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
