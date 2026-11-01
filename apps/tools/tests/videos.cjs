// The Videos tab (the Player add-on's library; the Android plugin faked): access asked, the phone's videos by
// folder with their counts, a folder's videos with how far each was watched, search; the recent ones; a Jellyfin
// server signed in to, its libraries browsed and a film played from it; a WebDAV folder listed.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port;
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 420, height: 860 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  const check = (what, ok) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) errors.push(what); };
  await p.addInitScript(() => {
    localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['player'], playerWith: 'app' }));
    localStorage.setItem('kt.player.memory', JSON.stringify({ '/sdcard/Movies/Film A.mkv': { pos: 600, duration: 1200, at: Date.now() - 1000 }, '/sdcard/DCIM/clip.mp4': { pos: 10, duration: 10, watched: true, at: Date.now() - 5000 } }));
    window.__calls = []; let granted = false;
    const V = (id, p, folder, d, size, mt) => ({ id, path: p, name: p.split('/').pop(), folder, duration: d, size, width: 1920, height: 1080, mtime: mt });
    const api = {
      addListener: () => ({ remove() {} }), list: async () => ({ tasks: [] }),
      mediaAccess: async (o) => { if (o.ask) { window.__calls.push('ask'); setTimeout(() => { granted = true; }, 300); } return { granted }; },
      mediaVideos: async () => ({ videos: [V(1, '/sdcard/Movies/Film A.mkv', 'Movies', 7200000, 2e9, 3), V(2, '/sdcard/Movies/Film B.mp4', 'Movies', 5400000, 1.5e9, 2), V(3, '/sdcard/DCIM/clip.mp4', 'Camera', 10000, 2e7, 5)] }),
      videoThumb: async () => { throw new Error('none'); }, localUrl: async (o) => ({ url: 'http://127.0.0.1:1/x' }),
      httpRequest: async (r) => {
        window.__calls.push([r.method || 'GET', r.url]);
        if (/AuthenticateByName/.test(r.url)) return { status: 200, headers: {}, body: JSON.stringify({ AccessToken: 'TOK', User: { Id: 'U1' } }) };
        if (/\/Users\/U1\/Views/.test(r.url)) return { status: 200, headers: {}, body: JSON.stringify({ Items: [{ Id: 'lib1', Name: 'Films', Type: 'CollectionFolder', IsFolder: true }] }) };
        if (/ParentId=lib1/.test(r.url)) return { status: 200, headers: {}, body: JSON.stringify({ Items: [{ Id: 'm1', Name: 'Big Film', Type: 'Movie', IsFolder: false, ProductionYear: 2024, RunTimeTicks: 72000000000, UserData: { PlayedPercentage: 40 } }] }) };
        if (r.method === 'PROPFIND') return { status: 207, headers: {}, body: '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response><d:response><d:href>/dav/Shows/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response><d:response><d:href>/dav/movie%20one.mkv</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>1000000</d:getcontentlength></d:prop></d:propstat></d:response><d:response><d:href>/dav/notes.txt</d:href><d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat></d:response></d:multistatus>' };
        return { status: 404, headers: {}, body: '' };
      },
      proxyUrl: async (o) => { window.__calls.push(['proxy', o.url, o.headers && o.headers.Authorization]); return { url: 'http://127.0.0.1:1/proxied' }; },
    };
    const plugin = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
  });
  await p.goto(`http://127.0.0.1:${port}/`); await p.waitForSelector('[data-dest="videos"]');
  check('a Videos tab with the Player add-on', true);
  await p.click('[data-dest="videos"]'); await p.waitForSelector('.videos-view');
  await p.locator('.videos-view .btn.primary', { hasText: 'Allow access' }).click();
  await p.waitForSelector('.video-folder', { timeout: 8000 }); check('access asked, then the folders', await p.evaluate(() => window.__calls.includes('ask')));
  const folders = await p.$$eval('.video-folder b', (e) => e.map((x) => x.textContent)); console.log('folders:', folders.join(' | '));
  check('folders newest first, with counts', folders.join() === 'Camera,Movies' && /Videos: 2/.test(await p.$eval('.video-folder >> nth=1', (e) => e.textContent)));
  await p.click('.video-folder >> nth=1'); await p.waitForSelector('.video-row');
  const rows = await p.$$eval('.video-row', (e) => e.map((x) => x.innerText.replace(/\s+/g, ' '))); console.log('rows:', rows.join(' | '));
  check('a folder\'s videos with length, quality and where they were left', rows.length === 2 && /1080p/.test(rows[0]) && /Left at 10:00/.test(rows[0]) && !!(await p.$('.video-row .video-prog')));
  await p.fill('.videos-tools input[type=search]', 'clip'); await p.waitForTimeout(100);
  check('search across folders', (await p.$$('.video-row')).length === 1);
  // Recent.
  await p.locator('.videos-view .chip', { hasText: 'Recent' }).click(); await p.waitForSelector('.videos-view .chip.on:has-text("Recent")'); await p.waitForSelector('.video-row');
  const rec = await p.$$eval('.video-row b', (e) => e.map((x) => x.textContent)); console.log('recent:', rec.join(' | '));
  check('recent: the last played first', rec[0] === 'Film A.mkv' && rec[1] === 'clip.mp4');
  // Jellyfin.
  await p.locator('.videos-view .chip', { hasText: 'Servers' }).click(); await p.locator('.videos-view .btn.primary', { hasText: 'Add a server' }).click();
  await p.fill('.sheet input[type=url]', 'http://jelly.local:8096/'); await p.fill('.sheet input[autocomplete=username]', 'me'); await p.fill('.sheet input[type=password]', 'pw');
  await p.locator('.sheet .btn.primary', { hasText: 'Connect' }).click(); await p.waitForSelector('.video-folder b:has-text("Films")', { timeout: 8000 });
  check('signed in to Jellyfin, its libraries listed', await p.evaluate(() => JSON.parse(localStorage.getItem('kt.settings')).mediaServers[0].token === 'TOK'));
  await p.click('.video-folder:has-text("Films")'); await p.waitForSelector('.video-row:has-text("Big Film")');
  const film = await p.$eval('.video-row', (e) => e.innerText.replace(/\s+/g, ' ')); console.log('film:', film);
  check('a film with its year and length, its progress', /2024/.test(film) && /2:00:00/.test(film) && !!(await p.$('.video-row .video-prog')));
  await p.click('.video-row:has-text("Big Film")'); await p.waitForSelector('.kt-player video', { timeout: 8000 });
  const src = await p.$eval('.kt-player video', (v) => v.getAttribute('src')); console.log('plays:', src);
  check('played straight from Jellyfin', src === 'http://jelly.local:8096/Videos/m1/stream?static=true&api_key=TOK');
  await p.evaluate(() => document.querySelector('.kt-player')?.dispatchEvent(new Event('kt-close')));
  // WebDAV.
  await p.evaluate(() => { location.hash = '#/videos?tab=servers'; }); await p.waitForTimeout(300);
  await p.locator('.videos-view .btn.primary', { hasText: 'Add a server' }).click();
  await p.locator('.sheet .row', { hasText: 'Kind' }).locator('.pick-btn').click(); await p.locator('.sheet .dest-row', { hasText: 'WebDAV' }).last().click();
  await p.fill('.sheet input[type=url]', 'https://nas.local/dav'); await p.fill('.sheet input[autocomplete=username]', 'u'); await p.fill('.sheet input[type=password]', 'p');
  await p.locator('.sheet .btn.primary', { hasText: 'Connect' }).click(); await p.waitForSelector('.video-row:has-text("movie one.mkv")', { timeout: 8000 });
  const dav = await p.$$eval('.videos-list > *', (e) => e.map((x) => x.innerText.replace(/\s+/g, ' '))); console.log('webdav:', dav.join(' | '));
  check('WebDAV: folders first, videos, nothing else', dav.length === 2 && /Shows/.test(dav[0]) && /movie one/.test(dav[1]));
  await p.click('.video-row:has-text("movie one.mkv")'); await p.waitForTimeout(800);
  const px = await p.evaluate(() => window.__calls.find((c) => c[0] === 'proxy')); console.log('proxy:', JSON.stringify(px));
  check('a WebDAV video played through the signed relay', !!px && px[1] === 'https://nas.local/dav/movie%20one.mkv' && /^Basic /.test(px[2]));
  check('no page errors', !errors.length);
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
