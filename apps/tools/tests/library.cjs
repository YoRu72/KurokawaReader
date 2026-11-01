// The anime library: the download folder read (folders and files, the phone's side stubbed), the files grouped and
// matched on AniList (stubbed), «Continue watching» offering the next episode on the disk, the episodes on the disk
// counted and the missing ones; a group no title matches offered to match by hand.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const lang = process.argv[2] || 'en';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg' };
const web = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }).listen(0, async () => {
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 420, height: 860 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript((lang) => {
    localStorage.setItem('kr.lang', lang); window.__calls = [];
    const s = { addons: ['anime'] }; localStorage.setItem('kt.settings', JSON.stringify(s)); localStorage.setItem('kr.tools.settings', JSON.stringify(s));
    localStorage.setItem('kt.anilist.token', 'x'); localStorage.setItem('kt.anilist.user', JSON.stringify({ id: 1, name: 'me', scoreFormat: 'POINT_10' }));
    const MB = 1 << 20; const FS = {
      '/sdcard/Download': [{ name: '[SubsPlease] Frieren', dir: true }, { name: 'Unknown Thing - 01.mkv', size: 300 * MB }, { name: 'notes.txt', size: 10 }],
      '/sdcard/Download/[SubsPlease] Frieren': [1, 2, 3].map((n) => ({ name: `[SubsPlease] Sousou no Frieren - 0${n} (1080p) [ABCD].mkv`, size: 700 * MB })),
    };
    const MEDIA = { id: 154587, idMal: 52991, title: { romaji: 'Sousou no Frieren', english: "Frieren: Beyond Journey's End", native: '葬送のフリーレン', userPreferred: 'Sousou no Frieren' }, synonyms: [], coverImage: { large: '', extraLarge: '', color: null }, format: 'TV', status: 'FINISHED', episodes: 28, season: 'FALL', seasonYear: 2023, startDate: {}, genres: ['Adventure'], averageScore: 90, popularity: 1, isAdult: false, siteUrl: 'https://anilist.co/anime/154587', nextAiringEpisode: null, mediaListEntry: { id: 9, status: 'CURRENT', progress: 1, score: 0 }, relations: { edges: [] } };
    const plugin = new Proxy({ addListener: () => ({ remove() {} }), list: async () => ({ tasks: [] }), defaultDir: async () => ({ dir: '/sdcard/Download' }),
      listDir: async (o) => ({ entries: (FS[o.path] || []).map((e) => ({ name: e.name, path: `${o.path}/${e.name}`, dir: !!e.dir, size: e.size || 0, mtime: 1 })), exists: !!FS[o.path] }),
      httpRequest: async (o) => { if (/graphql\.anilist/.test(o.url)) { const q = JSON.parse(o.body).query; window.__calls.push(['al', q.slice(0, 40)]); const data = /search: \$q/.test(q) ? { Page: { media: /Frieren/i.test(JSON.parse(o.body).variables.q) ? [MEDIA] : [] } } : /id_in/.test(q) ? { Page: { media: [MEDIA] } } : { Page: { media: [] } }; return { status: 200, url: o.url, headers: {}, body: JSON.stringify({ data }) }; } return { status: 404, url: o.url, headers: {}, body: '' }; } },
      { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async (a) => { window.__calls.push([k, a]); return {}; }) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
  }, lang);
  await p.goto(`http://127.0.0.1:${web.address().port}/#/anime?tab=library`); await p.waitForSelector('.lib-head'); await p.waitForSelector('.cont-card, .empty', { timeout: 20000 }); await p.waitForTimeout(400);
  const text = (await p.$eval('.anime-body', (e) => e.innerText)).replace(/\s+/g, ' '); console.log('library:', text.slice(0, 400));
  await p.screenshot({ path: path.join(__dirname, `shot-library-${lang}.png`) });
  await p.click('.cont-card'); await p.waitForTimeout(800);
  const play = await p.evaluate(() => window.__calls.filter((c) => c[0] === 'localUrl').map((c) => c[1].path));
  console.log('played:', play.join(', '));
  const pass = /Frieren/.test(text) && /(Episode 2|الحلقة ٢|الحلقة 2)/.test(text) && /Unknown Thing/.test(text) && play.some((x) => /- 02 /.test(x));
  console.log(errors.length ? 'errors ' + JSON.stringify(errors) : pass ? 'all passed' : 'FAILED');
  await br.close(); web.close(); process.exit(errors.length || !pass ? 1 : 0);
});
