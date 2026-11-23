// After watching (0.21 P7), on a stubbed phone (360 px) and a PC window, against stand-ins only (made-up show, made-up
// user; AniList and MyAnimeList answered by the page's own stub of the phone's HTTP — the app has no test hook):
//   the player goes back to the page it was opened from (the show's page, scrolled to the episode; the Downloads), by
//   Back and after the end, also when something sent the app elsewhere meanwhile; an external player leaves no
//   record; the app started again behind the player → that page with its history (Back as before), a stale record
//   ignored;
//   one switch for every automatic list update: an episode watched moves AniList and MyAnimeList once (no second
//   send, never lowered, kept while unreachable and sent when back online); a finished download moves it without
//   using up the episode's «once»; the switch off stops what was queued; a queued change of the user's own is put on
//   the entry as AniList has it then (never lowering it, never overwriting a score changed there);
//   «Episode n watched. Review it?» with its running line (held while pointed at; not shown when a note exists or
//   when turned off); the review button beside each episode;
//   the floating download bar (from a real download: the Subtitles page's, through a stand-in source): one,
//   several, its reason on failure, gone when removed, hidden on the Downloads page, tapped → Downloads, the setting
//   that opens the Downloads instead, and stacked with the review bar on a short screen.
// node tests/animewatch.cjs [en|ar]
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const { execFileSync } = require('node:child_process');
const LANG = process.argv[2] === 'ar' ? 'ar' : 'en';
const DIST = path.join(__dirname, '..', 'dist'); const REPO = path.join(__dirname, '..', '..', '..', 'repo');
const MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-animewatch-')); const SHOTS = process.env.KT_SHOTS || MEDIA;
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
const state = { progress: 1, score: 0, failSave: false, failAll: false, malWatched: 2 }; const saves = []; const malSets = [];
const MEDIA_AL = () => ({ id: ID, idMal: IDMAL, title: { romaji: 'Hoshizora Kissa', english: 'Starlit Cafe', native: '星空喫茶', userPreferred: 'Starlit Cafe' }, synonyms: [], coverImage: { large: '', extraLarge: '', color: '#5c6bc0' }, format: 'TV', status: 'FINISHED', episodes: 12, season: 'FALL', seasonYear: 2026, startDate: { year: 2026, month: 10, day: 1 }, genres: ['Slice of Life'], averageScore: 70, popularity: 10, isAdult: false, siteUrl: `https://anilist.co/anime/${ID}`, nextAiringEpisode: null, duration: 24, description: 'Made up.', studios: { nodes: [] }, airingSchedule: { nodes: [] }, streamingEpisodes: [], externalLinks: [], relations: { edges: [] }, mediaListEntry: { id: 9, status: 'CURRENT', progress: state.progress, score: state.score } });

