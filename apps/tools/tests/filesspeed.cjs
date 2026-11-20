// The Files page's time to first rows on a phone (360×800): a folder of 5,000 entries (1,000 of them folders) whose listing
// answers in 20 ms and whose folder counts cost 5 ms each. Held to a budget: the first rows painted soon after the listing,
// the listing asked WITHOUT counts, the counts asked only for the folders on screen (and one screenful ahead — at most 40
// paths before any scroll), the next ones when scrolled to, none more once the folder is left, and none again on coming back.
// (Times are measured with performance marks, never slept on; the limits are generous, for a slow CI box.)
// Run: NODE_PATH=$(npm root -g) node tests/filesspeed.cjs
const { chromium } = require('playwright'); const F = require('./filesphone-fixture.cjs'); const { K } = F;
let fails = 0; const ok = (what, cond, x) => { console.log((cond ? 'ok   ' : 'FAIL ') + what + (cond || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!cond) fails++; };
const FIRST_ROWS_MS = 250;

function extra({ K }) {
  const T = 1760000000000; const W = `${K}/Wide`; const put = window.__put; put(W, true);
  const entries = []; for (let i = 0; i < 5000; i++) { const n = String(i).padStart(4, '0'); const dir = i % 5 === 0; entries.push({ name: dir ? `folder ${n}` : `doc ${n}.txt`, path: `${W}/${dir ? 'folder' : 'doc'} ${n}${dir ? '' : '.txt'}`, dir, size: dir ? 0 : 1000 + i, mtime: T - i * 6e4, ext: dir ? undefined : 'txt' }); }
  const ctl = window.__ctl = { lists: [], asks: [], inflight: 0 }; const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const base = window.Capacitor.Plugins.KurokawaTools; const baseList = base.filesList;
  const over = {
    filesList: async (o) => { if (o.path !== W) return baseList(o); ctl.lists.push({ path: o.path, counts: o.counts }); await nap(20); return { exists: true, entries: entries.map((e) => ({ ...e })) }; },
    filesCounts: async ({ paths }) => { ctl.asks.push(...paths); ctl.inflight++; const counts = {}; for (const p of paths) { await nap(5); counts[p] = 1 + (p.length % 7); } ctl.inflight--; return { counts }; },
  };
  window.Capacitor.Plugins.KurokawaTools = new Proxy(base, { get: (t, k) => (k in over ? over[k] : t[k]) });
  localStorage.setItem('kt.files.prefs', JSON.stringify({ view: 'list', sort: 'name', desc: false, hidden: false, kind: 'all', last: K, thumbs: false, counts: true }));
}

(async () => {
  const z = await F.zipListing(); const srv = await F.serve(); const port = srv.address().port; const browser = await chromium.launch();
  const { page: p, errors } = await F.open(browser, { lang: 'en', z, width: 360, height: 800 }); await p.addInitScript(extra, { K });
  const W = `${K}/Wide`; const rAF = () => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const quiet = async () => { await p.waitForFunction(() => window.__ctl.inflight === 0); for (let i = 0; i < 12; i++) await rAF(); await p.waitForFunction(() => window.__ctl.inflight === 0); };
  await p.goto(`http://localhost:${port}/#/files?p=${encodeURIComponent(K)}`); await p.waitForSelector('.files-view .files-row');
  // 1. navigation → first rows
  const ms = await p.evaluate((w) => new Promise((res) => {
    performance.mark('nav'); const done = () => { if (document.querySelector('.files-view .files-row[data-p^="' + w + '/"]')) { performance.mark('rows'); res(performance.measure('first', 'nav', 'rows').duration); return true; } return false; };
    const mo = new MutationObserver(() => { if (done()) mo.disconnect(); }); mo.observe(document.body, { childList: true, subtree: true }); location.hash = `/files?p=${encodeURIComponent(w)}`;
  }), W);
  console.log(`     first rows painted ${ms.toFixed(0)} ms after navigating (the listing answers in 20 ms)`);
  ok(`first rows within ${FIRST_ROWS_MS} ms (${ms.toFixed(0)})`, ms <= FIRST_ROWS_MS);
  ok('the listing was asked without counts', await p.evaluate(() => window.__ctl.lists.length > 0 && window.__ctl.lists.every((l) => l.counts === false)), await p.evaluate(() => window.__ctl.lists));
  // 2. counts for what is on screen only
  await p.waitForFunction(() => window.__ctl.asks.length > 0 && !!document.querySelector('.files-row small.src') && /item/.test(document.querySelector('.files-row[data-p] small.src').textContent)); await quiet();
  const first = await p.evaluate(() => window.__ctl.asks.slice()); ok(`before any scroll: 1..40 folders asked (${first.length})`, first.length >= 1 && first.length <= 40, first.length);
  ok('the numbers filled into the rows', await p.evaluate(() => /\d+ items?/.test(document.querySelector('.files-row[data-p] small.src').textContent)));
  // 3. scrolling asks for the next ones
  const sc = () => p.evaluate((y) => { const b = document.querySelector('.files-body'); const e = b.scrollHeight > b.clientHeight + 1 ? b : document.scrollingElement; e.scrollTop = y; }, 6000);
  await sc(); await p.waitForFunction((n) => window.__ctl.asks.length > n, first.length); await quiet();
  const second = await p.evaluate(() => window.__ctl.asks.slice()); ok(`scrolling asked for further folders (${first.length} → ${second.length})`, second.length > first.length && new Set(second).size === second.length, second.length);
  // 4. a far jump, then leaving at once: nothing more is asked
  await p.evaluate(() => { const b = document.querySelector('.files-body'); const e = b.scrollHeight > b.clientHeight + 1 ? b : document.scrollingElement; e.scrollTop = 30000; });
  await p.waitForFunction((n) => window.__ctl.asks.length > n, second.length); await p.evaluate((h) => { location.hash = h; }, `/files?p=${encodeURIComponent(K)}`);
  await p.waitForFunction((k) => decodeURIComponent(location.hash).endsWith(k), K); await quiet(); const left = await p.evaluate(() => window.__ctl.asks.length);
  for (let i = 0; i < 20; i++) await rAF(); ok('after leaving: no further asks', await p.evaluate((n) => window.__ctl.asks.length === n, left));
  // 5. coming back: the counts are kept — the first folders show theirs at the first paint, and asking them again never happens
  await p.evaluate((h) => { location.hash = h; }, `/files?p=${encodeURIComponent(W)}`); await p.waitForSelector('.files-view .files-row[data-p^="' + W + '/"]');
  await p.evaluate(() => { const b = document.querySelector('.files-body'); b.scrollTop = 0; window.scrollTo(0, 0); }); await rAF();
  ok('coming back: the first folders show their counts at once', await p.evaluate(() => { const r = [...document.querySelectorAll('.files-row[data-p*="/folder "]')].slice(0, 12); return r.length === 12 && r.every((x) => /\d+ items?/.test(x.querySelector('small.src').textContent)); }));
  await quiet(); const back = await p.evaluate(() => window.__ctl.asks.slice());
  ok(`coming back: no folder asked twice (${back.length} asks in all)`, new Set(back).size === back.length);
  ok('coming back: none of the folders already counted asked again', back.slice(left).every((x) => !first.includes(x) && !second.slice(0, left).includes(x)), back.slice(left).length);
  const errs = errors.filter((e) => !/favicon/.test(e)); ok('no page errors', !errs.length, errs);
  await browser.close(); srv.close(); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
