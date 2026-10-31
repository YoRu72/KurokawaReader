// Torrent search in a browser, every site faked: the Torrent search add-on installed, a name typed, covers from
// AniList and Cinemeta, releases from Nyaa / Knaben / TPB / YTS grouped under the works they match; a work
// picked asks again by its ids (Torrentio by IMDb, YTS by IMDb).
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const REPO = path.join(__dirname, '..', '..', '..', 'repo');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
const H = 'abcdef0123456789abcdef0123456789abcdef0';
const svg = (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="90"><rect width="60" height="90" fill="${c}"/></svg>`;
(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port; const lang = process.argv[2] || 'en';
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 420, height: 900 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  const calls = []; const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  await p.route(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/main\/repo\/(.*)/, (r) => { const f = path.join(REPO, r.request().url().split('/main/repo/')[1]); if (!fs.existsSync(f)) return r.fulfill({ status: 404 }); r.fulfill({ body: fs.readFileSync(f), contentType: /\.mjs$/.test(f) ? 'text/plain' : (MIME[path.extname(f)] || 'application/octet-stream') }); });
  await p.route('https://img.test/**', (r) => r.fulfill({ contentType: 'image/svg+xml', body: svg(r.request().url().includes('dune') ? '#c96' : '#69c') }));
  await p.route('https://graphql.anilist.co/**', (r) => { if (r.request().method() === 'OPTIONS') return r.fulfill({ headers: cors }); calls.push('anilist'); r.fulfill({ headers: cors, json: { data: { Page: { media: [] } } } }); });
  await p.route('https://v3-cinemeta.strem.io/**', (r) => { const u = r.request().url(); calls.push('cinemeta ' + u.split('/catalog/')[1]); r.fulfill({ headers: cors, json: u.includes('/movie/') ? { metas: [{ imdb_id: 'tt15239678', name: 'Dune: Part Two', releaseInfo: '2024', poster: 'https://img.test/dune2.jpg', type: 'movie' }, { imdb_id: 'tt1160419', name: 'Dune', releaseInfo: '2021', poster: 'https://img.test/dune1.jpg', type: 'movie' }] } : { metas: [{ imdb_id: 'tt10466872', name: 'Dune: Prophecy', releaseInfo: '2024–', poster: 'https://img.test/prophecy.jpg', type: 'series' }] } }); });
  await p.route('https://nyaa.si/**', (r) => r.fulfill({ headers: cors, contentType: 'application/rss+xml', body: `<rss><channel><item><title>[Erai-raws] Dune Something - 01 [1080p].mkv</title><link>https://nyaa.si/download/1.torrent</link><guid>https://nyaa.si/view/1</guid><pubDate>Tue, 01 Oct 2024 10:00:00 -0000</pubDate><nyaa:seeders>5</nyaa:seeders><nyaa:leechers>1</nyaa:leechers><nyaa:infoHash>${H}1</nyaa:infoHash><nyaa:size>1.2 GiB</nyaa:size></item></channel></rss>` }));
  await p.route('https://api.knaben.org/**', (r) => { if (r.request().method() === 'OPTIONS') return r.fulfill({ headers: cors }); calls.push('knaben ' + r.request().postData()?.slice(0, 60)); r.fulfill({ headers: cors, json: { hits: [
    { title: 'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX', bytes: 23e9, seeders: 1200, peers: 300, hash: H + '2', tracker: '1337x', date: '2024-05-14T00:00:00' },
    { title: 'Dune.Part.Two.2024.1080p.BluRay.x264-SPARKS', bytes: 12e9, seeders: 800, peers: 90, hash: H + '3', tracker: 'TPB', date: '2024-05-20' },
    { title: 'Dune 2021 1080p WEBRip x265', bytes: 2e9, seeders: 400, peers: 20, hash: H + '4', tracker: 'TPB' },
    { title: 'Dune.Prophecy.S01E03.720p.WEB.h264-ETHEL', bytes: 9e8, seeders: 150, peers: 10, hash: H + '5', tracker: 'EZTV' }] } }); });
  await p.route('https://apibay.org/**', (r) => r.fulfill({ headers: cors, json: [{ id: '9', name: 'Dune.Part.Two.2024.1080p.BluRay.x264-SPARKS', info_hash: (H + '3').toUpperCase(), leechers: '5', seeders: '700', size: '12000000000', added: '1716000000', imdb: 'tt15239678' }] }));
  await p.route('https://yts.mx/**', (r) => { calls.push('yts ' + r.request().url().split('?')[1]); r.fulfill({ headers: cors, json: { data: { movies: [{ title: 'Dune: Part Two', title_long: 'Dune: Part Two (2024)', imdb_code: 'tt15239678', url: 'https://yts.mx/m', torrents: [{ hash: (H + '6').toUpperCase(), quality: '1080p', type: 'web', size_bytes: 2.9e9, seeds: 900, peers: 40, date_uploaded: '2024-04-16 00:00:00' }] }] } } }); });
  await p.route('https://torrentio.strem.fun/**', (r) => { calls.push('torrentio ' + r.request().url().split('/stream/')[1]); r.fulfill({ headers: cors, json: { streams: [{ name: 'Torrentio\n4k', description: 'Dune.Part.Two.2024.REMUX.2160p\n👤 55 💾 70.1 GB ⚙️ RARBG', infoHash: H + '7' }] } }); });
  await p.route('https://eztvx.to/**', (r) => r.fulfill({ headers: cors, json: { torrents: [] } }));
  await p.route('https://arm.haglund.dev/**', (r) => r.fulfill({ headers: cors, json: {} }));
  await p.addInitScript((lang) => localStorage.setItem('kr.lang', lang), lang);
  await p.goto(`http://127.0.0.1:${port}/#/settings/addons`); await p.waitForSelector('.addon-row');
  await p.click('.addon-row[data-id="torrent-search"] .btn'); await p.waitForSelector('.toast');
  console.log('installed:', await p.evaluate(() => JSON.parse(localStorage.getItem('kt.settings')).addons.join(',')));
  await p.goto(`http://127.0.0.1:${port}/#/search`); await p.waitForSelector('.search-input');
  await p.fill('.search-input', 'dune'); await p.press('.search-input', 'Enter');
  await p.waitForSelector('.title-card img'); await p.waitForFunction(() => !document.querySelector('.provider-chips .busy'), null, { timeout: 15000 }); await p.waitForTimeout(1500);
  console.log('cards:', (await p.$$eval('.title-card b', (e) => e.map((x) => x.textContent))).join(' | '));
  console.log('chips:', (await p.$$eval('.provider-chips .chip', (e) => e.map((x) => x.textContent.trim() + (x.classList.contains('failed') ? '✗' + x.title : '')))).join(' | '));
  console.log('groups:\n  ' + (await p.$$eval('.release-group', (gs) => gs.map((g) => g.querySelector('.release-head b').textContent + ' {' + g.querySelector('.release-head small').textContent + '} cover:' + !!g.querySelector('img.release-cover') + ' → ' + [...g.querySelectorAll('.result-title')].map((x) => x.textContent).join(' ; ')))).join('\n  '));
  await p.screenshot({ path: path.join(__dirname, `shot-search-${lang}.png`), fullPage: true });
  await p.click('.title-card:has-text("Part Two")'); await p.waitForSelector('.picked-card'); await p.waitForFunction(() => !document.querySelector('.provider-chips .busy'), null, { timeout: 15000 }); await p.waitForTimeout(400);
  console.log('picked rows:', (await p.$$eval('.release-group .result-title', (e) => e.map((x) => x.textContent))).join(' ; '));
  console.log('calls:', calls.filter((c) => /torrentio|yts|knaben/.test(c)).join(' | '));
  await p.click('.release-group .result-row'); await p.waitForSelector('.toast');
  console.log('toast:', await p.$eval('.toast', (e) => e.textContent));
  console.log(errors.length ? 'errors ' + JSON.stringify(errors) : 'all passed');
  await br.close(); web.close(); process.exit(errors.length ? 1 : 0);
})();
