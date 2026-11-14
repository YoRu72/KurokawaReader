// The window's own bar on a computer (both apps run this test, each with its own page): the icon and the name on a
// strip at the top in the theme's colours, told to the system's buttons; the page below it; gone in full screen; no
// bar in a browser. Run: node tests/titlebar.cjs [tools|reader]
// The Reader also has the Tauri shell's bar, drawn whole by the page (src/ui/winbar.ts; desktop-tauri/bridge.js with a
// fake Tauri IPC, as tests/tauribridge.cjs does): there only — not on Electron's bridge, a web page or a phone —; its
// buttons send the shell the right actions, the maximise icon follows the state, a double-click toggles it, a press
// drags; the settings (the app's own / the system's, transparent, the name) apply, persist and are offered there
// alone; mirrored right to left; hidden in full screen and immersive reading; a Mac keeps its lights; and nothing of
// the page under its buttons, at 1024 and 1366 px, solid and transparent.
// Tools has the same bar on its Tauri shell (the same src/ui/winbar.ts, desktop-tauri/bridge.js's titleBar →
// kt_title_bar, the kt:titleBarState event): `titlebar.cjs tools` checks it there — the bar, its buttons and what they
// send, full screen, the settings (kind, transparent, name: offered, applied, kept) — and that Electron's bridge, a web
// page and a phone have none of it. (The same file is in both apps' tests: tests/shared-copies.cjs.)
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const APP = process.argv[2] || (__dirname.includes('/reader/') ? 'reader' : 'tools');
const DIST = path.join(__dirname, '..', '..', APP, 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch(); const errors = [];
  const check = (what, ok, x) => { console.log(ok ? 'ok  ' : 'FAIL', `${APP}: ${what}`, ok ? '' : JSON.stringify(x ?? '')); if (!ok) errors.push(what); };
  const ctx = await br.newContext({ viewport: { width: 1366, height: 768 } }); await ctx.route(/raw\.githubusercontent\.com/, (r) => r.fulfill({ status: 404 }));
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript((app) => {
    localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.pc.starter', '1'); window.__tb = []; let cb = null;
    const tb = { titleBar: async (o) => { if (o) window.__tb.push(o); return { platform: 'win32', height: 38, fullscreen: false }; }, onTitleBarState: (f) => { cb = f; return () => {}; } };
    window.__full = (on) => cb && cb({ fullscreen: on });
    if (app === 'tools') window.kurokawaTools = new Proxy({ platform: 'desktop', available: true, os: 'win32', list: async () => [], onTasks: () => () => {}, ...tb }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) });
    else window.kurokawaDesktop = { onOpenFile: () => {}, setZoom: () => {}, ...tb };
  }, APP);
  await p.goto(base); await p.waitForSelector('.win-titlebar'); await p.waitForTimeout(800);
  const g = await p.evaluate(() => { const b = document.querySelector('.win-titlebar').getBoundingClientRect(); const rail = document.querySelector('.rail, .pc-rail, nav.rail, .side-rail'); return { top: b.top, h: b.height, name: document.querySelector('.win-title').textContent, logo: !!document.querySelector('.win-titlebar img[data-brand]'), railTop: rail ? rail.getBoundingClientRect().top : -1, bodyTop: document.body.getBoundingClientRect().top }; });
  check('a bar of its own at the top, with the icon and the name', g.top === 0 && g.h === 38 && /Kurokawa/i.test(g.name) && g.logo, g);
  check('the page below it', g.bodyTop === 38 && (g.railTop < 0 || g.railTop >= 38), g);
  const sent = await p.evaluate(() => window.__tb.at(-1)); check('the system\'s buttons told the theme\'s colours', !!sent && /^#[0-9a-f]{6}$/.test(sent.color) && /^#[0-9a-f]{6}$/.test(sent.symbol), sent);
  await p.evaluate(() => window.__full(true)); await p.waitForTimeout(100);
  check('Electron: not the Tauri shell\'s bar', !(await p.$('.kr-winbar')) && !(await p.evaluate(() => document.documentElement.classList.contains('winbar'))));
  check('gone in full screen', await p.evaluate(() => getComputedStyle(document.querySelector('.win-titlebar')).display === 'none' && document.body.getBoundingClientRect().top === 0));
  await p.evaluate(() => window.__full(false));
  await ctx.close();
  const c2 = await br.newContext({ viewport: { width: 1366, height: 768 } }); await c2.route(/raw\.githubusercontent\.com/, (r) => r.fulfill({ status: 404 })); const q = await c2.newPage(); q.on('pageerror', (e) => errors.push(e.message));
  await q.addInitScript(() => localStorage.setItem('kr.lang', 'en')); await q.goto(base); await q.waitForTimeout(1500);
  check('no bar in a browser', !(await q.$('.win-titlebar')) && (await q.evaluate(() => document.body.getBoundingClientRect().top)) === 0);
  await c2.close();
  if (APP === 'reader') await tauriPart(br, base, check, errors);
  if (APP === 'tools') await toolsTauriPart(br, base, check, errors);
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });

