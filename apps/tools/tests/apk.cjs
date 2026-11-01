// The app installer's sheet on Android (the plugin faked): a locked archive asks for its password, an archive
// holding two apps asks which one, low room is warned of, and the install is handed the password, the choice and
// the parts the plugin chose.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port;
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 420, height: 860 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  const check = (what, ok) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) errors.push(what); };
  await p.addInitScript(() => {
    localStorage.setItem('kr.lang', 'en'); const listeners = {}; window.__calls = [];
    window.__torrent = { id: 'b', kind: 'torrent', name: 'Apps pack', source: { magnet: 'magnet:?xt=urn:btih:' + 'c'.repeat(40) }, dir: '/sdcard/Download', state: 'done', done: 1, total: 1, downSpeed: 0, upSpeed: 0, files: [{ index: 0, path: 'Apps pack/One.apk', size: 1, done: 1, priority: 1 }, { index: 1, path: 'Apps pack/Two.xapk', size: 1, done: 1, priority: 1 }, { index: 2, path: 'Apps pack/readme.txt', size: 1, done: 1, priority: 1 }], addedAt: Date.now() - 90e3, doneAt: Date.now(), engine: 'native' };
    const task = { id: 'a', kind: 'http', name: 'Games.apks', source: { url: 'https://x/g' }, dir: '/sdcard/Download', state: 'done', done: 5e8, total: 5e8, downSpeed: 0, upSpeed: 0, files: [], addedAt: Date.now() - 60e3, doneAt: Date.now(), engine: 'native' };
    const api = {
      addListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); return Promise.resolve({ remove() {} }); },
      list: async () => ({ tasks: [task, window.__torrent] }),
      apkInfo: async (o) => {
        window.__calls.push(['info', o]);
        if (!o.password) throw new Error('password');
        if (o.password !== 'right') throw new Error('password');
        if (!o.select) return { choose: [{ select: 'bundle:Game.xapk', label: 'Game.xapk', size: 4e8 }, { select: 'apk:Tools/Other.apk', label: 'Other.apk', size: 2e7 }] };
        return { select: o.select, parts: ['base.apk', 'split_config.arm64_v8a.apk'], container: true, package: 'com.example.game', version: '1.2', versionCode: 12, label: 'Game', change: 'new', splits: 2, size: 4e8, bundle: true, supported: true, free: 5e8 };
      },
      pickFile: async () => ({ paths: ['/storage/emulated/0/Download/Picked.apk'] }), archiveList: async () => ({}),
      apkInstall: async (o) => { window.__calls.push(['install', o]); setTimeout(() => (listeners.apkInstall || []).forEach((f) => f({ id: o.id, status: 'success', package: 'com.example.game' })), 50); },
    };
    const plugin = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
  });
  await p.goto(`http://127.0.0.1:${port}/`); await p.waitForSelector('.task-card');
  await p.click('.task-card button[aria-label="More"]'); await p.locator('.sheet .dest-row', { hasText: 'Install' }).click();
  await p.waitForSelector('.sheet input[type=password]'); check('a locked archive asks for its password', /password/i.test(await p.$eval('.sheet', (e) => e.innerText)));
  await p.fill('.sheet input[type=password]', 'wrong'); await p.press('.sheet input[type=password]', 'Enter');
  await p.waitForFunction(() => /wrong/i.test(document.querySelector('.sheet')?.innerText || '')); check('a wrong one is said to be wrong', true);
  await p.fill('.sheet input[type=password]', 'right'); await p.press('.sheet input[type=password]', 'Enter');
  await p.waitForSelector('.sheet .dest-row:has-text("Game.xapk")'); const choices = await p.$$eval('.sheet .dest-row', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' ')));
  console.log('choices:', choices.join(' | ')); check('two apps to choose from', choices.length === 2 && /bundle/i.test(choices[0]) && /APK/.test(choices[1]));
  await p.click('.sheet .dest-row:has-text("Game.xapk")'); await p.waitForSelector('.sheet .apk-head');
  const body = await p.$eval('.sheet', (e) => e.innerText.replace(/\s+/g, ' ')); console.log('sheet:', body.slice(0, 400));
  check('from the archive, nothing extracted', /straight from the archive/i.test(body));
  check('low room warned of', /may not have room/i.test(body));
  check('the archive is what may be deleted', /Delete the archive once installed/.test(body));
  await p.click('.sheet .btn.primary'); await p.waitForFunction(() => window.__calls.some((c) => c[0] === 'install'));
  const inst = await p.evaluate(() => window.__calls.find((c) => c[0] === 'install')[1]); console.log('install:', JSON.stringify(inst));
  check('install handed the password, the choice and the parts', inst.password === 'right' && inst.select === 'bundle:Game.xapk' && JSON.stringify(inst.parts) === '["base.apk","split_config.arm64_v8a.apk"]' && inst.path === '/sdcard/Download/Games.apks');
  await p.waitForSelector('.sheet .glyph'); check('installed', /installed/i.test(await p.$eval('.sheet', (e) => e.innerText)));
  // The + menu: «Install an app», the file picked, the installer opened on it.
  await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove()));
  await p.click('.fab'); await p.waitForSelector('.fab-item'); console.log('fab:', (await p.$$eval('.fab-item b', (e) => e.map((x) => x.textContent))).join(' | ')); await p.locator('.fab-item', { hasText: 'Install an app' }).click();
  await p.waitForFunction(() => window.__calls.some((c) => c[0] === 'info' && c[1].path === '/storage/emulated/0/Download/Picked.apk'));
  check('the + menu installs a picked file', true);
  // A torrent with two apps among its files: a row for each.
  await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove()));
  await p.click('.task-card:has-text("Apps pack") button[aria-label="More"]'); await p.waitForSelector('.sheet .dest-row:has-text("Two.xapk")');
  const rows = await p.$$eval('.sheet .dest-row', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' ')).filter((x) => /Install/.test(x)));
  console.log('torrent rows:', rows.join(' | ')); check('a torrent\'s two apps can be installed', rows.length === 2 && /One\.apk/.test(rows[0]) && /Two\.xapk/.test(rows[1]));
  await p.click('.sheet .dest-row:has-text("Two.xapk")'); await p.waitForFunction(() => window.__calls.some((c) => c[0] === 'info' && c[1].path === '/sdcard/Download/Apps pack/Two.xapk'));
  check('its file path is the torrent\'s file', true);
  check('no page errors', !errors.filter((e) => e !== 'no page errors').length);
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
