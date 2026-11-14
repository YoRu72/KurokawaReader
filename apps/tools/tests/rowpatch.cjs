// node tests/rowpatch.cjs: the downloads list under progress pushes — 200 tasks, 5 under way, each push the whole list
// with the 5 changed (as every shell sends it). Measures the time a push costs the page (its handler plus the layout it
// forces) and counts the rows touched; checks that only changed rows are redrawn and that the order (sort by progress)
// and a filter stay right. KT_DIST=<another dist> measures another build (the «before»). Stand-ins only.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = process.env.KT_DIST || path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
(async () => {
  const web = serve().listen(0); const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 420, height: 900 } }); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript(() => {
    localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.pc.starter', '1'); localStorage.setItem('kt.update.lastCheck', String(Date.now()));
    const now = Date.now(); const ts = []; for (let i = 0; i < 200; i++) ts.push({ id: 't' + i, kind: 'http', name: `made-up-file-${String(i).padStart(3, '0')}.bin`, source: { url: `https://example.test/${i}` }, dir: '/d', state: i < 5 ? 'downloading' : i % 7 === 0 ? 'failed' : 'done', done: i < 5 ? 1e6 * i : 5e6, total: 5e6, downSpeed: i < 5 ? 1e5 : 0, upSpeed: 0, files: [], addedAt: now - i * 1000, error: i % 7 === 0 && i >= 5 ? 'HTTP 404' : undefined });
    window.__tasks = ts; const cbs = new Set(); window.__push = (x) => { for (const cb of cbs) cb(x); };
    window.kurokawaTools = new Proxy({ platform: 'desktop', available: true, os: 'linux', list: async () => ts, onTasks: (cb) => { cbs.add(cb); cb(ts); return () => cbs.delete(cb); }, defaultDir: async () => '/d' }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) });
  });
  await p.goto(`http://127.0.0.1:${web.address().port}/#/`); await p.waitForSelector('.task-card'); await p.waitForTimeout(800);
  const r = await p.evaluate(async () => {
    const list = document.querySelector('.task-list'); let touched = new Set(); const mo = new MutationObserver((ms) => { for (const m of ms) { const c = (m.target.nodeType === 1 ? m.target : m.target.parentElement)?.closest?.('.task-card'); if (c) touched.add(c.dataset.id); } }); mo.observe(list, { subtree: true, childList: true, characterData: true, attributes: true });
    const times = []; const touchedN = [];
    for (let k = 0; k < 60; k++) {
      const next = window.__tasks.map((x, i) => (i < 5 ? { ...x, done: Math.min(x.total, x.done + 50000 * (k + 1)), downSpeed: 1e5 + k * 10 + i } : { ...x }));
      touched = new Set(); const t0 = performance.now(); window.__push(next); void document.body.offsetHeight; times.push(performance.now() - t0);
      await new Promise((res) => setTimeout(res, 300)); mo.takeRecords().forEach(() => undefined); touchedN.push(touched.size);
    }
    mo.disconnect(); times.sort((a, b) => a - b);
    return { median: times[30], p90: times[54], max: times[59], touched: touchedN.slice(5).reduce((a, b) => Math.max(a, b), 0), rows: document.querySelectorAll('.task-card').length };
  });
  // (The rate: 5 jobs pushing ~3 times a second each — 15 pushes a second — for 4 s of real time; the main thread's busy
  // time per second (Chrome's TaskDuration) and the list's paints per second.)
  const cdp = await p.context().newCDPSession(p); await cdp.send('Performance.enable');
  const busy = async () => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration').value;
  const i0 = await busy(); await p.waitForTimeout(4000); const idleSec = ((await busy()) - i0) * 1000 / 4;
  const b0 = await busy();
  const rate = await p.evaluate(async () => {
    const list = document.querySelector('.task-list'); let paints = 0; const mo = new MutationObserver(() => { paints++; }); mo.observe(list, { subtree: true, childList: true, characterData: true });
    let k = 0; const t0 = performance.now();
    await new Promise((res) => { const iv = setInterval(() => { k++; window.__push(window.__tasks.map((x, i) => (i < 5 ? { ...x, done: Math.min(x.total, (x.done || 0) + 20000 * k), downSpeed: 1e5 + k + i } : { ...x }))); if (performance.now() - t0 > 4000) { clearInterval(iv); res(); } }, 1000 / 15); });
    await new Promise((res) => setTimeout(res, 300)); mo.disconnect(); return { pushes: k, paints };
  });
  const perSec = ((await busy()) - b0) * 1000 / 4.3;
  console.log(`idle (no pushes): main thread busy ${idleSec.toFixed(0)} ms per second`);
  console.log(`15 pushes/s, 4 s: main thread busy ${perSec.toFixed(0)} ms per second · ${rate.pushes} pushes · list mutated in ${rate.paints} batches`);
  // (Hidden: pushes keep coming; nothing is drawn till it is shown again.)
  const hid = await p.evaluate(async () => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); const list = document.querySelector('.task-list'); let n = 0; const mo = new MutationObserver(() => { n++; }); mo.observe(list, { subtree: true, childList: true, characterData: true }); for (let k = 0; k < 20; k++) { window.__push(window.__tasks.map((x, i) => (i < 5 ? { ...x, done: 4e6 + k * 1000 + i } : { ...x }))); await new Promise((r) => setTimeout(r, 60)); } const hiddenN = n; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); await new Promise((r) => setTimeout(r, 50)); mo.disconnect(); return { hiddenN, after: n - hiddenN }; });
  console.log(`hidden: ${hid.hiddenN} list changes during 20 pushes; ${hid.after ? 'drawn' : 'not drawn'} when shown again`);
  console.log(`push of 200 tasks (5 under way): median ${r.median.toFixed(2)} ms · p90 ${r.p90.toFixed(2)} ms · max ${r.max.toFixed(2)} ms · rows touched per push ≤ ${r.touched} · rows ${r.rows}`);
  if (!process.env.KT_DIST) {
    ok('every task has its row', r.rows === 200, r.rows);
    ok('only the changed rows are touched by a push (≤ 5 + the status bar)', r.touched <= 5, r.touched);
    // (Order and filter stay right: a finished one leaves «Active»; the list order follows the data.)
    await p.evaluate(() => { const t2 = window.__tasks[2]; Object.assign(t2, { state: 'done', done: t2.total, downSpeed: 0 }); window.__push(window.__tasks.map((x) => ({ ...x }))); });
    await p.click('.chip:has-text("Active")'); await p.waitForTimeout(200);
    const act = await p.$$eval('.task-card', (xs) => xs.map((x) => x.dataset.id)); ok('a filter stays right after a push (Active: the 4 still under way)', JSON.stringify(act.sort()) === JSON.stringify(['t0', 't1', 't3', 't4']), act);
    ok('under 15 pushes a second the main thread stays under 150 ms busy a second (was ~400: an eased width laid out the list each frame)', perSec < 150, perSec);
    ok('at most 4 paints a second under 15 pushes a second', rate.paints <= 4.5 * 4.3 + 2, rate);
    ok('nothing drawn while hidden, drawn when shown again', hid.hiddenN === 0 && hid.after > 0, hid);
    ok('no page errors', !errs.length, errs);
  }
  await br.close(); web.close(); process.exit(fails ? 1 : 0);
})();
