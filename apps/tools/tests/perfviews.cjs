// node tests/perfviews.cjs: the app's busiest screens under made-up loads, at phone size (CPU slowed 4×, the phone's
// plugin faked) and at PC size (the desktop bridge faked) — the Downloads list with 2,000 rows (opened, scrolled to the
// end, one row progressing under pushes of the whole list), Files with a folder of 5,000 (opened, scrolled to the end,
// all selected, the thumbnails asked for), Videos with 1,000 (phone; the computer has no video index), Settings
// (opened, a search typed), and every tab opened and left 20 times (the heap and the page's nodes after).
// Budgets are table-driven: counted work (rows in the page, rows touched, thumbnails asked, nodes, heap growth) and
// generous time limits, so a slow machine does not flake. KT_DIST=<another dist>: measure only (the «before»).
// KT_ONLY=<case name part>: those cases only. Stand-ins only, no network.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = process.env.KT_DIST || path.join(__dirname, '..', 'dist'); const BEFORE = !!process.env.KT_DIST;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };

// (The budgets: [phone, pc] for each measure; null = not measured there. Times in ms, generous — the counts carry the test.)
const BUDGET = {
  'downloads 2,000': { openMs: [4000, 2000], rows: [150, 150], scrollMaxFrameMs: [400, 200], scrollEndRows: [150, 150], pushMs: [40, 15], touched: [5, 5] },
  'files 5,000': { openMs: [4000, 2000], rows: [400, 400], scrollEndNodes: [8000, 8000], scrollMaxFrameMs: [600, 300], selectAllMs: [1500, 600], thumbsAtOpen: [120, 120] },
  'videos 1,000': { openMs: [4000, null], rows: [400, null], scrollMaxFrameMs: [600, null], thumbsAtOpen: [80, null] },
  'settings': { openMs: [3000, 1500], keyMs: [250, 80] },
  'tabs ×20': { heapGrowMB: [6, 6], nodesGrow: [300, 300] },
};

const STAND_IN = ({ kind, nTasks, nFiles, nVideos }) => {
  localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.pc.starter', '1'); localStorage.setItem('kt.update.lastCheck', String(Date.now()));
  localStorage.setItem('kt.settings', JSON.stringify({ addons: ['files', 'player', 'anime', 'tv', 'subtitles'], autoUpdateCheck: false }));
  const now = 1760000000000; const W = (window.__perf = { thumbs: 0, calls: 0, push: null });
  const ts = []; for (let i = 0; i < nTasks; i++) ts.push({ id: 't' + i, kind: 'http', name: `made-up-${String(i).padStart(4, '0')}.${i % 10 === 0 ? 'mkv' : 'bin'}`, source: { url: `https://example.test/${i}` }, dir: '/d', state: i < 5 ? 'downloading' : i % 50 === 0 ? 'failed' : 'done', done: i < 5 ? 1e6 * i : 5e6, total: 5e6, downSpeed: i < 5 ? 1e5 : 0, upSpeed: 0, files: [], addedAt: now - i * 1000, error: i % 50 === 0 && i >= 5 ? 'HTTP 404' : undefined });
  window.__tasks = ts; const cbs = new Set(); W.push = (x) => { for (const cb of cbs) cb(x); };
  const ext = ['jpg', 'mp4', 'txt', 'mkv', 'png', 'pdf', 'zip', 'mp3'];
  const big = []; for (let i = 0; i < nFiles; i++) big.push({ name: `file-${String(i).padStart(5, '0')}.${ext[i % ext.length]}`, dir: i < 20, size: 1000 + i * 37, mtime: now - i * 60000 });
  const entries = (dir) => big.map((e) => ({ ...e, name: e.dir ? `folder-${e.name.slice(5, 10)}` : e.name, path: `${dir}/${e.dir ? `folder-${e.name.slice(5, 10)}` : e.name}`, ext: e.dir ? undefined : e.name.split('.').pop(), count: e.dir ? 3 : undefined }));
  const vids = []; for (let i = 0; i < nVideos; i++) vids.push({ id: i + 1, path: `/sdcard/DCIM/Camera/clip-${i}.mp4`, name: `clip-${i}.mp4`, folder: 'Camera', duration: 60000 + i * 1000, size: 1e7 + i, width: 1920, height: 1080, mtime: now / 1000 - i });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  if (kind === 'pc') {
    window.kurokawaTools = new Proxy({ platform: 'desktop', available: true, os: 'linux', ready: async () => ({}), list: async () => ts, onTasks: (cb) => { cbs.add(cb); cb(ts); return () => cbs.delete(cb); }, defaultDir: async () => '/d',
      listDir: async (p) => { W.calls++; await wait(30); return { entries: entries(p).map(({ name, path, dir, size, mtime }) => ({ name, path, dir, size, mtime })) }; },
      fileUrl: async () => { W.thumbs++; return null; } }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) });
  } else {
    const ls = {};
    const api = {
      addListener: async (ev, fn) => { (ls[ev] = ls[ev] || []).push(fn); if (ev === 'tasksChanged') cbs.add((x) => fn({ tasks: x })); return { remove() { ls[ev] = (ls[ev] || []).filter((f) => f !== fn); } }; },
      list: async () => ({ tasks: ts }),
      filesRoots: async () => ({ allFiles: true, roots: [{ kind: 'phone', path: '/storage/emulated/0', name: 'Phone', readable: true, free: 12e9, total: 64e9 }] }),
      filesList: async ({ path }) => { W.calls++; await wait(30); return { exists: true, entries: entries(path) }; },
      filesThumb: async () => { W.thumbs++; return { url: null }; }, filesAccess: async () => ({ all: true }), filesCollection: async () => ({ entries: [] }),
      mediaAccess: async () => ({ granted: true }), mediaVideos: async () => { await wait(30); return { videos: vids }; }, videoThumb: async () => { W.thumbs++; return { url: null }; },
    };
    const plugin = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
  }
};

