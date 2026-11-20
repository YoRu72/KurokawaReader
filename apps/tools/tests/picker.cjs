// The Files page as another app's file picker (Android: KtPickActivity → #/pick; here the plugin faked, the pretend
// phone of tests/filesphone-fixture.cjs, made-up data only). First the plain logic (views/pickLogic.ts, built here with
// esbuild): the request read, a file's kind from its name, the kinds asked matched, the answer built. Then the page:
// who asked and for what; the bottom bar of the app gone; files of another kind greyed and refused with a reason; one
// file chosen and handed back with the request's mark; several chosen across folders, with their count; Back walks up
// the folders, then cancels — the asking app gets nothing. KT_SHOTS=<dir>: a screenshot of the picker.
// Run: NODE_PATH=$(npm root -g) node tests/picker.cjs
const { chromium } = require('playwright'); const F = require('./filesphone-fixture.cjs'); const path = require('node:path'); const { K } = F;
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };

function logic() {
  const esbuild = require(path.join(__dirname, '..', 'node_modules', 'esbuild'));
  const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src', 'views', 'pickLogic.ts')], bundle: true, format: 'cjs', platform: 'node', write: false });
  const m = { exports: {} }; new Function('module', 'exports', out.outputFiles[0].text)(m, m.exports); const L = m.exports;
  const r = L.parsePick('{"id":"a1","action":"android.intent.action.GET_CONTENT","multiple":true,"mimes":["image/*","Text/Plain"," bad ",7],"caller":" Telegram "}');
  ok('a request read: its mark, several, the kinds (cleaned), the app', r.id === 'a1' && r.multiple === true && JSON.stringify(r.mimes) === '["image/*","text/plain"]' && r.caller === 'Telegram', r);
  ok('a request of the wrong sort: nothing', L.parsePick('not json') === null && L.parsePick(null) === null && L.parsePick(42) === null);
  const d = L.parsePick({}); ok('a request with nothing in it: one file, any kind', d && d.multiple === false && d.mimes.length === 0 && d.caller === '');
  ok('a single «mimes» string taken as one kind', JSON.stringify(L.parsePick({ mimes: 'video/*' }).mimes) === '["video/*"]');
  ok('kinds from names', L.mimeOfName('a.JPG') === 'image/jpeg' && L.mimeOfName('ep.mkv') === 'video/x-matroska' && L.mimeOfName('x.ass') === 'text/x-ssa' && L.mimeOfName('y.srt') === 'application/x-subrip' && L.mimeOfName('noext') === 'application/octet-stream');
  ok('no kind asked, or */*: everything', L.mimeMatches('application/zip', []) && L.mimeMatches('video/mp4', ['*/*']) && L.mimeMatches('x/y', ['application/octet-stream']));
  ok('image/*: pictures only', L.mimeMatches('image/png', ['image/*']) && !L.mimeMatches('video/mp4', ['image/*']));
  ok('text/*: subtitles too (.ass, .srt, .vtt)', L.mimeMatches('text/x-ssa', ['text/*']) && L.mimeMatches('application/x-subrip', ['text/*']) && L.mimeMatches('text/vtt', ['text/plain']));
  ok('an exact kind: that one only', L.mimeMatches('application/pdf', ['application/pdf']) && !L.mimeMatches('application/zip', ['application/pdf']));
  ok('the answer: one when one was asked, several in order without repeats', JSON.stringify(L.pickResult({ multiple: false }, ['/a', '/b'])) === '["/a"]' && JSON.stringify(L.pickResult({ multiple: true }, ['/a', '/b', '/a', ''])) === '["/a","/b"]');
  ok('the kinds asked, in words', JSON.stringify(L.kindsAsked(['image/*', 'application/pdf'], { image: 'Pictures', video: 'Videos', audio: 'Music', text: 'Documents' })) === '["Pictures","PDF"]' && L.kindsAsked(['*/*'], {}).length === 0);
}

