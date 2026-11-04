// node tests/updater.cjs: the reader's updater on Android (the plugins faked, GitHub's API answered by a stub) —
// on the beta channel the newest *reader* release is offered (never one of Tools' tools-v… releases, which once
// slipped in), with every version since this one; the file fetched, checked against its SHA-256 and installed;
// a damaged one refused.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
const SHA = 'c'.repeat(64);
const rel = (tag, notes, pre = false) => ({ tag_name: tag, html_url: `https://github.com/x/y/releases/tag/${tag}`, body: `## What's new\n${notes.map((n) => `- ${n}`).join('\n')}\n\n## Files\n| a |`, published_at: '2026-11-01T00:00:00Z', prerelease: pre, draft: false,
  assets: [{ name: `KurokawaReader-${tag.replace(/^\D+/, '')}-arm64-v8a.apk`, browser_download_url: 'https://github.com/x/y/a.apk', size: 11600000, digest: `sha256:${SHA}` }] });
const RELEASES = [rel('tools-v99.9.0', ['TOOLS'], true), rel('v99.1.0', ['Reader newest', 'Second line'], true), rel('v99.0.0', ['Reader older']), rel('v0.0.1', ['ancient'])];
(async () => {
  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const b = await chromium.launch();
  const run = async (damaged) => {
    const p = await (await b.newContext({ viewport: { width: 420, height: 880 }, locale: 'en' })).newPage(); const errors = []; p.on('pageerror', (e) => errors.push(e.message));
    await p.route('https://api.github.com/**', (r) => r.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: RELEASES }));
    await p.addInitScript((damaged) => {
      localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now()));
      localStorage.setItem('kr.visual', JSON.stringify({ ...(JSON.parse(localStorage.getItem('kr.visual') || '{}')), updateChannel: 'beta' }));
      window.__calls = []; const ls = {};
      const Kurokawa = new Proxy({
        deviceInfo: async () => ({ abis: ['arm64-v8a'] }), addListener: (ev, fn) => { (ls[ev] = ls[ev] || []).push(fn); return Promise.resolve({ remove() {} }); },
        cachedFile: async () => ({}), downloadFile: async (a) => { window.__calls.push('dl'); (ls.downloadProgress || []).forEach((f) => f({ id: a.id, got: 11600000, total: 11600000, speed: 3e6 })); return { path: 'file:///cache/kr-update/' + a.name, size: 11600000 }; },
        hashFile: async () => { window.__calls.push('hash'); return { sha256: damaged ? 'd'.repeat(64) : 'c'.repeat(64), size: 11600000 }; }, deleteDownload: async () => { window.__calls.push('del'); return { ok: true }; },
        canInstall: async () => ({ granted: true }), installApk: async () => { window.__calls.push('install'); },
        // (The Kurokawa Installer inside the reader: what the file is, then the install with its events.)
        apkInfo: async () => ({ label: 'KurokawaReader', package: 'app.kurokawa.reader', version: '99.1.0', versionCode: 990100, size: 11600000, sameApp: true, installed: true, installedVersion: '0.59.11', signerMatch: true, minSdk: 24 }),
        apkInstall: async (a) => { window.__calls.push('install'); (ls.apk || []).forEach((f) => f({ id: a.id, status: 'progress', done: 11600000, total: 11600000 })); (ls.apk || []).forEach((f) => f({ id: a.id, status: 'success' })); return { id: a.id }; },
      }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { Kurokawa, Filesystem: { writeFile: async () => ({ uri: 'x' }) } }, PluginHeaders: [] };
    }, damaged);
    await p.goto(`http://127.0.0.1:${port}/`); await p.waitForTimeout(800); await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForTimeout(1200);
    const btn = p.locator('button:has-text("Check for updates")').first();
    if (!(await btn.isVisible())) await p.locator('h3.card-title').filter({ hasText: /update/i }).first().click();
    await btn.scrollIntoViewIfNeeded(); await btn.click(); await p.waitForSelector('.update-sheet .upd-version', { timeout: 10000 });
    return { p, errors };
  };
  let { p, errors } = await run(false);
  const vers = await p.$$eval('.update-sheet .upd-version summary b', (e) => e.map((x) => x.textContent)); console.log('versions:', vers.join(' | '));
  ok('beta: the reader\'s own newest, every version since, no Tools release', vers.join() === '99.1.0,99.0.0' && !/TOOLS/.test(await p.$eval('.update-sheet', (e) => e.textContent)));
  await p.waitForFunction(() => /arm64-v8a/.test(document.querySelector('.update-sheet .upd-file-name')?.textContent || ''));
  await p.locator('.update-sheet .upd-go').click();
  // (The installer's sheet: the file read — the version old → new, the signature matching — then Install tapped.)
  const inst = p.locator('.sheet').filter({ has: p.locator('.inst-card') }).first();
  await inst.locator('.inst-title').filter({ hasText: /0\.59\.11.*99\.1\.0/ }).waitFor({ timeout: 10000 });
  ok('the installer says what the file is', /0\.59\.11 → 99\.1\.0/.test(await inst.locator('.inst-title').textContent()) && /matches/i.test(await inst.locator('.inst-status').textContent()));
  await inst.locator('button.btn.primary').click();
  await p.waitForFunction(() => window.__calls.includes('install'), null, { timeout: 10000 });
  ok('fetched, checked, installed', (await p.evaluate(() => window.__calls.join(','))) === 'dl,hash,install');
  await p.waitForFunction(() => /Installed/.test(document.querySelector('.inst-status')?.textContent || ''), null, { timeout: 5000 });
  ok('no page errors', !errors.length); if (errors.length) console.log(errors);
  await p.close();
  ({ p, errors } = await run(true));
  await p.waitForFunction(() => /arm64-v8a/.test(document.querySelector('.update-sheet .upd-file-name')?.textContent || ''));
  await p.locator('.update-sheet .upd-go').click();
  await p.waitForFunction(() => /damaged/i.test(document.querySelector('.update-sheet .upd-status')?.textContent || ''), null, { timeout: 10000 });
  ok('a damaged file: deleted, not installed', (await p.evaluate(() => window.__calls.join(','))) === 'dl,hash,del');
  await b.close(); server.close();
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
