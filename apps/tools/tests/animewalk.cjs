// node tests/animewalk.cjs [en|ar] : the Anime tabs walked against a catalogue that misbehaves on purpose. The catalogue is a
// made-up server on 127.0.0.1 (the page's requests to the real address are answered through it; every other address is
// refused). Each case is made for every tab (Discover, Search, Season, Schedule, My list, Diary), a show's page and a studio's
// page: the catalogue never answers · answers only after the budget · 429 with Retry-After 30 (the wait shown, counted down,
// cancelled, then asked again) · 500 twice then fine · a cut connection · a garbage body · an empty list · odd items (no
// title, no cover, null dates and studios, a string where a number goes) · a slow first page then fast ones · the phone going
// offline and back. The rule checked for each: the screen ends in the list, in an empty message or in a failure that says why
// with «Try again» — never in a spinner alone, never in a blank — and the page raises no error. Also: the last good list shown
// at once, marked as refreshing, when the catalogue is gone; leaving a tab cancels its waits (no request after, no late paint).
// Phone 360x800 and 412x915, computer 1280x800; English and Arabic (a lang argument runs that one only).
// The request budget is scaled down in the page (window.__ktAlScale) so a catalogue that never answers is not waited on for 30 s.
// Env: ANWALK_ONLY=<tab>,<case> (one tab / case, comma-separated lists allowed)  ANWALK_OUT=<dir> (shots and AN-faults.md)
//      ANWALK_DIST=<another build>  ANWALK_BEFORE=1 (only record what is seen after 6 s: no assertions; for an older build)
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const ROOT = path.join(__dirname, '..'); const DIST = process.env.ANWALK_DIST || path.join(ROOT, 'dist');
const OUT = process.env.ANWALK_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'kt-animewalk-'));
const ONLY = process.env.ANWALK_ONLY ? process.env.ANWALK_ONLY.split(',') : null; const BEFORE = !!process.env.ANWALK_BEFORE;
const LANGS = process.argv[2] === 'en' || process.argv[2] === 'ar' ? [process.argv[2]] : ['en', 'ar'];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
let fails = 0, passes = 0; const log = [];
const ok = (name, c, x) => { if (c) passes++; else fails++; console.log((c ? 'ok   ' : 'FAIL ') + name + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 400))); };
setTimeout(() => { console.log('FAIL timed out'); process.exit(1); }, 1500000).unref();
const NOW = Math.floor(Date.now() / 1000);

// ---- made-up shows
const mk = (i, x = {}) => ({ id: 1000 + i, idMal: 5000 + i, title: { romaji: `Show ${i}`, english: `Show ${i}`, native: `作品${i}`, userPreferred: `Show ${i}` }, synonyms: [], coverImage: { large: '', extraLarge: '', color: '#2255aa' }, bannerImage: null, format: 'TV', status: 'RELEASING', episodes: 12, duration: 24, season: 'FALL', seasonYear: 2026, startDate: { year: 2026, month: 10, day: 1 }, endDate: { year: null, month: null, day: null }, genres: ['Action'], averageScore: 60 + (i * 7) % 35, popularity: 50000 - i * 300, isAdult: false, siteUrl: `https://anilist.co/anime/${1000 + i}`, nextAiringEpisode: i % 3 === 0 ? { airingAt: NOW + 3600 * (i + 1), episode: 3 } : null, studios: { nodes: [{ id: 5, name: 'Test Studio' }] }, mediaListEntry: null, ...x });
const many = (n, from = 1) => Array.from({ length: n }, (_, k) => mk(from + k));
// Odd ones among sixteen good: nothing in the title's place, no cover, null dates / studios / genres, numbers as words, an entry with no status.
const ODD = [null, 'not a show', 7, { id: 'x' }, { id: 3001 }, { id: 3002, title: null, coverImage: null, startDate: null, studios: null, genres: null, synonyms: null, siteUrl: null },
  { id: 3003, title: { romaji: null, english: null, native: null, userPreferred: null }, averageScore: 'high', episodes: '12', format: 'WEIRD', season: 'AUTUMN', seasonYear: null, nextAiringEpisode: { airingAt: 'soon', episode: null }, mediaListEntry: { id: 1, status: null, progress: null, score: null } },
  { id: 3004, title: { romaji: 'A'.repeat(400), english: '‮ RTL ‬', native: '' }, startDate: { year: 'x', month: null }, popularity: null, averageScore: null }];
