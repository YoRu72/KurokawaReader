// Pictures in lists (ui/thumbs.ts). On a pretend phone (the plugin faked, made-up pictures): a folder of 40 videos
// asks only for the rows near the screen, never more than three at a time, with the video's id as a number and its
// path, time and size (what the plugin keys its disk cache by); a video without a picture keeps the film icon; every
// picture keeps its length badge; scrolling down asks for the rest; a folder seen again asks for nothing. On a computer
// (the desktop bridge faked: a folder listed, each file's address on this test's server): Files draws the pictures and a
// GIF's first frame itself. KT_SHOTS=<dir>: screenshots of both.
// Run: NODE_PATH=$(npm root -g) node tests/thumbs.cjs
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.woff2': 'font/woff2' };
// (Made-up pictures for the computer: PNGs drawn by the browser below, and a 1×1 GIF.)
const FX = {}; const GIF = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
const serve = () => http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); if (u.pathname === '/fx') { const n = u.searchParams.get('p').split('/').pop(); const b = n.endsWith('.gif') ? GIF : FX[n]; if (!b) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*' }); res.end(b); return; }
  let p = decodeURIComponent(u.pathname); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const SHOTS = process.env.KT_SHOTS;

async function phone(br, port) {
  const ctx = await br.newContext({ viewport: { width: 412, height: 900 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 404 }));
  const p = await ctx.newPage(); const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(() => {
    localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['player'], playerWith: 'app' }));
    const memo = { '/storage/emulated/0/Kurokawa/Kurokawa ED karaoke v3.mp4': { pos: 40, duration: 92, at: Date.now() - 2000 } }; localStorage.setItem('kt.player.memory', JSON.stringify(memo));
    window.__calls = []; window.__inflight = 0; window.__maxInflight = 0;
    const pic = (id) => { const c = document.createElement('canvas'); c.width = 320; c.height = 180; const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 0, 320, 180); gr.addColorStop(0, `hsl(${(id * 53) % 360} 42% 34%)`); gr.addColorStop(1, `hsl(${(id * 53 + 70) % 360} 46% 16%)`); g.fillStyle = gr; g.fillRect(0, 0, 320, 180); g.fillStyle = 'rgba(255,255,255,.14)'; for (let i = 0; i < 6; i++) { g.beginPath(); g.arc(40 + i * 55, 120 - (i % 3) * 25, 18 + (id % 4) * 6, 0, 7); g.fill(); } g.fillStyle = 'rgba(255,255,255,.8)'; g.font = '600 22px sans-serif'; g.fillText(`#${id}`, 14, 34); return c.toDataURL('image/jpeg', 0.82); };
    const names = ['Kurokawa ED karaoke v3.mp4', 'Kurokawa OP signs test.mp4', 'Horemajo 03 karaoke preview.mkv', 'Seitokai ED rotating scene.mp4', 'Uma Musume title card.mp4', 'Demons Crest ED.mkv'];
    const vids = []; for (let i = 1; i <= 40; i++) vids.push({ id: 1000 + i, path: `/storage/emulated/0/Kurokawa/${i <= names.length ? names[i - 1] : `clip ${String(i).padStart(2, '0')}.mp4`}`, name: i <= names.length ? names[i - 1] : `clip ${String(i).padStart(2, '0')}.mp4`, folder: 'Kurokawa', duration: 15000 + i * 7000, size: 2e7 + i * 3e6, width: 1920, height: 1080, mtime: Date.now() - i * 36e5 });
    vids.push({ id: 2001, path: '/storage/emulated/0/DCIM/Screenshots/screen-2026-11-14.mp4', name: 'screen-2026-11-14.mp4', folder: 'Screenshots', duration: 41000, size: 9e6, width: 1080, height: 2400, mtime: Date.now() - 6e7 });
    const api = { addListener: () => ({ remove() {} }), list: async () => ({ tasks: [] }), mediaAccess: async () => ({ granted: true }), mediaVideos: async () => ({ videos: vids }),
      videoThumb: async (o) => { window.__calls.push(o); window.__inflight++; window.__maxInflight = Math.max(window.__maxInflight, window.__inflight); await new Promise((r) => setTimeout(r, 60)); window.__inflight--; if (o.id === 1003) throw new Error('none'); return { url: pic(o.id) }; } };
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) }) }, PluginHeaders: [] };
  });
  await p.goto(`http://127.0.0.1:${port}/#/videos?tab=phone`); await p.waitForSelector('.video-folder'); await p.waitForTimeout(600);
  await p.click('.video-folder:has-text("Kurokawa")'); await p.waitForSelector('.video-row'); await p.waitForTimeout(1500);
  const calls = await p.evaluate(() => window.__calls);
  const folderCalls = calls.filter((c) => c.id > 1006);
  ok('only the rows near the screen were asked for', calls.length > 3 && calls.length < 30, calls.length);
  ok('never more than three at a time', (await p.evaluate(() => window.__maxInflight)) <= 3, await p.evaluate(() => window.__maxInflight));
  ok('each asked by its id as a number, with path, time and size', calls.every((c) => typeof c.id === 'number' && c.id > 0 && typeof c.path === 'string' && c.path.startsWith('/storage/') && typeof c.mtime === 'number' && typeof c.size === 'number'));
  void folderCalls;
  const row3 = await p.evaluate(() => { const r = [...document.querySelectorAll('.video-row')].find((x) => x.textContent.includes('Horemajo')); return r ? [!!r.querySelector('.video-thumb svg'), !!r.querySelector('.video-thumb img')] : null; });
  ok('a video without a picture keeps the film icon', row3 && row3[0] && !row3[1], row3);
  const withImg = await p.$$eval('.video-row .video-thumb', (bs) => bs.filter((b) => b.querySelector('img')).map((b) => !!b.querySelector('.video-dur')));
  ok('pictures shown, each with its length badge', withImg.length >= 4 && withImg.every(Boolean), withImg);
  ok('the progress bar stays too', !!(await p.$('.video-row .video-thumb img ~ .video-prog, .video-row .video-thumb .video-prog')));
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'videos-folder-thumbnails-phone.png') });
  const before = calls.length;
  await p.evaluate(() => { const b = document.querySelector('.videos-view .body') || document.scrollingElement; b.scrollTop = 1e6; window.scrollTo(0, 1e6); }); await p.waitForTimeout(1800);
  const after = await p.evaluate(() => window.__calls.length);
  ok('scrolled down: the rest asked for', after > before, [before, after]);
  await p.click('.videos-crumb button[data-icon="back"]'); await p.waitForSelector('.video-folder'); await p.waitForTimeout(400);
  const n0 = await p.evaluate(() => window.__calls.length);
  await p.click('.video-folder:has-text("Kurokawa")'); await p.waitForSelector('.video-row'); await p.waitForTimeout(800);
  const n1 = await p.evaluate(() => window.__calls.length);
  ok('the folder seen again: its pictures from memory, nothing asked again but the one without', n1 - n0 <= 1, [n0, n1]);
  ok('[phone] no page errors', !errors.length, errors);
  await ctx.close();
}

