// The app's own player never leaves a silent black screen (src/player/health.ts), with made-up media made here by
// ffmpeg: a video with no audio track → «This file has no audio track» (the video goes on); a video whose picture does
// not decode (its frames overwritten) → «the file looks damaged» with «Open in another player» and «Download again»;
// an MPEG-TS (.ts) on a computer whose web view cannot play it → «This player can't open it» with «Open in another
// player»; .ts, .m2ts and .mts counted as videos. Phone (the plugin faked) and computer (the bridge faked), English or
// Arabic. KT_SHOTS=<dir>: screenshots. Run: NODE_PATH=$(npm root -g) node tests/playerhealth.cjs [en|ar]
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..'); const DIST = path.join(ROOT, 'dist'); const LANG = process.argv[2] === 'ar' ? 'ar' : 'en'; const SHOTS = process.env.KT_SHOTS;
const MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-health-'));
const ff = (...a) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...a]);
try {
  ff('-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-t', '12', '-c:v', 'libvpx', '-b:v', '300k', '-an', path.join(MEDIA, 'mute.webm'));
  ff('-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '12', '-c:v', 'libvpx', '-b:v', '300k', '-c:a', 'libopus', path.join(MEDIA, 'sound.webm'));
  ff('-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-t', '6', '-c:v', 'mpeg2video', '-f', 'mpegts', path.join(MEDIA, 'clip.ts'));
} catch { if (process.env.KT_REQUIRE_FFMPEG) { console.log('FAIL ffmpeg is required here (KT_REQUIRE_FFMPEG)'); process.exit(1); } console.log('ffmpeg not available — skipped'); process.exit(0); }
// (The damaged one: the picture track keeps its size in the header but not one of its frames comes through — the sound
// plays on, the time runs, the screen stays black: the owner's case, made here by dropping every picture packet.)
try { ff('-i', path.join(MEDIA, 'sound.webm'), '-c', 'copy', '-bsf:v', 'noise=drop=1', path.join(MEDIA, 'broken.webm')); } catch { if (process.env.KT_REQUIRE_FFMPEG) { console.log('FAIL ffmpeg with the noise filter is required here'); process.exit(1); } console.log('ffmpeg without the noise filter — skipped'); process.exit(0); }
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 500))); if (!c) fails++; };
setTimeout(() => { console.log('FAIL timed out'); process.exit(1); }, 240000).unref();
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webm': 'video/webm', '.ts': 'video/mp2t' };
const T = LANG === 'ar' ? { noAudio: 'لا مسار صوت', noSound: 'تعذَّر تشغيل أيِّ صوت', damaged: 'تالف', format: 'لا يشغِّل هذا المشغِّل', play: 'تشغيل', other: 'افتحه في مشغّل آخر' } : { noAudio: 'no audio track', noSound: 'No sound could be played', damaged: 'looks damaged', format: "can't play this kind of file", play: 'Play', other: 'Open in another player' };
const web = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = p.startsWith('/media/') ? path.join(MEDIA, p.slice(7)) : path.join(DIST, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  const size = fs.statSync(f).size; const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || ''); const type = MIME[path.extname(f)] || 'application/octet-stream';
  if (range) { const a = Number(range[1]), b = range[2] ? Number(range[2]) : size - 1; res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${a}-${b}/${size}`, 'accept-ranges': 'bytes', 'content-length': b - a + 1, 'access-control-allow-origin': '*' }); fs.createReadStream(f, { start: a, end: b }).pipe(res); return; }
  res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size, 'access-control-allow-origin': '*' }); fs.createReadStream(f).pipe(res);
}).listen(0, '127.0.0.1', async () => {
  const port = web.address().port; const base = `http://127.0.0.1:${port}/`;
  const br = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const errors = [];
  const shot = async (p, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, `health-${name}-${LANG}.png`) }); } };
  const task = (id, name) => ({ id, kind: 'http', name, source: { url: `https://example.test/${name}` }, dir: '/v', state: 'done', done: 1, total: 1, downSpeed: 0, upSpeed: 0, files: [{ index: 0, path: name, size: 1, done: 1, priority: 1 }], addedAt: Date.now() - 60e3, doneAt: Date.now(), engine: 'native' });
  const tasks = [task('a', 'mute.webm'), task('b', 'broken.webm'), task('c', 'clip.ts'), task('d', 'sound.webm')];
  const playIn = async (p, name) => { await p.click(`.task-card:has-text("${name}") button[aria-label="${T.play}"]`); };
  for (const where of ['phone', 'pc']) {
    const p = await br.newPage(where === 'phone' ? { viewport: { width: 360, height: 760 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 800 } });
    p.on('pageerror', (e) => errors.push(`${where}: ${e.message}`));
    await p.addInitScript(([lang, port, where, tasks]) => {
      localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.pc.starter', '1'); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['player'], playerWith: 'app' }));
      const url = (pth) => `http://127.0.0.1:${port}/media/${pth.split('/').pop()}`;
      if (where === 'phone') {
        const api = { addListener: () => Promise.resolve({ remove() {} }), list: async () => ({ tasks }), localUrl: async (o) => ({ url: url(o.path) }), siblings: async () => ({ paths: [] }), packStatus: async () => ({ python: { version: null, size: 0 }, ffmpeg: { version: null, size: 1 }, mpv: { version: null, size: 0 } }) };
        window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) }) }, PluginHeaders: [] };
      } else {
        const api = { ffprobe: async (u) => (/mute/.test(u) ? { streams: [{ codec_type: 'video', codec_name: 'vp8' }] } : /sound|broken/.test(u) ? { streams: [{ codec_type: 'video', codec_name: 'vp8' }, { codec_type: 'audio', codec_name: 'opus' }] } : null), platform: 'desktop', available: true, os: 'linux', list: async () => tasks, onTasks: (fn) => { setTimeout(() => fn(tasks), 50); return () => {}; }, on: () => () => {}, ready: async () => ({}), freeSpace: async () => 5e11, fileUrl: async (pth) => url(pth), siblings: async () => [] };
        window.kurokawaTools = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) });
      }
    }, [LANG, port, where, tasks]);
    await p.goto(base); await p.waitForSelector('.task-card', { timeout: 20000 });
    ok(`${where}: .ts counted as a video (its card has Play)`, !!(await p.$(`.task-card:has-text("clip.ts") button[aria-label="${T.play}"]`)));
    // no audio track
    await playIn(p, 'mute.webm'); await p.waitForSelector('.kt-player video.kt-video', { timeout: 15000 });
    // (Truthful words: «no audio track» only when a track list says so — the computer's probe here; the phone's fake has
    // no probe, so all it can say is that no sound could be played.)
    const want = where === 'pc' ? T.noAudio : T.noSound;
    await p.waitForFunction((s) => { const n = document.querySelector('.kt-notice'); return n && !n.hidden && n.textContent.includes(s); }, want, { timeout: 15000 }).catch(() => undefined);
    const told = await p.evaluate((s) => { const n = document.querySelector('.kt-notice'); return !!n && !n.hidden && n.textContent.includes(s); }, want);
    ok(`${where}: a video with no sound: said truthfully (${where === 'pc' ? 'the probe lists no audio track' : 'nothing lists the tracks'}), and it goes on playing`, told && !(await p.evaluate(() => document.querySelector('.kt-video').paused)));
    await shot(p, `noaudio-${where}`);
    await p.click('.kt-top button[data-icon="back"]'); await p.waitForFunction(() => !document.querySelector('.kt-player'));
    await playIn(p, 'sound.webm'); await p.waitForFunction(() => { const v = document.querySelector('.kt-video'); return v && v.currentTime > 4.5; }, null, { timeout: 20000 });
    ok(`${where}: …a file with sound and picture: no notice, no sheet`, !(await p.evaluate(() => { const n = document.querySelector('.kt-notice'); return !!n && !n.hidden; })) && !(await p.$('.kt-problem')));
    await p.click('.kt-top button[data-icon="back"]'); await p.waitForFunction(() => !document.querySelector('.kt-player'));
    // damaged picture — first with the window hidden (nothing drawn then): no verdict; seen again: the sheet
    await p.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    await playIn(p, 'broken.webm'); await p.waitForFunction(() => { const v = document.querySelector('.kt-video'); return v && v.currentTime > 5; }, null, { timeout: 20000 });
    ok(`${where}: hidden while it plays: no «damaged» verdict (frames are not drawn then)`, !(await p.$('.kt-problem')));
    await p.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
    await p.waitForFunction((s) => document.querySelector('.kt-problem')?.textContent.includes(s), T.damaged, { timeout: 20000 }).catch(() => undefined);
    const dmg = await p.evaluate(() => ({ text: document.querySelector('.kt-problem')?.textContent ?? '', buttons: document.querySelectorAll('.kt-problem .btn').length }));
    ok(`${where}: a picture that does not decode: «looks damaged», «Open in another player» and «Download again»`, dmg.text.includes(T.damaged) && dmg.buttons === 2, dmg);
    await p.waitForTimeout(250); await shot(p, `damaged-${where}`);
    await p.keyboard.press('Escape'); await p.waitForTimeout(200);
    if (await p.$('.kt-player')) { await p.click('.kt-top button[data-icon="back"]').catch(() => undefined); }
    await p.goto(base); await p.waitForSelector('.task-card');
    // a sound file is checked too (no false «no audio»)
    if (where === 'pc') {
      await playIn(p, 'clip.ts');
      await p.waitForFunction((s) => document.querySelector('.kt-problem')?.textContent.includes(s), T.format, { timeout: 25000 }).catch(() => undefined);
      const fm = await p.evaluate(() => ({ text: document.querySelector('.kt-problem')?.textContent ?? '', other: !!document.querySelector('.kt-problem .btn.primary') }));
      ok('computer: an MPEG-TS its web view cannot play, with no converter: said, «Open in another player» offered', fm.text.includes(T.format) && fm.other, fm);
      await p.waitForTimeout(250); await shot(p, 'format-pc');
      await p.click('.kt-problem .btn.primary'); await p.waitForSelector('.ext-chooser', { timeout: 10000 }).catch(() => undefined);
      ok('…«Open in another player» opens the hand-over\'s chooser', !!(await p.$('.ext-chooser')));
    }
    await p.close();
  }
  await br.close(); web.close(); fs.rmSync(MEDIA, { recursive: true, force: true });
  ok('no page errors', !errors.length, errors);
  console.log(fails ? `${fails} FAILED` : 'all ok'); process.exit(fails ? 1 : 0);
});
