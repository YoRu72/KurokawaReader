// When a download finishes: the chosen sound plays and the «Download complete» card shows the file, its time and
// average speed, with Open and Folder; a failure plays its own sound.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const lang = process.argv[2] || 'en'; const asked = [];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg' };
const web = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); asked.push(p); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }).listen(0, async () => {
  const br = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const p = await br.newPage({ viewport: { width: 420, height: 860 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript((lang) => {
    localStorage.setItem('kr.lang', lang); const listeners = {}; window.__emit = (ts) => (listeners.tasksChanged || []).forEach((f) => f({ tasks: ts }));
    const now = Date.now(); window.__mk = (state, extra = {}) => ({ id: 'a', kind: 'http', name: 'Episode 05.mkv', source: { url: 'https://x/e.mkv' }, dir: '/sdcard/Download', state, done: state === 'done' ? 7e8 : 3e8, total: 7e8, downSpeed: 0, upSpeed: 0, files: [], addedAt: now - 300e3, doneAt: state === 'done' ? now : undefined, engine: 'native', ...extra });
    const plugin = new Proxy({ addListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); return { remove() {} }; }, list: async () => ({ tasks: [window.__mk('downloading')] }) }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
  }, lang);
  await p.goto(`http://127.0.0.1:${web.address().port}/`); await p.waitForSelector('.task-card'); await p.waitForTimeout(800);
  await p.evaluate(() => window.__emit([window.__mk('downloading'), { ...window.__mk('downloading'), id: 'b', name: 'b.zip' }]));
  await p.waitForTimeout(400); await p.evaluate(() => window.__emit([window.__mk('done'), { ...window.__mk('downloading'), id: 'b', name: 'b.zip' }]));
  await p.waitForSelector('.done-card'); const card = (await p.$eval('.done-card', (e) => e.innerText)).replace(/\s+/g, ' '); console.log('card:', card);
  await p.screenshot({ path: path.join(__dirname, `shot-done-${lang}.png`) });
  await p.evaluate(() => window.__emit([window.__mk('done'), { ...window.__mk('failed'), id: 'b', name: 'b.zip' }])); await p.waitForTimeout(1600);
  const sounds = asked.filter((a) => a.startsWith('/sounds/')); console.log('sounds:', sounds.join(' '));
  const pass = /Episode 05\.mkv/.test(card) && /(5:00|٥:٠٠)/.test(card) && sounds.includes('/sounds/complete.ogg') && sounds.includes('/sounds/failed.ogg') && sounds.includes('/sounds/queue.ogg');
  console.log(errors.length ? 'errors ' + JSON.stringify(errors) : pass ? 'all passed' : 'FAILED');
  await br.close(); web.close(); process.exit(errors.length || !pass ? 1 : 0);
});
