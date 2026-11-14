// node tests/firstrun.cjs: the computer app's first start in the Tauri build and the Electron build's offer of the move
// (Tools' stage P9 — src/ui/firstrun.ts, src/ui/handoversheet.ts, src/rustswitch.ts). The built app (dist/) in
// Chromium:
//   «Tauri»: the real desktop-tauri/bridge.js and handover-bridge.js over a pretend IPC; the first-run screen in English
//     and Arabic, light and dark: the language and the look change the page at once; the data tile looks for a
//     hand-over and, found, carries its offer (what it holds, where the old data stays, the downloads already here);
//     none found but the old copy's data still there → «open the previous Kurokawa Tools once», with its button;
//     «Use Kurokawa Tools» for torrents and magnets asks the shell (registerMagnet) only when pressed; Start closes it
//     and it is not shown again; under a test driver or the self-test it is never shown;
//   «Electron»: with RUST_SWITCH off (switchInfo → null) nothing is offered; with a release carrying the Tauri build the
//     sheet says what it is, «Move now» goes through installUpdate('rust-switch') and a refusal (Electron's wrapped
//     «kt-update:handover …») is said in words, the button becomes «Try again»; «Not now» holds for a day (a week with
//     weekly checks), not for a newer version.
// Screenshots with --shots <dir>.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..'); const DIST = path.join(ROOT, 'dist');
const BRIDGE = fs.readFileSync(path.join(ROOT, 'desktop-tauri', 'bridge.js'), 'utf8');
const HBRIDGE = fs.readFileSync(path.join(ROOT, 'desktop-tauri', 'handover-bridge.js'), 'utf8');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const shotsAt = process.argv.indexOf('--shots'); const SHOTS = shotsAt > 0 ? process.argv[shotsAt + 1] : null; if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 600))); if (!c) fails++; return !!c; };
const MARKER = { app: 'KurokawaTools', kind: 'handover', format: 1, id: 'h-1', createdAt: 1, bytes: 23 * 1048576, counts: { local: 41, lists: 6, addons: 2, downloads: 3, videos: 1 }, files: [{ rel: 'handover/local.json', size: 10, sha256: 'x' }] };

// The pretend Tauri IPC: kt_handover_find answers as set per page (window.__find), registerMagnet counted.
const TAURI_SHIM = (o) => {
  try { localStorage.setItem('kt.pc.starter', '1'); localStorage.setItem('kt.update.lastCheck', String(Date.now())); if (o.lang && !localStorage.getItem('kr.lang')) localStorage.setItem('kr.lang', o.lang); if (o.mode && !localStorage.getItem('kt.settings')) localStorage.setItem('kt.settings', JSON.stringify({ uiMode: o.mode })); } catch { /* first load */ }
  if (!o.driver) Object.defineProperty(navigator, 'webdriver', { get: () => false });
  window.__calls = []; window.__find = o.find;
  const replies = { kt_state: () => ({ available: false, reason: '', os: 'win32', arch: 'x64' }), kt_list: () => [], kt_open_take: () => [], kt_roots: () => ({ roots: [] }), kt_default_dir: () => 'C:\\Users\\u\\Downloads\\Kurokawa', kt_files_roots: () => ({ roots: [] }),
    kt_handover_find: () => window.__find, kt_register_magnet: () => true, kt_handover_open_old: () => true, kt_app_icon: () => null };
  window.__TAURI__ = { core: { invoke: (cmd, args) => { window.__calls.push(cmd); return Promise.resolve(replies[cmd] ? replies[cmd](args || {}) : null); } }, event: { listen: () => Promise.resolve(() => {}) } };
};

