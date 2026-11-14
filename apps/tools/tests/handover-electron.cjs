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
let stage = 'start'; const t00 = Date.now();
const log = (...a) => console.log('[handover-electron]', `+${((Date.now() - t00) / 1000).toFixed(1)}s`, ...a);
const at = (s) => { stage = s; log('stage:', s); };
// (A watchdog: in run 43551417003 this step on Windows ran for over 20 minutes with nothing said. Each stage is told,
// and after 8 minutes the stage it hangs in is said and the run ends — the Electron process with it.)
let appProc = null;
setTimeout(() => { console.error(`[handover-electron] WATCHDOG: still in «${stage}» after 8 minutes`); try { if (appProc) appProc.kill(); } catch { /* gone */ } process.exit(3); }, 8 * 60 * 1000).unref();

// The loopback download server (tests/handover-dlserver.cjs), started DETACHED so it outlives this step: the Tauri
// build's step finishes the moving download from it. /slow.bin is sent slowly while <work>/slow.flag exists.
function startServer() {
  const { spawn } = require('child_process');
  const info = path.join(WORK, 'dlserver.json'); try { fs.unlinkSync(info); } catch { /* none */ }
  fs.writeFileSync(path.join(WORK, 'slow.flag'), 'slow');
  const c = spawn(process.execPath, [path.join(__dirname, 'handover-dlserver.cjs'), WORK], { detached: true, stdio: 'ignore', windowsHide: true }); c.unref();
  const pause = new Int32Array(new SharedArrayBuffer(4)); for (let i = 0; i < 600 && !fs.existsSync(info); i++) Atomics.wait(pause, 0, 0, 50);
  if (!fs.existsSync(info)) throw new Error('the download server did not start (no ' + info + ')');
  return JSON.parse(fs.readFileSync(info, 'utf8'));
}
// (The aria2c the workflow fetched for the bundle — desktop/aria2/<plat>-<arch>/ — first on the Electron app's PATH:
// `electron .` looks in Electron's own resources folder, then on the PATH — desktop/aria2.cjs binary().)
function aria2Dir() {
  const root = path.join(DESK, 'aria2'); const exe = process.platform === 'win32' ? 'aria2c.exe' : 'aria2c';
  const walk = (d, n) => { if (n > 3) return null; let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return null; } for (const e of es) { if (e.isFile() && e.name === exe) return d; } for (const e of es) if (e.isDirectory()) { const r = walk(path.join(d, e.name), n + 1); if (r) return r; } return null; };
  return walk(root, 0);
}