// ---------- the Tauri shell's bar (the Reader) ----------
const BRIDGE = fs.readFileSync(path.join(__dirname, '..', 'desktop-tauri', 'bridge.js'), 'utf8');
// (A fake Tauri IPC: kr_title_bar keeps a window's state and tells each change as the kr:titleBarState event.)
const FAKE = (os) => `(function () {
  var os = ${JSON.stringify(os)};
  var st = { platform: os, height: os === 'darwin' ? 28 : 32, own: true, wanted: true, controls: os === 'darwin' ? 'system' : 'own', maximized: false, fullscreen: false, focused: true };
  var subs = []; window.__wb = { state: st, calls: [] };
  window.__wbEmit = function (patch) { Object.assign(st, patch || {}); subs.forEach(function (f) { f({ event: 'kr:titleBarState', payload: JSON.parse(JSON.stringify(st)) }); }); };
  var replies = {
    kr_scan_device: function () { return { root: '/home/u', files: [], truncated: false }; }, kr_file_size: function () { return -1; }, kr_folder_read: function () { return null; },
    kr_http: function (a) { return { status: 404, url: a.o.url, headers: {}, body: '' }; },
    // (Stage R5: the interface's size is the web view's own zoom — Tauri's set_zoom, which the resolved Tauri has —, so
    // the page's CSS pixels stay as they are; the bridge zooms with CSS only where it has not.)
    kr_set_zoom: function () { return true; },
    kr_title_bar: function (a) {
      var o = (a && a.o) || {}; window.__wb.calls.push(JSON.parse(JSON.stringify(o)));
      if (typeof o.own === 'boolean') { st.wanted = o.own; if (os !== 'darwin') st.own = o.own; }
      if (o.act === 'maximize') setTimeout(function () { window.__wbEmit({ maximized: !st.maximized }); }, 5);
      return JSON.parse(JSON.stringify(st));
    },
  };
  window.__TAURI__ = { core: { invoke: function (c, a) { return replies[c] ? Promise.resolve(replies[c](a)) : Promise.resolve(null); } },
    event: { listen: function (n, f) { if (n === 'kr:titleBarState') subs.push(f); return Promise.resolve(function () { var i = subs.indexOf(f); if (i >= 0) subs.splice(i, 1); }); } } };
})();`;
const overlap = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