const oddList = () => [...ODD, ...many(16)];
const VALID_MIN = 16;

// ---- the stand-in catalogue: one behaviour at a time, set by the case
const S = { mode: 'ok', delay: 5000, ra: 30, fails: 2, n: 0, seen: new Map() }; const held = new Set();
const list = (mode, n = 60) => (mode === 'empty' ? [] : mode === 'odd' ? oddList() : many(n));
function answer(q, mode) {
  const text = q.query || ''; const v = q.variables || {};
  if (/airingSchedules/.test(text)) return { Page: { pageInfo: { hasNextPage: false }, airingSchedules: mode === 'empty' ? [] : mode === 'odd' ? [null, { airingAt: 'x', episode: 1, media: null }, { airingAt: NOW + 600, episode: 2, media: null }, { airingAt: NOW + 900, episode: 'two', media: { id: 4000 } }, ...many(14).map((m, k) => ({ airingAt: NOW + 600 * (k + 2), episode: 3, media: m }))] : many(14).map((m, k) => ({ airingAt: NOW + 600 * (k + 1), episode: 3, media: m })) } };
  if (/activities\(/.test(text)) return { Page: { pageInfo: { hasNextPage: false }, activities: [] } };
  if (/MediaListCollection/.test(text)) { const ms = list(mode, 14); return { MediaListCollection: { lists: mode === 'empty' ? [] : [{ entries: ms.map((m, k) => (m && typeof m === 'object' ? { id: 90 + k, status: 'CURRENT', progress: 2, score: 0, updatedAt: NOW - 5000, startedAt: null, completedAt: null, media: m } : { id: 90 + k, status: 'CURRENT', progress: 2, score: 0, media: m })).concat(mode === 'odd' ? [null, { id: 1, media: null }] : []) }] } }; }
  if (/trending: Page/.test(text)) { const l = (n, k) => ({ media: list(mode, n).map((m) => (m && typeof m === 'object' && mode === 'ok' ? { ...m, id: m.id + k } : m)) }); return { trending: l(10, 0), airing: l(10, 100), season: l(10, 200), top: l(10, 300), movies: l(10, 400) }; }
  if (/works: media/.test(text)) return { Studio: { id: 5, name: 'Test Studio', isAnimationStudio: true, favourites: 12, media: { pageInfo: { total: 30 }, nodes: [{ bannerImage: null, coverImage: { extraLarge: null, color: null } }] }, works: { pageInfo: { hasNextPage: false, total: 30 }, nodes: list(mode, 20) } } };
  if (/Media\(id: \$id, type: ANIME\)/.test(text)) return { Media: mode === 'empty' ? null : mode === 'odd' ? { id: 1001, title: null, siteUrl: null, genres: null, studios: null, relations: { edges: [null, { relationType: 'SEQUEL', node: null }] }, airingSchedule: null, streamingEpisodes: null, externalLinks: null, startDate: null, episodes: 'x' } : mk(1, { description: 'A made-up show.', relations: { edges: [] }, airingSchedule: { nodes: [] }, streamingEpisodes: [], externalLinks: [], trailer: null }) };
  if (/GenreCollection/.test(text)) return { GenreCollection: ['Action'], MediaTagCollection: [] };
  if (/perPage: 30\) \{ pageInfo/.test(text)) return { Page: { pageInfo: { hasNextPage: false }, media: list(mode, 12) } };
  if (/perPage: 50\) \{ pageInfo \{ hasNextPage \} media\(type: ANIME, season/.test(text)) { const page = v.page || 1; return { Page: { pageInfo: { hasNextPage: page < 2 && mode === 'ok' }, media: mode === 'ok' ? (page === 1 ? many(50) : many(10, 51)) : list(mode) } }; }
  if (/Page\(perPage: 50\) \{ media\(type: ANIME, season/.test(text)) return { Page: { media: list(mode, 20) } };
  return {};
}
function gql(req, res, body) {
  S.n++; let q = {}; try { q = JSON.parse(body); } catch { /* none */ } if (/season: \$season/.test(q.query || '')) S.seasonN++;
  const key = (q.query || '').slice(0, 60) + JSON.stringify(q.variables || {}); const nth = (S.seen.set(key, (S.seen.get(key) || 0) + 1), S.seen.get(key));
  const send = (status, obj, extra = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...extra }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
  const m = S.mode;
  if (m === 'never') { held.add(res); return; }
  if (m === 'slow') { setTimeout(() => { try { send(200, { data: answer(q, 'ok') }); } catch { /* gone */ } }, S.delay); return; }
  if (m === '429') return send(429, { errors: [{ message: 'Too Many Requests.', status: 429 }] }, { 'retry-after': String(S.ra) });
  if (m === '500x2' && nth <= S.fails) return send(500, { errors: [{ message: 'Internal Server Error', status: 500 }] });
  if (m === 'cut') { req.socket.destroy(); return; }
  if (m === 'garbage') return send(200, '<html><body>oops \u0000 not an answer', { 'content-type': 'text/html' });
  if (m === 'firstslow' && nth === 1) { setTimeout(() => { try { send(200, { data: answer(q, 'ok') }); } catch { /* gone */ } }, S.delay); return; }
  send(200, { data: answer(q, m === 'empty' || m === 'odd' ? m : 'ok') });
}
const web = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/graphql' && req.method === 'POST') { const b = []; req.on('data', (c) => b.push(c)); req.on('end', () => gql(req, res, Buffer.concat(b).toString())); return; }
  let p = decodeURIComponent(u); if (p === '/') p = '/index.html'; const f = path.join(DIST, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});

// ---- what is said, in each language
const SAY = {
  en: { timeout: /in time/, cut: /dropped/, busy: /busy/, server: /problem on its side/, bad: /could not be read/, offline: /offline/i, wait: /asked us to wait — (\d+) s/, cancelled: /Stopped waiting/, retry: /Try again/, refreshing: /last list we have — refreshing/, kept: /last list we have/ },
  ar: { timeout: /لم يردّ الفهرس/, cut: /انقطع الاتصال/, busy: /مشغول/, server: /مشكلة من جهة الفهرس/, bad: /تعذّرت قراءته/, offline: /غير متصل/, wait: /طلب الفهرس منّا الانتظار — (\d+) ث/, cancelled: /توقّف انتظار/, retry: /إعادة المحاولة/, refreshing: /آخر قائمة لدينا — جارٍ التحديث/, kept: /آخر قائمة لدينا/ },
};
const TABS = {
  season: { hash: '#/anime?tab=season', content: '.anime-card', auto: true }, schedule: { hash: '#/anime?tab=schedule', content: '.sched-row', auto: true },
  list: { hash: '#/anime?tab=list', content: '.anime-card', auto: true }, diary: { hash: '#/anime?tab=diary', content: '.diary', auto: true },
  discover: { hash: '#/anime?tab=discover', content: '.dc-poster', discover: true }, search: { hash: '#/anime?tab=search&q=Show', content: '.anime-card' },
  entry: { hash: '#/anime/1001', content: '.anime-head', auto: true, one: true }, studio: { hash: '#/anime/studio/5?name=Test', content: '.anime-card', auto: true },
};
const CASES = ['ok', 'empty', 'odd', 'never', 'slow', '429', '500x2', 'cut', 'garbage', 'firstslow', 'offline'];
const COMBOS = [{ w: 360, h: 800, lang: 'en', phone: true }, { w: 412, h: 915, lang: 'ar', phone: true }, { w: 1280, h: 800, lang: 'en', phone: false }, { w: 360, h: 800, lang: 'ar', phone: true }, { w: 412, h: 915, lang: 'en', phone: true }, { w: 1280, h: 800, lang: 'ar', phone: false }];

const see = (p, tab) => p.evaluate(([sel, disc]) => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const notes = [...document.querySelectorAll('.net-note')].filter(vis); const note = notes[0];
  const fail = [...document.querySelectorAll('.net-fail')].filter(vis)[0];
  const retry = [...document.querySelectorAll('.net-btn')].filter(vis).find((b) => /Try again|إعادة المحاولة/.test(b.textContent));
  const cancel = [...document.querySelectorAll('.net-note .net-btn')].filter(vis).find((b) => /Cancel|إلغاء/.test(b.textContent));
  const spin = [...document.querySelectorAll('.view .spinner')].filter(vis).length > 0; const ph = disc ? [...document.querySelectorAll('.dc-rail:not([hidden]) .dc-ph')].filter(vis).length > 0 : false;
  const empty = [...document.querySelectorAll('.empty.small, .empty:not(.net-fail)')].filter(vis).map((e) => e.textContent.trim()).filter(Boolean)[0] || '';
  const bar = document.querySelector('.view');
  return { content: [...document.querySelectorAll(sel)].filter(vis).length, noteText: note ? note.innerText.replace(/\s+/g, ' ').trim() : '', noteBad: !!note && note.classList.contains('bad'), noteWait: !!note && note.classList.contains('wait'), failText: fail ? fail.innerText.replace(/\s+/g, ' ').trim() : '', retry: !!retry, cancel: !!cancel, spinner: spin, placeholders: ph, empty, wide: document.documentElement.scrollWidth - innerWidth, text: bar ? bar.innerText.replace(/\s+/g, ' ').slice(0, 300) : '' };
}, [TABS[tab].content, !!TABS[tab].discover]);
const said = (s) => [s.failText, s.noteBad || s.noteWait ? s.noteText : ''].filter(Boolean).join(' | ');
const settledE = (p, tab, want) => settledImpl(p, tab, want);
async function settledImpl(p, tab, want) { const t0 = Date.now(); for (;;) { const s = await see(p, tab); const done = !s.spinner && !s.placeholders && (s.content > 0 || s.failText || s.noteBad || s.empty || (TABS[tab].discover && S.mode === 'empty' && S.n > 0)); if (done && (!want || want(s))) return s; if (Date.now() - t0 > 16000) return Object.assign(s, { timedOut: true }); await p.waitForTimeout(100); } }
const waitFor = async (p, tab, pred, ms = 12000) => { const t0 = Date.now(); for (;;) { const s = await see(p, tab); if (pred(s)) return s; if (Date.now() - t0 > ms) return Object.assign(s, { timedOut: true }); await p.waitForTimeout(100); } };
const clickRetry = (p) => p.evaluate(() => { const b = [...document.querySelectorAll('.net-btn')].find((x) => /Try again|إعادة المحاولة/.test(x.textContent)); if (b) b.click(); return !!b; });
const clickCancel = (p) => p.evaluate(() => { const b = [...document.querySelectorAll('.net-note .net-btn')].find((x) => /Cancel|إلغاء/.test(x.textContent)); if (b) b.click(); return !!b; });
const boxes = (p) => p.evaluate(() => [...document.querySelectorAll('.net-btn')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
const phones = (c) => (c.phone ? { viewport: { width: c.w, height: c.h }, hasTouch: true, isMobile: true } : { viewport: { width: c.w, height: c.h } });

let br;
async function newPage(combo, hold) {
  S.mode = 'ok'; S.delay = 5000; S.ra = 30; S.fails = 2; S.n = 0; S.seasonN = 0; S.seen.clear();
  const ctx = await br.newContext(phones(combo)); const base = `http://127.0.0.1:${web.address().port}`;
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, async (r) => {
    const u = new URL(r.request().url()); if (u.host !== 'graphql.anilist.co') return r.abort('blockedbyclient').catch(() => undefined);
    try {
      const resp = await fetch(base + '/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: r.request().postData() || '{}' });
      const headers = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'retry-after' }; resp.headers.forEach((v, k) => { headers[k] = v; }); delete headers['content-length']; delete headers['transfer-encoding'];
      await r.fulfill({ status: resp.status, headers, body: Buffer.from(await resp.arrayBuffer()) });
    } catch { await r.abort('connectionreset').catch(() => undefined); }
  });
  const p = await ctx.newPage(); p.setDefaultTimeout(20000); p.errors = []; p.on('pageerror', (e) => p.errors.push(e.message));
  await p.addInitScript(([lang, scale]) => {
    window.__ktAlScale = scale;
    if (!localStorage.getItem('kt.settings')) {
      localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['anime'], settingsLayout: 'list' }));
      localStorage.setItem('kt.anilist.token', 'MADE-UP-TOKEN'); localStorage.setItem('kt.anilist.user', JSON.stringify({ id: 9001, name: 'Test Viewer', scoreFormat: 'POINT_10' }));
      localStorage.setItem('kt.update.lastCheck', String(Date.now()));
    }
  }, [combo.lang, 0.1]);
  void hold; return { ctx, p, base };
}
const release = () => { for (const r of held) { try { r.destroy(); } catch { /* gone */ } } held.clear(); };

