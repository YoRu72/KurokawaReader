// node tests/updates/android.cjs: the update dialog on Android, against a stand-in for the native plugin —
// progress only the update's own (another download's events mixed in), never going backwards, one download when
// the dialog is opened again mid-way, Cancel stopping the native download, and an update fetched before used
// again without downloading.
const { chromium, devices } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
(async () => {
  await new Promise((r) => server.listen(5419, r));
  const browser = await chromium.launch(); const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'en' }); const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://localhost:5419/'); await page.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await page.reload(); await page.waitForSelector('.library-view');
  const chunk = fs.readdirSync(path.join(DIST, 'assets')).filter((f) => /^chunk-updates-.*\.js$/.test(f)).find((f) => /showUpdateSheet/.test(fs.readFileSync(path.join(DIST, 'assets', f), 'utf8')));
  // The stand-in plugin: a download the test drives by hand (window.krDl.step), with a cache it keeps.
  await page.evaluate(() => {
    const listeners = []; const st = { calls: 0, cancelled: [], cache: {}, pending: null, installs: [] };
    const emit = (ev) => { for (const l of listeners) l.fn(ev); };
    window.krDl = st;
    st.emit = emit;
    st.finish = () => { const p = st.pending; st.pending = null; st.cache[p.name] = p.size; emit({ id: p.id, got: p.size, total: p.size, pct: 100, speed: 0 }); p.ok({ path: 'file:///cache/kr-update/' + p.name, size: p.size }); };
    window.Capacitor = { getPlatform: () => 'android', isNativePlatform: () => false, Plugins: { Filesystem: {}, Kurokawa: {
      deviceInfo: async () => ({ abis: ['arm64-v8a'] }),
      addListener: async (ev, fn) => { const l = { ev, fn }; listeners.push(l); return { remove() { listeners.splice(listeners.indexOf(l), 1); } }; },
      downloadFile: (o) => new Promise((ok, fail) => { st.calls++; st.pending = { ...o, size: 10000000, ok, fail }; }),
      cancelDownload: async (o) => { st.cancelled.push(o.id); const p = st.pending; if (p && p.id === o.id) { st.pending = null; p.fail(new Error('cancelled')); } },
      cachedFile: async (o) => (st.cache[o.name] === o.size ? { path: 'file:///cache/kr-update/' + o.name, size: o.size } : {}),
      canInstall: async () => ({ granted: true }),
      installApk: async (o) => { st.installs.push(o.path); },
    } } };
  });
  const rel = { version: '9.9.9', notes: "## What's new\n- Something", url: 'https://example.com', publishedAt: '2026-10-28', assets: [{ name: 'KurokawaReader-9.9.9-arm64-v8a.apk', url: 'https://example.com/a.apk', size: 10000000 }] };
  const open = () => page.evaluate(([c, r]) => import('./assets/' + c).then((m) => m.showUpdateSheet(r)), [chunk, rel]);
  const closeAll = () => page.evaluate(() => document.querySelectorAll('.sheet .sheet-head .icon-btn').forEach((b) => b.click()));
  const status = () => page.$eval('.update-sheet .upd-status', (e) => e.textContent);
  await open(); await page.waitForSelector('.update-sheet .upd-go:not([disabled])'); await page.waitForTimeout(300);
  await page.click('.update-sheet .upd-go'); await page.waitForTimeout(200);
  const id = await page.evaluate(() => window.krDl.pending?.id);
  // The update's own progress, with another download's events between (the old updater showed those too).
  const seen = [];
  for (const [mine, pct] of [[1, 50], [0, 83], [1, 96], [0, 20], [1, 91]]) {
    await page.evaluate(([mine, pct, id]) => window.krDl.emit({ id: mine ? id : 'book-download-1', got: pct * 100000, total: 10000000, pct, speed: 1000000 }), [mine, pct, id]);
    await page.waitForTimeout(60); seen.push(/^⁨?(\d+)%/.exec(await status())?.[1]);
  }
  ok('only the update\'s own progress, and it never goes back (50, 96, 96 — not 83, 20 or 91)', JSON.stringify(seen) === JSON.stringify(['50', '50', '96', '96', '96']));
  if (JSON.stringify(seen) !== JSON.stringify(['50', '50', '96', '96', '96'])) console.log('  seen', JSON.stringify(seen));
  // The dialog closed and opened again mid-way: the same download shown, no second one.
  await closeAll(); await page.waitForTimeout(200); await open(); await page.waitForTimeout(500);
  ok('opened again mid-way: the download under way is shown, no second download started', (await page.evaluate(() => window.krDl.calls)) === 1 && /96%/.test(await status()));
  // Cancel stops the native download.
  await page.click('.update-sheet .upd-major button:has-text("Cancel")'); await page.waitForTimeout(300);
  ok('Cancel stops the native download', (await page.evaluate(() => window.krDl.cancelled)).includes(id) && /Cancelled/.test(await status()));
  // Downloaded to the end, the installer dismissed; the dialog opened again: installs without downloading.
  await page.click('.update-sheet .upd-go'); await page.waitForTimeout(200); await page.evaluate(() => window.krDl.finish()); await page.waitForTimeout(400);
  const calls = await page.evaluate(() => window.krDl.calls);
  await closeAll(); await page.waitForTimeout(200); await open(); await page.waitForTimeout(600);
  const said = await status();
  await page.click('.update-sheet .upd-go'); await page.waitForTimeout(400);
  ok('an update downloaded before is installed again without downloading', /Already downloaded/.test(said) && (await page.evaluate(() => window.krDl.calls)) === calls && (await page.evaluate(() => window.krDl.installs.length)) === 2);
  // A download left running with the dialog closed, the dialog opened again: when it ends, one installer only.
  await page.evaluate(() => { window.krDl.cache = {}; }); await closeAll(); await page.waitForTimeout(200);
  await open(); await page.waitForSelector('.update-sheet .upd-go:not([disabled])'); await page.waitForTimeout(400);
  await page.click('.update-sheet .upd-go'); await page.waitForTimeout(200);
  await closeAll(); await page.waitForTimeout(200); await open(); await page.waitForTimeout(600);
  const before = await page.evaluate(() => window.krDl.installs.length);
  await page.evaluate(() => window.krDl.finish()); await page.waitForTimeout(600);
  ok('closed and opened again mid-way: the installer starts once', (await page.evaluate(() => window.krDl.installs.length)) === before + 1);
  console.log(fails ? `${fails} FAILED` : 'all passed', 'errors', errors);
  await browser.close(); server.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