async function tauriPart(br, base, check, errors) {
  const make = async ({ os = 'win32', lang = 'en', visual = {}, width = 1366 } = {}) => {
    const ctx = await br.newContext({ viewport: { width, height: 768 }, serviceWorkers: 'block' }); await ctx.route(/raw\.githubusercontent\.com/, (r) => r.fulfill({ status: 404 }));
    const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message)); p.setDefaultTimeout(15000);
    await p.addInitScript(({ lang, visual }) => { if (!sessionStorage.getItem('tb.init')) { sessionStorage.setItem('tb.init', '1'); localStorage.setItem('kr.lang', lang); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.visual', JSON.stringify({ bookPage: 'never', ...visual })); } }, { lang, visual });
    await p.addInitScript({ content: FAKE(os) });
    await p.addInitScript({ content: `window.__KR_BOOT__ = ${JSON.stringify({ os, arch: 'x64' })};\n${BRIDGE}` });
    await p.goto(base + '#/'); await p.waitForSelector('.library-view'); await p.waitForTimeout(500);
    return { ctx, p };
  };
  const calls = (p) => p.evaluate(() => window.__wb.calls.slice());
  const cls = (p, c) => p.evaluate((c) => document.documentElement.classList.contains(c), c);
  const rect = (p, sel) => p.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; }, sel);
  const importBook = async (p) => {
    await p.setInputFiles('.library-view input[type=file]', path.join(DIST, 'samples', 'maqamat-al-hariri.epub'));
    await p.waitForSelector('.book-card:not(.folder-card):not(.device-card)', { timeout: 30000 });
    return p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result[0].id); }; }));
  };
  const toReader = async (p, id) => { await p.evaluate((id) => { location.hash = '#/read/' + id; }, id); await p.waitForSelector('.reader-flow p', { timeout: 30000 }); await p.waitForTimeout(900); };

  /* 1. The bar, its buttons and what they send. */
  let { ctx, p } = await make();
  await p.waitForSelector('.kr-winbar');
  const g = await p.evaluate(() => {
    const b = document.querySelector('.kr-winbar').getBoundingClientRect();
    const btns = [...document.querySelectorAll('.kr-winbar .wb-btn')].map((x) => { const r = x.getBoundingClientRect(); return { cls: x.className, label: x.getAttribute('aria-label'), w: r.width, h: r.height, left: r.left, tab: x.tabIndex }; });
    return { top: b.top, h: b.height, w: b.width, bodyTop: document.body.getBoundingClientRect().top, name: document.querySelector('.kr-winbar .wb-name').textContent, logo: !!document.querySelector('.kr-winbar img[data-brand]'), btns, group: document.querySelector('.kr-winbar .wb-controls').getAttribute('aria-label'), shell: window.__KR_SHELL__, old: !!document.querySelector('.win-titlebar') };
  });
  check('tauri: the bar at the top, 32 px, the icon and the name; the page below it', g.top === 0 && g.h === 32 && g.bodyTop === 32 && /Kurokawa/.test(g.name) && g.logo && g.shell === 'tauri' && !g.old, g);
  check('tauri: three buttons of 46×32 at the end, named, in the keyboard\'s order', g.btns.length === 3 && g.btns.every((b) => b.w === 46 && b.h === 32 && b.tab === 0) && g.btns.map((b) => b.label).join('|') === 'Minimise|Maximise|Close' && g.btns[2].left + 46 === g.w && g.group === 'Window controls', g.btns);
  const asked = await calls(p); check('tauri: the shell asked for the app\'s own bar at the start', asked[0] && asked[0].own === true, asked);
  await p.evaluate(() => { window.__wb.calls.length = 0; });
  await p.click('.wb-min'); await p.click('.wb-close');
  check('tauri: minimise and close send their actions', JSON.stringify((await calls(p)).map((c) => c.act)) === '["minimize","close"]', await calls(p));
  await p.click('.wb-max'); await p.waitForTimeout(120);
  const maxed = { cls: await cls(p, 'wb-maxed'), label: await p.getAttribute('.wb-max', 'aria-label'), restoreShown: await p.evaluate(() => getComputedStyle(document.querySelector('.wb-max .g-restore')).opacity) };
  await p.waitForTimeout(600); maxed.restoreShown = await p.evaluate(() => getComputedStyle(document.querySelector('.wb-max .g-restore')).opacity);
  check('tauri: maximise → the state event → the icon and the name become «Restore»', maxed.cls && maxed.label === 'Restore' && maxed.restoreShown === '1', maxed);
  await p.click('.wb-max'); await p.waitForTimeout(120);
  check('tauri: and back', !(await cls(p, 'wb-maxed')) && (await p.getAttribute('.wb-max', 'aria-label')) === 'Maximise');
  await p.evaluate(() => { window.__wb.calls.length = 0; });
  await p.mouse.move(600, 16); await p.mouse.down(); await p.mouse.up();
  await p.waitForTimeout(400);
  await p.mouse.dblclick(600, 16); await p.waitForTimeout(150);
  const acts = (await calls(p)).map((c) => c.act);
  check('tauri: a press on the bar drags the window, a double-click maximises it', acts[0] === 'drag' && acts.includes('maximize') && await cls(p, 'wb-maxed'), acts);
  await p.mouse.dblclick(600, 16); await p.waitForTimeout(150);
  check('tauri: a second double-click restores it', !(await cls(p, 'wb-maxed')));
  await p.evaluate(() => { window.__wb.calls.length = 0; });
  await p.focus('.wb-min'); await p.keyboard.press('Tab'); await p.keyboard.press('Enter'); await p.waitForTimeout(120);
  check('tauri: the buttons work from the keyboard', (await calls(p)).some((c) => c.act === 'maximize'), await calls(p));
  await p.evaluate(() => window.__wbEmit({ maximized: false, focused: false })); await p.waitForTimeout(50);
  check('tauri: the bar quietens when the window is not in front', await cls(p, 'wb-blur'));
  await p.evaluate(() => window.__wbEmit({ focused: true }));
  check('tauri: the sidebar leaves the icon and the name to the bar', await p.evaluate(() => getComputedStyle(document.querySelector('.rail-brand > .rail-name')).display === 'none'));

  /* 2. Full screen and immersive reading hide it; a mouse at the top shows it for a moment. */
  await p.evaluate(() => window.__wbEmit({ fullscreen: true })); await p.waitForTimeout(80);
  check('tauri: hidden in full screen, the page at the top', await p.evaluate(() => getComputedStyle(document.querySelector('.kr-winbar')).display === 'none' && document.body.getBoundingClientRect().top === 0));
  await p.evaluate(() => window.__wbEmit({ fullscreen: false })); await p.waitForTimeout(80);
  check('tauri: back after full screen', await p.evaluate(() => getComputedStyle(document.querySelector('.kr-winbar')).display === 'flex' && document.body.getBoundingClientRect().top === 32));
  const id = await importBook(p);
  await toReader(p, id);
  check('tauri: in the reader the bar takes the page\'s colour', await p.evaluate(() => { const rv = document.querySelector('.reader-view'); return getComputedStyle(document.querySelector('.kr-winbar')).backgroundColor === getComputedStyle(rv.querySelector('.reader')).backgroundColor || !!document.querySelector('.kr-winbar').style.getPropertyValue('--wb-bg'); }));
  await p.mouse.click(683, 450); await p.waitForTimeout(500);
  const imm = { imm: await p.evaluate(() => !!document.querySelector('.reader-view.immersive')), hidden: await cls(p, 'wb-hide'), top: await p.evaluate(() => document.body.getBoundingClientRect().top) };
  check('tauri: hidden in immersive reading', imm.imm && imm.hidden && imm.top === 0, imm);
  await p.mouse.move(683, 1); await p.waitForTimeout(300);
  check('tauri: a mouse at the very top shows it over the page', await cls(p, 'wb-peek') && await p.evaluate(() => getComputedStyle(document.querySelector('.kr-winbar')).display === 'flex' && document.body.getBoundingClientRect().top === 0));
  await p.mouse.move(683, 300); await p.waitForTimeout(150);
  check('tauri: and hides it again when it leaves', !(await cls(p, 'wb-peek')));
  await p.mouse.click(683, 450); await p.waitForTimeout(500);
  check('tauri: back when immersive reading ends', !(await cls(p, 'wb-hide')));

  /* 3. The settings: offered here, applied at once, kept. */
  await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForSelector('.title-bar-field', { state: 'attached' });
  const rows = await p.evaluate(() => ({ kind: [...document.querySelectorAll('[data-tb-kind]')].map((b) => b.textContent + ':' + b.getAttribute('aria-pressed')), clear: !!document.querySelector('.wb-clear-switch'), name: !!document.querySelector('.wb-name-switch') }));
  check('tauri: the settings offer the title bar (the app\'s own pressed), transparent, the name', rows.kind.join('|') === "The app's own:true|The system's:false" && rows.clear && rows.name, rows);
  await p.evaluate(() => document.querySelector('.wb-clear-switch').click()); await p.waitForTimeout(600);
  const tr = await p.evaluate(() => ({ clear: document.documentElement.classList.contains('wb-clear'), bg: getComputedStyle(document.querySelector('.kr-winbar')).backgroundColor, top: document.body.getBoundingClientRect().top, kept: JSON.parse(localStorage.getItem('kr.visual')).titleBarClear }));
  check('tauri: transparent — no surface, the page under the bar', tr.clear && tr.bg === 'rgba(0, 0, 0, 0)' && tr.top === 0 && tr.kept === true, tr);
  await p.reload(); await p.waitForSelector('.kr-winbar'); await p.waitForTimeout(400);
  check('tauri: transparent kept after a reload', await cls(p, 'wb-clear'));
  await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForSelector('.title-bar-field', { state: 'attached' });
  await p.evaluate(() => document.querySelector('.wb-clear-switch').click()); await p.waitForTimeout(150);
  await p.evaluate(() => document.querySelector('.wb-name-switch').click()); await p.waitForTimeout(150);
  check('tauri: the name off — the bar is a plain strip, the sidebar keeps its name', !(await cls(p, 'wb-named')) && await p.evaluate(() => getComputedStyle(document.querySelector('.rail-brand > .rail-name')).display !== 'none'));
  await p.evaluate(() => document.querySelector('.wb-name-switch').click());
  await p.evaluate(() => { window.__wb.calls.length = 0; document.querySelector('[data-tb-kind="system"]').click(); }); await p.waitForTimeout(300);
  check('tauri: the system\'s frame — asked of the shell, the bar gone, the page at the top', (await calls(p)).some((c) => c.own === false) && !(await p.$('.kr-winbar')) && !(await cls(p, 'winbar')) && await p.evaluate(() => document.body.getBoundingClientRect().top === 0 && !document.querySelector('.wb-clear-switch')));
  await p.goto(base + '#/'); await p.reload(); await p.waitForSelector('.library-view'); await p.waitForTimeout(500);
  check('tauri: the system\'s frame kept (asked again at the start)', (await calls(p)).some((c) => c.own === false) && !(await p.$('.kr-winbar')));
  await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForSelector('[data-tb-kind="own"]', { state: 'attached' });
  await p.evaluate(() => document.querySelector('[data-tb-kind="own"]').click()); await p.waitForTimeout(300);
  check('tauri: the app\'s own again', !!(await p.$('.kr-winbar')) && await cls(p, 'winbar'));
  await ctx.close();

  /* 4. Nothing of the page under the buttons: library and reader, 1024 and 1366 px, solid and transparent. */
  for (const width of [1024, 1366]) for (const clear of [false, true]) for (const lang of ['en', 'ar']) {
    ({ ctx, p } = await make({ width, lang, visual: { titleBarClear: clear } }));
    const id2 = await importBook(p); await p.waitForTimeout(400);
    const hits = async (where) => p.evaluate(({ where }) => {
      const ov = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
      const ctl = [...document.querySelectorAll('.kr-winbar .wb-btn')].map((x) => x.getBoundingClientRect());
      const sel = '.reader-view .topbar button, .reader-view .topbar .title, .reader-view .float-toolbar button, .library-tools > *, .library-hero > *, .rail-brand button, .nav-rail button, .library-view .chips button, .library-view .folder-chips button';
      const out = [];
      for (const e of document.querySelectorAll(sel)) { if (!e.getClientRects().length) continue; const r = e.getBoundingClientRect(); if (!r.width || !r.height) continue; if (ctl.some((c) => ov(c, r))) out.push(where + ': ' + (e.getAttribute('aria-label') || e.className || e.tagName)); }
      return out;
    }, { where });
    const bad = [...await hits('library')];
    await toReader(p, id2); bad.push(...await hits('reader'));
    check(`tauri: nothing under the window's buttons (${width} px, ${clear ? 'transparent' : 'solid'}, ${lang})`, !bad.length && (await p.$$('.kr-winbar .wb-btn')).length === 3, bad);
    if (lang === 'ar' && width === 1366 && !clear) {
      const m = await p.evaluate(() => { const b = [...document.querySelectorAll('.kr-winbar .wb-btn')].map((x) => x.getBoundingClientRect().left); const n = document.querySelector('.kr-winbar .wb-brand img').getBoundingClientRect().left; return { close: b[2], min: b[0], brand: n, dir: getComputedStyle(document.querySelector('.kr-winbar')).direction, label: document.querySelector('.wb-close').getAttribute('aria-label') }; });
      check('tauri: right to left the bar mirrors — its buttons at the left, close leftmost, the name at the right', m.dir === 'rtl' && m.close < m.min && m.min < 200 && m.brand > 1200 && m.label === 'إغلاق', m);
    }
    await ctx.close();
  }

  /* 5. A Mac: the system's lights kept, room for them, no buttons of the page's. */
  ({ ctx, p } = await make({ os: 'darwin' }));
  await p.waitForSelector('.kr-winbar');
  const mac = await p.evaluate(() => ({ h: document.querySelector('.kr-winbar').getBoundingClientRect().height, ctl: getComputedStyle(document.querySelector('.kr-winbar .wb-controls')).display, pad: getComputedStyle(document.querySelector('.kr-winbar')).paddingLeft, top: document.body.getBoundingClientRect().top }));
  check('tauri (Mac): a 28 px bar, the lights\' room at its left, no buttons of the page\'s', mac.h === 28 && mac.ctl === 'none' && mac.pad === '78px' && mac.top === 28, mac);
  await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForSelector('.title-bar-field', { state: 'attached' });
  check('tauri (Mac): the row says a change waits for the next start', await p.evaluate(() => /next time the app starts/.test(document.querySelector('.title-bar-field .hint').textContent)));
  await ctx.close();

  /* 6. Nowhere else: a web page, a phone. */
  for (const [what, init] of [['a web page on a computer', () => {}], ['a phone app', () => { window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {} }; }]]) {
    const c = await br.newContext({ viewport: what === 'a phone app' ? { width: 412, height: 915 } : { width: 1366, height: 768 }, serviceWorkers: 'block' }); const q = await c.newPage();
    await q.addInitScript(() => localStorage.setItem('kr.lang', 'en')); await q.addInitScript(init);
    await q.goto(base + '#/settings'); await q.waitForSelector('.settings-body'); await q.waitForTimeout(800);
    check(`tauri: no bar and no title-bar settings on ${what}`, !(await q.$('.kr-winbar')) && !(await q.$('.title-bar-field')));
    await c.close();
  }
}

