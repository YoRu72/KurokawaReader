// Settings → Advanced, the torrent engine (stage M3 of the Rust port): «Torrent engine» on phones only, its choices by
// the libraries the app carries — Classic always, Director with the Rust core (libkt_android), Rust with the torrent
// library (libkt_torrent) —, Classic by default, a pick told to the engine (configure({ torEngine })) and kept; absent
// on a phone without either library and on a computer (even one whose bridge claims both); the engine badge on a
// torrent's row only in a debuggable build.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ogg': 'audio/ogg' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch(); const errors = [];
  const check = (what, ok, x) => { console.log(ok ? 'ok  ' : 'FAIL', what, ok ? '' : JSON.stringify(x ?? '')); if (!ok) errors.push(what); };
  const torrent = { id: 't1', kind: 'torrent', name: 'Made-up Ep 01', source: { magnet: 'magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, dir: '/storage/emulated/0/Download/Kurokawa', state: 'downloading', done: 10, total: 100, downSpeed: 5, upSpeed: 0, peers: 1, seeds: 0, files: [], addedAt: Date.now(), meta: { torEngine: 'rust' }, infoHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
  // o.kind: 'phone' | 'pc'; o.core / o.tor: what deviceInfo says of the two libraries; o.debug: a debuggable build.
  const open = async (o, hash = '#/settings') => {
    const ctx = await br.newContext({ viewport: o.kind === 'pc' ? { width: 1366, height: 768 } : { width: 420, height: 860 } }); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
    await ctx.route(/raw\.githubusercontent\.com|api\.github\.com/, (r) => r.fulfill({ status: 404 }));
    await p.addInitScript(([o, torrent]) => {
      localStorage.setItem('kr.lang', o.lang || 'en'); localStorage.setItem('kt.pc.starter', '1'); localStorage.setItem('kt.update.lastCheck', String(Date.now()));
      window.__calls = []; let tor = 'classic';
      const info = async () => ({ abis: ['arm64-v8a'], rustCore: o.core, rustTorrent: o.tor, dlEngine: 'java', dlEngineChoice: 'java', dlEngineFallbacks: 0, torEngineChoice: tor, torEngine: tor, torEngineFallbacks: 3, debuggable: !!o.debug });
      if (o.kind === 'pc') {
        window.kurokawaTools = new Proxy({ platform: 'desktop', available: true, os: 'win32', list: async () => [], onTasks: () => () => {}, deviceInfo: info }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) });
        return;
      }
      const api = { addListener: (n, fn) => { if (n === 'tasksChanged') window.__emit = fn; return { remove() {} }; }, list: async () => ({ tasks: o.tasks ? [torrent] : [] }), deviceInfo: info, configure: async (c) => { window.__calls.push(c); if (c.torEngine) tor = c.torEngine; } };
      const plugin = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
    }, [o, torrent]);
    await p.goto(base + hash); await p.waitForTimeout(hash === '#/settings' ? 0 : 1200);
    if (hash === '#/settings') { await p.waitForSelector('.settings-body > .card'); await p.waitForTimeout(600); if (await p.$('#advanced.collapsed')) await p.click('#advanced h3'); }
    return { p, ctx };
  };
  const choices = async (p) => { await p.click('#advanced .tor-engine-row button'); await p.waitForTimeout(300); const l = await p.$$eval('label.dest-row', (e) => e.map((x) => x.textContent.trim())); return l; };

  // A phone with both libraries: three choices, Classic by default; Rust picked → told and kept.
  let { p, ctx } = await open({ kind: 'phone', core: '0.2.0', tor: '0.1.0' });
  check('phone with both: «Torrent engine» in Advanced', /Torrent engine/.test(await p.$eval('#advanced', (e) => e.textContent)));
  check('…Classic by default', /Classic/.test(await p.$eval('#advanced .tor-engine-row button', (e) => e.textContent)));
  check('…the status line: engine, version, fallbacks', /New torrents: Classic/.test(await p.$eval('#advanced .tor-engine-status', (e) => e.textContent)) && /0\.1\.0/.test(await p.$eval('#advanced .tor-engine-status', (e) => e.textContent)) && /Classic: 3/.test(await p.$eval('#advanced .tor-engine-status', (e) => e.textContent)));
  const all = await choices(p);
  check('…Classic, Director and Rust offered', all.some((x) => /Classic/.test(x)) && all.some((x) => /Director/.test(x)) && all.some((x) => /^Rust/.test(x)), all);
  await p.locator('label.dest-row', { hasText: /^Rust$/ }).first().click(); await p.waitForTimeout(500);
  check('Rust picked: told to the engine', (await p.evaluate(() => window.__calls)).some((c) => c.torEngine === 'rust'));
  check('…kept in the settings', await p.evaluate(() => JSON.parse(localStorage.getItem('kt.settings') || '{}').torEngine) === 'rust');
  check('…the hint says what Rust refuses (SAF folders)', /SAF/.test(await p.$eval('#advanced', (e) => e.textContent)));
  await ctx.close();
  // The core only: Director, no Rust.
  ({ p, ctx } = await open({ kind: 'phone', core: '0.2.0', tor: null }));
  const some = await choices(p);
  check('core only: Classic and Director, no Rust', some.some((x) => /Director/.test(x)) && !some.some((x) => /^Rust$/.test(x)), some);
  await ctx.close();
  // The torrent library only: the card with the torrent row alone.
  ({ p, ctx } = await open({ kind: 'phone', core: null, tor: '0.1.0' }));
  check('torrent library only: the card, the torrent row, no download-engine row', !!(await p.$('#advanced .tor-engine-row')) && !(await p.$('#advanced .dl-engine-row')));
  await ctx.close();
  // Neither library: no card at all.
  ({ p, ctx } = await open({ kind: 'phone', core: null, tor: null }));
  check('neither library: no «Advanced», no torrent engine', !(await p.$('#advanced')) && !/Torrent engine/.test(await p.$eval('.settings-body', (e) => e.textContent)));
  await ctx.close();
  // Arabic.
  ({ p, ctx } = await open({ kind: 'phone', core: '0.2.0', tor: '0.1.0', lang: 'ar' }));
  const ar = await p.$eval('#advanced', (e) => e.textContent);
  check('Arabic: the row in Arabic, the count as «العدد»', /محرّك التورنت/.test(ar) && /العدد: (٣|3)/.test(ar), ar.slice(0, 400));
  await ctx.close();
  // A computer: never, even with a bridge that claims both.
  ({ p, ctx } = await open({ kind: 'pc', core: '0.2.0', tor: '0.1.0' }));
  check('computer: no «Advanced» card', !(await p.$$eval('.settings-body > .card', (e) => e.map((c) => c.id))).includes('advanced'));
  await p.fill('.settings-search', 'torrent engine'); await p.waitForTimeout(200);
  check('computer: a search finds no torrent-engine switch', !/Torrent engine/.test(await p.$eval('.settings-body', (e) => e.textContent)));
  await ctx.close();
  // The badge on a torrent's row: a debuggable build only.
  ({ p, ctx } = await open({ kind: 'phone', core: '0.2.0', tor: '0.1.0', debug: true, tasks: true }, '#/'));
  // (The rows are drawn again on the next change of the tasks — every ~0.7 s on a phone while one downloads.)
  await p.waitForTimeout(800); await p.evaluate((t) => window.__emit && window.__emit({ tasks: [{ ...t, done: 20 }] }), torrent); await p.waitForTimeout(500);
  const body0 = await p.evaluate(() => document.body.textContent); let body = body0;
  check('debuggable build: the row says «engine: Rust»', /engine: Rust/.test(body), body.slice(0, 300));
  await ctx.close();
  ({ p, ctx } = await open({ kind: 'phone', core: '0.2.0', tor: '0.1.0', debug: false, tasks: true }, '#/'));
  await p.waitForTimeout(1500);
  body = await p.evaluate(() => document.body.textContent);
  check('released build: no engine badge', /Made-up Ep 01/.test(body) && !/engine: Rust/.test(body), body.slice(0, 300));
  await ctx.close();
  check('no page errors', !errors.length);
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
