// The Tauri build's first start and its update sheet (stage R6b), in Chromium with the real bridge
// (desktop-tauri/bridge.js) and a fake Tauri IPC, as tests/tauribridge.cjs does:
//  - the first-run screen shows once over the library (never under a test driver: the test makes the page believe no
//    driver is there), in the interface's language; its language buttons switch the interface (Arabic: right to
//    left), its look buttons the interface mode; «Bring my library» looks for a hand-over (none here: it says so); «Open the settings» asks the shell for the default-apps page (Windows and macOS only); «Start
//    reading» closes it for good (not shown after a reload); Escape too; the page tells the shell its first paint, its
//    first screen and its colour (kr_boot_mark);
//  - ONE screen with the hand-over (stage R6a; handover-bridge.js over a fake IPC): an empty profile with a hand-over
//    to bring gets the first-run page with the offer IN its library tile (count, size, folder) and no sheet of its own;
//    «Not now» marks it declined and the page stays; «Bring it now» brings it (done, «Free the space», «Continue»),
//    «Start reading» waits while it comes, «Continue» reloads, and neither screen shows again; with the first run done
//    before, the offer comes alone, as its own sheet;
//  - the update sheet of the Tauri build picks the Tauri build's file for this kind of copy (the installer's), passes
//    the release's size and digest to installUpdate, shows the progress the shell sends, and turns the shell's refusals
//    and results into sentences (a checksum refused, a portable copy, a Mac's disk image).
// With --shots <dir>: pictures of both, English and Arabic, light and dark, at 2× (the owner's preview).
// Run after `node scripts/build.mjs`: node tests/firstrun.cjs [--shots <dir>]
'use strict';
const { chromium } = require('playwright');
const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const BRIDGE = fs.readFileSync(path.join(ROOT, 'desktop-tauri', 'bridge.js'), 'utf8');
const HO_BRIDGE = fs.readFileSync(path.join(ROOT, 'desktop-tauri', 'handover-bridge.js'), 'utf8');
// (A hand-over as handover.rs finds one: whole, nothing in it — restoreHandover brings an empty library as well.)
const HO_DIR = 'C:\\Users\\u\\AppData\\Roaming\\KurokawaReader\\handover';
const HO = { found: true, dir: HO_DIR, marker: { app: 'KurokawaReader', kind: 'handover', format: 1, id: 'h1', createdAt: 1, counts: { books: 37 }, bytes: 734003200, files: [] }, state: null };
const SHOTS = (() => { const i = process.argv.indexOf('--shots'); return i > 0 ? path.resolve(process.argv[i + 1]) : null; })();
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });

const SIZE = 9858211;
const RELEASES = [{
  tag_name: 'v0.72.0', html_url: 'https://github.com/YoRu72/KurokawaReader/releases/tag/v0.72.0', draft: false, prerelease: false, published_at: '2026-11-20T10:00:00Z',
  body: "## What's new\n- The computer app moves to a new engine: a tenth of the download, a faster start\n- A one-page installer that installs in seconds\n- Updates resume where they stopped, and are checked before they install\n\n## Files\n",
  assets: [
    { name: 'KurokawaReader-0.72.0-win-x64.exe', browser_download_url: 'https://github.com/YoRu72/KurokawaReader/releases/download/v0.72.0/KurokawaReader-0.72.0-win-x64.exe', size: 85600000 },
    { name: 'KurokawaReader-0.72.0-windows-x64-setup.exe', browser_download_url: 'https://github.com/YoRu72/KurokawaReader/releases/download/v0.72.0/KurokawaReader-0.72.0-windows-x64-setup.exe', size: SIZE, digest: 'sha256:' + 'ab'.repeat(32) },
    { name: 'KurokawaReader-0.72.0-windows-x64-portable.zip', browser_download_url: 'https://github.com/YoRu72/KurokawaReader/releases/download/v0.72.0/KurokawaReader-0.72.0-windows-x64-portable.zip', size: 6100000 },
    { name: 'KurokawaReader-0.72.0-SHA256SUMS.txt', browser_download_url: 'https://github.com/YoRu72/KurokawaReader/releases/download/v0.72.0/KurokawaReader-0.72.0-SHA256SUMS.txt', size: 600 },
  ],
}];

