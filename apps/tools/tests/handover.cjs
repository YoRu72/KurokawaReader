// node tests/handover.cjs: the hand-over from the Electron build to the Rust build (Tools' stage P9 — src/handover.ts,
// src/ui/handoversheet.ts, desktop/handover.cjs, desktop-tauri/handover-bridge.js; the Rust side's file rules are
// kt-core's handoverlogic.rs's own tests, and CI runs the real thing: tests/handover-electron.cjs then
// desktop-tauri/handovercheck.js). The built app (dist/) in Chromium, in two shapes:
//   «Electron»: window.kurokawaHandover as preload.cjs gives it, its channels answered here by desktop/handover.cjs's
//     own install() — over a pretend ipcMain, in a temp «userData» folder, with a pretend aria2 (JSON-RPC answers, its
//     session file written as aria2 writes it);
//   «Rust»: desktop-tauri/bridge.js and handover-bridge.js over a pretend Tauri IPC whose kt_handover_* commands do what
//     src-tauri/src/handover.rs does, and whose «start» runs engine_prestart's rules first (the same rules, in Node).
// It checks: a full disk refused (nothing written, nothing paused, the person told, false for the installer); the free
// space unknown → asked, Cancel → nothing; a write broken off at the check → no hand-over, the paused downloads set
// going again; «Go on» → the hand-over made (marker, every hash, the pointer, the engine's files, which downloads were
// moving, the streams ended first; the partial download and its .aria2 file untouched); a killed write leaves only a part
// folder and the older hand-over stands; the Rust start puts the engine's files in place (the moving downloads going,
// the paused one paused, the screen font under its own name), offers the rest with what it holds and where the old data
// stays, brings it — a 17 MiB kept file in three pieces — and the profile is then the same (deep compare of every key,
// record and kept file; the screen translator's font paths moved to this build's folder; a downloaded update's path and
// the hand-over's own keys not carried); the icon applied; not offered again; a damaged copy refused, a truncated one
// not offered; a profile with things of its own merged (its own values kept); «Not now» kept; a picked folder found;
// «Free the space» deletes only the copy.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os'); const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-handover-'));
// (The pointer goes to the Rust build's data folder: here, under a temp XDG_DATA_HOME — never the real one.)
process.env.XDG_DATA_HOME = path.join(TMP, 'xdg'); delete process.env.KT_HANDOVER_FREE;
const H = require('../desktop/handover.cjs');
const DIST = path.join(ROOT, 'dist');
const BRIDGE = fs.readFileSync(path.join(ROOT, 'desktop-tauri', 'bridge.js'), 'utf8');
const HBRIDGE = fs.readFileSync(path.join(ROOT, 'desktop-tauri', 'handover-bridge.js'), 'utf8');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 900))); if (!c) fails++; return !!c; };
const userData = path.join(TMP, 'electron-userData'); const tauriData = H.tauriDataDir(); const dl = path.join(TMP, 'Downloads', 'Kurokawa');
for (const d of [userData, path.join(userData, 'screen-fonts'), dl]) fs.mkdirSync(d, { recursive: true });
const ICON = 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'desktop', 'icon.png')).toString('base64');
const FONT_NAME = '1700000000000-My Font خط.ttf'; const FONT = path.join(userData, 'screen-fonts', FONT_NAME);
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

