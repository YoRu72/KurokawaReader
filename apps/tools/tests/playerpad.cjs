// The player's floating pieces: REX Player's frame pad switched on from the bar (a frame on, A and B set, the pad off
// again), a sheet closed by a tap outside it — over the player too —, the floating window asked of Android with the
// video's shape, and armed when it plays.
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
  const check = (what, ok, x) => { console.log(ok ? 'ok  ' : 'FAIL', what, ok || x === undefined ? '' : JSON.stringify(x)); if (!ok) errors.push(what); };
  await p.addInitScript((port) => {
    localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['player'], playerWith: 'app' }));
    const task = { id: 'v', kind: 'http', name: 'clip.webm', source: { url: 'https://x/clip.webm' }, dir: '/sdcard/Download', state: 'done', done: 1, total: 1, downSpeed: 0, upSpeed: 0, files: [{ index: 0, path: 'clip.webm', size: 1, done: 1, priority: 1 }], addedAt: Date.now() - 60e3, doneAt: Date.now(), engine: 'native' };
    const api = {
      addListener: () => Promise.resolve({ remove() {} }), list: async () => ({ tasks: [task] }),
      localUrl: async (o) => ({ url: `http://127.0.0.1:${port}/media/${o.path.split('/').pop()}` }), siblings: async () => ({ paths: ['/sdcard/Download/clip.srt'] }),
      orientation: async (o) => { (window.__orient = window.__orient || []).push(o.to); }, pip: async (o) => { window.__pip = o; return { ok: true }; }, pipAuto: async (o) => { window.__pipAuto = o; },
      httpRequest: async (o) => { const r = await fetch(o.url, { method: o.method || 'GET', headers: o.headers, body: o.body }); return { status: r.status, headers: {}, body: await r.text() }; },
    };
    const plugin = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
  }, port);
  await p.goto(`http://127.0.0.1:${port}/`); await p.waitForSelector('.task-card');
  await p.click('.task-card button[aria-label="Play"]'); await p.waitForSelector('.kt-player video.kt-video');
  await p.waitForFunction(() => document.querySelector('.kt-video').currentTime > 0.3, null, { timeout: 15000 });
  check('the floating window is armed while playing', await p.waitForFunction(() => window.__pipAuto && window.__pipAuto.on === true, null, { timeout: 4000 }).then(() => true, () => false));
  await p.evaluate(() => document.querySelector('.kt-player').dispatchEvent(new PointerEvent('pointermove', { bubbles: true })));
  await p.click('.kt-player button[aria-label="Frame navigation"], .kt-player button[title="Frame navigation"]').catch(async () => { await p.evaluate(() => [...document.querySelectorAll('.kt-player button')].find((b) => /Frame/.test(b.getAttribute('aria-label') || b.title || ''))?.click()); });
  await p.waitForSelector('.kt-framepad', { timeout: 4000 }).catch(() => undefined);
  check('the frames tool puts the pad on the video', !!(await p.$('.kt-framepad')) && !(await p.$('.sheet')));
  const t0 = await p.evaluate(() => document.querySelector('.kt-video').currentTime);
  await p.click('.kt-framepad button[aria-label="A frame forward"]'); await p.waitForTimeout(400);
  const t1 = await p.evaluate(() => document.querySelector('.kt-video').currentTime);
  check('a frame on', t1 > t0 && t1 - t0 < 0.2);
  await p.click('.kt-framepad button[aria-label="Point A here"]'); await p.click('.kt-framepad button[aria-label="A frame forward"]'); await p.waitForTimeout(300); await p.click('.kt-framepad button[aria-label="Point B here"]'); await p.waitForTimeout(200);
  check('A and B set from the pad', await p.evaluate(() => !document.querySelector('.kt-mark.a').hidden && !document.querySelector('.kt-mark.b').hidden));
  await p.click('.kt-framepad .kt-fp-row button[aria-label="Close"]'); await p.waitForTimeout(200);
  check('the pad off again', !(await p.$('.kt-framepad')));
  await p.click('.kt-top button[aria-label="Subtitles"]'); await p.waitForSelector('.sheet');
  await p.mouse.click(10, 10); await p.waitForTimeout(300);
  check('a tap outside a sheet closes it, over the player too', !(await p.$('.sheet')));
  const pipBtn = await p.evaluate(() => [...document.querySelectorAll('.kt-player button')].some((b) => /Picture in picture|Floating/i.test(b.getAttribute('aria-label') || b.title || '')));
  await p.evaluate(() => [...document.querySelectorAll('.kt-player button')].find((b) => /Picture in picture|Floating/i.test(b.getAttribute('aria-label') || b.title || ''))?.click()); await p.waitForTimeout(200);
  const pip = await p.evaluate(() => window.__pip);
  check('the floating window button is there on Android, asking with the video\'s shape', pipBtn && !!pip && pip.w === 320 && pip.h === 180);
  await p.evaluate(() => window.dispatchEvent(new CustomEvent('ktpip', { detail: true })));
  check('in the floating window the controls hide', await p.evaluate(() => document.querySelector('.kt-player').classList.contains('kt-pip') && document.querySelector('.kt-player').classList.contains('hide-ui')));
  await p.evaluate(() => window.dispatchEvent(new CustomEvent('ktpip', { detail: false })));
  // The big play/pause in the middle; a tap anywhere shows or hides the controls, paused too.
  const ui = () => p.evaluate(() => !document.querySelector('.kt-player').classList.contains('hide-ui'));
  await p.evaluate(() => document.querySelector('.kt-player').dispatchEvent(new PointerEvent('pointermove', { bubbles: true })));
  await p.evaluate(() => { const v = document.querySelector('.kt-video'); if (!v.paused) v.pause(); }); await p.waitForTimeout(250);
  if (!(await ui())) { await p.mouse.click(700, 330); await p.waitForTimeout(450); }
  const big = () => p.evaluate(() => { const b = document.querySelector('.kt-bigplay'); const r = b.getBoundingClientRect(); return { label: b.getAttribute('aria-label'), shown: parseFloat(getComputedStyle(b).opacity) > 0.9 && r.width >= 56, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; });
  let bg = await big(); check('paused: the big button in the middle says Play', bg.label === 'Play' && bg.shown && Math.abs(bg.cx - 450) < 4 && Math.abs(bg.cy - 260) < 4, bg);
  await p.screenshot({ path: process.env.SHOT_CENTRE || '/dev/null' }).catch(() => undefined);
  await p.mouse.click(450, 130); await p.waitForTimeout(450);
  check('paused, a tap on the screen hides the controls (and the big button)', !(await ui()) && !(await big()).shown);
  await p.mouse.click(700, 330); await p.waitForTimeout(450);
  check('a second tap shows them again', await ui());
  await p.waitForTimeout(400); check('paused, they do not hide by themselves', await ui());
  await p.click('.kt-bigplay'); await p.waitForTimeout(300);
  bg = await big(); check('the big button plays, and turns to Pause', !(await p.evaluate(() => document.querySelector('.kt-video').paused)) && bg.label === 'Pause');
  await p.click('.kt-bigplay'); await p.waitForTimeout(300);
  check('and pauses again', await p.evaluate(() => document.querySelector('.kt-video').paused) && (await big()).label === 'Play');
  await p.evaluate(() => [...document.querySelectorAll('.kt-player button')].find((b) => b.getAttribute('aria-label') === 'Lock the controls')?.click()); await p.waitForTimeout(200);
  check('locked: no big button', await p.evaluate(() => getComputedStyle(document.querySelector('.kt-bigplay')).display === 'none'));
  await p.evaluate(() => document.querySelector('.kt-unlock').click()); await p.waitForTimeout(200);
  await p.keyboard.press('a'); await p.waitForTimeout(100);   // (the A/B loop set above let go, or it keeps jumping back to A)
  // The camera: the Save frame pad, and «Make a clip from here» → the clip sheet begun at this frame, the subtitle choice three-way.
  await p.evaluate(() => [...document.querySelectorAll('.kt-tools button')].find((b) => b.getAttribute('aria-label') === 'Screenshot').click());
  await p.waitForSelector('.kt-shotpad', { timeout: 3000 });
  const pad = await p.evaluate(() => { const q = (s) => [...document.querySelectorAll('.kt-shotpad ' + s)]; const nav = q('.kt-fp-nav .kt-fp-btn').map((b) => Math.round(b.getBoundingClientRect().width)); const acts = q('.kt-fp-acts .btn').map((b) => Math.round(b.getBoundingClientRect().width)); return { nav, acts, sw: !!document.querySelector('.kt-shotpad .switch-row input'), seg: q('.kt-fp-segbtn').map((b) => b.textContent), time: document.querySelector('.kt-shotpad .kt-fp-info').textContent }; });
  check('pad: ±1 s and frame steps of equal width, two equal actions, the switch, PNG/JPG, the exact time', pad.nav.length === 4 && new Set(pad.nav).size === 1 && pad.acts.length === 2 && Math.abs(pad.acts[0] - pad.acts[1]) <= 1 && pad.sw && pad.seg.join() === 'PNG,JPG' && /\d:\d\d\.\d{3}/.test(pad.time), pad);
  const tA = await p.evaluate(() => document.querySelector('.kt-video').currentTime);
  await p.click('.kt-shotpad button[aria-label="Forward 1 second"]'); await p.waitForTimeout(300);
  const tB = await p.evaluate(() => document.querySelector('.kt-video').currentTime); check('+1 s from the pad', Math.abs(tB - tA - 1) < 0.15, { tA, tB });
  await p.screenshot({ path: process.env.SHOT_PAD || '/dev/null' }).catch(() => undefined);
  const tClip = await p.evaluate(() => document.querySelector('.kt-video').currentTime);
  await p.locator('.kt-shotpad button', { hasText: 'Make a clip from here' }).click(); await p.waitForSelector('.sheet .cut-subs-row', { timeout: 4000 });
  check('the clip sheet opens with A at this frame', await p.evaluate((t0) => { const v = document.querySelector('.sheet .cut-time').value.split(':').map(Number); const s0 = v.length === 3 ? v[0] * 3600 + v[1] * 60 + v[2] : v[0] * 60 + v[1]; return Math.abs(s0 - t0) < 0.05; }, tClip) && !(await p.$('.kt-shotpad')));
  check('no native checkbox for the subtitles: a pick of three', !(await p.$('.sheet .cut-subs-row input[type=checkbox]')) && !!(await p.$('.sheet .cut-subs-row .pick-btn')));
  await p.click('.sheet .cut-subs-row .pick-btn'); await p.waitForTimeout(250);
  const choices = await p.evaluate(() => [...document.querySelectorAll('label.dest-row')].filter((r) => r.querySelector('input[name=kr-pick]')).map((b) => b.textContent.trim()));
  check('None / Burnt into the picture / Kept as a track', ['None', 'Burnt into the picture', 'Kept as a track'].every((x) => choices.some((c) => c.includes(x))), choices);
  await p.evaluate(() => [...document.querySelectorAll('label.dest-row')].find((r) => r.querySelector('input[name=kr-pick]') && r.textContent.trim() === 'Kept as a track')?.querySelector('input').click()); await p.waitForTimeout(250);
  const hint = await p.evaluate(() => document.querySelector('.sheet .cut-subs-row small').textContent);
  check('kept as a track: MP4 by default, honest that it keeps words and timing only', /MP4 keeps the words and their timing/.test(hint) && await p.evaluate(() => [...document.querySelectorAll('.sheet .row')].some((r) => /Container/.test(r.textContent) && /MP4/.test(r.textContent))), hint);
  await p.evaluate(() => document.querySelector('.sheet .cut-subs-row').scrollIntoView({ block: 'center' })); await p.waitForTimeout(150);
  await p.screenshot({ path: process.env.SHOT_CLIP || '/dev/null' }).catch(() => undefined);
  await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .pick-menu').forEach((x) => x.remove()));
  await p.evaluate(() => [...document.querySelectorAll('.kt-player button')].find((b) => /Frame navigation/.test(b.getAttribute('aria-label') || b.title || ''))?.click()); await p.waitForTimeout(150);
  await p.evaluate(() => [...document.querySelectorAll('.kt-player button')].find((b) => /Screen rotation/i.test(b.getAttribute('aria-label') || b.title || ''))?.click()); await p.waitForTimeout(150);
  await p.keyboard.press('Escape'); await p.evaluate(() => document.querySelector('.kt-player .kt-top button')?.click()); await p.waitForTimeout(400);
  const turns = await p.evaluate(() => window.__orient || []);
  check('the rotation button turns the screen; leaving the player puts it back', turns.includes('landscape') && turns[turns.length - 1] === 'auto' && !(await p.$('.kt-player')), turns);
  check('no page errors', !errors.length);
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
