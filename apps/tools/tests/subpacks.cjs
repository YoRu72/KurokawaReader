// node tests/subpacks.cjs [en|ar]: a show's subtitle pack on a stubbed phone — a folder assigned from the anime page,
// its episodes listed (and the missing ones); episode 3 played → its file loaded with no prompt, the online search not
// run over it; episode 4 its own, its other variant a track; a wrong pick corrected by hand (loaded, remembered on
// reopening, shown on the page, the shift offered), then back to automatic; an episode the pack lacks → one toast
// and the normal search; a real ZIP as the pack; the pack removed → nothing loaded; the TV page's control.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const { execFileSync } = require('node:child_process');
const LANG = process.argv[2] === 'ar' ? 'ar' : 'en';
const DIST = path.join(__dirname, '..', 'dist'); const MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-subpacks-'));
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
fs.mkdirSync(path.join(MEDIA, 'Download')); fs.mkdirSync(path.join(MEDIA, 'Subs', 'Frieren', 'Fonts'), { recursive: true });
try { execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '12', '-c:v', 'libvpx', '-b:v', '300k', '-c:a', 'libopus', path.join(MEDIA, 'Download', 'clip.webm')]); }
catch { console.log('ffmpeg not available — skipped'); process.exit(0); }
for (const e of [3, 4, 5]) fs.copyFileSync(path.join(MEDIA, 'Download', 'clip.webm'), path.join(MEDIA, 'Download', `Frieren 0${e}.webm`));
const srt = (text) => `1\n00:00:00,000 --> 00:01:00,000\n${text}\n`;
const SUBS = path.join(MEDIA, 'Subs', 'Frieren');
fs.writeFileSync(path.join(SUBS, '[G] Frieren - 03 [ABCD1234].srt'), srt('PACK EP3'));
fs.writeFileSync(path.join(SUBS, '[G] Frieren - 04 (1080p).srt'), srt('PACK EP4 G'));
fs.writeFileSync(path.join(SUBS, '[H] Frieren - 04 (1080p).srt'), srt('PACK EP4 H'));
fs.writeFileSync(path.join(SUBS, '[G] Frieren - 07 (1080p).srt'), srt('PACK EP7'));
fs.copyFileSync(path.join(__dirname, 'fixtures', 'Caladea-Bold.ttf'), path.join(SUBS, 'Fonts', 'Caladea-Bold.ttf'));
// (A real zip, made by Python's zipfile.)
const zipSrc = path.join(MEDIA, 'zipsrc'); fs.mkdirSync(path.join(zipSrc, 'Fonts'), { recursive: true });
fs.writeFileSync(path.join(zipSrc, 'Frieren S01E03.srt'), srt('ZIP EP3')); fs.writeFileSync(path.join(zipSrc, 'Frieren S01E04.srt'), srt('ZIP EP4')); fs.copyFileSync(path.join(__dirname, 'fixtures', 'Caladea-Bold.ttf'), path.join(zipSrc, 'Fonts', 'Caladea-Bold.ttf'));
execFileSync('python3', ['-I', '-c', 'import sys,zipfile,os\nz=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED)\nfor r,_,fs in os.walk(sys.argv[2]):\n  for f in fs: p=os.path.join(r,f); z.write(p, os.path.relpath(p, sys.argv[2]))\nz.close()', path.join(MEDIA, 'Subs', 'frieren.zip'), zipSrc]);
const real = (p) => path.join(MEDIA, p.replace(/^\/sdcard\/?/, ''));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webm': 'video/webm' };
const web = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = p.startsWith('/media/') ? path.join(MEDIA, p.slice(7)) : path.join(DIST, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  const size = fs.statSync(f).size; const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || ''); const type = MIME[path.extname(f)] || 'application/octet-stream';
  if (range) { const a = Number(range[1]), b = range[2] ? Number(range[2]) : size - 1; res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${a}-${b}/${size}`, 'accept-ranges': 'bytes', 'content-length': b - a + 1, 'access-control-allow-origin': '*' }); fs.createReadStream(f, { start: a, end: b }).pipe(res); return; }
  res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size, 'access-control-allow-origin': '*' }); fs.createReadStream(f).pipe(res);
});
const AL_ID = 154587;
const MEDIA_AL = { id: AL_ID, idMal: 52991, title: { romaji: 'Sousou no Frieren', english: 'Frieren', native: '葬送のフリーレン', userPreferred: 'Frieren' }, synonyms: [], coverImage: { large: '', extraLarge: '', color: '#5c6bc0' }, format: 'TV', status: 'FINISHED', episodes: 12, season: 'FALL', seasonYear: 2023, startDate: { year: 2023, month: 10, day: 1 }, genres: ['Fantasy'], averageScore: 90, popularity: 1, isAdult: false, siteUrl: `https://anilist.co/anime/${AL_ID}`, nextAiringEpisode: null, mediaListEntry: null, duration: 24, description: 'A synopsis.', studios: { nodes: [] }, airingSchedule: { nodes: [] }, streamingEpisodes: [], externalLinks: [], relations: { edges: [] } };
const SERIES = { id: 'tt1234567', imdb_id: 'tt1234567', type: 'series', name: 'Night Shift', poster: '', releaseInfo: '2020–', genres: ['Drama'], description: 'A hospital at night.', videos: [1, 2, 3].map((e) => ({ id: `tt1234567:1:${e}`, season: 1, episode: e, name: `Ep ${e}`, released: '2020-01-0' + e + 'T00:00:00.000Z' })) };
(async () => {
  web.listen(0); const port = web.address().port;
  const br = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const p = await br.newPage({ viewport: { width: 412, height: 860 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  const httpLog = [];
  await p.exposeFunction('__ls', (dir) => { const d = real(dir); if (!fs.existsSync(d)) return { exists: false, entries: [] }; return { exists: true, entries: fs.readdirSync(d).map((n) => { const st = fs.statSync(path.join(d, n)); return { name: n, path: `${dir.replace(/\/$/, '')}/${n}`, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs }; }) }; });
  await p.exposeFunction('__http', (o) => {
    httpLog.push(o.url);
    if (/graphql\.anilist\.co/.test(o.url)) { const q = JSON.parse(o.body || '{}').query || ''; if (/Media\(id/.test(q)) return { status: 200, headers: {}, body: JSON.stringify({ data: { Media: MEDIA_AL } }) }; return { status: 200, headers: {}, body: JSON.stringify({ data: { Page: { pageInfo: { hasNextPage: false }, media: [MEDIA_AL] } } }) }; }
    if (/v3-cinemeta\.strem\.io\/meta/.test(o.url)) return { status: 200, headers: {}, body: JSON.stringify({ meta: SERIES }) };
    return { status: 404, headers: {}, body: '' };
  });
  await p.addInitScript(([port, lang, AL_ID]) => {
    localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['player', 'anime', 'tv', 'subtitles'], playerWith: 'app' }));
    if (!localStorage.getItem('kt.player')) localStorage.setItem('kt.player', JSON.stringify({ autoSubs: true }));
    const task = (e) => ({ id: `ep${e}`, kind: 'http', name: `Frieren 0${e}.webm`, source: { url: `https://x/${e}.webm` }, dir: '/sdcard/Download', state: 'done', done: 1, total: 1, downSpeed: 0, upSpeed: 0, files: [{ index: 0, path: `Frieren 0${e}.webm`, size: 1, done: 1, priority: 1 }], addedAt: Date.now() - 60e3, doneAt: Date.now(), engine: 'native', meta: { anilistId: AL_ID, episode: e, title: 'Frieren' } });
    const tasks = [task(3), task(4), task(5)];
    const api = {
      addListener: () => Promise.resolve({ remove() {} }), list: async () => ({ tasks }),
      localUrl: async (o) => ({ url: `http://127.0.0.1:${port}/media/${o.path.replace(/^\/sdcard\//, '')}` }), siblings: async () => ({ paths: [] }),
      filesList: async (o) => window.__ls(o.path), pickDir: async () => ({ dir: window.__pickDir }), pickFile: async () => ({ paths: [window.__pickFile] }),
      httpRequest: async (o) => window.__http(o),
    };
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) }) }, PluginHeaders: [] };
  }, [port, LANG, AL_ID]);
  const clear = () => p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim, .toast').forEach((e) => e.remove()));
  const page = async () => { await p.goto(`http://127.0.0.1:${port}/#/anime/${AL_ID}`); await p.waitForSelector('.ep-row[data-ep="3"] button[data-icon="play"]', { timeout: 15000 }); };
  const packSheet = async () => { await clear(); await p.click('.subs-btn'); await p.waitForSelector('.pack-sheet'); };
  const cue = (re, ms = 10000) => p.waitForFunction((src) => new RegExp(src).test(document.querySelector('.kt-subs')?.textContent || ''), re.source, { timeout: ms }).then(() => true, () => false);
  const subsNow = () => p.evaluate(() => document.querySelector('.kt-subs')?.textContent || '');
  const play = async (e) => { await clear(); await p.click(`.ep-row[data-ep="${e}"] button[data-icon="play"]`); await p.waitForSelector('.kt-player video.kt-video'); };
  const closePlayer = async () => { await clear(); await p.click('.kt-top button[data-icon="back"]'); await p.waitForSelector('.kt-player', { state: 'detached' }); };
  const subsSheet = async () => { await clear(); await p.click('.kt-top button[data-icon="subtitles"]'); await p.waitForSelector('.sheet .kt-pack'); };

  // A folder assigned from the anime page.
  await page(); await packSheet();
  ok('the page\'s sheet: no pack yet, a folder or an archive to choose, and the search', !!(await p.$('.pack-sheet .pack-pick-folder')) && !!(await p.$('.pack-sheet .pack-pick-archive')) && !!(await p.$('.pack-sheet .pack-find')));
  await p.evaluate(() => { window.__pickDir = '/sdcard/Subs/Frieren'; }); await p.click('.pack-sheet .pack-pick-folder');
  await p.waitForSelector('.pack-ep[data-ep="3"]', { timeout: 8000 }).catch(() => undefined);
  const rows = await p.$$eval('.pack-ep', (els) => els.map((e) => ({ ep: e.dataset.ep, name: e.querySelector('.name').textContent, missing: e.classList.contains('missing') })));
  ok('its episodes listed with their files, the show\'s twelve', rows.length === 12 && /03/.test(rows[2].name) && /\[G\].*04/.test(rows[3].name) && /07/.test(rows[6].name), rows.slice(0, 7));
  ok('the missing ones marked and counted', rows[4].missing && rows[0].missing && !rows[2].missing && /(1|١).*(2|٢).*(5|٥)/.test(await p.$eval('.pack-count', (e) => e.textContent)), await p.$eval('.pack-count', (e) => e.textContent));
  await p.screenshot({ path: path.join(MEDIA, `sheet-${LANG}.png`) });
  // Episode 3: loaded with no prompt; the online search not run over it.
  await play(3); ok('episode 3: its pack file loaded by itself', await cue(/PACK EP3/));
  ok('…with no prompt', !(await p.$('.sheet')));
  const before = httpLog.length; await p.waitForTimeout(5500);
  ok('…the online auto-search did not replace it (nor ran)', /PACK EP3/.test(await subsNow()) && !httpLog.slice(before).some((u) => /anilist|cinemeta/.test(u)), httpLog.slice(before));
  await closePlayer();
  // Episode 4: its own file; the other group's a track.
  await play(4); ok('episode 4: its own file', await cue(/PACK EP4 G/));
  await subsSheet();
  const tracks = await p.$$eval('.sheet .dest-list .dest-row .name', (els) => els.map((e) => e.textContent));
  ok('the other variant of episode 4 is a track to switch to', tracks.some((x) => /\[H\]/.test(x)), tracks);
  ok('the sheet tells the pack and this episode\'s file', /04/.test(await p.$eval('.sheet .pack-this', (e) => e.textContent)));
  // A wrong pick corrected by hand: every file listed, the chosen one loaded, the shift offered.
  await p.click('.sheet .pack-choose'); await p.waitForSelector('.pack-files .pack-file');
  const listed = await p.$$eval('.pack-files .pack-file .name', (els) => els.map((e) => e.textContent));
  ok('«Choose another file» lists every subtitle in the pack, the matching ones first', listed.length === 4 && /04/.test(listed[0]) && /04/.test(listed[1]), listed);
  await p.locator('.pack-files .pack-file', { hasText: '07' }).click();
  ok('the file picked by hand loaded', await cue(/PACK EP7/));
  ok('the shift it implies offered in a toast with an action', !!(await p.waitForSelector('.toast.with-action', { timeout: 3000 }).catch(() => null)));
  await closePlayer(); await play(4);
  ok('reopened: the hand-picked file kept for the episode', await cue(/PACK EP7/));
  await p.waitForTimeout(4500); ok('…and not replaced by the automatic search', /PACK EP7/.test(await subsNow()));
  await closePlayer(); await packSheet(); await p.waitForSelector('.pack-ep[data-ep="4"]');
  ok('the page shows the hand-picked file for episode 4', await p.$eval('.pack-ep[data-ep="4"]', (e) => /07/.test(e.querySelector('.name').textContent) && !!e.querySelector('small')));
  await clear(); await play(4); await cue(/PACK EP7/); await subsSheet(); await p.click('.sheet .pack-auto');
  ok('«Back to automatic»: the matched file again', await cue(/PACK EP4 G/));
  await closePlayer(); await play(4); ok('…and so on reopening', await cue(/PACK EP4 G/)); await closePlayer();
  // The page's mapping changed by hand.
  await packSheet(); await p.click('.pack-ep[data-ep="3"]'); await p.waitForSelector('.pack-files .pack-file'); await p.locator('.pack-files .pack-file', { hasText: '07' }).click();
  await p.waitForFunction(() => /07/.test(document.querySelector('.pack-ep[data-ep="3"] .name')?.textContent || ''), null, { timeout: 4000 }).catch(() => undefined);
  ok('the page\'s list changes an episode\'s file', /07/.test(await p.$eval('.pack-ep[data-ep="3"] .name', (e) => e.textContent)));
  await clear(); await play(3); ok('…and the player follows it', await cue(/PACK EP7/)); await subsSheet(); await p.click('.sheet .pack-auto'); await cue(/PACK EP3/); await closePlayer();
  // An episode the pack lacks: one toast, the normal behaviour.
  const b5 = httpLog.length; await play(5);
  const t5 = await p.waitForSelector('.toast', { timeout: 6000 }).then((e) => e.textContent(), () => '');
  ok('episode 5 (not in the pack): a toast says so', /[5٥]/.test(t5), t5);
  await p.waitForTimeout(5500); ok('…and the online auto-search runs as usual', httpLog.slice(b5).some((u) => /anilist|cinemeta/.test(u)), httpLog.slice(b5));
  await closePlayer();
  // A ZIP pack.
  await packSheet(); await p.evaluate(() => { window.__pickFile = '/sdcard/Subs/frieren.zip'; }); await p.click('.pack-sheet .pack-pick-archive');
  await p.waitForFunction(() => /S01E03/.test(document.querySelector('.pack-ep[data-ep="3"] .name')?.textContent || ''), null, { timeout: 8000 }).catch(() => undefined);
  ok('a zip as the pack: its episodes listed', /S01E03/.test(await p.$eval('.pack-ep[data-ep="3"] .name', (e) => e.textContent)));
  await clear(); await play(3); ok('zip: episode 3 loaded', await cue(/ZIP EP3/)); await closePlayer();
  await play(4); ok('zip: episode 4 loaded', await cue(/ZIP EP4/)); await closePlayer();
  // Removed: nothing loaded.
  await packSheet(); await p.click('.pack-sheet .pack-remove'); await clear();
  await play(3); await p.waitForTimeout(2500); ok('the pack removed: nothing loaded from it', !/EP3/.test(await subsNow()));
  await subsSheet(); ok('…and the player\'s sheet offers to assign one', !!(await p.$('.sheet .kt-pack .pack-pick-folder')) && !(await p.$('.sheet .pack-this')));
  await closePlayer();
  // The TV page has the control too.
  await p.goto(`http://127.0.0.1:${port}/#/tv/series/tt1234567`); await p.waitForSelector('.subs-btn', { timeout: 10000 }).catch(() => undefined);
  ok('the TV title page has the Subtitles control', !!(await p.$('.subs-btn')));
  if (await p.$('.subs-btn')) { await p.click('.subs-btn'); await p.waitForSelector('.pack-sheet'); ok('…opening the pack sheet', !!(await p.$('.pack-sheet .pack-pick-folder'))); }
  ok(`${LANG}: the page laid out ${LANG === 'ar' ? 'right to left' : 'left to right'}`, (await p.evaluate(() => document.documentElement.dir || 'ltr')) === (LANG === 'ar' ? 'rtl' : 'ltr'));
  ok('no page errors', !errors.length, errors);
  await br.close(); web.close(); fs.rmSync(MEDIA, { recursive: true, force: true });
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + e.message); process.exit(1); });