// ---------- the Tauri shell's bar (Tools) ----------
const FAKE_KT = (os) => `(function () {
  var os = ${JSON.stringify(os)};
  var st = { platform: os, height: os === 'darwin' ? 28 : 32, own: true, wanted: true, controls: os === 'darwin' ? 'system' : 'own', maximized: false, fullscreen: false, focused: true };
  var subs = []; window.__wb = { state: st, calls: [] };
  window.__wbEmit = function (patch) { Object.assign(st, patch || {}); subs.forEach(function (f) { f({ event: 'kt:titleBarState', payload: JSON.parse(JSON.stringify(st)) }); }); };
  var replies = {
    kt_state: function () { return { available: false, reason: '', os: os, arch: 'x64' }; }, kt_list: function () { return []; },
    kt_title_bar: function (a) {
      var o = (a && a.o) || {}; window.__wb.calls.push(JSON.parse(JSON.stringify(o)));
      if (typeof o.own === 'boolean') { st.wanted = o.own; if (os !== 'darwin') st.own = o.own; }
      if (o.act === 'maximize') setTimeout(function () { window.__wbEmit({ maximized: !st.maximized }); }, 5);
      return JSON.parse(JSON.stringify(st));
    },
  };
  window.__TAURI__ = { core: { invoke: function (c, a) { return Promise.resolve(replies[c] ? replies[c](a) : null); } },
    event: { listen: function (n, f) { if (n === 'kt:titleBarState') subs.push(f); return Promise.resolve(function () { var i = subs.indexOf(f); if (i >= 0) subs.splice(i, 1); }); } } };
})();`;

