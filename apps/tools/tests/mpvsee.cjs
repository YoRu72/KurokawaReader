// (from packs.cjs): installing the Video add-on asks for Python and ffmpeg (sizes from
// the release's packs file), downloads them with progress, then installs the add-on; Play asks how to watch, and
// «another app» hands the finished file to the phone's chooser, remembered when asked to.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const REPO = path.join(__dirname, '..', '..', '..', 'repo');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
// What a phone shows while mpv plays: mpv draws its picture beneath the page, so every pixel the page paints over the
// picture hides it. The player is opened on mpv (stubbed) with an Erai-raws-like MKV, the page rendered on a see-through
// background, and the share of the picture area left clear is measured (the black picture with sound was 0%).
// (Below: the stub of tests/mpvplayer.cjs.) The player on mpv (src/player/mpv.ts) on a stubbed phone: the mpv engine chosen when its pack is there, the file
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
    const task = { id: 't1', kind: 'http', name: '[Erai-raws] Chii Fuyo - 04 [1080p CR WEBRip HEVC AAC][MultiSub].mkv', source: { url: 'https://x/f.mkv' }, dir: '/sdcard/Download', state: 'done', done: 100, total: 100, downSpeed: 0, upSpeed: 0, files: [{ index: 0, path: '[Erai-raws] Chii Fuyo - 04 [1080p CR WEBRip HEVC AAC][MultiSub].mkv', size: 100, done: 100, priority: 1 }], addedAt: Date.now(), engine: 'native' };
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
  await p.waitForSelector('.get-card'); await p.click('.get-card .btn.primary');
  await p.waitForSelector('.kt-mpv-video', { state: 'attached', timeout: 15000 });
  for (const [prop, value] of [['duration', 23.9 * 60], ['video-params/w', 1920], ['video-params/h', 1080], ['pause', false], ['time-pos', 12]]) await p.evaluate(([a, b]) => window.__emit('mpv', { prop: a, value: b }), [prop, value]);
  await p.evaluate(() => window.__emit('mpv', { event: 'loaded' }));
  const cdp = await p.context().newCDPSession(p); await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  const measure = async (name, limit = 16) => {
    const png = await p.screenshot({ omitBackground: true, path: process.env.SHOTS ? `${process.env.SHOTS}/mpvsee-${name}.png` : undefined });
    // The middle of the picture (the bars at top and bottom left out): the share of pixels with nothing painted on them.
    return await p.evaluate(async ([b64, lim]) => { const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode(); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); const y0 = Math.round(img.height * 0.3), y1 = Math.round(img.height * 0.7); const d = g.getImageData(0, y0, img.width, y1 - y0).data; let clear = 0; for (let i = 3; i < d.length; i += 4) if (d[i] < lim) clear++; return clear / (d.length / 4); }, [png.toString('base64'), limit]);
  };
  await p.waitForTimeout(600); const withControls = await measure('controls', 200); console.log('seen through the controls\' shade:', (withControls * 100).toFixed(1) + '%');
  await p.waitForTimeout(4500); const without = await measure('playing'); console.log('clear while playing:', (without * 100).toFixed(1) + '%');
  check('mpv\'s picture shows through the page while it plays', without > 0.97);
  check('and mostly with the controls shown', withControls > 0.6);
  console.log(errors.length ? 'errors ' + JSON.stringify(errors) : 'all passed'); await br.close(); web.close(); process.exit(errors.length ? 1 : 0);
})();
