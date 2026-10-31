// The Anime add-on in a browser: the repository served from disk, AniList answered by a stub — installing the
// add-on from Settings, the season chart, a show's page, the torrent picker running the bundled providers.
const { chromium } = require('playwright');
const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const REPO = path.join(__dirname, '..', '..', '..', 'repo');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'access-control-allow-origin': '*' }); fs.createReadStream(f).pipe(res); });
const MEDIA = (id, n) => ({ id, idMal: id, title: { romaji: `Sousou no Frieren ${n}`, english: `Frieren ${n}`, native: '葬送のフリーレン', userPreferred: `Frieren ${n}` }, synonyms: ['Frieren at the Funeral'], coverImage: { large: '', extraLarge: '', color: '#5c6bc0' }, format: 'TV', status: 'RELEASING', episodes: 28, season: 'FALL', seasonYear: 2026, startDate: { year: 2026, month: 10, day: 1 }, genres: ['Adventure', 'Fantasy'], averageScore: 90, popularity: 100000, isAdult: false, siteUrl: `https://anilist.co/anime/${id}`, nextAiringEpisode: { airingAt: Math.floor(Date.now() / 1000) + 90000, episode: 6 }, mediaListEntry: null, duration: 24, description: 'A synopsis.', studios: { nodes: [{ name: 'Madhouse' }] }, airingSchedule: { nodes: [1, 2, 3, 4, 5].map((e) => ({ airingAt: Math.floor(Date.now() / 1000) - (6 - e) * 604800, episode: e })) }, streamingEpisodes: [], externalLinks: [], relations: { edges: [] } });
(async () => {
  const web = serve(DIST).listen(0); const repo = serve(REPO).listen(0);
  const port = web.address().port, rport = repo.address().port;
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 420, height: 860 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.route(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/main\/repo\/(.*)/, (r) => { const rel = r.request().url().split('/main/repo/')[1]; const f = path.join(REPO, rel); if (!fs.existsSync(f)) return r.fulfill({ status: 404 }); r.fulfill({ body: fs.readFileSync(f), contentType: /\.mjs$/.test(f) ? 'text/plain' : (MIME[path.extname(f)] || 'application/octet-stream') }); });  // (GitHub serves .mjs as text/plain)
  await p.route('https://graphql.anilist.co/**', (r) => { const q = JSON.parse(r.request().postData() || '{}').query; const data = /Media\(id/.test(q) ? { Media: MEDIA(1, 1) } : /airingSchedules/.test(q) ? { Page: { pageInfo: { hasNextPage: false }, airingSchedules: [{ airingAt: Math.floor(Date.now() / 1000) + 3600, episode: 6, media: MEDIA(1, 1) }] } } : { Page: { pageInfo: { hasNextPage: false }, media: [MEDIA(1, 1), MEDIA(2, 2), MEDIA(3, 3)] } }; r.fulfill({ json: { data } }); });
  await p.route('https://arm.haglund.dev/**', (r) => r.fulfill({ json: { anidb: 17617, kitsu: 46474, imdb: 'tt22248376' } }));
  await p.route('https://nyaa.si/**', (r) => r.fulfill({ contentType: 'application/xml', body: `<rss><channel><item><title>[SubsPlease] Sousou no Frieren - 05 (1080p) [AAAA].mkv</title><nyaa:infoHash>0123456789abcdef0123456789abcdef01234567</nyaa:infoHash><nyaa:size>1.3 GiB</nyaa:size><nyaa:seeders>900</nyaa:seeders><nyaa:leechers>20</nyaa:leechers><pubDate>Fri, 31 Oct 2026 10:00:00 -0000</pubDate></item><item><title>[Judas] Sousou no Frieren (Season 1) [1080p] (Batch)</title><nyaa:infoHash>89abcdef0123456789abcdef0123456789abcdef</nyaa:infoHash><nyaa:size>20 GiB</nyaa:size><nyaa:seeders>300</nyaa:seeders><nyaa:leechers>5</nyaa:leechers><pubDate>Fri, 31 Oct 2026 10:00:00 -0000</pubDate></item><item><title>[X] Sousou no Frieren - 04 (720p).mkv</title><nyaa:infoHash>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</nyaa:infoHash><nyaa:size>500 MiB</nyaa:size><nyaa:seeders>10</nyaa:seeders><nyaa:leechers>1</nyaa:leechers><pubDate>Fri, 31 Oct 2026 10:00:00 -0000</pubDate></item></channel></rss>` }));
  await p.route('https://torrentio.strem.fun/**', (r) => r.fulfill({ json: { streams: [{ name: 'Torrentio\n1080p', title: 'Frieren 05 [Erai]\n👤 120 💾 1.1 GB ⚙️ NyaaSi', infoHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', sources: ['tracker:udp://x/announce'] }] } }));
  await p.route('https://releases.moe/**', (r) => r.fulfill({ json: { items: [{ expand: { trs: [{ infoHash: 'cccccccccccccccccccccccccccccccccccccccc', isBest: true, releaseGroup: 'Vodes', dualAudio: true, tracker: 'Nyaa', files: [{ length: 1000 }] }] } }] } }));
  await p.route('https://feed.animetosho.org/**', (r) => r.fulfill({ json: [{ title: 'Frieren 05 tosho', info_hash: 'dddddddddddddddddddddddddddddddddddddddd', total_size: 5, seeders: 3, leechers: 1, timestamp: 1 }] }));
  await p.goto(`http://127.0.0.1:${port}/#/settings/addons`); await p.waitForSelector('.addon-row');
  const rows = await p.$$eval('.addon-row b', (els) => els.map((e) => e.textContent)); console.log('add-ons:', rows.join(', '));
  const anime = (await p.$$('.addon-row')).find(async () => true); void anime;
  await p.click('.addon-row:has-text("Anime") .btn'); await p.waitForSelector('.toast');
  console.log('installed:', await p.evaluate(() => JSON.parse(localStorage.getItem('kt.settings')).addons.join(',')));
  await p.waitForSelector('[data-dest="anime"]'); await p.click('[data-dest="anime"]'); await p.waitForSelector('.anime-card');
  console.log('season cards:', await p.$$eval('.anime-card', (e) => e.length), await p.$eval('.season-head h2', (e) => e.textContent));
  await p.screenshot({ path: 'shot-anime-season.png' });
  await p.click('.chip:has-text("Schedule")'); await p.waitForSelector('.sched-row'); console.log('schedule:', await p.$eval('.sched-row .anime-title', (e) => e.textContent), await p.$eval('.sched-until', (e) => e.textContent));
  await p.click('.sched-row'); await p.waitForSelector('.ep-row'); console.log('episodes:', await p.$$eval('.ep-row', (e) => e.length), 'aired rows:', await p.$$eval('.ep-row:not(.future)', (e) => e.length));
  await p.screenshot({ path: 'shot-anime-entry.png' });
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('console:', m.text().slice(0, 300)); });
  await p.locator('.ep-row:not(.future)').nth(4).locator('button[aria-label="Find torrents"]').evaluate((b) => b.click()); await p.waitForSelector('.sheet'); await p.waitForTimeout(3000);
  console.log('sheet:', (await p.$eval('.sheet', (e) => e.innerText)).slice(0, 600));
  await p.waitForSelector('.torrent-list .result-row'); await p.waitForFunction(() => !document.querySelector('.provider-chips .busy'));
  console.log('chips:', await p.$$eval('.provider-chips .chip', (e) => e.map((x) => x.className + ' ' + x.title)).then((x) => x.join(' | ')));
  console.log('providers:', await p.$$eval('.provider-chips .chip', (e) => e.map((x) => x.textContent.trim())).then((x) => x.join(' | ')));
  console.log('results:', await p.$$eval('.torrent-list .result-row .result-title', (e) => e.map((x) => x.textContent)).then((x) => x.join(' | ')));
  await p.screenshot({ path: 'shot-anime-torrents.png' });
  await p.click('.switch-row.small input'); console.log('unfiltered:', await p.$$eval('.torrent-list .result-row', (e) => e.length));
  console.log(errors.length ? 'errors ' + JSON.stringify(errors) : 'all passed');
  await br.close(); web.close(); repo.close(); process.exit(errors.length ? 1 : 0);
})();
