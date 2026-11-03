// Sound the player cannot decode, played beside the video (src/player/compat.ts): a video whose sound is AC-3 (which
// the browser cannot play), its sound served converted from where the video is — here as MP3, which this test's
// browser plays —; the sound starts with the video, keeps in step while it plays, follows a seek, pauses with it.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const { execFileSync, spawn } = require('node:child_process');
const esbuild = require('esbuild');
(async () => {
  try { execFileSync('ffmpeg', ['-version']); } catch { console.log('skipped: no ffmpeg on this machine'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksb-')); const vid = path.join(dir, 'v.mkv');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=25:duration=40', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-b:v', '200k', '-c:a', 'ac3', '-b:a', '96k', vid]);
  const js = esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src', 'player', 'compat.ts')], bundle: true, write: false, format: 'iife', globalName: 'Compat', platform: 'browser', external: [] }).outputFiles[0].text;
  const asked = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<video id=v width=160 height=120 muted></video>'); return; }
    if (u.pathname === '/v') { const size = fs.statSync(vid).size; const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || ''); const a = m ? +m[1] : 0, b = m && m[2] ? +m[2] : size - 1; res.writeHead(m ? 206 : 200, { 'content-type': 'video/webm', 'accept-ranges': 'bytes', 'content-length': b - a + 1, ...(m ? { 'content-range': `bytes ${a}-${b}/${size}` } : {}) }); fs.createReadStream(vid, { start: a, end: b }).pipe(res); return; }
    if (u.pathname === '/audio') { asked.push(Number(u.searchParams.get('ss'))); res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' }); const p = spawn('ffmpeg', ['-v', 'error', '-ss', u.searchParams.get('ss'), '-i', vid, '-map', `0:a:${u.searchParams.get('a')}`, '-c:a', 'libmp3lame', '-b:a', '96k', '-f', 'mp3', 'pipe:1']); p.stdout.pipe(res); req.on('close', () => p.kill('SIGKILL')); return; }
    res.writeHead(404); res.end();
  }).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`; const errors = [];
  const check = (w, ok) => { console.log(ok ? 'ok  ' : 'FAIL', w); if (!ok) errors.push(w); };
  const br = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const p = await br.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(base + '/'); await p.addScriptTag({ content: js });
  await p.evaluate((b) => { const v = document.getElementById('v'); v.src = b + '/v'; window.sb = new Compat.SoundBeside(v, b + '/v', 0, b + '/audio'); return v.play(); }, base);
  await p.waitForTimeout(4000);
  let st = await p.evaluate(() => { const v = document.getElementById('v'); return { v: v.currentTime, a: window.sb.base + window.sb.el.currentTime, playing: !window.sb.el.paused, muted: v.muted }; });
  console.log('playing:', JSON.stringify(st));
  check('the sound plays with the video, the video muted', st.playing && st.muted && st.a > 1);
  check('in step (within 0.3 s)', Math.abs(st.v - st.a) < 0.3);
  await p.evaluate(() => { document.getElementById('v').currentTime = 20; }); await p.waitForTimeout(3500);
  st = await p.evaluate(() => { const v = document.getElementById('v'); return { v: v.currentTime, a: window.sb.base + window.sb.el.currentTime }; });
  console.log('after a seek to 20 s:', JSON.stringify(st), 'asked from', asked.join(', '));
  check('a seek: the sound asked again from there', asked.some((x) => x >= 19.5 && x <= 21));
  check('in step after the seek', Math.abs(st.v - st.a) < 0.35 && st.v > 21);
  await p.evaluate(() => document.getElementById('v').pause()); await p.waitForTimeout(400);
  check('paused with the video', await p.evaluate(() => window.sb.el.paused));
  await p.evaluate(() => { window.sb.stop(); }); check('let go: the video unmuted', await p.evaluate(() => !document.getElementById('v').muted));
  check('no page errors', errors.length === 0 || (console.log(errors), false));
  await br.close(); srv.close(); fs.rmSync(dir, { recursive: true, force: true });
  if (errors.length) process.exit(1); console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
