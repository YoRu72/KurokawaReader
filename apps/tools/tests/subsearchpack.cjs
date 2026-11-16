// The «Subtitles» sheet's search and its films (0.21 P7), on a stubbed phone (360 px), made-up titles only, the
// Subtitles add-on's sources replaced by one stand-in module served by this test (nothing reaches a real site):
//   the three buttons alike and apart; without the add-on, the search says so and offers the add-ons;
//   the search filled with the show's titles; a result chosen → fetched, attached to the show as its pack, what
//   matched shown (episodes with a file, the ones without), and Undo; a single file for one episode;
//   a film: its sheet, a folder with several files — the best by title and year, «several fit» said, chosen by hand —,
//   played with its file and the other languages beside it; a series pack holding two seasons, read per season.
// node tests/subsearchpack.cjs [en|ar]
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const { execFileSync } = require('node:child_process');
const LANG = process.argv[2] === 'ar' ? 'ar' : 'en';
const DIST = path.join(__dirname, '..', 'dist'); const REPO = path.join(__dirname, '..', '..', '..', 'repo');
const MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-subsearch-')); const SHOTS = process.env.KT_SHOTS || MEDIA;
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 400))); if (!c) fails++; };
fs.mkdirSync(path.join(MEDIA, 'Download')); fs.mkdirSync(path.join(MEDIA, 'Subs', 'Moon'), { recursive: true }); fs.mkdirSync(path.join(MEDIA, 'Subs', 'Night'), { recursive: true }); fs.mkdirSync(path.join(MEDIA, 'served'));
try { execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-t', '6', '-c:v', 'libvpx', '-b:v', '200k', path.join(MEDIA, 'Download', 'Moon Harbor (2019).webm')]); }
catch { console.log('ffmpeg not available — skipped'); process.exit(0); }
const srt = (x) => `1\n00:00:00,000 --> 00:01:00,000\n${x}\n`;
const ass = (x) => `[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize\nStyle: Default,Arial,40\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:01:00.00,Default,,0,0,0,,${x}\n`;
for (const [n, x] of [['Moon Harbor 2019 [en].srt', 'MOON EN'], ['Moon Harbor 2019 [ar].srt', 'MOON AR'], ['Moon Harbor 2019 alt [en].srt', 'MOON ALT'], ['Other Film 2001.srt', 'OTHER']]) fs.writeFileSync(path.join(MEDIA, 'Subs', 'Moon', n), srt(x));
for (const s of [1, 2]) for (const e of [1, 2]) fs.writeFileSync(path.join(MEDIA, 'Subs', 'Night', `Night Desk S0${s}E0${e}.srt`), srt(`NIGHT ${s}-${e}`));
// What the stand-in source hands out: a season's archive (episodes 1, 2 and 4), one episode's file, a file with no number.
const zsrc = path.join(MEDIA, 'zsrc'); fs.mkdirSync(zsrc); for (const e of [1, 2, 4]) fs.writeFileSync(path.join(zsrc, `Starlit Cafe - 0${e}.ass`), ass(`ZIP ${e}`));
execFileSync('python3', ['-I', '-c', 'import sys,zipfile,os\nz=zipfile.ZipFile(sys.argv[1],"w")\nfor f in sorted(os.listdir(sys.argv[2])): z.write(os.path.join(sys.argv[2],f), f)\nz.close()', path.join(MEDIA, 'served', 'pack.zip'), zsrc]);
fs.writeFileSync(path.join(MEDIA, 'served', 'Starlit Cafe - 03.ass'), ass('SINGLE 3'));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webm': 'video/webm' };
const web = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = p.startsWith('/media/') ? path.join(MEDIA, p.slice(7)) : path.join(DIST, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'access-control-allow-origin': '*' }); fs.createReadStream(f).pipe(res);
});
const ID = 4242;
const MEDIA_AL = { id: ID, idMal: 4343, title: { romaji: 'Hoshizora Kissa', english: 'Starlit Cafe', native: '星空喫茶', userPreferred: 'Starlit Cafe' }, synonyms: ['Cafe Under Stars'], coverImage: { large: '', extraLarge: '', color: '#5c6bc0' }, format: 'TV', status: 'FINISHED', episodes: 4, season: 'FALL', seasonYear: 2026, startDate: { year: 2026, month: 10, day: 1 }, genres: [], averageScore: 70, popularity: 10, isAdult: false, siteUrl: `https://anilist.co/anime/${ID}`, nextAiringEpisode: null, duration: 24, description: 'Made up.', studios: { nodes: [] }, airingSchedule: { nodes: [] }, streamingEpisodes: [], externalLinks: [], relations: { edges: [] }, mediaListEntry: null };
const MOVIE = { id: 'tt7654321', imdb_id: 'tt7654321', type: 'movie', name: 'Moon Harbor', poster: '', releaseInfo: '2019', year: '2019', genres: ['Drama'], description: 'A made-up film.' };
const SERIES = { id: 'tt1112223', imdb_id: 'tt1112223', type: 'series', name: 'Night Desk', poster: '', releaseInfo: '2020–', genres: ['Drama'], description: 'Made up.', videos: [1, 2].flatMap((s) => [1, 2].map((e) => ({ id: `tt1112223:${s}:${e}`, season: s, episode: e, name: `Ep ${e}`, released: `202${s}-01-0${e}T00:00:00.000Z` }))) };

