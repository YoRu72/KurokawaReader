// Finding a page's videos. native/grab.js (what the app's browser runs on a page) must be the same in its two
// embedded copies; run on a player page it finds the <video> and its sources, the og:video tag, the JSON-LD
// contentUrl, an escaped playlist address in a script and the playlist the page fetched; the grabber's plain read
// (no browser) finds the same without running the page, and sends a stream's playlist to the Video add-on.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const ROOT = path.join(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
const PAGE = `<!doctype html><html><head><title>A clip</title>
<meta property="og:video" content="https://cdn.example.com/og/clip-720.mp4"><meta property="og:video:type" content="video/mp4"><meta property="og:video:width" content="1280">
<script type="application/ld+json">{"@type":"VideoObject","name":"A clip","contentUrl":"https://cdn.example.com/ld/clip.mp4","thumbnailUrl":"https://cdn.example.com/t.jpg"}</script>
<script>var player = {"sources":[{"file":"https:\\/\\/stream.example.com\\/hls\\/abc\\/master.m3u8?token=x\\u0026e=1"}]};</script>
</head><body><video id="v" src="/media/main.mp4" title="Main"><source src="/media/main-480.webm"></video>
<a href="/files/notes.pdf">notes</a><img src="/img/a.jpg"></body></html>`;
(async () => {
  const errors = []; const check = (what, ok) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) errors.push(what); };
  const m = await import(path.join(ROOT, 'native', 'embed-grab.mjs'));
  const desk = /^const GRAB_JS = (.*);$/m.exec(fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8'));
  const java = /^ {4}static final String GRAB_JS = (.*);$/m.exec(fs.readFileSync(path.join(ROOT, 'native', 'android', 'KtBrowserActivity.java'), 'utf8'));
  check('desktop copy matches native/grab.js (run node native/embed-grab.mjs)', desk && JSON.parse(desk[1]) === m.grabSource());
  check('android copy matches native/grab.js', java && JSON.parse(java[1]) === m.grabSource());
  const web = serve(DIST).listen(0); const port = web.address().port;
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 420, height: 860 } });
  p.on('pageerror', (e) => errors.push(e.message));
  // The browser's reading, on the page itself.
  await p.route('https://site.example.com/**', (r) => { const u = r.request().url(); if (/watch/.test(u)) return r.fulfill({ contentType: 'text/html', body: PAGE }); if (/\.m3u8/.test(u)) return r.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: '#EXTM3U' }); return r.fulfill({ status: 404, body: '' }); });
  await p.route(/cdn\.example\.com|stream\.example\.com/, (r) => r.fulfill({ status: 404, body: '' }));
  await p.goto('https://site.example.com/watch?v=1'); await p.evaluate(() => fetch('/live/index.m3u8').catch(() => 0)); await p.waitForTimeout(300);
  const got = await p.evaluate(m.grabSource());
  const vids = got.links.filter((l) => l.kind === 'video').map((l) => l.href); console.log('browser videos:\n  ' + vids.join('\n  '));
  for (const [what, u] of [['the <video>', 'https://site.example.com/media/main.mp4'], ['its <source>', 'https://site.example.com/media/main-480.webm'], ['og:video', 'https://cdn.example.com/og/clip-720.mp4'], ['JSON-LD', 'https://cdn.example.com/ld/clip.mp4'], ['the escaped playlist', 'https://stream.example.com/hls/abc/master.m3u8?token=x&e=1'], ['the playlist it fetched', 'https://site.example.com/live/index.m3u8']]) check(`browser finds ${what}`, vids.includes(u));
  check('og:video:type and width are not links', !got.links.some((l) => /^video\/mp4$|^1280$/.test(l.href)));
  // The grabber's plain read (the desktop bridge faked, with yt-dlp there).
  await p.addInitScript(() => {
    const tasks = []; window.__added = [];
    window.kurokawaTools = { platform: 'desktop', available: true, os: 'linux', ready: async () => ({}), list: async () => tasks, add: async (o) => { window.__added.push(o); return { id: 't' + window.__added.length, name: 'x', ...o }; }, pause: async () => {}, resume: async () => {}, remove: async () => {}, setFiles: async () => {}, setLimits: async () => {}, configure: async () => {}, torrentInfo: async () => null, open: async () => {}, defaultDir: async () => '/d', pickDir: async () => '/x', onTasks: (cb) => { cb(tasks); return () => {}; }, videoInfo: async () => { throw new Error('no'); }, videoVersion: async () => ({ version: '2026.10.1' }) };
    try { const s = JSON.parse(localStorage.getItem('kt.settings') || '{}'); s.addons = ['video']; localStorage.setItem('kt.settings', JSON.stringify(s)); } catch (e) { /* first */ }
  });
  await p.unroute('https://site.example.com/**');
  await p.route('https://site.example.com/**', (r) => r.fulfill({ contentType: 'text/html', headers: { 'access-control-allow-origin': '*' }, body: PAGE }));
  await p.goto(`http://127.0.0.1:${port}/#/`); await p.waitForSelector('.fab');
  await p.click('.fab'); await p.locator('.fab-item', { hasText: 'Grab' }).click(); await p.waitForSelector('.sheet input[type=url]');
  await p.fill('.sheet input[type=url]', 'https://site.example.com/watch?v=1'); await p.press('.sheet input[type=url]', 'Enter'); await p.waitForSelector('.grab-row');
  const chip = await p.$$eval('.sheet .chip', (c) => c.map((x) => x.textContent)); console.log('chips:', chip.join(' | '));
  check('the Videos chip is chosen first', /Video/.test(await p.$eval('.sheet .chip.on:not([data-d])', (e) => e.textContent).catch(() => '')));
  const rows = await p.$$eval('.grab-row .src', (r) => r.map((x) => x.textContent)); console.log('plain read rows:', rows.join(' | '));
  check('plain read finds 5 videos', rows.length === 5);
  check('the Video add-on offered for the page', !!(await p.$('.grab-ytdlp')));
  await p.click('.sheet .btn.primary'); await p.waitForFunction(() => window.__added.length === 5);
  const added = await p.evaluate(() => window.__added.map((a) => [a.source.url, !!a.video]));
  console.log('added:', JSON.stringify(added));
  check('the playlist goes to the Video add-on, files download as files', added.find((a) => /master\.m3u8/.test(a[0]))?.[1] === true && added.filter((a) => a[1]).length === 1);
  check('no page errors', !errors.filter((e) => e !== 'no page errors').length);
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
