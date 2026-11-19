// «Everywhere in my folders» (views/filesearch.ts) on a computer with the Tauri shell, through the real
// desktop-tauri/bridge.js over a pretend Tauri IPC whose file index is made-up names in the page: no folder chosen →
// «Choose folders to search» opens the sheet; a folder added, one inside it and one around it refused with their
// reasons; the looking-through shown with its count; typing searches as you type (debounced, the newest search
// winning over a slower older one); the hits rendered with the match marked and their folder isolated, the list
// virtual (ten thousand hits, a few dozen rows in the page, smooth scrolling); the kind, size and date chips and the
// sort build the query the shell is sent; Show in folder walks the Files page there; no results; the sheet's Remove,
// Rebuild, Remove index (asked first) and pause; nothing of it on a phone, in Electron or on the web; right to left in
// Arabic; and nothing left behind once closed (listeners, observers, the state's polling).
// Run: NODE_PATH=$(npm root -g) node tests/filesearch.cjs [en|ar]   (screenshots: KT_SHOTS=<folder>)
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const BRIDGE = fs.readFileSync(path.join(__dirname, '..', 'desktop-tauri', 'bridge.js'), 'utf8');
const SHOTS = process.env.KT_SHOTS || '';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = () => http.createServer((req, r) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); r.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(r); });
let fails = 0; const ok = (what, cond, x) => { console.log((cond ? 'ok   ' : 'FAIL ') + what + (cond || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!cond) fails++; };

/** In the page, before the bridge: a pretend Tauri IPC — a folder to list and a file index of made-up names. */
function fakeTauri({ lang }) {
  localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.pc.starter', '1');
  localStorage.setItem('kt.settings', JSON.stringify({ addons: ['files'] }));
  localStorage.setItem('kt.files.prefs', JSON.stringify({ view: 'list', sort: 'name', desc: false, hidden: false, kind: 'all' }));
  localStorage.removeItem('kt.fsearch.ui');
  // (The leak check's counters: listeners on the panel's own nodes and the page's kt:filesearch, observers made and let go.)
  const live = (window.__live = { scroll: 0, keydown: 0, input: 0, fsEvent: 0, ro: 0 });
  const add = EventTarget.prototype.addEventListener; const rem = EventTarget.prototype.removeEventListener;
  const tag = (t, type) => (t && t.classList && (t.classList.contains('fs-scroll') || t.classList.contains('fs-input')) && type in live ? type : t === window && type === 'kt:filesearch' ? 'fsEvent' : null);
  EventTarget.prototype.addEventListener = function (type, fn, o) { const k = tag(this, type); if (k) live[k]++; return add.call(this, type, fn, o); };
  EventTarget.prototype.removeEventListener = function (type, fn, o) { const k = tag(this, type); if (k) live[k]--; return rem.call(this, type, fn, o); };
  const RO = window.ResizeObserver; window.ResizeObserver = class extends RO { constructor(f) { super(f); this.__on = false; } observe(x) { if (!this.__on && x.classList?.contains('fs-scroll')) { this.__on = true; live.ro++; } return super.observe(x); } disconnect() { if (this.__on) { this.__on = false; live.ro--; } return super.disconnect(); } };
  // (The index: 12 000 made-up names in folders under /home/u/Media; kinds by extension.)
  const KIND = { mkv: 'video', mp4: 'video', flac: 'audio', mp3: 'audio', jpg: 'picture', png: 'picture', pdf: 'document', txt: 'document', zip: 'archive' };
  const words = ['report', 'holiday', 'lecture', 'budget', 'episode', 'draft', 'summary', 'scan', 'تقرير', 'رحلة'];
  const exts = Object.keys(KIND); const all = [];
  for (let i = 0; i < 12000; i++) { const w = words[i % words.length]; const e = exts[(i * 7) % exts.length]; const dir = `/home/u/Media/Group ${String(i % 40).padStart(2, '0')}`; all.push({ name: `${w} ${String(i).padStart(5, '0')}.${e}`, path: `${dir}/${w} ${String(i).padStart(5, '0')}.${e}`, dir, size: (i * 7919) % (3 * 2 ** 30), mtime: 1760000000000 - (i % 400) * 86400000, folder: false, link: false, kind: KIND[e] }); }
  for (let g = 0; g < 40; g++) all.push({ name: `Group ${String(g).padStart(2, '0')}`, path: `/home/u/Media/Group ${String(g).padStart(2, '0')}`, dir: '/home/u/Media', size: 0, mtime: 1760000000000, folder: true, link: false, kind: 'folder' });
  const fsx = (window.__fs = { roots: [], busy: false, polls: 0, walkPolls: 0, paused: false, pauseOnBattery: true, queries: [], calls: [], pick: null, slow: {} });
  const under = (a, b) => a === b || a.startsWith(b + '/');
  const status = () => ({ running: fsx.roots.length > 0, busy: fsx.busy, paused: fsx.paused, pauseOnBattery: fsx.pauseOnBattery, onBattery: false, batteryPaused: false, entries: fsx.busy ? 0 : all.length, folders: 40, files: 12000, memory: 1300000, fileBytes: fsx.busy ? 0 : 620000, note: null,
    progress: { entries: fsx.busy ? 1500 + fsx.polls * 10 : 0, current: fsx.roots[0]?.path ?? '' }, roots: fsx.roots.map((r) => ({ path: r.path, entries: fsx.busy ? 0 : all.length, walked: !fsx.busy, lastWalk: fsx.busy ? 0 : 1760000000000, unreadable: 0, exclude: r.exclude })), excludeNames: [] });
  const query = (o) => {
    const ws = o.text.toLowerCase().split(/\s+/).filter(Boolean);
    let m = all.filter((x) => ws.every((w) => x.name.toLowerCase().includes(w)) && (!o.kinds || o.kinds.includes(x.kind)) && (o.sizeMin === undefined || x.size >= o.sizeMin) && (o.sizeMax === undefined || x.size <= o.sizeMax) && (o.after === undefined || x.mtime >= o.after) && (o.before === undefined || x.mtime <= o.before));
    const by = { name: (a, b) => a.name.localeCompare(b.name), size: (a, b) => a.size - b.size, date: (a, b) => a.mtime - b.mtime, path: (a, b) => a.path.localeCompare(b.path) }[o.sort];
    if (by) { m = m.slice().sort(by); if (o.desc) m.reverse(); }
    fsx.lastTotal = m.length; return { total: m.length, micros: 1234, hits: m.slice(0, o.limit) };
  };
  const replies = {
    kt_state: () => ({ available: false, reason: '', os: 'linux', arch: 'x64' }), kt_list: () => [], kt_default_dir: () => '/home/u/Downloads', kt_roots: () => ({ roots: ['/home/u'] }),
    kt_home_dir: () => '/home/u',
    kt_files_roots: () => ({ allFiles: true, roots: [{ kind: 'home', path: '/home/u', name: 'u', readable: true }] }),
    kt_list_dir: (a) => { const p = a.p.replace(/\/+$/, ''); const kids = all.filter((x) => x.dir === p).slice(0, 50); return { exists: true, entries: p === '/home/u' ? [{ name: 'Media', path: '/home/u/Media', dir: true, size: 0, mtime: 1760000000000 }, { name: 'notes.txt', path: '/home/u/notes.txt', dir: false, size: 12, mtime: 1760000000000 }] : kids.map((x) => ({ name: x.name, path: x.path, dir: x.folder, size: x.size, mtime: x.mtime })) }; },
    kt_files_stat: (a) => ({ exists: true, name: a.o.path.split('/').pop(), path: a.o.path, dir: true, size: 0, mtime: 1, readable: true, writable: true, hidden: false }),
    kt_pick_dir: () => fsx.pick,
    kt_fsearch_status: () => { fsx.polls++; if (fsx.busy && fsx.walkPolls && fsx.polls >= fsx.walkPolls) fsx.busy = false; return status(); },
    kt_fsearch_query: (a) => { fsx.queries.push(a.o); if (!fsx.roots.length) return { idle: true }; const r = query(a.o); const ms = fsx.slow[a.o.text] ?? 5; return new Promise((ok) => setTimeout(() => ok(r), ms)); },
    kt_fsearch_add: (a) => { const p = a.o.path; for (const r of fsx.roots) { if (r.path === p) return { ok: false, reason: 'same', other: r.path }; if (under(p, r.path)) return { ok: false, reason: 'inside', other: r.path }; if (under(r.path, p)) return { ok: false, reason: 'holds', other: r.path }; } fsx.roots.push({ path: p, exclude: [] }); fsx.busy = true; fsx.polls = 0; return { ok: true }; },
    kt_fsearch_remove: (a) => { const n = fsx.roots.length; fsx.roots = fsx.roots.filter((r) => r.path !== a.o.path); return { ok: fsx.roots.length < n }; },
    kt_fsearch_exclude: (a) => { const r = fsx.roots.find((x) => x.path === a.o.root); if (!r) return { ok: false, reason: 'noRoot' }; if (a.o.remove) { r.exclude = r.exclude.filter((e) => e !== a.o.path); return { ok: true }; } if (!a.o.path.startsWith(a.o.root + '/')) return { ok: false, reason: 'outside' }; r.exclude.push(a.o.path); return { ok: true }; },
    kt_fsearch_rebuild: () => ({ ok: fsx.roots.length > 0 }),
    kt_fsearch_forget: () => { fsx.roots = []; return { ok: true }; },
    kt_fsearch_pause: (a) => { if (typeof a.o.paused === 'boolean') fsx.paused = a.o.paused; if (typeof a.o.pauseOnBattery === 'boolean') fsx.pauseOnBattery = a.o.pauseOnBattery; return status(); },
  };
  const ls = {};
  window.__TAURI__ = {
    core: { invoke: (c, a) => { fsx.calls.push([c, JSON.parse(JSON.stringify(a || {}))]); try { return Promise.resolve(replies[c] ? replies[c](a || {}) : null); } catch (e) { return Promise.reject(e); } } },
    event: { listen: (n, f) => { (ls[n] = ls[n] || []).push(f); return Promise.resolve(() => undefined); } },
  };
  window.__KT_BOOT__ = { os: 'linux', arch: 'x64' };
}

(async () => {
  const only = process.argv[2]; const langs = only ? [only] : ['en', 'ar'];
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch(); const S = (lang) => { const esb = require('esbuild'); const out = esb.buildSync({ entryPoints: [path.join(__dirname, '..', 'src/i18n', `${lang}.ts`)], bundle: true, write: false, format: 'cjs', platform: 'node' }); const m = { exports: {} }; new Function('module', 'exports', out.outputFiles[0].text)(m, m.exports); const en = (() => { const o = esb.buildSync({ entryPoints: [path.join(__dirname, '..', 'src/i18n/en.ts')], bundle: true, write: false, format: 'cjs', platform: 'node' }); const mm = { exports: {} }; new Function('module', 'exports', o.outputFiles[0].text)(mm, mm.exports); return mm.exports.en; })(); return { ...en, ...m.exports[lang] }; };
  const shot = async (page, name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }); };
  for (const lang of langs) {
    const T = S(lang); const L = (s) => `[${lang}] ${s}`; const fill = (s, v) => Object.entries(v).reduce((a, [k, x]) => a.replaceAll(`{${k}}`, x), s);
    const page = await br.newPage({ viewport: { width: 1280, height: 800 } }); const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 404, body: '' }));
    await page.addInitScript(fakeTauri, { lang }); await page.addInitScript({ content: BRIDGE });
    await page.goto(`${base}#/files?p=${encodeURIComponent('/home/u')}`); await page.waitForSelector('.files-row', { timeout: 15000 });
    const calls = (c) => page.evaluate((c) => window.__fs.calls.filter((x) => x[0] === c).map((x) => x[1]), c);
    const lastQ = () => page.evaluate(() => window.__fs.queries[window.__fs.queries.length - 1]);
    ok(L('nothing of the file search is asked for before it is used'), (await page.evaluate(() => window.__fs.calls.filter((x) => /^kt_fsearch/.test(x[0])).length)) === 0);
    // The filter button keeps the folder's own filter, as before.
    await page.click('.topbar-actions button[data-icon="filter"]'); await page.waitForTimeout(150);
    ok(L('the filter button still filters this folder'), await page.evaluate(() => !document.querySelector('.files-search').hidden && !document.querySelector('.fs-panel')));
    await page.keyboard.press('Escape'); await page.waitForTimeout(100);
    // No folder chosen: the search button opens the panel on «Choose folders to search».
    await page.click('.topbar-actions button[data-icon="search"]'); await page.waitForSelector('.fs-panel', { timeout: 5000 }); await page.waitForTimeout(300);
    ok(L('the panel takes the folder\'s place'), await page.evaluate(() => document.querySelector('.files-view').classList.contains('fs-on') && getComputedStyle(document.querySelector('.files-body')).display === 'none'));
    ok(L('no folders: «Choose folders to search»'), (await page.textContent('.fs-empty')).includes(T.fsChooseTitle));
    ok(L('the field has focus'), await page.evaluate(() => document.activeElement?.classList.contains('fs-input')));
    await shot(page, `fs-empty-${lang}.png`);
    // The sheet: a folder added; one inside it and one around it refused, each with its reason.
    await page.click('.fs-choose'); await page.waitForSelector('.fs-sheet');
    await page.evaluate(() => { window.__fs.pick = '/home/u/Media'; }); await page.click('.fs-add'); await page.waitForSelector('.fs-root');
    ok(L('a folder added through pickDir'), JSON.stringify(await calls('kt_fsearch_add')) === JSON.stringify([{ o: { path: '/home/u/Media' } }]));
    await page.evaluate(() => { window.__fs.pick = '/home/u/Media/Group 01'; }); await page.click('.fs-add'); await page.waitForSelector('.toast.error');
    ok(L('a folder inside a chosen one refused, the reason said'), (await page.textContent('.toast.error')).includes(fill(T.fsRefInside, { other: '/home/u/Media' })));
    await page.evaluate(() => { window.__fs.pick = '/home/u'; document.querySelectorAll('.toast').forEach((x) => x.remove()); }); await page.click('.fs-add'); await page.waitForSelector('.toast.error');
    ok(L('a folder around a chosen one refused, the reason said'), (await page.textContent('.toast.error')).includes(fill(T.fsRefHolds, { other: '/home/u/Media' })));
    ok(L('one folder listed'), (await page.locator('.fs-root').count()) === 1);
    // An exclusion: outside the folder refused; inside taken, and given back.
    await page.evaluate(() => { window.__fs.pick = '/elsewhere'; document.querySelectorAll('.toast').forEach((x) => x.remove()); }); await page.click('.fs-exclude'); await page.waitForSelector('.toast.error');
    ok(L('an exclusion outside the folder refused'), (await page.textContent('.toast.error')).includes(fill(T.fsRefOutside, { root: '/home/u/Media' })));
    await page.evaluate(() => { window.__fs.pick = '/home/u/Media/Group 07'; }); await page.click('.fs-exclude'); await page.waitForSelector('.fs-excl-row');
    ok(L('an exclusion listed under its folder'), (await page.textContent('.fs-excl-row')).includes('/home/u/Media/Group 07'));
    await page.click('.fs-excl-row button'); await page.waitForTimeout(200);
    ok(L('an exclusion given back'), (await page.locator('.fs-excl-row').count()) === 0 && JSON.stringify((await calls('kt_fsearch_exclude')).pop()) === JSON.stringify({ o: { root: '/home/u/Media', path: '/home/u/Media/Group 07', remove: true } }));
    // Pause: a switch, not a checkbox look-alike; the call sent.
    ok(L('pause and battery are switches'), await page.evaluate(() => [...document.querySelectorAll('.fs-switch input')].every((i) => i.getAttribute('role') === 'switch')));
    await page.click('.fs-pause input'); await page.waitForTimeout(150);
    ok(L('pause sent'), JSON.stringify((await calls('kt_fsearch_pause')).pop()) === JSON.stringify({ o: { paused: true } }));
    await page.click('.fs-pause input'); await page.waitForTimeout(150);
    const btns = await page.evaluate(() => [...document.querySelectorAll('.fs-sheet-btns .btn')].map((b) => Math.round(b.getBoundingClientRect().width)));
    ok(L('the sheet\'s buttons share a width'), btns.length === 2 && Math.abs(btns[0] - btns[1]) <= 1, btns);
    const gap = await page.evaluate(() => { const [a, b] = [...document.querySelectorAll('.fs-sheet-btns .btn')].map((x) => x.getBoundingClientRect()); return Math.max(b.left - a.right, a.left - b.right); });
    ok(L('the buttons do not touch'), gap >= 8, gap);
    ok(L('the sheet\'s footer does not cover its last row'), await page.evaluate(() => { const body = document.querySelector('.fs-sheet .sheet-body'); const act = document.querySelector('.fs-sheet .sheet-actions'); body.scrollTop = 1e6; const last = body.lastElementChild.getBoundingClientRect(); return last.bottom <= act.getBoundingClientRect().top + 1; }));
    await shot(page, `fs-manage-${lang}.png`);
    await page.click('.fs-sheet .sheet-head button'); await page.waitForTimeout(300);
    // Looking through: the progress and its count.
    await page.waitForSelector('.fs-empty.indexing', { timeout: 5000 });
    ok(L('looking through: shown with its count'), (await page.textContent('.fs-empty')).includes(T.fsIndexing));
    await shot(page, `fs-indexing-${lang}.png`);
    const pollsWhileBusy = await page.evaluate(() => window.__fs.polls); await page.waitForTimeout(1000);
    ok(L('the state is read again while it is busy'), (await page.evaluate(() => window.__fs.polls)) > pollsWhileBusy);
    await page.evaluate(() => { window.__fs.walkPolls = 1; }); await page.waitForTimeout(1300);
    const polls = await page.evaluate(() => window.__fs.polls); await page.waitForTimeout(1300);
    ok(L('once done, the polling stops'), (await page.evaluate(() => window.__fs.polls)) === polls);
    ok(L('ready: the count of entries'), (await page.textContent('.fs-empty')).includes(fill(T.fsReadyHint, { n: '12,040' })), await page.textContent('.fs-empty'));
    // Typing: debounced and superseding — a slow older search never replaces a newer one.
    await page.evaluate(() => { window.__fs.slow = { r: 600, re: 600, rep: 600 }; window.__fs.queries = []; });
    await page.type('.fs-input', 'report', { delay: 90 }); await page.waitForTimeout(900);
    const texts = await page.evaluate(() => window.__fs.queries.map((q) => q.text));
    ok(L('typing: a search per pause, not per key'), texts.length >= 2 && texts.length <= 6 && texts[texts.length - 1] === 'report', texts);
    await page.waitForFunction(() => document.querySelectorAll('.fs-row').length > 0);
    ok(L('the newest search wins over slower older ones'), await page.evaluate(() => [...document.querySelectorAll('.fs-row .fs-name')].every((n) => n.textContent.startsWith('report'))));
    ok(L('the match is marked'), await page.evaluate(() => document.querySelector('.fs-row .fs-name mark')?.textContent.toLowerCase() === 'report'));
    ok(L('the folder is isolated, left to right'), await page.evaluate(() => { const d = document.querySelector('.fs-row .fs-dir'); return d.tagName === 'BDI' && d.getAttribute('dir') === 'ltr'; }));
    ok(L('«showing N of total»'), (await page.textContent('.fs-line')).includes(fill(T.fsShowing, { n: '500', total: '1,200' })), await page.textContent('.fs-line'));
    // The chips build the query.
    await page.evaluate(() => { window.__fs.slow = {}; });
    await page.click('.fs-chip[data-kind="video"]'); await page.waitForTimeout(250);
    ok(L('kind chip → kinds'), JSON.stringify((await lastQ()).kinds) === '["video"]', await lastQ());
    await page.click('.fs-chip[data-kind="folder"]'); await page.waitForTimeout(250);
    ok(L('two kinds'), JSON.stringify((await lastQ()).kinds) === '["video","folder"]');
    await shot(page, `fs-results-${lang}.png`);
    await page.click('.fs-chip[data-kind="folder"]'); await page.waitForTimeout(150);
    const pick = async (nth, label) => { await page.locator('.fs-chip[aria-haspopup="menu"]').nth(nth).click(); await page.waitForSelector('.sheet .dest-row'); await page.locator('.sheet .dest-row', { hasText: label }).first().click(); await page.waitForTimeout(250); };
    await pick(0, T.fsSizeHuge);
    ok(L('size chip → sizeMin'), (await lastQ()).sizeMin === 1024 * 1024 * 1024 + 1 && (await lastQ()).sizeMax === undefined, await lastQ());
    await pick(1, T.fsDateWeek);
    const q1 = await lastQ(); ok(L('date chip → after, a week back'), Math.abs(q1.after - (Date.now() - 7 * 86400000)) < 60000 && q1.before === undefined, q1);
    await pick(2, T.sortSize);
    ok(L('sort → size, largest first'), (await lastQ()).sort === 'size' && (await lastQ()).desc === true);
    await pick(2, T.sortSize);
    ok(L('the same sort again turns the order round'), (await lastQ()).sort === 'size' && (await lastQ()).desc === false);
    ok(L('every hit fits the filters'), await page.evaluate(() => [...document.querySelectorAll('.fs-row .fs-ic')].every((i) => i.classList.contains('k-video'))));
    const chipGap = await page.evaluate(() => { const cs = [...document.querySelectorAll('.fs-chips > .chip')].map((c) => c.getBoundingClientRect()); let min = 99; for (let i = 1; i < cs.length; i++) if (Math.abs(cs[i].top - cs[i - 1].top) < 2) min = Math.min(min, Math.abs(cs[i].left - cs[i - 1].right), Math.abs(cs[i - 1].left - cs[i].right)); return min; });
    ok(L('the chips do not touch'), chipGap >= 6, chipGap);
    await page.click('.fs-clear'); await page.waitForTimeout(250);
    const q2 = await lastQ(); ok(L('Clear filters: none sent'), !q2.kinds && q2.sizeMin === undefined && q2.after === undefined, q2);
    // No results.
    await page.fill('.fs-input', 'zzqx'); await page.waitForTimeout(300);
    ok(L('no results said'), (await page.textContent('.fs-empty')).includes(fill(T.fsNoResults, { q: 'zzqx' })));
    // Ten thousand hits: a few dozen rows in the page; scrolling stays smooth and reaches the last.
    await page.fill('.fs-input', '0'); await page.waitForTimeout(400);
    for (let k = 0; k < 8; k++) { await page.evaluate(() => { const s = document.querySelector('.fs-scroll'); s.scrollTop = s.scrollHeight; }); await page.waitForTimeout(250); }
    const big = await page.evaluate(() => ({ rows: document.querySelectorAll('.fs-row').length, h: document.querySelector('.fs-space').getBoundingClientRect().height, line: document.querySelector('.fs-line').textContent, lastQ: window.__fs.queries[window.__fs.queries.length - 1].limit, total: new Intl.NumberFormat('en-US').format(window.__fs.lastTotal) }));
    ok(L('10 000 hits asked for as the list is scrolled'), big.lastQ === 10000, big);
    ok(L('the list is virtual (a few dozen rows in the page)'), big.rows > 5 && big.rows < 80 && big.h >= 10000 * 60 - 1, big);
    ok(L('«showing 10,000 of …»'), big.line.includes(fill(T.fsShowing, { n: '10,000', total: big.total })), big.line);
    const frames = await page.evaluate(async () => { const s = document.querySelector('.fs-scroll'); s.scrollTop = 0; const times = []; let last = performance.now(); for (let i = 0; i < 60; i++) { s.scrollTop += 1400; await new Promise((r) => requestAnimationFrame(r)); const now = performance.now(); times.push(now - last); last = now; } times.sort((a, b) => a - b); return { median: times[30], worst: times[59], rows: document.querySelectorAll('.fs-row').length }; });
    ok(L('scrolling 10 000 rows stays smooth'), frames.median < 34 && frames.rows < 80, frames);
    // Keyboard: ↓ from the field into the list, Enter opens (a folder: the page goes there).
    await page.fill('.fs-input', 'Group 03'); await page.waitForTimeout(300);
    await page.focus('.fs-input'); await page.keyboard.press('ArrowDown');
    ok(L('↓ moves into the list'), await page.evaluate(() => document.querySelector('.fs-row.active') !== null && document.activeElement?.classList.contains('fs-scroll')));
    // Show in folder: the Files page walks there and the panel goes.
    await page.fill('.fs-input', 'holiday 00011'); await page.waitForTimeout(300);
    await page.hover('.fs-row'); await page.click('.fs-row .fs-show');
    await page.waitForFunction(() => !document.querySelector('.fs-panel')); await page.waitForTimeout(300);
    ok(L('Show in folder → that folder in Files'), decodeURIComponent(await page.evaluate(() => location.hash)).includes('p=/home/u/Media/Group 11'), await page.evaluate(() => location.hash));
    ok(L('closed: the folder\'s list is back'), await page.evaluate(() => !document.querySelector('.files-view').classList.contains('fs-on') && getComputedStyle(document.querySelector('.files-body')).display !== 'none'));
    const live1 = await page.evaluate(() => ({ ...window.__live }));
    ok(L('closed: nothing left listening or observing'), live1.scroll === 0 && live1.keydown === 0 && live1.input === 0 && live1.ro === 0, live1);
    // Ctrl+Shift+F brings it back; the sheet's Rebuild, Remove (folder) and Remove index (asked first).
    await page.keyboard.press('Control+Shift+F'); await page.waitForSelector('.fs-panel', { timeout: 5000 });
    ok(L('Ctrl+Shift+F opens it'), true);
    await page.click('.fs-manage'); await page.waitForSelector('.fs-root');
    await page.click('.fs-rebuild'); await page.waitForTimeout(200);
    ok(L('Rebuild sent'), (await calls('kt_fsearch_rebuild')).length === 1);
    await page.click('.fs-forget'); await page.waitForSelector('.fs-forget-go');
    ok(L('Remove index asks first'), (await page.textContent('.sheet.stacked')).includes(T.fsForgetAsk));
    await page.click('.fs-forget-go'); await page.waitForTimeout(300);
    ok(L('Remove index sent'), (await calls('kt_fsearch_forget')).length === 1);
    ok(L('after it: no folders listed'), (await page.locator('.fs-root').count()) === 0);
    await page.evaluate(() => { window.__fs.pick = '/home/u/Media'; }); await page.click('.fs-add'); await page.waitForSelector('.fs-root');
    await page.click('.fs-remove'); await page.waitForTimeout(250);
    ok(L('a folder removed'), JSON.stringify((await calls('kt_fsearch_remove')).pop()) === JSON.stringify({ o: { path: '/home/u/Media' } }) && (await page.locator('.fs-root').count()) === 0);
    await page.click('.fs-sheet .sheet-head button'); await page.waitForTimeout(200);
    // Right to left in Arabic: the kind's icon at the start (the right), the field and chips laid out that way.
    if (lang === 'ar') {
      await page.evaluate(() => { window.__fs.pick = '/home/u/Media'; window.__fs.busy = false; window.__fs.walkPolls = 0; });
      await page.click('.fs-manage'); await page.waitForSelector('.fs-sheet'); await page.click('.fs-add'); await page.waitForSelector('.fs-root'); await page.click('.fs-sheet .sheet-head button'); await page.waitForTimeout(200);
      await page.evaluate(() => { window.__fs.busy = false; });
      await page.fill('.fs-input', 'تقرير'); await page.waitForSelector('.fs-row');
      const rtl = await page.evaluate(() => { const r = document.querySelector('.fs-row'); const ic = r.querySelector('.fs-ic').getBoundingClientRect(); const main = r.querySelector('.fs-main').getBoundingClientRect(); return { dir: getComputedStyle(r).direction, icRight: ic.left > main.left }; });
      ok(L('right to left: the icon at the right'), rtl.dir === 'rtl' && rtl.icRight, rtl);
      ok(L('Arabic name marked'), await page.evaluate(() => document.querySelector('.fs-row .fs-name mark')?.textContent === 'تقرير'));
      ok(L('no Eastern digits in the counts'), !/[٠-٩]/.test(await page.textContent('.fs-line')), await page.textContent('.fs-line'));
      await shot(page, `fs-results-ar-rtl.png`);
    }
    // The Files page replaced (another folder asked for in the address) with the panel open: the old page and its panel
    // let go of everything — only the new page's one listener for Ctrl+Shift+F is left.
    ok(L('the panel is open before the page goes'), (await page.locator('.fs-panel').count()) === 1);
    await page.evaluate(() => { location.hash = '#/files?p=' + encodeURIComponent('/home/u/Media'); }); await page.waitForTimeout(800);
    const live2 = await page.evaluate(() => ({ ...window.__live }));
    ok(L('page replaced: nothing of the old page or its panel left'), live2.fsEvent === 1 && live2.scroll === 0 && live2.keydown === 0 && live2.input === 0 && live2.ro === 0, live2);
    const n0 = await page.evaluate(() => window.__fs.calls.length); await page.waitForTimeout(1200);
    ok(L('left: no more calls to the shell'), (await page.evaluate(() => window.__fs.calls.length)) === n0);
    ok(L('no page errors'), errors.length === 0, errors);
    await page.close();
  }
  // Nothing of it elsewhere: Electron's bridge (no fileSearch), a phone (its plugin), the web.
  const elsewhere = async (what, init, vp) => {
    const ctx = await br.newContext(vp || { viewport: { width: 1280, height: 800 } }); const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 404, body: '' }));
    await p.addInitScript(init); await p.goto(`${base}#/files?p=${encodeURIComponent('/home/u')}`); await p.waitForTimeout(1500);
    const btn = p.locator('.topbar-actions button[data-icon="search"]'); if (await btn.count()) { await btn.first().click().catch(() => undefined); await p.waitForTimeout(500); }
    await p.keyboard.press('Control+Shift+F'); await p.waitForTimeout(300);
    ok(`[${what}] no «Everywhere» panel`, (await p.locator('.fs-panel').count()) === 0 && !(await p.content()).includes('fs-panel'));
    ok(`[${what}] no page errors`, errs.length === 0, errs);
    await ctx.close();
  };
  await elsewhere('electron', () => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.pc.starter', '1'); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['files'] })); window.kurokawaTools = { platform: 'desktop', available: false, os: 'linux', ready: async () => ({}), list: async () => [], onTasks: (cb) => { cb([]); return () => undefined; }, defaultDir: async () => '/home/u', homeDir: async () => '/home/u', listDir: async () => ({ entries: [{ name: 'a.txt', path: '/home/u/a.txt', dir: false, size: 1, mtime: 1 }] }), pickDir: async () => null }; });
  await elsewhere('phone', () => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['files'] })); const api = { addListener: () => ({ remove() {} }), list: async () => ({ tasks: [] }), filesList: async () => ({ exists: true, entries: [] }), filesRoots: async () => ({ allFiles: true, roots: [{ kind: 'phone', path: '/storage/emulated/0', name: 'Phone', readable: true }] }) }; const plugin = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) }); window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] }; }, { viewport: { width: 412, height: 860 }, hasTouch: true, isMobile: true });
  await elsewhere('web', () => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['files'] })); });
  await br.close(); web.close();
  console.log(fails ? `filesearch: ${fails} FAILED` : 'filesearch: all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
