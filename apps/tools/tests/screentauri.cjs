// The screen translator on a computer with the Tauri shell: every path of the page the eight channels drive, through the
// real desktop-tauri/bridge.js over a pretend Tauri IPC (kt_screen_* answered as src-tauri/src/screentr.rs answers),
// in English and Arabic — the settings page (status, turned on with its words for the tray, a shortcut set, the region
// forgotten, the region / clipboard buttons, a shortcut another program holds; this shell's own steps: the screen not
// takeable here with its reason, Wayland's portal, a Mac's Screen Recording permission with its button), the frozen
// screen (a region drawn → kt_screen_region in page pixels → translated over the words; Esc → kt_screen_close; «again»
// reads the kept region at once; «full» reads all of it; no OCR said plainly), «auto»'s caption (kt:screenCaption
// translated, its height sent back), the clipboard's window. Then the self-test's screen rows (selftest.js runScreen)
// against the pretend screen of tests/screenfake.cjs: all pass; with the capture's pixels wrong, the pixel rows fail.
// Run: NODE_PATH=$(npm root -g) node tests/screentauri.cjs
'use strict';
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm');
const DIST = path.join(__dirname, '..', 'dist');
const BRIDGE = fs.readFileSync(path.join(__dirname, '..', 'desktop-tauri', 'bridge.js'), 'utf8');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = () => http.createServer((req, r) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); r.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(r); });
let fails = 0; const ok = (what, cond, x) => { console.log((cond ? 'ok   ' : 'FAIL ') + what + (cond || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!cond) fails++; };

/** In the page, before the bridge: a pretend Tauri IPC with screentr.rs's answers. `v` picks the system. */
function fakeTauri({ lang, v }) {
  localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.pc.starter', '1');
  localStorage.setItem('kt.settings', JSON.stringify({ addons: ['screen'] }));
  window.__calls = []; const ls = {}; window.__emit = (n, p) => (ls[n] || []).forEach((f) => f({ event: n, payload: p }));
  const sys = { win: { os: 'win32', capture: { kind: 'gdi', why: '' }, ocr: 'windows' }, wayland: { os: 'linux', capture: { kind: 'portal', why: '' }, ocr: 'none' }, mac: { os: 'darwin', capture: { kind: 'screencapture', why: '' }, ocr: 'vision', permission: 'denied' }, none: { os: 'linux', capture: { kind: 'none', why: 'no X display (DISPLAY is not set)' }, ocr: 'tesseract' } }[v];
  let on = false; let conf = {}; let region = window.__region || null;
  const KEYS = { region: 'Alt+Shift+T', full: 'Alt+Shift+F', repeat: 'Alt+Shift+R', auto: 'Alt+Shift+A', clipboard: 'Alt+Shift+C' };
  const status = () => { const k = {}; for (const [a, acc] of Object.entries({ ...KEYS, ...((conf.pc && conf.pc.keys) || {}) })) k[a] = { acc, ok: on && a !== 'full' }; const s = { platform: sys.os, on, keys: k, tray: on && !!(conf.pc && conf.pc.tray), auto: false, region, ocr: sys.ocr, capture: sys.capture }; if (sys.permission) s.permission = sys.permission; return s; };
  const c = document.createElement('canvas'); c.width = 800; c.height = 500; const x = c.getContext('2d'); x.fillStyle = '#ffffff'; x.fillRect(0, 0, 800, 500); x.fillStyle = '#203080'; x.fillRect(100, 100, 300, 60); x.fillStyle = '#fff'; x.font = '30px sans-serif'; x.fillText('Hello there', 120, 140);
  const job = window.__job || { mode: 'region', image: c.toDataURL(), width: 800, height: 500, scale: 1, cfg: {} };
  const replies = {
    kt_state: () => ({ available: false, reason: '', os: sys.os, arch: 'x64' }), kt_list: () => [],
    kt_http: (a) => { const q = new URL(a.o.url).searchParams.get('q'); return { status: 200, headers: {}, body: JSON.stringify([[['TR(' + q + ')', q]], null, 'en']), url: a.o.url }; },
    kt_screen_status: () => status(),
    kt_screen_config: (a) => { conf = a.o.config || {}; on = !!conf.pcOn; if (a.o.clearFixed) region = null; return status(); },
    kt_screen_action: () => true,
    kt_screen_job: () => job,
    kt_screen_region: (a) => { if (window.__noOcr) return Promise.reject('ocr-missing'); const r = a.r; return { blocks: [{ text: 'Hello there', x: 105, y: 110, width: 280, height: 40 }, { text: '42', x: 10, y: 10, width: 20, height: 10 }].map((b) => (r ? b : { ...b })) }; },
    kt_screen_close: () => true,
    kt_screen_ocr_langs: () => ({ kind: sys.ocr, langs: ['en-US'] }),
    kt_screen_caption: () => true,
  };
  window.__TAURI__ = {
    core: { invoke: (cmd, a) => { window.__calls.push([cmd, JSON.parse(JSON.stringify(a || {}))]); try { return Promise.resolve(replies[cmd] ? replies[cmd](a || {}) : null); } catch (e) { return Promise.reject(e); } } },
    event: { listen: (n, f) => { (ls[n] = ls[n] || []).push(f); return Promise.resolve(() => { ls[n] = ls[n].filter((g) => g !== f); }); } },
  };
  window.__KT_BOOT__ = { os: sys.os, arch: 'x64' };
}

(async () => {
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch();
  const S = (lang) => { const esb = require('esbuild'); const out = esb.buildSync({ entryPoints: [path.join(__dirname, '..', 'src/i18n', `${lang}.ts`)], bundle: true, write: false, format: 'cjs', platform: 'node' }); const m = { exports: {} }; new Function('module', 'exports', out.outputFiles[0].text)(m, m.exports); return { ...m.exports.en, ...m.exports[lang] }; };
  for (const lang of ['en', 'ar']) {
    const T = S(lang); const L = (s) => `[${lang}] ${s}`;
    const open = async (v, hash, pre, size) => {
      const page = await br.newPage({ viewport: size || { width: 1000, height: 760 } }); const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
      await page.route(/api\.github\.com|raw\.githubusercontent\.com/, (r) => r.fulfill({ status: 404, body: '' }));
      if (pre) await page.addInitScript(pre);
      await page.addInitScript(fakeTauri, { lang, v }); await page.addInitScript({ content: BRIDGE });
      await page.goto(`${base}${hash}`);
      return { page, errors, calls: () => page.evaluate(() => window.__calls) };
    };
    // --- the settings page (Windows-like): turned on, a shortcut set, the region forgotten, the buttons.
    {
      const { page, errors, calls } = await open('win', '#/screen');
      await page.waitForSelector('#scr-keys input[name="key-region"]', { timeout: 15000 });
      ok(L('a computer\'s settings through the Tauri bridge: shortcuts and background, no bubble'), !!(await page.$('#scr-bg')) && !(await page.$('#scr-bubble')));
      ok(L('the computer\'s OCR named (Windows OCR)'), (await page.textContent('.screen-step[data-step="ocr"]')).includes(T.scrOcrWindows));
      ok(L('nothing about capture or permission where the screen can be taken'), !(await page.$('.screen-step[data-step="capture"]')) && !(await page.$('.screen-step[data-step="perm"]')));
      await page.click('.screen-go'); await page.waitForTimeout(400);
      const cfgs = async () => (await calls()).filter((c) => c[0] === 'kt_screen_config').map((c) => c[1].o);
      let last = (await cfgs()).pop();
      ok(L('turned on: kt_screen_config with pcOn, the keys, the tray, and the tray menu\'s words'), last && last.config.pcOn === true && last.config.pc.keys.region === 'Alt+Shift+T' && last.config.pc.tray === true && last.config.labels && last.config.labels.region === T.scr_region && last.config.labels.quit === T.scr_quit, last && last.config.labels);
      ok(L('a shortcut another program holds said'), !!(await page.$('.screen-step[data-step="key-full"]')));
      await page.click('input[name="key-region"]'); await page.keyboard.press('Control+Alt+KeyK'); await page.waitForTimeout(400);
      last = (await cfgs()).pop(); ok(L('a shortcut set by pressing keys'), last.config.pc.keys.region === 'Control+Alt+K');
      await page.click('#scr-read button.btn.text'); await page.waitForTimeout(300);
      last = (await cfgs()).pop(); ok(L('«forget the last region» → clearFixed'), last.clearFixed === true);
      const btns = page.locator('#scr-keys .row-actions button');
      await btns.nth(0).click(); await btns.nth(1).click(); await page.waitForTimeout(200);
      const acts = (await calls()).filter((c) => c[0] === 'kt_screen_action').map((c) => c[1]);
      ok(L('the region and clipboard buttons → kt_screen_action { a }'), JSON.stringify(acts) === JSON.stringify([{ a: 'region' }, { a: 'clipboard' }]), acts);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      ok(L('no sideways overflow'), over <= 1, over);
      if (lang === 'ar') ok(L('right to left'), (await page.evaluate(() => document.documentElement.dir)) === 'rtl');
      ok(L('no page errors'), !errors.length, errors);
      await page.screenshot({ path: path.join(__dirname, `shot-screentauri-${lang}.png`) });
      await page.close();
    }
    // --- this shell's own steps: the screen not takeable (with why), Wayland's portal, a Mac's permission.
    {
      const { page, errors } = await open('none', '#/screen'); await page.waitForSelector('.screen-step[data-step="ocr"]', { timeout: 15000 });
      const t = await page.textContent('.screen-step[data-step="capture"]').catch(() => '');
      ok(L('the screen cannot be taken here: said, with the system\'s reason'), t.includes(T.scrCapNone) && t.includes('DISPLAY'), t);
      ok(L('…no page errors'), !errors.length, errors); await page.close();
    }
    {
      const { page, errors } = await open('wayland', '#/screen'); await page.waitForSelector('.screen-step[data-step="ocr"]', { timeout: 15000 });
      const t = await page.textContent('.screen-step[data-step="capture"]').catch(() => '');
      ok(L('Wayland: each picture through the portal, said'), t.includes(T.scrCapPortal) && t.includes(T.scrCapPortalHint), t);
      ok(L('Wayland without Tesseract: no OCR said'), (await page.textContent('.screen-step[data-step="ocr"]')).includes(T.scrOcrNone));
      ok(L('…no page errors'), !errors.length, errors); await page.close();
    }
    {
      const { page, errors, calls } = await open('mac', '#/screen'); await page.waitForSelector('.screen-step[data-step="perm"]', { timeout: 15000 });
      const t = await page.textContent('.screen-step[data-step="perm"]');
      ok(L('a Mac without Screen Recording: what to allow and where'), t.includes(T.scrPermNeed) && t.includes(T.scrPermHint), t);
      await page.click('.screen-step[data-step="perm"] button'); await page.waitForTimeout(200);
      ok(L('its button → kt_screen_action { a: permission } (the system asks once, then its settings)'), (await calls()).some((c) => c[0] === 'kt_screen_action' && c[1].a === 'permission'));
      ok(L('…no page errors'), !errors.length, errors); await page.close();
    }
    // --- the frozen screen: a region drawn, read, translated over the words; Esc closes it.
    {
      const { page, errors, calls } = await open('win', '#/overlay', null, { width: 800, height: 500 });
      await page.waitForSelector('.kt-ov-shot', { timeout: 15000 });
      await page.mouse.move(90, 90); await page.mouse.down(); await page.mouse.move(300, 150, { steps: 4 }); await page.mouse.move(420, 180, { steps: 4 }); await page.mouse.up();
      await page.waitForSelector('.kt-ov-box', { timeout: 8000 });
      const reg = (await calls()).find((c) => c[0] === 'kt_screen_region');
      ok(L('the region drawn → kt_screen_region { r } in page pixels'), reg && reg[1].r.x === 90 && reg[1].r.y === 90 && reg[1].r.width === 330 && reg[1].r.height === 90, reg);
      const box = await page.$eval('.kt-ov-box', (e) => ({ text: e.textContent, left: e.style.left, top: e.style.top }));
      ok(L('translated over the words'), box.text === 'TR(Hello there)' && box.left === '105px' && box.top === '110px', box);
      await page.keyboard.press('Escape'); await page.waitForTimeout(200);
      ok(L('Esc → kt_screen_close'), (await calls()).some((c) => c[0] === 'kt_screen_close'));
      ok(L('…no page errors'), !errors.length, errors); await page.close();
    }
    {
      const { page, calls } = await open('win', '#/overlay?go=1', () => { window.__region = { x: 12, y: 34, width: 200, height: 60, display: 'M@0,0' }; window.__job = null; }, { width: 800, height: 500 });
      await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'kt_screen_region'), null, { timeout: 15000 });
      const reg = (await calls()).find((c) => c[0] === 'kt_screen_region');
      ok(L('«again»: the kept region read at once (from kt_screen_status)'), reg && reg[1].r.x === 12 && reg[1].r.width === 200, reg);
      await page.close();
    }
    {
      const { page, calls } = await open('win', '#/overlay', () => { const c = document.createElement('canvas'); c.width = 40; c.height = 40; window.__job = { mode: 'full', image: c.toDataURL(), width: 40, height: 40, scale: 1, cfg: {} }; }, { width: 800, height: 500 });
      await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'kt_screen_region'), null, { timeout: 15000 });
      const reg = (await calls()).find((c) => c[0] === 'kt_screen_region');
      ok(L('«full»: all of the screen read (r null)'), reg && reg[1].r === null, reg);
      await page.close();
    }
    {
      const { page, errors } = await open('wayland', '#/overlay', () => { window.__noOcr = true; }, { width: 800, height: 500 });
      await page.waitForSelector('.kt-ov-shot', { timeout: 15000 });
      await page.mouse.move(90, 90); await page.mouse.down(); await page.mouse.move(420, 180, { steps: 4 }); await page.mouse.up();
      await page.waitForFunction((w) => document.querySelector('.kt-ov-hint')?.textContent === w, T.scrOvNoOcr, { timeout: 8000 }).catch(() => undefined);
      ok(L('no OCR here: said plainly («ocr-missing»)'), (await page.textContent('.kt-ov-hint')) === T.scrOvNoOcr, await page.textContent('.kt-ov-hint'));
      ok(L('…no page errors'), !errors.length, errors); await page.close();
    }
    // --- «auto»'s caption, and the clipboard's window.
    {
      const { page, errors, calls } = await open('win', '#/overlay?caption=1', null, { width: 400, height: 120 });
      await page.waitForSelector('.kt-ov-cap', { state: 'attached', timeout: 15000 }); await page.waitForTimeout(300);
      await page.evaluate(() => window.__emit('kt:screenCaption', { text: 'Where are you\ngoing?' }));
      await page.waitForFunction(() => /TR\(/.test(document.querySelector('.kt-ov-cap').textContent), null, { timeout: 8000 });
      ok(L('kt:screenCaption → the caption translated (lines joined)'), (await page.textContent('.kt-ov-cap')) === 'TR(Where are you going?)');
      await page.waitForTimeout(200);
      const sz = (await calls()).filter((c) => c[0] === 'kt_screen_caption');
      ok(L('its height sent back (kt_screen_caption { o: { height } })'), sz.length > 0 && sz[0][1].o.height > 16, sz);
      ok(L('…no page errors'), !errors.length, errors); await page.close();
    }
    {
      const { page, errors } = await open('win', '#/overlay?text=1', () => { window.__job = { mode: 'text', text: 'Good night', cfg: {} }; }, { width: 420, height: 220 });
      await page.waitForFunction(() => /TR\(/.test(document.querySelector('.kt-ov-tr')?.textContent || ''), null, { timeout: 15000 });
      ok(L('the clipboard\'s text translated by the mouse'), (await page.textContent('.kt-ov-tr')) === 'TR(Good night)' && /Good night/.test(await page.textContent('.kt-ov-orig')));
      ok(L('…no page errors'), !errors.length, errors); await page.close();
    }
  }
  await br.close(); web.close();

  // --- the self-test's screen rows against the pretend screen: all pass; wrong pixels fail the pixel rows.
  const sw = {}; vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'desktop-tauri', 'selftest.js'), 'utf8'), vm.createContext({ window: sw, Promise, Object, Array, String, Error, JSON, Uint8Array, Date, setTimeout, clearTimeout, Math }));
  const lib = sw.__KT_SELFTEST_LIB__;
  for (const [what, opts, wrong, os] of [['good', {}, false], ['wrong pixels', {}, true], ['no tray, no OCR', { trayPossible: false, ocr: 'none' }, false], ['never painted', { paint: 'never' }, false],
    ['painted after a nudge', { paint: 'nudge' }, false], ['the caption keeps the focus (Windows)', { captionFocused: true, capture: 'gdi', ocr: 'windows' }, false, 'win32'], ['Windows, all well', { capture: 'gdi', ocr: 'windows' }, false, 'win32'], ['no focus sample (Windows)', { noSample: true, capture: 'gdi', ocr: 'windows' }, false, 'win32'], ['a stopped caption still closing (Windows)', { slowClose: true, capture: 'gdi', ocr: 'windows' }, false, 'win32']]) {
    const F = require('./screenfake.cjs')({ os: os || 'linux' }, opts); const results = [];
    const env = { sleep: () => new Promise((r) => setTimeout(r, 1)), now: () => Date.now(), invoke: (cmd, a) => Promise.resolve().then(() => F.act(a.o)), storage: null,
      pixels: wrong ? async (u, pts) => ({ w: 1, h: 1, px: pts.map(() => [40, 40, 40, 255]) }) : F.pixels };
    const must = (c, m) => { if (!c) throw new Error(m); };
    const check = async (name, required, fn) => { try { const d = await fn(); results.push({ name, ok: true, required, d }); return true; } catch (e) { results.push({ name, ok: false, required, d: e.message }); return false; } };
    await lib.runScreen(F.kt, { os: os || 'linux', base: 'http://127.0.0.1:1' }, env, check, must);
    const failed = results.filter((r) => r.required && !r.ok).map((r) => r.name);
    if (what === 'good') ok('self-test rows against the pretend screen: all pass', failed.length === 0 && results.length === 13 && results.every((r) => r.ok), results.filter((r) => !r.ok));
    if (what === 'never painted') ok('self-test rows: a test window never painted fails its row with how, the rows after it too, and is reported', failed[0] === 'screen: a window the test draws, captured as the app captures it — its pixels' && /never painted/.test(results.find((r) => r.name === failed[0]).d) && results.some((r) => /paints without help/.test(r.name) && !r.ok && !r.required), results.filter((r) => !r.ok));
    if (what === 'painted after a nudge') ok('self-test rows: painted only after a nudge — the capture passes, the «without help» row reports it', failed.length === 0 && results.some((r) => /paints without help/.test(r.name) && !r.ok && /nudge/.test(r.d)), results.filter((r) => !r.ok));
    if (what === 'the caption keeps the focus (Windows)') ok('self-test rows (Windows): a caption holding the focus fails its row, and «auto» is still stopped for the rows after', failed.length === 1 && /caption opens click-through/.test(failed[0]) && /took the focus/.test(results.find((r) => r.name === failed[0]).d) && F.S.auto === false && results.some((r) => /clipboard/.test(r.name) && r.ok), results.filter((r) => !r.ok));
    if (what === 'no focus sample (Windows)') ok('self-test rows (Windows): a focus sample that cannot be taken fails as such — not as «took the focus»', failed.length === 1 && /could not be taken/.test(results.find((r) => r.name === failed[0]).d) && !/took the focus/.test(results.find((r) => r.name === failed[0]).d) && /round 1, \d+ ms; auto/.test(results.find((r) => r.name === failed[0]).d), results.filter((r) => !r.ok));
    if (what === 'a stopped caption still closing (Windows)') ok('self-test rows (Windows): five rounds wait for the stopped caption to be gone, then pass', failed.length === 0 && /^5 rounds/.test(results.find((r) => /caption opens/.test(r.name)).d), results.filter((r) => !r.ok || /caption opens/.test(r.name)));
    if (what === 'Windows, all well') ok('self-test rows (Windows): all pass', failed.length === 0 && results.every((r) => r.ok || !r.required), results.filter((r) => !r.ok));
    if (what === 'wrong pixels') ok('self-test rows: wrong pixels fail the capture, frozen-screen and crop rows', failed.length === 3 && failed.every((n) => /pixels|frozen screen|crop/.test(n)), failed);
    if (what === 'no tray, no OCR') ok('self-test rows: no tray / no OCR said, not failed', failed.length === 0 && /no tray here/.test(results.find((r) => /tray/.test(r.name)).d), results.filter((r) => /tray|OCR/.test(r.name)));
    ok(`self-test rows (${what}): left off — no window, no auto`, !F.S.on && !F.S.auto && F.S.wins.size === 0, { on: F.S.on, wins: [...F.S.wins.keys()] });
  }
  if (fails) { console.log(`\n${fails} failed`); process.exit(1); }
  console.log('\nscreentauri: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
