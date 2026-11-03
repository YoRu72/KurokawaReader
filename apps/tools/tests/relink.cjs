// A download whose signed link ran out (HTTP 403 — itch.io, cloud storage), the Android plugin faked: its page says
// why and offers a new link — from the page it came from, opened in the app's browser (the next download started
// there given to it, with the site's headers, instead of a new download), or pasted.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port; const lang = process.argv[2] || 'en';
  const br = await chromium.launch(); const errors = [];
  const check = (what, ok) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) errors.push(what); };
  const p = await br.newPage({ viewport: { width: 400, height: 860 } }); p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript((lang) => {
    localStorage.setItem('kr.lang', lang); window.__calls = []; const listeners = {}; window.__emit = (ev, d) => (listeners[ev] || []).forEach((f) => f(d));
    const task = { id: 't9', kind: 'http', name: 'Game-0.apk', source: { url: 'https://mirror.example/Game-0.bin?sig=old', headers: { Referer: 'https://maker.itch.io/game' } }, dir: '/sdcard/Download/Kurokawa', state: 'failed', error: 'HTTP 403', done: 144e6, total: 1.7e9, downSpeed: 0, upSpeed: 0, files: [], addedAt: Date.now() - 60e3, engine: 'native' };
    const api = {
      addListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); return Promise.resolve({ remove() {} }); }, list: async () => ({ tasks: [task] }), get: async () => ({ task }),
      browse: async (o) => { window.__calls.push(['browse', o.url, o.replay]); }, setUrl: async (o) => { window.__calls.push(['setUrl', o.id, o.url, o.headers]); },
    };
    const plugin = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
  }, lang);
  await p.goto(`http://127.0.0.1:${port}/#/task/t9`); await p.waitForSelector('.expired-acts [data-act="relink"]');
  check('the refused link explained', /signed links|الروابط الموقَّعة/.test(await p.textContent('.plan-note.bad')));
  await p.click('.expired-acts [data-act="relink"]'); await p.waitForTimeout(300);
  let c = await p.evaluate(() => window.__calls); check('the page it came from opened in the app\'s browser', c.some((x) => x[0] === 'browse' && x[1] === 'https://maker.itch.io/game'));
  await p.evaluate(() => window.__emit('browser', { kind: 'download', url: 'https://mirror.example/Game-0.bin?sig=new', referer: 'https://maker.itch.io/game', cookie: 'a=1', ua: 'UA', name: 'Game-0.apk' }));
  await p.waitForTimeout(600);
  c = await p.evaluate(() => window.__calls); const s = c.find((x) => x[0] === 'setUrl');
  check('the next download there given to it, with the site\'s headers', s && s[1] === 't9' && /sig=new/.test(s[2]) && s[3]?.Cookie === 'a=1' && s[3]?.Referer === 'https://maker.itch.io/game');
  check('no new download sheet for it', !(await p.$('.sheet textarea')));
  await p.evaluate(() => window.__emit('browser', { kind: 'download', url: 'https://other.example/x.zip' })); await p.waitForTimeout(600);
  check('the one after makes a new download as before', (await p.evaluate(() => window.__calls.filter((x) => x[0] === 'setUrl').length)) === 1 && !!(await p.$('.sheet')));
  await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim').forEach((e) => e.remove()));
  await p.click('.expired-acts [data-act="paste"]'); await p.waitForSelector('.sheet input[type=url]');
  await p.fill('.sheet input[type=url]', 'https://mirror.example/Game-0.bin?sig=pasted'); await p.click('.sheet .btn.primary'); await p.waitForTimeout(300);
  check('or a link pasted', (await p.evaluate(() => window.__calls.filter((x) => x[0] === 'setUrl').pop()))[2].endsWith('sig=pasted'));
  // The way kept from the browser, then replayed by itself (the switch on its page, off by default).
  await p.evaluate(() => { window.__calls = []; document.querySelectorAll('.sheet, .sheet-scrim').forEach((e) => e.remove()); localStorage.setItem('kt.trails', JSON.stringify({ 'https://mirror.example/Game-0.bin': [{ url: 'https://maker.itch.io/game', start: true }, { url: 'https://maker.itch.io/game', text: 'Download Now', tag: 'a', href: '', id: '', n: 0 }] })); });
  await p.goto(`http://127.0.0.1:${port}/#/`); await p.goto(`http://127.0.0.1:${port}/#/task/t9`); await p.waitForSelector('[data-act="auto-relink"]');
  check('«Get a new link by itself» off by default', !(await p.$eval('[data-act="auto-relink"]', (e) => e.checked)) && !(await p.$eval('[data-act="auto-relink"]', (e) => e.disabled)));
  await p.check('[data-act="auto-relink"]'); await p.waitForTimeout(400);
  c = await p.evaluate(() => window.__calls); const rp = c.find((x) => x[0] === 'browse' && x[2]);
  check('turned on: the way replayed in the browser for this download', rp && rp[2].id === 't9' && rp[2].trail.length === 2 && rp[1] === 'https://maker.itch.io/game');
  await p.evaluate(() => window.__emit('browser', { kind: 'relink', id: 't9', ok: true, url: 'https://mirror.example/Game-0.bin?sig=replayed', referer: 'https://maker.itch.io/game/download/K1', ua: 'UA' })); await p.waitForTimeout(500);
  const su = (await p.evaluate(() => window.__calls)).filter((x) => x[0] === 'setUrl').pop();
  check('the replay\'s link given to the download', su && su[1] === 't9' && /sig=replayed/.test(su[2]) && su[3]?.Referer === 'https://maker.itch.io/game/download/K1');
  check('the manual button replays the way too', await (async () => { await p.evaluate(() => { window.__calls = []; }); await p.click('.expired-acts [data-act="relink"]'); await p.waitForTimeout(300); return (await p.evaluate(() => window.__calls)).some((x) => x[0] === 'browse' && x[2]); })());
  check('no page errors', !errors.length);
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
