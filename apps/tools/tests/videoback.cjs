// The owner's phone recording, replayed (the Android plugin and its App bridge faked): Videos → «On this phone» →
// the folder «Kurokawa» → Android's Back goes up to the folders (it used to jump to the downloads); «Screenshots»
// → Back → the folders again; Back once more, at the tab's top → the downloads; Videos again shows the folders, not a
// folder left open. The arrow beside a folder's name does the same as Back. Each row's picture comes from the faked
// plugin (made-up fixture images) and keeps its length badge.
// Run: NODE_PATH=$(npm root -g) node tests/videoback.cjs
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
(async () => {
  const web = serve().listen(0); const port = web.address().port; const br = await chromium.launch();
  const ctx = await br.newContext({ viewport: { width: 412, height: 900 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 404 }));
  const p = await ctx.newPage(); const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(() => {
    localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['player', 'files'], playerWith: 'app' }));
    window.__min = 0; window.__thumbCalls = 0;
    // (A made-up picture per video: a gradient drawn here, as a JPEG data: URL — what the plugin hands back.)
    const pic = (id) => { const c = document.createElement('canvas'); c.width = 320; c.height = 180; const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 0, 320, 180); gr.addColorStop(0, `hsl(${(id * 47) % 360} 45% 32%)`); gr.addColorStop(1, `hsl(${(id * 47 + 80) % 360} 50% 18%)`); g.fillStyle = gr; g.fillRect(0, 0, 320, 180); g.fillStyle = 'rgba(255,255,255,.75)'; g.beginPath(); g.moveTo(140, 65); g.lineTo(190, 90); g.lineTo(140, 115); g.fill(); return c.toDataURL('image/jpeg', 0.8); };
    const V = (id, folder, name, d) => ({ id, path: `/storage/emulated/0/${folder}/${name}`, name, folder, duration: d, size: 3e7 + id * 1e6, width: 1920, height: 1080, mtime: Date.now() - id * 6e4 });
    const vids = [V(1, 'Kurokawa', 'clip-ed.mp4', 92000), V(2, 'Kurokawa', 'clip-op.mp4', 89000), V(3, 'Kurokawa', 'sign-test.mkv', 15000), V(4, 'Screenshots', 'screen-2026-11-14.mp4', 41000), V(5, 'Screenshots', 'screen-2026-11-13.mp4', 12000), V(6, 'Camera', 'VID_0001.mp4', 31000)];
    const api = { addListener: () => ({ remove() {} }), list: async () => ({ tasks: [] }), mediaAccess: async () => ({ granted: true }), mediaVideos: async () => ({ videos: vids }), videoThumb: async (o) => { window.__thumbCalls++; if (typeof o.id !== 'number' || !vids.some((v) => v.id === o.id)) throw new Error('no such video'); return { url: pic(o.id) }; }, localUrl: async () => ({ url: 'http://127.0.0.1:1/x' }) };
    const App = { addListener: (ev, fn) => { if (ev === 'backButton') window.__back = fn; return { remove() {} }; }, minimizeApp: () => { window.__min++; }, exitApp: () => {} };
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) }), App }, PluginHeaders: [] };
  });
  const hash = () => p.evaluate(() => location.hash || '#/');
  const sysBack = async () => { await p.evaluate(() => window.__back()); await p.waitForTimeout(450); };
  const crumb = () => p.evaluate(() => document.querySelector('.videos-view .videos-crumb b')?.textContent ?? null);
  await p.goto(`http://127.0.0.1:${port}/#/`); await p.waitForSelector('[data-dest="videos"]'); await p.waitForTimeout(300);
  await p.click('[data-dest="videos"]'); await p.waitForSelector('.video-folder');
  ok('Videos: the phone\'s folders', (await p.$$('.video-folder')).length === 3);
  await p.click('.video-folder:has-text("Kurokawa")'); await p.waitForSelector('.video-row');
  ok('inside «Kurokawa», its header «< Kurokawa»', (await crumb()) === 'Kurokawa' && (await p.$$('.video-row')).length === 3);
  await p.waitForFunction(() => document.querySelectorAll('.video-row .video-thumb img').length === 3, null, { timeout: 5000 }).catch(() => undefined);
  ok('each row shows its picture, not the film icon', (await p.$$('.video-row .video-thumb img')).length === 3);
  ok('the length badge stays on the picture', (await p.$$('.video-row .video-thumb img + .video-dur, .video-row .video-thumb .video-dur')).length === 3);
  if (process.env.KT_SHOT) await p.screenshot({ path: process.env.KT_SHOT });
  await sysBack();
  ok('Back inside «Kurokawa»: up to the folders (not the downloads)', /^#\/videos/.test(await hash()) && (await crumb()) === null && !!(await p.$('.video-folder')), await hash());
  await p.click('.video-folder:has-text("Screenshots")'); await p.waitForSelector('.video-row');
  ok('inside «Screenshots»', (await crumb()) === 'Screenshots');
  await sysBack();
  ok('Back inside «Screenshots»: the folders again', /^#\/videos/.test(await hash()) && (await crumb()) === null, await hash());
  await sysBack();
  ok('Back at the tab\'s top: the downloads', (await hash()) === '#/' && !!(await p.$('.downloads-view')), await hash());
  await p.click('[data-dest="videos"]'); await p.waitForSelector('.video-folder'); await p.waitForTimeout(200);
  ok('Videos again: the folders, no folder left open', (await crumb()) === null);
  await p.click('.video-folder:has-text("Camera")'); await p.waitForSelector('.video-row');
  await p.click('.videos-crumb button[data-icon="back"]'); await p.waitForTimeout(400);
  ok('the arrow beside the name: up to the folders too', (await crumb()) === null && /^#\/videos/.test(await hash()));
  await sysBack(); ok('then Back: the downloads', (await hash()) === '#/');
  ok('the app was never sent away', (await p.evaluate(() => window.__min)) === 0);
  ok('no page errors', !errors.length, errors);
  await br.close(); web.close();
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