// ---- one tab, one case
async function walk(tab, cs, combo, shots) {
  const T = TABS[tab]; const say = SAY[combo.lang]; const name = `${tab} / ${cs} / ${combo.w}x${combo.h}${combo.phone ? '' : ' pc'} ${combo.lang}`;
  const { ctx, p, base } = await newPage(combo); const saw = [];
  const check = (label, c, x) => ok(`${name}: ${label}`, c, x);
  try {
    S.mode = cs === 'offline' ? 'never' : cs; if (cs === 'firstslow') S.delay = 700;
    await p.goto(base + '/' + T.hash);
    if (BEFORE) { await p.waitForTimeout(6000); const s = await see(p, tab); log.push({ tab, cs, combo, saw: `${s.spinner ? 'a spinner and nothing else' : s.content ? s.content + ' items' : s.empty || s.failText || 'blank'} after 6 s` }); return; }
    if (cs === 'offline') {
      for (let k = 0; k < 80 && S.n < 1; k++) await p.waitForTimeout(100); await ctx.setOffline(true);
      const s = await waitFor(p, tab, (s) => s.failText || s.noteBad, 10000); saw.push(`offline: ${said(s)}`);
      check('offline says offline, with Try again', say.offline.test(said(s)) && s.retry && !s.spinner, s);
      S.mode = 'ok'; await ctx.setOffline(false);
      if (!T.auto) await p.waitForTimeout(300), await clickRetry(p);
      const s2 = await waitFor(p, tab, (s) => s.content > 0 && !s.noteBad); saw.push(`back online: ${s2.content} items${T.auto ? ' by itself' : ' after Try again'}`);
      check('back online, the list appears', s2.content > 0 && !s2.timedOut, s2);
    } else {
      const s = cs === '429' ? await waitFor(p, tab, (x) => x.noteWait, 12000) : await settledE(p, tab);
      if (cs === 'ok' || cs === 'firstslow') { saw.push(`${s.content} items`); check('the list appears, no failure', s.content > 0 && !s.failText && !s.noteBad && !s.timedOut, s); }
      else if (cs === 'empty') {
        const emptyOk = T.discover || tab === 'diary' || tab === 'entry' ? true : !!s.empty; saw.push(T.discover || tab === 'diary' ? `${s.content} items, no failure` : tab === 'entry' ? `${said(s) || s.text.slice(0, 80)}` : `"${s.empty}"`);
        check('an empty list says so (no spinner, no failure)', !s.spinner && !s.timedOut && (tab === 'entry' ? s.retry : emptyOk && !s.failText && !s.noteBad), s);
      } else if (cs === 'odd') {
        const need = tab === 'entry' ? 1 : tab === 'diary' ? 1 : tab === 'schedule' ? 10 : VALID_MIN - 2; saw.push(`${s.content} items drawn, nothing blank`);
        check('odd items: the rest kept, the list not blank', (s.content >= need || (tab === 'diary' && !s.failText)) && !s.timedOut && !s.failText && !s.noteBad, s);
        if (tab === 'season') { // (the sort chip walked on to «For you», and the leftovers chip: neither blanks the list)
          for (const pick of ['sort', 'leftovers']) { await p.evaluate((w) => { const chips = [...document.querySelectorAll('.season-head .chip')]; (w === 'sort' ? chips[chips.length - 1] : chips[0]).click(); }, pick); const s3 = await settledE(p, tab); check(`odd items after the ${pick} chip`, !s3.timedOut && s3.content >= 1 && !s3.failText, s3); }
          await p.evaluate(() => { const chips = [...document.querySelectorAll('.season-head .chip')]; chips[chips.length - 1].click(); }); const s4 = await settledE(p, tab); check('odd items under «For you» (taste ordering)', !s4.timedOut && s4.content >= 1 && !s4.failText, s4);
        }
      } else if (cs === '429') {
        const m1 = say.wait.exec(s.noteText); saw.push(`wait notice: «${s.noteText}»`); check('the 429 wait is shown, counted in seconds', !!m1 && Number(m1[1]) >= 25 && Number(m1[1]) <= 31, s.noteText); check('the wait can be cancelled (button ≥ 40 px)', s.cancel && (await boxes(p)).every(([w, h]) => w >= 40 && h >= 40), s);
        await p.waitForTimeout(1300); const s1 = await see(p, tab); const m2 = say.wait.exec(s1.noteText); check('the countdown counts down', !!m1 && !!m2 && Number(m2[1]) < Number(m1[1]), [s.noteText, s1.noteText]);
        if (shots && combo.lang === 'en' && combo.phone && combo.w === 412 && tab === 'season') await p.screenshot({ path: path.join(OUT, 'AN-season-waiting-en.png') });
        await clickCancel(p); const s2 = await waitFor(p, tab, (x) => (x.failText || x.noteBad) && !x.noteWait); saw.push(`cancelled: «${said(s2)}»`);
        check('cancelled: says so, with Try again, no spinner', say.cancelled.test(said(s2)) && s2.retry && !s2.spinner, s2);
        S.mode = 'ok'; await clickRetry(p); const s3 = await waitFor(p, tab, (x) => x.content > 0 && !x.noteBad && !x.failText); check('Try again then shows the list', s3.content > 0 && !s3.timedOut, s3);
      } else {
        const kind = cs === 'never' || cs === 'slow' ? 'timeout' : cs === '500x2' ? 'server' : cs === 'cut' ? 'cut' : 'bad';
        saw.push(`«${said(s)}»${s.retry ? ' + Try again' : ''}`);
        check(`failure says why (${kind}) with Try again, no spinner`, say[kind].test(said(s)) && s.retry && !s.spinner && !s.placeholders && !s.timedOut, s);
        check('the failure fits the screen (no sideways scroll; buttons ≥ 40 px)', s.wide <= 1 && (await boxes(p)).every(([w, h]) => w >= 40 && h >= 40), [s.wide, await boxes(p)]);
        if (shots && kind === 'timeout' && combo.lang === 'ar' && combo.phone && combo.w === 412 && tab === 'season') await p.screenshot({ path: path.join(OUT, 'AN-season-error-ar.png') });
        S.mode = 'ok'; S.seen.clear(); await clickRetry(p); const s3 = await waitFor(p, tab, (x) => x.content > 0 && !x.noteBad && !x.failText); saw.push(`Try again: ${s3.content} items`); check('Try again then shows the list', s3.content > 0 && !s3.timedOut, s3);
      }
    }
    // (Offline here is the whole page's network, loopback too: a chunk of the app not yet fetched cannot come — not the app's error.)
    const errs = p.errors.filter((m) => !(cs === 'offline' && /dynamically imported module|Failed to fetch/.test(m)));
    check('no page error', errs.length === 0, errs);
  } catch (e) { check('walk ran', false, String(e && e.message || e)); } finally { release(); await ctx.close(); }
  if (!BEFORE) log.push({ tab, cs, combo, saw: saw.join(' → ') });
}

