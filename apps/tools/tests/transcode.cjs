// A picture the web view cannot decode, converted as it plays (src/player/transcode.ts, desktop/transcode.cjs): a
// 10-bit H.264 MKV with AC-3 sound (an older anime release) — black in the browser, not one frame drawn —; told
// apart by its probe; given ffmpeg's stream (VP9 here: this test's Chromium has no H.264), which the element plays
// as the file — its time and length the file's, a seek beyond what has come a new stream from there, the player
// seeing one «seeked» and no new «loadedmetadata».
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const { execFileSync } = require('node:child_process');
const esbuild = require('esbuild');
const DIST = path.join(__dirname, '..', 'dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
(async () => {
  try { execFileSync('ffmpeg', ['-version']); } catch { console.log('skipped: no ffmpeg on this machine'); return; }
  const Transcode = require('../desktop/transcode.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ktc-')); const vid = path.join(dir, 'hi10.mkv');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=40', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-c:a', 'ac3', '-b:a', '96k', vid]);
  const js = esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src', 'player', 'transcode.ts')], bundle: true, write: false, format: 'iife', globalName: 'TC', platform: 'browser' }).outputFiles[0].text;
  const asked = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/t') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<video id=v width=320 height=180 muted></video>'); return; }
    if (u.pathname === '/raw') { const b = fs.readFileSync(vid); res.writeHead(200, { 'content-type': 'video/x-matroska', 'content-length': b.length }); res.end(b); return; }
    if (u.pathname === '/video') { asked.push(Number(u.searchParams.get('ss'))); if (/^\/m\//.test(u.searchParams.get('src'))) u.searchParams.set('src', vid); void Transcode.serve(u, req, res); return; }
    { let f = path.join(DIST, decodeURIComponent(u.pathname)); if (f.endsWith('/')) f += 'index.html'; if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); return; }
    res.writeHead(404); res.end();
  }).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`; const errors = [];
  const check = (w, ok) => { console.log(ok ? 'ok  ' : 'FAIL', w); if (!ok) errors.push(w); };
  const br = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const p = await br.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(base + '/t'); await p.addScriptTag({ content: js });

  check('10-bit H.264 is a picture the web view cannot show', await p.evaluate(() => TC.pictureProblem({ codec: 'h264', profile: 'High 10', pixFmt: 'yuv420p10le' }) === 'H264 10-bit'));
  check('XviD too; VP9 in 8 bits is shown as it is', await p.evaluate(() => !!TC.pictureProblem({ codec: 'mpeg4' }) && TC.pictureProblem({ codec: 'vp9', pixFmt: 'yuv420p' }) === null));

  // The file as it is: playing, no frame drawn (or not opened at all).
  const raw = await p.evaluate(async (b) => { const v = document.getElementById('v'); v.src = b + '/raw'; try { await v.play(); } catch { /* refused */ } await new Promise((r) => setTimeout(r, 3500)); return { black: TC.noPicture(v), err: v.error?.code ?? 0, w: v.videoWidth }; }, base);
  console.log('as it is:', JSON.stringify(raw));
  check('as it is: no picture (black, or refused)', raw.black || raw.err === 4 || raw.w === 0);

  // Converted.
  await p.evaluate((b) => {
    const v = document.getElementById('v'); v.pause(); v.removeAttribute('src'); v.load();
  }, base);
  await p.waitForTimeout(300);
  await p.evaluate(([b, file]) => {
    const v = document.getElementById('v'); window.seen = { loadedmetadata: 0, seeked: 0, pause: 0 };
    for (const k of Object.keys(window.seen)) v.addEventListener(k, () => window.seen[k]++);
    window.cv = new TC.Converted(v, b + '/video', file, 0, 40); window.cv.start(3, true);
  }, [base, vid]);
  await p.waitForFunction(() => document.getElementById('v').currentTime > 5, null, { timeout: 20000 }).catch(() => {});
  let st = await p.evaluate(() => { const v = document.getElementById('v'); const q = v.getVideoPlaybackQuality(); return { t: v.currentTime, d: v.duration, w: v.videoWidth, frames: q.totalVideoFrames, paused: v.paused, src: v.currentSrc, seen: window.seen }; });
  console.log('converted:', JSON.stringify(st), 'asked', asked.join(','));
  check('converted: it plays, with a picture', !st.paused && st.w === 320 && st.frames > 10);
  check('started where asked (3 s), its time the file\'s', asked[0] === 3 && st.t > 5 && st.t < 12);
  check('its length the file\'s, its source the file', st.d === 40 && st.src === vid);
  check('the start hidden from the player (no loadedmetadata, no pause)', st.seen.loadedmetadata === 0 && st.seen.pause === 0);

  // A seek beyond what has come: a new stream from there, one «seeked».
  await p.evaluate(() => { document.getElementById('v').currentTime = 30; });
  await p.waitForFunction(() => document.getElementById('v').currentTime > 31, null, { timeout: 20000 }).catch(() => {});
  st = await p.evaluate(() => { const v = document.getElementById('v'); return { t: v.currentTime, paused: v.paused, seen: window.seen, buf: v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0 }; });
  console.log('after a seek to 30:', JSON.stringify(st), 'asked', asked.join(','));
  check('a seek beyond: asked again from there', asked.length === 2 && Math.abs(asked[1] - 30) < 0.01);
  check('…and playing on from 30 s, as the file', !st.paused && st.t > 31 && st.t < 38 && st.buf > 30);
  check('one «seeked», still no new loadedmetadata', st.seen.seeked === 1 && st.seen.loadedmetadata === 0);

  // A seek back within what has come: no new stream.
  await p.evaluate(() => { const v = document.getElementById('v'); v.currentTime = v.buffered.start(0) + 0.5; }); await p.waitForTimeout(800);
  check('a seek within what has come: no new stream', asked.length === 2);

  // Paused, another sound track: the stream again, from here, still paused.
  await p.evaluate(() => document.getElementById('v').pause()); await p.waitForTimeout(300);
  await p.evaluate(() => window.cv.setTrack(0)); await p.waitForTimeout(2500);
  st = await p.evaluate(() => ({ paused: document.getElementById('v').paused, t: document.getElementById('v').currentTime }));
  check('another track while paused: from here, still paused', asked.length === 3 && st.paused && st.t > 30);

  await p.evaluate(() => window.cv.stop()); check('let go: the element its own again', await p.evaluate(() => !Object.prototype.hasOwnProperty.call(document.getElementById('v'), 'currentTime')));

  // The whole player, on a computer: a finished 10-bit MKV played from Downloads — ffprobe says what it is, and the
  // player turns to the converted picture by itself.
  {
    const probeJson = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', vid]).toString();
    const q = await br.newPage({ viewport: { width: 900, height: 520 } }); q.on('pageerror', (e) => errors.push(e.message));
    await q.addInitScript(([b, pj]) => {
      localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['player'], playerWith: 'app' }));
      const task = { id: 'v', kind: 'torrent', name: 'Show - 01 [BD 1080p Hi10].mkv', source: { url: 'magnet:?xt=urn:btih:x' }, dir: '/m', state: 'done', done: 1, total: 1, downSpeed: 0, upSpeed: 0, files: [{ index: 0, path: 'hi10.mkv', size: 1, done: 1, priority: 1 }], addedAt: Date.now() - 60e3, doneAt: Date.now() - 30e3 };
      const api = { platform: 'desktop', available: true, os: 'linux', ready: async () => ({}), list: async () => [task], on: () => () => {}, onTasks: (cb) => { setTimeout(() => cb([task]), 50); return () => {}; }, freeSpace: async () => 5e11,
        fileUrl: async () => `${b}/raw`, siblings: async () => [], ffprobe: async () => JSON.parse(pj), videoUrl: async () => ({ url: `${b}/video` }), audioUrl: async () => ({ url: `${b}/none` }), ffmpegAvailable: async () => ({ ok: true }) };
      window.kurokawaTools = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : undefined) });
    }, [base, probeJson]);
    asked.length = 0;
    await q.goto(`${base}/#/downloads`); await q.waitForSelector('.task-card');
    await q.click('.task-card button[aria-label="Play"]'); await q.waitForSelector('.kt-player video.kt-video');
    await q.waitForFunction(() => { const v = document.querySelector('.kt-player video'); return v && v.getVideoPlaybackQuality().totalVideoFrames > 5 && v.currentTime > 1; }, null, { timeout: 25000 }).catch(() => {});
    const r = await q.evaluate(() => { const v = document.querySelector('.kt-player video'); return { frames: v.getVideoPlaybackQuality().totalVideoFrames, w: v.videoWidth, t: v.currentTime, d: v.duration, end: document.querySelector('.kt-time-end, .kt-dur')?.textContent ?? '', flash: document.querySelector('.kt-flash')?.textContent ?? '' }; });
    console.log('in the player:', JSON.stringify(r), 'asked', asked.join(','));
    check('the player converts the 10-bit MKV by itself, and it shows', asked.length >= 1 && r.frames > 5 && r.w === 320);
    check('the file\'s length on the bar', Math.round(r.d) === 40);
    await q.close();
  }
  check('no page errors', errors.filter((e) => !/play\(\)/.test(e)).length === 0 || (console.log(errors), false));
  await br.close(); srv.close(); fs.rmSync(dir, { recursive: true, force: true });
  if (errors.length) process.exit(1); console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
