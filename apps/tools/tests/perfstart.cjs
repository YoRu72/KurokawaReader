// node tests/perfstart.cjs: the start, measured with stand-ins only (the desktop bridge or the phone's plugin faked,
// the build served on loopback, a cold cache each run): script start → first paint → usable (the Downloads list on
// screen and its + button there), at phone size with the CPU slowed 4× and at PC size; and the start-up JavaScript —
// the bytes fetched before the list is usable and the modules in them (from the build's metafile when KR_META was set).
// Budgets (counts, not times, so CI does not flake): the start JS stays under START_KB, and none of the modules that
// only a sub-page needs is in it. KT_DIST=<another dist> measures another build (the «before»), budgets not checked.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = process.env.KT_DIST || path.join(__dirname, '..', 'dist'); const BEFORE = !!process.env.KT_DIST;
// (330 before 0.21: English's 2,500 strings were all in it; now only those the first screen names — scripts/build.mjs
// splitStrings. 186 KB then, the budget that plus room for what is coming.)
const START_KB = 200;
// (Sub-pages and things done after the first screen: never fetched before the list is usable.)
const NOT_AT_START = [/src\/updates\.ts$/, /src\/installer\.ts$/, /src\/updateCore\.ts$/, /src\/theme\/editor/, /src\/theme\/gallery\.ts$/, /src\/views\/(settings|player|files|screen|battery|btconnect|anime\w*|tv\w*|videoChooser|add|addVideo)\.ts$/, /src\/video\/(ytdlp|choice|errors|signin)\.ts$/, /src\/player\//, /src\/screen\//, /src\/anime\//, /src\/tv\//, /src\/i18n\/(rest\/|gate\.ts)/, /src\/i18n\/(ar|ja|zh|ko)\.ts$/, /src\/handover\.ts$/, /src\/anilist\.ts$/, /src\/backup\.ts$/, /src\/packs\.ts$/, /src\/addons\.ts$/, /src\/ui\/(handoversheet|ownersheet|firstrun|thumbs|backnav|dropzone|crash)\.ts$/, /src\/downloads\/(recorder|sidecars|hotkeys|done|browserEvents|net|power|relink|background|trash|trackers|episodeCache|cloud|mega|gdrive|social)\.ts$/, /src\/views\/(task|subs|search|videos|courses|pick|mini|overlay|fabMenu|extract|apk)\.ts$/];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
(async () => {
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`; const br = await chromium.launch();
  const run = async (kind) => {
    const ctx = await br.newContext(kind === 'phone' ? { viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true } : { viewport: { width: 1366, height: 768 } }); const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 404 }));
    if (kind === 'phone') { const cdp = await ctx.newCDPSession(p); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 }); }
    await p.addInitScript((kind) => {
      localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.pc.starter', '1'); localStorage.setItem('kt.update.lastCheck', String(Date.now()));
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      // (When the list is usable: on screen, with its + button.)
      window.__usable = 0; new MutationObserver((_, mo) => { if (document.querySelector('.downloads-view .fab') && document.querySelector('.downloads-view .task-list')) { mo.disconnect(); requestAnimationFrame(() => { window.__usable = performance.now(); }); } }).observe(document, { subtree: true, childList: true });
      if (kind === 'pc') window.kurokawaTools = new Proxy({ platform: 'desktop', available: true, os: 'linux', ready: async () => { await wait(150); return {}; }, list: async () => [], onTasks: (cb) => { cb([]); return () => {}; }, defaultDir: async () => '/d' }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) });
      else { const api = { addListener: () => ({ remove() {} }), list: async () => ({ tasks: [] }) }; const plugin = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => { await wait(20); return {}; }) }); window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] }; }
    }, kind);
    await p.goto(base + '#/'); await p.waitForFunction(() => window.__usable > 0, null, { timeout: 30000 });
    const r = await p.evaluate(() => { const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? performance.getEntriesByName('first-paint')[0]?.startTime ?? 0; const js = performance.getEntriesByType('resource').filter((e) => /\.js$/.test(new URL(e.name).pathname) && e.responseEnd <= window.__usable); return { fcp, usable: window.__usable, jsKB: js.reduce((a, e) => a + (e.encodedBodySize || e.transferSize || 0), 0) / 1024, files: js.map((e) => new URL(e.name).pathname.split('/').pop()) }; });
    await ctx.close(); return { ...r, errs };
  };
  // (The start JS proper: app.js and what it imports statically — what every start fetches before any code runs; read from the files, as scripts/build.mjs preload() does.)
  const A = path.join(DIST, 'assets'); const closure = new Set(); const visit = (f) => { if (closure.has(f) || !fs.existsSync(path.join(A, f))) return; closure.add(f); const src = fs.readFileSync(path.join(A, f), 'utf8'); for (const m of src.matchAll(/(?:^|[;}\s])import(?:[^"'()]*?from)?\s*["'](\.\/[^"']+\.js)["']/g)) visit(m[1].slice(2)); }; visit('app.js');
  const staticKB = [...closure].reduce((a, f) => a + fs.statSync(path.join(A, f)).size, 0) / 1024;
  console.log(`start JS (app.js and its static imports): ${staticKB.toFixed(1)} KB in ${closure.size} files`);
  const out = {};
  for (const kind of ['phone', 'pc']) {
    const rs = []; for (let i = 0; i < 9; i++) rs.push(await run(kind));
    out[kind] = { fcp: med(rs.map((r) => r.fcp)), usable: med(rs.map((r) => r.usable)), jsKB: rs[0].jsKB, files: rs[0].files, errs: rs.flatMap((r) => r.errs) };
    if (process.env.KT_FILES) console.log(out[kind].files.join(" "));
    console.log(`${kind}: first paint ${out[kind].fcp.toFixed(0)} ms · usable ${out[kind].usable.toFixed(0)} ms · JS fetched by then ${out[kind].jsKB.toFixed(1)} KB in ${out[kind].files.length} files`);
  }
  if (!BEFORE) {
    ok(`start JS under ${START_KB} KB`, staticKB < START_KB, staticKB);
    ok('no page errors', !out.phone.errs.length && !out.pc.errs.length, [...out.phone.errs, ...out.pc.errs]);
    const meta = path.join(__dirname, '..', 'meta.json');
    if (fs.existsSync(meta)) {
      const m = JSON.parse(fs.readFileSync(meta, 'utf8')); const mods = new Set();
      for (const f of closure) { const o = m.outputs[`dist/assets/${f}`]; if (o) for (const k of Object.keys(o.inputs)) mods.add(k); }
      const bad = [...mods].filter((k) => !/\.css$/.test(k) && NOT_AT_START.some((re) => re.test(k)));
      ok('no sub-page module in the start JS', !bad.length, bad);
    } else console.log('(no meta.json: build with KR_META=1 to check the modules)');
  }
  await br.close(); web.close(); process.exit(fails ? 1 : 0);
})();
