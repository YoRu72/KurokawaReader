// node tests/dlfix.cjs [en|ar]: the downloads' page-side fixes on a stubbed phone.
// The modules (bundled here): a download's start time set without its stop time going (and the other way round); a stop
// time that passed while paused taken off, not left to pause it later; the «later» scheduler resuming only what it paused
// itself — never one the reader paused, never one held for Wi-Fi —, pausing at the window's end only what it did not
// see the reader start by hand; a list brought back with one link twice adding it once; names with a bare «%»
// read; a cloud link's renewal tried again later (not once per run).
// The app (dist/): a batch with a link that fails and one with a bare «%» — the others added, only the failed one left
// in the box —; the Download button tapped twice adding once; a download of unknown size (total -1) shown without
// «-1 B» and with no bar under 0; one held for Wi-Fi offering «Download now», which asks the engine to start it anyway.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const lang = process.argv[2] || 'en';
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const STUB = () => {
  window.__calls = []; window.__tasks = JSON.parse(sessionStorage.getItem('kt.test.tasks') || '[]');
  const plugin = new Proxy({ addListener: () => ({ remove() {} }), list: async () => ({ tasks: window.__tasks }),
    add: async (o) => { window.__calls.push(['add', o.source.url, o]); await new Promise((r) => setTimeout(r, 30)); if (/bad\.bin$/.test(o.source.url || '')) throw new Error('refused here'); const task = { id: 'n' + window.__calls.length, kind: 'http', name: o.name || 'x', source: o.source, dir: '/d', state: 'downloading', done: 0, total: 0, files: [], addedAt: Date.now(), engine: 'native', meta: o.meta }; return { task }; },
    pause: async (o) => { window.__calls.push(['pause', o.id]); const x = window.__tasks.find((y) => y.id === o.id); if (x) x.state = 'paused'; },
    resume: async (o) => { window.__calls.push(['resume', o.id, !!o.anyway]); const x = window.__tasks.find((y) => y.id === o.id); if (x) x.state = 'downloading'; },
    setTaskMeta: async (o) => { const x = window.__tasks.find((y) => y.id === o.id); if (!x) throw new Error('noTask'); x.meta = x.meta || {}; for (const [k, v] of Object.entries(o.patch)) { if (v === null || v === undefined) delete x.meta[k]; else x.meta[k] = v; } } },
  { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
};
(async () => {
  const esbuild = require(require.resolve('esbuild', { paths: [path.join(__dirname, '..'), path.join(__dirname, '..', '..', '..')] }));
  const entry = "import * as R from './src/downloads/rules'; import * as B from './src/downloads/background'; import * as X from './src/downloads/extras'; import * as P from './src/downloads/probe'; import * as E from './src/engine'; import * as M from './src/downloads/mega'; import * as S from './src/settings'; (window as any).__m = { R, B, X, P, E, M, S };";
  const bundle = (await esbuild.build({ stdin: { contents: entry, resolveDir: path.join(__dirname, '..'), loader: 'ts' }, bundle: true, write: false, format: 'iife', logLevel: 'silent', loader: { '.woff2': 'empty', '.png': 'empty', '.svg': 'text' } })).outputFiles[0].text;
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]);
    if (p === '/blank.html') { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><html><body></body></html>'); return; }
    if (p === '/bundle.js') { r.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); r.end(bundle); return; }
    if (p.startsWith('/x/')) { r.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '4', 'accept-ranges': 'bytes' }); r.end(q.method === 'HEAD' ? undefined : 'abcd'); return; }
    if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : p.endsWith('.json') ? 'application/json' : 'text/html' }); r.end(fs.readFileSync(f));
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res)); const base = `http://127.0.0.1:${srv.address().port}`;
  const b = await chromium.launch(); const errs = [];
  /* ---------- the modules ---------- */
  { const p = await b.newPage(); p.on('pageerror', (e) => errs.push('modules: ' + e.message)); await p.addInitScript(STUB); await p.goto(`${base}/blank.html`); await p.addScriptTag({ url: `${base}/bundle.js` }); await p.waitForFunction(() => !!window.__m, null, { timeout: 5000 }).catch(() => console.log('bundle did not load:', errs.join(' ; ')));
    const r = await p.evaluate(async () => {
      const { R, B, X, P, E, M, S } = window.__m; const out = {}; const T = Date.now(); const H = 3600_000; const wait = (ms) => new Promise((res) => setTimeout(res, ms));
      // Clock.
      window.__tasks = [{ id: 'k1', kind: 'http', name: 'k1', source: { url: 'https://h/k1' }, state: 'paused', done: 0, total: 10, meta: { startAt: T + H, stopAt: T + 2 * H } }];
      await R.setClock('k1', { startAt: T + 3 * H }); out.clockKeepsStop = window.__tasks[0].meta.stopAt === T + 2 * H && window.__tasks[0].meta.startAt === T + 3 * H;
      await R.setClock('k1', { stopAt: T + 4 * H }); out.clockKeepsStart = window.__tasks[0].meta.startAt === T + 3 * H && window.__tasks[0].meta.stopAt === T + 4 * H;
      window.__tasks = [{ id: 'k2', kind: 'http', name: 'k2', source: { url: 'https://h/k2' }, state: 'paused', done: 0, total: 10, meta: { stopAt: T - 60_000, startAt: T + H } }]; window.__calls = [];
      await R.tickClocks(); out.stalestop = { meta: window.__tasks[0].meta, calls: window.__calls.length };
      // The scheduler, its window open now: only what it paused itself, and not one held.
      const hm = (d) => { const x = new Date(T + d); return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`; };
      const mk = (id, state, meta, extra = {}) => ({ id, kind: 'http', name: id, source: { url: 'https://h/' + id }, state, done: 0, total: 10, meta: { later: true, ...meta }, ...extra });
      S.updateSettings({ schedule: { enabled: true, start: hm(-H), stop: hm(H), days: [] } });
      window.__tasks = [mk('a', 'paused', {}), mk('b', 'paused', { schedPaused: true }), mk('c', 'paused', { schedPaused: true }, { heldBy: 'metered' })]; window.__calls = [];
      B.startScheduler(); await wait(600); out.open = { calls: window.__calls.map((c) => c.slice(0, 2).join(':')), b: window.__tasks[1].meta };
      // Its window shut: d (running, unmarked) paused and marked; e (marked, running: started by hand) left alone, twice.
      S.updateSettings({ schedule: { enabled: true, start: hm(H), stop: hm(2 * H), days: [] } });
      window.__tasks = [mk('d', 'downloading', {}), mk('e', 'downloading', { schedPaused: true })]; window.__calls = [];
      B.startScheduler(); await wait(600); B.startScheduler(); await wait(600);
      out.shut = { calls: window.__calls.map((c) => c.slice(0, 2).join(':')), d: window.__tasks[0].meta, e: window.__tasks[1].meta };
      S.updateSettings({ schedule: { enabled: false, start: '00:00', stop: '00:00', days: [] } }); B.startScheduler();
      // A list with one link twice.
      window.__tasks = []; window.__calls = []; out.imported = await X.importList('https://h/same.bin\nhttps://h/same.bin\nhttps://h/other.bin', { finishedToo: false }, []);
      // Names with a bare «%».
      try { out.decode = [P.safeDecode && P.safeDecode('100%.mkv'), P.safeDecode && P.safeDecode('a%20b%.mkv'), E.magnetName('magnet:?xt=urn:btih:abc&dn=50%25+off')]; } catch (e) { out.decode = String(e); }
      // A renewal tried again later.
      if (M.renewDue) { const seen = new Map(); const x = { id: 'm1', done: 0 }; out.renew = [M.renewDue(seen, x, 0), M.renewDue(seen, x, 1000), M.renewDue(seen, x, 121_000), M.renewDue(seen, x, 200_000), M.renewDue(seen, x, 362_000), M.renewDue(seen, { id: 'm1', done: 50 }, 483_000), M.renewDue(seen, { id: 'm1', done: 50 }, 486_000)]; } else out.renew = 'once per run (no renewDue)';
      return out;
    });
    ok('a start time set: the stop time kept', r.clockKeepsStop); ok('a stop time set: the start time kept', r.clockKeepsStart);
    ok('a stop time passed while paused: taken off, nothing paused, the start time kept', r.stalestop.calls === 0 && !('stopAt' in r.stalestop.meta) && !!r.stalestop.meta.startAt, r.stalestop);
    ok('window open: only the one it paused resumed (not the reader\'s, not the held one), its mark taken off', JSON.stringify(r.open.calls) === '["resume:b"]' && !r.open.b.schedPaused, r.open);
    ok('window shut: the unmarked one paused and marked; the one started by hand left running', JSON.stringify(r.shut.calls) === '["pause:d"]' && r.shut.d.schedPaused === true && r.shut.e.schedSkip === true, r.shut);
    ok('a list naming a link twice: added once', r.imported && r.imported.added === 2 && r.imported.skipped === 1, r.imported);
    ok('a bare «%» read as it is', JSON.stringify(r.decode) === JSON.stringify(['100%.mkv', 'a b%.mkv', '50% off']), r.decode);
    ok('a renewal: now, not again at once, again after 2 min, then 4 min; 2 min again (not 8) once the download moved', JSON.stringify(r.renew) === JSON.stringify([true, false, true, false, true, true, false]), r.renew);
    await p.close(); }
  /* ---------- the app ---------- */
  { const p = await b.newPage({ viewport: { width: 412, height: 900 } }); p.on('pageerror', (e) => errs.push('app: ' + e.message));
    await p.addInitScript(STUB); await p.addInitScript((lang) => { localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.settings', JSON.stringify({ downloadDir: '/storage/emulated/0/Download' })); }, lang);
    await p.goto(`${base}/`); await p.waitForSelector('.fab', { timeout: 15000 });
    // A batch: a, a bare «%», one the engine refuses, c.
    await p.click('.fab'); await p.click('.fab-item >> nth=0'); await p.waitForSelector('.add-input', { timeout: 10000 });
    await p.fill('.add-input', [`${base}/x/a.bin`, `${base}/x/100%.bin`, `${base}/x/bad.bin`, `${base}/x/c.bin`].join('\n'));
    await p.click('.sheet-actions .btn.primary'); await p.waitForTimeout(2500);
    const batch = await p.evaluate(() => ({ adds: window.__calls.filter((c) => c[0] === 'add').map((c) => c[1].split('/').pop()), box: document.querySelector('.add-input')?.value ?? null, open: !!document.querySelector('.add-input') }));
    ok('a batch goes on past a link that fails: the others added (the bare «%» one too)', JSON.stringify(batch.adds) === JSON.stringify(['a.bin', '100%.bin', 'bad.bin', 'c.bin']), batch.adds);
    ok('only the failed link left in the box, the sheet open', batch.open && batch.box === `${base}/x/bad.bin`, batch.box);
    // The Download button tapped twice.
    await p.evaluate(() => { window.__calls = []; }); await p.fill('.add-input', `${base}/x/one.bin`); await p.waitForTimeout(800);
    await p.evaluate(() => { const g = document.querySelector('.sheet-actions .btn.primary'); g.click(); g.click(); }); await p.waitForTimeout(2500);
    const twice = await p.evaluate(() => window.__calls.filter((c) => c[0] === 'add').length); ok('Download tapped twice: added once', twice === 1, twice);
    // The list: a download of unknown size, and one held for Wi-Fi.
    await p.evaluate(() => { document.querySelectorAll('.sheet-head button').forEach((x) => x.click()); });
    await p.evaluate(() => { const now = Date.now(); const tasks = [
      { id: 'u1', kind: 'http', name: 'stream.ts', source: { url: 'https://h/stream.ts' }, dir: '/d', state: 'downloading', done: 3e6, total: -1, downSpeed: 1e6, upSpeed: 0, files: [], addedAt: now, engine: 'native' },
      { id: 'w1', kind: 'http', name: 'held.mkv', source: { url: 'https://h/held.mkv' }, dir: '/d', state: 'paused', done: 1e6, total: 5e6, downSpeed: 0, upSpeed: 0, files: [], addedAt: now - 1000, engine: 'native', heldBy: 'metered', meta: { wifiOnly: true } }]; sessionStorage.setItem('kt.test.tasks', JSON.stringify(tasks)); });
    await p.goto(`${base}/#/`); await p.reload(); await p.waitForSelector('.task-card', { timeout: 15000 }); await p.waitForTimeout(500);
    const list = await p.evaluate(() => [...document.querySelectorAll('.task-card')].map((c) => ({ name: c.querySelector('.task-name')?.textContent, line: c.querySelector('.task-line')?.textContent, bar: c.querySelector('.task-bar i')?.style.width, busy: c.querySelector('.task-bar')?.classList.contains('busy-any'), buttons: [...c.querySelectorAll('button')].map((x) => x.getAttribute('aria-label') || x.title || x.textContent) })));
    const u = list.find((x) => x.name === 'stream.ts'), w = list.find((x) => x.name === 'held.mkv');
    ok('unknown size: no «-1», no bar under 0, shown as under way', !!u && !/-1|−1/.test(u.line) && !/^-/.test(u.bar || '') && u.busy, u);
    const nowLabel = lang === 'ar' ? 'نزّل الآن' : 'Download now';
    ok('held for Wi-Fi: «Download now» offered', !!w && w.buttons.includes(nowLabel), w);
    await p.click(`.task-card:has-text("held.mkv") button[aria-label="${nowLabel}"]`).catch(() => {}); await p.waitForTimeout(400);
    const res = await p.evaluate(() => window.__calls.filter((c) => c[0] === 'resume')); ok('«Download now» asks the engine to start it anyway', JSON.stringify(res) === JSON.stringify([['resume', 'w1', true]]), res);
    await p.screenshot({ path: path.join(__dirname, `shot-dlfix-${lang}.png`) }); await p.close(); }
  if (errs.length) { console.log('ERRORS ' + errs.join(' ; ')); fails++; }
  console.log(fails ? 'FAILED' : 'all passed'); await b.close(); srv.close(); process.exit(fails ? 1 : 0);
})();