(async () => {
  web.listen(0); const port = web.address().port; const BASE = `http://127.0.0.1:${port}`;
  // The index the app reads: the Subtitles add-on with one stand-in source (its module written here).
  const ix = JSON.parse(fs.readFileSync(path.join(REPO, 'tools', 'index.json'), 'utf8'));
  ix.addons = ix.addons.filter((a) => a.kind !== 'subtitle-source'); ix.addons.find((a) => a.id === 'subtitles').children = ['subs-standin'];
  ix.addons.push({ id: 'subs-standin', kind: 'subtitle-source', parent: 'subtitles', name: 'Stand-in', description: 'A test source.', version: '1.0.0', module: 'subs/standin.mjs', icon: 'subtitles' });
  const MOD = `export async function search(q) { (globalThis.__subQ ??= []).push(q); return [
    { title: 'Starlit Cafe — the whole season', language: 'en', site: 'Stand-in', url: '${BASE}/media/served/pack.zip', archive: 'zip', downloads: 9 },
    { title: 'Starlit Cafe - 03', language: 'en', site: 'Stand-in', url: '${BASE}/media/served/Starlit%20Cafe%20-%2003.ass', episode: 3, downloads: 5 } ]; }`;
  const br = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await br.newPage({ viewport: { width: 360, height: 760 }, hasTouch: true, isMobile: true }); const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => {
    const u = r.request().url(); const m = /\/main\/repo\/(.*)$/.exec(u);
    if (m && m[1] === 'tools/index.json') return r.fulfill({ json: ix });
    if (m && m[1] === 'tools/subs/standin.mjs') return r.fulfill({ body: MOD, contentType: 'text/plain' });
    if (m) { const f = path.join(REPO, m[1]); return fs.existsSync(f) ? r.fulfill({ body: fs.readFileSync(f) }) : r.fulfill({ status: 404, body: '' }); }
    return r.fulfill({ status: 404, body: '' });
  });
  await p.exposeFunction('__http', (o) => {
    if (/graphql\.anilist\.co/.test(o.url)) { const q = JSON.parse(o.body || '{}').query || ''; return { status: 200, headers: {}, body: JSON.stringify({ data: /Media\(id/.test(q) ? { Media: MEDIA_AL } : { Page: { pageInfo: { hasNextPage: false }, media: [MEDIA_AL] } } }) }; }
    if (/v3-cinemeta\.strem\.io\/meta\/movie/.test(o.url)) return { status: 200, headers: {}, body: JSON.stringify({ meta: MOVIE }) };
    if (/v3-cinemeta\.strem\.io\/meta\/series/.test(o.url)) return { status: 200, headers: {}, body: JSON.stringify({ meta: SERIES }) };
    const sv = /^http:\/\/127\.0\.0\.1:\d+\/media\/(served\/.*)$/.exec(o.url);
    if (sv) { const f = path.join(MEDIA, decodeURIComponent(sv[1])); if (fs.existsSync(f)) { const b = fs.readFileSync(f); return { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: o.binary ? b.toString('base64') : b.toString('utf8') }; } }
    return { status: 404, headers: {}, body: '' };
  });
  const real = (p0) => path.join(MEDIA, p0.replace(/^\/sdcard\/?/, ''));
  await p.exposeFunction('__ls', (dir) => { const d = real(dir); if (!fs.existsSync(d)) return { exists: false, entries: [] }; return { exists: true, entries: fs.readdirSync(d).map((n) => { const st = fs.statSync(path.join(d, n)); return { name: n, path: `${dir.replace(/\/$/, '')}/${n}`, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs }; }) }; });
  await p.exposeFunction('__mkdir', (d) => { fs.mkdirSync(real(d), { recursive: true }); return {}; });
  await p.exposeFunction('__write', (o) => { fs.mkdirSync(path.dirname(real(o.path)), { recursive: true }); fs.writeFileSync(real(o.path), o.text); return {}; });
  await p.addInitScript(([port, lang]) => {
    if (!localStorage.getItem('kt.settings')) { localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['player', 'anime', 'tv'], playerWith: 'app', downloadDir: '/sdcard/Download' })); localStorage.setItem('kt.player', JSON.stringify({ autoSubs: false, resume: 'never' })); localStorage.setItem('kt.update.lastCheck', String(Date.now())); }
    const movie = { id: 'mv', kind: 'http', name: 'Moon Harbor (2019).webm', source: { url: 'https://x/m.webm' }, dir: '/sdcard/Download', state: 'done', done: 1, total: 1, downSpeed: 0, upSpeed: 0, files: [{ index: 0, path: 'Moon Harbor (2019).webm', size: 1, done: 1, priority: 1 }], addedAt: Date.now() - 6e4, doneAt: Date.now() - 5e4, meta: { imdbId: 'tt7654321', title: 'Moon Harbor' } };
    const api = { addListener: () => Promise.resolve({ remove() {} }), list: async () => ({ tasks: [movie] }), localUrl: async (o) => ({ url: `http://127.0.0.1:${port}/media/${o.path.replace(/^\/sdcard\//, '')}` }), siblings: async () => ({ paths: [] }),
      filesList: async (o) => window.__ls(o.path), filesMkdir: async (o) => window.__mkdir(o.path), filesWrite: async (o) => window.__write(o), defaultDir: async () => ({ dir: '/sdcard/Download' }),
      pickDir: async () => ({ dir: window.__pickDir }), pickFile: async () => ({ paths: [window.__pickFile] }), httpRequest: async (o) => window.__http(o) };
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) }) }, PluginHeaders: [] };
  }, [port, LANG]);
  const shot = (n) => p.screenshot({ path: path.join(SHOTS, `p7-${n}-${LANG}.png`) });
  const clear = () => p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim, .toast').forEach((e) => e.remove()));
  const animeSheet = async () => { await p.goto(`${BASE}/#/anime/${ID}`); await p.waitForSelector('.subs-btn', { timeout: 15000 }); await clear(); await p.click('.subs-btn'); await p.waitForSelector('.pack-sheet .pack-find'); };

  // ---- the sheet's three buttons; no add-on ----
  await animeSheet();
  const bx = await p.$$eval('.pack-sheet .row-actions .btn', (els) => els.map((e) => e.getBoundingClientRect().toJSON()));
  const touching = bx.some((a, i) => bx.some((b, j) => j > i && a.left < b.right + 4 && b.left < a.right + 4 && a.top < b.bottom + 4 && b.top < a.bottom + 4));
  ok('three buttons: folder, archive, search — one height, apart, inside 360 px', bx.length === 3 && new Set(bx.map((b) => Math.round(b.height))).size === 1 && !touching && bx.every((b) => b.right <= 360), bx);
  await p.waitForTimeout(200); await shot('subs-sheet-phone');
  await p.click('.pack-sheet .pack-find'); await p.waitForSelector('.sheet .btn.filled');
  ok('without the Subtitles add-on: said, with the way to the add-ons', !!(await p.$('.sheet .btn.filled')));
  await shot('subs-noaddon-phone');
  // ---- the add-on installed (its one stand-in source) ----
  await clear(); await p.goto(`${BASE}/#/settings/addons`); await p.waitForSelector('.addon-row');
  await p.click('.addon-row:has-text("Subtitles") .btn, .addon-row:has-text("الترجمات") .btn'); await p.waitForFunction(() => JSON.parse(localStorage.getItem('kt.settings')).addons.includes('subtitles'), null, { timeout: 15000 });
  await animeSheet(); await p.click('.pack-sheet .pack-find'); await p.waitForSelector('.sheet input[type=search]');
  ok('the search filled with the show\'s title', /Starlit Cafe/.test(await p.inputValue('.sheet input[type=search]')));
  await p.click('.sheet button[type=submit], .sheet .btn.primary').catch(() => undefined);
  await p.waitForSelector('.sheet .result-row', { timeout: 15000 });
  const q = await p.evaluate(() => globalThis.__subQ?.[0]);
  ok('…asked with the show\'s titles and ids', q && /Starlit/.test(q.title) && (q.titles || []).some((x) => /Hoshizora/.test(x)) && q.anilistId === 4242, q);
  await shot('subs-results-phone');
  // The season's archive: attached, matched, the missing episode said; Undo.
  const seen = []; p.on('console', (m) => seen.push(m.text().slice(0, 200)));
  const toasts = setInterval(() => void p.evaluate(() => [...document.querySelectorAll('.toast')].map((e) => e.textContent)).then((x) => { for (const y of x) if (!seen.includes(y)) seen.push(y); }).catch(() => undefined), 300);
  await p.locator('.sheet .result-row', { hasText: 'whole season' }).click();
  await p.waitForSelector('.pack-sheet .pack-ep[data-ep="1"]', { timeout: 15000 }).catch(() => console.log('seen:', JSON.stringify(seen)));
  clearInterval(toasts);
  await p.waitForFunction(() => /01/.test(document.querySelector('.pack-ep[data-ep="1"] .name')?.textContent || ''), null, { timeout: 8000 }).catch(() => undefined);
  const rows = await p.$$eval('.pack-ep', (els) => els.map((e) => ({ ep: e.dataset.ep, name: e.querySelector('.name').textContent, missing: e.classList.contains('missing') })));
  ok('an archive chosen: attached as the pack, episodes 1, 2, 4 matched, 3 marked missing', rows.length === 4 && !rows[0].missing && !rows[1].missing && rows[2].missing && !rows[3].missing, rows);
  ok('…the count and the missing one said', /3|٣/.test(await p.$eval('.pack-count', (e) => e.textContent)));
  ok('…and Undo offered', !!(await p.$('.toast.with-action')));
  await shot('subs-attached-phone');
  await p.click('.toast.with-action .toast-act'); await p.waitForTimeout(800);
  ok('Undo: the show has no pack again', !(await p.$('.pack-sheet .pack-current')) && !!(await p.$('.pack-sheet .pack-find')));
  await p.click('.pack-sheet .pack-find'); await p.waitForSelector('.sheet input[type=search]'); await p.click('.sheet button[type=submit], .sheet .btn.primary').catch(() => undefined);
  await p.waitForSelector('.sheet .result-row', { timeout: 15000 }); await p.locator('.sheet .result-row', { hasText: 'whole season' }).click(); await p.waitForSelector('.pack-sheet .pack-ep[data-ep="4"]', { timeout: 15000 });
  // One episode's file: the missing episode 3 gets it.
  await p.click('.pack-sheet .pack-find'); await p.waitForSelector('.sheet input[type=search]');
  const epIn = await p.$$('.sheet input[type=number]'); if (epIn.length) await epIn[epIn.length - 1].fill('3');
  await p.click('.sheet button[type=submit], .sheet .btn.primary').catch(() => undefined); await p.waitForSelector('.sheet .result-row', { timeout: 15000 });
  await p.locator('.sheet .result-row', { hasText: '- 03' }).click();
  await p.waitForFunction(() => { const r = document.querySelector('.pack-ep[data-ep="3"]'); return r && !r.classList.contains('missing'); }, null, { timeout: 15000 }).catch(async () => console.log('state:', await p.evaluate(() => [...document.querySelectorAll('.toast, .sheet h2, .sheet .sheet-title, .pack-ep')].map((e) => e.className + ':' + e.textContent.slice(0, 80)))));
  ok('one episode\'s file: episode 3 has it now', !(await p.$eval('.pack-ep[data-ep="3"]', (e) => e.classList.contains('missing'))));

  // ---- a film ----
  await clear(); await p.goto(`${BASE}/#/tv/movie/tt7654321`); await p.waitForSelector('.subs-btn', { timeout: 15000 }).catch(() => undefined);
  ok('a film\'s page has the Subtitles control', !!(await p.$('.subs-btn')));
  await p.click('.subs-btn'); await p.waitForSelector('.pack-sheet .pack-find');
  ok('…its sheet: the film\'s own text, the three buttons', /film|فيلم|映画|영화|电影/i.test(await p.$eval('.pack-sheet .hint', (e) => e.textContent)) && (await p.$$('.pack-sheet .row-actions .btn')).length === 3);
  await p.evaluate(() => { window.__pickDir = '/sdcard/Subs/Moon'; }); await p.click('.pack-sheet .pack-pick-folder');
  await p.waitForSelector('.pack-movie', { timeout: 8000 });
  const mv = await p.$eval('.pack-movie', (e) => e.textContent);
  // (English first: two English files fit alike — «several» said; Arabic first: the Arabic one, alone.)
  ok('a folder of several files: the best by title, year and the first language plays (several alike: said)', LANG === 'ar' ? /2019 \[ar\]/.test(mv) : /Moon Harbor 2019/.test(mv) && !/Other Film/.test(mv) && /tap/.test(mv), mv);
  await shot('subs-movie-phone');
  await p.click('.pack-movie'); await p.waitForSelector('.pack-files .pack-file'); await p.locator('.pack-files .pack-file', { hasText: 'alt' }).click();
  await p.waitForFunction(() => /alt/.test(document.querySelector('.pack-movie')?.textContent || ''), null, { timeout: 5000 }).catch(() => undefined);
  ok('chosen by hand: kept', /alt/.test(await p.$eval('.pack-movie', (e) => e.textContent)));
  // Played: the chosen file shown, the other languages beside it.
  await clear(); await p.goto(`${BASE}/#/`); await p.waitForSelector('button[data-icon="play"]', { timeout: 10000 }); await p.click('button[data-icon="play"]'); await p.waitForSelector('.kt-player video');
  const cue = await p.waitForFunction(() => /MOON ALT/.test(document.querySelector('.kt-subs')?.textContent || ''), null, { timeout: 10000 }).then(() => true, () => false);
  ok('the film played: its chosen file shown', cue);
  await p.click('.kt-top button[data-icon="subtitles"]'); await p.waitForSelector('.sheet .dest-list');
  const tr = await p.$$eval('.sheet .dest-list .dest-row .name', (els) => els.map((e) => e.textContent));
  ok('…the other languages beside it as tracks', tr.some((x) => /\[ar\]/.test(x)) && tr.some((x) => /2019 \[en\]/.test(x)), tr);
  await clear(); await p.click('.kt-top button[data-icon="back"]'); await p.waitForSelector('.kt-player', { state: 'detached' });

  // ---- a series pack holding two seasons ----
  await p.goto(`${BASE}/#/tv/series/tt1112223`); await p.waitForSelector('.subs-btn', { timeout: 15000 }).catch(async () => { await shot('debug-series'); console.log('series page:', (await p.evaluate(() => document.querySelector('.view:not([hidden])')?.innerText || '')).slice(0, 300)); });
  const s2 = await p.$('button.chip:has-text("2")'); if (s2) await s2.click();
  await p.click('.subs-btn'); await p.waitForSelector('.pack-sheet'); await p.evaluate(() => { window.__pickDir = '/sdcard/Subs/Night'; }); await p.click('.pack-sheet .pack-pick-folder');
  await p.waitForSelector('.pack-ep[data-ep="2"]', { timeout: 8000 }).catch(() => undefined);
  const sr = await p.$$eval('.pack-ep', (els) => els.map((e) => e.querySelector('.name').textContent));
  ok('a two-season pack: this season\'s files', sr.length === 2 && sr.every((x) => (s2 ? /S02/ : /S01/).test(x)), sr);
  await shot('subs-series-phone');
  ok(`${LANG}: laid out ${LANG === 'ar' ? 'right to left' : 'left to right'}, nothing wider than the screen`, (await p.evaluate(() => document.documentElement.dir || 'ltr')) === (LANG === 'ar' ? 'rtl' : 'ltr') && (await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)));
  ok('no page errors', !errors.length, errors);
  // ---- PC: the sheet ----
  await p.setViewportSize({ width: 1280, height: 800 }); await animeSheet(); await p.waitForTimeout(300); await shot('subs-sheet-pc');
  await br.close(); web.close(); fs.rmSync(MEDIA, { recursive: true, force: true });
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + e.message); process.exit(1); });