// (Before the page: the fake IPC, the boot line and the bridge — what main.rs injects —, and no test driver seen.)
const init = (o) => `(function () {
  try { Object.defineProperty(Navigator.prototype, 'webdriver', { get: function () { return false; }, configurable: true }); } catch (e) {}
  try { if (!localStorage.getItem('kr.test.seeded')) { localStorage.setItem('kr.test.seeded', '1'); localStorage.setItem('kr.lang', ${JSON.stringify(o.lang)}); localStorage.setItem('kr.update.lastCheck', String(Date.now())); ${o.mode ? `localStorage.setItem('kr.visual', JSON.stringify({ uiMode: ${JSON.stringify(o.mode)} }));` : ''} } } catch (e) {}
  window.__calls = []; window.__listeners = [];
  window.__emit = function (n, p) { window.__listeners.filter(function (l) { return l[0] === n; }).forEach(function (l) { l[1]({ event: n, payload: p }); }); };
  var replies = {
    kr_scan_device: function () { return { root: '/home/u', files: [], truncated: false }; }, kr_file_size: function () { return -1; }, kr_folder_read: function () { return null; },
    kr_http: function (a) { return { status: 404, url: a.o.url, headers: {}, body: '' }; }, kr_open_take: function () { return []; },
    kr_title_bar: function () { return { platform: ${JSON.stringify(o.os)}, height: 32, own: true, wanted: true, controls: 'own', maximized: false, fullscreen: false, focused: true }; },
    kr_app_icon: function () { return null; }, kr_set_zoom: function () { return true; }, kr_progress: function () { return true; }, kr_menu: function () { return false; },
    kr_default_apps: function () { return true; }, kr_boot_mark: function (a) { return { paint: 1, ready: 2 }; },
    kr_update_download: function () { return 'none'; }, kr_update_install: function () { return false; },
    kr_install_update: function (a) { return window.__installReply ? window.__installReply(a) : 'installing'; }
  };
  ${o.handover ? `var hoState = null; try { hoState = JSON.parse(localStorage.getItem('kr.test.hostate') || 'null'); } catch (e) {}
  replies.kr_handover_find = function () { return Object.assign({}, ${JSON.stringify(HO)}, { state: hoState }); };
  replies.kr_handover_verify = function () { return { ok: true, bad: [] }; };
  replies.kr_handover_read = function () { return []; };
  replies.kr_handover_mark = function (a) { hoState = { id: a.o.id, state: a.o.state, at: Date.now() }; localStorage.setItem('kr.test.hostate', JSON.stringify(hoState)); return true; };
  replies.kr_handover_free = function () { return { freed: 1 }; };` : ''}
  ${o.left ? `replies.kr_handover_find = function () { return { found: false, state: null, looked: [], problems: [], electron: ${JSON.stringify(o.left)} }; };
  replies.kr_handover_open_old = function () { return true; };` : ''}
  window.__TAURI__ = {
    core: { invoke: function (cmd, args) { window.__calls.push({ cmd: cmd, args: JSON.parse(JSON.stringify(args || {})) }); return replies[cmd] ? Promise.resolve().then(function () { return replies[cmd](args || {}); }) : Promise.reject('unknown command ' + cmd); } },
    event: { listen: function (n, f) { window.__listeners.push([n, f]); return Promise.resolve(function () {}); } }
  };
  window.__KR_BOOT__ = ${JSON.stringify({ os: o.os, arch: 'x64', kind: o.kind || 'nsis' })};
  ${o.firstrunDone ? "try { localStorage.setItem('kr.firstrun.done', '1'); } catch (e) {}" : ''}
})();\n${BRIDGE}${o.handover || o.left ? '\n' + HO_BRIDGE : ''}`;

