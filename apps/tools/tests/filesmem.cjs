// The Files page's memory on a phone (360×800, pictures on): a folder of 5,000 mixed entries (folders, pictures, videos,
// documents) whose pictures are real small JPEGs; the JS heap (after a collection), the page's DOM nodes and its <img>
// count measured after opening it, after scrolling to its end and back, after visiting 20 more folders of pictures,
// and after leaving for another tab and coming back. The numbers are printed (FILESMEM_JSON=1: as JSON) and held to a
// budget, so the page cannot grow back into what Android ends to free memory.
// Run: NODE_PATH=$(npm root -g) node tests/filesmem.cjs
// (No element handles are taken — waitForSelector's would keep a left page alive and be counted as held.)
const { chromium } = require('playwright'); const F = require('./filesphone-fixture.cjs'); const { K } = F;
let fails = 0; const ok = (what, cond, x) => { console.log((cond ? 'ok   ' : 'FAIL ') + what + (cond || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!cond) fails++; };
// (The budget, with room above what the page uses now: nodes and heap after the whole round trip.)
const BUDGET = { live: 5000, detached: 1500, heapMB: 20, imgs: 400 };

function extra({ K }) {
  const T = 1760000000000; const put = window.__put;
  put(`${K}/Big`, true);
  for (let i = 0; i < 5000; i++) { const k = i % 25; const n = String(i).padStart(4, '0'); if (k === 0) put(`${K}/Big/folder ${n}`, true); else if (k < 16) put(`${K}/Big/photo ${n}.jpg`, false, 2e6 + i, T - i * 6e4); else if (k < 21) put(`${K}/Big/clip ${n}.mp4`, false, 5e7 + i, T - i * 6e4); else put(`${K}/Big/notes ${n}.txt`, false, 1e3 + i, T - i * 6e4); }
  for (let f = 0; f < 20; f++) { put(`${K}/Pics${f}`, true); for (let i = 0; i < 250; i++) put(`${K}/Pics${f}/img ${String(i).padStart(3, '0')}.jpg`, false, 3e6 + i, T - i * 6e4); }
  const base = window.Capacitor.Plugins.KurokawaTools; window.__thumbs = 0;
  const pic = (seed, px) => { const c = document.createElement('canvas'); c.width = px; c.height = px; const g = c.getContext('2d'); let s = seed; for (let y = 0; y < px; y += 8) for (let x = 0; x < px; x += 8) { s = (s * 1103515245 + 12345) & 0x7fffffff; g.fillStyle = `rgb(${s & 255},${(s >> 8) & 255},${(s >> 16) & 255})`; g.fillRect(x, y, 8, 8); } return c.toDataURL('image/jpeg', 0.8); };
  const over = { filesThumb: async ({ path: p, px }) => { window.__thumbs++; let h = 7; for (const ch of p) h = (h * 31 + ch.charCodeAt(0)) | 0; return { url: pic(Math.abs(h), Math.min(px, 160)) }; } };
  window.Capacitor.Plugins.KurokawaTools = new Proxy(base, { get: (t, k) => (k in over ? over[k] : t[k]) });
  localStorage.setItem('kt.files.prefs', JSON.stringify({ view: 'list', sort: 'name', desc: false, hidden: false, kind: 'all', last: K, thumbs: true }));
}

(async () => {
  const z = await F.zipListing(); const srv = await F.serve(); const port = srv.address().port; const browser = await chromium.launch();
  const { page: p, errors } = await F.open(browser, { lang: 'en', z, width: 360, height: 800 }); await p.addInitScript(extra, { K });
  const cdp = await p.context().newCDPSession(p); await cdp.send('Performance.enable');
  const measure = async (label) => {
    await cdp.send('HeapProfiler.collectGarbage'); await cdp.send('HeapProfiler.collectGarbage');
    const m = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
    const [imgs, asked] = await p.evaluate(() => [document.querySelectorAll('img').length, window.__thumbs]);
    // (DOM nodes still held once they are out of the page — what would stay after Android asks for memory —: counted in a
    // heap snapshot, which collects all garbage first; the «Nodes» metric also counts garbage not yet collected.)
    const chunks = []; const on = (e) => chunks.push(e.chunk); cdp.on('HeapProfiler.addHeapSnapshotChunk', on); await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }); cdp.off('HeapProfiler.addHeapSnapshotChunk', on);
    const snap = JSON.parse(chunks.join('')); const NF = snap.snapshot.meta.node_fields.length, iDet = snap.snapshot.meta.node_fields.indexOf('detachedness'); let detached = 0; for (let i = iDet; i < snap.nodes.length; i += NF) if (snap.nodes[i] === 2) detached++;
    const live = await p.evaluate(() => document.getElementsByTagName('*').length);
    const r = { label, live, detached, heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1), nodes: m.Nodes, imgs, asked, docs: m.Documents, listeners: m.JSEventListeners };
    console.log('     ' + JSON.stringify(r)); return r;
  };
  const settle = () => p.evaluate(() => new Promise((r) => { let n = 0; const f = () => { const w = window.__thumbs; setTimeout(() => { if (window.__thumbs === w && ++n > 2) r(); else f(); }, 120); }; f(); }));
  const go = async (dir) => { await p.evaluate((h) => { location.hash = h; }, `/files?p=${encodeURIComponent(dir)}`); await p.waitForFunction((d) => decodeURIComponent(location.hash).endsWith(d) && !!document.querySelector('.files-view .files-row'), dir); };
  const scrollEnd = async () => {
    for (let i = 0; i < 400; i++) {
      const done = await p.evaluate(() => { const b = document.querySelector('.files-body'); const sc = b.scrollHeight > b.clientHeight + 1 ? b : document.scrollingElement; sc.scrollTop += 2400; return !document.querySelector('.files-more-sentinel') && sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2; });
      await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); if (done) break;
    }
  };
  const top = () => p.evaluate(() => { const b = document.querySelector('.files-body'); b.scrollTop = 0; window.scrollTo(0, 0); });
  await p.goto(`http://localhost:${port}/#/files?p=${encodeURIComponent(`${K}/Big`)}`); await p.waitForFunction((q) => !!document.querySelector(q), '.files-row'); await settle();
  const a = await measure('opened 5,000');
  await scrollEnd(); await settle(); await top(); await settle();
  const b = await measure('end and back');
  for (let f = 0; f < 20; f++) { await go(`${K}/Pics${f}`); await p.evaluate(() => { const b = document.querySelector('.files-body'); (b.scrollHeight > b.clientHeight + 1 ? b : document.scrollingElement).scrollTop = 3000; }); await settle(); }
  const c = await measure('20 folders of pictures');
  // (The big folder scrolled half way, another tab, then back: the page kept for it comes back as it was, not drawn whole.)
  await go(`${K}/Big`); await p.evaluate(() => { const b = document.querySelector('.files-body'); (b.scrollHeight > b.clientHeight + 1 ? b : document.scrollingElement).scrollTop = 60000; }); await settle();
  const back = await p.evaluate(() => location.hash);
  await p.evaluate(() => { location.hash = '/search'; }); await p.waitForFunction(() => !document.querySelector('.files-view')?.isConnected); await p.evaluate(() => new Promise((r) => setTimeout(r, 300)));
  await p.evaluate((h) => { location.hash = h; }, back); await p.waitForFunction((q) => !!document.querySelector(q), '.files-view .files-row');
  const peak = await p.evaluate(() => new Promise((r) => { let m = 0, n = 0; const f = () => { m = Math.max(m, document.getElementsByTagName('*').length); if (++n < 30) requestAnimationFrame(f); else r(m); }; f(); }));
  console.log('     peak elements on coming back: ' + peak); await settle();
  const d = await measure('another tab, back'); d.peak = peak; ok(`coming back to the kept page: at most ${BUDGET.live} elements at any frame (${peak})`, peak <= BUDGET.live);
  if (process.env.FILESMEM_JSON) console.log(JSON.stringify({ a, b, c, d }));
  for (const r of [b, c, d]) ok(`${r.label}: elements ${r.live} ≤ ${BUDGET.live}, held out of the page ${r.detached} ≤ ${BUDGET.detached}, heap ${r.heapMB} MB ≤ ${BUDGET.heapMB}, pictures ${r.imgs} ≤ ${BUDGET.imgs}`, r.live <= BUDGET.live && r.detached <= BUDGET.detached && r.heapMB <= BUDGET.heapMB && r.imgs <= BUDGET.imgs);
  const errs = errors.filter((e) => !/favicon/.test(e)); ok('no page errors', !errs.length, errs);
  await browser.close(); srv.close(); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
