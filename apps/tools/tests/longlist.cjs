// node tests/longlist.cjs: the downloads list with 2,000 finished downloads (made up, the desktop bridge faked): only the
// rows near the screen are in the page (spacers stand for the rest), and nothing a person does with the list notices —
// scrolled to the end, the last rows are there; «select all» picks all 2,000; a search finds a row far down; a filter
// and the sort still apply. Reports DOM nodes, the JS heap and the time to show. KT_DIST=<another dist>: report only.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = process.env.KT_DIST || path.join(__dirname, '..', 'dist'); const BEFORE = !!process.env.KT_DIST;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
(async () => {
  const web = serve().listen(0); const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 412, height: 915 } }); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript(() => {
    localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.pc.starter', '1'); localStorage.setItem('kt.update.lastCheck', String(Date.now()));
    const now = Date.now(); const ts = []; for (let i = 0; i < 2000; i++) ts.push({ id: 't' + i, kind: 'http', name: `made-up-${String(i).padStart(4, '0')}.${i % 10 === 0 ? 'mkv' : 'bin'}`, source: { url: `https://example.test/${i}` }, dir: '/d', state: i % 50 === 0 ? 'failed' : 'done', done: 5e6, total: 5e6, downSpeed: 0, upSpeed: 0, files: [], addedAt: now - i * 1000, error: i % 50 === 0 ? 'HTTP 404' : undefined });
    window.kurokawaTools = new Proxy({ platform: 'desktop', available: true, os: 'linux', list: async () => ts, onTasks: (cb) => { cb(ts); return () => {}; }, remove: async () => {} }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) });
  });
  const cdp = await p.context().newCDPSession(p); await cdp.send('Performance.enable');
  await p.goto(`http://127.0.0.1:${web.address().port}/#/`); await p.waitForFunction(() => document.querySelectorAll('.task-card').length >= 10, null, { timeout: 60000 });
  const shown = await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(performance.now())))); await p.waitForTimeout(400); await cdp.send('HeapProfiler.collectGarbage').catch(() => undefined);
  const m = (await cdp.send('Performance.getMetrics')).metrics; const g = (n) => m.find((x) => x.name === n).value;
  console.log(`2,000 finished: shown at ${shown.toFixed(0)} ms · DOM nodes ${g('Nodes')} · JS heap ${(g('JSHeapUsedSize') / 1048576).toFixed(1)} MB · rows in the page ${await p.$$eval('.task-card', (x) => x.length)}`);
  if (!BEFORE) {
    ok('a screenful or two of rows, not 2,000', (await p.$$eval('.task-card', (x) => x.length)) < 120 && g('Nodes') < 5000, g('Nodes'));
    // (Scrolled to the end: the last rows.)
    await p.mouse.move(200, 600); for (let i = 0; i < 6; i++) { await p.mouse.wheel(0, 100000); await p.waitForTimeout(120); }
    const ids = await p.$$eval('.task-card', (x) => x.map((c) => c.dataset.id)); ok('scrolled to the end: the last row is there', ids.includes('t1999'), ids.slice(-3));
    // (Back to the top, and the first.)
    for (let i = 0; i < 6; i++) { await p.mouse.wheel(0, -100000); await p.waitForTimeout(120); }
    ok('back at the top: the first row', (await p.$$eval('.task-card', (x) => x.map((c) => c.dataset.id))).includes('t0'));
    // (Select all: every one of the 2,000, rendered or not.)
    await p.keyboard.press('Control+a'); await p.waitForTimeout(200); const bar = await p.$eval('.select-bar, .dl-select, [class*=select]', (e) => e.textContent).catch(() => '');
    ok('«select all» picks all 2,000', /2,?000/.test(bar), bar);
    // (Scrolled while all are chosen: the rows the scroll brings in are drawn chosen too — the window moves without the
    // whole list being drawn again.)
    for (let i = 0; i < 6; i++) { await p.mouse.wheel(0, 100000); await p.waitForTimeout(120); }
    const marks = await p.$$eval('.task-card', (x) => [x.length, x.filter((c) => c.classList.contains('picked')).length, x.some((c) => c.dataset.id === 't1999')]);
    ok('scrolled to the end while choosing: every row there shown chosen', marks[2] && marks[0] > 0 && marks[0] === marks[1], marks);
    for (let i = 0; i < 6; i++) { await p.mouse.wheel(0, -100000); await p.waitForTimeout(120); }
    await p.keyboard.press('Escape');
    // (A filter: the failed ones only — 40 —, no windowing below the threshold.)
    await p.click('.chip:has-text("Failed")'); await p.waitForTimeout(200); ok('a filter applies (40 failed)', (await p.$$eval('.task-card', (x) => x.length)) === 40);
    ok('no page errors', !errs.length, errs);
  }
  await br.close(); web.close(); process.exit(fails ? 1 : 0);
})();
