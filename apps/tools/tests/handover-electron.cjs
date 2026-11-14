// CI (tauri-check.yml, «Hand-over», Tools' stage P9; the Reader's tests/handover-electron.cjs the model): the REAL
// Electron Tools (apps/tools/desktop, run as `electron .`, its own data folder) given what a person keeps — settings,
// lists with watch progress and subtitle choices, a made-up sign-in, add-on records and files (one over two 8 MiB
// pieces), history, a custom icon set through its shell, a screen-translator font —, and, where its aria2c runs, two
// downloads from a loopback server on this machine: one moving (the server sends slowly) and one the person paused.
// Then its hand-over is made exactly as the bridge build makes it before installing the Rust build
// (window.__KT_HANDOVER__.make → desktop/handover.cjs: the streams ended, the engine paused, its session saved). The
// profile's snapshot and the downloads' ids go to <out> for the Tauri build's check (desktop-tauri/handovercheck.js,
// KTH_EXPECT).
//   node tests/handover-electron.cjs <expected.json> [work folder]
// Needs: desktop/node_modules (electron), desktop/dist (the built web UI copied in), desktop/aria2 (fetch-aria2.mjs; the
// downloads are left out, and said, without it), and playwright-core (or playwright).
const fs = require('fs'); const path = require('path'); const os = require('os'); const http = require('http');
let pw; try { pw = require('playwright-core'); } catch { pw = require('playwright'); }
const ROOT = path.resolve(__dirname, '..'); const DESK = path.join(ROOT, 'desktop');
const [outFile, workArg] = process.argv.slice(2);
if (!outFile) { console.error('usage: node tests/handover-electron.cjs <expected.json> [work folder]'); process.exit(2); }
const WORK = workArg || fs.mkdtempSync(path.join(os.tmpdir(), 'kt-handover-e-'));
fs.mkdirSync(WORK, { recursive: true });
const ICON = 'data:image/png;base64,' + fs.readFileSync(path.join(DESK, 'icon.png')).toString('base64');
const log = (...a) => console.log('[handover-electron]', ...a);

