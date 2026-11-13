// The Tauri build's first start and its update sheet (stage R6b), in Chromium with the real bridge
// (desktop-tauri/bridge.js) and a fake Tauri IPC, as tests/tauribridge.cjs does:
//  - the first-run screen shows once over the library (never under a test driver: the test makes the page believe no
//    driver is there), in the interface's language; its language buttons switch the interface (Arabic: right to
//    left), its look buttons the interface mode; «Bring my library» calls the hand-over (src/handover.ts) and says
//    what it answered; «Open the settings» asks the shell for the default-apps page (Windows and macOS only); «Start
//    reading» closes it for good (not shown after a reload); Escape too; the page tells the shell its first paint, its
//    first screen and its colour (kr_boot_mark);
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
  window.__TAURI__ = {
    core: { invoke: function (cmd, args) { window.__calls.push({ cmd: cmd, args: JSON.parse(JSON.stringify(args || {})) }); return replies[cmd] ? Promise.resolve().then(function () { return replies[cmd](args || {}); }) : Promise.reject('unknown command ' + cmd); } },
    event: { listen: function (n, f) { window.__listeners.push([n, f]); return Promise.resolve(function () {}); } }
  };
  window.__KR_BOOT__ = ${JSON.stringify({ os: o.os, arch: 'x64', kind: o.kind || 'nsis' })};
})();\n${BRIDGE}`;

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
      // the hand-over: the placeholder finds nothing, and the tile says so
      await p.click('.fr-bring'); await p.waitForFunction(() => /No library from an earlier version/.test(document.querySelector('.fr-tile p').textContent));
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
    // (Linux: no default-apps tile — the .deb registers the kinds of file itself; Escape closes the screen.)
    {
      const { ctx, p } = await page(br, base, { lang: 'en', os: 'linux', kind: 'appimage', scheme: 'light', mode: 'light' });
      await p.waitForSelector('.firstrun .fr-card');
      assert.equal(await p.evaluate(() => document.querySelectorAll('.fr-tile').length), 1);
      await shot(p, 'firstrun-en-light');
      await p.keyboard.press('Escape'); await p.waitForFunction(() => !document.querySelector('.firstrun'));
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
    console.log('firstrun: ok — the first-run screen (once; language, look, hand-over, default apps; Linux without the default-apps tile), the start marks, the Tauri build\'s update sheet (its file, size and digest, progress, refusals in words)');
  } finally { await br.close(); web.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
function RELEASES_URL() { return RELEASES[0].assets[1].browser_download_url; }