(async () => {
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`; const br = await chromium.launch();
  const open = async (kind, data) => {
    const ctx = await br.newContext(kind === 'phone' ? { viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true } : { viewport: { width: 1366, height: 768 } });
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 404, body: '' }));
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    const cdp = await ctx.newCDPSession(p); await cdp.send('Performance.enable');
    if (kind === 'phone') await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await p.addInitScript(STAND_IN, { kind, nTasks: 0, nFiles: 0, nVideos: 0, ...data });
    const metric = async (n) => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === n).value;
    const heapMB = async () => { await cdp.send('HeapProfiler.collectGarbage').catch(() => undefined); return (await metric('JSHeapUsedSize')) / 1048576; };
    return { ctx, p, errs, metric, heapMB };
  };
  // (Opening a place: from the hash set till its rows are on screen, a frame drawn after.)
  const goTo = (p, hash, sel, n) => p.evaluate(async ({ hash, sel, n }) => { const t0 = performance.now(); location.hash = hash; await new Promise((res) => { const tick = () => (document.querySelectorAll(sel).length >= n ? requestAnimationFrame(() => res()) : setTimeout(tick, 5)); tick(); }); return performance.now() - t0; }, { hash, sel, n });
  // (Scrolled to the end a screen at a time, a frame each, till it no longer moves: the longest frame, the time.)
  const scrollEnd = (p) => p.evaluate(async () => {
    const pick = () => { const c = [...document.querySelectorAll('#app .view .body, #app .view, #app .files-list, #app [class*=list]')].filter((e) => e.scrollHeight > e.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)); return c.sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || document.scrollingElement; };
    let max = 0; let last = performance.now(); const t0 = last; let still = 0; let steps = 0;
    while (still < 8 && steps < 600) { const el = pick(); const before = el.scrollTop; el.scrollTop = before + el.clientHeight; await new Promise((r) => requestAnimationFrame(() => r())); const now = performance.now(); max = Math.max(max, now - last); last = now; steps++; still = el.scrollTop === before ? still + 1 : 0; if (still) await new Promise((r) => setTimeout(r, 30)); }
    return { maxFrame: max, ms: performance.now() - t0, steps };
  });
  const R = {}; const only = process.env.KT_ONLY;
  const want = (n) => !only || n.includes(only);
  const put = (name, kind, r) => { (R[name] ??= {})[kind] = r; console.log(`${name} · ${kind}: ${Object.entries(r).filter(([k]) => k !== 'errs').map(([k, v]) => `${k} ${typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(1)) : v}`).join(' · ')}`); };

  for (const kind of ['phone', 'pc']) {
    if (want('downloads')) {
      const { ctx, p, errs } = await open(kind, { nTasks: 2000 });
      await p.goto(base + '#/settings'); await p.waitForSelector('.settings-search');
      const openMs = await goTo(p, '#/', '.task-card', 10); await p.waitForTimeout(500);
      const rows = await p.$$eval('.task-card', (x) => x.length);
      const sc = await scrollEnd(p); const endRows = await p.$$eval('.task-card', (x) => x.length); const last = await p.$$eval('.task-card', (x) => x.some((c) => c.dataset.id === 't1999'));
      await p.evaluate(() => { const el = document.querySelector('#app .view .body') || document.scrollingElement; el.scrollTop = 0; window.scrollTo(0, 0); }); await p.waitForTimeout(300);
      // (A push of the whole list, the 5 under way moved on: the time its handler and the layout it forces take; the rows it touched.)
      const push = await p.evaluate(async () => {
        const list = document.querySelector('.task-list'); let touched = new Set(); const mo = new MutationObserver((ms) => { for (const m of ms) { const c = (m.target.nodeType === 1 ? m.target : m.target.parentElement)?.closest?.('.task-card'); if (c) touched.add(c.dataset.id); } }); mo.observe(list, { subtree: true, childList: true, characterData: true, attributes: true });
        const times = []; let most = 0;
        for (let k = 0; k < 30; k++) { const next = window.__tasks.map((x, i) => (i < 5 ? { ...x, done: Math.min(x.total, x.done + 30000 * (k + 1)), downSpeed: 1e5 + k * 10 + i } : x)); touched = new Set(); const t0 = performance.now(); window.__perf.push(next); void document.body.offsetHeight; times.push(performance.now() - t0); await new Promise((r) => setTimeout(r, 300)); mo.takeRecords(); if (k > 3) most = Math.max(most, touched.size); }
        mo.disconnect(); times.sort((a, b) => a - b); return { median: times[15], touched: most };
      });
      put('downloads 2,000', kind, { openMs, rows, scrollMaxFrameMs: sc.maxFrame, scrollMs: sc.ms, scrollEndRows: endRows, lastRowReached: last ? 1 : 0, pushMs: push.median, touched: push.touched, errs: errs.length });
      await ctx.close();
    }
    if (want('files')) {
      const { ctx, p, errs } = await open(kind, { nFiles: 5000 });
      await p.goto(base + '#/'); await p.waitForSelector('.downloads-view');
      await p.evaluate(() => { location.hash = '#/files'; }); await p.waitForSelector('.files-view'); await p.waitForTimeout(600);
      const dir = kind === 'pc' ? '/home/me/Big' : '/storage/emulated/0/Big';
      await p.evaluate(() => { window.__perf.thumbs = 0; });
      const openMs = await goTo(p, '#/files?p=' + encodeURIComponent(dir), '.files-view .files-row', 20); await p.waitForTimeout(800);
      const rows = await p.$$eval('.files-view .files-row', (x) => x.length); const thumbsAtOpen = await p.evaluate(() => window.__perf.thumbs);
      const sc = await scrollEnd(p); await p.waitForTimeout(300);
      const endNodes = await p.evaluate(() => document.getElementsByTagName('*').length); const thumbsAfterScroll = await p.evaluate(() => window.__perf.thumbs);
      const lastRow = await p.$$eval('.files-view .files-row', (x) => x.some((e) => /file-04999/.test(e.textContent)));
      // (All selected: by the keyboard on a computer, from the selection's own menu on a phone — the time till the bar says 4,980.)
      const selectAllMs = await p.evaluate(async (kind) => {
        const t0 = performance.now(); const two = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        if (kind === 'pc') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
        else { document.querySelector('.files-view .files-row').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await two(); [...document.querySelectorAll('.files-view button')].find((b) => b.getAttribute('aria-label') === 'Select all')?.click(); }
        await two();
        return { ms: performance.now() - t0, sel: document.querySelectorAll('.files-view .files-row.picked').length, bar: (document.querySelector('.files-view .files-selcount')?.textContent || '') };
      }, kind);
      put('files 5,000', kind, { openMs, rows, thumbsAtOpen, scrollMaxFrameMs: sc.maxFrame, scrollMs: sc.ms, scrollEndNodes: endNodes, thumbsAfterScroll, lastRowReached: lastRow ? 1 : 0, selectAllMs: selectAllMs.ms, selectedShown: selectAllMs.sel, selCount: Number((selectAllMs.bar.match(/[\d,]+/) || ['0'])[0].replace(/,/g, '')), errs: errs.length });
      if (process.env.KT_DETAIL) console.log('   select bar:', selectAllMs.bar);
      await ctx.close();
    }
    if (want('videos') && kind === 'phone') {
      const { ctx, p, errs } = await open(kind, { nVideos: 1000 });
      await p.goto(base + '#/'); await p.waitForSelector('.downloads-view');
      const openMs = await goTo(p, '#/videos?tab=phone&folder=Camera', '.videos-view .video-row', 5); await p.waitForTimeout(800);
      const rows = await p.evaluate(() => document.querySelectorAll('.videos-view .video-row').length); const thumbsAtOpen = await p.evaluate(() => window.__perf.thumbs);
      const sc = await scrollEnd(p); const endNodes = await p.evaluate(() => document.getElementsByTagName('*').length);
      put('videos 1,000', kind, { openMs, rows, thumbsAtOpen, scrollMaxFrameMs: sc.maxFrame, scrollMs: sc.ms, scrollEndNodes: endNodes, thumbsAfterScroll: await p.evaluate(() => window.__perf.thumbs), errs: errs.length });
      await ctx.close();
    }
    if (want('settings')) {
      const { ctx, p, errs } = await open(kind, {});
      await p.goto(base + '#/'); await p.waitForSelector('.downloads-view'); await p.waitForTimeout(500);
      const openMs = await goTo(p, '#/settings', '.settings-view .settings-search', 1); await p.waitForTimeout(400);
      // (A search typed a letter at a time: each letter's handler and the layout it forces.)
      const keys = await p.evaluate(async () => { const s = document.querySelector('.settings-search'); const out = []; for (const ch of 'download folder') { const t0 = performance.now(); s.value += ch; s.dispatchEvent(new Event('input', { bubbles: true })); void document.body.offsetHeight; out.push(performance.now() - t0); await new Promise((r) => setTimeout(r, 30)); } out.sort((a, b) => a - b); return { median: out[Math.floor(out.length / 2)], max: out[out.length - 1] }; });
      put('settings', kind, { openMs, keyMs: keys.median, keyMaxMs: keys.max, errs: errs.length });
      await ctx.close();
    }
    if (want('tabs')) {
      const { ctx, p, errs, heapMB, metric } = await open(kind, { nTasks: 200, nFiles: 300, nVideos: 100 });
      const TABS = ['#/', '#/files', '#/videos', '#/search', '#/anime', '#/tv', '#/subs', '#/settings'];
      await p.goto(base + '#/'); await p.waitForSelector('.downloads-view'); await p.waitForTimeout(600);
      const round = async () => { for (const h of TABS) { await p.evaluate((x) => { location.hash = x; }, h); await p.waitForTimeout(kind === 'phone' ? 140 : 80); } };
      await round(); await round(); await p.waitForTimeout(500);
      const h0 = await heapMB(); const n0 = await metric('Nodes'); const l0 = await metric('JSEventListeners');
      for (let i = 0; i < 20; i++) await round();
      await p.evaluate(() => { location.hash = '#/'; }); await p.waitForTimeout(800);
      const h1 = await heapMB(); const n1 = await metric('Nodes'); const l1 = await metric('JSEventListeners');
      put('tabs ×20', kind, { heapMB: h0, heapGrowMB: h1 - h0, nodesGrow: n1 - n0, listenersGrow: l1 - l0, errs: errs.length });
      await ctx.close();
    }
  }
  if (!BEFORE) {
    const k = { phone: 0, pc: 1 };
    for (const [name, b] of Object.entries(BUDGET)) for (const kind of ['phone', 'pc']) {
      const r = R[name]?.[kind]; if (!r) continue;
      for (const [m, lim] of Object.entries(b)) { const L = lim[k[kind]]; if (L === null || r[m] === undefined) continue; ok(`${name} · ${kind}: ${m} ${typeof r[m] === 'number' ? r[m].toFixed(1) : r[m]} ≤ ${L}`, r[m] >= 0 && r[m] <= L, r); }
      if (r.lastRowReached !== undefined) ok(`${name} · ${kind}: scrolled to the end, the last row there`, r.lastRowReached === 1);
      if (name === 'files 5,000') ok(`${name} · ${kind}: «select all» picked every entry (the bar counts 5,000)`, r.selCount === 5000 && r.selectedShown > 0, r);
      ok(`${name} · ${kind}: no page errors`, !r.errs);
    }
  }
  await br.close(); web.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
