// The updater on Android (the plugin faked, GitHub's API answered by a stub): every version since this one in the
// sheet, the file for this phone with its size, fetched and checked against its SHA-256, the right to install
// asked for and the install carried on once given; a damaged file refused; the Atom feed when the API is limited.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
const SHA = 'a'.repeat(64);
const rel = (v, notes) => ({ tag_name: `tools-v${v}`, html_url: `https://github.com/x/y/releases/tag/tools-v${v}`, body: `## KurokawaTools\n\n## What's new\n${notes.map((n) => `- ${n}`).join('\n')}\n\n## Files\n| a | b |`, published_at: '2026-11-01T00:00:00Z', prerelease: true, draft: false,
  assets: [{ name: `KurokawaTools-${v}-arm64-v8a.apk`, browser_download_url: `https://github.com/x/y/releases/download/tools-v${v}/KurokawaTools-${v}-arm64-v8a.apk`, size: 15800000, digest: `sha256:${SHA}` }, { name: `KurokawaTools-${v}-universal.apk`, browser_download_url: 'u', size: 29000000 }] });
const RELEASES = [rel('99.1.0', ['Newest fix', 'Newest feature']), rel('99.0.0', ['Older fix']), { ...rel('0.55.9', ['reader']), tag_name: 'v0.55.9' }, rel('0.0.1', ['ancient'])];
(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port;
  const br = await chromium.launch(); const errors = []; const check = (what, ok) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) errors.push(what); };
  const page = async (o) => {
    const p = await br.newPage({ viewport: { width: 420, height: 860 } }); p.on('pageerror', (e) => errors.push(e.message));
    await p.route('https://api.github.com/**', (r) => (o.limited ? r.fulfill({ status: 403, body: '{"message":"API rate limit exceeded"}' }) : r.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: RELEASES })));
    await p.addInitScript((o) => {
      localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.update.lastCheck', String(Date.now())); const listeners = {}; window.__calls = []; let can = false;
      const api = {
        addListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); return { remove() {} }; }, list: async () => ({ tasks: [] }), deviceInfo: async () => ({ abis: ['arm64-v8a', 'armeabi-v7a'] }),
        downloadFile: async (a) => { window.__calls.push(['dl', a.name]); for (const g of [5e6, 1e7, 15800000]) { await new Promise((r) => setTimeout(r, 60)); (listeners.downloadProgress || []).forEach((f) => f({ id: a.id, got: g, total: 15800000, speed: 4e6, connections: 8 })); } return { path: '/cache/kt-files/' + a.name, size: 15800000 }; },
        hashFile: async () => ({ sha256: o.damaged ? 'b'.repeat(64) : 'a'.repeat(64), size: 15800000 }), exists: async () => ({ exists: [false] }), deletePath: async () => ({ ok: true }),
        canInstall: async () => ({ granted: can }),
        apkInstall: async (a) => { window.__calls.push(['appinstall', a.path]); if (!can) { setTimeout(() => { can = true; }, 900); throw new Error('permission'); } },
        installApk: async (a) => { window.__calls.push(['install', a.path]); if (!can) { setTimeout(() => { can = true; }, 900); throw new Error('permission'); } },
        httpRequest: async (r) => { window.__calls.push(['http', r.url]); return { status: 200, headers: {}, body: `<?xml version="1.0"?><feed><entry><updated>2026-11-01T00:00:00Z</updated><link rel="alternate" type="text/html" href="https://github.com/YoRu72/KurokawaReader/releases/tag/tools-v99.2.0"/><content type="html">&lt;h2&gt;What's new&lt;/h2&gt;&lt;ul&gt;&lt;li&gt;From the feed&lt;/li&gt;&lt;/ul&gt;</content></entry><entry><link href="https://github.com/YoRu72/KurokawaReader/releases/tag/v0.60.0"/></entry></feed>` }; },
      };
      const plugin = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
    }, o);
    await p.goto(`http://127.0.0.1:${port}/#/settings`); await p.waitForSelector('#updates'); if (await p.$('#updates.collapsed')) await p.click('#updates h3');
    await p.locator('#updates button', { hasText: 'Check for updates' }).click(); await p.waitForSelector('.update-sheet .upd-version', { timeout: 10000 });
    return p;
  };
  let p = await page({});
  const vers = await p.$$eval('.update-sheet .upd-version summary b', (e) => e.map((x) => x.textContent)); console.log('versions:', vers.join(' | '));
  check('every version since this one, none of the reader\'s', vers.join() === '99.1.0,99.0.0');
  check('the newest open, its bullets', await p.$eval('.update-sheet .upd-version[open]', (e) => /Newest fix/.test(e.textContent) && !/Files/.test(e.textContent)));
  await p.waitForFunction(() => /arm64-v8a\.apk/.test(document.querySelector('.update-sheet .upd-file')?.textContent || ''));
  const file = await p.$eval('.update-sheet .upd-file', (e) => e.textContent); console.log('file:', file); check('this phone\'s file, its size, checked', /arm64-v8a\.apk/.test(file) && /MB/.test(file) && /SHA-256/.test(file));
  check('the installer offered: the app\'s chosen first', await p.$eval('.update-sheet .upd-via [data-v="app"]', (e) => e.classList.contains('on')));
  await p.click('.update-sheet .upd-via [data-v="system"]');
  check('Android\'s installer chosen and remembered', await p.evaluate(() => localStorage.getItem('kt.update.installer')) === 'system');
  await p.locator('.update-sheet .btn.primary', { hasText: 'Download and install' }).click();
  await p.waitForFunction(() => /installer was opened/i.test(document.querySelector('.update-sheet')?.textContent || ''), null, { timeout: 15000 });
  const calls = await p.evaluate(() => window.__calls.map((c) => c[0]).filter((c) => c !== 'http').join(','));
  console.log('calls:', calls); check('fetched, refused for want of the right, installed once it was given', calls === 'dl,install,install');
  check('the download kept for a second tap', await p.evaluate(() => JSON.parse(localStorage.getItem('kt.update.file')).name === 'KurokawaTools-99.1.0-arm64-v8a.apk'));
  await p.close();
  // The app's own installer.
  p = await page({}); await p.evaluate(() => localStorage.setItem('kt.update.installer', 'app'));
  await p.waitForFunction(() => /arm64/.test(document.querySelector('.update-sheet .upd-file')?.textContent || ''));
  await p.locator('.update-sheet .btn.primary', { hasText: 'Download and install' }).click();
  await p.waitForFunction(() => window.__calls.some((c) => c[0] === 'appinstall'), null, { timeout: 15000 }); await p.waitForTimeout(1500);
  const c2 = await p.evaluate(() => window.__calls.filter((c) => c[0] !== 'http'));
  console.log('app installer calls:', JSON.stringify(c2)); check('the app\'s installer: given the file downloaded, not Android\'s', c2.some((c) => c[0] === 'appinstall' && /KurokawaTools-99\.1\.0-arm64-v8a\.apk$/.test(c[1])) && !c2.some((c) => c[0] === 'install'));
  await p.close();
  p = await page({ damaged: true });
  await p.waitForFunction(() => /arm64/.test(document.querySelector('.update-sheet .upd-file')?.textContent || ''));
  await p.locator('.update-sheet .btn.primary', { hasText: 'Download and install' }).click();
  await p.waitForFunction(() => /damaged/i.test(document.querySelector('.update-sheet')?.textContent || ''), null, { timeout: 15000 });
  check('a damaged file is not installed', await p.evaluate(() => !window.__calls.some((c) => c[0] === 'install')) && !!(await p.$('.update-sheet .btn.primary:has-text("Try again")')));
  await p.close();
  p = await page({ limited: true });
  const fv = await p.$$eval('.update-sheet .upd-version summary b', (e) => e.map((x) => x.textContent)); console.log('from the feed:', fv.join(' | '));
  check('the API limited: the Atom feed, this app\'s releases only', fv.join() === '99.2.0' && /From the feed/.test(await p.$eval('.update-sheet', (e) => e.textContent)));
  await p.waitForFunction(() => /arm64/.test(document.querySelector('.update-sheet .upd-file')?.textContent || ''));
  check('its file named as the workflow names it', /KurokawaTools-99\.2\.0-arm64-v8a\.apk/.test(await p.$eval('.update-sheet .upd-file', (e) => e.textContent)));
  await p.close();
  check('no page errors', !errors.length);
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