// ---- the last good list, kept and shown at once
async function cached(tab, combo, shots) {
  const T = TABS[tab]; const say = SAY[combo.lang]; const name = `${tab} cached ${combo.w}x${combo.h}${combo.phone ? '' : ' pc'} ${combo.lang}`; const { ctx, p, base } = await newPage(combo); const saw = [];
  try {
    await p.goto(base + '/' + T.hash); const s = await settledE(p, tab); ok(`${name}: first load fine`, s.content > 0 && !s.failText, s);
    await p.waitForTimeout(400); const kept = await p.evaluate(() => localStorage.getItem('kt.cache.animeLists')); ok(`${name}: the answer was kept (${kept ? kept.length : 0} chars, at most 600000)`, !!kept && kept.length <= 600000, kept && kept.length);
    S.mode = 'never'; const t0 = Date.now(); await p.reload(); const s1 = await waitFor(p, tab, (x) => x.content > 0, 3000); const ms = Date.now() - t0;
    ok(`${name}: the old list at once (${ms} ms)`, s1.content > 0 && ms < 2500, s1); ok(`${name}: marked as being refreshed`, say.refreshing.test(s1.noteText) || s1.noteWait || say.kept.test(s1.noteText), s1.noteText);
    saw.push(`${s1.content} items at once, strip «${s1.noteText}»`);
    if (shots && tab === 'season' && combo.lang === 'en' && combo.phone && combo.w === 412) await p.screenshot({ path: path.join(OUT, 'AN-season-cached-en.png') });
    const s2 = await waitFor(p, tab, (x) => x.noteBad, 12000); saw.push(`then «${s2.noteText}»`);
    ok(`${name}: the budget over, the old list stays with the reason and Try again`, s2.content > 0 && say.kept.test(s2.noteText) && s2.retry && !s2.timedOut, s2);
    if (shots && tab === 'season' && !combo.phone && combo.lang === 'en') await p.screenshot({ path: path.join(OUT, 'AN-pc-en.png') });
    S.mode = 'ok'; await clickRetry(p); const s3 = await waitFor(p, tab, (x) => x.content > 0 && !x.noteBad && !x.noteText); ok(`${name}: Try again replaces it with the new list, the strip gone`, s3.content > 0 && !s3.noteText && !s3.timedOut, s3);
    ok(`${name}: no page error`, p.errors.length === 0, p.errors);
  } catch (e) { ok(`${name}: ran`, false, String(e && e.message || e)); } finally { release(); await ctx.close(); }
  log.push({ tab, cs: 'cached (catalogue gone on the next visit)', combo, saw: saw.join(' → ') });
}

