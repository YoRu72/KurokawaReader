// A download folder Android blocks (Android 11+: a folder of its own at the storage's root), the Android plugin
// faked: the failed download named for it, not «EPERM»; its fix asked from the download's page — «All files
// access» allowed and the download resumed; a folder chosen in Settings that cannot be written offered the same,
// or the app's folder kept; and the app's browser opened from Downloads with no address.
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
    localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.settings', JSON.stringify({ downloadDir: '/storage/emulated/0/A K Tools' }));
    window.__calls = []; let all = false;
    const task = { id: 't1', kind: 'http', name: 'game-0.bin', source: { url: 'https://x/game-0.bin' }, dir: '/storage/emulated/0/A K Tools', state: 'failed', error: 'noFolderAccess', done: 0, total: 1000, downSpeed: 0, upSpeed: 0, files: [], addedAt: Date.now() - 60e3, engine: 'native' };
    const api = {
      addListener: () => Promise.resolve({ remove() {} }), list: async () => ({ tasks: [task] }), get: async () => ({ task }),
      folderAccess: async (o) => { window.__calls.push(['access', !!o.ask]); if (o.ask) setTimeout(() => { all = true; }, 300); return { all, writable: all || !/A K Tools/.test(o.dir || ''), defaultDir: '/storage/emulated/0/Download/Kurokawa' }; },
      resume: async (o) => { window.__calls.push(['resume', o.id]); },
      pickDir: async () => ({ dir: '/storage/emulated/0/Other Root' }),
      browse: async (o) => { window.__calls.push(['browse', o.url]); },
    };
    const plugin = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
  }, lang);
  await p.goto(`http://127.0.0.1:${port}/`); await p.waitForSelector('.task-card');
  const card = await p.textContent('.task-card'); console.log('card:', card.replace(/\s+/g, ' ').slice(0, 160));
  check('the card says the folder is not allowed, not EPERM', /Folder not allowed|المجلّد غير مسموح/.test(card) && !/EPERM|noFolderAccess/.test(card));
  // The app's browser, no address needed.
  await p.click('.topbar .browse-btn'); await p.waitForTimeout(200);
  check('the browser opened from Downloads with no address', (await p.evaluate(() => window.__calls)).some((c) => c[0] === 'browse' && c[1] === ''));
  // The fix from the download's page.
  await p.goto(`http://127.0.0.1:${port}/#/task/t1`); await p.waitForSelector('.plan-note.bad button');
  check('its page explains it', /does not let the app save|لا يسمح أندرويد/.test(await p.textContent('.plan-note.bad')));
  await p.click('.plan-note.bad button'); await p.waitForSelector('.sheet .btn.primary');
  check('why, with the folder named', /A K Tools/.test(await p.textContent('.sheet')));
  await p.click('.sheet .btn.primary'); await p.waitForFunction(() => window.__calls.some((c) => c[0] === 'resume'), null, { timeout: 8000 });
  const c = await p.evaluate(() => window.__calls);
  check('All files access asked, then the download resumed', c.some((x) => x[0] === 'access' && x[1]) && c.some((x) => x[0] === 'resume' && x[1] === 't1') && !(await p.$('.sheet')));
  // A folder chosen in Settings that cannot be written: the app's folder kept instead.
  await p.evaluate(() => { window.__calls = []; }); await p.addInitScript(() => {});
  await p.goto(`http://127.0.0.1:${port}/#/settings`); await p.waitForSelector('#downloads'); if (await p.$('#downloads.collapsed')) await p.click('#downloads h3');
  await p.evaluate(() => { const pl = window.Capacitor.Plugins.KurokawaTools; pl.folderAccess = async (o) => ({ all: false, writable: false, defaultDir: '/storage/emulated/0/Download/Kurokawa' }); });
  await p.locator('#downloads .row', { hasText: lang === 'ar' ? 'مجلد التنزيل' : 'Download folder' }).first().locator('button').click(); await p.waitForSelector('.sheet .btn.tonal');
  await p.click('.sheet .btn.tonal'); await p.waitForTimeout(400);
  check('the app\'s folder kept when access is not given', (JSON.parse(await p.evaluate(() => localStorage.getItem('kt.settings'))).downloadDir || '') === '');
  check('no page errors', !errors.length);
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
