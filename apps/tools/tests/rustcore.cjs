// Settings → Advanced, stage M5 of the Rust port: «File jobs engine: Classic / Rust» and the «Rust core status» block.
// On a phone with the core: the row is there, Classic by default, Rust picked → told to the engine (configure({
// fileEngine })) and kept; the status lists the core, every engine deviceInfo reports (the download engine and the
// file jobs', and a sister stage's «torEngine» it has never heard of), their counters, the journal's jobs, and «Copy
// report» puts them on the clipboard; with only M2's fields (a build before M5) the status still shows what there is.
// A phone without the core: neither; a computer: never, even with a bridge that claims a core.
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
      window.__calls = []; let engine = 'java'; let fallbacks = 2; let fileEngine = 'classic';
      const m5 = () => (o.old ? {} : { fileEngineChoice: fileEngine, fileEngine: o.core ? fileEngine : 'classic', fileEngineFallbacks: 0, fileChecks: 7, fileMismatches: 0, fileDisputed: 0, fileJournalResumable: 1, fileJournalUndoable: 3, torEngine: 'java', torEngineChoice: 'java', torEngineFallbacks: 4 });
      const info = async () => ({ abis: ['arm64-v8a'], rustCore: o.core, rustCoreStatus: o.core ? 'Rust core: ' + o.core : 'Rust core: absent', rustShadow: { on: true, calls: 12, mismatches: 0, first: [] }, dlEngineChoice: engine, dlEngine: o.core ? engine : 'java', dlEngineFallbacks: fallbacks, ...m5() });
      if (o.kind === 'pc') {
        window.kurokawaTools = new Proxy({ platform: 'desktop', available: true, os: 'win32', list: async () => [], onTasks: () => () => {}, deviceInfo: info }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) });
        return;
      }
      const api = { addListener: () => ({ remove() {} }), list: async () => ({ tasks: [] }), deviceInfo: info, configure: async (c) => { window.__calls.push(c); if (c.dlEngine) engine = c.dlEngine; if (c.fileEngine) fileEngine = c.fileEngine; },
        filesJournals: async () => ({ items: [{ id: '17-j1', op: 'move', dest: '/storage/emulated/0/Movies', steps: 9, done: 4, resumable: true }] }), filesJournalResume: async (x) => { window.__calls.push({ resume: x.journal }); return { id: 'r' }; }, filesJournalRollback: async (x) => { window.__calls.push({ rollback: x.journal }); return { undone: 4 }; } };
      const plugin = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
    }, o);
    await p.goto(base + '#/settings'); await p.waitForSelector('.settings-body > .card'); await p.waitForTimeout(600);
    return { p, ctx };
  };

  // A phone with the core.
  let { p, ctx } = await open({ kind: 'phone', core: '0.2.0' });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => undefined);
  if (await p.$('#advanced.collapsed')) await p.click('#advanced h3');
  check('phone with the core: the file jobs engine row', !!(await p.$('#advanced .file-engine-row')));
  check('…Classic chosen by default', /Classic/.test(await p.$eval('#advanced .file-engine-row button', (e) => e.textContent)));
  const st = await p.$eval('#rust-status', (e) => e.textContent);
  check('the status: the core, the download engine and the file jobs engine', /Rust core status/.test(st) && /Rust core 0\.2\.0/.test(st) && !!(await p.$('#rust-status .rust-engine[data-area="dl"]')) && !!(await p.$('#rust-status .rust-engine[data-area="file"]')), st);
  check('…an engine of a stage it does not know (torEngine) shown too, with its fallbacks', !!(await p.$('#rust-status .rust-engine[data-area="tor"]')) && /fell back: 4/.test(await p.$eval('#rust-status .rust-engine[data-area="tor"]', (e) => e.textContent)));
  check('…the shadow checks and the journal', /Shadow checks: 12/.test(st) && /resumed: 1/.test(st) && /undone: 3/.test(st), st);
  await p.click('#rust-status .rust-copy'); await p.waitForTimeout(300);
  const clip = await p.evaluate(() => navigator.clipboard.readText().catch(() => ''));
  check('«Copy report»: every engine and counter on the clipboard', /fileEngineFallbacks/.test(clip) && /dl: in use java/.test(clip) && /tor: in use java/.test(clip), clip.slice(0, 300));
  await p.click('#rust-status .rust-jobs-open'); await p.waitForTimeout(300);
  check('the interrupted jobs listed, Resume and Roll back', /Movies/.test(await p.$eval('#rust-status .rust-jobs', (e) => e.textContent)) && (await p.$$('#rust-status .rust-job button')).length === 2);
  await p.click('#rust-status .rust-job button'); await p.waitForTimeout(300);
  check('…Resume asks the engine', (await p.evaluate(() => window.__calls)).some((c) => c.resume === '17-j1'));
  await p.click('#advanced .file-engine-row button'); await p.waitForTimeout(300);
  await p.locator('label.dest-row', { hasText: 'Rust' }).first().click(); await p.waitForTimeout(500);
  const calls = await p.evaluate(() => window.__calls);
  check('Rust picked: told to the engine', calls.some((c) => c.fileEngine === 'rust'), calls);
  check('…and kept in the settings', await p.evaluate(() => JSON.parse(localStorage.getItem('kt.settings') || '{}').fileEngine) === 'rust');
  check('…the status says it is in use', /in use: Rust/.test(await p.$eval('#rust-status .rust-engine[data-area="file"]', (e) => e.textContent)));
  check('the download engine row is still the first one', /Download engine/.test(await p.$eval('#advanced .dl-engine-row', (e) => e.textContent)));
  await ctx.close();
  // A build before M5 (only M2's fields): the status shows what there is, without errors.
  ({ p, ctx } = await open({ kind: 'phone', core: '0.2.0', old: true }));
  if (await p.$('#advanced.collapsed')) await p.click('#advanced h3');
  check('older fields only: the status still there, the download engine in it, no journal line', !!(await p.$('#rust-status .rust-engine[data-area="dl"]')) && !(await p.$('#rust-status .rust-journal')) && !(await p.$('#rust-status .rust-jobs-open')));
  await ctx.close();
  // Arabic.
  ({ p, ctx } = await open({ kind: 'phone', core: '0.2.0', lang: 'ar' }));
  if (await p.$('#advanced.collapsed')) await p.click('#advanced h3');
  const ar = await p.$eval('#advanced', (e) => e.textContent);
  check('Arabic: the row and the status in Arabic, counts as «العدد»', /محرّك مهامّ الملفّات/.test(ar) && /حالُ نواة Rust/.test(ar) && /العدد: ٤|العدد: 4/.test(ar), ar.slice(0, 400));
  await ctx.close();
  // No core: nothing.
  ({ p, ctx } = await open({ kind: 'phone', core: null }));
  check('phone without the core: no file jobs engine, no status', !(await p.$('.file-engine-row')) && !(await p.$('#rust-status')));
  await ctx.close();
  // A computer: never.
  ({ p, ctx } = await open({ kind: 'pc', core: '0.2.0' }));
  check('computer: no file jobs engine, no status', !(await p.$('.file-engine-row')) && !(await p.$('#rust-status')));
  await p.fill('.settings-search', 'file jobs'); await p.waitForTimeout(200);
  check('computer: a search finds no file jobs engine', !/File jobs engine/.test(await p.$eval('.settings-body', (e) => e.textContent)));
  await ctx.close();
  check('no page errors', !errors.length);
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
