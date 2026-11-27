// node tests/pickwalk.cjs : the Files page as another app's picker (Android: KtPickActivity → #/pick), walked the way a
// thumb does it (CDP touch at 360x800 and 412x915), in en and ar, for every shape of request another app can make:
// one file of any kind, a picture, a PDF, several texts, several pictures or videos, a PICK that names only a media
// collection (no type), a request with no asking app's name, and no request at all. For each: the screen says what is
// asked and by whom; only fitting files can be confirmed; the count and the Add button's state; the answer the page
// gives (pickDone: the request's mark and the paths, in order; none for a cancel) by the button, ×, Back at the top
// (the system's Back and the back gesture arrive as the same event); a second request arriving while one is open; the
// asking app gone; a chosen file gone; a cold start with a request waiting; each control twice quickly; targets of
// 40 px at least, equal button widths, no sideways scroll. The plugin is the made-up phone of tests/filesphone-fixture.cjs.
// Env: WALK_ONLY=<case,…>  WALK_SHOTS=<dir>  (D5 screenshots: D5-pick-one.png, D5-pick-many-ar.png, D5-imp-*.png)
const { chromium } = require('playwright'); const path = require('node:path'); const fs = require('node:fs'); const os = require('node:os');
const F = require('./filesphone-fixture.cjs'); const { K, SD } = F;
const SHOTS = process.env.WALK_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'kt-pickwalk-'));
const ONLY = process.env.WALK_ONLY ? process.env.WALK_ONLY.split(',') : null;
let fails = 0, passes = 0; const faultLog = [];
const ok = (n, c, x) => { if (c) passes++; else { fails++; faultLog.push(n); } console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 400))); };
setTimeout(() => { console.log('FAIL timed out'); process.exit(1); }, 600000).unref();
const want = (c) => !ONLY || ONLY.includes(c);
const GA = 'android.intent.action.GET_CONTENT', PK = 'android.intent.action.PICK';

/** The made-up asking app's requests (names made up). */
const REQ = {
  any: { id: 'q-any', action: GA, multiple: false, mimes: [], caller: 'Note Maker' },
  image: { id: 'q-img', action: GA, multiple: false, mimes: ['image/*'], caller: 'Photo Frame' },
  pdf: { id: 'q-pdf', action: GA, multiple: false, mimes: ['application/pdf'], caller: 'Paper Desk' },
  texts: { id: 'q-txt', action: GA, multiple: true, mimes: ['text/*'], caller: 'Subtitle Studio' },
  media: { id: 'q-med', action: GA, multiple: true, mimes: ['image/*', 'video/*'], caller: 'Album Maker' },
  pickData: { id: 'q-pd', action: PK, multiple: false, mimes: [], data: 'content://media/external/images/media', caller: 'Wall Setter' },
  nameless: { id: 'q-nn', action: GA, multiple: false, mimes: ['image/*'], caller: '' },
};

/** A tap by touch (CDP), at an element's centre. */
async function tap(p, sel) {
  const loc = typeof sel === 'string' ? p.locator(sel).first() : sel;
  // (a row is brought to the middle first: the fixed bar at the bottom would take a tap meant for a row under it)
  await loc.evaluate((e) => { if (e.closest('.files-row')) e.scrollIntoView({ block: 'center' }); }, null, { timeout: 5000 });
  const box = await loc.boundingBox({ timeout: 5000 }); if (!box) throw new Error('no box for ' + sel);
  const cdp = await p.context().newCDPSession(p); const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach();
}
const until = async (p, fn, arg, ms = 4000) => { try { await p.waitForFunction(fn, arg, { timeout: ms }); return true; } catch { return false; } };

