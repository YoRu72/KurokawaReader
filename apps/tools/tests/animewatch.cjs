// After watching (0.21 P7), on a stubbed phone (360 px) and a PC window, against stand-ins only (made-up show, made-up
// user; AniList and MyAnimeList answered by the page's own stub of the phone's HTTP): the player goes back to the
// page it was opened from (the show's page, scrolled to the episode; the Downloads), by Back and after the end, and
// after the app started again meanwhile; an episode watched to the end moves the progress on AniList and MyAnimeList
// once (no second send, never lowered, kept while unreachable and sent when back online); «Episode n watched. Review
// it?» with its running line (held while pointed at, closable, not shown when a note exists or when turned off); the
// pen beside each episode; the floating download bar (one, several, failed, tapped → Downloads, the setting that
// opens the Downloads instead). node tests/animewatch.cjs [en|ar]
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const { execFileSync } = require('node:child_process');
const LANG = process.argv[2] === 'ar' ? 'ar' : 'en';
const DIST = path.join(__dirname, '..', 'dist'); const MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-animewatch-'));
const SHOTS = process.env.KT_SHOTS || MEDIA;
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 400))); if (!c) fails++; };
fs.mkdirSync(path.join(MEDIA, 'Download'));
try { execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '4', '-c:v', 'libvpx', '-b:v', '200k', '-c:a', 'libopus', path.join(MEDIA, 'Download', 'clip.webm')]); }
catch { console.log('ffmpeg not available — skipped'); process.exit(0); }
for (const e of [3, 4, 5]) fs.copyFileSync(path.join(MEDIA, 'Download', 'clip.webm'), path.join(MEDIA, 'Download', `Starlit 0${e}.webm`));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webm': 'video/webm' };
const web = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = p.startsWith('/media/') ? path.join(MEDIA, p.slice(7)) : path.join(DIST, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  const size = fs.statSync(f).size; const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || ''); const type = MIME[path.extname(f)] || 'application/octet-stream';
  if (range) { const a = Number(range[1]), b = range[2] ? Number(range[2]) : size - 1; res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${a}-${b}/${size}`, 'accept-ranges': 'bytes', 'content-length': b - a + 1 }); fs.createReadStream(f, { start: a, end: b }).pipe(res); return; }
  res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size }); fs.createReadStream(f).pipe(res);
});
const ID = 4242; const IDMAL = 4343;
const state = { progress: 1, failSave: false, failAll: false, malWatched: 2 }; const saves = []; const malSets = [];
const MEDIA_AL = () => ({ id: ID, idMal: IDMAL, title: { romaji: 'Hoshizora Kissa', english: 'Starlit Cafe', native: '星空喫茶', userPreferred: 'Starlit Cafe' }, synonyms: [], coverImage: { large: '', extraLarge: '', color: '#5c6bc0' }, format: 'TV', status: 'FINISHED', episodes: 12, season: 'FALL', seasonYear: 2026, startDate: { year: 2026, month: 10, day: 1 }, genres: ['Slice of Life'], averageScore: 70, popularity: 10, isAdult: false, siteUrl: `https://anilist.co/anime/${ID}`, nextAiringEpisode: null, duration: 24, description: 'Made up.', studios: { nodes: [] }, airingSchedule: { nodes: [] }, streamingEpisodes: [], externalLinks: [], relations: { edges: [] }, mediaListEntry: { id: 9, status: 'CURRENT', progress: state.progress, score: 0 } });

(async () => {
  web.listen(0); const port = web.address().port; const BASE = `http://127.0.0.1:${port}`;
  const br = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const mk = async (viewport, phone) => {
    const ctx = await br.newContext({ viewport, ...(phone ? { hasTouch: true, isMobile: true } : {}) }); const p = await ctx.newPage(); p.errors = []; p.on('pageerror', (e) => p.errors.push(e.message));
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 404, body: '' }));
    await p.exposeFunction('__http', (o) => {
      if (/\/graphql$/.test(o.url)) {
        if (state.failAll) throw new Error('offline');
        const b = JSON.parse(o.body || '{}'); const q = b.query || '';
        if (/SaveMediaListEntry/.test(q)) { if (state.failSave) throw new Error('offline'); saves.push(b.variables); state.progress = b.variables.progress; return { status: 200, headers: {}, body: JSON.stringify({ data: { SaveMediaListEntry: { id: 9, status: b.variables.status, progress: b.variables.progress, score: 0 } } }) }; }
        if (/Media\(id/.test(q)) return { status: 200, headers: {}, body: JSON.stringify({ data: { Media: MEDIA_AL() } }) };
        return { status: 200, headers: {}, body: JSON.stringify({ data: { Page: { pageInfo: { hasNextPage: false }, media: [MEDIA_AL()] }, MediaListCollection: { lists: [] } } }) };
      }
      if (/\/v2\/anime\/4343\?/.test(o.url)) return { status: 200, headers: {}, body: JSON.stringify({ id: IDMAL, my_list_status: { status: 'watching', num_episodes_watched: state.malWatched } }) };
      if (/\/v2\/anime\/4343\/my_list_status$/.test(o.url)) { malSets.push({ method: o.method, body: o.body }); return { status: 200, headers: {}, body: '{}' }; }
      return { status: 404, headers: {}, body: '' };
    });
    await p.exposeFunction('__ls', (dir) => { const d = path.join(MEDIA, dir.replace(/^\/sdcard\/?/, '')); if (!fs.existsSync(d)) return { exists: false, entries: [] }; return { exists: true, entries: fs.readdirSync(d).map((n) => { const st = fs.statSync(path.join(d, n)); return { name: n, path: `${dir.replace(/\/$/, '')}/${n}`, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs }; }) }; });
    await p.addInitScript(([port, lang, ID]) => {
      if (location.protocol !== 'http:') return;   // (about:blank, between two loads)
      window.__ktTestApi = { anilist: `http://127.0.0.1:${port}/graphql`, mal: `http://127.0.0.1:${port}` };
      if (!localStorage.getItem('kt.settings')) {
        localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['player', 'anime'], playerWith: 'app' }));
        localStorage.setItem('kt.player', JSON.stringify({ autoSubs: false, resume: 'never', autoplayNext: false }));
        localStorage.setItem('kt.anilist.token', 'MADE-UP'); localStorage.setItem('kt.anilist.user', JSON.stringify({ id: 1, name: 'Test Viewer', scoreFormat: 'POINT_10' }));
        localStorage.setItem('kt.mal.token', JSON.stringify({ access: 'MAL-MADE-UP', refresh: '', exp: Date.now() + 864e5, name: 'mal_tester' }));
        localStorage.setItem('kt.update.lastCheck', String(Date.now()));
      }
      const task = (e) => ({ id: `ep${e}`, kind: 'http', name: `Starlit 0${e}.webm`, source: { url: `https://x/${e}.webm` }, dir: '/sdcard/Download', state: 'done', done: 1, total: 1, downSpeed: 0, upSpeed: 0, files: [{ index: 0, path: `Starlit 0${e}.webm`, size: 1, done: 1, priority: 1 }], addedAt: Date.now() - 60e3, doneAt: Date.now() - 50e3, meta: { anilistId: ID, episode: e, title: 'Starlit Cafe' } });
      window.__tasks = [task(3), task(4), task(5)]; window.__subs = {};
      const api = {
        addListener: (ev, cb) => { (window.__subs[ev] ??= []).push(cb); return Promise.resolve({ remove() {} }); }, list: async () => ({ tasks: window.__tasks }),
        localUrl: async (o) => ({ url: `http://127.0.0.1:${port}/media/${o.path.replace(/^\/sdcard\//, '')}` }), siblings: async () => ({ paths: [] }), filesList: async (o) => window.__ls(o.path),
        httpRequest: async (o) => window.__http(o),
      };
      window.__emit = (tasks) => { window.__tasks = tasks; for (const cb of window.__subs.tasksChanged ?? []) cb({ tasks }); };
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) }) }, PluginHeaders: [] };
    }, [port, LANG, ID]);
    return p;
  };
  const shot = (p, n) => p.screenshot({ path: path.join(SHOTS, `p7-${n}-${LANG}.png`) });
  const p = await mk({ width: 360, height: 760 }, true);
  const clear = () => p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim, .toast, .review-bar').forEach((e) => e.remove()));
  const page = async () => { await p.goto(`${BASE}/#/anime/${ID}`); await p.waitForSelector('.ep-row[data-ep="5"] button[data-icon="play"]', { timeout: 15000 }); };
  const play = async (e) => { await clear(); await p.click(`.ep-row[data-ep="${e}"] button[data-icon="play"]`); await p.waitForSelector('.kt-player video.kt-video'); await p.waitForFunction(() => document.querySelector('.kt-player video')?.readyState >= 1, null, { timeout: 10000 }); };
  const toEnd = async () => { await p.evaluate(() => { const v = document.querySelector('.kt-player video'); v.currentTime = Math.max(0, v.duration - 0.3); void v.play(); }); await p.waitForFunction(() => document.querySelector('.kt-player video')?.ended, null, { timeout: 10000 }); await p.waitForTimeout(600); };
  const back = async () => { await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove())); await p.click('.kt-top button[data-icon="back"]'); await p.waitForSelector('.kt-player', { state: 'detached' }); await p.waitForTimeout(500); };
  const inView = (e) => p.$eval(`.ep-row[data-ep="${e}"]`, (el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });

  // ---- back to where it was opened from ----
  await page(); await p.$eval('.ep-row[data-ep="5"]', (e) => e.scrollIntoView({ block: 'center' }));
  await play(5); await back();
  ok('Back from the player: the show\'s page, not the Downloads', (await p.evaluate(() => location.hash)) === `#/anime/${ID}` && !!(await p.$('.anime-entry')));
  ok('…the episode played still in view', await inView(5));
  ok('…no review offered (not watched)', !(await p.$('.review-bar')));
  // Watched to the end: progress sent once; back on the page; the review bar.
  await play(3); await toEnd();
  await p.waitForFunction(() => true); await new Promise((r) => setTimeout(r, 1200));
  ok('watched to the end: AniList progress 1 → 3 sent, once', saves.length === 1 && saves[0].mediaId === ID && saves[0].progress === 3, saves);
  ok('…and MyAnimeList moved from 2 to 3', malSets.length === 1 && /num_watched_episodes=3/.test(malSets[0].body) && malSets[0].method === 'PATCH', malSets);
  await back();
  ok('after the end: back on the show\'s page, the episode in view', (await p.evaluate(() => location.hash)) === `#/anime/${ID}` && await inView(3));
  const bar = await p.waitForSelector('.review-bar', { timeout: 6000 }).catch(() => null);
  ok('«Review it?» shown, announced politely, not focused', !!bar && (await p.$eval('.review-bar', (e) => e.getAttribute('aria-live') === 'polite' && !e.contains(document.activeElement))));
  ok('…with its running line (8 s)', /8000ms|8s/.test(await p.$eval('.review-bar .rb-line i', (e) => getComputedStyle(e).animationDuration + e.style.animationDuration)));
  await p.waitForTimeout(300); await shot(p, 'review-bar-phone');
  await p.hover('.review-bar .rb-main'); ok('…held while pointed at', await p.$eval('.review-bar', (e) => e.classList.contains('held')));
  const nav = await p.$('.bottom-nav'); if (nav) { const a = await p.$eval('.review-bar', (e) => e.getBoundingClientRect().toJSON()); const b = await nav.boundingBox(); const t = await p.$eval('.anime-entry-view .topbar', (e) => e.getBoundingClientRect().toJSON()); ok('…covering neither the top bar nor the bottom bar', a.top >= t.bottom - 1 && a.bottom <= b.y, { a, t, b }); }
  await p.click('.review-bar .rb-main'); await p.waitForSelector('.note-sheet .note-text');
  ok('tapped: the note editor for episode 3', /3|٣/.test(await p.$eval('.sheet-head, .sheet h2, .sheet .sheet-title', (e) => e.textContent).catch(() => '')) && !(await p.$('.review-bar:not(.leaving)')));
  await p.fill('.note-sheet .note-text', 'Lovely.'); await p.click('.note-save'); await p.waitForSelector('.note-sheet', { state: 'detached' });
  // The pen beside each episode.
  await p.waitForSelector('.ep-row[data-ep="3"] .ep-note-btn.on');
  ok('the pen beside the episode: filled once a note exists', !!(await p.$('.ep-row[data-ep="3"] .ep-note-btn.on')) && !!(await p.$('.ep-row[data-ep="4"] .ep-note-btn:not(.on)')));
  const boxes = await p.$$eval('.ep-row[data-ep="3"] > button, .ep-row[data-ep="3"] > .icon-btn', (els) => els.map((e) => e.getBoundingClientRect().toJSON()));
  const touch = boxes.some((a, i) => boxes.some((b, j) => j > i && a.left < b.right + 2 && b.left < a.right + 2 && a.top < b.bottom && b.top < a.bottom));
  ok('at 360 px the row\'s buttons do not touch, and fit', !touch && boxes.every((b) => b.right <= 360 && b.left >= 0), boxes);
  await p.$eval('.ep-row[data-ep="3"]', (e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(200); await shot(p, 'episode-pen-phone');
  // Once per episode; never lowered.
  await play(3); await toEnd(); await back(); await p.waitForTimeout(800);
  ok('the same episode watched again: nothing sent again', saves.length === 1 && malSets.length === 1, { saves, malSets });
  ok('…and no review offered: a note exists', !(await p.$('.review-bar')));
  state.progress = 10; await play(4); await toEnd(); await back(); await p.waitForTimeout(800);
  ok('an episode below the progress: never lowered', saves.length === 1, saves);
  ok('review asked for episode 4 (no note there)', !!(await p.$('.review-bar')));
  // Unreachable: kept, sent when back online.
  state.progress = 1; await p.evaluate(() => localStorage.removeItem('kt.anime.tracked')); await clear();
  state.failAll = true; await play(5); await toEnd(); await back(); await p.waitForTimeout(800);
  ok('AniList unreachable: nothing sent, the episode kept', saves.length === 1 && (await p.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('kt.anime.watchPending') || '{}')).length)) === 1);
  state.failAll = false; await p.evaluate(() => window.dispatchEvent(new Event('online'))); await p.waitForTimeout(1500);
  ok('back online: sent then, read anew (1 → 5)', saves.length === 2 && saves[1].progress === 5 && (await p.evaluate(() => localStorage.getItem('kt.anime.watchPending'))) === '{}', saves);
  // Turned off: no review bar.
  await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('kt.settings')); s.animeAskReview = false; localStorage.setItem('kt.settings', JSON.stringify(s)); });
  await p.goto('about:blank'); await page(); await clear(); state.progress = 1; await p.evaluate(() => localStorage.removeItem('kt.anime.tracked'));
  await play(4); await toEnd(); await back(); await p.waitForTimeout(800);
  ok('«Ask to review after watching» off: no bar', !(await p.$('.review-bar')));
  // Opened from the Downloads: back to the Downloads.
  await p.goto(`${BASE}/#/`); await p.waitForSelector('button[data-icon="play"]', { timeout: 10000 });
  await p.click('button[data-icon="play"]'); await p.waitForSelector('.kt-player video'); await back();
  ok('opened from the Downloads: back to the Downloads', ['#/', '', '#'].includes(await p.evaluate(() => location.hash)) && !(await p.$('.anime-entry')));
  // The app started again while the player was open: back to the page it was opened from.
  await p.evaluate((ID) => localStorage.setItem('kt.player.from', JSON.stringify({ hash: `#/anime/${ID}`, at: Date.now(), scroll: 0, anilistId: ID, episode: 4 })), ID);
  await p.goto('about:blank'); await p.goto(`${BASE}/`); await p.waitForFunction((ID) => location.hash === `#/anime/${ID}`, ID, { timeout: 8000 }).catch(() => undefined);
  ok('the app started again behind the player: back on the show\'s page', (await p.evaluate(() => location.hash)) === `#/anime/${ID}`);

  // ---- the floating download bar ----
  await page(); await clear();
  const dl = (t) => p.evaluate((t) => window.__ktProgress.dl().then((m) => m.downloadStarted(t)), t);
  const mkTask = (id, name, done, total, st = 'downloading') => ({ id, kind: 'http', name, source: { url: 'https://x/y' }, dir: '/sdcard/Download', state: st, done, total, downSpeed: 1, upSpeed: 0, files: [] });
  await dl({ id: 'n1', name: 'Starlit Cafe - 06 [1080p].mkv' }); await p.waitForSelector('.dl-float');
  ok('a download started: the floating bar, the page stays', (await p.evaluate(() => location.hash)) === `#/anime/${ID}` && /Starlit/.test(await p.$eval('.dl-float .dlf-name', (e) => e.textContent)));
  await p.evaluate((t) => window.__emit([...window.__tasks.filter((x) => x.id.startsWith('ep')), t]), mkTask('n1', 'Starlit Cafe - 06 [1080p].mkv', 42, 100));
  await p.waitForFunction(() => /42|٤٢/.test(document.querySelector('.dl-float .dlf-pct')?.textContent || ''));
  ok('…its percentage and line follow the download', /42/.test(await p.$eval('.dl-float .dlf-line i', (e) => e.style.width)));
  const fb = await p.$eval('.dl-float', (e) => e.getBoundingClientRect().toJSON()); const nb = await p.$eval('.bottom-nav', (e) => e.getBoundingClientRect().toJSON()).catch(() => null);
  ok('…above the bottom bar, not touching it', !nb || fb.bottom < nb.top - 4, { fb, nb });
  await shot(p, 'dl-float-one-phone');
  await dl({ id: 'n2', name: 'Starlit Cafe - 07 [1080p].mkv' });
  await p.evaluate((ts) => window.__emit([...window.__tasks.filter((x) => x.id.startsWith('ep')), ...ts]), [mkTask('n1', 'a', 50, 100), mkTask('n2', 'b', 30, 100)]);
  await p.waitForFunction(() => /2|٢/.test(document.querySelector('.dl-float .dlf-name')?.textContent || ''));
  ok('two downloads: one bar, «count: 2», the overall progress (40%)', /40|٤٠/.test(await p.$eval('.dl-float .dlf-pct', (e) => e.textContent)));
  await shot(p, 'dl-float-many-phone');
  await p.evaluate((ts) => window.__emit([...window.__tasks.filter((x) => x.id.startsWith('ep')), ...ts]), [mkTask('n1', 'a', 100, 100, 'done'), mkTask('n2', 'b', 30, 100, 'failed')]);
  await p.waitForSelector('.dl-float.failed'); await p.waitForTimeout(3000);
  ok('a failure stays until seen', !!(await p.$('.dl-float.failed')));
  await p.click('.dl-float .dlf-main'); await p.waitForTimeout(500);
  ok('tapped: the Downloads, the bar gone', ['#/', ''].includes(await p.evaluate(() => location.hash)) && !(await p.$('.dl-float:not(.leaving)')));
  await page(); await dl({ id: 'n3', name: 'c' }); await p.evaluate((t) => window.__emit([...window.__tasks.filter((x) => x.id.startsWith('ep')), t]), mkTask('n3', 'c', 100, 100, 'done'));
  await p.waitForTimeout(3200); ok('finished: the bar leaves by itself', !(await p.$('.dl-float')));
  await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('kt.settings')); s.openDownloadsOnStart = true; localStorage.setItem('kt.settings', JSON.stringify(s)); });
  await p.goto('about:blank'); await page(); await dl({ id: 'n4', name: 'd' }); await p.waitForTimeout(500);
  ok('«Open Downloads when a download starts» on: straight to the Downloads, no bar', ['#/', ''].includes(await p.evaluate(() => location.hash)) && !(await p.$('.dl-float')));
  // The settings rows.
  await p.goto(`${BASE}/#/settings/anime`); await p.waitForSelector('#anime .notes-settings h4', { state: 'attached', timeout: 10000 });
  await p.$eval('.notes-settings', (e) => e.scrollIntoView({ block: 'start' })); await p.waitForTimeout(300); await shot(p, 'settings-afterwatch-phone');
  await p.goto(`${BASE}/#/settings/downloads`); await p.waitForTimeout(800); await shot(p, 'settings-opendl-phone');
  ok(`${LANG}: ${LANG === 'ar' ? 'right to left' : 'left to right'}, nothing wider than the screen`, (await p.evaluate(() => document.documentElement.dir || 'ltr')) === (LANG === 'ar' ? 'rtl' : 'ltr') && (await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)));
  ok('no page errors (phone)', !p.errors.length, p.errors);

  // ---- PC: the review bar and the floating bar where they go ----
  const q = await mk({ width: 1280, height: 800 }, false);
  await q.goto(`${BASE}/#/anime/${ID}`); await q.waitForSelector('.ep-row[data-ep="5"]', { timeout: 15000 });
  await q.evaluate((ID) => { sessionStorage.setItem('kt.anime.reviewAsk', JSON.stringify({ id: ID, ep: 5, at: Date.now() })); window.dispatchEvent(new CustomEvent('kt-anime-watched', { detail: { id: ID, ep: 5 } })); }, ID);
  await q.waitForSelector('.review-bar'); await q.evaluate(() => window.__ktProgress.dl().then((m) => { m.downloadStarted({ id: 'p1', name: 'Starlit Cafe - 08.mkv' }); m.downloadStarted({ id: 'p2', name: 'Starlit Cafe - 09.mkv' }); }));
  await q.waitForSelector('.dl-float'); await q.waitForTimeout(300); await shot(q, 'review-and-dl-pc');
  const rb = await q.$eval('.review-bar', (e) => e.getBoundingClientRect().toJSON()); const db = await q.$eval('.dl-float', (e) => e.getBoundingClientRect().toJSON());
  ok('PC: the review bar and the download bar apart', rb.bottom < db.top);
  await q.evaluate(() => document.querySelector('.ep-row[data-ep="4"]')?.scrollIntoView({ block: 'center' })); await shot(q, 'episode-pen-pc');
  ok('no page errors (PC)', !q.errors.length, q.errors);
  await br.close(); web.close(); fs.rmSync(MEDIA, { recursive: true, force: true });
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + e.message); process.exit(1); });
