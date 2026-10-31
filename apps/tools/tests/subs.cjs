// The Subtitles add-on in a browser: installed from Settings, a title resolved from AniList + Cinemeta (stubbed),
// the sites answered by stubs, results ranked by language; a tap adds a download.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const REPO = path.join(__dirname, '..', '..', '..', 'repo');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port;
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 420, height: 860 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.route(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/main\/repo\/(.*)/, (r) => { const f = path.join(REPO, r.request().url().split('/main/repo/')[1]); if (!fs.existsSync(f)) return r.fulfill({ status: 404 }); r.fulfill({ body: fs.readFileSync(f), contentType: /\.mjs$/.test(f) ? 'text/plain' : (MIME[path.extname(f)] || 'application/octet-stream') }); });  // (GitHub serves .mjs as text/plain)
  await p.route('https://graphql.anilist.co/**', (r) => r.fulfill({ json: { data: { Page: { media: [{ id: 21, idMal: 21, title: { romaji: 'One Piece', english: 'One Piece', native: 'ワンピース', userPreferred: 'One Piece' }, synonyms: [], coverImage: {}, format: 'TV', status: 'RELEASING', episodes: null, seasonYear: 1999, startDate: { year: 1999 }, genres: [], isAdult: false, siteUrl: '' }] } } } }));
  await p.route('https://v3-cinemeta.strem.io/**', (r) => { const u = r.request().url(); r.fulfill({ json: u.includes('/movie/') ? { metas: [{ imdb_id: 'tt0111161', name: 'The Shawshank Redemption', releaseInfo: '1994', type: 'movie' }] } : u.includes('/catalog/series') ? { metas: [{ imdb_id: 'tt0388629', name: 'One Piece', releaseInfo: '1999-', type: 'series' }] } : { meta: { videos: [{ season: 1 }, { season: 21 }] } } }); });
  await p.route('https://arm.haglund.dev/**', (r) => r.fulfill({ json: { anidb: 69, kitsu: 12, imdb: 'tt0388629', thetvdb: 81797 } }));
  await p.route('https://api.gestdown.info/**', (r) => { const u = r.request().url(); r.fulfill({ json: u.includes('/external/') ? { shows: [{ id: 'abc', name: 'One Piece' }] } : { episodes: [{ number: 5, subtitles: [{ subtitleId: 's1', version: 'HDTV', downloadUri: '/subtitles/download/s1', completed: true, hearingImpaired: false }] }] } }); });
  await p.route('https://www.podnapisi.net/**', (r) => r.fulfill({ json: { data: [{ id: 'p1', language: 'ar', flags: [], url: 'https://www.podnapisi.net/x', releases: ['One.Piece.E05.ARABIC'], custom_releases: [], movie: { title: 'One Piece', type: 'tv-series', year: 1999, episode_info: { season: 1, episode: 5 } } }] } }));
  await p.route('https://feed.animetosho.org/**', (r) => { const u = r.request().url(); r.fulfill({ json: u.includes('show=torrent') ? { files: [{ filename: 'OP 05.mkv', attachments: [{ id: 255, type: 'subtitle', info: { lang: 'eng', name: 'English' } }, { id: 256, type: 'font', info: {} }] }] } : [{ id: 7, title: '[Group] One Piece - 05' }] }); });
  await p.route('https://subf2m.co/**', (r) => r.fulfill({ status: 403, body: 'cf' }));
  await p.route(/^https:\/\/([a-z.]*\.)?(yifysubtitles\.ch|jimaku\.cc|subdl\.com|opensubtitles\.com|subsource\.net)\//, (r) => r.fulfill({ status: 404, body: '' }));
  await p.addInitScript(() => { if (!localStorage.getItem('kt.settings')) localStorage.setItem('kt.settings', JSON.stringify({ subLangs: ['ar', 'en'] })); });
  await p.goto(`http://127.0.0.1:${port}/#/settings/addons`); await p.waitForSelector('.addon-row');
  await p.click('.addon-row:has-text("Subtitles") .btn'); await p.waitForSelector('.toast'); console.log('toast:', await p.$eval('.toast', (e) => e.textContent), 'addons:', await p.evaluate(() => (JSON.parse(localStorage.getItem('kt.settings')).addons || []).join(','))); await p.reload(); await p.waitForSelector('[data-dest="subs"]');
  await p.click('[data-dest="subs"]'); await p.fill('.search-input', 'One Piece'); await p.press('.search-input', 'Enter'); await p.waitForSelector('.title-card');
  console.log('cards:', await p.$$eval('.title-card b', (e) => e.map((x) => x.textContent)).then((x) => x.join(' | ')), '| kinds:', await p.$$eval('.title-card small', (e) => e.map((x) => x.textContent)).then((x) => x.join(' | ')));
  await p.click('.title-card'); await p.waitForSelector('.picked-card');
  console.log('picked:', await p.$eval('.picked-card small', (e) => e.textContent));
  await p.fill('.num-field input', '5'); await p.press('.num-field input', 'Tab');
  await p.waitForSelector('.sub-list .sub-row'); await p.waitForFunction(() => !document.querySelector('.provider-chips .busy'));
  console.log('chips:', await p.$$eval('.provider-chips .chip', (e) => e.map((x) => x.textContent.trim() + (x.classList.contains('failed') ? '✗' : ''))).then((x) => x.join(' | ')));
  console.log('rows:', await p.$$eval('.sub-row', (e) => e.map((x) => x.querySelector('.lang-badge').textContent + ' ' + x.querySelector('.result-title').textContent + ' · ' + x.querySelector('small').textContent)).then((x) => x.join('\n      ')));
  await p.screenshot({ path: 'shot-subs.png' });
  await p.fill('.search-input', 'https://anilist.co/anime/21/One-Piece/'); await p.waitForTimeout(800); console.log('pasted link → picked:', !!(await p.$('.picked-card')));
  console.log(errors.length ? 'errors ' + JSON.stringify(errors) : 'all passed');
  await br.close(); web.close(); process.exit(errors.length ? 1 : 0);
})();
