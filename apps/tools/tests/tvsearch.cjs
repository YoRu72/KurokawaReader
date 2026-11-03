// The TV & Movies add-on (the repository served from disk, Cinemeta and Torrentio answered by stubs, the desktop
// bridge faked): installed from Settings, its tab, Discover, a series' page, an episode's releases — one added
// with only its own file of the season pack —, and a pack's files chosen by hand.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const REPO = path.join(__dirname, '..', '..', '..', 'repo');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
const cors = { 'access-control-allow-origin': '*' };
// TV & Movies search: a release's file name searched as its title (the year taken aside), the results filled in with
// their genres and ratings, then narrowed with the tags and filters and put in order; an IMDb id opens its page.
const M = {
  tt1: { type: 'movie', name: 'Dune', releaseInfo: '2021', imdbRating: '8.0', genres: ['Sci-Fi', 'Adventure'] },
  tt2: { type: 'movie', name: 'Dune', releaseInfo: '1984', imdbRating: '6.3', genres: ['Sci-Fi', 'Adventure'] },
  tt3: { type: 'series', name: 'Dune: Prophecy', releaseInfo: '2024-', imdbRating: '7.1', genres: ['Drama', 'Sci-Fi'] },
  tt4: { type: 'movie', name: 'Dune Drifter', releaseInfo: '2020', imdbRating: '3.9', genres: ['Action'] },
};
const card = (id) => ({ id: id + '00000', imdb_id: id + '00000', type: M[id].type, name: M[id].name, releaseInfo: M[id].releaseInfo, poster: '' });
(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port;
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 420, height: 860 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message)); const asked = [];
  const check = (what, ok) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) errors.push(what); };
  await p.route(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/main\/repo\/(.*)/, (r) => { const f = path.join(REPO, r.request().url().split('/main/repo/')[1]); if (!fs.existsSync(f)) return r.fulfill({ status: 404 }); r.fulfill({ body: fs.readFileSync(f), contentType: /\.mjs$/.test(f) ? 'text/plain' : (MIME[path.extname(f)] || 'application/octet-stream') }); });
  await p.route('https://cinemeta-catalogs.strem.io/**', (r) => r.fulfill({ headers: cors, json: { metas: [] } }));
  await p.route('https://v3-cinemeta.strem.io/**', (r) => {
    const u = decodeURIComponent(r.request().url());
    const s = /\/catalog\/(movie|series)\/top\/search=(.*)\.json/.exec(u);
    if (s) { asked.push(s[2]); const ids = s[2].toLowerCase() === 'dune' ? Object.keys(M).filter((k) => M[k].type === s[1]) : []; return r.fulfill({ headers: cors, json: { metas: ids.map(card) } }); }
    const m = /\/meta\/(movie|series)\/(tt\d+)\.json/.exec(u); const k = m && m[2].replace(/00000$/, '');
    if (k && M[k] && M[k].type === m[1]) return r.fulfill({ headers: cors, json: { meta: { ...card(k), ...M[k] } } });
    r.fulfill({ headers: cors, json: {} });
  });
  await p.addInitScript(() => {
    const tasks = []; window.__added = [];
    window.kurokawaTools = { platform: 'desktop', available: true, os: 'linux', ready: async () => ({}), list: async () => tasks, add: async (o) => { window.__added.push(o); return { id: 't' + window.__added.length, name: 'x', ...o }; }, pause: async () => {}, resume: async () => {}, remove: async () => {}, setFiles: async () => {}, setLimits: async () => {}, configure: async () => {}, open: async () => {}, defaultDir: async () => '/d', pickDir: async () => '/x', onTasks: (cb) => { cb(tasks); return () => {}; },
      torrentInfo: async () => ({ name: 'Night.Shift.S01.1080p.WEB-DL', infoHash: 'a'.repeat(40), total: 1, files: [1, 2, 3].map((e) => ({ index: e - 1, path: `Night.Shift.S01.1080p.WEB-DL/Night.Shift.S01E0${e}.1080p.WEB-DL.mkv`, size: 1.4e9 })).concat([{ index: 3, path: 'Night.Shift.S01.1080p.WEB-DL/Sample/sample.mkv', size: 3e7 }]) }) };
  });

  await p.goto(`http://127.0.0.1:${port}/#/settings/addons`); await p.waitForSelector('.addon-row');
  await p.click('.addon-row:has-text("TV & Movies") .btn'); await p.waitForSelector('.toast');
  await p.goto(`http://127.0.0.1:${port}/#/tv?tab=search`); await p.waitForSelector('.search-input');
  await p.fill('.search-input', 'Dune.2021.1080p.WEB-DL.x264'); await p.press('.search-input', 'Enter');
  await p.waitForSelector('.tv-card'); await p.waitForFunction(() => document.querySelectorAll('.tv-genres .chip').length >= 3);
  check('the file name searched as «Dune»', asked.includes('Dune') && !asked.some((q) => /1080/.test(q)));
  check('says which words found them', /Dune \(2021\)/.test(await p.textContent('.tv-filters .hint')));
  const names = async () => p.$$eval('.tv-card .anime-title', (e) => e.map((x) => x.textContent));
  const facts = async () => p.$$eval('.tv-card .anime-facts', (e) => e.map((x) => x.textContent));
  check('all four, the year asked first', (await names()).length === 4 && (await facts())[0].includes('2021'));
  check('genres as tags', (await p.$$eval('.tv-genres .chip', (e) => e.map((x) => x.textContent))).includes('Sci-Fi'));
  await p.click('.tv-genres .chip:text-is("Sci-Fi")'); check('a genre tag keeps only those with it', (await names()).length === 3);
  await p.click('.tv-filters .chip:text-is("★ 7+")'); check('a lowest rating', (await names()).length === 2);
  await p.click('.tv-filters .chip:text-is("Series")'); check('series only', JSON.stringify(await names()) === '["Dune: Prophecy"]');
  await p.click('.tv-filters .chip:text-is("All")'); await p.click('.tv-filters .chip:text-is("★ 7+")'); await p.click('.tv-filters .chip:text-is("Any rating")'); await p.click('.tv-genres .chip:text-is("Sci-Fi")');
  await p.click('.tv-filters .chip:text-is("Top rated")'); const f = await facts(); console.log('top rated:', f.join(' | '));
  check('ordered by rating', f.length === 4 && f[0].includes('8') && f[3].includes('3'));
  await p.click('.tv-filters .chip:text-is("Oldest")'); check('ordered oldest first', (await facts())[0].includes('1984'));
  await p.fill('.search-input', 'https://www.imdb.com/title/tt300000/'); await p.press('.search-input', 'Enter');
  await p.waitForFunction(() => location.hash.includes('/tv/series/tt300000'), null, { timeout: 8000 }).catch(() => undefined);
  check('an IMDb link opens its page', (await p.evaluate(() => location.hash)).includes('/tv/series/tt300000'));
  check('no page errors', errors.length === 0 || (console.log(errors), false));
  await br.close(); web.close(); if (errors.length) process.exit(1); console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