async function toolsTauriPart(br, base, check, errors) {
  const make = async ({ os = 'win32', lang = 'en', settings = {} } = {}) => {
    const ctx = await br.newContext({ viewport: { width: 1366, height: 768 }, serviceWorkers: 'block' }); await ctx.route(/raw\.githubusercontent\.com|api\.github\.com/, (r) => r.fulfill({ status: 404, body: '' }));
    const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message)); p.setDefaultTimeout(15000);
    await p.addInitScript(({ lang, settings }) => { if (!sessionStorage.getItem('tb.init')) { sessionStorage.setItem('tb.init', '1'); localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.pc.starter', '1'); localStorage.setItem('kt.settings', JSON.stringify(settings)); } }, { lang, settings });
    await p.addInitScript({ content: FAKE_KT(os) });
    await p.addInitScript({ content: `window.__KT_BOOT__ = ${JSON.stringify({ os, arch: 'x64' })};\n${BRIDGE}` });
    await p.goto(base + '#/'); await p.waitForSelector('.kr-winbar', { state: 'attached' }); await p.waitForTimeout(500);
    return { ctx, p };
  };
  const calls = (p) => p.evaluate(() => window.__wb.calls.slice());
  const cls = (p, c) => p.evaluate((c) => document.documentElement.classList.contains(c), c);
  let { ctx, p } = await make();
  const g = await p.evaluate(() => {
    const b = document.querySelector('.kr-winbar').getBoundingClientRect();
    const btns = [...document.querySelectorAll('.kr-winbar .wb-btn')].map((x) => { const r = x.getBoundingClientRect(); return { label: x.getAttribute('aria-label'), w: r.width, h: r.height, left: r.left }; });
    return { top: b.top, h: b.height, w: b.width, bodyTop: document.body.getBoundingClientRect().top, name: document.querySelector('.kr-winbar .wb-name').textContent, logo: !!document.querySelector('.kr-winbar img[data-brand]'), btns, shell: window.__KT_SHELL__, old: !!document.querySelector('.win-titlebar') };
  });
  check('tauri (Tools): the bar at the top, 32 px, the icon and the name; the page below it; not Electron\'s', g.top === 0 && g.h === 32 && g.bodyTop === 32 && /Kurokawa/.test(g.name) && g.logo && g.shell === 'tauri' && !g.old, g);
  check('tauri (Tools): three buttons of 46×32 at the end, named', g.btns.length === 3 && g.btns.every((b) => b.w === 46 && b.h === 32) && g.btns.map((b) => b.label).join('|') === 'Minimise|Maximise|Close' && g.btns[2].left + 46 === g.w, g.btns);
  check('tauri (Tools): the shell asked for the app\'s own bar at the start', (await calls(p))[0]?.own === true, await calls(p));
  await p.evaluate(() => { window.__wb.calls.length = 0; });
  await p.click('.wb-min'); await p.click('.wb-max'); await p.waitForTimeout(150);
  check('tauri (Tools): minimise and maximise sent; the state comes back as «Restore»', JSON.stringify((await calls(p)).map((c) => c.act)) === '["minimize","maximize"]' && await cls(p, 'wb-maxed') && (await p.getAttribute('.wb-max', 'aria-label')) === 'Restore', await calls(p));
  await p.evaluate(() => { window.__wb.calls.length = 0; }); await p.mouse.move(600, 16); await p.mouse.down(); await p.mouse.up(); await p.waitForTimeout(100);
  check('tauri (Tools): a press on the bar drags the window', (await calls(p))[0]?.act === 'drag', await calls(p));
  await p.evaluate(() => window.__wbEmit({ fullscreen: true })); await p.waitForTimeout(80);
  check('tauri (Tools): hidden in full screen, the page at the top', await p.evaluate(() => getComputedStyle(document.querySelector('.kr-winbar')).display === 'none' && document.body.getBoundingClientRect().top === 0));
  await p.evaluate(() => window.__wbEmit({ fullscreen: false })); await p.waitForTimeout(80);
  await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForSelector('.title-bar-field', { state: 'attached' });
  const rows = await p.evaluate(() => ({ kind: [...document.querySelectorAll('[data-tb-kind]')].map((b) => b.textContent + ':' + b.getAttribute('aria-pressed')), clear: !!document.querySelector('.wb-clear-switch'), name: !!document.querySelector('.wb-name-switch') }));
  check('tauri (Tools): the settings offer the title bar (the app\'s own pressed), transparent, the name', rows.kind.join('|') === "The app's own:true|The system's:false" && rows.clear && rows.name, rows);
  await p.evaluate(() => document.querySelector('.wb-clear-switch').click()); await p.waitForTimeout(500);
  const tr = await p.evaluate(() => ({ clear: document.documentElement.classList.contains('wb-clear'), bg: getComputedStyle(document.querySelector('.kr-winbar')).backgroundColor, top: document.body.getBoundingClientRect().top, kept: JSON.parse(localStorage.getItem('kt.settings')).titleBarClear }));
  check('tauri (Tools): transparent — no surface, the page under the bar, kept', tr.clear && tr.bg === 'rgba(0, 0, 0, 0)' && tr.top === 0 && tr.kept === true, tr);
  await p.reload(); await p.waitForSelector('.kr-winbar', { state: 'attached' }); await p.waitForTimeout(400);
  check('tauri (Tools): transparent kept after a reload', await cls(p, 'wb-clear'));
  await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForSelector('.title-bar-field', { state: 'attached' });
  await p.evaluate(() => document.querySelector('.wb-clear-switch').click()); await p.waitForTimeout(200);
  await p.evaluate(() => document.querySelector('.wb-name-switch').click()); await p.waitForTimeout(200);
  check('tauri (Tools): the name off — a plain strip', !(await cls(p, 'wb-named')) && !(await cls(p, 'wb-clear')));
  await p.evaluate(() => { window.__wb.calls.length = 0; document.querySelector('[data-tb-kind="system"]').click(); }); await p.waitForTimeout(300);
  check('tauri (Tools): the system\'s frame — asked of the shell, the bar gone, the page at the top', (await calls(p)).some((c) => c.own === false) && !(await p.$('.kr-winbar')) && !(await cls(p, 'winbar')) && await p.evaluate(() => document.body.getBoundingClientRect().top === 0 && !document.querySelector('.wb-clear-switch')));
  await p.evaluate(() => document.querySelector('[data-tb-kind="own"]').click()); await p.waitForTimeout(300);
  check('tauri (Tools): the app\'s own again', !!(await p.$('.kr-winbar')) && await cls(p, 'winbar'));
  await ctx.close();
  ({ ctx, p } = await make({ lang: 'ar' }));
  const m = await p.evaluate(() => { const b = [...document.querySelectorAll('.kr-winbar .wb-btn')].map((x) => x.getBoundingClientRect().left); return { close: b[2], min: b[0], dir: getComputedStyle(document.querySelector('.kr-winbar')).direction, label: document.querySelector('.wb-close').getAttribute('aria-label') }; });
  check('tauri (Tools): right to left the bar mirrors — close leftmost, named in Arabic', m.dir === 'rtl' && m.close < m.min && m.min < 200 && m.label === 'إغلاق', m);
  await ctx.close();
  ({ ctx, p } = await make({ os: 'darwin' }));
  const mac = await p.evaluate(() => ({ h: document.querySelector('.kr-winbar').getBoundingClientRect().height, ctl: getComputedStyle(document.querySelector('.kr-winbar .wb-controls')).display, pad: getComputedStyle(document.querySelector('.kr-winbar')).paddingLeft }));
  check('tauri (Tools, Mac): a 28 px bar, the lights\' room, no buttons of the page\'s', mac.h === 28 && mac.ctl === 'none' && mac.pad === '78px', mac);
  await ctx.close();
  for (const [what, init] of [['a web page on a computer', () => {}], ['a phone app', () => { window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {} }; }], ["Electron's bridge", () => { window.kurokawaTools = new Proxy({ platform: 'desktop', available: true, os: 'win32', list: async () => [], onTasks: () => () => {}, titleBar: async () => ({ platform: 'win32', height: 38 }), onTitleBarState: () => () => {} }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) }); }]]) {
    const c = await br.newContext({ viewport: what === 'a phone app' ? { width: 412, height: 915 } : { width: 1366, height: 768 }, serviceWorkers: 'block' }); const q = await c.newPage();
    await q.addInitScript(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.pc.starter', '1'); }); await q.addInitScript(init);
    await q.goto(base + '#/settings'); await q.waitForTimeout(1200);
    check(`tauri (Tools): no Tauri bar and no title-bar settings on ${what}`, !(await q.$('.kr-winbar')) && !(await q.$('.title-bar-field')));
    await c.close();
  }
}