// ---------- the Electron shell's own files, and a pretend aria2 ----------
fs.writeFileSync(path.join(userData, 'custom-icon.png'), fs.readFileSync(path.join(ROOT, 'desktop', 'icon.png')));
fs.writeFileSync(path.join(userData, 'window-state.json'), JSON.stringify({ x: 10, y: 20, width: 1200, height: 800, maximized: false }));
fs.writeFileSync(FONT, Buffer.alloc(2000, 7));
fs.writeFileSync(path.join(userData, 'tasks.json'), JSON.stringify({ '00a1b2c3d4e5f601': { name: 'a.bin', addedAt: 1700000000000 }, '00a1b2c3d4e5f602': { name: 'b.bin', addedAt: 1700000000001 }, '00a1b2c3d4e5f603': { name: 'c.bin', addedAt: 1700000000002 } }));
fs.writeFileSync(path.join(userData, 'aria2-config.json'), JSON.stringify({ seed: true, maxConnections: 12 }));
fs.writeFileSync(path.join(userData, 'dht.dat'), Buffer.alloc(300, 1));
fs.writeFileSync(path.join(userData, 'video-jobs.json'), JSON.stringify([{ id: 'v1', state: 'paused', url: 'https://example.test/v', dir: dl }]));
// (The partial download and its control file: they must be untouched by the hand-over.)
fs.writeFileSync(path.join(dl, 'a.bin'), Buffer.alloc(5000, 3)); fs.writeFileSync(path.join(dl, 'a.bin.aria2'), Buffer.alloc(120, 9));
const partSums = () => [sha(path.join(dl, 'a.bin')), sha(path.join(dl, 'a.bin.aria2'))].join();
const partBefore = partSums();
const aria = { list: [{ gid: '00a1b2c3d4e5f601', status: 'active', uri: 'https://example.test/a.bin', out: 'a.bin' }, { gid: '00a1b2c3d4e5f602', status: 'waiting', uri: 'https://example.test/b.bin', out: 'b.bin' }, { gid: '00a1b2c3d4e5f603', status: 'paused', uri: 'https://example.test/c.bin', out: 'c.bin' }], calls: [] };
const writeSession = () => fs.writeFileSync(path.join(userData, 'aria2.session'), aria.list.map((d) => `${d.uri}\n dir=${dl}\n gid=${d.gid}\n out=${d.out}\n${d.status === 'paused' ? ' pause=true\n' : ''}`).join(''));
writeSession();
const rpc = { call: async (m, ...a) => {
  aria.calls.push(m === 'unpause' ? `unpause ${a[0]}` : m);
  if (m === 'tellActive') return aria.list.filter((d) => d.status === 'active').map((d) => ({ gid: d.gid, status: d.status }));
  if (m === 'tellWaiting') return aria.list.filter((d) => d.status !== 'active').map((d) => ({ gid: d.gid, status: d.status }));
  if (m === 'pauseAll') { for (const d of aria.list) if (d.status === 'waiting') d.status = 'paused'; setTimeout(() => { for (const d of aria.list) if (d.status === 'active') d.status = 'paused'; }, 300); return 'OK'; }
  if (m === 'forcePauseAll') { for (const d of aria.list) if (d.status !== 'complete') d.status = 'paused'; return 'OK'; }
  if (m === 'saveSession') { writeSession(); return 'OK'; }
  if (m === 'unpause') { const d = aria.list.find((x) => x.gid === a[0]); if (!d) throw new Error('not found'); d.status = 'active'; return a[0]; }
  throw new Error('unknown ' + m);
} };
let streamsEnded = 0;
const handlers = {}; const fakeIpc = { handle: (ch, fn) => { handlers[ch] = fn; } };
H.install({ ipcMain: fakeIpc, app: { getPath: () => userData, getVersion: () => '0.16.32' } }, { engine: () => ({ rpc, available: true }), beforeEngine: async () => { streamsEnded++; } });
let failVerifyOnce = false;
async function electronCall(cmd, a) {
  if (cmd === 'verify' && failVerifyOnce) { failVerifyOnce = false; throw new Error('the process ended here'); }
  const ch = { begin: 'kt:handover-begin', write: 'kt:handover-write', shellFiles: 'kt:handover-shell', engineFiles: 'kt:handover-engine', readPart: 'kt:handover-read', verify: 'kt:handover-verify', finish: 'kt:handover-finish', abort: 'kt:handover-abort', status: 'kt:handover-status' }[cmd];
  if (!ch || !handlers[ch]) throw new Error('unknown ' + cmd);
  if (cmd === 'write') return handlers[ch](null, a.rel, Buffer.from(a.b64, 'base64'), a.append);
  if (cmd === 'readPart') return Buffer.from(await handlers[ch](null, a.rel)).toString('base64');
  if (cmd === 'begin') return handlers[ch](null, { need: a.need, unknownOk: a.unknownOk });
  if (cmd === 'verify') return handlers[ch](null, a.list);
  if (cmd === 'finish') return handlers[ch](null, a.info);
  return handlers[ch](null);
}
const ELECTRON_SHIM = () => {
  const call = (c, a) => window.__kthE(c, a || {});
  const toB64 = (u) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
  const fromB64 = (b) => { const s = atob(b); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; };
  window.kurokawaHandover = Object.freeze({ shell: 'electron', begin: (o) => call('begin', { need: o.need, unknownOk: !!o.unknownOk }), write: (rel, data, append) => call('write', { rel, b64: toB64(data), append: !!append }), shellFiles: () => call('shellFiles'), engineFiles: () => call('engineFiles'), readPart: async (rel) => fromB64(await call('readPart', { rel })), verify: (list) => call('verify', { list }), finish: (info) => call('finish', { info }), abort: () => call('abort'), status: () => call('status'), switchInfo: () => Promise.resolve(null) });
};