(async () => {
  web.listen(0); const port = web.address().port; const BASE = `http://127.0.0.1:${port}`;
  // (The add-ons' index: the Subtitles add-on with one stand-in source written here, for a real download to start.)
  const ix = JSON.parse(fs.readFileSync(path.join(REPO, 'tools', 'index.json'), 'utf8'));
  ix.addons = ix.addons.filter((a) => a.kind !== 'subtitle-source'); ix.addons.find((a) => a.id === 'subtitles').children = ['subs-standin'];
  const MOD = `export async function search(q) { return [1, 2].map((n) => ({ title: 'Starlit Cafe subs ' + n, language: 'en', site: 'Stand-in', url: 'https://subs.invalid/' + n + '.srt', downloads: 3 - n })); }`;
  // (Honest like the real index: the entry carries the module's sha256 and size — the app refuses a module without one
  // once any module in the index has one, so the live checker keeps running in this test.)
  const entryFor = (id, parent, name, file, body) => ({ id, kind: 'subtitle-source', parent, name, description: 'A test source.', version: '1.0.0', module: file, sha256: require('node:crypto').createHash('sha256').update(body).digest('hex'), size: Buffer.byteLength(body), icon: 'subtitles' });
  ix.addons.push(entryFor('subs-standin', 'subtitles', 'Stand-in', 'subs/standin.mjs', MOD));
  const br = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const mk = async (viewport, phone) => {
    const ctx = await br.newContext({ viewport, ...(phone ? { hasTouch: true, isMobile: true } : {}) }); const p = await ctx.newPage(); p.errors = []; p.on('pageerror', (e) => p.errors.push(e.message));
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => {
      const m = /\/main\/repo\/(.*)$/.exec(r.request().url());
      if (m && m[1] === 'tools/index.json') return r.fulfill({ json: ix });
      if (m && m[1] === 'tools/subs/standin.mjs') return r.fulfill({ body: MOD, contentType: 'text/plain' });
      if (m) { const f = path.join(REPO, m[1]); return fs.existsSync(f) ? r.fulfill({ body: fs.readFileSync(f) }) : r.fulfill({ status: 404, body: '' }); }
      return r.fulfill({ status: 404, body: '' });
    });
    await p.exposeFunction('__http', (o) => {
      if (/graphql\.anilist\.co/.test(o.url)) {
        if (state.failAll) throw new Error('offline');
        const b = JSON.parse(o.body || '{}'); const q = b.query || '';
        if (/SaveMediaListEntry/.test(q)) { if (state.failSave) throw new Error('offline'); saves.push(b.variables); state.progress = b.variables.progress; state.score = b.variables.score; return { status: 200, headers: {}, body: JSON.stringify({ data: { SaveMediaListEntry: { id: 9, status: b.variables.status, progress: b.variables.progress, score: b.variables.score } } }) }; }
        if (/Media\(id/.test(q)) return { status: 200, headers: {}, body: JSON.stringify({ data: { Media: MEDIA_AL() } }) };
        return { status: 200, headers: {}, body: JSON.stringify({ data: { Page: { pageInfo: { hasNextPage: false }, media: [MEDIA_AL()] }, MediaListCollection: { lists: [] } } }) };
      }
      if (/^https:\/\/api\.myanimelist\.net\/v2\/anime\/4343\?/.test(o.url)) { if (state.failAll) throw new Error('offline'); return { status: 200, headers: {}, body: JSON.stringify({ id: IDMAL, my_list_status: { status: 'watching', num_episodes_watched: state.malWatched } }) }; }
      if (/^https:\/\/api\.myanimelist\.net\/v2\/anime\/4343\/my_list_status$/.test(o.url)) { malSets.push({ method: o.method, body: o.body }); state.malWatched = Number(/num_watched_episodes=(\d+)/.exec(o.body)?.[1] ?? state.malWatched); return { status: 200, headers: {}, body: '{}' }; }
      return { status: 404, headers: {}, body: '' };
    });
    await p.exposeFunction('__ls', (dir) => { const d = path.join(MEDIA, dir.replace(/^\/sdcard\/?/, '')); if (!fs.existsSync(d)) return { exists: false, entries: [] }; return { exists: true, entries: fs.readdirSync(d).map((n) => { const st = fs.statSync(path.join(d, n)); return { name: n, path: `${dir.replace(/\/$/, '')}/${n}`, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs }; }) }; });
    await p.addInitScript(([port, lang, ID]) => {
      if (location.protocol !== 'http:') return;   // (about:blank, between two loads)
      if (!localStorage.getItem('kt.settings')) {
        localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['player', 'anime'], playerWith: 'app', subLangs: ['en'] }));
        localStorage.setItem('kt.player', JSON.stringify({ autoSubs: false, resume: 'never', autoplayNext: false }));
        localStorage.setItem('kt.anilist.token', 'MADE-UP'); localStorage.setItem('kt.anilist.user', JSON.stringify({ id: 1, name: 'Test Viewer', scoreFormat: 'POINT_10' }));
        localStorage.setItem('kt.mal.token', JSON.stringify({ access: 'MAL-MADE-UP', refresh: '', exp: Date.now() + 864e5, name: 'mal_tester' }));
        localStorage.setItem('kt.update.lastCheck', String(Date.now()));
      }
      const task = (e) => ({ id: `ep${e}`, kind: 'http', name: `Starlit 0${e}.webm`, source: { url: `https://x/${e}.webm` }, dir: '/sdcard/Download', state: 'done', done: 1, total: 1, downSpeed: 0, upSpeed: 0, files: [{ index: 0, path: `Starlit 0${e}.webm`, size: 1, done: 1, priority: 1 }], addedAt: Date.now() - 60e3, doneAt: Date.now() - 50e3, meta: { anilistId: ID, episode: e, title: 'Starlit Cafe' } });
      window.__tasks = [task(3), task(4), task(5)]; window.__subs = {}; window.__ext = [];
      const api = {
        addListener: (ev, cb) => { (window.__subs[ev] ??= []).push(cb); return Promise.resolve({ remove() {} }); }, list: async () => ({ tasks: window.__tasks }),
        add: async (o) => { const t = { id: `n${window.__tasks.length}${Date.now() % 1000}`, kind: 'http', name: o.name || 'subtitle.srt', source: o.source, dir: o.dir || '/sdcard/Download', state: 'downloading', done: 0, total: 100, downSpeed: 1, upSpeed: 0, files: [], meta: o.meta }; window.__tasks = [...window.__tasks, t]; return { task: t }; },
        localUrl: async (o) => ({ url: `http://127.0.0.1:${port}/media/${o.path.replace(/^\/sdcard\//, '')}` }), siblings: async () => ({ paths: [] }), filesList: async (o) => window.__ls(o.path),
        openWith: async (o) => { window.__ext.push(o); }, httpRequest: async (o) => window.__http(o),
      };
      window.__emit = (tasks) => { window.__tasks = tasks; for (const cb of window.__subs.tasksChanged ?? []) cb({ tasks }); };
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) }) }, PluginHeaders: [] };
    }, [port, LANG, ID]);
    return p;
  };
  // (Taken once the floating bars have finished appearing.)
  const shot = async (p, n) => { await p.waitForFunction(() => [...document.querySelectorAll('.float-bar')].every((e) => !e.getAnimations().length)).catch(() => undefined); await p.screenshot({ path: path.join(SHOTS, `p7-${n}-${LANG}.png`) }); };
  const p = await mk({ width: 360, height: 760 }, true);
  const clear = () => p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim, .toast, .review-bar, .done-card').forEach((e) => e.remove()));
  const setting = (k, v) => p.evaluate(([k, v]) => { const s = JSON.parse(localStorage.getItem('kt.settings')); s[k] = v; localStorage.setItem('kt.settings', JSON.stringify(s)); }, [k, v]);
  const page = async (fresh = false) => { if (fresh) await p.goto('about:blank'); await p.goto(`${BASE}/#/anime/${ID}`); await p.waitForSelector('.ep-row[data-ep="5"] button[data-icon="play"]', { timeout: 15000 }); };
  const play = async (e) => { await clear(); await p.click(`.ep-row[data-ep="${e}"] button[data-icon="play"]`); await p.waitForSelector('.kt-player video.kt-video'); await p.waitForFunction(() => document.querySelector('.kt-player video')?.readyState >= 1, null, { timeout: 10000 }); };
  const toEnd = async () => { await p.evaluate(() => { const v = document.querySelector('.kt-player video'); v.currentTime = Math.max(0, v.duration - 0.3); void v.play(); }); await p.waitForFunction(() => document.querySelector('.kt-player video')?.ended, null, { timeout: 10000 }); };
  const back = async () => { await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim, .done-card').forEach((e) => e.remove())); await p.click('.kt-top button[data-icon="back"]'); await p.waitForSelector('.kt-player', { state: 'detached' }); };
  const settle = (fn, ms = 6000) => p.waitForFunction(fn, null, { timeout: ms }).then(() => true, () => false);
  const hashIs = (h) => p.waitForFunction((h) => location.hash === h, h, { timeout: 6000 }).then(() => true, () => false);
  const inView = (e) => p.$eval(`.ep-row[data-ep="${e}"]`, (el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });

  // ---- back to where it was opened from ----
  await page(); await p.$eval('.ep-row[data-ep="5"]', (e) => e.scrollIntoView({ block: 'center' }));
  await play(5); await back();
  ok('Back from the player: the show\'s page, not the Downloads', (await hashIs(`#/anime/${ID}`)) && !!(await p.$('.anime-entry')));
  ok('…the episode played still in view', await inView(5));
  ok('…no review offered (not watched)', !(await p.$('.review-bar')));
  // Sent to the Downloads behind the player meanwhile: closing still goes back to the show's page.
  await play(5); await p.evaluate(() => { location.hash = '#/'; }); await hashIs('#/'); await back();
  ok('something went to the Downloads behind the player: closing it goes back to the show\'s page', await hashIs(`#/anime/${ID}`));
  // Watched to the end: progress sent once; back on the page; the review bar.
  await play(3); await toEnd();
  ok('watched to the end: AniList progress 1 → 3 sent, once', await (async () => { for (let i = 0; i < 40 && saves.length < 1; i++) await p.waitForTimeout(100); return saves.length === 1 && saves[0].mediaId === ID && saves[0].progress === 3; })(), saves);
  ok('…and MyAnimeList moved from 2 to 3', await (async () => { for (let i = 0; i < 40 && malSets.length < 1; i++) await p.waitForTimeout(100); return malSets.length === 1 && /num_watched_episodes=3/.test(malSets[0].body) && malSets[0].method === 'PATCH'; })(), malSets);
  await back();
  ok('after the end: back on the show\'s page, the episode in view', (await hashIs(`#/anime/${ID}`)) && await inView(3));
  const bar = await p.waitForSelector('.review-bar', { timeout: 6000 }).catch(() => null);
  ok('«Review it?» shown, announced politely, not focused, with the review mark', !!bar && (await p.$eval('.review-bar', (e) => e.getAttribute('aria-live') === 'polite' && !e.contains(document.activeElement) && !!e.querySelector('svg.review-ic'))));
  ok('…with its running line (8 s)', /8000ms|8s/.test(await p.$eval('.review-bar .rb-line i', (e) => getComputedStyle(e).animationDuration + e.style.animationDuration)));
  await shot(p, 'review-bar-phone');
  await p.hover('.review-bar .rb-main'); ok('…held while pointed at', await p.$eval('.review-bar', (e) => e.classList.contains('held')));
  const nav = await p.$('.bottom-nav'); if (nav) { const a = await p.$eval('.review-bar', (e) => e.getBoundingClientRect().toJSON()); const b = await nav.boundingBox(); const t = await p.$eval('.anime-entry-view .topbar', (e) => e.getBoundingClientRect().toJSON()); ok('…covering neither the top bar nor the bottom bar', a.top >= t.bottom - 1 && a.bottom <= b.y, { a, t, b }); }
  await p.click('.review-bar .rb-main'); await p.waitForSelector('.note-sheet .note-text');
  ok('tapped: the note editor for episode 3', /3|٣/.test(await p.$eval('.sheet-head, .sheet h2, .sheet .sheet-title', (e) => e.textContent).catch(() => '')));
  await p.fill('.note-sheet .note-text', 'Lovely.'); await p.click('.note-save'); await p.waitForSelector('.note-sheet', { state: 'detached' });
  // The review button beside each episode.
  await p.waitForSelector('.ep-row[data-ep="3"] .ep-note-btn.on');
  const lbl = await p.$eval('.ep-row[data-ep="4"] .ep-note-btn', (e) => [e.getAttribute('aria-label'), e.title, !!e.querySelector('svg.review-ic')]);
  ok('the review button: the review mark, «Review this episode», filled once a note exists', lbl[2] && lbl[0] === lbl[1] && lbl[0].length > 5 && !!(await p.$('.ep-row[data-ep="3"] .ep-note-btn.on')) && !!(await p.$('.ep-row[data-ep="4"] .ep-note-btn:not(.on)')), lbl);
  const boxes = await p.$$eval('.ep-row[data-ep="3"] > button, .ep-row[data-ep="3"] > .icon-btn', (els) => els.map((e) => e.getBoundingClientRect().toJSON()));
  const touch = boxes.some((a, i) => boxes.some((b, j) => j > i && a.left < b.right + 2 && b.left < a.right + 2 && a.top < b.bottom && b.top < a.bottom));
  ok('at 360 px the row\'s buttons do not touch, and fit', !touch && boxes.every((b) => b.right <= 360 && b.left >= 0), boxes);
  await p.$eval('.ep-row[data-ep="3"]', (e) => e.scrollIntoView({ block: 'center' })); await shot(p, 'episode-review-btn-phone');
  // Once per episode; never lowered.
  await play(3); await toEnd(); await back();
  ok('the same episode watched again: nothing sent again', !(await settle(() => false, 1200)) && saves.length === 1 && malSets.length === 1, { saves, malSets });
  ok('…and no review offered: a note exists', !(await p.$('.review-bar')));
  state.progress = 10; await play(4); await toEnd(); await back();
  ok('review asked for episode 4 (no note there)', !!(await p.waitForSelector('.review-bar', { timeout: 6000 }).catch(() => null)));
  ok('an episode below the progress: never lowered', saves.length === 1, saves);
  // A finished download: progress moved, the episode's «once» not used up.
  state.progress = 1; await clear();
  await p.evaluate((ID) => { const t = { id: 'dl6', kind: 'http', name: 'Starlit 06.webm', source: { url: 'https://x/6' }, dir: '/sdcard/Download', state: 'downloading', done: 1, total: 2, downSpeed: 1, upSpeed: 0, files: [], meta: { anilistId: ID, episode: 6, title: 'Starlit Cafe' } }; window.__emit([...window.__tasks, t]); window.__emit([...window.__tasks.filter((x) => x.id !== 'dl6'), { ...t, state: 'done', done: 2 }]); }, ID);
  ok('a download finished: progress moved to 6', await (async () => { for (let i = 0; i < 40 && saves.length < 2; i++) await p.waitForTimeout(100); return saves.length === 2 && saves[1].progress === 6; })(), saves);
  ok('…without using up episode 6\'s «once»', !(await p.evaluate((ID) => JSON.parse(localStorage.getItem('kt.anime.tracked') || '[]').includes(`${ID}:6`), ID)));
  // Unreachable: kept, sent when back online, read anew.
  state.progress = 1; await p.evaluate(() => localStorage.removeItem('kt.anime.tracked')); await clear();
  state.failAll = true; await play(5); await toEnd(); await back();
  ok('unreachable: nothing sent, the episode kept', await settle(() => Object.keys(JSON.parse(localStorage.getItem('kt.tmp.animeWatchPending') || '{}')).length === 1) && saves.length === 2);
  state.failAll = false; await p.evaluate(() => window.dispatchEvent(new Event('online')));
  ok('back online: sent then, read anew (1 → 5)', await (async () => { for (let i = 0; i < 40 && saves.length < 3; i++) await p.waitForTimeout(100); return saves.length === 3 && saves[2].progress === 5; })() && (await p.evaluate(() => localStorage.getItem('kt.tmp.animeWatchPending'))) === '{}', saves);
  // The switch off: what was queued is dropped and nothing is sent by itself.
  state.progress = 1; await p.evaluate(() => localStorage.removeItem('kt.anime.tracked')); state.failAll = true; await play(4); await toEnd(); await back();
  await settle(() => Object.keys(JSON.parse(localStorage.getItem('kt.tmp.animeWatchPending') || '{}')).length === 1);
  await p.goto(`${BASE}/#/settings/anime`); await p.waitForSelector('#anime .notes-settings .switch-row input', { state: 'attached', timeout: 10000 });
  // (The row is found by its words, and the words can arrive a moment after the first switch: wait for THAT row — the release job once clicked before it was there.)
  await p.waitForFunction(() => [...document.querySelectorAll('#anime .notes-settings .switch-row')].some((r) => /Update my list|حدِّث قائمتي/.test(r.textContent || '') && r.querySelector('input')), null, { timeout: 10000 });
  await p.evaluate(() => { const row = [...document.querySelectorAll('#anime .notes-settings .switch-row')].find((r) => /Update my list|حدِّث قائمتي/.test(r.textContent)); row.querySelector('input').click(); });
  await settle(() => JSON.parse(localStorage.getItem('kt.settings')).animeTrackAfterWatch === false);
  ok('«Update my list after watching» off: the queue emptied', await settle(() => !Object.keys(JSON.parse(localStorage.getItem('kt.tmp.animeWatchPending') || '{}')).length));
  state.failAll = false; await p.evaluate(() => window.dispatchEvent(new Event('online')));
  await page(); await play(5); await toEnd(); await back();
  ok('…and nothing sent by itself, queued or new', !(await settle(() => false, 1500)) && saves.length === 3, saves);
  await setting('animeTrackAfterWatch', true); await setting('anilistPending', {});
  // A change of the user's own, queued while offline: put on the entry as AniList has it then.
  await page(true); state.progress = 2; state.score = 0; await page(true);
  state.failAll = true; await p.click('.progress-ctl button[data-icon="plus"]');
  await settle(() => Object.keys(JSON.parse(localStorage.getItem('kt.settings')).anilistPending || {}).length === 1);
  state.failAll = false; state.progress = 7; state.score = 9;   // (changed on AniList's site meanwhile)
  await p.evaluate(() => window.dispatchEvent(new Event('online')));
  ok('a queued +1 sent later: progress not lowered below what AniList has (7), its score kept (9)', await (async () => { for (let i = 0; i < 40 && saves.length < 4; i++) await p.waitForTimeout(100); const l = saves[saves.length - 1]; return saves.length === 4 && l.progress === 7 && l.score === 9; })(), saves.slice(-1));
  // Turned off: no review bar.
  await setting('animeAskReview', false); state.progress = 1; await p.evaluate(() => localStorage.removeItem('kt.anime.tracked'));
  await page(true); await play(4); await toEnd(); await back();
  ok('«Ask to review after watching» off: no bar', !(await p.waitForSelector('.review-bar', { timeout: 1500 }).catch(() => null)));
  await setting('animeAskReview', true);
  // Opened from the Downloads: back to the Downloads.
  await p.goto(`${BASE}/#/`); await p.waitForSelector('button[data-icon="play"]', { timeout: 10000 });
  await p.click('button[data-icon="play"]'); await p.waitForSelector('.kt-player video'); await back();
  ok('opened from the Downloads: back to the Downloads', ['#/', '', '#'].includes(await p.evaluate(() => location.hash)) && !(await p.$('.anime-entry')));
  // Another app's player: no record kept (nothing to go back to on a start).
  await setting('playerWith', 'external'); await page(true); await clear(); await p.click('.ep-row[data-ep="5"] button[data-icon="play"]');
  await settle(() => window.__ext.length > 0);
  ok('played in another app: no record of the page kept', (await p.evaluate(() => localStorage.getItem('kt.tmp.playerFrom'))) === null);
  await setting('playerWith', 'app');
  // The app started again behind the player (Android ends the page's process): the page and its history back.
  await p.goto('about:blank'); await p.goto(`${BASE}/#/anime?tab=season`); await p.waitForSelector('.anime-card', { timeout: 10000 });
  await p.click('.anime-card'); await p.waitForSelector('.ep-row[data-ep="5"] button[data-icon="play"]', { timeout: 10000 });
  await play(5); await settle(() => !!localStorage.getItem('kt.tmp.playerFrom'));
  await p.goto('about:blank'); await p.goto(`${BASE}/`);
  ok('started again behind the player: the show\'s page', await hashIs(`#/anime/${ID}`));
  await p.waitForSelector('.anime-entry-view .topbar button[data-icon="back"]'); await p.click('.anime-entry-view .topbar button[data-icon="back"]');
  ok('…and Back goes where it went before (the season chart), not the Downloads', await hashIs('#/anime?tab=season'), await p.evaluate(() => location.hash));
  await p.evaluate((ID) => localStorage.setItem('kt.tmp.playerFrom', JSON.stringify({ hash: `#/anime/${ID}`, at: Date.now() - 10 * 60e3, scroll: 0 })), ID);
  await p.goto('about:blank'); await p.goto(`${BASE}/`); await p.waitForSelector('.downloads-view', { timeout: 10000 });
  ok('a record from long ago: a normal start, on the Downloads', !(await hashIs(`#/anime/${ID}`)) && (await p.evaluate(() => localStorage.getItem('kt.tmp.playerFrom'))) === null);

  // ---- the floating download bar, from a real download (the Subtitles page) ----
  await p.goto(`${BASE}/#/settings/addons`); await p.waitForSelector('.addon-row');
  await p.click('.addon-row:has-text("Subtitles") .btn, .addon-row:has-text("الترجمات") .btn'); ok('the Subtitles add-on installed (its stand-in source too)', await settle(() => JSON.parse(localStorage.getItem('kt.settings')).addons.includes('subtitles'), 15000), await p.evaluate(() => document.querySelector('.addon-row:has(.btn)')?.textContent ?? ''));
  await p.goto(`${BASE}/#/subs?q=${encodeURIComponent('Starlit Cafe')}`); await p.waitForSelector('.title-card', { timeout: 15000 }); await p.click('.title-card');
  await p.waitForSelector('.sub-row', { timeout: 15000 }).catch(async (e) => { throw new Error('no subtitle rows from the stand-in source: ' + JSON.stringify(await p.evaluate(() => ({ hash: location.hash, addons: JSON.parse(localStorage.getItem('kt.settings')).addons, text: document.body.innerText.slice(0, 200) }))) + ' / ' + e.message.split('\n')[0]); }); await clear(); await p.click('.sub-row >> nth=0'); await p.waitForSelector('.dl-float');
  ok('a download started: the floating bar, the page stays', /#\/subs/.test(await p.evaluate(() => location.hash)) && /Starlit|subtitle|srt/i.test(await p.$eval('.dl-float .dlf-name', (e) => e.textContent)));
  const added = () => p.evaluate(() => window.__tasks.filter((x) => /^n/.test(x.id)));
  const emitAdded = (f) => p.evaluate((src) => { const fn = new Function('t', 'i', src); window.__emit(window.__tasks.map((t) => (/^n/.test(t.id) ? { ...t, ...fn(t, window.__tasks.filter((x) => /^n/.test(x.id)).indexOf(t)) } : t))); }, f);
  await emitAdded('return { done: 42, total: 100 };');
  ok('…its percentage and line follow the download', await settle(() => /42|٤٢/.test(document.querySelector('.dl-float .dlf-pct')?.textContent || '')) && /42/.test(await p.$eval('.dl-float .dlf-line i', (e) => e.style.width)));
  const opaque = await p.$eval('.dl-float', (e) => { const c = getComputedStyle(e).backgroundColor; const m = /rgba?\(([^)]+)\)/.exec(c); const a = m && m[1].split(',')[3]; return a === undefined || Number(a) === 1; });
  ok('…an opaque surface', opaque);
  const fb = await p.$eval('.dl-float', (e) => e.getBoundingClientRect().toJSON()); const nb = await p.$eval('.bottom-nav', (e) => e.getBoundingClientRect().toJSON()).catch(() => null);
  ok('…above the bottom bar, with a margin', !nb || fb.bottom < nb.top - 8, { fb, nb });
  await shot(p, 'dl-float-one-phone');
  ok('…its percentage in the page\'s own digits', await p.evaluate(() => { const pct = document.querySelector('.dl-float .dlf-pct').textContent; const arabic = /[٠-٩]/.test(pct); const pageArabic = /[٠-٩]/.test(document.querySelector('.subs-view, .view:not([hidden])')?.textContent.replace(pct, '') ?? ''); return arabic === pageArabic || !arabic; }));
  await p.click('.sub-row >> nth=1'); await settle(() => (window.__tasks.filter((x) => /^n/.test(x.id))).length === 2);
  await emitAdded('return i === 0 ? { done: 50, total: 100 } : { done: 30, total: 100 };');
  ok('two downloads: one bar, «count: 2», the overall progress (40%)', await settle(() => /40|٤٠/.test(document.querySelector('.dl-float .dlf-pct')?.textContent || '')) && /2|٢/.test(await p.$eval('.dl-float .dlf-name', (e) => e.textContent)));
  await shot(p, 'dl-float-many-phone');
  // (The same bar over the show's page.)
  await p.evaluate((ID) => { location.hash = `#/anime/${ID}`; }, ID); await p.waitForSelector('.ep-row[data-ep="5"]'); await p.waitForSelector('.dl-float:not([hidden])'); await shot(p, 'dl-float-many-anime-phone');
  ok('…opaque over the show\'s page too', await p.$eval('.dl-float', (e) => { const c = getComputedStyle(e).backgroundColor; const m = /rgba?\(([^)]+)\)/.exec(c); const a = m && m[1].split(',')[3]; return (a === undefined || Number(a) === 1) && getComputedStyle(e).opacity === '1'; }));
  await p.evaluate(() => history.back()); await p.waitForSelector('.sub-row');
  await p.evaluate(() => { location.hash = '#/'; }); ok('on the Downloads page: hidden', await settle(() => document.querySelector('.dl-float')?.hidden === true));
  await p.evaluate(() => history.back()); ok('…shown again when leaving it', await settle(() => document.querySelector('.dl-float')?.hidden === false));
  await emitAdded("return i === 0 ? { state: 'done', done: 100, total: 100 } : { state: 'failed', error: 'Disk full\\nmore detail', done: 30, total: 100 };");
  ok('a failure: kept, with its short reason', await settle(() => document.querySelector('.dl-float.failed') && /Disk full/.test(document.querySelector('.dl-float .dlf-pct').textContent) && !/more detail/.test(document.querySelector('.dl-float .dlf-pct').textContent)));
  await p.evaluate(() => window.__emit(window.__tasks.filter((x) => !/^n/.test(x.id))));
  ok('both removed from the list: the bar leaves', await settle(() => !document.querySelector('.dl-float:not(.leaving)')));
  await p.click('.sub-row >> nth=0'); await p.waitForSelector('.dl-float'); await p.click('.dl-float .dlf-main');
  ok('tapped: the Downloads, the bar gone', (await hashIs('#/')) && !(await p.$('.dl-float:not(.leaving)')));
  await setting('openDownloadsOnStart', true); await p.goto('about:blank'); await p.goto(`${BASE}/#/subs?q=${encodeURIComponent('Starlit Cafe')}`); await p.waitForSelector('.title-card', { timeout: 15000 }); await p.click('.title-card'); await p.waitForSelector('.sub-row', { timeout: 15000 }).catch(async (e) => { throw new Error('no subtitle rows from the stand-in source: ' + JSON.stringify(await p.evaluate(() => ({ hash: location.hash, addons: JSON.parse(localStorage.getItem('kt.settings')).addons, text: document.body.innerText.slice(0, 200) }))) + ' / ' + e.message.split('\n')[0]); });
  await clear(); await p.click('.sub-row >> nth=0');
  ok('«Open Downloads when a download starts» on: straight to the Downloads, no bar', (await hashIs('#/')) && !(await p.$('.dl-float')));
  await setting('openDownloadsOnStart', false);
  // The settings rows.
  await p.goto(`${BASE}/#/settings/anime`); await p.waitForSelector('#anime .notes-settings h4', { state: 'attached', timeout: 10000 });
  await p.$eval('.notes-settings', (e) => e.scrollIntoView({ block: 'start' })); await shot(p, 'settings-afterwatch-phone');
  ok('one switch for automatic updates: the AniList card has no second one', !(await p.$('#anilist .switch-row')));
  await p.goto(`${BASE}/#/settings/downloads`); await p.waitForSelector('#downloads .switch-row', { state: 'attached' }); await shot(p, 'settings-opendl-phone');
  ok(`${LANG}: ${LANG === 'ar' ? 'right to left' : 'left to right'}, nothing wider than the screen`, (await p.evaluate(() => document.documentElement.dir || 'ltr')) === (LANG === 'ar' ? 'rtl' : 'ltr') && (await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)));
  ok('no page errors (phone)', !p.errors.length, p.errors);

  // ---- a short phone screen, and the PC: the review bar and the download bar never in one spot ----
  const s = await mk({ width: 640, height: 360 }, true);
  for (const [q, name] of [[s, 'short-phone'], [await mk({ width: 1280, height: 800 }, false), 'pc']]) {
    await q.goto(`${BASE}/#/anime/${ID}`); await q.waitForSelector('.ep-row[data-ep="5"]', { timeout: 15000 });
    await q.evaluate((ID) => { sessionStorage.setItem('kt.anime.reviewAsk', JSON.stringify({ id: ID, ep: 5, at: Date.now() })); window.dispatchEvent(new CustomEvent('kt-anime-watched', { detail: { id: ID, ep: 5 } })); }, ID);
    await q.waitForSelector('.review-bar');
    // (A real download from this page: the episode's «Download the best release» needs sources; the Subtitles page's is used.)
    await q.goto(`${BASE}/#/settings/addons`); await q.waitForSelector('.addon-row', { state: 'attached' }); await q.evaluate(() => [...document.querySelectorAll('.addon-row')].find((r) => /Subtitles|الترجمات/.test(r.textContent))?.querySelector('.btn')?.click());
    await q.waitForFunction(() => JSON.parse(localStorage.getItem('kt.settings')).addons.includes('subtitles'), null, { timeout: 15000 });
    await q.goto(`${BASE}/#/subs?q=${encodeURIComponent('Starlit Cafe')}`); await q.waitForSelector('.title-card', { timeout: 15000 }); await q.click('.title-card'); await q.waitForSelector('.sub-row', { timeout: 15000 });
    await q.click('.sub-row >> nth=0'); await q.click('.sub-row >> nth=1'); await q.waitForSelector('.dl-float');
    await q.evaluate((ID) => { location.hash = `#/anime/${ID}`; }, ID); await q.waitForSelector('.ep-row[data-ep="5"]');
    await q.evaluate((ID) => { sessionStorage.setItem('kt.anime.reviewAsk', JSON.stringify({ id: ID, ep: 5, at: Date.now() })); window.dispatchEvent(new CustomEvent('kt-anime-watched', { detail: { id: ID, ep: 5 } })); }, ID);
    await q.waitForSelector('.review-bar'); await q.waitForSelector('.dl-float:not([hidden])');
    await q.waitForFunction(() => [...document.querySelectorAll('.review-bar, .dl-float')].every((e) => !e.getAnimations().length));
    const rb = await q.$eval('.review-bar', (e) => e.getBoundingClientRect().toJSON()); const db = await q.$eval('.dl-float', (e) => e.getBoundingClientRect().toJSON());
    ok(`${name}: the review bar and the download bar apart`, rb.bottom <= db.top || db.bottom <= rb.top, { rb, db });
    await shot(q, `review-and-dl-${name}`);
    if (name === 'pc') { await q.evaluate(() => document.querySelector('.ep-row[data-ep="4"]')?.scrollIntoView({ block: 'center' })); await shot(q, 'episode-review-btn-pc'); }
    ok(`no page errors (${name})`, !q.errors.length, q.errors);
  }
  await br.close(); web.close(); fs.rmSync(MEDIA, { recursive: true, force: true });
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + e.message); process.exit(1); });
