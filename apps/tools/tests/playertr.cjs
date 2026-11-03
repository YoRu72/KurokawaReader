// The player's subtitles translated (Google answered here): the lines from where the video is first, the translation
// shown with the original above it, a second line chosen by hand, the progress said; the rest of the player's
// own test is in player.cjs. (Header kept from it:)
// The player (REX Player's and VLC's features) on a finished download (the Android plugin faked, a short WebM
// made by ffmpeg and served here, its subtitle beside it): the subtitle found and shown; double taps seeking and
// adding up; the equaliser's presets; rotation, looks and sharpness; bookmarks on the bar; jumping to a time;
// line-by-line subtitle seeking and VLC's two-tap sync; previews over the seek bar; the preferences panel.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const { execFileSync } = require('node:child_process');
const DIST = path.join(__dirname, '..', 'dist');
const MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-player-'));
try { execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '12', '-c:v', 'libvpx', '-b:v', '300k', '-c:a', 'libopus', path.join(MEDIA, 'clip.webm')]); }
catch { console.log('ffmpeg not available — skipped'); process.exit(0); }
fs.writeFileSync(path.join(MEDIA, 'clip.srt'), '1\n00:00:01,000 --> 00:00:03,000\nFirst line\n\n2\n00:00:05,000 --> 00:00:07,000\nSecond line\n\n3\n00:00:09,000 --> 00:00:11,000\nThird line\n');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg', '.webm': 'video/webm', '.srt': 'text/plain' };
const serve = () => http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = p.startsWith('/media/') ? path.join(MEDIA, p.slice(7)) : path.join(DIST, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  const size = fs.statSync(f).size; const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const type = MIME[path.extname(f)] || 'application/octet-stream';
  if (range) { const a = Number(range[1]), b = range[2] ? Number(range[2]) : size - 1; res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${a}-${b}/${size}`, 'accept-ranges': 'bytes', 'content-length': b - a + 1, 'access-control-allow-origin': '*' }); fs.createReadStream(f, { start: a, end: b }).pipe(res); return; }
  res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size, 'access-control-allow-origin': '*' }); fs.createReadStream(f).pipe(res);
});
(async () => {
  const web = serve().listen(0); const port = web.address().port;
  const br = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const p = await br.newPage({ viewport: { width: 900, height: 520 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  const check = (what, ok) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) errors.push(what); };
  await p.addInitScript((port) => {
    localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['player'], playerWith: 'app' }));
    const task = { id: 'v', kind: 'http', name: 'clip.webm', source: { url: 'https://x/clip.webm' }, dir: '/sdcard/Download', state: 'done', done: 1, total: 1, downSpeed: 0, upSpeed: 0, files: [{ index: 0, path: 'clip.webm', size: 1, done: 1, priority: 1 }], addedAt: Date.now() - 60e3, doneAt: Date.now(), engine: 'native' };
    const api = {
      addListener: () => Promise.resolve({ remove() {} }), list: async () => ({ tasks: [task] }),
      localUrl: async (o) => ({ url: `http://127.0.0.1:${port}/media/${o.path.split('/').pop()}` }), siblings: async () => ({ paths: ['/sdcard/Download/clip.srt'] }),
      httpRequest: async (o) => { const r = await fetch(o.url, { method: o.method || 'GET', headers: o.headers, body: o.body }); return { status: r.status, headers: {}, body: await r.text() }; },
    };
    const plugin = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
  }, port);
  const asked = [];
  await p.route('https://translate.googleapis.com/**', (r) => { const u = new URL(r.request().url()); asked.push(u.searchParams.get('q')); r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify([[['JA:' + u.searchParams.get('q'), u.searchParams.get('q')]], null, 'en']) }); });
  await p.goto(`http://127.0.0.1:${port}/`); await p.waitForSelector('.task-card');
  await p.click('.task-card button[aria-label="Play"]'); await p.waitForSelector('.kt-player video.kt-video');
  await p.waitForFunction(() => document.querySelector('.kt-video').currentTime > 0.3, null, { timeout: 15000 });
  const seek = (s) => p.evaluate((s) => { const v = document.querySelector('.kt-video'); v.pause(); v.currentTime = s; }, s);
  await seek(5.5); await p.waitForFunction(() => /Second line/.test(document.querySelector('.kt-subs')?.textContent || ''), null, { timeout: 8000 });
  await p.click('.kt-top button[aria-label="Subtitles"]'); await p.waitForSelector('.sheet .sub-tr button.btn');
  await p.locator('.sheet .sub-tr .row', { hasText: 'To' }).locator('.pick-btn').click(); await p.locator('.sheet .dest-row', { hasText: '日本語' }).last().click(); await p.waitForTimeout(200);
  await p.click('.sheet .sub-tr button.btn.tonal'); await p.waitForFunction(() => /Translated into/.test(document.querySelector('.sub-tr-status')?.textContent || ''), null, { timeout: 10000 }).catch(() => undefined);
  console.log('status:', await p.textContent('.sub-tr-status').catch(() => '?'));
  check('the end said, the language named', /Translated into 日本語/.test(await p.textContent('.sub-tr-status')));
  console.log('asked in order:', asked.join(' | '));
  check('the lines from where the video is asked first', asked[0] === 'Second line' && asked.includes('First line') && asked.length === 3);
  await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove()));
  await seek(5.6); await p.waitForTimeout(400);
  const bottom = await p.$eval('.kt-subs', (e) => e.textContent); const top = await p.evaluate(() => [...document.querySelectorAll('.kt-subs-top, .kt-sub2, .kt-subs.top')].map((e) => e.textContent).join(' '));
  const all = await p.evaluate(() => document.querySelector('.kt-player').innerText);
  console.log('bottom:', bottom, '| all:', all.replace(/\s+/g, ' ').slice(0, 200));
  check('the translation shown', /JA:Second line/.test(all));
  check('the original kept above it', /Second line/.test(all.replace(/JA:Second line/g, '')));
  
  // A second line by hand: none.
  await p.click('.kt-top button[aria-label="Subtitles"]'); await p.waitForSelector('.sheet .row .pick-btn');
  await p.locator('.sheet .row', { hasText: 'Second line' }).locator('.pick-btn').click(); await p.locator('.sheet .dest-row', { hasText: /^\s*No subtitles\s*$/ }).last().click(); await p.waitForTimeout(200);
  await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove())); await seek(5.7); await p.waitForTimeout(400);
  const all2 = await p.evaluate(() => document.querySelector('.kt-player').innerText);
  check('the second line turned off by hand', /JA:Second line/.test(all2) && !/Second line/.test(all2.replace(/JA:Second line/g, '')));
  check('no page errors', !errors.length);
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