// ---------- the Rust shell's kt_handover_* and engine_prestart — src-tauri/src/handover.rs's rules, in Node ----------
function check(dir) {
  const m = rj(path.join(dir, 'marker.json')); if (!m) return { bad: [`${dir}: no readable marker`] };
  if (m.app !== 'KurokawaTools' || m.kind !== 'handover') return { bad: ['not a hand-over'] };
  if (!(m.format >= 1 && m.format <= 1)) return { bad: [`format ${m.format}`] };
  const bad = [];
  for (const f of m.files || []) { if (!H.safeRel(f.rel)) { bad.push(f.rel); continue; } let st; try { st = fs.statSync(path.join(dir, ...f.rel.split('/'))); } catch { bad.push(`${f.rel}: missing`); continue; } if (st.size !== f.size) bad.push(`${f.rel}: ${st.size} bytes, ${f.size} expected`); }
  return bad.length ? { bad } : { m };
}
const resolveGiven = (p) => (fs.existsSync(path.join(p, 'marker.json')) ? p : fs.existsSync(path.join(p, 'handover', 'marker.json')) ? path.join(p, 'handover') : p);
const R = { from: null };   // (KT_HANDOVER_FROM)
const candidates = () => [...new Set([R.from && resolveGiven(R.from), rj(path.join(tauriData, H.POINTER))?.dir, path.join(userData, 'handover')].filter(Boolean))];
const firstFound = () => { for (const d of candidates()) { if (!fs.existsSync(path.join(d, 'marker.json'))) continue; const c = check(d); if (c.m) return { dir: d, m: c.m }; } return null; };
// (handoverlogic.rs session_unpause: « pause=true» off the entries of the moving downloads.)
const unpause = (text, moving) => text.split(/(?=^\S)/m).map((e) => (moving.some((g) => new RegExp(`^[ \\t]+gid=${g}\\s*$`, 'm').test(e)) ? e.replace(/^[ \t]+pause=true\r?\n?/m, '') : e)).join('');
function enginePrestart() {
  const doneFile = path.join(tauriData, 'handover-engine.json'); const f = firstFound(); if (!f) return;
  const id = f.m.id; if (rj(doneFile)?.id === id) return;
  const note = (state, x = {}) => { fs.mkdirSync(tauriData, { recursive: true }); fs.writeFileSync(doneFile, JSON.stringify({ id, state, at: Date.now(), ...x })); };
  const listed = (rel) => f.m.files.some((x) => x.rel === rel);
  const bad = f.m.files.filter((x) => (x.rel.startsWith('engine/') || x.rel.startsWith('shell/screen-fonts')) && sha(path.join(f.dir, ...x.rel.split('/'))) !== x.sha256);
  if (bad.length) return note('damaged');
  let fonts = 0;
  for (const x of listed('shell/screen-fonts.json') ? rj(path.join(f.dir, 'shell', 'screen-fonts.json')) : []) { const to = path.join(tauriData, 'screen-fonts', x.name); if (fs.existsSync(to) || /[\\/:*?"<>|]/.test(x.name)) continue; fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(f.dir, ...x.rel.split('/')), to); fonts++; }
  const own = (n) => { try { return fs.readFileSync(path.join(tauriData, n), 'utf8').trim(); } catch { return ''; } };
  if (!['', '{}'].includes(own('tasks.json')) || own('aria2.session') || !['', '[]'].includes(own('video-jobs.json'))) return note('kept-own', { fonts });
  const moving = listed('engine/moving.json') ? rj(path.join(f.dir, 'engine', 'moving.json')) : [];
  let downloads = 0, videos = 0, files = 0;
  for (const [rel, name] of [['engine/aria2.session', 'aria2.session'], ['engine/tasks.json', 'tasks.json'], ['engine/aria2-config.json', 'aria2-config.json'], ['engine/dht.dat', 'dht.dat'], ['engine/dht6.dat', 'dht6.dat'], ['engine/video-jobs.json', 'video-jobs.json']]) {
    if (!listed(rel)) continue; let b = fs.readFileSync(path.join(f.dir, ...rel.split('/')));
    if (name === 'aria2.session') { const t = b.toString('utf8'); downloads = (t.match(/^[ \t]+gid=/gm) || []).length; b = Buffer.from(unpause(t, moving)); }
    if (name === 'video-jobs.json') videos = JSON.parse(b.toString('utf8')).length;
    fs.writeFileSync(path.join(tauriData, name), b); files++;
  }
  note('carried', { files, downloads, moving: moving.length, videos, fonts });
}
const stateFile = () => path.join(tauriData, 'handover-state.json');
const ranges = [];
const rust = {
  kt_handover_find: ({ p }) => {
    const state = rj(stateFile()); const engine = rj(path.join(tauriData, 'handover-engine.json'));
    const list = p ? [resolveGiven(p)] : candidates(); const problems = [];
    for (const d of list) { if (!fs.existsSync(path.join(d, 'marker.json'))) continue; const c = check(d); if (c.m) return { found: true, dir: d, marker: c.m, state, engine, dataDir: tauriData, looked: list }; problems.push(...c.bad); }
    return { found: false, state, engine, dataDir: tauriData, looked: list, problems, electron: { library: true, program: false } };
  },
  kt_handover_verify: ({ p }) => { const c = check(p); if (!c.m) return { ok: false, bad: c.bad }; const bad = c.m.files.filter((f) => sha(path.join(p, ...f.rel.split('/'))) !== f.sha256).map((f) => `${f.rel}: its contents changed`); return { ok: !bad.length, bad }; },
  kt_handover_read: ({ p, rel, at, len }) => {
    if (!H.safeRel(rel)) throw new Error('not a path in the hand-over: ' + rel);
    const f = path.join(p, ...rel.split('/'));
    if (at === undefined && len === undefined) return { b64: fs.readFileSync(f).toString('base64') };
    ranges.push(rel);
    const want = Math.min(len ?? 8 * 1024 * 1024, 64 * 1024 * 1024); const fd = fs.openSync(f, 'r');
    try { const b = Buffer.alloc(want); const n = fs.readSync(fd, b, 0, want, at ?? 0); return { b64: b.subarray(0, n).toString('base64') }; } finally { fs.closeSync(fd); }
  },
  kt_handover_mark: ({ o }) => { if (!o.id || !['restored', 'declined'].includes(o.state)) throw new Error('id and state'); fs.mkdirSync(tauriData, { recursive: true }); fs.writeFileSync(stateFile(), JSON.stringify({ id: o.id, state: o.state, at: Date.now(), counts: o.counts ?? null })); return true; },
  kt_handover_free: ({ p }) => { if (path.basename(p) !== 'handover' || rj(path.join(p, 'marker.json'))?.kind !== 'handover') throw new Error('not a hand-over folder: ' + p); let n = 0; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const q = path.join(d, e.name); if (e.isDirectory()) walk(q); else n += fs.statSync(q).size; } }; walk(p); fs.rmSync(p, { recursive: true, force: true }); return { freed: n }; },
  kt_handover_open_old: () => false,
};
const shellState = { icon: null };
rust.kt_app_icon = ({ o }) => { if (o && 'set' in o) { shellState.icon = o.set; return true; } return shellState.icon; };
async function rustCall(cmd, a) { if (!rust[cmd]) throw new Error('unknown ' + cmd); return rust[cmd](a); }
const TAURI_SHIM = () => {
  try { localStorage.setItem('kt.pc.starter', '1'); localStorage.setItem('kt.update.lastCheck', String(Date.now())); if (!localStorage.getItem('kr.lang')) localStorage.setItem('kr.lang', 'en'); } catch { /* first load */ }
  const fromB64 = (b) => { const s = atob(b); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
  const replies = { kt_state: () => ({ available: false, reason: '', os: 'linux', arch: 'x64' }), kt_list: () => [], kt_open_take: () => [], kt_roots: () => ({ roots: ['/home/u'] }), kt_default_dir: () => '/home/u/Downloads/Kurokawa', kt_files_roots: () => ({ roots: [] }) };
  window.__TAURI__ = {
    core: { invoke: (cmd, args) => (/^kt_handover_|^kt_app_icon$/.test(cmd) ? window.__kthT(cmd, JSON.parse(JSON.stringify(args || {}))).then((r) => (r && typeof r.b64 === 'string' ? fromB64(r.b64) : r)) : Promise.resolve(replies[cmd] ? replies[cmd](args || {}) : null)) },
    event: { listen: () => Promise.resolve(() => {}) },
  };
};

// ---------- what the person keeps in the Electron build ----------
const FILL = async ({ ICON, FONT, NOW }) => {
  const L = { 'kt.settings': JSON.stringify({ addons: ['anime', 'tv', 'player'], doh: 'off', uiMode: 'dark' }), 'kt.anime.listStatus': JSON.stringify({ 21: 'watching', 1535: 'completed' }), 'kt.tv.watchlist': JSON.stringify([{ id: 1399, name: 'A show' }]),
    'kt.player.memory': JSON.stringify({ 'file:/home/u/Downloads/Kurokawa/ep01.mkv': { pos: 1234.5, dur: 1440, sub: 'ara', audio: 'jpn' } }), 'kt.anilist.token': 'made-up-token-for-a-test', 'kt.follows': JSON.stringify(['ani:21']), 'kt.notes': JSON.stringify([{ id: 'n1', text: 'ملاحظة' }]),
    'kt.screen': JSON.stringify({ fonts: [{ name: 'My Font', path: FONT }], on: false }), 'app.icon': ICON, 'kt.update.file': JSON.stringify({ name: 'x.exe', path: '/tmp/x.exe', size: 1 }), 'kt.handover.progress': 'old' };
  for (const [k, v] of Object.entries(L)) localStorage.setItem(k, v);
  const d = await new Promise((res, rej) => { const r = indexedDB.open('kurokawa-tools', 1); r.onupgradeneeded = () => { const x = r.result; for (const s of ['meta', 'files']) if (!x.objectStoreNames.contains(s)) x.createObjectStore(s); if (!x.objectStoreNames.contains('history')) x.createObjectStore('history', { keyPath: 'id' }); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const big = new Uint8Array(17 * 1024 * 1024 + 5); for (let i = 0; i < big.length; i += 4096) big[i] = (i / 4096) & 255;
  await new Promise((res) => { const tx = d.transaction(['meta', 'files', 'history'], 'readwrite'); const m = tx.objectStore('meta'); const f = tx.objectStore('files'); const h = tx.objectStore('history');
    m.put({ id: 'nyaa', name: 'Nyaa', url: 'https://example.test/nyaa.json', version: '1.2.0' }, 'addon-manifest:nyaa'); m.put('1.2.0', 'addon-version:nyaa'); m.put(['nyaa-child'], 'addon-children:nyaa');
    m.put({ lines: ['سطر', 'line'], at: new Date(NOW) }, 'subtr:ep01:ar'); m.put({ when: new Date(NOW), bytes: new Uint8Array([1, 2, 3]), pic: new Blob(['peek'], { type: 'image/jpeg' }), $kt: 'a user key', inf: Infinity }, 'odd');
    f.put(new Blob(['{"add-on":"code"}'.repeat(100)], { type: 'application/json' }), 'addon:nyaa'); f.put(new File([big], 'Big Font.ttf', { type: 'font/ttf' }), 'font:big');
    h.put({ id: 'h1', url: 'https://example.test/a', at: NOW, title: 'A' }); h.put({ id: 'h2', url: 'https://example.test/b', at: NOW + 1, title: 'ب' });
    tx.oncomplete = () => res(); });
  d.close();
};

(async () => {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('no dist/: run node scripts/build.mjs first');
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}/`;
  const br = await chromium.launch(); const errors = [];
  const electronPage = async () => {
    const ctx = await br.newContext({ viewport: { width: 1100, height: 800 } }); const p = await ctx.newPage(); p.setDefaultTimeout(30000);
    p.on('pageerror', (e) => errors.push('E: ' + e.message));
    await p.exposeFunction('__kthE', (c, a) => electronCall(c, a));
    await p.addInitScript(ELECTRON_SHIM);
    await p.addInitScript(() => { try { localStorage.setItem('kt.pc.starter', '1'); if (!localStorage.getItem('kr.lang')) localStorage.setItem('kr.lang', 'en'); } catch { /* first */ } });
    await p.goto(base); await p.waitForSelector('.downloads-view'); return p;
  };
  const rustPage = async () => {
    enginePrestart();   // (main.rs: before the engine and the page)
    const ctx = await br.newContext({ viewport: { width: 1100, height: 800 } }); const p = await ctx.newPage(); p.setDefaultTimeout(30000);
    p.on('pageerror', (e) => errors.push('R: ' + e.message));
    await p.exposeFunction('__kthT', (c, a) => rustCall(c, a));
    await p.addInitScript(TAURI_SHIM);
    await p.addInitScript({ content: `window.__KT_BOOT__ = ${JSON.stringify({ os: 'linux', arch: 'x64' })};\n${BRIDGE}\n${HBRIDGE}` });
    await p.goto(base); await p.waitForSelector('.downloads-view'); return p;
  };
  const make = (p) => p.evaluate(() => window.__KT_HANDOVER__.beforeInstall());
  const sheetState = (p) => p.evaluate(() => [...document.querySelectorAll('[data-handover]')].map((e) => e.getAttribute('data-handover')).pop() || null);
  const closeSheets = (p) => p.evaluate(() => { for (const s of document.querySelectorAll('.sheet')) s.querySelector('.sheet-actions .btn.primary, .sheet-actions .btn')?.click(); });

  // ================= 1. the Electron profile, filled =================
  const A = await electronPage();
  await A.evaluate(FILL, { ICON, FONT, NOW: 1_700_000_000_000 });
  await A.reload(); await A.waitForSelector('.downloads-view');

  // ================= 2. refusals: a full disk, an unknown free space, a write broken off =================
  process.env.KT_HANDOVER_FREE = '1000';
  ok('a full disk: false for the installer', (await make(A)) === false);
  ok('… the person told why', (await sheetState(A)) === 'failed' && /Not enough free space/.test(await A.evaluate(() => document.querySelector('[data-handover="failed"] [role="status"]')?.textContent || '')));
  ok('… nothing written, nothing paused', !fs.existsSync(path.join(userData, 'handover')) && !fs.existsSync(path.join(userData, 'handover.part')) && !aria.calls.includes('pauseAll'), aria.calls);
  await closeSheets(A);
  process.env.KT_HANDOVER_FREE = '-1';
  let made = make(A); await A.waitForSelector('[data-handover="ask-space"]');
  ok('free space unknown: asked, with the estimate', /about/.test(await A.evaluate(() => document.querySelector('[data-handover="ask-space"] [role="status"]').textContent)));
  await A.click('[data-act="space-no"]'); ok('… Cancel → false, nothing written', (await made) === false && !fs.existsSync(path.join(userData, 'handover')) && !fs.existsSync(path.join(userData, 'handover.part')));
  delete process.env.KT_HANDOVER_FREE;
  failVerifyOnce = true; aria.calls.length = 0;
  ok('a write broken off at the check: false', (await make(A)) === false);
  ok('… no hand-over, no part folder', !fs.existsSync(path.join(userData, 'handover')) && !fs.existsSync(path.join(userData, 'handover.part')));
  ok('… the downloads paused for it set going again (the one paused by the person left)', aria.calls.includes('pauseAll') && aria.calls.includes('unpause 00a1b2c3d4e5f601') && aria.calls.includes('unpause 00a1b2c3d4e5f602') && !aria.calls.includes('unpause 00a1b2c3d4e5f603'), aria.calls);
  await closeSheets(A);

  // ================= 3. made (the free space unknown, «Go on») =================
  process.env.KT_HANDOVER_FREE = '-1'; aria.calls.length = 0; const ended0 = streamsEnded;
  for (const d of aria.list) if (d.gid !== '00a1b2c3d4e5f603') d.status = d.gid.endsWith('1') ? 'active' : 'waiting';
  made = make(A); await A.waitForSelector('[data-handover="ask-space"]'); await A.click('[data-act="space-go"]');
  ok('«Go on» → made: true for the installer', (await made) === true); delete process.env.KT_HANDOVER_FREE;
  const hdir = path.join(userData, 'handover'); const marker = rj(path.join(hdir, 'marker.json'));
  ok('the marker: Tools\' app, every file with its size and SHA-256', marker && marker.app === 'KurokawaTools' && marker.files.length > 8 && marker.files.every((f) => sha(path.join(hdir, ...f.rel.split('/'))) === f.sha256 && fs.statSync(path.join(hdir, ...f.rel.split('/'))).size === f.size), marker && marker.files.map((f) => f.rel));
  ok('… its counts', marker && marker.counts.addons === 1 && marker.counts.history === 2 && marker.counts.downloads === 3 && marker.counts.moving === 2 && marker.counts.videos === 1 && marker.counts.lists >= 5, marker && marker.counts);
  ok('no part folder left; the pointer in the Rust build\'s data folder', !fs.existsSync(path.join(userData, 'handover.part')) && rj(path.join(tauriData, H.POINTER))?.id === marker.id);
  ok('the streams ended first, then the engine paused and its session saved', streamsEnded === ended0 + 1 && aria.calls.indexOf('pauseAll') >= 0 && aria.calls.indexOf('saveSession') > aria.calls.indexOf('pauseAll') && aria.list.every((d) => d.status === 'paused'), aria.calls);
  ok('the engine\'s files and which downloads were moving', ['aria2.session', 'tasks.json', 'aria2-config.json', 'dht.dat', 'video-jobs.json'].every((n) => fs.existsSync(path.join(hdir, 'engine', n))) && JSON.stringify(rj(path.join(hdir, 'engine', 'moving.json'))) === JSON.stringify(['00a1b2c3d4e5f601', '00a1b2c3d4e5f602']));
  ok('the screen font by number, its own name in the index', rj(path.join(hdir, 'shell', 'screen-fonts.json'))?.[0]?.name === FONT_NAME && sha(path.join(hdir, 'shell', 'screen-fonts', '0')) === sha(FONT));
  ok('the partial download and its .aria2 file untouched, in their folder', partSums() === partBefore);
  const local = rj(path.join(hdir, 'handover', 'local.json'));
  ok('every key but a downloaded update\'s path and the hand-over\'s own; the sign-in kept', local && !('kt.update.file' in local) && !('kt.handover.progress' in local) && local['kt.anilist.token'] === 'made-up-token-for-a-test' && local['app.icon'] === ICON);
  const snapA = await A.evaluate(() => window.__KT_HANDOVER__.snapshot());

  // ================= 4. a killed write: only a part folder; the hand-over made before stands =================
  { const w = new H.Writer(userData, {}); await w.begin(10); await w.write('handover/local.json', Buffer.from('{"half":'), false); }
  ok('a killed write leaves a part folder, never a marker', fs.existsSync(path.join(userData, 'handover.part')) && !fs.existsSync(path.join(userData, 'handover.part', 'marker.json')));
  ok('… the complete one still found', rust.kt_handover_find({}).marker?.id === marker.id);

  // ================= 5. the Rust build's first start =================
  const B = await rustPage();
  const eng = rj(path.join(tauriData, 'handover-engine.json'));
  ok('engine_prestart: the downloads carried before the engine', eng && eng.state === 'carried' && eng.id === marker.id && eng.downloads === 3 && eng.moving === 2 && eng.videos === 1 && eng.fonts === 1, eng);
  const sess = fs.readFileSync(path.join(tauriData, 'aria2.session'), 'utf8'); const ent = (g) => sess.split(/(?=^\S)/m).find((e) => e.includes(`gid=${g}`)) || '';
  ok('… the two that were moving go on, the one paused by the person stays paused', !/pause=true/.test(ent('00a1b2c3d4e5f601')) && !/pause=true/.test(ent('00a1b2c3d4e5f602')) && /pause=true/.test(ent('00a1b2c3d4e5f603')) && ent('00a1b2c3d4e5f601').includes(`dir=${dl}`), sess);
  ok('… the notes on each download, the settings, the DHT, the video jobs the same', ['tasks.json', 'aria2-config.json', 'dht.dat', 'video-jobs.json'].every((n) => sha(path.join(tauriData, n)) === sha(path.join(userData, n))));
  ok('… the screen font under its own name', fs.existsSync(path.join(tauriData, 'screen-fonts', FONT_NAME)) && sha(path.join(tauriData, 'screen-fonts', FONT_NAME)) === sha(FONT));
  await B.waitForSelector('[data-handover="offer"]', { timeout: 15000 });
  const offerText = await B.evaluate(() => document.querySelector('[data-handover="offer"]').textContent);
  ok('the offer at the start: what it holds, the downloads already here, where the old data stays', /Settings: \d+/.test(offerText) && /Add-ons: 1/.test(offerText) && /Downloads: 4/.test(offerText) && /already here \(4\)/.test(offerText) && offerText.includes(hdir), offerText.slice(0, 600));
  await B.click('[data-handover-go]');
  await B.waitForFunction(() => ['done', 'failed'].includes(document.querySelector('[data-handover]')?.getAttribute('data-handover')), null, { timeout: 60000 });
  ok('«Bring it now» brought it', (await sheetState(B)) === 'done', await B.evaluate(() => document.querySelector('[data-handover] [role="status"]')?.textContent));
  ok('… the 17 MiB kept file in three pieces', ranges.filter((r) => r.startsWith('files/')).length === 3, ranges);
  await Promise.all([B.waitForNavigation(), B.click('[data-handover-continue]')]); await B.waitForSelector('.downloads-view');
  const snapB = await B.evaluate(() => window.__KT_HANDOVER__.snapshot());
  const OWN = /^(kt\.update\.(lastCheck|ran)|kt\.screen|kt\.firstrun\.done|kt\.pc\.starter|kt\.deviceId|kt\.recorder)$/;
  const keyDiff = Object.keys(snapA.local).filter((k) => !OWN.test(k) && snapB.local[k] !== snapA.local[k]);
  ok('every key the same (deep compare)', keyDiff.length === 0, keyDiff);
  ok('every record the same (meta, history — dates, bytes, pictures, odd numbers)', JSON.stringify(snapB.idb) === JSON.stringify(snapA.idb), { a: snapA.idb, b: snapB.idb });
  ok('every kept file the same size', JSON.stringify(snapB.files) === JSON.stringify(snapA.files), snapB.files);
  ok('watch progress and subtitle choice the same', JSON.parse(snapB.local['kt.player.memory'])['file:/home/u/Downloads/Kurokawa/ep01.mkv'].pos === 1234.5 && JSON.parse(snapB.local['kt.player.memory'])['file:/home/u/Downloads/Kurokawa/ep01.mkv'].sub === 'ara');
  ok('the screen translator\'s font now named in this build\'s folder', JSON.parse(snapB.local['kt.screen']).fonts[0].path === path.join(tauriData, 'screen-fonts', FONT_NAME), snapB.local['kt.screen']);
  ok('neither a downloaded update\'s path nor the old hand-over keys came', !('kt.update.file' in snapB.local) && snapB.local['kt.handover.progress'] === undefined);
  ok('the icon put on the window', shellState.icon === ICON);
  ok('marked restored', rj(stateFile())?.state === 'restored' && rj(stateFile())?.id === marker.id);
  ok('the Blob, the date and the bytes came back as they were', await B.evaluate(async () => { const d = await new Promise((r) => { const q = indexedDB.open('kurokawa-tools'); q.onsuccess = () => r(q.result); }); const v = await new Promise((r) => { const q = d.transaction('meta').objectStore('meta').get('odd'); q.onsuccess = () => r(q.result); }); d.close(); return v.when instanceof Date && v.bytes instanceof Uint8Array && v.bytes[2] === 3 && v.pic instanceof Blob && (await v.pic.text()) === 'peek' && v.inf === Infinity && v.$kt === 'a user key'; }));
  await B.reload(); await B.waitForSelector('.downloads-view'); await B.waitForTimeout(2500);
  ok('the second start offers nothing', !(await B.$('[data-handover="offer"]')));
  const B2 = await rustPage(); ok('… nor does the engine take its files twice', rj(path.join(tauriData, 'handover-engine.json'))?.at === eng.at); await B2.context().close();

  // ================= 6. damaged and truncated copies =================
  const dmg = path.join(TMP, 'damaged', 'handover'); fs.cpSync(hdir, dmg, { recursive: true });
  for (const rel of ['handover/local.json', 'engine/tasks.json']) { const f = path.join(dmg, ...rel.split('/')); const b = fs.readFileSync(f); b[5] ^= 1; fs.writeFileSync(f, b); }
  ok('a damaged copy: found by size, refused by its hash', rust.kt_handover_find({ p: dmg }).found && !rust.kt_handover_verify({ p: dmg }).ok);
  const trunc = path.join(TMP, 'trunc', 'handover'); fs.cpSync(hdir, trunc, { recursive: true }); fs.truncateSync(path.join(trunc, 'handover', 'local.json'), 10);
  ok('a truncated copy is not even offered', !rust.kt_handover_find({ p: trunc }).found);
  ok('a picked folder: Electron\'s data folder → its hand-over', rust.kt_handover_find({ p: userData }).dir === hdir);
  { const C = await (async () => { R.from = dmg; fs.rmSync(path.join(tauriData), { recursive: true, force: true }); return rustPage(); })();
    await C.waitForSelector('[data-handover="offer"]', { timeout: 15000 }); await C.click('[data-handover-go]');
    await C.waitForFunction(() => ['done', 'failed'].includes(document.querySelector('[data-handover]')?.getAttribute('data-handover')), null, { timeout: 60000 });
    ok('… and its offer says it is damaged, bringing nothing', (await sheetState(C)) === 'failed' && /damaged/.test(await C.evaluate(() => document.querySelector('[data-handover] [role="status"]').textContent)) && !(await C.evaluate(() => localStorage.getItem('kt.anilist.token'))));
    ok('… nor did the engine take its damaged files', rj(path.join(tauriData, 'handover-engine.json'))?.state === 'damaged');
    await C.context().close(); R.from = null; }

  // ================= 7. «Not now», then a merge into a profile with things of its own =================
  fs.rmSync(tauriData, { recursive: true, force: true }); fs.mkdirSync(tauriData, { recursive: true });
  fs.writeFileSync(path.join(tauriData, 'tasks.json'), JSON.stringify({ ffff000000000001: { name: 'mine.bin' } }));
  const D = await rustPage();
  ok('a build with downloads of its own keeps them (the old list left where it is)', rj(path.join(tauriData, 'handover-engine.json'))?.state === 'kept-own' && Object.keys(rj(path.join(tauriData, 'tasks.json'))).join() === 'ffff000000000001');
  await D.waitForSelector('[data-handover="offer"]', { timeout: 15000 });
  await D.click('[data-handover="offer"] .btn.text');
  ok('«Not now» marked declined', rj(stateFile())?.state === 'declined');
  await D.reload(); await D.waitForSelector('.downloads-view'); await D.waitForTimeout(2500);
  ok('… and not offered at the start again', !(await D.$('[data-handover="offer"]')));
  await D.evaluate(() => { localStorage.setItem('kt.tv.watchlist', JSON.stringify([{ id: 7, name: 'Mine' }])); });
  await D.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-tools'); r.onsuccess = () => { const tx = r.result.transaction('history', 'readwrite'); tx.objectStore('history').put({ id: 'h9', url: 'https://example.test/mine', at: 1 }); tx.oncomplete = () => { r.result.close(); res(); }; }; }));
  const mr = await D.evaluate(() => window.__KT_HANDOVER__.restore(undefined, 'auto'));
  const snapD = await D.evaluate(() => window.__KT_HANDOVER__.snapshot());
  ok('merged: its own list kept, the missing keys and records added', mr.mode === 'merge' && JSON.parse(snapD.local['kt.tv.watchlist'])[0].name === 'Mine' && snapD.local['kt.anilist.token'] === 'made-up-token-for-a-test' && Object.keys(snapD.idb.history).length === 3 && snapD.files['font:big'] === snapA.files['font:big'], { mode: mr.mode, history: Object.keys(snapD.idb.history) });
  await D.context().close();

  // ================= 8. «Free the space»: only the copy =================
  fs.rmSync(tauriData, { recursive: true, force: true }); fs.mkdirSync(tauriData, { recursive: true });
  const E2 = await rustPage();
  await E2.waitForSelector('[data-handover="offer"]', { timeout: 15000 }); await E2.click('[data-handover-go]');
  await E2.waitForSelector('[data-handover="done"]', { timeout: 60000 });
  await E2.click('[data-handover-free]'); await E2.waitForSelector('[data-handover-free-yes]');
  ok('«Free the space» asks first, saying what stays', /stay/.test(await E2.evaluate(() => [...document.querySelectorAll('.sheet')].pop().textContent)) && fs.existsSync(hdir));
  await E2.click('[data-handover-free-yes]'); await E2.waitForTimeout(400);
  ok('… then deletes only the copy: Electron\'s data and the downloads stay', !fs.existsSync(hdir) && fs.existsSync(path.join(userData, 'aria2.session')) && fs.existsSync(FONT) && partSums() === partBefore);
  await E2.context().close();

  ok('no page errors', errors.length === 0, errors);
  await br.close(); server.close(); fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fails ? `handover: ${fails} failed` : 'handover: all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
