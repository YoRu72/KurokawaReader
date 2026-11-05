// The Discover pages (Anime and TV) and a studio's page: AniList and Cinemeta answered by stubs, pictures by a
// generated one. Checks the hero, the rails, the badges, the tiles, the studio search and a studio's works.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const SHOTS = process.env.SHOTS;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
const pic = (seed) => `https://img.example/${seed}.svg`;
const now = Math.floor(Date.now() / 1000);
const media = (i, extra = {}) => ({ id: 100 + i, idMal: null, title: { romaji: `Show ${i}`, english: `Show number ${i}`, native: null, userPreferred: `Show number ${i}` }, synonyms: [], coverImage: { large: pic(`c${i}`), extraLarge: pic(`c${i}`), color: '#446688' }, bannerImage: pic(`b${i}`), format: i % 5 ? 'TV' : 'MOVIE', status: 'RELEASING', episodes: 12, season: 'FALL', seasonYear: 2026, startDate: { year: 2026 - (i % 3) }, genres: ['Action', 'Drama'], averageScore: 60 + (i % 35), popularity: 1000, isAdult: false, siteUrl: `https://anilist.co/anime/${100 + i}`, nextAiringEpisode: { airingAt: now + 5 * 86400 + i * 3600, episode: (i % 4) + 1 }, mediaListEntry: null, description: 'A long description of the show that goes on.', duration: 24, studios: { nodes: [{ id: 7, name: 'Studio Seven' }] }, prequels: { edges: i % 2 ? [{ relationType: 'PREQUEL' }] : [] }, ...extra });
const studio = (i) => ({ id: i + 1, name: ['MAPPA', 'ufotable', 'Kyoto Animation', 'Madhouse', 'Bones'][i % 5] + (i > 4 ? ` ${i}` : ''), isAnimationStudio: true, favourites: 5000, media: { nodes: [{ bannerImage: pic(`s${i}`), coverImage: { extraLarge: pic(`s${i}`), color: '#884422' } }] } });
(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port;
  const br = await chromium.launch(); const errors = []; const check = (what, ok) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) errors.push(what); };
  for (const [vw, vh, tag] of [[420, 900, 'phone'], [1440, 900, 'pc']]) {
    const p = await br.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: SHOTS ? 2 : 1 });
    p.on('pageerror', (e) => errors.push(e.message));
    await p.route('https://img.example/**', (r) => { const s = r.request().url().split('/').pop(); const h = [...s].reduce((a, c) => a + c.charCodeAt(0) * 37, 0) % 360; r.fulfill({ headers: cors, contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h},60%,55%)"/><stop offset="1" stop-color="hsl(${(h + 70) % 360},55%,25%)"/></linearGradient></defs><rect width="600" height="400" fill="url(#g)"/><circle cx="420" cy="140" r="90" fill="rgba(255,255,255,.18)"/></svg>` }); });
    await p.route('https://graphql.anilist.co/**', (r) => {
      if (r.request().method() === 'OPTIONS') return r.fulfill({ headers: cors, body: '' });
      const q = JSON.parse(r.request().postData() || '{}').query || '';
      let data;
      if (q.includes('trending:')) data = { trending: { media: Array.from({ length: 12 }, (_, i) => media(i)) }, airing: { media: Array.from({ length: 10 }, (_, i) => media(i + 20)) }, season: { media: Array.from({ length: 10 }, (_, i) => media(i + 40)) }, top: { media: Array.from({ length: 10 }, (_, i) => media(i + 60)) }, movies: { media: Array.from({ length: 8 }, (_, i) => media(i + 80, { format: 'MOVIE' })) } };
      else if (q.includes('Studio(search:')) { data = {}; for (let i = 0; i < 20; i++) data[`s${i}`] = studio(i); }
      else if (q.includes('studios(search:')) data = { Page: { studios: [studio(0), studio(1)] } };
      else if (q.includes('works:')) data = { Studio: { ...studio(0), works: { pageInfo: { hasNextPage: false, total: 42 }, nodes: Array.from({ length: 9 }, (_, i) => media(i + 90)) } } };
      else if (/: Page\(perPage: 1\)/.test(q)) { data = {}; for (const m of q.matchAll(/(a[A-Za-z0-9_]+): Page/g)) data[m[1]] = { media: [{ bannerImage: pic(m[1]), coverImage: { extraLarge: pic(m[1]), color: '#335577' } }] }; }
      else data = { Page: { pageInfo: { hasNextPage: false }, media: Array.from({ length: 6 }, (_, i) => media(i)) } };
      r.fulfill({ headers: cors, json: { data } });
    });
    const TV = (i, type) => ({ id: `tt10000${i}`, imdb_id: `tt10000${i}`, type, name: `${type === 'movie' ? 'Film' : 'Series'} ${i}`, poster: pic(`p${type}${i}`), background: pic(`bg${type}${i}`), releaseInfo: '2024', imdbRating: '8.1', genres: ['Drama', 'Crime'], description: 'Something happens.', runtime: '50 min' });
    await p.route('https://cinemeta-catalogs.strem.io/**', (r) => { const type = r.request().url().includes('/movie/') ? 'movie' : 'series'; r.fulfill({ headers: cors, json: { metas: Array.from({ length: 12 }, (_, i) => TV(i, type)) } }); });
    await p.route('https://v3-cinemeta.strem.io/**', (r) => r.fulfill({ headers: cors, json: { meta: TV(1, 'series') } }));
    await p.addInitScript((lang) => { if (!localStorage.getItem('kt.settings')) localStorage.setItem('kt.settings', JSON.stringify({ addons: ['anime', 'tv'], lang })); localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.anime.tab', 'discover'); localStorage.setItem('kt.tv.tab', 'discover');
      localStorage.setItem('kt.player.memory', JSON.stringify({ '/x/ep5.mkv': { pos: 300, duration: 1440, at: Date.now(), anilistId: 101, episode: 5, show: 'Show number 1', cover: 'https://img.example/b1.svg' } })); }, process.env.LANG_UI || 'en');
    await p.goto(`http://127.0.0.1:${port}/#/anime?tab=discover`);
    await p.waitForSelector('.dc-hero-slide', { timeout: 15000 }); await p.waitForSelector('.dc-tile-img'); await p.waitForTimeout(600);
    check(`${tag}: hero slides`, (await p.$$('.dc-hero-slide')).length === 8);
    check(`${tag}: trending ranked`, (await p.textContent('.dc-rail:nth-of-type(3) .dc-badge')) !== null);
    check(`${tag}: airing badges`, (await p.$$('.dc-badge.k-new, .dc-badge.k-live')).length > 0);
    check(`${tag}: studios tiles`, (await p.$$('.dc-tile.square')).length >= 5);
    check(`${tag}: genre/season/decade tiles`, (await p.$$('.dc-tile:not(.square)')).length >= 18 + 4 + 7);
    if (SHOTS) { await p.screenshot({ path: `${SHOTS}/anime-${tag}-top${process.env.LANG_UI || ''}.png` }); await p.evaluate(() => document.querySelector('.anime-body').scrollBy(0, 1300)); await p.waitForTimeout(400); await p.screenshot({ path: `${SHOTS}/anime-${tag}-mid${process.env.LANG_UI || ''}.png` }); }
    // a studio's page
    await p.click('.dc-tile.square >> nth=0'); await p.waitForSelector('.studio-head h2'); await p.waitForSelector('.studio-view .anime-card');
    check(`${tag}: studio page`, (await p.textContent('.studio-head h2')) === 'MAPPA' && (await p.$$('.studio-view .anime-card')).length === 9);
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/studio-${tag}.png` });
    // studio search in the search tab
    await p.goto(`http://127.0.0.1:${port}/#/anime?tab=search&q=mappa`); await p.waitForSelector('.studio-box .dc-tile', { timeout: 10000 });
    check(`${tag}: studios found by search`, (await p.$$('.studio-box .dc-tile')).length === 2);
    // TV
    await p.goto(`http://127.0.0.1:${port}/#/tv?tab=discover`); await p.waitForSelector('.dc-hero-slide'); await p.waitForSelector('.dc-poster'); await p.waitForTimeout(800);
    check(`${tag}: tv rails`, (await p.$$('.dc-rail:not([hidden])')).length >= 7);
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/tv-${tag}.png` });
    await p.click('.dc-tile >> nth=0'); await p.waitForSelector('.tv-card');
    check(`${tag}: genre tile opens Browse`, (await p.$$('.tv-card')).length > 0 && await p.evaluate(() => location.hash.includes('browse')));
    await p.close();
  }
  console.log(errors.length ? 'errors ' + JSON.stringify(errors) : 'all passed'); await br.close(); web.close(); process.exit(errors.length ? 1 : 0);
})();