(async () => {
  at('server'); const srv = startServer(); const base = `http://127.0.0.1:${srv.port}`; log('download server', base, 'pid', srv.pid);
  const a2 = aria2Dir(); log('aria2c for Electron:', a2 || 'none fetched');
  // (Also where desktop/aria2.cjs looks FIRST — <resources>/aria2/<plat>-<arch>/, Electron's own resources folder under
  // `electron .`: in run 43563414074 the PATH alone was not enough on Windows — its `aria2c.exe --version` probe has
  // 4 s, and a fresh copy's first start under the antivirus can take longer.)
  if (a2) {
    const plat = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
    const resDir = path.join(path.dirname(require(path.join(DESK, 'node_modules', 'electron'))), 'resources', 'aria2', `${plat}-${process.arch}`);
    try { fs.mkdirSync(resDir, { recursive: true }); for (const f of fs.readdirSync(a2)) fs.copyFileSync(path.join(a2, f), path.join(resDir, f)); log('aria2c copied into Electron\'s resources:', resDir, fs.readdirSync(resDir).join(', ')); } catch (e) { log('aria2c not copied into Electron\'s resources:', e.message); }
    // (Its first start, here, before Electron's: the antivirus' look at a new program paid now.)
    try { const r = require('child_process').spawnSync(path.join(a2, process.platform === 'win32' ? 'aria2c.exe' : 'aria2c'), ['--version'], { timeout: 60000, windowsHide: true }); log('aria2c --version:', r.status, String(r.stdout || '').split(/\r?\n/)[0]); } catch (e) { log('aria2c --version failed:', e.message); }
  }
  const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }; if (a2) { const k = Object.keys(env).find((x) => x.toUpperCase() === 'PATH') || 'PATH'; env[k] = a2 + path.delimiter + (env[k] || ''); }
  const exe = require(path.join(DESK, 'node_modules', 'electron'));
  const args = [...(process.platform === 'linux' ? ['--no-sandbox'] : []), DESK];
  log('electron', exe, args.join(' '));
  at('launch');
  const app = await pw._electron.launch({ executablePath: exe, args, cwd: DESK, env, timeout: 120000 });
  try { appProc = app.process(); } catch { /* older playwright */ }
  // (The main process's own words about the engine — desktop/aria2.cjs's «[aria2c] …» — in this log.)
  try { for (const st of [appProc && appProc.stdout, appProc && appProc.stderr]) if (st) st.on('data', (d) => { for (const l of String(d).split(/\r?\n/)) if (/\[aria2c\]|\[tools\]|aria2/i.test(l)) log('electron:', l.slice(0, 300)); }); } catch { /* no pipes */ }
  const userData = await app.evaluate(({ app }) => app.getPath('userData'));
  log('userData', userData);
  const p = await app.firstWindow(); p.setDefaultTimeout(60000);
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.pc.starter', '1'); localStorage.setItem('kt.update.lastCheck', String(Date.now())); });
  at('reload'); await p.reload(); await p.waitForSelector('.downloads-view');
  if (!(await p.evaluate(() => !!window.kurokawaHandover && !!window.__KT_HANDOVER__))) throw new Error('this Electron build has no hand-over (preload.cjs kurokawaHandover, main.ts __KT_HANDOVER__)');

  at('profile');
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

  at('downloads');
  // Downloads, where aria2c runs: one moving, one paused by the person.
  const engine = { gids: [], moving: [], pausedByUser: [], available: false, dir: '', slow: null, server: { base, size: srv.size, sha256: srv.sha256, work: WORK } };
  // (Electron's contextBridge copies `window.kurokawaTools` when it exposes it: its `available` / `reason` getters were
  // read ONCE, while the engine was still starting — so polling `kt.available` gave {false, ''} for ever, in runs
  // 43563414074 and 43567491803, whatever aria2c did. The engine's real state is what main.cjs answers: kt:engineRetry
  // waits for the start under way (aria2c up and answering, or its reason) and returns it — as the page's «Try again».)
  const eng = await p.evaluate(async () => { const kt = window.kurokawaTools; await kt.ready(); const s = await kt.retryEngine(); return { available: !!(s && s.available), reason: (s && s.reason) || '' }; });
  engine.available = eng.available; log('Electron\'s engine:', JSON.stringify(eng));
  if (engine.available) {
    const dir = path.join(WORK, 'Downloads'); fs.mkdirSync(dir, { recursive: true });
    const add = (url, name) => p.evaluate(({ url, name, dir }) => window.kurokawaTools.add({ source: { url }, name, dir }), { url, name, dir });
    engine.dir = dir; engine.slowFile = path.join(dir, 'slow.bin');
    const a = await add(`${base}/slow.bin`, 'slow.bin'); const b = await add(`${base}/small.bin?2`, 'paused.bin');
    const idOf = (x) => (typeof x === 'string' ? x : x && (x.id || x.gid));
    engine.gids = [idOf(a), idOf(b)].filter(Boolean); engine.slow = idOf(a);
    await p.evaluate((id) => window.kurokawaTools.pause(id), idOf(b));
    for (let i = 0; i < 100; i++) { const t = await p.evaluate(() => window.kurokawaTools.list()); const s = t.find((x) => x.id === idOf(a)); if (s && s.state === 'downloading' && s.done > 1024 * 1024) break; await p.waitForTimeout(200); }
    const tasks = await p.evaluate(() => window.kurokawaTools.list());
    engine.moving = tasks.filter((t) => engine.gids.includes(t.id) && t.state !== 'paused').map((t) => t.id);
    engine.pausedByUser = tasks.filter((t) => engine.gids.includes(t.id) && t.state === 'paused').map((t) => t.id);
    log('downloads', JSON.stringify(tasks.map((t) => [t.id, t.state, t.done])));
  } else log('no aria2c here: the downloads are left out (the engine\'s files still cross)');
  // (Windows: the downloads' hand-over is required — never left out unsaid again.)
  const needDownloads = process.platform === 'win32';
  await p.waitForTimeout(1500);

  at('snapshot');
  const snap = await p.evaluate(() => window.__KT_HANDOVER__.snapshot());
  log('profile:', Object.keys(snap.local).length, 'keys;', Object.keys(snap.idb.meta).length + Object.keys(snap.idb.history).length, 'records;', Object.keys(snap.files).length, 'files');
  const t0 = Date.now();
  at('make');
  // (Where the disk's free space cannot be read, the page asks «Go on» — answered here, and said, so the step never
  // waits on a click.)
  let goOn = false; const asker = setInterval(() => { void p.evaluate(() => { const b = [...document.querySelectorAll('.sheet button')].find((x) => /^\s*Go on\s*$/.test(x.textContent || '')); if (b) { b.click(); return true; } return false; }).then((c) => { if (c && !goOn) { goOn = true; log('the free space was unknown: «Go on» pressed'); } }).catch(() => undefined); }, 500);
  const made = await p.evaluate(() => window.__KT_HANDOVER__.make()).finally(() => clearInterval(asker));
  log('hand-over:', JSON.stringify(made), `${Date.now() - t0} ms`);
  const status = await p.evaluate(() => window.kurokawaHandover.status());
  const after = engine.available ? await p.evaluate(() => window.kurokawaTools.list()) : [];
  at('close');
  // (Closed, or — the app not ending within 20 s — its process killed: its downloads are paused and saved already.)
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 20000))]).catch(() => undefined);
  try { if (appProc && appProc.exitCode === null) { log('the app did not end in 20 s: killed'); appProc.kill(); } } catch { /* gone */ }
  at('checks');
  const fails = [];
  if (needDownloads && !engine.available) fails.push('Electron\'s engine did not start, so no download was handed over (required on Windows): ' + JSON.stringify(eng));
  if (needDownloads && engine.available && (engine.moving.length !== 1 || engine.pausedByUser.length !== 1)) fails.push('not one moving and one paused download at the hand-over: ' + JSON.stringify({ moving: engine.moving, paused: engine.pausedByUser }));
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