// A loopback server: /slow.bin — 64 MiB sent 64 KiB at a time, slowly (the download stays moving); /small.bin.
const SLOW = 64 * 1024 * 1024; const chunk = Buffer.alloc(64 * 1024, 0x5a);
const server = http.createServer((req, res) => {
  const total = req.url.startsWith('/slow') ? SLOW : 3 * 1024 * 1024;
  const m = /bytes=(\d+)-/.exec(req.headers.range || ''); const from = m ? Number(m[1]) : 0;
  res.writeHead(m ? 206 : 200, { 'content-length': total - from, 'accept-ranges': 'bytes', ...(m ? { 'content-range': `bytes ${from}-${total - 1}/${total}` } : {}), 'content-type': 'application/octet-stream' });
  let sent = from;
  const tick = () => { if (res.destroyed || sent >= total) return res.end(); const n = Math.min(chunk.length, total - sent); res.write(chunk.subarray(0, n)); sent += n; setTimeout(tick, req.url.startsWith('/slow') ? 40 : 0); };
  tick();
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
  const exe = require(path.join(DESK, 'node_modules', 'electron'));
  const args = [...(process.platform === 'linux' ? ['--no-sandbox'] : []), DESK];
  log('electron', exe, args.join(' '));
  const app = await pw._electron.launch({ executablePath: exe, args, cwd: DESK, env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }, timeout: 120000 });
  const userData = await app.evaluate(({ app }) => app.getPath('userData'));
  log('userData', userData);
  const p = await app.firstWindow(); p.setDefaultTimeout(60000);
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.pc.starter', '1'); localStorage.setItem('kt.update.lastCheck', String(Date.now())); });
  await p.reload(); await p.waitForSelector('.downloads-view');
  if (!(await p.evaluate(() => !!window.kurokawaHandover && !!window.__KT_HANDOVER__))) throw new Error('this Electron build has no hand-over (preload.cjs kurokawaHandover, main.ts __KT_HANDOVER__)');

  // What the person keeps, in the page's storage.
  const FONT_DIR = path.join(userData, 'screen-fonts');
  await p.evaluate(async ({ ICON }) => {
    const NOW = 1_700_000_000_000;
    const L = { 'kt.anime.listStatus': JSON.stringify({ 21: 'watching', 1535: 'completed' }), 'kt.tv.watchlist': JSON.stringify([{ id: 1399, name: 'A show' }]),
      'kt.player.memory': JSON.stringify({ 'file:C:/Users/u/Downloads/Kurokawa/ep01.mkv': { pos: 1234.5, dur: 1440, sub: 'ara', audio: 'jpn' } }), 'kt.anilist.token': 'CI-not-a-real-token',
      'kt.follows': JSON.stringify(['ani:21']), 'kt.notes': JSON.stringify([{ id: 'n1', text: 'ملاحظة' }]), 'kt.files.bookmarks': JSON.stringify(['/home/u/x']) };
    for (const [k, v] of Object.entries(L)) localStorage.setItem(k, v);
    const d = await new Promise((res, rej) => { const r = indexedDB.open('kurokawa-tools', 1); r.onupgradeneeded = () => { const x = r.result; for (const s of ['meta', 'files']) if (!x.objectStoreNames.contains(s)) x.createObjectStore(s); if (!x.objectStoreNames.contains('history')) x.createObjectStore('history', { keyPath: 'id' }); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const big = new Uint8Array(17 * 1024 * 1024 + 123); for (let i = 0; i < big.length; i++) big[i] = (i * 7 + (i >>> 20)) & 255;
    await new Promise((res) => { const tx = d.transaction(['meta', 'files', 'history'], 'readwrite');
      tx.objectStore('meta').put({ id: 'ci', name: 'CI add-on', url: 'https://example.test/ci.json', version: '1.0.0' }, 'addon-manifest:ci'); tx.objectStore('meta').put('1.0.0', 'addon-version:ci');
      tx.objectStore('meta').put({ lines: ['سطر', 'line'], at: new Date(NOW) }, 'subtr:ep01:ar');
      tx.objectStore('files').put(new Blob(['{"add-on":"code"}'], { type: 'application/json' }), 'addon:ci'); tx.objectStore('files').put(new File([big], 'Big Font.ttf', { type: 'font/ttf' }), 'font:big');
      tx.objectStore('history').put({ id: 'h1', url: 'https://example.test/a', at: NOW }); tx.oncomplete = res; });
    d.close();
    // The custom icon, through the shell as Settings sets it (desktop/appicon.cjs: <userData>/custom-icon.png).
    if (window.kurokawaTools.appIcon) await window.kurokawaTools.appIcon({ set: ICON }); localStorage.setItem('app.icon', ICON);
  }, { ICON });
  // A screen-translator font through the shell (kt:screenFontAdd), named in its settings.
  const font = await p.evaluate(async () => { const b = new Uint8Array(4000).fill(7); let s = ''; for (const x of b) s += String.fromCharCode(x); const r = await window.kurokawaTools.screenFontAdd({ name: 'My Font.ttf', b64: btoa(s) }); localStorage.setItem('kt.screen', JSON.stringify({ fonts: [{ name: 'My Font', path: r.path }] })); return r.path; }).catch((e) => { log('screen font not added:', e.message); return null; });

  // Downloads, where aria2c runs: one moving, one paused by the person.
  const engine = { gids: [], moving: [], pausedByUser: [], available: false };
  engine.available = await p.evaluate(async () => { const kt = window.kurokawaTools; await kt.ready(); for (let i = 0; i < 100 && !kt.available; i++) await new Promise((r) => setTimeout(r, 300)); return kt.available; });
  if (engine.available) {
    const dir = path.join(WORK, 'Downloads'); fs.mkdirSync(dir, { recursive: true });
    const add = (url, name) => p.evaluate(({ url, name, dir }) => window.kurokawaTools.add({ source: { url }, name, dir }), { url, name, dir });
    const a = await add(`${base}/slow.bin`, 'slow.bin'); const b = await add(`${base}/small.bin?2`, 'paused.bin');
    const idOf = (x) => (typeof x === 'string' ? x : x && (x.id || x.gid));
    engine.gids = [idOf(a), idOf(b)].filter(Boolean);
    await p.evaluate((id) => window.kurokawaTools.pause(id), idOf(b));
    for (let i = 0; i < 100; i++) { const t = await p.evaluate(() => window.kurokawaTools.list()); const s = t.find((x) => x.id === idOf(a)); if (s && s.state === 'downloading' && s.done > 1024 * 1024) break; await p.waitForTimeout(200); }
    const tasks = await p.evaluate(() => window.kurokawaTools.list());
    engine.moving = tasks.filter((t) => engine.gids.includes(t.id) && t.state !== 'paused').map((t) => t.id);
    engine.pausedByUser = tasks.filter((t) => engine.gids.includes(t.id) && t.state === 'paused').map((t) => t.id);
    log('downloads', JSON.stringify(tasks.map((t) => [t.id, t.state, t.done])));
  } else log('no aria2c here: the downloads are left out (the engine\'s files still cross)');
  await p.waitForTimeout(1500);

  const snap = await p.evaluate(() => window.__KT_HANDOVER__.snapshot());
  log('profile:', Object.keys(snap.local).length, 'keys;', Object.keys(snap.idb.meta).length + Object.keys(snap.idb.history).length, 'records;', Object.keys(snap.files).length, 'files');
  const t0 = Date.now();
  const made = await p.evaluate(() => window.__KT_HANDOVER__.make());
  log('hand-over:', JSON.stringify(made), `${Date.now() - t0} ms`);
  const status = await p.evaluate(() => window.kurokawaHandover.status());
  const after = engine.available ? await p.evaluate(() => window.kurokawaTools.list()) : [];
  await app.close(); server.close();
  const fails = [];
  if (!made.ok) fails.push('the hand-over was not made: ' + JSON.stringify(made));
  if (!status || status.marker.id !== made.id) fails.push('no marker after it: ' + JSON.stringify(status));
  if (!fs.existsSync(path.join(userData, 'custom-icon.png'))) fails.push('the custom icon was not set by the shell');
  const marker = status && status.marker;
  if (marker && !marker.files.some((f) => f.rel === 'shell/custom-icon.png')) fails.push('the shell\'s icon not in the hand-over');
  if (marker && !marker.files.some((f) => f.rel === 'engine/moving.json')) fails.push('the engine\'s part not in the hand-over');
  if (engine.available && after.some((t) => engine.gids.includes(t.id) && t.state === 'downloading')) fails.push('a download still moving after the hand-over: ' + JSON.stringify(after));
  if (engine.available && JSON.stringify(marker && marker.counts && marker.counts.moving) !== JSON.stringify(engine.moving.length)) fails.push('moving: ' + JSON.stringify(marker && marker.counts));
  fs.writeFileSync(outFile, JSON.stringify({ snapshot: snap, engine, font: !!font && fs.existsSync(font), handover: { dir: made.dir, id: made.id, counts: made.counts, userData, fontDir: FONT_DIR } }));
  log('expected written to', outFile);
  if (errors.length) log('page errors:', errors.slice(0, 5));
  if (fails.length) { console.error('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
  log('ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
