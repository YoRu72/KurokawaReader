// Start-up on a phone (Reader): 412x915, CPU slowed x4, a slow 4G link, a cold load (no HTTP cache) of the built app over a small made-up
// library, in English and Arabic. Prints: first paint, the library usable (first book card drawn + a tap on it answered),
// the bytes fetched and the requests made up to that point, and any request answered 4xx/5xx (a 404 at start fails).
// Timing never fails the run except against the hard ceilings below (about 3x what the build measured when they were set).
// Run: NODE_PATH=$(npm root -g) node tests/startup.cjs [en|ar]
const { chromium, devices } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const args = process.argv.slice(2); const LANGS = args.includes('ar') ? ['ar'] : args.includes('en') ? ['en'] : ['en', 'ar'];
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
// Hard ceilings, 3x what the build measured (Reader 0.65: usable ~4.3 s, ~580 KB, 37 requests before it): a gross regression only.
const CEIL = { usableMs: 13000, bytes: 1750000, requests: 110 };
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.epub': 'application/epub+zip' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]); let f = path.join(DIST, u);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { if (/\.[a-z0-9]+$/i.test(u) && u !== '/') { res.writeHead(404); res.end(); return; } f = path.join(DIST, 'index.html'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-startup-'));
const NAMES = ['Harbour Lights', 'Quiet Orchard', 'Paper Kingdom', 'Winter Letters'];
const files = NAMES.map((nm, n) => { const f = path.join(TMP, `${nm}.txt`); fs.writeFileSync(f, `${nm}\n\n` + Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of the made-up book ${n}.`).join('\n\n')); return f; });
const allBooks = (p) => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result); q.onerror = () => res([]); }; r.onerror = () => res([]); }));

(async () => {
  await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
  let fails = 0;
  for (const lang of LANGS) {
    const dir = fs.mkdtempSync(path.join(TMP, 'prof-'));
    const opts = { ...devices['Pixel 7'], viewport: { width: 412, height: 915 }, locale: lang, serviceWorkers: 'block' };
    // 1. seed the library (not measured), then close: the library stays in the profile.
    let ctx = await chromium.launchPersistentContext(dir, opts);
    await ctx.route((u) => !/^(127\.0\.0\.1|localhost)$/.test(u.hostname), (r) => r.abort());
    let p = ctx.pages()[0] || await ctx.newPage();
    await p.goto(base); await p.evaluate((l) => { localStorage.setItem('kr.lang', l); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }, lang); await p.reload(); await p.waitForSelector('.library-view', { timeout: 30000 });
    await p.setInputFiles('.library-view input[type=file]', files);
    for (let i = 0; i < 160; i++) { const n = (await allBooks(p)).length; if (n >= files.length) break; await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); s?.querySelector('.sheet-actions button, button.btn')?.click(); }); await p.waitForTimeout(250); }
    if ((await allBooks(p)).length < files.length) { console.log(`ERR   ${lang}: the fixture library was not made`); fails++; }
    await ctx.close();
    // 2. the measured cold load.
    ctx = await chromium.launchPersistentContext(dir, opts);
    await ctx.route((u) => !/^(127\.0\.0\.1|localhost)$/.test(u.hostname), (r) => r.abort());
    p = ctx.pages()[0] || await ctx.newPage();
    await p.addInitScript(() => {
      const w = window; w.__st = {};
      const watch = () => { const mo = new MutationObserver(() => { if (!w.__st.card && document.querySelector('.library-view .book-card[data-book]')) { w.__st.card = performance.now(); mo.disconnect(); } }); mo.observe(document, { childList: true, subtree: true }); };
      watch();
      addEventListener('pointerdown', () => { w.__st.down = performance.now(); }, true);
      addEventListener('hashchange', () => { if (w.__st.down && !w.__st.answered) w.__st.answered = performance.now(); });
    });
    const cdp = await ctx.newCDPSession(p);
    await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    // A slow 4G phone link (Lighthouse's numbers: 1.6 Mbit/s down, 150 ms round trip): what the bytes cost on a real start.
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8 });
    const reqs = new Map(); let bytes = 0; let count = 0; const bad = [];
    cdp.on('Network.requestWillBeSent', (e) => { reqs.set(e.requestId, e.request.url); count++; });
    cdp.on('Network.responseReceived', (e) => { if (e.response.status >= 400) bad.push(`${e.response.status} ${e.response.url.replace(base, '/')}`); });
    cdp.on('Network.loadingFinished', (e) => { bytes += e.encodedDataLength || 0; });
    cdp.on('Network.loadingFailed', (e) => { const u = reqs.get(e.requestId) || ''; if (/^http:\/\/127\.0\.0\.1/.test(u) && !e.canceled) bad.push(`failed ${u.replace(base, '/')}`); });
    const errors = []; p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(base, { waitUntil: 'commit' });
    await p.waitForFunction(() => window.__st && window.__st.card, null, { timeout: 60000, polling: 20 }).catch(async (e) => { console.log('DBG', await p.evaluate(() => [...document.querySelectorAll('.book-card')].map((c) => c.className + ':' + c.textContent.slice(0, 30)).join(' / ') + ' H=' + location.hash), JSON.stringify(errors)); throw e; });
    const bytesAt = bytes, countAt = count;
    const box = await p.evaluate(() => { const r = document.querySelector('.library-view .book-card[data-book]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 60) }; });
    await p.touchscreen.tap(box.x, box.y);
    await p.waitForFunction(() => window.__st.answered, null, { timeout: 8000, polling: 20 }).catch(async (e) => { console.log('DBG', await p.evaluate(() => JSON.stringify({ h: location.hash, st: window.__st, v: document.querySelector('#app').firstElementChild.className })), JSON.stringify(box)); throw e; });
    const st = await p.evaluate(() => ({ ...window.__st, fcp: (performance.getEntriesByName('first-contentful-paint')[0] || {}).startTime, fp: (performance.getEntriesByName('first-paint')[0] || {}).startTime }));
    const nav = await p.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? n.responseStart : 0; });
    await p.waitForTimeout(1500); // what the start loads afterwards (the 404 check only; not in the numbers)
    const tap = st.answered - st.down; const usable = st.card + tap;
    console.log(`${lang}  first paint ${Math.round(st.fcp || st.fp || 0)} ms | library usable ${Math.round(usable)} ms (card ${Math.round(st.card)} + tap ${Math.round(tap)}) | bytes before ${bytesAt} | requests before ${countAt} (total ${count}, ${bytes} B) | 404s ${bad.length}${bad.length ? ' [' + bad.join(', ') + ']' : ''}`);
    if (bad.length) { console.log(`FAIL  ${lang}: failed requests at start`); fails++; }
    if (errors.length) { console.log(`FAIL  ${lang}: page errors ${errors.slice(0, 2).join(' | ')}`); fails++; }
    if (usable > CEIL.usableMs || bytesAt > CEIL.bytes || countAt > CEIL.requests) { console.log(`FAIL  ${lang}: over the hard ceiling ${JSON.stringify(CEIL)}`); fails++; }
    await ctx.close();
  }
  console.log(fails ? `${fails} FAILED` : 'all passed');
  server.close(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