async function openPick(browser, z, { lang, width, height, req, start = '#/', cold = false, extra }) {
  const { page: p, errors } = await F.open(browser, { lang, pc: false, z, width, height, dense: true });
  await p.addInitScript(({ req, K }) => {
    const kt = window.Capacitor.Plugins.KurokawaTools; window.__done = []; window.__req = req;
    kt.pickRequest = async () => ({ request: window.__req ? JSON.stringify(window.__req) : null });
    kt.pickDone = async (o) => {
      window.__done.push(o);
      if (window.__gone) throw new Error('no request');
      if (window.__vanish && o.paths.some((x) => x === window.__vanish)) { window.__done.pop(); return { refused: [window.__vanish], why: 'gone' }; }
      if (window.__req && window.__req.id === o.id) window.__req = null; // (answered: no longer waiting; an answer for another request changes nothing — KtPlugin.pickDone)
    };
    // (Pictures and a video beside the fixture's files: what an «image/*» or «video/*» request is for.)
    const put = window.__put; put(`${K}/Camera`, true); for (let i = 1; i <= 6; i++) put(`${K}/Camera/shot-${i}.jpg`, false, 2e6 + i); put(`${K}/Camera/clip.mp4`, false, 4e7); put(`${K}/paper.pdf`, false, 3e5);
    put(`${K}/${'‮'}gnp.exe`, false, 10);
  }, { req, K });
  if (extra) await p.addInitScript(extra);
  await p.goto(`http://localhost:${browser.__port}/${cold ? '#/pick?t=1' : start}`);
  if (!cold && start === '#/') { await p.waitForTimeout(500); await p.evaluate(() => { location.hash = '#/pick?t=1'; }); }
  return { p, errors };
}
const head = (p) => p.$eval('.pick-head', (e) => e.innerText.replace(/\s+/g, ' ')).catch(() => '');
const row = (p, name) => p.locator(`.files-view.picker .files-row:has(.files-name[title="${name}"])`).first();
const done = (p) => p.evaluate(() => window.__done);
async function intoFolder(p, name) { await tap(p, row(p, name)); await until(p, (n) => document.querySelector('.files-view.picker .files-title')?.textContent === n, name); }
async function layoutChecks(p, L) {
  const lay = await p.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
    const small = [...document.querySelectorAll('.files-view.picker button, .files-view.picker .files-row, .pick-bar button, .pick-head label, .pick-recent button')].filter(vis).map((e) => { const r = e.getBoundingClientRect(); return [e.className || e.tagName, Math.round(r.width), Math.round(r.height)]; }).filter(([, w, hh]) => w < 40 || hh < 40);
    const bar = [...document.querySelectorAll('.pick-bar button')].filter(vis).map((b) => Math.round(b.getBoundingClientRect().width));
    return { small, bar, over: document.documentElement.scrollWidth - window.innerWidth };
  });
  ok(`${L} targets ≥ 40 px`, !lay.small.length, lay.small.slice(0, 6));
  ok(`${L} the bar's buttons of equal width`, lay.bar.length < 2 || Math.max(...lay.bar) - Math.min(...lay.bar) <= 1, lay.bar);
  ok(`${L} no sideways scroll`, lay.over <= 1, lay.over);
}

