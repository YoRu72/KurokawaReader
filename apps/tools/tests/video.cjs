// The smart Add bar: a YouTube link without the Video add-on offers it; with it, yt-dlp's answer (faked) shows the
// qualities; Download adds a video task with the chosen format. A plain file link stays an ordinary download.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const REPO = path.join(__dirname, '..', '..', '..', 'repo');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port;
  const lang = process.argv[2] || 'en';
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 420, height: 860 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.route(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/main\/repo\/(.*)/, (r) => { const f = path.join(REPO, r.request().url().split('/main/repo/')[1]); if (!fs.existsSync(f)) return r.fulfill({ status: 404 }); r.fulfill({ body: fs.readFileSync(f), contentType: /\.mjs$/.test(f) ? 'text/plain' : (MIME[path.extname(f)] || 'application/octet-stream') }); });
  await p.route(/i\.ytimg\.com/, (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#c33"/></svg>' }));
  await p.addInitScript((lang) => {
    localStorage.setItem('kr.lang', lang); window.__added = [];
    const raw = { id: 'abc', title: 'A short film about trains', thumbnail: 'https://i.ytimg.com/vi/abc/hq.jpg', duration: 754, extractor_key: 'Youtube', webpage_url: 'https://www.youtube.com/watch?v=abc', uploader: 'Rail Channel', subtitles: { en: [], ar: [] },
      formats: [{ format_id: '251', url: 'x', vcodec: 'none', acodec: 'opus', abr: 160, ext: 'webm', filesize: 12e6 }, { format_id: '140', url: 'x', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, ext: 'm4a', filesize: 9e6 },
        { format_id: '137', url: 'x', vcodec: 'avc1', acodec: 'none', height: 1080, fps: 30, tbr: 4000, ext: 'mp4', filesize: 300e6 }, { format_id: '22', url: 'x', vcodec: 'avc1', acodec: 'mp4a', height: 720, fps: 30, tbr: 2000, ext: 'mp4', filesize: 120e6 }, { format_id: '313', url: 'x', vcodec: 'vp9', acodec: 'none', height: 2160, fps: 60, tbr: 18000, ext: 'webm', filesize: 1.4e9 }] };
    window.kurokawaTools = { platform: 'desktop', available: true, os: 'linux', ready: async () => ({}), list: async () => [], add: async (o) => { window.__added.push(o); return { id: 't' + window.__added.length, name: o.video?.title || o.source.url, ...o }; }, pause: async () => {}, resume: async () => {}, remove: async () => {}, setFiles: async () => {}, setLimits: async () => {}, configure: async () => {}, torrentInfo: async () => null, open: async () => {}, defaultDir: async () => '/home/u/Downloads', pickDir: async () => null, onTasks: (cb) => { cb([]); return () => {}; },
      videoReady: async () => true, videoInfo: async (o) => { await new Promise((r) => setTimeout(r, 150)); if (/youtube/.test(o.url)) return raw; throw new Error('Unsupported URL'); }, videoVersion: async () => ({ version: '2026.10.10', ready: true }), videoUpdate: async () => ({ version: '2026.10.22', updated: true }) };
  }, lang);
  const base = `http://127.0.0.1:${port}/`;
  await p.goto(base + '#/'); await p.waitForSelector('.fab'); await p.click('.fab'); await p.waitForSelector('.sheet');
  await p.fill('.add-input', 'https://www.youtube.com/watch?v=abc'); await p.waitForSelector('.video-card.offer', { timeout: 4000 });
  console.log('offer:', await p.$eval('.video-card.offer', (e) => e.innerText.replace(/\n+/g, ' | ')));
  await p.click('.video-card.offer .btn'); await p.waitForSelector('.video-choices', { timeout: 6000 });
  console.log('panel:', (await p.$eval('.video-panel', (e) => e.innerText)).replace(/\n+/g, ' | '));
  await p.screenshot({ path: path.join(__dirname, `shot-video-${lang}.png`) });
  await p.click('.video-choices .chip:has-text("720")');
  await p.click('.sheet .btn.primary'); await p.waitForFunction(() => window.__added.length === 1);
  console.log('added:', JSON.stringify(await p.evaluate(() => window.__added[0])));
  // A file link: no panel, an ordinary task.
  await p.click('.fab'); await p.waitForSelector('.sheet'); await p.fill('.add-input', 'https://example.com/files/linux.iso'); await p.waitForTimeout(900);
  console.log('file panel hidden:', await p.$eval('.video-panel', (e) => e.hidden));
  await p.click('.sheet .btn.primary'); await p.waitForFunction(() => window.__added.length === 2);
  console.log('file added:', JSON.stringify(await p.evaluate(() => window.__added[1])));
  // Settings card
  await p.goto(base + '#/settings'); await p.waitForSelector('#video'); await p.waitForFunction(() => /2026/.test(document.querySelector('#video').innerText));
  console.log('settings:', (await p.$eval('#video', (e) => e.innerText)).replace(/\n+/g, ' | '));
  console.log(errors.length ? 'errors ' + JSON.stringify(errors) : 'all passed');
  await br.close(); web.close(); process.exit(errors.length ? 1 : 0);
})();
