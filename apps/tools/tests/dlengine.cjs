// Settings → Advanced, the download engine (stage M2 of the Rust port): on a phone that carries the Rust core the card
// is there, Java chosen by default, Rust picked → told to the engine (configure({ dlEngine })) and kept in the settings,
// the core's version, the engine in use and the fallback count shown; a phone without the core (deviceInfo's rustCore
// null) has no card; a computer (whose downloads are aria2's) never has it, even with a bridge that says it has a core.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ogg': 'audio/ogg' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch(); const errors = [];
  const check = (what, ok, x) => { console.log(ok ? 'ok  ' : 'FAIL', what, ok ? '' : JSON.stringify(x ?? '')); if (!ok) errors.push(what); };
  // o.kind: 'phone' (Capacitor, Android) or 'pc' (the desktop bridge); o.core: what deviceInfo says of the core.
  const open = async (o) => {
    const ctx = await br.newContext({ viewport: o.kind === 'pc' ? { width: 1366, height: 768 } : { width: 420, height: 860 } }); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
    await ctx.route(/raw\.githubusercontent\.com|api\.github\.com/, (r) => r.fulfill({ status: 404 }));
    await p.addInitScript((o) => {
      localStorage.setItem('kr.lang', o.lang || 'en'); localStorage.setItem('kt.pc.starter', '1'); localStorage.setItem('kt.update.lastCheck', String(Date.now()));
      window.__calls = []; let engine = 'java'; let fallbacks = 2;
      const info = async () => ({ abis: ['arm64-v8a'], rustCore: o.core, rustCoreStatus: o.core ? 'Rust core: ' + o.core : 'Rust core: absent', dlEngineChoice: engine, dlEngine: o.core ? engine : 'java', dlEngineFallbacks: fallbacks });
      if (o.kind === 'pc') {
        window.kurokawaTools = new Proxy({ platform: 'desktop', available: true, os: 'win32', list: async () => [], onTasks: () => () => {}, deviceInfo: info }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) });
        return;
      }
      const api = { addListener: () => ({ remove() {} }), list: async () => ({ tasks: [] }), deviceInfo: info, configure: async (c) => { window.__calls.push(c); if (c.dlEngine) engine = c.dlEngine; } };
      const plugin = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
    }, o);
    await p.goto(base + '#/settings'); await p.waitForSelector('.settings-body > .card'); await p.waitForTimeout(600);
    return { p, ctx };
  };

  // A phone with the core: the card, Java by default.
  let { p, ctx } = await open({ kind: 'phone', core: '0.3.0' });
  check('phone with the core: «Advanced» is there', !!(await p.$('#advanced')));
  if (await p.$('#advanced.collapsed')) await p.click('#advanced h3');
  const txt = await p.$eval('#advanced', (e) => e.textContent);
  check('it names the download engine, Classic (Java) chosen by default', /Download engine/.test(txt) && /Classic/.test(await p.$eval('#advanced .dl-engine-row button', (e) => e.textContent)), txt);
  check('the core\'s version, the engine in use, the fallbacks', /Rust core 0\.3\.0/.test(txt) && /in use: Classic/.test(txt) && /handed back to Classic: 2/.test(txt), txt);
  await p.click('#advanced .dl-engine-row button'); await p.waitForTimeout(300);
  await p.locator('label.dest-row', { hasText: 'Rust' }).first().click(); await p.waitForTimeout(500);
  const calls = await p.evaluate(() => window.__calls);
  check('Rust picked: told to the engine', calls.some((c) => c.dlEngine === 'rust'), calls);
  check('…and kept in the settings', await p.evaluate(() => JSON.parse(localStorage.getItem('kt.settings') || '{}').dlEngine) === 'rust');
  check('…and the line says it is in use', /in use: Rust/.test(await p.$eval('#advanced', (e) => e.textContent)));
  await ctx.close();
  // The same phone in Arabic: the card in its words.
  ({ p, ctx } = await open({ kind: 'phone', core: '0.3.0', lang: 'ar' }));
  if (await p.$('#advanced.collapsed')) await p.click('#advanced h3');
  const ar = await p.$eval('#advanced', (e) => e.textContent);
  check('Arabic: the card in Arabic, the count as «العدد»', /محرّك التنزيل/.test(ar) && /العدد: ٢|العدد: 2/.test(ar), ar);
  await ctx.close();
  // A phone whose bridge reports no core: no card.
  ({ p, ctx } = await open({ kind: 'phone', core: null }));
  check('phone without the core: no «Advanced»', !(await p.$('#advanced')));
  check('…and nothing about the engine anywhere', !/Download engine/.test(await p.$eval('.settings-body', (e) => e.textContent)));
  await ctx.close();
  // A computer: never, even with a bridge that claims a core.
  ({ p, ctx } = await open({ kind: 'pc', core: '0.3.0' }));
  const ids = await p.$$eval('.settings-body > .card', (e) => e.map((c) => c.id));
  check('computer: no «Advanced» card', !ids.includes('advanced'), ids);
  await p.fill('.settings-search', 'engine'); await p.waitForTimeout(200);
  check('computer: a search finds no download-engine switch', !/Download engine/.test(await p.$eval('.settings-body', (e) => e.textContent)));
  await ctx.close();
  check('no page errors', !errors.length);
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