async function walk(browser, z, lang, width, height) {
  const L0 = `[${lang} ${width}]`; const ar = lang === 'ar';
  // ---- one file, any kind
  if (want('any')) {
    const { p, errors } = await openPick(browser, z, { lang, width, height, req: REQ.any }); const L = `${L0} any:`;
    await p.waitForSelector('.files-view.picker .files-row', { timeout: 15000 }); await p.waitForTimeout(400);
    const hd = await head(p);
    ok(`${L} says one file, for whom, no kinds`, ar ? /اختر ملفًّا/.test(hd) && /Note Maker/.test(hd) && !/المطلوب/.test(hd) : /Choose a file/.test(hd) && /For Note Maker/.test(hd) && !/Wanted/.test(hd), hd);
    ok(`${L} no show-all switch when any kind will do`, !(await p.$('.pick-head .pick-all')));
    await layoutChecks(p, L);
    await tap(p, row(p, 'Song.mp3')); await tap(p, row(p, 'Song.mp3')).catch(() => undefined); await p.waitForTimeout(500);
    const d = await done(p);
    ok(`${L} one tap hands it back at once; a second quick tap hands nothing more`, d.length === 1 && d[0].id === 'q-any' && JSON.stringify(d[0].paths) === JSON.stringify([`${K}/Song.mp3`]), d);
    ok(`${L} the picker left`, await until(p, () => !document.querySelector('.files-view.picker')));
    ok(`${L} no page errors`, !errors.length, errors); await p.close();
  }
  // ---- one picture (the improvement: the pictures shown as pictures)
  if (want('image')) {
    const { p, errors } = await openPick(browser, z, { lang, width, height, req: REQ.image }); const L = `${L0} image:`;
    await p.waitForSelector('.files-view.picker .files-row', { timeout: 15000 }); await p.waitForTimeout(300);
    const hd = await head(p);
    ok(`${L} says a picture, for whom`, ar ? /اختر ملفًّا/.test(hd) && /Photo Frame/.test(hd) && /الصور|صور/.test(hd) : /Choose a file/.test(hd) && /For Photo Frame/.test(hd) && /Images/.test(hd), hd);
    await intoFolder(p, 'Camera');
    ok(`${L} a pictures-only request shows a grid of pictures`, await p.$eval('.files-view.picker .files-list', (e) => /grid/.test(e.className)).catch(() => false), await p.$eval('.files-view.picker .files-list', (e) => e.className).catch(() => ''));
    ok(`${L} the video greyed`, await row(p, 'clip.mp4').evaluate((e) => e.classList.contains('pick-off')));
    await tap(p, row(p, 'clip.mp4')); await p.waitForTimeout(300);
    ok(`${L} the video refused with a reason, nothing handed`, (await done(p)).length === 0 && (await p.$$eval('.toast', (ts) => ts.map((x) => x.textContent))).length > 0);
    await layoutChecks(p, L);
    if (lang === 'en' && width === 412) await p.screenshot({ path: path.join(SHOTS, 'D5-pick-one.png') });
    if (lang === 'en' && width === 412) await p.screenshot({ path: path.join(SHOTS, 'D5-imp-1.png') });
    await tap(p, row(p, 'shot-2.jpg')); await p.waitForTimeout(400);
    const d = await done(p);
    ok(`${L} the picture handed back with the request's mark`, d.length === 1 && d[0].id === 'q-img' && d[0].paths[0] === `${K}/Camera/shot-2.jpg`, d);
    // the last folder, per asking app (improvement 2): another app opens where it last picked, Photo Frame in Camera
    await p.evaluate(() => { window.__req = { id: 'q-pdf2', action: 'android.intent.action.GET_CONTENT', multiple: false, mimes: ['application/pdf'], caller: 'Paper Desk' }; window.__done = []; location.hash = '#/pick?t=7'; });
    await p.waitForSelector('.files-view.picker .files-row', { timeout: 15000 }); await p.waitForTimeout(300);
    const t2 = await p.textContent('.files-view.picker .files-title').catch(() => '');
    ok(`${L} an app that never asked opens where the last pick was made (Camera)`, t2 === 'Camera', t2);
    for (let i = 0; i < 3 && !(await row(p, 'paper.pdf').count()); i++) { await p.evaluate(() => window.__back()); await p.waitForTimeout(400); }
    await tap(p, row(p, 'paper.pdf')); await p.waitForTimeout(400);
    await p.evaluate(() => { window.__req = { id: 'q-img2', action: 'android.intent.action.GET_CONTENT', multiple: false, mimes: ['image/*'], caller: 'Photo Frame' }; window.__done = []; location.hash = '#/pick?t=8'; });
    await p.waitForSelector('.files-view.picker .files-row', { timeout: 15000 }); await p.waitForTimeout(300);
    const t3 = await p.textContent('.files-view.picker .files-title').catch(() => '');
    ok(`${L} Photo Frame asks again: opens in Camera, where it last picked`, t3 === 'Camera', t3);
    if (lang === 'en' && width === 412) await p.screenshot({ path: path.join(SHOTS, 'D5-imp-2.png') });
    await tap(p, row(p, 'shot-3.jpg')); await p.waitForTimeout(400);
    await p.evaluate(() => { window.__req = { id: 'q-pdf3', action: 'android.intent.action.GET_CONTENT', multiple: false, mimes: ['application/pdf'], caller: 'Paper Desk' }; window.__done = []; location.hash = '#/pick?t=9'; });
    await p.waitForSelector('.files-view.picker .files-row', { timeout: 15000 }); await p.waitForTimeout(300);
    const t4 = await p.textContent('.files-view.picker .files-title').catch(() => '');
    ok(`${L} Paper Desk asks again: its own folder (Kurokawa), not Photo Frame's last`, t4 === 'Kurokawa', t4);
    // recent folders picked from (improvement 3): a row of them, a tap goes there
    const rec = await p.$$eval('.pick-recent button', (b) => b.map((x) => x.textContent)).catch(() => []);
    ok(`${L} the folders picked from lately, as a row`, rec.some((x) => /Camera/.test(x)) && rec.some((x) => /Kurokawa/.test(x)), rec);
    if (rec.length) { await tap(p, p.locator('.pick-recent button', { hasText: 'Camera' }).first()); await p.waitForTimeout(500); ok(`${L} a recent folder tapped: there`, (await p.textContent('.files-view.picker .files-title').catch(() => '')) === 'Camera'); }
    if (lang === 'en' && width === 412) { await p.evaluate(() => window.__back()); await p.waitForTimeout(400); await p.screenshot({ path: path.join(SHOTS, 'D5-imp-3.png') }); }
    ok(`${L} no page errors`, !errors.length, errors); await p.close();
  }
  // ---- one PDF; a bidi-control name; a request without a name
  if (want('pdf')) {
    const { p, errors } = await openPick(browser, z, { lang, width, height, req: REQ.pdf }); const L = `${L0} pdf:`;
    await p.waitForSelector('.files-view.picker .files-row', { timeout: 15000 }); await p.waitForTimeout(300);
    const hd = await head(p); ok(`${L} «PDF» named`, /PDF/.test(hd) && /Paper Desk/.test(hd), hd);
    ok(`${L} photo.jpg greyed, paper.pdf not`, await row(p, 'photo.jpg').evaluate((e) => e.classList.contains('pick-off')) && !(await row(p, 'paper.pdf').evaluate((e) => e.classList.contains('pick-off'))));
    // (Show all: a file of another kind may be handed on purpose — the switch, twice quickly, ends where it began.)
    const sw = '.pick-head .pick-all input'; await tap(p, sw); await tap(p, sw); await p.waitForTimeout(250);
    ok(`${L} Show all twice quickly: back off, photo greyed again`, await row(p, 'photo.jpg').evaluate((e) => e.classList.contains('pick-off')) && !(await p.$eval(sw, (e) => e.checked)));
    ok(`${L} Show all is a switch, not a plain box`, await p.$eval(sw, (e) => getComputedStyle(e).appearance === 'none' || e.getAttribute('role') === 'switch'));
    // a file gone between the list and the tap (Android says «gone»)
    await p.evaluate((k) => { window.__vanish = `${k}/paper.pdf`; }, K); await tap(p, row(p, 'paper.pdf')); await p.waitForSelector('.pick-refused:not([hidden])', { timeout: 3000 }).catch(() => undefined);
    const note = await p.textContent('.pick-refused').catch(() => '');
    ok(`${L} a vanished file: said it is no longer there (not «no link»), still picking`, (ar ? /لم يعد|لم يَعُد/.test(note) : /no longer there/.test(note)) && !!(await p.$('.files-view.picker')), note);
    ok(`${L} no page errors`, !errors.length, errors); await p.close();
  }
  if (want('nameless')) {
    const { p, errors } = await openPick(browser, z, { lang, width, height, req: REQ.nameless }); const L = `${L0} nameless:`;
    await p.waitForSelector('.files-view.picker .files-row', { timeout: 15000 }); const hd = await head(p);
    ok(`${L} no «For …» when the asking app is unnamed, no empty «⁨⁩»`, !/For |لتطبيق/.test(hd) && !/«⁨⁩»/.test(hd), hd);
    ok(`${L} no page errors`, !errors.length, errors); await p.close();
  }
  // ---- PICK naming only a media collection: pictures wanted
  if (want('pickData')) {
    const { p, errors } = await openPick(browser, z, { lang, width, height, req: REQ.pickData }); const L = `${L0} pickData:`;
    await p.waitForSelector('.files-view.picker .files-row', { timeout: 15000 }); await p.waitForTimeout(300); const hd = await head(p);
    ok(`${L} a PICK on the pictures collection asks for pictures`, (ar ? /الصور|صور/.test(hd) : /Images/.test(hd)) && await row(p, 'Song.mp3').evaluate((e) => e.classList.contains('pick-off')), hd);
    ok(`${L} no page errors`, !errors.length, errors); await p.close();
  }
  // ---- several texts: the count, Add's state, order, cancel paths, twice quickly
  if (want('texts')) {
    const { p, errors } = await openPick(browser, z, { lang, width, height, req: REQ.texts }); const L = `${L0} texts:`;
    await p.waitForSelector('.files-view.picker .files-row', { timeout: 15000 }); await p.waitForTimeout(300);
    const st0 = await p.evaluate(() => [document.querySelector('.pick-bar .pick-count')?.textContent, document.querySelector('.pick-bar .btn.primary')?.disabled]);
    ok(`${L} nothing chosen: said, Add off`, st0[1] === true && !!st0[0], st0);
    await intoFolder(p, 'Sub'); await tap(p, row(p, 'in.txt')); await intoFolder(p, 'Deeper'); await tap(p, row(p, 'deep.txt')); await p.waitForTimeout(200);
    const st = await p.evaluate(() => [document.querySelector('.pick-bar .pick-count')?.textContent, document.querySelector('.pick-bar .btn.primary')?.textContent, document.querySelector('.pick-bar .btn.primary')?.disabled]);
    ok(`${L} two chosen: the count${ar ? ' as «العدد: 2» (said once, beside Add)' : ''}, Add${ar ? '' : ' (2)'} on`, st[2] === false && (ar ? /العدد: 2/.test(st[0]) && /إضافة/.test(st[1]) : /2 files/.test(st[0]) && /Add \(2\)/.test(st[1])), st);
    ok(`${L} the count shown whole, not cut`, await p.$eval('.pick-bar .pick-count', (e) => e.scrollWidth <= e.clientWidth + 1));
    await layoutChecks(p, L);
    if (lang === 'ar' && width === 412) await p.screenshot({ path: path.join(SHOTS, 'D5-pick-many-ar.png') });
    // a chosen one tapped twice quickly: chosen again, the count back where it was
    await tap(p, row(p, 'deep.txt')); await tap(p, row(p, 'deep.txt')); await p.waitForTimeout(200);
    ok(`${L} a row tapped twice quickly: still chosen, two in all`, ar ? /العدد: 2/.test(await p.textContent('.pick-bar .pick-count')) : /2 files/.test(await p.textContent('.pick-bar .pick-count')));
    // Back walks up, keeping the choice
    await p.evaluate(() => window.__back()); await p.waitForTimeout(400);
    ok(`${L} Back: up a folder, the choice kept`, (await p.textContent('.files-view.picker .files-title')) === 'Sub' && (ar ? /العدد: 2/ : /2 files/).test(await p.textContent('.pick-bar .pick-count')));
    // Add twice quickly: one answer, in the order chosen
    await tap(p, '.pick-bar .btn.primary'); await tap(p, '.pick-bar .btn.primary').catch(() => undefined); await p.waitForTimeout(500);
    const d = await done(p);
    ok(`${L} Add twice quickly: one answer, both, in order`, d.length === 1 && d[0].id === 'q-txt' && JSON.stringify(d[0].paths) === JSON.stringify([`${K}/Sub/in.txt`, `${K}/Sub/Deeper/deep.txt`]), d);
    ok(`${L} no page errors`, !errors.length, errors); await p.close();
  }
  // ---- several pictures/videos: cancel by the button, by ×, by Back at the top
  if (want('cancel')) {
    for (const how of ['button', 'x', 'back']) {
      const { p, errors } = await openPick(browser, z, { lang, width, height, req: REQ.media }); const L = `${L0} cancel by ${how}:`;
      await p.waitForSelector('.files-view.picker .files-row', { timeout: 15000 }); await p.waitForTimeout(300);
      await intoFolder(p, 'Camera'); await tap(p, row(p, 'shot-1.jpg')); await tap(p, row(p, 'clip.mp4')); await p.waitForTimeout(150);
      if (how === 'button') { await tap(p, '.pick-bar .btn.text'); await tap(p, '.pick-bar .btn.text').catch(() => undefined); }
      else if (how === 'x') await tap(p, '.files-view.picker .pick-close');
      else { await p.evaluate(() => window.__back()); await p.waitForTimeout(300); await p.evaluate(() => window.__back()); }
      await p.waitForTimeout(500); const d = await done(p);
      ok(`${L} nothing handed back, once, with the mark`, d.length === 1 && d[0].paths.length === 0 && d[0].id === 'q-med', d);
      ok(`${L} the picker left`, !(await p.$('.files-view.picker')));
      ok(`${L} no page errors`, !errors.length, errors); await p.close();
    }
  }
  // ---- a second request while the first is open: the screen and the answer are the second's
  if (want('second')) {
    const { p, errors } = await openPick(browser, z, { lang, width, height, req: REQ.texts }); const L = `${L0} second request:`;
    await p.waitForSelector('.files-view.picker .files-row', { timeout: 15000 }); await p.waitForTimeout(300);
    await intoFolder(p, 'Sub'); await tap(p, row(p, 'in.txt'));
    await p.evaluate((r) => { window.__req = r; location.hash = '#/pick?t=2'; }, REQ.image);
    await p.waitForTimeout(900); await p.waitForSelector('.files-view.picker .files-row', { timeout: 15000 });
    const hd = await head(p);
    ok(`${L} the screen now says the second request`, /Photo Frame/.test(hd) && !/Subtitle Studio/.test(hd), hd);
    ok(`${L} the first one's choice is not carried over`, !(await p.$('.pick-bar .pick-count.has')));
    const d0 = await done(p);
    ok(`${L} the first request answered «none» with its own mark (Android cancels it too)`, d0.some((x) => x.id === 'q-txt' && !x.paths.length), d0);
    await p.evaluate(() => { window.__done = []; }); if (await row(p, 'photo.jpg').count()) await tap(p, row(p, 'photo.jpg')); await p.waitForTimeout(400);
    const d = await done(p);
    ok(`${L} the pick answers the second request`, d.length === 1 && d[0].id === 'q-img' && d[0].paths[0] === `${K}/photo.jpg`, d);
    ok(`${L} no page errors`, !errors.length, errors); await p.close();
  }
  // ---- the asking app no longer waits
  if (want('gone')) {
    const { p, errors } = await openPick(browser, z, { lang, width, height, req: REQ.image, extra: () => { window.__gone = true; } }); const L = `${L0} asker gone:`;
    await p.waitForSelector('.files-view.picker .files-row', { timeout: 15000 }); await p.waitForTimeout(300);
    await tap(p, row(p, 'photo.jpg')); await p.waitForTimeout(600);
    const toasts = await p.$$eval('.toast', (ts) => ts.map((x) => x.textContent));
    ok(`${L} said: the app that asked is no longer waiting`, toasts.some((x) => (ar ? /لم يعد .*ينتظر/ : /no longer waiting/).test(x)), toasts);
    ok(`${L} no page errors`, !errors.length, errors); await p.close();
  }
  // ---- a cold start: the app opened by the request, the hand-over's hash lost
  if (want('cold')) {
    const { p, errors } = await openPick(browser, z, { lang, width, height, req: REQ.image, start: '#/files' }); const L = `${L0} cold start:`;
    const got = await until(p, () => !!document.querySelector('.files-view.picker .files-row'), undefined, 8000);
    ok(`${L} a request waiting at start opens the picker by itself`, got, await p.evaluate(() => location.hash));
    ok(`${L} no page errors`, !errors.length, errors); await p.close();
  }
  // ---- no request
  if (want('none')) {
    const { p, errors } = await openPick(browser, z, { lang, width, height, req: null, cold: true }); const L = `${L0} nothing asked:`;
    await p.waitForSelector('.empty', { timeout: 15000 }); const tx = await p.textContent('.empty');
    ok(`${L} says nobody is waiting, a way out`, !!tx && !!(await p.$('.empty .btn')), tx);
    await layoutChecks(p, L);
    ok(`${L} no page errors`, !errors.length, errors); await p.close();
  }
}

(async () => {
  const z = await F.zipListing(); const web = await F.serve(); const browser = await chromium.launch(); browser.__port = web.address().port;
  const t0 = Date.now();
  for (const [lang, w, hgt] of [['en', 360, 800], ['ar', 360, 800], ['en', 412, 915], ['ar', 412, 915]]) await walk(browser, z, lang, w, hgt);
  await browser.close(); web.close();
  console.log(`pickwalk: ${passes} ok, ${fails} failed, ${Math.round((Date.now() - t0) / 1000)} s; shots in ${SHOTS}`);
  if (fails) console.log('faults:\n  ' + faultLog.join('\n  '));
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
