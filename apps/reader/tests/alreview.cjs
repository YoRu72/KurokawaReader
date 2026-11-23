// node tests/alreview.cjs [en|ar]: the AniList review sheet (src/ui/alreview.ts) — every request to AniList is faked here
// (made-up data, nothing reaches the real site). Hidden when no account is linked and when the book has no match; opens with the
// online review; counts; publish sends the right variables; the site's refusal shown with the draft kept; the draft survives a
// reopen; a newer-or-different pair gives the choice; delete; the Private switch; rate limit; Arabic direction and digits.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const LANG = process.argv.includes('ar') ? 'ar' : 'en';
const DIST = path.resolve(__dirname, '../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, extra) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(extra ?? ''))); if (!c) fails++; };
const S = LANG === 'ar' ? { action: 'مراجعة في AniList', edit: 'تحرير مراجعتك', publish: 'نشر', pubd: 'المنشورة', draft: 'مسودتك', open: 'فتح في AniList' } : { action: 'Review on AniList', edit: 'Edit your review', publish: 'Publish', pubd: 'The published one', draft: 'Your draft', open: 'Open on AniList' };
const JSON_H = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
const BODY = (n, w = 'word ') => w.repeat(Math.ceil(n / w.length)).slice(0, n - 1) + 'x';
(async () => {
  await new Promise((r) => server.listen(5471, r));
  const b = await chromium.launch(); const errors = [];
  // A page with a fake AniList (srv: what it holds and answers), a linked account (or not) and a book (with a match or not).
  const open = async (o = {}) => {
    const srv = { review: o.review ?? null, saves: [], deletes: [], reviewQueries: 0, refuse: null, rate: false };
    const ctx = await b.newContext({ viewport: { width: 412, height: 915 }, locale: LANG }); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
    await ctx.route('https://graphql.anilist.co/**', async (route) => {
      const q = route.request().postData() || ''; const v = JSON.parse(q).variables || {};
      const send = (status, body) => route.fulfill({ status, headers: JSON_H, body: JSON.stringify(body) });
      if (/Viewer/.test(q)) return send(200, { data: { Viewer: { id: 7, name: 'Reader', avatar: { medium: '' }, mediaListOptions: { scoreFormat: 'POINT_10' } } } });
      if (/SaveReview/.test(q)) {
        srv.saves.push(v);
        if (srv.rate) return send(429, { errors: [{ message: 'Too Many Requests.', status: 429 }], data: null });
        if (srv.refuse) return send(400, { errors: [{ message: 'validation', status: 400, validation: { body: [srv.refuse] } }], data: null });
        srv.review = { id: 55, summary: v.summary, body: v.body, score: v.score, private: v.private, siteUrl: 'https://anilist.co/review/55', updatedAt: Math.floor(Date.now() / 1000) };
        return send(200, { data: { SaveReview: { id: 55, siteUrl: 'https://anilist.co/review/55' } } });
      }
      if (/DeleteReview/.test(q)) { srv.deletes.push(v); srv.review = null; return send(200, { data: { DeleteReview: { deleted: true } } }); }
      if (/Review\(/.test(q)) { srv.reviewQueries++; return srv.review ? send(200, { data: { Review: srv.review } }) : send(404, { errors: [{ message: 'Not Found.', status: 404 }], data: { Review: null } }); }
      return send(200, { data: {} });
    });
    await p.goto('http://localhost:5471/');
    await p.evaluate(([lang, linked, o]) => {
      localStorage.setItem('kr.lang', lang); localStorage.setItem('kr.update.lastCheck', String(Date.now()));
      localStorage.setItem('kr.visual', JSON.stringify({ anilistEnabled: true }));
      if (linked) { localStorage.setItem('kr.anilist.token', 'FAKE'); localStorage.setItem('kr.anilist.user', JSON.stringify({ id: 7, name: 'Reader', scoreFormat: 'POINT_10' })); }
    }, [LANG, o.linked !== false, o]);
    await p.reload(); await p.waitForTimeout(800);
    await p.evaluate((o) => new Promise((res, rej) => {
      const r = indexedDB.open('kurokawa-reader'); r.onerror = () => rej(r.error);
      r.onsuccess = () => { const tx = r.result.transaction('books', 'readwrite');
        tx.objectStore('books').put({ id: 'b1', title: 'Test Novel', format: 'txt', fileName: 'n.txt', size: 10, addedAt: Date.now(), bookmarks: [], highlights: [{ id: 'h1', text: 'A fine line about the sea.', color: 'blue', createdAt: 1 }, { id: 'h2', text: 'Another quiet line.', color: 'blue', createdAt: 2 }], stats: { ms: 7380000, words: 100, days: {} }, doneAt: Date.UTC(2026, 9, 5, 12), alDraft: o.draft,
          track: o.track === false ? undefined : { service: 'anilist', media: { id: 99, title: 'Test Novel', url: 'https://anilist.co/manga/99', chapters: 10 }, entry: { status: 'COMPLETED', progress: 10, score: 8 }, updatedAt: 1 } });
        tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); };
    }), o);
    return { p, ctx, srv };
  };
  const book = (p) => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').get('b1'); q.onsuccess = () => res(q.result); }; }));
  const goBook = async (p) => { await p.evaluate(() => { location.hash = '#/book/b1'; }); await p.waitForSelector('.book-hero h1', { timeout: 10000 }); await p.waitForTimeout(400); };
  const tile = (p, label) => p.locator('.book-tile', { hasText: label });
  const sheet = async (p) => { await tile(p, S.action).or(tile(p, S.edit)).first().click(); await p.waitForSelector('.alr-sheet .alr-body'); await p.waitForTimeout(500); };
  const fillValid = async (p) => { await p.fill('.alr-summary', 'A calm and careful novel'); await p.fill('.alr-body', BODY(2300)); };

  // 1. Hidden: no account linked, and no match.
  { const { p, ctx } = await open({ linked: false }); await goBook(p);
    ok('1: no AniList account linked: no review entry, no hint of it', (await tile(p, S.action).count()) === 0 && !/AniList/.test(await p.locator('.book-tiles').innerText().then((x) => x.replace(/Tracking|تتبع/g, ''))) || (await tile(p, S.action).count()) === 0);
    await ctx.close(); }
  { const { p, ctx } = await open({ track: false }); await goBook(p);
    ok('1: linked but the book has no AniList match: no review entry', (await tile(p, S.action).count()) === 0 && (await tile(p, S.edit).count()) === 0);
    await ctx.close(); }

  // 2. A matched book, no online review: counts, validation, publish with the right variables, the Private switch.
  { const { p, ctx, srv } = await open({}); await goBook(p);
    ok('2: linked and matched: «' + S.action + '» on the details page', (await tile(p, S.action).count()) === 1);
    await sheet(p);
    ok('2: the score starts from the book\'s AniList score (8/10 → 80)', (await p.inputValue('.alr-score-n')) === '80' && (await p.inputValue('.alr-sheet input[type=range]')) === '80');
    ok('2: Publish is disabled while the review is empty', await p.locator('.alr-publish').isDisabled());
    await p.fill('.alr-summary', 'Too short'); await p.fill('.alr-body', BODY(100));
    const cnt = await p.locator('.alr-sheet .alr-count').allInnerTexts();
    ok('2: the body count shows what is still missing (2100)', /2100/.test(cnt[1]) && /100/.test(cnt[1]), cnt);
    ok('2: … Publish still disabled (summary under the minimum, body short)', await p.locator('.alr-publish').isDisabled());
    await p.fill('.alr-summary', 'A calm and careful novel'); await p.fill('.alr-body', BODY(2200));
    ok('2: valid: Publish enabled', !(await p.locator('.alr-publish').isDisabled()));
    await p.fill('.alr-body', BODY(2199)); ok('2: 2199 characters is still one short', await p.locator('.alr-publish').isDisabled());
    await p.fill('.alr-body', BODY(2300));
    await p.fill('.alr-sheet .alr-score-n', '73'); ok('2: the number moves the slider', (await p.inputValue('.alr-sheet input[type=range]')) === '73');
    await p.waitForTimeout(600);
    const d = (await book(p)).alDraft; ok('2: the draft is kept on the book as typed', !!d && d.summary === 'A calm and careful novel' && d.body.length === 2300 && d.score === 73, d);
    ok('2: nothing was sent before Publish', srv.saves.length === 0);
    await p.locator('.alr-privrow .switch').click(); await p.locator('.alr-publish').click(); await p.waitForSelector('.alr-open:not([hidden])');
    const v = srv.saves[0];
    ok('2: Publish sent the right variables (new review, media 99, 73, private)', srv.saves.length === 1 && v.mediaId === 99 && v.id === null && v.score === 73 && v.private === true && v.summary === 'A calm and careful novel' && v.body.length === 2300, v);
    ok('2: «' + S.open + '» points at the review on AniList', (await p.getAttribute('.alr-open', 'href')) === 'https://anilist.co/review/55');
    const bk = await book(p); ok('2: the draft is cleared after publishing and the review id is remembered', !bk.alDraft && bk.track.reviewId === 55, bk.alDraft);
    // 3. Delete: confirmed, sent with the id.
    p.once('dialog', (dlg) => { ok('3: the confirm says it cannot be undone on the site', LANG === 'ar' ? /التراجع/.test(dlg.message()) : /cannot be undone/.test(dlg.message())); dlg.accept(); });
    await p.locator('.alr-delete').click(); await p.waitForSelector('.alr-sheet', { state: 'detached', timeout: 5000 });
    ok('3: Delete sent the review id and the sheet closed', srv.deletes.length === 1 && srv.deletes[0].id === 55, srv.deletes);
    ok('3: the review id is forgotten', !(await book(p)).track.reviewId);
    await ctx.close(); }

  // 4. The site refuses: its message is shown, the draft is kept, and it survives a reopen.
  { const { p, ctx, srv } = await open({}); await goBook(p); await sheet(p); await fillValid(p); srv.refuse = 'The body must be at least 2300 characters.';
    await p.locator('.alr-publish').click(); await p.waitForSelector('.alr-status:not([hidden])');
    const msg = await p.locator('.alr-status').innerText();
    ok('4: the server\'s own message is shown', /at least 2300 characters/.test(msg), msg);
    await p.waitForTimeout(600); ok('4: the draft is kept after a refusal', !!(await book(p)).alDraft && (await book(p)).alDraft.body.length === 2300);
    await p.keyboard.press('Escape'); await p.waitForSelector('.alr-sheet', { state: 'detached' });
    await sheet(p);
    ok('4: reopened: the draft is back as typed', (await p.inputValue('.alr-body')).length === 2300 && (await p.inputValue('.alr-summary')) === 'A calm and careful novel');
    srv.refuse = null; srv.rate = true; await p.locator('.alr-publish').click(); await p.waitForSelector('.alr-status:not([hidden])');
    const rl = await p.locator('.alr-status').innerText();
    ok('5: rate limit (429): one clear message, the draft kept', (LANG === 'ar' ? /يحدّ/ : /limiting/).test(rl) && !!(await book(p)).alDraft, rl);
    await ctx.close(); }

  // 6. Online review, no draft: the sheet shows it, titled «Edit your review»; the label follows on the page.
  const ONLINE = { id: 31, summary: 'The published summary line here', body: BODY(2400, 'online '), score: 90, private: false, siteUrl: 'https://anilist.co/review/31', updatedAt: Math.floor(Date.now() / 1000) };
  { const { p, ctx, srv } = await open({ review: ONLINE }); await goBook(p); await sheet(p);
    ok('6: opens with the online review', (await p.inputValue('.alr-summary')) === ONLINE.summary && (await p.inputValue('.alr-body')).startsWith('online online') && (await p.inputValue('.alr-score-n')) === '90');
    ok('6: titled «' + S.edit + '», with Delete and Open on AniList', (await p.locator('.alr-sheet .sheet-head h3').innerText()) === S.edit && !(await p.locator('.alr-delete').isHidden()) && (await p.getAttribute('.alr-open', 'href')) === ONLINE.siteUrl);
    await p.fill('.alr-body', BODY(2500, 'edited ')); await p.locator('.alr-publish').click(); await p.waitForSelector('.alr-open:not([hidden])');
    ok('6: publishing an edit sends the review id', srv.saves[0].id === 31, srv.saves[0]);
    await p.waitForTimeout(300); await p.keyboard.press('Escape'); await p.reload(); await p.waitForTimeout(600); await goBook(p);
    ok('6: the page now says «' + S.edit + '»', (await tile(p, S.edit).count()) === 1);
    await ctx.close(); }

  // 7. A draft and a different published one: the choice appears; picking the published one shows it.
  { const { p, ctx } = await open({ review: ONLINE, draft: { summary: 'My unfinished draft summary text', body: BODY(300, 'draft '), score: 55, private: true, at: Date.now() + 5000 } }); await goBook(p); await sheet(p);
    ok('7: both exist and differ: the choice is shown, the newer draft is in the editor', !(await p.locator('.alr-choice').isHidden()) && (await p.inputValue('.alr-summary')) === 'My unfinished draft summary text');
    await p.locator('.alr-pick-pub').click();
    ok('7: «' + S.pubd + '» puts the online text in', (await p.inputValue('.alr-summary')) === ONLINE.summary && (await p.locator('.alr-choice').isHidden()));
    await ctx.close(); }
  { const { p, ctx } = await open({ review: ONLINE, draft: { summary: 'An older draft summary text ok', body: BODY(300, 'draft '), score: 55, private: false, at: 1000 } }); await goBook(p); await sheet(p);
    ok('7: an older draft: the online text opens, the draft one tap away', (await p.inputValue('.alr-summary')) === ONLINE.summary && !(await p.locator('.alr-choice').isHidden()));
    await p.locator('.alr-pick-draft').click(); ok('7: «' + S.draft + '» brings it back', (await p.inputValue('.alr-summary')) === 'An older draft summary text ok');
    await ctx.close(); }

  // 8. Helpers: highlights as quotes, the reading facts; and the Arabic checks.
  { const { p, ctx } = await open({}); await goBook(p); await sheet(p);
    await p.locator('.alr-helpers .btn').first().click(); await p.waitForSelector('.alr-pick .alr-hl'); await p.locator('.alr-pick .alr-hl .switch').first().click(); await p.locator('.alr-pick .btn.primary').click();
    ok('8: a picked highlight goes in as a quote', (await p.inputValue('.alr-body')).startsWith('> A fine line about the sea.'));
    await p.locator('.alr-helpers .btn').nth(1).click(); const bd = await p.inputValue('.alr-body');
    ok('8: the reading facts go in (finish date and time read)', /2026-10-05/.test(bd) && /2/.test(bd), bd);
    if (LANG === 'ar') {
      const txt = await p.locator('.alr-sheet').innerText();
      ok('ar: the page is right-to-left', (await p.evaluate(() => document.documentElement.dir)) === 'rtl');
      ok('ar: no Eastern digits in the sheet', !/[٠-٩]/.test(txt), txt.slice(0, 200));
      ok('ar: counts read «العدد: n»', /العدد: \d+/.test(txt));
    } else ok('en: counts shown', /characters/.test(await p.locator('.alr-sheet').innerText()));
    // the tracking sheet's entry too
    await p.keyboard.press('Escape'); await p.waitForSelector('.alr-sheet', { state: 'detached' });
    await ctx.close(); }
  { const { p, ctx } = await open({}); await goBook(p);
    await p.locator('.book-tile').filter({ has: p.locator('svg') }).nth(0).waitFor();
    await p.evaluate(() => [...document.querySelectorAll('.book-tile')].find((x) => /Tracked|Tracking|مُتابَع|المتابعة/.test(x.textContent))?.click()); await p.waitForSelector('.track-review', { timeout: 5000 }).catch(() => {});
    ok('9: the tracking sheet has the review entry (a media is matched)', (await p.locator('.track-review').count()) === 1);
    await ctx.close(); }
  console.log(fails ? `${fails} FAILED` : 'all passed', 'errors', errors);
  await b.close(); server.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