(async () => {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('no dist/: run node scripts/build.mjs first');
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}/`;
  const br = await chromium.launch(); const errors = [];
  const tauriPage = async (o) => {
    const ctx = await br.newContext({ viewport: { width: 1100, height: 760 }, colorScheme: o.mode === 'light' ? 'light' : 'dark' }); const p = await ctx.newPage(); p.setDefaultTimeout(20000);
    p.on('pageerror', (e) => errors.push(`${o.lang}/${o.mode}: ${e.message}`));
    await p.addInitScript(TAURI_SHIM, o);
    await p.addInitScript({ content: `window.__KT_BOOT__ = ${JSON.stringify({ os: 'win32', arch: 'x64' })};\n${BRIDGE}\n${HBRIDGE}` + (o.selftest ? '\nwindow.__KT_SELFTEST__ = {};' : '') });
    await p.goto(base); return p;
  };
  const found = { found: true, dir: 'C:\\Users\\u\\AppData\\Roaming\\Kurokawa Tools\\handover', marker: MARKER, state: null, engine: { id: 'h-1', state: 'carried', downloads: 3, videos: 1, moving: 2 }, dataDir: 'C:\\Users\\u\\AppData\\Roaming\\app.kurokawa.tools' };
  const left = { found: false, state: null, electron: { library: true, program: true } };

  for (const lang of ['en', 'ar']) for (const mode of ['light', 'dark']) {
    const tag = `${lang}/${mode}`;
    const p = await tauriPage({ lang, mode, find: found });
    await p.waitForSelector('.firstrun .fr-card');
    ok(`${tag}: the first-run screen at the first start`, await p.isVisible('.fr-start'));
    ok(`${tag}: written in its language, laid out its way`, (await p.evaluate(() => [document.documentElement.lang, document.documentElement.dir].join())) === (lang === 'ar' ? 'ar,rtl' : 'en,ltr'));
    await p.waitForSelector('.firstrun [data-handover="offer"]');
    const tile = await p.evaluate(() => document.querySelector('.firstrun [data-handover="offer"]').textContent);
    ok(`${tag}: the offer in the tile: what it holds, the downloads here, where the old data stays`, tile.includes(found.dir) && (lang === 'en' ? /Settings: 41/.test(tile) && /Downloads: 4/.test(tile) && /already here \(4\)/.test(tile) : /العدد: [٤4]/.test(tile)), tile.slice(0, 300));
    ok(`${tag}: Bring it now and Not now`, await p.isVisible('[data-handover-go]') && (await p.$$('.firstrun [data-handover="offer"] .btn')).length >= 2);
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `firstrun-${lang}-${mode}.png`) });
    const bg = await p.evaluate(() => getComputedStyle(document.querySelector('.fr-card')).backgroundColor);
    ok(`${tag}: the card in the ${mode} look`, mode === 'light' ? !/rgb\((1\d|2\d|3\d|4\d), /.test(bg) : /rgb\((1\d|2\d|3\d|4\d), /.test(bg), bg);
    await p.context().close();
  }

  // The look and the language change at once; the magnet button asks only when pressed; Start closes it for good.
  {
    const p = await tauriPage({ lang: 'en', mode: 'dark', find: left });
    await p.waitForSelector('.firstrun .fr-card');
    await p.waitForSelector('.fr-open-old');
    ok('none to bring, the old copy\'s data still there: «open the previous one once», with its button', /previous Kurokawa Tools still holds your data/.test(await p.evaluate(() => document.querySelector('.firstrun').textContent)));
    await p.click('.fr-open-old'); ok('… the button asks the shell to open it', await p.evaluate(() => window.__calls.includes('kt_handover_open_old')));
    ok('registerMagnet not asked before the button', !(await p.evaluate(() => window.__calls.includes('kt_register_magnet'))));
    await p.click('.fr-default'); await p.waitForTimeout(150);
    ok('«Use Kurokawa Tools» asks the shell, then says it is done', (await p.evaluate(() => window.__calls.includes('kt_register_magnet'))) && /open with Kurokawa Tools/.test(await p.evaluate(() => document.querySelector('.firstrun').textContent)));
    await p.click('.fr-seg button:has-text("Light")'); await p.waitForTimeout(200);
    ok('the look chosen: the page light at once', await p.evaluate(() => JSON.parse(localStorage.getItem('kt.settings') || '{}').uiMode === 'light'));
    await p.click('.fr-seg button:has-text("العربية")'); await p.waitForFunction(() => document.documentElement.lang === 'ar');
    ok('the language chosen: the screen in Arabic at once', /مرحبًا بك في أدوات كروكاوا/.test(await p.evaluate(() => document.querySelector('.firstrun').textContent)));
    await p.click('.fr-start'); await p.waitForTimeout(400);
    ok('Start closes it', !(await p.$('.firstrun')));
    await p.reload(); await p.waitForSelector('.downloads-view'); await p.waitForTimeout(800);
    ok('not shown at the next start', !(await p.$('.firstrun')));
    await p.context().close();
  }
  for (const [what, o] of [['a test driver', { driver: true }], ['the self-test', { selftest: true }]]) {
    const p = await tauriPage({ lang: 'en', mode: 'dark', find: left, ...o }); await p.waitForSelector('.downloads-view'); await p.waitForTimeout(800);
    ok(`never shown under ${what}`, !(await p.$('.firstrun'))); await p.context().close();
  }

  // ---------- the Electron build's offer of the move ----------
  // (Offered 20 s after the start: the page's clock run forward — Playwright's clock —, never a real wait.)
  const electronPage = async (info, fail, later) => {
    const ctx = await br.newContext({ viewport: { width: 1100, height: 760 } }); const p = await ctx.newPage(); p.setDefaultTimeout(20000);
    p.on('pageerror', (e) => errors.push('E: ' + e.message));
    await p.clock.install();
    await p.addInitScript(({ info, fail, later }) => {
      try { localStorage.setItem('kt.pc.starter', '1'); localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.update.lastCheck', String(Date.now())); if (later) localStorage.setItem('kt.rustSwitch.later', JSON.stringify({ v: later, at: Date.now() })); } catch { /* first */ }
      window.__asked = [];
      window.kurokawaHandover = Object.freeze({ shell: 'electron', switchInfo: () => Promise.resolve(info) });
      window.kurokawaTools = { platform: 'desktop', available: false, reason: '', os: 'win32', ready: () => Promise.resolve({}), list: () => Promise.resolve([]), onTasks: () => () => {}, onUpdateProgress: () => () => {},
        installUpdate: (u) => { window.__asked.push(u); return Promise.reject(new Error(fail)); } };
    }, { info, fail, later });
    await p.goto(base); await p.waitForSelector('.downloads-view');
    await p.clock.runFor(21000); await p.waitForTimeout(300);
    return p;
  };
  const INFO = { version: '0.17.0', name: 'KurokawaTools-0.17.0-windows-x64-setup.exe', size: 12 * 1048576, page: 'https://example.test/releases/tools-v0.17.0', portable: false, os: 'win32' };
  {
    const p = await electronPage(null, 'x');
    ok('Electron with RUST_SWITCH off (switchInfo → null): nothing offered', !(await p.$('.switch-sheet')));
    ok('… the hand-over\'s maker reachable by the shell (window.__KT_HANDOVER__.beforeInstall)', await p.evaluate(() => typeof window.__KT_HANDOVER__?.beforeInstall === 'function'));
    await p.context().close();
  }
  {
    const p = await electronPage(INFO, "Error invoking remote method 'kt:installUpdate': Error: kt-update:handover not made");
    const shown = !!(await p.$('.switch-sheet'));
    ok('Electron: a release carrying the Tauri build → the switch sheet, a while after the start', shown);
    if (shown) {
      const txt = await p.evaluate(() => document.querySelector('.switch-sheet').textContent);
      ok('… it says what it is, its file and size, and that the data and downloads come with it', /0\.17\.0/.test(txt) && txt.includes(INFO.name) && /12(\.0)? MB/.test(txt) && /downloads come with it/.test(txt), txt.slice(0, 400));
      if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'switch-en.png') });
      await p.click('[data-switch-go]'); await p.waitForSelector('.switch-sheet[data-switch="refused"]');
      ok('… «Move now» asks the shell for the switch (never an Electron update)', JSON.stringify(await p.evaluate(() => window.__asked)) === '["rust-switch"]');
      ok('… a refusal said in words, «Try again» offered', /could not be made ready, so nothing was installed/.test(await p.evaluate(() => document.querySelector('.switch-sheet [role="status"]').textContent)) && /Try again/.test(await p.evaluate(() => document.querySelector('[data-switch-go]').textContent)));
      await p.click('.switch-sheet .btn.text:has-text("Not now")');
      const later = JSON.parse(await p.evaluate(() => localStorage.getItem('kt.rustSwitch.later')));
      ok('… «Not now» kept for this version', later && later.v === '0.17.0');
    }
    await p.context().close();
  }
  {
    const p = await electronPage(INFO, 'x', '0.17.0');
    ok('«Not now» holds for that version (within a day)', !(await p.$('.switch-sheet')));
    await p.context().close();
    const q = await electronPage(INFO, 'x', '0.16.40');
    ok('… not for a newer version', !!(await q.$('.switch-sheet')));
    await q.context().close();
  }
  ok('no page errors', errors.length === 0, errors);
  await br.close(); server.close();
  console.log(fails ? `firstrun: ${fails} failed` : 'firstrun: all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
