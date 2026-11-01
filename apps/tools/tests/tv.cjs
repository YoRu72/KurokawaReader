// The TV & Movies add-on (the repository served from disk, Cinemeta and Torrentio answered by stubs, the desktop
// bridge faked): installed from Settings, its tab, Discover, a series' page, an episode's releases — one added
// with only its own file of the season pack —, and a pack's files chosen by hand.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const REPO = path.join(__dirname, '..', '..', '..', 'repo');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
const cors = { 'access-control-allow-origin': '*' };
const SERIES = { id: 'tt1234567', imdb_id: 'tt1234567', type: 'series', name: 'Night Shift', poster: '', releaseInfo: '2020–', imdbRating: '8.1', genres: ['Drama'], description: 'A hospital at night.',
  videos: [1, 2, 3].map((e) => ({ id: `tt1234567:1:${e}`, season: 1, episode: e, name: `Hour ${e}`, released: '2020-01-0' + e + 'T00:00:00.000Z' })).concat([{ id: 'tt1234567:2:1', season: 2, episode: 1, name: 'Dawn', released: '2021-01-01T00:00:00.000Z' }]) };
(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port;
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 420, height: 860 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  const check = (what, ok) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) errors.push(what); };
  await p.route(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/main\/repo\/(.*)/, (r) => { const f = path.join(REPO, r.request().url().split('/main/repo/')[1]); if (!fs.existsSync(f)) return r.fulfill({ status: 404 }); r.fulfill({ body: fs.readFileSync(f), contentType: /\.mjs$/.test(f) ? 'text/plain' : (MIME[path.extname(f)] || 'application/octet-stream') }); });
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
  await p.waitForSelector('[data-dest="tv"]'); await p.click('[data-dest="tv"]'); await p.waitForSelector('.tv-card');
  check('discover shows the catalogue', (await p.$$('.tv-card')).length === 2);
  await p.click('.tv-card >> nth=0'); await p.waitForSelector('.ep-row');
  check('series page with season 1 episodes', (await p.$$('.ep-row')).length === 3);
  // An episode's releases: the first adds only its own file of the season pack.
  await p.click('.ep-row >> nth=1'); await p.waitForSelector('.ep-sheet .dest-row'); await p.locator('.ep-sheet .dest-row', { hasText: 'Choose a release' }).click();
  await p.waitForSelector('.torrent-list .result-row'); console.log('releases:', await p.$$eval('.torrent-list .result-title', (e) => e.map((x) => x.textContent).join(' | ')));
  await p.click('.torrent-list .result-row >> nth=0'); await p.waitForFunction(() => window.__added.length === 1);
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
  check('no page errors', !errors.filter((e) => e !== 'no page errors').length);
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
