// The TV & Movies add-on (the repository served from disk, Cinemeta and Torrentio answered by stubs, the desktop
// bridge faked): installed from Settings, its tab, Discover, a series' page, an episode's releases — one added
// with only its own file of the season pack —, and a pack's files chosen by hand.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const REPO = path.join(__dirname, '..', '..', '..', 'repo');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
const cors = { 'access-control-allow-origin': '*' };
const SERIES = { id: 'tt1234567', imdb_id: 'tt1234567', type: 'series', name: 'Night Shift', poster: '', releaseInfo: '2020–', imdbRating: '8.1', genres: ['Drama'], description: 'A hospital at night.',
  videos: [1, 2, 3].map((e) => ({ id: `tt1234567:1:${e}`, season: 1, episode: e, name: `Hour ${e}`, ...(e === 1 ? { thumbnail: 'https://episodes.metahub.space/tt1234567/1/1/w780.jpg' } : {}), released: '2020-01-0' + e + 'T00:00:00.000Z' })).concat([{ id: 'tt1234567:2:1', season: 2, episode: 1, name: 'Dawn', released: '2021-01-01T00:00:00.000Z' }]) };
(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port;
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 420, height: 860 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  const check = (what, ok) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) errors.push(what); };
  await p.route(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/main\/repo\/(.*)/, (r) => { const f = path.join(REPO, r.request().url().split('/main/repo/')[1]); if (!fs.existsSync(f)) return r.fulfill({ status: 404 }); r.fulfill({ body: fs.readFileSync(f), contentType: /\.mjs$/.test(f) ? 'text/plain' : (MIME[path.extname(f)] || 'application/octet-stream') }); });
  // (TVmaze for the pictures Cinemeta lacks; every picture a small PNG.)
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAJCAYAAAA7KqwyAAAAEklEQVR42mP8z8DwnxEPYBxVSAoA0KkFE3ZgS1AAAAAASUVORK5CYII=', 'base64');
  await p.route(/episodes\.metahub\.space|static\.tvmaze\.com/, (r) => r.fulfill({ contentType: 'image/png', body: PNG }));
  await p.route('https://api.tvmaze.com/lookup/shows**', (r) => r.fulfill({ headers: cors, json: { id: 99 } }));
  await p.route('https://api.tvmaze.com/shows/99/episodes', (r) => r.fulfill({ headers: cors, json: [1, 2, 3].map((n) => ({ season: 1, number: n, name: `Hour ${n}`, image: { medium: `https://static.tvmaze.com/e${n}.jpg` } })) }));
  await p.route('https://cinemeta-catalogs.strem.io/**', (r) => r.fulfill({ headers: cors, json: { metas: [SERIES, { ...SERIES, id: 'tt7654321', imdb_id: 'tt7654321', name: 'Day Shift' }] } }));
  await p.route('https://v3-cinemeta.strem.io/**', (r) => r.fulfill({ headers: cors, json: { meta: SERIES } }));
  await p.route('https://torrentio.strem.fun/**', (r) => r.fulfill({ headers: cors, json: { streams: [
    { name: 'Torrentio\n1080p', title: 'Night.Shift.S01.1080p.WEB-DL\nNight.Shift.S01E02.1080p.WEB-DL.mkv\n👤 210 💾 1.4 GB ⚙️ EZTV', infoHash: 'a'.repeat(40), fileIdx: 1, behaviorHints: { filename: 'Night.Shift.S01E02.1080p.WEB-DL.mkv', videoSize: 1.4e9 } },
    { name: 'Torrentio\n720p', title: 'Night.Shift.S01E02.720p\n👤 40 💾 700 MB ⚙️ 1337x', infoHash: 'b'.repeat(40), behaviorHints: { videoSize: 7e8 } }] } }));
  await p.addInitScript(() => {
    const tasks = []; window.__added = [];
    window.kurokawaTools = { platform: 'desktop', available: true, os: 'linux', ready: async () => ({}), list: async () => tasks, add: async (o) => { window.__added.push(o); return { id: 't' + window.__added.length, name: 'x', ...o }; }, pause: async () => {}, resume: async () => {}, remove: async () => {}, setFiles: async () => {}, setLimits: async () => {}, configure: async () => {}, open: async () => {}, defaultDir: async () => '/d', pickDir: async () => '/x', onTasks: (cb) => { cb(tasks); return () => {}; },
      torrentInfo: async () => ({ name: 'Night.Shift.S01.1080p.WEB-DL', infoHash: 'a'.repeat(40), total: 1, files: [1, 2, 3].map((e) => ({ index: e - 1, path: `Night.Shift.S01.1080p.WEB-DL/Night.Shift.S01E0${e}.1080p.WEB-DL.mkv`, size: 1.4e9 })).concat([{ index: 3, path: 'Night.Shift.S01.1080p.WEB-DL/Sample/sample.mkv', size: 3e7 }]) }) };
  });
  await p.goto(`http://127.0.0.1:${port}/#/settings/addons`); await p.waitForSelector('.addon-row');
  await p.click('.addon-row:has-text("TV & Movies") .btn'); await p.waitForSelector('.toast');
  check('installed', await p.evaluate(() => JSON.parse(localStorage.getItem('kt.settings')).addons.includes('tv')));
  await p.waitForSelector('[data-dest="tv"]'); await p.click('[data-dest="tv"]'); await p.waitForSelector('.dc-poster'); await p.click('.chip:has-text("Browse")'); await p.waitForSelector('.tv-card');
  // (The Browse grid, once drawn: a slow machine is waited for, and what it showed is said if not two.)
  await p.waitForSelector('.tv-head .chip.on'); const nCards = await p.waitForFunction(() => document.querySelectorAll('.tv-card').length === 2, null, { timeout: 8000 }).then(() => 2).catch(() => p.$$eval('.tv-card', (e) => e.length));
  if (nCards !== 2) console.log('browse cards:', nCards, await p.$$eval('.tv-card', (e) => e.map((x) => x.textContent.slice(0, 30))));
  check('discover shows the catalogue', nCards === 2);
  await p.click('.tv-card >> nth=0'); await p.waitForSelector('.ep-row');
  check('series page with season 1 episodes', (await p.$$('.ep-row')).length === 3);
  await p.waitForFunction(() => document.querySelectorAll('.ep-row .ep-pic img').length === 3, null, { timeout: 4000 }).catch(() => undefined);
  const pics = await p.$$eval('.ep-row .ep-pic img', (e) => e.map((x) => x.getAttribute('src')));
  check('each episode with its picture: Cinemeta\'s, else TVmaze\'s', pics.length === 3 && /metahub/.test(pics[0]) && /tvmaze.com\/e2/.test(pics[1]));
  // An episode's releases: the first adds only its own file of the season pack.
  await p.click('.ep-row >> nth=1'); await p.waitForSelector('.ep-sheet .dest-row'); await p.locator('.ep-sheet .dest-row', { hasText: 'Choose a release' }).click();
  await p.waitForSelector('.torrent-list .result-row'); console.log('releases:', await p.$$eval('.torrent-list .result-title', (e) => e.map((x) => x.textContent).join(' | ')));
  await p.click('.torrent-list .result-row >> nth=0'); await p.waitForSelector('.pick-files .pick-row');
  check('a season pack: its files shown first, this episode ticked, the rest not', await p.$$eval('.pick-files .pick-row.on .pick-name', (e) => e.map((x) => x.textContent).join('|')).then((x) => /E02/.test(x) && !x.includes('|')));
  check('select all: one box, partly ticked', await p.$eval('.pick-master input', (e) => e.indeterminate && !e.checked));
  await p.click('.pick-files .btn.primary'); await p.waitForFunction(() => window.__added.length === 1);
  let a = await p.evaluate(() => window.__added[0]); console.log('added:', JSON.stringify({ files: a.files, meta: a.meta }));
  check('only the episode file of the pack', JSON.stringify(a.files) === '[1]' && a.meta.season === 1 && a.meta.episode === 2 && a.meta.imdbId === 'tt1234567');
  // The pack's files chosen by hand: this episode ticked, the sample not.
  await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove()));
  await p.click('.ep-row >> nth=1'); await p.waitForSelector('.ep-sheet .dest-row'); await p.locator('.ep-sheet .dest-row', { hasText: 'Choose a release' }).click();
  await p.waitForSelector('.torrent-list .result-files'); await p.click('.torrent-list .result-files >> nth=0'); await p.waitForSelector('.pick-files .pick-row');
  const ticked = await p.$$eval('.pick-files .pick-row', (r) => r.filter((x) => x.querySelector('input').checked).map((x) => x.querySelector('.pick-name').textContent));
  console.log('ticked:', ticked.join(' | ')); check('this episode ticked in the picker', ticked.length === 1 && /S01E02/.test(ticked[0]));
  await p.locator('.pick-files .pick-tools .chip', { hasText: 'Episodes only' }).click(); await p.click('.pick-files .btn.primary'); await p.waitForFunction(() => window.__added.length === 2);
  a = await p.evaluate(() => window.__added[1]); console.log('added:', JSON.stringify(a.files));
  check('episodes only: the three, no sample', JSON.stringify(a.files) === '[0,1,2]');
  // Held (a right click here): the episode's options.
  await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove()));
  await p.dispatchEvent('.ep-row >> nth=2', 'contextmenu'); await p.waitForSelector('.ep-menu .dest-row');
  const opts = await p.$$eval('.ep-menu .dest-row', (r) => r.map((x) => x.innerText.trim())); console.log('held:', opts.join(' | '));
  check('holding an episode opens its options', opts.some((x) => /Watch now/.test(x)) && opts.some((x) => /Mark watched up to episode 3/.test(x)));
  await p.locator('.ep-menu .dest-row', { hasText: 'Mark watched up to' }).click(); await p.waitForTimeout(300);
  check('marked watched up to it', (await p.$$('.ep-row.seen')).length === 3);
  // Schedule: the week's episodes from TVmaze, day by day; a show on your list first and under «Yours».
  {
    // (The three episodes must air TODAY by the UTC date the schedule is asked for: late in the UTC day «in 2–4 hours»
    //  is tomorrow, and the check then failed by the clock. The step shrinks so that all three stay inside today.)
    const left = new Date().setUTCHours(24, 0, 0, 0) - Date.now();
    const step = Math.min(3600e3, Math.max(1000, (left - 60e3) / 5));
    const inH = (h) => new Date(Date.now() + h * step).toISOString();
    const show = (id, name, imdb) => ({ id, name, image: { medium: 'https://static.tvmaze.com/s.jpg' }, externals: { imdb }, webChannel: { name: 'Netflix' } });
    let asked = 0;
    await p.route('https://api.tvmaze.com/schedule**', (r) => { asked++; const today = r.request().url().includes(new Date().toISOString().slice(0, 10)) && r.request().url().includes('/web');
      r.fulfill({ headers: cors, json: today ? [
        { id: 1, season: 2, number: 5, name: 'Other One', airstamp: inH(2), _embedded: { show: show(1, 'Some Other Show', 'tt0000001') } },
        { id: 2, season: 1, number: 4, name: 'Hour 4', airstamp: inH(3), _embedded: { show: show(2, 'Night Shift', 'tt1234567') } },
        { id: 3, season: 1, number: 1, name: 'No IMDb', airstamp: inH(4), _embedded: { show: { id: 3, name: 'Unknown', externals: {} } } }] : [] }); });
    await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove()));
    await p.evaluate(() => { location.hash = '#/tv'; }); await p.waitForSelector('.chip:has-text("Schedule")'); await p.click('.chip:has-text("Schedule")');
    await p.waitForSelector('.tv-sched .sched-row', { timeout: 8000 });
    const names = await p.$$eval('.tv-sched .sched-row .anime-title', (e) => e.map((x) => x.textContent));
    check('schedule: TVmaze asked, at most four at a time, a week of days', asked === 14);
    check('schedule: shows with an IMDb id only, yours first', names.length === 2 && /Night Shift/.test(names[0]), names);
    await p.click('.tv-sched-head .chip:nth-child(2)'); await p.waitForTimeout(200);
    check('schedule: «Yours» keeps only yours', (await p.$$('.tv-sched .sched-row')).length === 1);
    await p.click('.tv-sched .sched-row'); await p.waitForTimeout(300);
    check('schedule: a row opens its show at its season', /#\/tv\/series\/tt1234567\?s=1/.test(await p.evaluate(() => location.hash)));
  }
  check('no page errors', !errors.filter((e) => e !== 'no page errors').length);
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