// ---- the cap of the kept lists (anime/listCache.ts run on its own with a stand-in for the device's storage)
async function cap() {
  const store = new Map(); globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); } };
  let C; try { C = await import(require('node:url').pathToFileURL(path.join(ROOT, 'src/anime/listCache.ts')).href); } catch (e) { console.log('skip  cap (this node cannot read .ts: ' + String(e.message).slice(0, 80) + ')'); return; }
  for (let i = 0; i < 30; i++) C.keep('k' + i, { r: 'x'.repeat(40000) });
  const kept = JSON.parse(store.get('kt.cache.animeLists')); const n = Object.keys(kept).length; const chars = Object.values(kept).reduce((a, e) => a + JSON.stringify(e.v).length, 0);
  ok(`cap: thirty lists of 40 000 characters kept one after another: ${n} stay (at most ${C.MAX_LISTS}), ${chars} characters (at most ${C.MAX_CHARS}); the newest is there`, n <= C.MAX_LISTS && chars <= C.MAX_CHARS && 'k29' in kept && !('k0' in kept), [n, chars]);
  C.keep('big', { r: 'y'.repeat(300000) }); ok('cap: one list over 250 000 characters is not kept', !('big' in JSON.parse(store.get('kt.cache.animeLists'))));
  ok('cap: a kept list is read back with its time', !!C.cached('k29') && typeof C.cached('k29').at === 'number' && C.cached('nothing') === null);
  store.set('kt.cache.animeLists', '{not json'); ok('cap: damaged storage reads as nothing, and is written over', C.cached('k1') === null && (C.keep('a', 1), C.cached('a').v === 1));
  delete globalThis.localStorage;
}