async function pc(br, port) {
  // (The made-up pictures: drawn by the browser, kept as PNG bytes for the server.)
  const mk = await br.newPage();
  for (const [n, hue] of [['sunset.png', 18], ['forest.png', 130], ['night sky.png', 230], ['poster.jpg', 300]]) FX[n] = Buffer.from((await mk.evaluate(([hue, n]) => { const c = document.createElement('canvas'); c.width = 400; c.height = 300; const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 0, 400, 300); gr.addColorStop(0, `hsl(${hue} 50% 42%)`); gr.addColorStop(1, `hsl(${hue + 40} 45% 14%)`); g.fillStyle = gr; g.fillRect(0, 0, 400, 300); g.fillStyle = 'rgba(255,255,255,.2)'; g.beginPath(); g.arc(280, 110, 60, 0, 7); g.fill(); return c.toDataURL(n.endsWith('.jpg') ? 'image/jpeg' : 'image/png').split(',')[1]; }, [hue, n])), 'base64');
  await mk.close();
  const ctx = await br.newContext({ viewport: { width: 1366, height: 800 } });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 404 }));
  const p = await ctx.newPage(); const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript((port) => {
    localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['files'] })); localStorage.setItem('kt.pc.starter', '1');
    const E = (name, size) => ({ name, path: `/home/me/Pictures/${name}`, dir: false, size, mtime: Date.now() - 1e6 });
    const entries = [E('sunset.png', 2.1e6), E('forest.png', 1.8e6), E('night sky.png', 1.2e6), E('poster.jpg', 3e5), E('wave.gif', 4e4), E('notes.txt', 900)];
    window.__urls = [];
    window.kurokawaTools = new Proxy({ platform: 'desktop', available: true, os: 'linux', ready: async () => ({}), list: async () => [], onTasks: (cb) => { cb([]); return () => {}; }, defaultDir: async () => '/home/me/Downloads', homeDir: async () => '/home/me',
      listDir: async (d) => ({ entries: d === '/home/me/Pictures' ? entries : [] }), fileUrl: async (pth) => { window.__urls.push(pth); return `http://127.0.0.1:${port}/fx?p=${encodeURIComponent(pth)}`; } }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) });
  }, port);
  await p.goto(`http://127.0.0.1:${port}/#/files?p=${encodeURIComponent('/home/me/Pictures')}`); await p.waitForSelector('.files-row'); await p.waitForTimeout(2000);
  const shown = await p.$$eval('.files-row', (rs) => rs.map((r) => [r.querySelector('.files-name')?.getAttribute('title') ?? r.innerText.split('\n')[0], !!r.querySelector('.files-ic img'), r.querySelector('.files-ic img')?.src.slice(0, 22) ?? '']));
  console.log('pc rows:', JSON.stringify(shown));
  ok('[pc] Files draws each picture itself (a small JPEG)', shown.filter((x) => /\.(png|jpg)$/.test(x[0])).every((x) => x[1] && x[2].startsWith('data:image/jpeg')), shown);
  ok('[pc] a GIF: its first frame, still', shown.some((x) => x[0] === 'wave.gif' && x[1] && x[2].startsWith('data:image/jpeg')), shown);
  ok('[pc] a text file keeps its icon', shown.some((x) => x[0] === 'notes.txt' && !x[1]));
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'files-thumbnails-pc.png') });
  ok('[pc] no page errors', !errors.length, errors);
  await ctx.close();
}

(async () => {
  const web = serve().listen(0); const port = web.address().port; const br = await chromium.launch();
  await phone(br, port); await pc(br, port);
  await br.close(); web.close();
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