async function page(br, base, o) {
  const ctx = await br.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: SHOTS ? 2 : 1, colorScheme: o.scheme || 'dark' });
  await ctx.route(/raw\.githubusercontent\.com/, (r) => r.fulfill({ status: 404 }));
  await ctx.route(/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RELEASES) }));
  const p = await ctx.newPage(); p.setDefaultTimeout(15000);
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript({ content: init(o) });
  await p.goto(base + '#/');
  await p.waitForSelector('.library-view');
  return { ctx, p, errors };
}
const shot = async (p, name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); await p.waitForTimeout(450); await p.screenshot({ path: path.join(SHOTS, name + '.png') }); console.log('  picture', path.join(SHOTS, name + '.png')); };

(async () => {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('no dist/: run node scripts/build.mjs first');
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch();
  try {
    // --- the first-run screen
    {
      const { ctx, p, errors } = await page(br, base, { lang: 'en', os: 'win32' });
      await p.waitForSelector('.firstrun .fr-card');
      const t = await p.evaluate(() => ({ h: document.querySelector('.fr-hero h1').textContent, langs: document.querySelectorAll('.fr-seg')[0].querySelectorAll('button').length, looks: [...document.querySelectorAll('.fr-seg')[1].querySelectorAll('button')].map((b) => b.textContent), tiles: document.querySelectorAll('.fr-tile').length, lib: !!document.querySelector('.library-view') }));
      assert.equal(t.h, 'Welcome to KurokawaReader'); assert.equal(t.langs, 5); assert.deepEqual(t.looks, ['System', 'Light', 'Dark']); assert.equal(t.tiles, 2, 'the library tile and the default-apps tile (Windows)'); assert.ok(t.lib, 'the library under it');
      const marks = await p.evaluate(() => window.__calls.filter((c) => c.cmd === 'kr_boot_mark').map((c) => [c.args.what, /^#[0-9a-f]{6}$/i.test(c.args.bg || '')]));
      assert.deepEqual(marks.slice(0, 2).map((m) => m[0]).sort(), ['paint', 'ready'], 'the start told to the shell: ' + JSON.stringify(marks)); assert.ok(marks.every((m) => m[1]), 'with the interface\'s colour');
      await shot(p, 'firstrun-en-dark');
      // the hand-over: none on this computer (the shell reads none), and the tile says so
      await p.click('.fr-bring'); await p.waitForFunction(() => /No library from an earlier version/.test(document.querySelector('.fr-tile p').textContent));
      // …with the way left for a library the earlier version did not hand over: a full backup made there, restored here
      assert.ok(await p.evaluate(() => /full backup/.test(document.querySelector('.fr-backup-hint')?.textContent || '') && !!document.querySelector('.fr-tile .fr-backup')), 'the backup file offered when none was found');
      // the default-apps page asked for
      await p.click('.fr-default'); await p.waitForFunction(() => window.__calls.some((c) => c.cmd === 'kr_default_apps'));
      // the look: Light
      await p.click('.fr-seg >> nth=1 >> button >> nth=1'); await p.waitForFunction(() => document.documentElement.dataset.ui === 'light');
      await p.waitForFunction(() => window.__calls.some((c) => c.cmd === 'kr_boot_mark' && c.args.what === 'theme' && c.args.bg === '#f7f8fa'), null, { timeout: 5000 });
      await shot(p, 'firstrun-en-light-none-found');
      // Arabic: right to left, in Arabic
      await p.click('.fr-seg >> nth=0 >> button >> nth=1'); await p.waitForFunction(() => document.documentElement.dir === 'rtl' && /أهلًا/.test(document.querySelector('.fr-hero h1').textContent));
      await shot(p, 'firstrun-ar-light');
      await p.click('.fr-seg >> nth=1 >> button >> nth=2'); await p.waitForFunction(() => document.documentElement.dataset.ui === 'dark');
      await shot(p, 'firstrun-ar-dark');
      // «Start reading»: gone, and not again after a reload
      await p.click('.fr-start'); await p.waitForFunction(() => !document.querySelector('.firstrun'));
      await p.reload(); await p.waitForSelector('.library-view'); await p.waitForTimeout(1200);
      assert.equal(await p.$('.firstrun'), null, 'shown once only');
      assert.deepEqual(errors, []);
      await ctx.close();
    }
    // (No hand-over, but the earlier copy's library still in it — the setup kept its program —: said at once, with a
    // button that opens it; its program gone: how to get it back. Never «none found».)
    {
      const { ctx, p, errors } = await page(br, base, { lang: 'en', os: 'win32', left: { library: true, program: true } });
      await p.waitForSelector('.firstrun .fr-open-old');
      const txt = await p.evaluate(() => document.querySelector('.fr-tile p').textContent);
      assert.ok(/still in the previous KurokawaReader/.test(txt) && /Open it once and let it update/.test(txt), txt);
      await p.click('.firstrun .fr-open-old'); await p.waitForFunction(() => window.__calls.some((c) => c.cmd === 'kr_handover_open_old'));
      assert.ok(await p.$('.firstrun .fr-backup'), 'the backup file offered too');
      assert.deepEqual(errors, []);
      await ctx.close();
    }
    {
      const { ctx, p, errors } = await page(br, base, { lang: 'ar', os: 'win32', left: { library: true, program: false } });
      await p.waitForFunction(() => /لم تُنقَلْ بعدُ/.test(document.querySelector('.firstrun .fr-tile p')?.textContent || ''));
      assert.equal(await p.$('.firstrun .fr-open-old'), null, 'no program: no button to open it');
      assert.deepEqual(errors, []);
      await ctx.close();
    }
    // («Restore a backup file»: the screen goes — done — and the restore's own sheet opens over the library.)
    {
      const { ctx, p, errors } = await page(br, base, { lang: 'en', os: 'win32' });
      await p.waitForSelector('.firstrun .fr-backup');
      await p.click('.firstrun .fr-backup');
      await p.waitForFunction(() => !document.querySelector('.firstrun') && [...document.querySelectorAll(".sheet button, .sheet .dest-row")].some((b) => /From a backup file/.test(b.textContent)), null, { timeout: 10000 });
      assert.ok(await p.evaluate(() => !!localStorage.getItem('kr.firstrun.done')), 'the screen marked done');
      assert.deepEqual(errors, []);
      await ctx.close();
    }
    // (Linux: no default-apps tile — the .deb registers the kinds of file itself; Escape closes the screen.)
    {
      const { ctx, p } = await page(br, base, { lang: 'en', os: 'linux', kind: 'appimage', scheme: 'light', mode: 'light' });
      await p.waitForSelector('.firstrun .fr-card');
      assert.equal(await p.evaluate(() => document.querySelectorAll('.fr-tile').length), 1);
      await shot(p, 'firstrun-en-light');
      await p.keyboard.press('Escape'); await p.waitForFunction(() => !document.querySelector('.firstrun'));
      await ctx.close();
    }
    // --- ONE screen with the hand-over: the first-run page carries the offer
    {
      const { ctx, p, errors } = await page(br, base, { lang: 'en', os: 'win32', handover: true });
      await p.waitForSelector('.firstrun .fr-tile[data-handover="offer"]');
      await p.waitForTimeout(2500);   // (the time the offer alone would have taken: it must not come as well)
      const o1 = await p.evaluate(() => ({ offers: document.querySelectorAll('[data-handover]').length, sheets: document.querySelectorAll('.sheet').length, text: document.querySelector('[data-handover="offer"]').textContent, go: !!document.querySelector('.firstrun [data-handover-go]') }));
      assert.equal(o1.offers, 1, 'one offer'); assert.equal(o1.sheets, 0, 'no sheet of its own over or under the first-run page');
      assert.match(o1.text, /Books: 37/); assert.match(o1.text, /700 MB|734/); assert.ok(o1.text.includes(HO_DIR), 'where the old data stays'); assert.ok(o1.go);
      await shot(p, 'firstrun-handover-en-dark');
      // «Not now»: declined, the page stays and says where to find it
      await p.click('.firstrun [data-handover] .btn.text');
      await p.waitForFunction(() => !document.querySelector('[data-handover]') && /Settings → Backup/.test(document.querySelector('.firstrun .fr-tile p').textContent));
      assert.equal(await p.evaluate(() => JSON.parse(localStorage.getItem('kr.test.hostate')).state), 'declined');
      // «Bring my library» finds it again (declined: offered on demand) — and brings it
      await p.click('.fr-bring'); await p.waitForSelector('.firstrun [data-handover="offer"] [data-handover-go]');
      await p.click('.firstrun [data-handover-go]');
      await p.waitForFunction(() => document.querySelector('.firstrun [data-handover]')?.getAttribute('data-handover') === 'done');
      const o2 = await p.evaluate(() => ({ status: document.querySelector('[data-handover] [role="status"]').textContent, free: !!document.querySelector('[data-handover-free]'), state: JSON.parse(localStorage.getItem('kr.test.hostate')).state, done: localStorage.getItem('kr.handover.done') }));
      assert.match(o2.status, /^Done\./); assert.ok(o2.free); assert.equal(o2.state, 'restored'); assert.equal(o2.done, 'h1');
      await shot(p, 'firstrun-handover-done');
      // «Free the space» asks above the first-run page
      await p.click('[data-handover-free]'); await p.waitForSelector('[data-handover-free-yes]');
      assert.ok(await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); return Number(getComputedStyle(s).zIndex) > Number(getComputedStyle(document.querySelector('.firstrun')).zIndex); }), 'the question above the first-run page');
      await p.keyboard.press('Escape'); await p.waitForFunction(() => !document.querySelector('[data-handover-free-yes]'));
      assert.ok(await p.$('.firstrun'), 'Escape closed the question, not the first-run page');
      // «Continue»: the page reloads; neither screen again
      await Promise.all([p.waitForNavigation(), p.click('[data-handover-continue]')]);
      await p.waitForSelector('.library-view'); await p.waitForTimeout(2500);
      assert.equal(await p.evaluate(() => document.querySelectorAll('.firstrun, [data-handover]').length), 0, 'shown once only');
      assert.deepEqual(errors, []);
      await ctx.close();
    }
    // (While it comes, the first-run page cannot be left.)
    {
      const { ctx, p, errors } = await page(br, base, { lang: 'en', os: 'win32', handover: true });
      await p.waitForSelector('.firstrun [data-handover-go]');
      await p.evaluate(() => { const inv = window.__TAURI__.core.invoke; window.__TAURI__.core.invoke = (c, a) => (c === 'kr_handover_verify' ? new Promise((ok) => { window.__verified = () => ok({ ok: true, bad: [] }); }) : inv(c, a)); });
      await p.click('.firstrun [data-handover-go]');
      await p.waitForFunction(() => document.querySelector('.fr-start').disabled);
      await p.keyboard.press('Escape'); await p.waitForTimeout(300);
      assert.ok(await p.$('.firstrun'), 'Escape does nothing while it comes');
      await p.evaluate(() => window.__verified());
      await p.waitForFunction(() => document.querySelector('[data-handover]')?.getAttribute('data-handover') === 'done' && !document.querySelector('.fr-start').disabled);
      assert.deepEqual(errors, []);
      await ctx.close();
    }
    // (The first run done before: the offer alone, as its own sheet.)
    {
      const { ctx, p, errors } = await page(br, base, { lang: 'en', os: 'win32', handover: true, firstrunDone: true });
      await p.waitForSelector('.sheet[data-handover="offer"]');
      assert.equal(await p.$('.firstrun'), null);
      assert.equal(await p.evaluate(() => document.querySelectorAll('[data-handover]').length), 1);
      await shot(p, 'handover-alone-en-dark');
      assert.deepEqual(errors, []);
      await ctx.close();
    }
    // --- the update sheet of the Tauri build: its file, the release's size and digest, the progress, the outcome
    for (const [lang, scheme] of [['en', 'dark'], ['en', 'light'], ['ar', 'dark'], ['ar', 'light']]) {
      const { ctx, p, errors } = await page(br, base, { lang, os: 'win32', scheme, mode: scheme });
      await p.evaluate(() => { try { localStorage.setItem('kr.firstrun.done', '1'); } catch (e) {} document.querySelector('.firstrun')?.remove(); });
      await p.evaluate(() => { window.__installReply = () => new Promise((ok) => { window.__finish = ok; let pct = 0; const tick = () => { pct = Math.min(63, pct + 3); window.__emit('kr:update-progress', { pct, got: Math.round(9858211 * pct / 100), total: 9858211, speed: 3355443 }); if (pct < 63) setTimeout(tick, 20); }; tick(); }); });
      await p.evaluate(() => window.__emit('kr:command', 'update'));
      await p.waitForSelector('.update-sheet .upd-go');
      const f = await p.evaluate(() => document.querySelector('.upd-file-name').textContent);
      assert.equal(f, 'KurokawaReader-0.72.0-windows-x64-setup.exe', 'the Tauri build\'s installer chosen');
      await p.click('.update-sheet .upd-go');
      await p.waitForFunction(() => /63%/.test(document.querySelector('.upd-status').textContent));
      const call = await p.evaluate(() => window.__calls.find((c) => c.cmd === 'kr_install_update'));
      assert.equal(call.args.url, RELEASES_URL());
      assert.equal(call.args.o.size, 9858211); assert.equal(call.args.o.digest, 'sha256:' + 'ab'.repeat(32)); assert.equal(call.args.o.name, 'KurokawaReader-0.72.0-windows-x64-setup.exe');
      await shot(p, `update-${lang}-${scheme}`);
      await p.evaluate(() => window.__finish('installing'));
      await p.waitForFunction(() => document.querySelector('.upd-dl.ok'));
      if (lang === 'en' && scheme === 'dark') {
        assert.match(await p.evaluate(() => document.querySelector('.upd-status').textContent), /installer has been opened/);
        // refusals in words
        for (const [code, re] of [['kr-update:checksum', /does not match the release's checksum/], ['kr-update:portable', /portable copy/], ['kr-update:handover the backup could not be written', /could not be made ready.*the backup could not be written/], ['boom', /— boom$/]]) {
          await p.evaluate((c) => { window.__installReply = () => Promise.reject(c); }, code);
          await p.evaluate(() => window.__emit('kr:command', 'update')); await p.waitForSelector('.update-sheet .upd-go');
          await p.click('.update-sheet .upd-go'); await p.waitForFunction(() => !document.querySelector('.update-sheet .upd-go').hidden && document.querySelector('.upd-status').textContent.length > 3);
          assert.match(await p.evaluate(() => document.querySelector('.upd-status').textContent), re, code);
        }
        await p.evaluate(() => { window.__installReply = () => 'kr-update:mac-opened'; window.__emit('kr:command', 'update'); }); await p.waitForSelector('.update-sheet .upd-go');
        await p.click('.update-sheet .upd-go'); await p.waitForFunction(() => document.querySelector('.upd-dl.ok'));
        assert.match(await p.evaluate(() => document.querySelector('.upd-status').textContent), /drag KurokawaReader onto Applications/);
      }
      assert.deepEqual(errors, []);
      await ctx.close();
    }
    console.log('firstrun: ok — the first-run screen (once; language, look, hand-over, default apps; Linux without the default-apps tile), one screen with the hand-over (the offer in the first-run page, «Not now», brought, «Free the space» above it, «Continue», alone when the first run was done), the start marks, the Tauri build\'s update sheet (its file, size and digest, progress, refusals in words)');
  } finally { await br.close(); web.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
function RELEASES_URL() { return RELEASES[0].assets[1].browser_download_url; }