// ---- leaving a tab cancels its waits
async function leaving(combo) {
  const name = `leaving ${combo.w}x${combo.h} ${combo.lang}`; const { ctx, p, base } = await newPage(combo);
  try {
    S.mode = '429'; S.ra = 1; await p.goto(base + '/#/anime?tab=season'); const s = await waitFor(p, 'season', (x) => x.noteWait, 8000); ok(`${name}: the wait is shown`, s.noteWait, s);
    const n0 = S.seasonN; await p.evaluate(() => { [...document.querySelectorAll('.chip')].find((c) => /Search|بحث/.test(c.textContent) && c.closest('.filter-chips')).click(); });
    await p.waitForTimeout(3500); const s1 = await see(p, 'season');
    ok(`${name}: no season request after leaving (${n0} → ${S.seasonN})`, S.seasonN === n0, [n0, S.seasonN]); ok(`${name}: nothing of the season's wait or list painted over the other tab`, !s1.noteText && !/season-head/.test(await p.evaluate(() => document.querySelector('.anime-body')?.innerHTML.slice(0, 2000) || '')) && !(await p.$('.season-head')), s1);
    // A request that never answers, left before its budget ends: no error painted later over the next tab.
    S.mode = 'never'; await p.evaluate(() => { [...document.querySelectorAll('.chip')].find((c) => /Season|الموسم/.test(c.textContent) && c.closest('.filter-chips')).click(); });
    await p.waitForTimeout(300); await p.evaluate(() => { [...document.querySelectorAll('.chip')].find((c) => /Search|بحث/.test(c.textContent) && c.closest('.filter-chips')).click(); });
    await p.waitForTimeout(4500); const s2 = await see(p, 'season'); ok(`${name}: no late failure over the Search tab`, !s2.failText && !s2.noteBad && !(await p.$('.season-head')), s2);
    ok(`${name}: no page error`, p.errors.length === 0, p.errors);
  } catch (e) { ok(`${name}: ran`, false, String(e && e.message || e)); } finally { release(); await ctx.close(); }
}