async function page(browser, port, z, lang, multiple) {
  const L = (s) => `[${lang}${multiple ? ', several' : ''}] ${s}`;
  const { page: p, errors } = await F.open(browser, { lang, pc: false, z });
  const req = multiple ? { id: 'r2', action: 'android.intent.action.GET_CONTENT', multiple: true, mimes: ['text/*'], caller: 'Aegisub Mobile' } : { id: 'r1', action: 'android.intent.action.GET_CONTENT', multiple: false, mimes: ['image/*'], caller: 'Telegram' };
  await p.addInitScript((req) => {
    const kt = window.Capacitor.Plugins.KurokawaTools; window.__done = [];
    kt.pickRequest = async () => ({ request: JSON.stringify(req) }); kt.pickDone = async (o) => { window.__done.push(o); };
    const pic = () => { const c = document.createElement('canvas'); c.width = 96; c.height = 96; const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 0, 96, 96); gr.addColorStop(0, '#4d6a8a'); gr.addColorStop(1, '#1c2733'); g.fillStyle = gr; g.fillRect(0, 0, 96, 96); g.fillStyle = 'rgba(255,255,255,.25)'; g.beginPath(); g.arc(64, 34, 14, 0, 7); g.fill(); return c.toDataURL('image/jpeg'); };
    kt.filesThumb = async (o) => ({ url: /\.jpg$/.test(o.path) ? pic() : null });
  }, req);
  await p.goto(`http://localhost:${port}/#/`); await p.waitForTimeout(800);
  await p.evaluate(() => { location.hash = '#/pick?t=1'; }); await p.waitForSelector('.files-view.picker .files-row', { timeout: 15000 }); await p.waitForTimeout(700);
  const head = await p.$eval('.pick-head', (e) => e.innerText.replace(/\s+/g, ' '));
  console.log(L('head:'), head);
  if (lang === 'en') ok(L('who asked and for what'), multiple ? /Choose files/.test(head) && /Aegisub Mobile/.test(head) : /Choose a file/.test(head) && /For Telegram/.test(head) && /Images/.test(head), head);
  else ok(L('who asked and for what, in Arabic'), multiple ? /اختر ملفات/.test(head) : /اختر ملفًّا/.test(head) && /Telegram/.test(head), head);
  ok(L('the app\'s bottom bar and the + button gone'), !(await p.isVisible('.bottom-nav')) && !(await p.$('.files-view.picker .files-fab')));
  const row = (name) => p.locator(`.files-row:has(.files-name[title="${name}"])`).first();
  if (!multiple) {
    ok(L('another kind greyed (Song.mp3), the kind asked not (photo.jpg)'), await row('Song.mp3').evaluate((e) => e.classList.contains('pick-off')) && !(await row('photo.jpg').evaluate((e) => e.classList.contains('pick-off'))));
    await row('Song.mp3').click(); await p.waitForTimeout(300);
    ok(L('another kind tapped: refused, said why'), (await p.$$eval('.toast', (ts) => ts.map((t) => t.textContent))).some((x) => /another kind/.test(x)) && (await p.evaluate(() => window.__done.length)) === 0);
    ok(L('a single pick has no Select button: only Cancel in the bar'), !(await p.$('.pick-bar .btn.primary')) && (await p.$$('.pick-bar button')).length === 1);
    ok(L('the show-all switch is there (a kind was asked)'), !!(await p.$('.pick-head .pick-all input')));
    await row('Song.mp3').evaluate((e) => e.scrollIntoView()); await p.click('.pick-head .pick-all input'); await p.waitForTimeout(250);
    ok(L('Show all: Song.mp3 no longer dimmed'), !(await row('Song.mp3').evaluate((e) => e.classList.contains('pick-off'))));
    await p.click('.pick-head .pick-all input'); await p.waitForTimeout(250);
    ok(L('switched off again: dimmed once more'), await row('Song.mp3').evaluate((e) => e.classList.contains('pick-off')));
    ok(L('paste bar and action bar hidden in pick mode'), !(await p.isVisible('.files-clipbar')) && !(await p.isVisible('.files-selbar')));
    if (process.env.KT_SHOTS && lang === 'en') { await p.emulateMedia({ colorScheme: 'dark' }); await p.waitForTimeout(300); await p.screenshot({ path: path.join(process.env.KT_SHOTS, 'F3-pick-single-en-dark.png') }); await p.emulateMedia({ colorScheme: 'light' }); }
    await row('photo.jpg').click(); await p.waitForTimeout(500);
    const done = await p.evaluate(() => window.__done);
    ok(L('one tap on the file hands it back at once, with the request\'s mark'), done.length === 1 && done[0].id === 'r1' && JSON.stringify(done[0].paths) === JSON.stringify([`${K}/photo.jpg`]), done);
    ok(L('then the picker is left'), !(await p.$('.files-view.picker')) && !(await p.evaluate(() => document.documentElement.classList.contains('picking'))));
    ok(L('the folder picked from is remembered apart from browsing'), (await p.evaluate(() => localStorage.getItem('kt.files.pickLast'))) === K && !(await p.evaluate(() => localStorage.getItem('kt.files.pickLast') === null)));
  } else {
    ok(L('folders open, an .mp3 greyed'), await row('Song.mp3').evaluate((e) => e.classList.contains('pick-off')) && !(await row('Sub').evaluate((e) => e.classList.contains('pick-off'))));
    await row('Sub').click(); await p.waitForTimeout(500); await row('in.txt').click(); await p.waitForTimeout(200);
    await row('Deeper').click(); await p.waitForTimeout(500); await row('deep.txt').click(); await p.waitForTimeout(200);
    const bar = await p.evaluate(() => [document.querySelector('.pick-bar .pick-count').textContent, document.querySelector('.pick-bar .btn.primary').textContent]);
    ok(L('two chosen in two folders: the count, «Add (2)»'), /2|٢|ملفان/.test(bar[0]) && /[2٢]/.test(bar[1]) && (lang === 'en' ? /Add/.test(bar[1]) : /إضافة/.test(bar[1])), bar);
    if (process.env.KT_SHOTS) await p.emulateMedia({ colorScheme: 'light' }); if (process.env.KT_SHOTS) await p.screenshot({ path: path.join(process.env.KT_SHOTS, lang === 'ar' ? 'F3-pick-multi-ar-light.png' : `picker-several-phone-${lang}.png`) });
    await p.evaluate(() => window.__back()); await p.waitForTimeout(500);
    ok(L('Back: up a folder, still in the picker, the choice kept'), !!(await p.$('.files-view.picker')) && (await p.textContent('.files-title')) === 'Sub' && /2|٢|ملفان/.test(await p.textContent('.pick-bar .pick-count')));
    if (lang === 'en') {
      await p.click('.pick-bar .btn.primary'); await p.waitForTimeout(500);
      const done = await p.evaluate(() => window.__done);
      ok(L('Add: both handed back, in the order chosen'), done.length === 1 && done[0].id === 'r2' && JSON.stringify(done[0].paths) === JSON.stringify([`${K}/Sub/in.txt`, `${K}/Sub/Deeper/deep.txt`]), done);
      await p.evaluate(() => { location.hash = '#/pick?t=2'; }); await p.waitForSelector('.files-view.picker .files-row', { timeout: 15000 }); await p.waitForTimeout(600);
      ok(L('a new request opens in the folder last picked from'), (await p.textContent('.files-title')) === 'Sub', await p.textContent('.files-title'));
    } else {
      await p.evaluate(() => window.__back()); await p.waitForTimeout(500);
      ok(L('Back: up again, to the top'), !!(await p.$('.files-view.picker')) && (await p.textContent('.files-title')) === 'Kurokawa');
      await p.evaluate(() => window.__back()); await p.waitForTimeout(600);
      const done = await p.evaluate(() => window.__done);
      ok(L('Back at the top: cancelled — nothing handed back, the picker left'), done.length === 1 && done[0].paths.length === 0 && done[0].id === 'r2' && !(await p.$('.files-view.picker')), done);
    }
  }
  ok(L('no page errors'), !errors.filter((e) => !/favicon/.test(e)).length, errors);
  await p.close();
}

(async () => {
  logic();
  const z = await F.zipListing(); const web = await F.serve(); const port = web.address().port; const browser = await chromium.launch();
  await page(browser, port, z, 'en', false); await page(browser, port, z, 'en', true); await page(browser, port, z, 'ar', true);
  await browser.close(); web.close();
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
