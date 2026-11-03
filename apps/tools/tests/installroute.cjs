// An app opened with «Kurokawa Installer» (Android hands the file to the app, which opens #/install?p=…; the
// plugin faked): the app's installer opens on it; and the update installer chosen in Settings.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port;
  const br = await chromium.launch(); const errors = [];
  const check = (what, ok) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) errors.push(what); };
  const p = await br.newPage({ viewport: { width: 400, height: 860 } }); p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(() => {
    localStorage.setItem('kr.lang', 'en'); window.__calls = [];
    const api = { addListener: () => Promise.resolve({ remove() {} }), list: async () => ({ tasks: [] }),
      apkInfo: async (o) => { window.__calls.push(['info', o.path]); return { package: 'com.example.game', label: 'Example Game', version: '1.2', versionCode: 12, change: 'new', splits: 0, size: 5e7, supported: true, permissions: [], abis: [], abiFits: true }; } };
    const plugin = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
  });
  await p.goto(`http://127.0.0.1:${port}/#/install?p=${encodeURIComponent('/data/cache/kt-install/Game 1.2.apk')}`);
  await p.waitForFunction(() => window.__calls.some((c) => c[0] === 'info'), null, { timeout: 8000 }); await p.waitForSelector('.sheet');
  check('the app\'s installer opened on the file handed over', (await p.evaluate(() => window.__calls.find((c) => c[0] === 'info')[1])) === '/data/cache/kt-install/Game 1.2.apk' && /Example Game/.test(await p.textContent('.sheet')));
  await p.goto(`http://127.0.0.1:${port}/#/settings`); await p.waitForSelector('#updates'); if (await p.$('#updates.collapsed')) await p.click('#updates h3');
  await p.locator('#updates .row', { hasText: 'Install with' }).locator('.pick-btn').click(); await p.locator('.sheet .dest-row', { hasText: "Android's installer" }).last().click(); await p.waitForTimeout(200);
  check('the update installer chosen in Settings', await p.evaluate(() => localStorage.getItem('kt.update.installer')) === 'system');
  check('no page errors', !errors.length);
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