(async () => {
  await new Promise((r) => web.listen(0, '127.0.0.1', r)); br = await chromium.launch();
  const want = (tab, cs) => (!ONLY || ((!ONLY.some((o) => o in TABS) || ONLY.includes(tab)) && (!ONLY.some((o) => CASES.includes(o)) || ONLY.includes(cs))));
  const onlyExtra = ONLY && ONLY.every((o) => o === 'cached' || o === 'leaving' || o === 'cap');
  let rot = 0;
  for (const tab of Object.keys(TABS)) {
    for (const cs of CASES) {
      // The season tab (the owner's) in three sizes and both languages; the others in the next size and language in turn.
      const combos = tab === 'season' ? [COMBOS[0], COMBOS[1], COMBOS[2]] : [COMBOS[rot % COMBOS.length]]; rot++;
      if (onlyExtra || !want(tab, cs)) continue;
      for (const c of combos) { if (!LANGS.includes(c.lang)) continue; await walk(tab, cs, c, true); }
    }
  }
  if (!BEFORE && (!ONLY || ONLY.includes('cached'))) for (const tab of ['season', 'schedule', 'list', 'discover']) for (const c of [COMBOS[4], COMBOS[2], COMBOS[1]]) { if (!LANGS.includes(c.lang)) continue; if (tab !== 'season' && c !== COMBOS[4]) continue; await cached(tab, c, true); }
  if (!BEFORE && (!ONLY || ONLY.includes('leaving'))) for (const c of [COMBOS[0], COMBOS[1]]) { if (LANGS.includes(c.lang)) await leaving(c); }
  if (!BEFORE && (!ONLY || ONLY.includes('cap'))) await cap();
  await br.close(); web.close(); release();
  const md = ['# What the user sees (Anime tabs against a misbehaving catalogue)', '', BEFORE ? 'Build under test: the one named by ANWALK_DIST (the state before the change), what is on screen 6 s after opening.' : 'Build under test: this tree. Budget scaled by 0.1 in the page (a real budget is 12 s; the waits asked for by a 429 are real seconds).', '', '| tab | case | screen | what the user sees |', '|---|---|---|---|', ...log.map((l) => `| ${l.tab} | ${l.cs} | ${l.combo.w}x${l.combo.h}${l.combo.phone ? '' : ' pc'} ${l.combo.lang} | ${String(l.saw).replace(/\|/g, '/')} |`)].join('\n');
  fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, BEFORE ? 'AN-faults-before.md' : 'AN-faults.md'), md + '\n');
  console.log(`${passes} passed, ${fails} failed; notes and shots in ${OUT}`); console.log(fails ? 'FAIL animewalk' : 'ok   animewalk'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL', e); process.exit(1); });
