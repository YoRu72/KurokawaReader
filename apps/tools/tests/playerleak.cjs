// The app's own player let go of everything when it closes (made-up loopback media, the phone's plugin faked): one
// warm-up open/close (the modules the player loads on first use stay, as they should), then four more, each counted
// after the page settled and the garbage was collected through the DevTools protocol — the DOM nodes and the
// listeners must stay at the warm-up's level (a plateau: lazy modules; a steady rise: a leak — the window «resize»
// listener of the tool bar once held every closed player), and nothing may be left on window or document.
// Run: NODE_PATH=$(npm root -g) node tests/playerleak.cjs
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const { execFileSync } = require('node:child_process');
const DIST = path.join(__dirname, '..', 'dist');
const MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-leak-'));
try { execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-t', '20', '-c:v', 'libvpx', '-b:v', '200k', path.join(MEDIA, 'clip.webm')]); }
catch { if (process.env.KT_REQUIRE_FFMPEG) { console.log('FAIL ffmpeg is required here (KT_REQUIRE_FFMPEG)'); process.exit(1); } console.log('ffmpeg not available — skipped'); process.exit(0); }
fs.writeFileSync(path.join(MEDIA, 'clip.srt'), '1\n00:00:00,500 --> 00:00:09,000\nA made-up line\n');
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 600))); if (!c) fails++; };
setTimeout(() => { console.log('FAIL timed out'); process.exit(1); }, 240000).unref();
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webm': 'video/webm', '.srt': 'text/plain' };
const web = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = p.startsWith('/media/') ? path.join(MEDIA, p.slice(7)) : path.join(DIST, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  const size = fs.statSync(f).size; const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || ''); const type = MIME[path.extname(f)] || 'application/octet-stream';
  if (range) { const a = Number(range[1]), b = range[2] ? Number(range[2]) : size - 1; res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${a}-${b}/${size}`, 'accept-ranges': 'bytes', 'content-length': b - a + 1, 'access-control-allow-origin': '*' }); fs.createReadStream(f, { start: a, end: b }).pipe(res); return; }
  res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size, 'access-control-allow-origin': '*' }); fs.createReadStream(f).pipe(res);
}).listen(0, '127.0.0.1', async () => {
  const port = web.address().port;
  const br = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const p = await br.newPage({ viewport: { width: 1000, height: 600 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript((port) => {
    localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['player'], playerWith: 'app' }));
    const task = { id: 'v', kind: 'http', name: 'clip.webm', source: { url: 'https://x/clip.webm' }, dir: '/sdcard/Download', state: 'done', done: 1, total: 1, downSpeed: 0, upSpeed: 0, files: [{ index: 0, path: 'clip.webm', size: 1, done: 1, priority: 1 }], addedAt: Date.now() - 60e3, doneAt: Date.now(), engine: 'native' };
    const api = { addListener: () => Promise.resolve({ remove() {} }), list: async () => ({ tasks: [task] }), localUrl: async (o) => ({ url: `http://127.0.0.1:${port}/media/${o.path.split('/').pop()}` }), siblings: async () => ({ paths: ['/sdcard/Download/clip.srt'] }), packStatus: async () => ({ python: { version: null, size: 0 }, ffmpeg: { version: null, size: 1 }, mpv: { version: null, size: 0 } }) };
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) }) }, PluginHeaders: [] };
  }, port);
  const cdp = await p.context().newCDPSession(p); await cdp.send('Performance.enable');
  const count = async () => { await p.waitForTimeout(6000); await cdp.send('HeapProfiler.collectGarbage'); await cdp.send('HeapProfiler.collectGarbage'); const m = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value])); return { nodes: m.Nodes, listeners: m.JSEventListeners }; };
  const on = async (expr) => { const { result } = await cdp.send('Runtime.evaluate', { expression: expr }); const r = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId }); const c = {}; for (const l of r.listeners) c[l.type] = (c[l.type] || 0) + 1; return c; };
  const cycle = async () => {
    await p.click('.task-card button[aria-label="Play"]');
    await p.waitForFunction(() => { const v = document.querySelector('.kt-video'); return v && v.currentTime > 0.6; }, null, { timeout: 30000 });
    await p.waitForTimeout(800); await p.click('.kt-top button[data-icon="back"]'); await p.waitForFunction(() => !document.querySelector('.kt-player'));
  };
  await p.goto(`http://127.0.0.1:${port}/`); await p.waitForSelector('.task-card');
  await cycle(); const warm = await count(); const w0 = await on('window'), d0 = await on('document');
  const rows = []; for (let i = 0; i < 4; i++) { await cycle(); rows.push(await count()); }
  const w1 = await on('window'), d1 = await on('document');
  const diff = (a, b) => Object.fromEntries(Object.keys({ ...a, ...b }).filter((k) => (a[k] || 0) !== (b[k] || 0)).map((k) => [k, (b[k] || 0) - (a[k] || 0)]));
  console.log('warm-up', JSON.stringify(warm), 'then', JSON.stringify(rows));
  ok('four more open/close cycles: the DOM nodes stay at the warm-up\'s level (no closed player kept)', rows.every((r) => r.nodes <= warm.nodes + 10), rows);
  ok('…the listeners too', rows.every((r) => r.listeners <= warm.listeners + 3), rows);
  ok('nothing added on window or document by a closed player', !Object.keys(diff(w0, w1)).length && !Object.keys(diff(d0, d1)).length, { window: diff(w0, w1), document: diff(d0, d1) });
  ok('no page errors', !errors.length, errors);
  await br.close(); web.close(); fs.rmSync(MEDIA, { recursive: true, force: true });
  console.log(fails ? `${fails} FAILED` : 'all ok'); process.exit(fails ? 1 : 0);
});
