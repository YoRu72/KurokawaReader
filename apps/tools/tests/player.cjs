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
    };
    const plugin = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
  }, port);
  await p.goto(`http://127.0.0.1:${port}/`); await p.waitForSelector('.task-card');
  await p.click('.task-card button[aria-label="Play"]'); await p.waitForSelector('.kt-player video.kt-video');
  await p.waitForFunction(() => document.querySelector('.kt-video').currentTime > 0.3, null, { timeout: 15000 });
  check('the video plays', true);
  const T = () => p.evaluate(() => document.querySelector('.kt-video').currentTime);
  const seek = (s) => p.evaluate((s) => { document.querySelector('.kt-video').currentTime = s; }, s);
  await seek(1.5); await p.waitForTimeout(500);
  check('the subtitle beside the file found and shown', /First line/.test(await p.$eval('.kt-subs', (e) => e.textContent)));
  // Double taps on the right: +10, then +10 more (adding up in the ripple).
  await p.evaluate(() => document.querySelector('.kt-video').pause()); await seek(0);
  const box = await p.$eval('.kt-stage', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width * 0.92, y: r.top + r.height / 2 }; });
  await p.mouse.click(box.x, box.y); await p.waitForTimeout(60); await p.mouse.click(box.x, box.y); await p.waitForTimeout(120);
  const t1 = await T(); const r1 = await p.$eval('.kt-ripple', (e) => (e.hidden ? '' : e.textContent));
  await p.mouse.click(box.x, box.y); await p.waitForTimeout(150);
  const r2 = await p.$eval('.kt-ripple', (e) => (e.hidden ? '' : e.textContent)); console.log('double tap:', t1.toFixed(1), r1, '→', r2);
  check('a double tap on the right seeks ten seconds', t1 >= 9.5 && t1 <= 10.5 && /\+10s/.test(r1));
  check('tapping again adds up', /\+20s/.test(r2) || (await T()) >= 11.5);
  // The equaliser.
  await p.click('.kt-top button[aria-label="Sound"]'); await p.waitForSelector('.sheet .kt-eq');
  await p.locator('.sheet .row', { hasText: 'Preset' }).locator('.pick-btn').click(); await p.locator('.sheet .dest-row', { hasText: /^\s*Rock\s*$/ }).last().click(); await p.waitForTimeout(200);
  let prefs = await p.evaluate(() => JSON.parse(localStorage.getItem('kt.player'))); console.log('eq:', prefs.eqOn, prefs.eqPreset, JSON.stringify(prefs.eq));
  check('a preset sets the ten bands and turns the equaliser on', prefs.eqOn && prefs.eqPreset === 'rock' && prefs.eq[0] === 8 && prefs.eq.length === 10);
  check('ten band sliders', (await p.$$('.sheet .kt-eq input[type=range]')).length === 10);
  await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove()));
  // The picture: a quarter turn, a look, sharpness.
  await p.click('.kt-top button[aria-label="More"]'); await p.locator('.sheet .dest-row', { hasText: 'Picture' }).first().click(); await p.waitForSelector('.sheet .chips');
  await p.locator('.sheet .chip', { hasText: '90°' }).click(); await p.locator('.sheet .chip', { hasText: 'Vivid' }).click(); await p.waitForTimeout(150);
  const st = await p.$eval('.kt-video', (v) => ({ tr: v.style.transform, f: v.style.filter })); console.log('picture:', JSON.stringify(st));
  check('rotated a quarter turn', /rotate\(90deg\)/.test(st.tr));
  check('a look applied (with the sharpening filter)', /saturate/.test(st.f) && /url\("?#kt-fx/.test(st.f));
  await p.locator('.sheet .btn.tonal', { hasText: 'Reset' }).click(); await p.waitForTimeout(150);
  check('reset takes it all back', !(await p.$eval('.kt-video', (v) => v.style.transform)));
  // Bookmarks.
  await seek(4); await p.waitForTimeout(150);
  await p.click('.kt-top button[aria-label="More"]'); await p.locator('.sheet .dest-row', { hasText: 'Bookmarks' }).click(); await p.locator('.sheet .btn.primary', { hasText: 'Bookmark' }).click(); await p.waitForTimeout(150);
  check('a bookmark on the bar and remembered', (await p.$$('.kt-seek .kt-bm')).length === 1 && await p.evaluate(() => Object.values(JSON.parse(localStorage.getItem('kt.player.memory'))).some((m) => (m.marks || []).length === 1)));
  await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove()));
  // Jump to a time.
  await p.click('.kt-top button[aria-label="More"]'); await p.locator('.sheet .dest-row', { hasText: 'Jump to a time' }).click(); await p.fill('.sheet input[type=text]', '0:08'); await p.press('.sheet input[type=text]', 'Enter'); await p.waitForTimeout(200);
  check('jumped to 0:08', Math.abs((await T()) - 8) < 0.3);
  // Line by line, and the two-tap sync.
  await seek(1.2); await p.waitForTimeout(100); await p.keyboard.press('Control+ArrowRight'); await p.waitForTimeout(150);
  const tl = await T(); console.log('next line at', tl.toFixed(2)); check('Ctrl+→ goes to the next subtitle line', Math.abs(tl - 5) < 0.2);
  await p.keyboard.press('Shift+H'); await seek(6); await p.waitForTimeout(80); await p.keyboard.press('Shift+J'); await p.waitForTimeout(150);
  const flashText = await p.$eval('.kt-flash', (e) => e.textContent); console.log('sync:', flashText);
  check('heard, then shown: the delay is the difference', /-1\.00/.test(flashText) || /−1\.00/.test(flashText));
  // Seek-bar previews.
  const bar = await p.$eval('.kt-seek', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width * 0.5, y: r.top + r.height / 2 }; });
  await p.evaluate(() => document.querySelector('.kt-player').classList.remove('hide-ui'));
  await p.mouse.move(bar.x, bar.y); await p.mouse.down(); await p.mouse.move(bar.x + 30, bar.y, { steps: 3 }); await p.waitForTimeout(600);
  const pv = await p.$eval('.kt-preview', (e) => ({ shown: !e.hidden, label: e.textContent })).catch(() => ({ shown: false })); await p.mouse.up();
  console.log('preview:', JSON.stringify(pv)); check('a preview over the bar while dragging', pv.shown && /\d:\d\d/.test(pv.label));
  // The preferences panel.
  await p.click('.kt-top button[aria-label="More"]'); await p.locator('.sheet .dest-row', { hasText: 'Player settings' }).click(); await p.waitForSelector('.sheet .pp-group');
  const groups = await p.$$eval('.sheet .pp-group > summary', (e) => e.map((x) => x.textContent)); console.log('groups:', groups.join(' | '));
  check('six groups of preferences', groups.length === 6);
  check('no page errors', !errors.length);
  await br.close(); web.close(); fs.rmSync(MEDIA, { recursive: true, force: true });
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
