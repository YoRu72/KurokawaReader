// node tests/subauto.cjs [en|ar]: «Find subtitles automatically» on a stubbed phone (360×800), two made-up stand-in
// subtitle sources served by this test (nothing leaves 127.0.0.1):
//   off by default — no request at all; turned on in Settings → Subtitles (the one ordered language list there);
//   on — one search per episode opened, the best applied above the floor (a toast with «Change»), nothing below it
//   (the subtitles button counts what was found), the language order honoured (the second only when the first has
//   nothing confident), «Only my languages», the user's own choice never replaced, a source switched off not asked,
//   «Wi-Fi only» on a mobile connection, closed before it answered → nothing applied later.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const crypto = require('node:crypto'); const { execFileSync } = require('node:child_process');
const LANG = process.argv[2] === 'ar' ? 'ar' : 'en';
const DIST = path.join(__dirname, '..', 'dist'); const REPO = path.join(__dirname, '..', '..', '..', 'repo');
const MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-subauto-')); const SHOTS = process.env.KT_SHOTS || path.join(MEDIA, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 500))); if (!c) fails++; };
const T0 = Date.now();
fs.mkdirSync(path.join(MEDIA, 'Download')); fs.mkdirSync(path.join(MEDIA, 'served'));
try { execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '20', '-c:v', 'libvpx', '-b:v', '200k', '-c:a', 'libopus', path.join(MEDIA, 'Download', 'clip.webm')]); }
catch { console.log('ffmpeg not available — skipped'); process.exit(0); }
for (const e of [1, 2, 3, 4, 5, 6]) fs.copyFileSync(path.join(MEDIA, 'Download', 'clip.webm'), path.join(MEDIA, 'Download', `Kumo 0${e}.webm`));
const srt = (x) => `1\n00:00:00,000 --> 00:01:00,000\n${x}\n`;
for (const [n, x] of [['own.fr.srt', 'OWN FR'], ['own.ar.srt', 'OWN AR'], ['ar.srt', 'AUTO AR'], ['en.srt', 'AUTO EN'], ['fr.srt', 'AUTO FR'], ['b.srt', 'AUTO B']]) fs.writeFileSync(path.join(MEDIA, 'served', n), srt(x));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webm': 'video/webm' };
const web = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = p.startsWith('/media/') ? path.join(MEDIA, p.slice(7)) : path.join(DIST, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  const size = fs.statSync(f).size; const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || ''); const type = MIME[path.extname(f)] || 'application/octet-stream';
  if (range) { const a = Number(range[1]), b = range[2] ? Number(range[2]) : size - 1; res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${a}-${b}/${size}`, 'accept-ranges': 'bytes', 'content-length': b - a + 1, 'access-control-allow-origin': '*' }); fs.createReadStream(f, { start: a, end: b }).pipe(res); return; }
  res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size, 'access-control-allow-origin': '*' }); fs.createReadStream(f).pipe(res);
});
const SHOW = { id: 6161, idMal: 6162, title: { romaji: 'Kumo no Ue', english: 'Kumo', native: 'Kumo', userPreferred: 'Kumo' }, synonyms: [], coverImage: { large: '', extraLarge: '', color: '#5c6bc0' }, format: 'TV', status: 'FINISHED', episodes: 6, season: 'FALL', seasonYear: 2025, startDate: { year: 2025, month: 10, day: 1 }, genres: [], averageScore: 70, popularity: 1, isAdult: false, siteUrl: 'https://anilist.co/anime/6161', nextAiringEpisode: null, mediaListEntry: null, duration: 24, description: 'Made up.', studios: { nodes: [] }, airingSchedule: { nodes: [] }, streamingEpisodes: [], externalLinks: [], relations: { edges: [] } };
// Two stand-in sources; what they answer is set by the test (localStorage «test.mode»).
const mod = (who) => `export async function search(q) {
  const B = globalThis.__subBase; const m = localStorage.getItem('test.mode') || 'good'; const ep = q.animeEpisode ?? q.episode; (globalThis.__subQ ??= []).push({ who: '${who}', ep });
  if (m === 'slow') await new Promise((ok) => setTimeout(ok, 6000));
  const r = (title, language, file, e) => ({ title, language, site: 'Stand-in ${who}', url: B + '/media/served/' + file, episode: e, downloads: 5 });
  if ('${who}' === 'B') return m === 'onlyB' ? [r('Kumo - ' + String(ep).padStart(2, '0'), 'ar', 'b.srt', ep)] : [];
  if (m === 'weak') return [r('Kumo - 09', 'ar', 'ar.srt', 9), r('Kumo - 10', 'en', 'en.srt', 10)];
  if (m === 'order') return [r('Kumo - 09', 'ar', 'ar.srt', 9), r('Kumo - ' + String(ep).padStart(2, '0'), 'en', 'en.srt', ep)];
  if (m === 'fr') return [r('Kumo - ' + String(ep).padStart(2, '0'), 'fr', 'fr.srt', ep)];
  return [r('Kumo - ' + String(ep).padStart(2, '0'), 'en', 'en.srt', ep), r('Kumo - ' + String(ep).padStart(2, '0'), 'ar', 'ar.srt', ep)]; }`;
const MODS = { A: mod('A'), B: mod('B') };
(async () => {
  web.listen(0, '127.0.0.1'); await new Promise((r) => web.on('listening', r)); const port = web.address().port; const BASE = `http://127.0.0.1:${port}`;
  const ix = JSON.parse(fs.readFileSync(path.join(REPO, 'tools', 'index.json'), 'utf8'));
  ix.addons = ix.addons.filter((a) => a.kind !== 'subtitle-source'); ix.addons.find((a) => a.id === 'subtitles').children = ['subs-a', 'subs-b'];
  for (const w of ['A', 'B']) ix.addons.push({ id: `subs-${w.toLowerCase()}`, kind: 'subtitle-source', parent: 'subtitles', name: `Stand-in ${w}`, description: 'A test source.', version: '1.0.0', module: `subs/standin${w}.mjs`, sha256: crypto.createHash('sha256').update(MODS[w]).digest('hex'), size: Buffer.byteLength(MODS[w]), icon: 'subtitles' });
  const br = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const errors = [];
  const p = await br.newPage({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true }); p.on('pageerror', (e) => errors.push(e.message));
  let modLoads = 0;
  await p.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => {
    const u = r.request().url(); const m = /\/main\/repo\/(.*)$/.exec(u);
    if (m && m[1] === 'tools/index.json') return r.fulfill({ json: ix });
    const sm = m && /^tools\/subs\/standin([AB])\.mjs$/.exec(m[1]); if (sm) modLoads++; if (sm) return r.fulfill({ body: MODS[sm[1]], contentType: 'text/plain' });
    if (m) { const f = path.join(REPO, m[1]); return fs.existsSync(f) ? r.fulfill({ body: fs.readFileSync(f) }) : r.fulfill({ status: 404, body: '' }); }
    return r.fulfill({ status: 404, body: '' });
  });
  await p.exposeFunction('__http', (o) => {
    if (/graphql\.anilist\.co/.test(o.url)) { const q = JSON.parse(o.body || '{}').query || ''; return { status: 200, headers: {}, body: JSON.stringify({ data: /Media\(id/.test(q) ? { Media: SHOW } : { Page: { pageInfo: { hasNextPage: false }, media: [SHOW] } } }) }; }
    const sv = /^http:\/\/127\.0\.0\.1:\d+\/media\/(served\/[^?]*)/.exec(o.url);
    if (sv) { const f = path.join(MEDIA, decodeURIComponent(sv[1])); if (fs.existsSync(f)) { const b = fs.readFileSync(f); return { status: 200, headers: {}, body: o.binary ? b.toString('base64') : b.toString('utf8') }; } }
    return { status: 404, headers: {}, body: '' };
  });
  const task = (e) => ({ id: `k${e}`, kind: 'http', name: `Kumo 0${e}.webm`, source: { url: `https://x/${e}.webm` }, dir: '/sdcard/Download', state: 'done', done: 1, total: 1, downSpeed: 0, upSpeed: 0, files: [{ index: 0, path: `Kumo 0${e}.webm`, size: 1, done: 1, priority: 1 }], addedAt: Date.now() - 60e3, doneAt: Date.now(), engine: 'native', meta: { anilistId: 6161, episode: e, title: 'Kumo' } });
  await p.addInitScript(([port, lang, tasks]) => {
    if (!localStorage.getItem('kt.settings')) { localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['player', 'anime', 'subtitles'], playerWith: 'app', downloadDir: '/sdcard/Download', settingsLayout: 'list' })); localStorage.setItem('kt.player', JSON.stringify({ resume: 'never' })); localStorage.setItem('kt.update.lastCheck', String(Date.now())); }
    globalThis.__subBase = `http://127.0.0.1:${port}`;
    Object.defineProperty(navigator, 'connection', { configurable: true, get: () => ({ type: localStorage.getItem('test.net') || 'wifi', saveData: false }) });
    const api = { addListener: () => Promise.resolve({ remove() {} }), list: async () => ({ tasks }), localUrl: async (o) => ({ url: `http://127.0.0.1:${port}/media/${o.path.replace(/^\/sdcard\//, '')}` }), siblings: async () => ({ paths: [] }), filesList: async () => ({ exists: false, entries: [] }), httpRequest: async (o) => window.__http(o) };
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) }) }, PluginHeaders: [] };
  }, [port, LANG, [1, 2, 3, 4, 5, 6].map(task)]);
  const clear = () => p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim, .toast').forEach((e) => e.remove()));
  const cue = (re, ms = 12000) => p.waitForFunction((s) => new RegExp(s).test(document.querySelector('.kt-subs')?.textContent || ''), re.source, { timeout: ms }).then(() => true, () => false);
  const subsNow = () => p.evaluate(() => document.querySelector('.kt-subs')?.textContent || '');
  const searches = () => p.evaluate(() => (globalThis.__subQ ?? []).length);
  const mode = (m) => p.evaluate((m) => localStorage.setItem('test.mode', m), m);
  const page = async () => { await p.goto(`${BASE}/#/anime/6161`); await p.waitForSelector('.ep-row[data-ep="1"] button[data-icon="play"]', { timeout: 15000 }); };
  const play = async (e) => { await clear(); await p.click(`.ep-row[data-ep="${e}"] button[data-icon="play"]`); await p.waitForSelector('.kt-player video.kt-video'); };
  const closePlayer = async () => { await clear(); await p.click('.kt-top button[data-icon="back"]'); await p.waitForSelector('.kt-player', { state: 'detached' }); };
  const settings = async () => { await p.goto(`${BASE}/#/settings`); await p.waitForSelector('#sublangs h3', { timeout: 15000 }); if (!(await p.$('#sublangs .sub-auto-on:visible'))) await p.click('#sublangs h3'); await p.waitForSelector('.sub-settings .sub-auto-on', { timeout: 15000 }); await p.evaluate(() => document.querySelector('.sub-settings')?.scrollIntoView({ block: 'start' })); };
  const reload = async () => { await p.reload(); };
  const toastText = (ms = 9000) => p.waitForSelector('.toast.with-action', { timeout: ms }).then((e) => e.textContent(), () => '');

  // Off by default.
  await page(); await play(1); await p.waitForTimeout(7000);
  ok('off by default: no search request at all', (await searches()) === 0, { s: await searches(), modLoads });
  ok('…and the default list: the app\'s language, then English', JSON.stringify(await p.evaluate(() => JSON.parse(localStorage.getItem('kt.settings')).subLangs)) === JSON.stringify(LANG === 'ar' ? ['ar', 'en'] : ['en']), await p.evaluate(() => JSON.parse(localStorage.getItem('kt.settings')).subLangs));
  await closePlayer();
  // Settings → Subtitles: the one list, ordered (Arabic first), then auto-find on.
  await settings();
  if (LANG === 'en') { await p.click('.sub-settings .sub-lang-add'); await p.fill('.sheet .sub-lang-q', 'arab'); await p.click('.sheet .sub-lang-pick[data-lang="ar"]'); await p.waitForSelector('.sub-lang-row[data-lang="ar"]'); await p.click('.sub-lang-row[data-lang="ar"] .sub-lang-up'); }
  ok('the list ordered: Arabic first, then English — one value', JSON.stringify(await p.evaluate(() => JSON.parse(localStorage.getItem('kt.settings')).subLangs)) === '["ar","en"]');
  ok('the picker and the list show each language by its own name', /العربية/.test(await p.$eval('.sub-lang-row[data-lang="ar"]', (e) => e.textContent)));
  await p.click('.sub-settings .sub-auto-on'); await p.waitForSelector('.sub-settings .sub-auto-only'); await p.waitForSelector('.sub-settings .sub-auto-src', { timeout: 8000 });
  ok('on: «Only my languages», «Wi-Fi only» (a phone), and a switch per installed source by its own name', !!(await p.$('.sub-auto-only input:checked')) && !!(await p.$('.sub-auto-wifi input:checked')) && (await p.$$eval('.sub-auto-src', (e) => e.map((x) => x.textContent))).join('|') === 'Stand-in A|Stand-in B');
  if (LANG === 'en') { await p.waitForTimeout(300); await p.screenshot({ path: path.join(SHOTS, 'SB-auto-settings-en.png') }); }
  // On: one search per episode, the best applied.
  await reload(); await page(); await mode('good'); await p.evaluate(() => { globalThis.__subQ = []; });
  await play(2); ok('on: the best (this episode, Arabic first) applied', await cue(/AUTO AR/));
  const tt = await toastText(); ok('…said in a toast with «Change»', tt.length > 3, tt);
  if (LANG === 'ar') await p.screenshot({ path: path.join(SHOTS, 'SB-auto-toast-ar.png') });
  ok('…one search per source for the episode', JSON.stringify(await p.evaluate(() => globalThis.__subQ.map((x) => x.who + x.ep).sort())) === '["A2","B2"]', await p.evaluate(() => globalThis.__subQ));
  await p.click('.toast.with-action .toast-act'); await p.waitForSelector('.sheet .kt-auto .kt-auto-row', { timeout: 5000 }).catch(() => undefined);
  ok('«Change»: the candidates from every source, marked by source', (await p.$$eval('.sheet .kt-auto .kt-auto-row', (e) => e.map((x) => x.textContent))).every((x) => /Stand-in A/.test(x)) && (await p.$$('.sheet .kt-auto .kt-auto-row')).length === 2);
  ok('…the applied one remembered for the episode', await p.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('kt.subApplied') || '{}')).some((k) => /al:6161\|\|2$/.test(k))));
  await closePlayer();
  // Below the floor: nothing applied, the count on the button.
  await mode('weak'); await play(3); await p.waitForSelector('.kt-top .kt-dot', { timeout: 12000 }).catch(() => undefined);
  ok('nothing confident: nothing applied, the subtitles button counts what was found', !/AUTO/.test(await subsNow()) && /2/.test(await p.$eval('.kt-top .kt-dot', (e) => e.textContent).catch(() => '')));
  await closePlayer();
  // The order: English only because Arabic has nothing for this episode.
  await mode('order'); await play(4); ok('the second language only when the first has nothing confident', await cue(/AUTO EN/)); await closePlayer();
  // Only my languages.
  await mode('fr'); await play(5); await p.waitForTimeout(6000); ok('«Only my languages»: a French one never applied', !/AUTO FR/.test(await subsNow())); await closePlayer();
  await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('kt.settings')); s.subAutoOnly = false; localStorage.setItem('kt.settings', JSON.stringify(s)); }); await reload(); await page();
  await play(5); ok('…turned off: applied when nothing else fits', await cue(/AUTO FR/)); await closePlayer();
  await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('kt.settings')); s.subAutoOnly = true; localStorage.setItem('kt.settings', JSON.stringify(s)); }); await reload(); await page();
  // The user's own choice is never replaced.
  await mode('slow'); await play(6); await p.click('.kt-top button[data-icon="subtitles"]'); await p.waitForSelector('.sheet input[type="file"]', { state: 'attached' }); await p.setInputFiles('.sheet input[type="file"]', path.join(MEDIA, 'served', 'own.fr.srt')); await cue(/OWN FR/); await clear();
  await p.waitForTimeout(9000); ok('the user\'s own choice (a file loaded) never replaced', /OWN FR/.test(await subsNow()) && !/AUTO/.test(await subsNow())); await closePlayer();
  // Closed before it answered: nothing later.
  await p.evaluate(() => { localStorage.removeItem('kt.subApplied'); globalThis.__subQ = []; }); await play(2); await p.waitForFunction(() => (globalThis.__subQ ?? []).length > 0, null, { timeout: 15000 }).catch(() => undefined); await clear(); await p.evaluate(() => document.querySelector('.kt-top button[data-icon="back"]')?.click()); await p.waitForSelector('.kt-player', { state: 'detached' }); await p.waitForTimeout(8000);
  const late = { toast: await p.$eval('.toast.with-action', (e) => e.textContent).catch(() => ''), applied: await p.evaluate(() => localStorage.getItem('kt.subApplied')), q: await p.evaluate(() => (globalThis.__subQ ?? []).length) };
  ok('closed before the answer: nothing applied later, nothing remembered', !/AUTO|found|عُثر/.test(late.toast) && late.applied === null && late.q > 0, late);
  // A source switched off.
  await mode('onlyB'); await settings(); await p.click('.sub-auto-src:has-text("Stand-in B")'); await reload(); await page(); await p.evaluate(() => { globalThis.__subQ = []; });
  await play(3); await p.waitForTimeout(7000);
  ok('a source switched off is not asked', JSON.stringify(await p.evaluate(() => globalThis.__subQ.map((x) => x.who))) === '["A"]', await p.evaluate(() => globalThis.__subQ)); await closePlayer();
  // Wi-Fi only on a mobile connection.
  await p.evaluate(() => localStorage.setItem('test.net', 'cellular')); await reload(); await page(); await p.evaluate(() => { globalThis.__subQ = []; }); await mode('good');
  await play(2); await p.waitForTimeout(7000); ok('«Wi-Fi only» on mobile data: no search', (await searches()) === 0); await closePlayer();
  // The video has subtitles of its own: nothing searched by itself.
  await p.evaluate(() => localStorage.setItem('test.net', 'wifi')); await reload(); await page();
  const own = async (file) => { await clear(); await p.evaluate(() => { globalThis.__subQ = []; }); await p.evaluate(([b, f]) => window.dispatchEvent(new CustomEvent('kt:play', { detail: { url: `${b}/media/Download/Kumo 02.webm`, name: 'Kumo - 02.webm', subs: [`${b}/media/served/${f}`] } })), [BASE, file]); await p.waitForSelector('.kt-player video.kt-video'); };
  await own('own.fr.srt'); await cue(/OWN FR/); const offer = await p.waitForSelector('.kt-sub-offer', { timeout: 12000 }).then((e) => e.textContent(), () => '');
  ok('its own subtitle (French only): no search by itself', (await searches()) === 0);
  ok('…none in the user\'s languages: one quiet offer, «Don\'t ask for this show» beside it', offer.length > 3 && !!(await p.$('.kt-sub-offer .kt-offer-never')), offer);
  await p.click('.kt-top button[data-icon="subtitles"]'); await p.waitForSelector('.sheet .kt-auto-get'); await p.click('.sheet .kt-auto-get');
  await p.waitForSelector('.sheet .kt-auto .kt-auto-row', { timeout: 15000 }).catch(() => undefined);
  ok('«Get other subtitles» runs the search and lists what it found, applying nothing by itself', (await searches()) > 0 && (await p.$$('.sheet .kt-auto .kt-auto-row')).length >= 1 && /OWN FR/.test(await subsNow()));
  await clear(); await p.evaluate(() => document.querySelector('.kt-top button[data-icon="back"]')?.click()); await p.waitForSelector('.kt-player', { state: 'detached' });
  await own('own.fr.srt'); await p.waitForSelector('.kt-sub-offer .kt-offer-never', { timeout: 12000 }); await p.click('.kt-sub-offer .kt-offer-never'); await clear(); await p.evaluate(() => document.querySelector('.kt-top button[data-icon="back"]')?.click()); await p.waitForSelector('.kt-player', { state: 'detached' });
  await own('own.fr.srt'); await p.waitForTimeout(8000); ok('«Don\'t ask for this show» remembered', !(await p.$('.kt-sub-offer')) && (await searches()) === 0);
  await clear(); await p.evaluate(() => document.querySelector('.kt-top button[data-icon="back"]')?.click()); await p.waitForSelector('.kt-player', { state: 'detached' });
  await p.evaluate(() => localStorage.removeItem('kt.subAutoNoAsk'));
  await own('own.ar.srt'); await cue(/OWN AR/); await p.waitForTimeout(8000); ok('its own subtitle in the user\'s language: no offer, no search', !(await p.$('.kt-sub-offer')) && (await searches()) === 0);
  await clear(); await p.evaluate(() => document.querySelector('.kt-top button[data-icon="back"]')?.click());
  await br.close(); web.close();
  ok('no page errors', errors.length === 0, errors);
  fs.rmSync(MEDIA, { recursive: true, force: true });
  console.log(`${Math.round((Date.now() - T0) / 1000)} s`); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL', e && e.stack || e); process.exit(1); });
