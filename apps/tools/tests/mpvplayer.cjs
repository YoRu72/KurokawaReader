// (from packs.cjs): installing the Video add-on asks for Python and ffmpeg (sizes from
// the release's packs file), downloads them with progress, then installs the add-on; Play asks how to watch, and
// «another app» hands the finished file to the phone's chooser, remembered when asked to.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const REPO = path.join(__dirname, '..', '..', '..', 'repo');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
// The player on mpv (src/player/mpv.ts) on a stubbed phone: the mpv engine chosen when its pack is there, the file
// opened in mpv (its path, the preferred subtitle languages), the player's time and state following mpv's
// properties, play/pause/seek/speed turned into mpv's properties and commands, its audio tracks from mpv's list
// in the sound menu, the file's own subtitles in the subtitles menu (chosen by sid), the page see-through while
// it plays and opaque again after.
(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port;
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 860, height: 420 } });
  const errors = []; p.on('pageerror', (e) => { errors.push(e.message); console.log('STACK', e.stack.split('\n').slice(0, 4).join(' | ')); });
  const check = (w, ok) => { console.log(ok ? 'ok  ' : 'FAIL', w); if (!ok) errors.push(w); };
  await p.route(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/main\/repo\/(.*)/, (r) => { const f = path.join(REPO, r.request().url().split('/main/repo/')[1].split('?')[0]); if (!fs.existsSync(f)) return r.fulfill({ status: 404, body: '' }); r.fulfill({ body: fs.readFileSync(f), contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' } }); });
  await p.addInitScript(() => {
    const listeners = {}; window.__emit = (ev, d) => (listeners[ev] || []).forEach((f) => f(d)); window.__calls = [];
    const task = { id: 't1', kind: 'http', name: 'Film.mkv', source: { url: 'https://x/f.mkv' }, dir: '/sdcard/Download', state: 'done', done: 100, total: 100, downSpeed: 0, upSpeed: 0, files: [{ index: 0, path: 'Film.mkv', size: 100, done: 100, priority: 1 }], addedAt: Date.now(), engine: 'native' };
    const plugin = new Proxy({
      addListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); return { remove: () => undefined }; },
      list: async () => ({ tasks: [task] }), defaultDir: async () => ({ dir: '/sdcard/Download' }),
      packStatus: async () => ({ python: { version: null, size: 0 }, ffmpeg: { version: '1', size: 1 }, mpv: { version: 'm1', size: 1 }, abi: 'arm64-v8a' }),
      mpvAvailable: async () => ({ available: true }),
      mpvOpen: async (o) => { window.__calls.push(['open', o.url, o.options]); },
      mpvSet: async (o) => { window.__calls.push(['set', o.name, o.value]); }, mpvCommand: async (o) => { window.__calls.push(['cmd', ...o.args]); }, mpvClose: async () => { window.__calls.push(['close']); },
      localUrl: async (o) => ({ url: 'http://127.0.0.1:9/file?p=' + encodeURIComponent(o.path) }), streamUrl: async () => ({ url: 'http://127.0.0.1:9/t1/0' }),
      openWith: async (o) => { window.__calls.push(['openWith', o.path || o.url]); },
    }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
    if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1'); const st = JSON.parse(localStorage.getItem('kt.settings') || '{}'); st.playerWith = 'app'; st.subLangs = ['ar', 'en']; localStorage.setItem('kt.settings', JSON.stringify(st));
  });
  await p.goto(`http://127.0.0.1:${port}/#/`); await p.waitForSelector('.task-card'); await p.click('.task-card button[aria-label="Play"]');
  await p.waitForSelector('.get-card'); await p.click('.get-card .btn.primary');   // (the Player add-on fetched, as the first time)
  await p.waitForSelector('.kt-mpv-video', { state: 'attached', timeout: 15000 });
  const calls = () => p.evaluate(() => window.__calls);
  let c = await calls(); const open = c.find((x) => x[0] === 'open'); console.log('open:', JSON.stringify(open));
  check('opened in mpv, by its path', open && /Film\.mkv$/.test(open[1]));
  check('the preferred subtitle languages handed to mpv', open && /ar,ara,en,eng/.test(open[2].slang));
  check('the page see-through while it plays', await p.evaluate(() => document.documentElement.classList.contains('kt-mpv-on')));
  // mpv says: loaded, 2 audio tracks, 2 subtitle tracks, 90 s long, playing at 12 s.
  await p.evaluate(() => { const e = window.__emit; e('mpv', { prop: 'duration', value: 90 }); e('mpv', { event: 'loaded' });
    e('mpv', { prop: 'track-list', value: JSON.stringify([{ id: 1, type: 'video', codec: 'hevc', selected: true }, { id: 1, type: 'audio', lang: 'jpn', codec: 'eac3', title: 'Japanese', selected: true }, { id: 2, type: 'audio', lang: 'eng', codec: 'dts', title: 'English' }, { id: 1, type: 'sub', lang: 'ara', codec: 'ass', title: 'Arabic', selected: true }, { id: 2, type: 'sub', lang: 'eng', codec: 'subrip', title: 'English' }]) });
    e('mpv', { prop: 'pause', value: false }); e('mpv', { prop: 'time-pos', value: 12 }); });
  await p.waitForTimeout(400);
  check('the player shows mpv\'s time', /0?:12/.test(await p.textContent('.kt-time')));
  await p.click('.kt-play'); await p.waitForTimeout(150); c = await calls();
  check('pause → mpv pause=yes', c.some((x) => x[0] === 'set' && x[1] === 'pause' && x[2] === 'yes'));
  await p.keyboard.press('ArrowRight'); await p.waitForTimeout(150); c = await calls(); const seek = c.filter((x) => x[0] === 'cmd' && x[1] === 'seek').pop(); console.log('seek:', JSON.stringify(seek));
  check('a seek → mpv seek absolute', seek && Number(seek[2]) > 12 && seek[3] === 'absolute');
  await p.click('.kt-top button[aria-label="Sound"], .kt-top [aria-label*="ound"]').catch(() => undefined);
  await p.evaluate(() => { const b = [...document.querySelectorAll('.kt-top button')].find((x) => /sound|audio/i.test(x.getAttribute('aria-label') || '')); b && b.click(); });
  await p.waitForSelector('.sheet input[name="kt-at"]', { timeout: 4000 }).catch(() => undefined);
  const audio = await p.$$eval('.sheet input[name="kt-at"]', (e) => e.length); check('the two audio tracks in the sound menu', audio === 2);
  if (audio === 2) { await p.click('.sheet input[name="kt-at"] >> nth=1'); await p.waitForTimeout(100); c = await calls(); check('chosen → mpv aid', c.some((x) => x[0] === 'set' && x[1] === 'aid' && x[2] === '2')); }
  await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim').forEach((x) => x.remove()));
  await p.evaluate(() => { const b = [...document.querySelectorAll('.kt-top button')].find((x) => /subtitle/i.test(x.getAttribute('aria-label') || '')); b && b.click(); });
  await p.waitForSelector('.sheet .dest-row', { timeout: 4000 });
  const subs = await p.$$eval('.sheet .dest-row', (e) => e.map((x) => x.innerText.replace(/\s+/g, ' ').trim())); console.log('subtitles:', JSON.stringify(subs));
  check('the file\'s own subtitles listed', subs.some((x) => /Arabic/.test(x)) && subs.some((x) => /English/.test(x)));
  await p.locator('.sheet .dest-row', { hasText: 'English' }).first().locator('input').check(); await p.waitForTimeout(200); c = await calls();
  check('one chosen → mpv sid', c.some((x) => x[0] === 'set' && x[1] === 'sid' && x[2] === '2'));
  await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim').forEach((x) => x.remove()));
  await p.keyboard.press('Escape'); await p.waitForTimeout(300); c = await calls();
  check('closed: mpv let go, the page opaque again', c.some((x) => x[0] === 'close') && !(await p.evaluate(() => document.documentElement.classList.contains('kt-mpv-on'))));
  check('no page errors', errors.length === 0 || (console.log(errors), false));
  await br.close(); web.close(); if (errors.length) process.exit(1); console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
