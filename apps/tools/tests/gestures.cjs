// node tests/gestures.cjs: the phone's gestures, with real touches (the browser's own touch input): a page swiped
// sideways to the bottom bar's next place and back, a vertical drag and a short swipe doing nothing, the setting
// that turns it off; a bottom sheet dragged down to close (a short drag springing back); Files pulled down at its top
// read again; a Files row swiped back to delete (asked first); the picture viewer swiped down to close; Arabic, the
// swipe mirrored.
const { chromium, devices } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
(async () => {
  const web = http.createServer((q, r) => { let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); }).listen(0);
  const b = await chromium.launch();
  const run = async (lang) => {
    const ctx = await b.newContext({ ...devices['Pixel 7'] }); const p = await ctx.newPage(); const cdp = await ctx.newCDPSession(p);
    const errors = []; p.on('pageerror', (e) => errors.push(e.message));
    await p.addInitScript((lang) => {
      window.__lists = 0; window.__calls = [];
      const tree = { '/storage/emulated/0/Download/Kurokawa': { 'Movie.mkv': 7e8, 'photo.jpg': 2.5e6, 'notes.txt': 1200, Sub: {} } };
      const listOf = (dir) => Object.entries(tree[dir] ?? {}).map(([name, v]) => ({ name, path: `${dir}/${name}`, dir: typeof v === 'object', size: typeof v === 'object' ? 0 : v, mtime: 1760000000000, ext: typeof v === 'object' ? undefined : name.split('.').pop() }));
      const plugin = new Proxy({
        addListener: async () => ({ remove() {} }), list: async () => ({ tasks: [] }), defaultDir: async () => ({ dir: '/sdcard/Download' }),
        filesRoots: async () => ({ allFiles: true, roots: [{ kind: 'app', path: '/storage/emulated/0/Download/Kurokawa', name: 'Kurokawa', readable: true, free: 12e9, total: 64e9 }] }),
        filesList: async ({ path }) => { window.__lists++; return { exists: true, entries: listOf(path) }; },
        localUrl: async () => ({ url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==' }), filesThumb: async () => ({ url: null }),
      }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin, Filesystem: {} }, PluginHeaders: [] };
      try { if (!localStorage.getItem('kt.settings')) localStorage.setItem('kt.settings', JSON.stringify({ addons: ['files'], navOrder: ['downloads', 'files'] })); localStorage.setItem('kr.lang', lang); } catch { /* about:blank */ }
    }, lang);
    const touch = async (pts, steps = 10, ms = 120) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pts[0][0], y: pts[0][1] }] });
      for (let i = 1; i <= steps; i++) { const x = pts[0][0] + ((pts[1][0] - pts[0][0]) * i) / steps, y = pts[0][1] + ((pts[1][1] - pts[0][1]) * i) / steps; await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] }); await p.waitForTimeout(ms / steps); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await p.waitForTimeout(450);
    };
    const W = 412; const hash = () => p.evaluate(() => location.hash);
    const base = `http://127.0.0.1:${web.address().port}/`;
    await p.goto(base + '#/'); await p.waitForSelector('.bottom-nav'); await p.waitForTimeout(400);
    const order = await p.$$eval('.bottom-nav [data-dest]', (e) => e.map((x) => x.dataset.dest));
    const rtl = lang === 'ar'; const toNext = rtl ? [[100, 420], [340, 430]] : [[320, 420], [80, 430]]; const toPrev = rtl ? [[320, 420], [80, 430]] : [[100, 420], [340, 430]];
    ok(`${lang}: the page's direction`, (await p.evaluate(() => document.documentElement.dir)) === (rtl ? 'rtl' : 'ltr'));
    await touch(toNext);
    ok(`${lang}: a page swiped toward the start: the next place (${order[1]})`, (await hash()).startsWith(`#/${order[1]}`) || (await hash()).includes(order[1]), [await hash(), order]);
    // (Files has its drawer at its start side: swiped back from its end side, to the previous place.)
    await touch(rtl ? [[235, 420], [15, 430]] : [[200, 420], [405, 430]]);
    ok(`${lang}: …not the drawer`, !(await p.$('.files-drawer')));
    ok(`${lang}: swiped back: the first place again`, !(await hash()).includes(order[1]), await hash());
    await touch([[200, 300], [210, 700]]); ok(`${lang}: a vertical drag does not change place`, !(await hash()).includes(order[1]), await hash());
    await touch(rtl ? [[200, 420], [240, 420]] : [[200, 420], [160, 420]]); ok(`${lang}: a short swipe does not change place`, !(await hash()).includes(order[1]), await hash());
    if (lang === 'en') {
      // A bottom sheet dragged down.
      await p.click('.fab'); await p.click('.fab-item >> nth=0'); await p.waitForSelector('.add-sheet'); await p.waitForTimeout(500);
      const head = await p.$eval('.add-sheet .sheet-head', (e) => { const r = e.getBoundingClientRect(); return [r.x + 60, r.y + r.height / 2]; });
      await touch([head, [head[0], head[1] + 30]]); ok('a sheet dragged a little: springs back', !!(await p.$('.add-sheet')));
      await touch([head, [head[0], head[1] + 420]], 12, 200); ok('a sheet dragged down: closed', !(await p.$('.add-sheet')));
      // The setting off.
      await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('kt.settings')); s.swipeTabs = false; localStorage.setItem('kt.settings', JSON.stringify(s)); });
      await p.goto('about:blank'); await p.goto(base + '#/'); await p.waitForSelector('.bottom-nav'); await p.waitForTimeout(300);
      await touch(toNext); ok('with the setting off, a swipe stays', !(await hash()).includes(order[1]), await hash());
      await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('kt.settings')); delete s.swipeTabs; localStorage.setItem('kt.settings', JSON.stringify(s)); });
      // Files: pulled down to refresh, a row swiped back, the viewer swiped down.
      await p.goto('about:blank'); await p.goto(base + '#/files'); await p.waitForSelector('.files-row'); await p.waitForTimeout(400);
      const before = await p.evaluate(() => window.__lists);
      await touch([[200, 300], [205, 650]], 14, 300); await p.waitForTimeout(300);
      ok('Files pulled down at its top: read again', (await p.evaluate(() => window.__lists)) > before, [before, await p.evaluate(() => window.__lists)]);
      ok('the pull mark gone after', !(await p.$('.ptr-mark.spin')));
      const row = await p.$eval('.files-row:has-text("notes.txt")', (e) => { const r = e.getBoundingClientRect(); return [r.x + r.width * 0.75, r.y + r.height / 2]; });
      await touch([row, [row[0] - 260, row[1]]]); await p.waitForTimeout(300);
      const sheet = await p.$eval('.sheet', (e) => e.textContent).catch(() => '');
      ok('a Files row swiped back: its deletion asked', /notes\.txt|Delete/i.test(sheet), sheet.slice(0, 120));
      ok('…and the page stayed on Files', (await hash()).includes('files'), await hash());
      await p.evaluate(() => document.querySelectorAll('.sheet').forEach((s) => s.__close?.()));
      await p.click('.files-row:has-text("photo.jpg")'); await p.waitForSelector('.files-viewer-stage', { timeout: 5000 }).catch(() => undefined);
      const st = await p.$eval('.files-viewer-stage', (e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + 60]; }).catch(() => null);
      if (st) { await touch([st, [st[0] + 5, st[1] + 260]]); ok('the viewer swiped down: closed', !(await p.$('.files-viewer'))); } else ok('the viewer opened', false);
    }
    ok(`${lang}: no page errors`, !errors.length, errors);
    await ctx.close();
  };
  await run('en'); await run('ar');
  await b.close(); web.close(); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})();
