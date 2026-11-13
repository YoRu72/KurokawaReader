// The Reader's Tauri shell, its bridge (desktop-tauri/bridge.js) against the Electron one (desktop/preload.cjs):
//  1. in plain node: the bridge has exactly the preload's names; each ported function sends the preload's arguments
//     under the command named after its channel (kr:a-b → kr_a_b); bytes come back as an ArrayBuffer, errors as
//     Errors, a page's text in its own charset; each stub answers as bridge.js documents and never reaches the IPC;
//     every command the bridge and the self-test call is registered in main.rs with the argument names they send;
//     the self-test script (desktop-tauri/selftest.js) is inert without its settings and passes / fails as it should
//     against a fake bridge;
//  2. in Chromium (Playwright): the built web app (dist/) with the bridge and a fake Tauri IPC that records each call
//     — the library renders with the computer's layout, a book opens in the reader, Settings open, no page errors, and
//     each ported function sends the right command and arguments from the page.
// Run after `node scripts/build.mjs`: node tests/tauribridge.cjs
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const Module = require('node:module');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const TAURI = path.join(ROOT, 'desktop-tauri');
const BRIDGE = fs.readFileSync(path.join(TAURI, 'bridge.js'), 'utf8');
const snake = (ch) => ch.replace(/^kr:/, 'kr_').replace(/-/g, '_');

// --- Electron's preload, with a fake electron that records each invoke / send.
let eCalls = [];
function loadPreload() {
  let exposed = null;
  const fake = {
    contextBridge: { exposeInMainWorld: (_n, o) => { exposed = o; } },
    ipcRenderer: { invoke: (ch, ...a) => { eCalls.push({ ch, a }); return Promise.resolve(null); }, send: (ch, ...a) => { eCalls.push({ ch, a, send: true }); }, on() {}, removeListener() {}, removeAllListeners() {} },
    webFrame: { setZoomFactor() {} },
  };
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'electron' ? fake : orig.call(this, req, ...rest); };
  try { delete require.cache[require.resolve(path.join(ROOT, 'desktop', 'preload.cjs'))]; require(path.join(ROOT, 'desktop', 'preload.cjs')); } finally { Module._load = orig; }
  return exposed;
}

// --- the Tauri bridge, in a context with a fake window.__TAURI__.
let tCalls = []; let reply = () => null;
function loadBridge(boot, win) {
  const window = win || { __TAURI__: { core: { invoke: (cmd, args) => { tCalls.push({ cmd, args }); return Promise.resolve().then(() => reply(cmd, args)); } } } };
  if (boot) window.__KR_BOOT__ = boot;
  const ctx = vm.createContext({ window, Promise, Object, Array, String, Error, ArrayBuffer, Uint8Array, JSON, TextDecoder, atob, setTimeout });
  vm.runInContext(BRIDGE, ctx, { filename: 'bridge.js' });
  return window;
}
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

async function nodePart() {
  const pre = loadPreload();
  assert.ok(pre, 'preload exposed nothing');
  const win = loadBridge({ os: 'linux', arch: 'x64' });
  const kd = win.kurokawaDesktop; const stubs = win.__KR_BRIDGE_STUBS__;
  assert.ok(kd, 'bridge defined no window.kurokawaDesktop');
  assert.ok(stubs && typeof stubs === 'object', 'bridge lists no stubs');

  // Names: exactly the preload's.
  assert.deepEqual(Object.keys(kd).sort(), Object.keys(pre).sort(), 'bridge names ≠ preload names');
  assert.equal(kd.platform, 'linux');
  for (const k of Object.keys(pre)) assert.equal(typeof kd[k], typeof pre[k], `${k}: ${typeof kd[k]} ≠ ${typeof pre[k]}`);
  const fns = Object.keys(pre).filter((k) => typeof pre[k] === 'function');
  const ported = fns.filter((k) => !(k in stubs));
  for (const k of Object.keys(stubs)) { assert.ok(fns.includes(k), `stub ${k} is no preload function`); assert.match(stubs[k], /^R[2-6]$/, `${k}: stage`); }

  // Arguments: each ported function sends what the preload sends, under the command named after its channel.
  const samples = {
    readFile: ['/x/a.epub'], fileSize: ['/x/a.epub'], readTextFile: ['/x/sync.json'], writeTextFile: ['/x/sync.json', 'نص'],
    writeBinary: ['/x/b.bin', 'AAEC', true], scanDevice: [['epub', 'pdf']], pickFolder: [], archivePickDir: [], archivePickFile: [{ multiple: true }],
    openDefaultApps: [],
  };
  const special = ['http', 'isPortable'];
  assert.deepEqual([...Object.keys(samples), ...special].sort(), [...ported].sort(), 'samples ≠ ported functions');
  const sent = {};
  for (const m of Object.keys(samples)) {
    eCalls = []; tCalls = [];
    await pre[m](...samples[m]); await kd[m](...samples[m]);
    assert.equal(eCalls.length, 1, `${m}: preload calls`); assert.equal(tCalls.length, 1, `${m}: bridge calls`);
    const { ch, a } = eCalls[0]; const { cmd, args } = tCalls[0];
    assert.equal(cmd, snake(ch), `${m}: ${ch} → ${cmd}`);
    assert.deepEqual(JSON.parse(JSON.stringify(Object.values(args))), JSON.parse(JSON.stringify(a)), `${m}: arguments`);
    sent[cmd] = Object.keys(args);
  }
  // isPortable: answered here (this build is never Electron's portable .exe), no IPC.
  tCalls = []; assert.equal(await kd.isPortable(), false); assert.equal(tCalls.length, 0);
  // writeBinary: append is a boolean, as the preload's !!append.
  tCalls = []; await kd.writeBinary('/p', 'AA'); assert.equal(tCalls[0].args.append, false);
  // archivePickFile with nothing: { multiple: false }.
  tCalls = []; await kd.archivePickFile(); assert.deepEqual(JSON.parse(JSON.stringify(tCalls[0].args)), { o: { multiple: false } });

  // http: kr:http's channel, accept-encoding left to the shell, the body always asked for as base64 and made text
  // here in the page's charset (Content-Type, else <meta>, else UTF-8); binary answers passed as they came.
  eCalls = []; tCalls = [];
  const req = { url: 'https://example.org/a', method: 'POST', headers: { 'Accept-Encoding': 'gzip', 'x-a': 'b' }, body: 'eHl6', bodyBase64: true };
  await pre.http(req);
  reply = () => ({ status: 200, url: 'https://example.org/a', headers: { 'content-type': 'text/html; charset=windows-1256' }, body: b64([0xe3, 0xd1, 0xcd, 0xc8, 0xc7]) });
  let r = await kd.http(req);
  assert.equal(snake(eCalls[0].ch), tCalls[0].cmd);
  assert.deepEqual(JSON.parse(JSON.stringify(tCalls[0].args)), { o: { url: 'https://example.org/a', method: 'POST', headers: { 'x-a': 'b' }, binary: true, body: 'eHl6', bodyBase64: true } });
  sent.kr_http = Object.keys(tCalls[0].args);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), { status: 200, headers: { 'content-type': 'text/html; charset=windows-1256' }, body: 'مرحبا', url: 'https://example.org/a' });
  tCalls = [];
  reply = () => ({ status: 200, url: 'u', headers: { 'content-type': 'text/html' }, body: b64([...Buffer.from('<meta charset="windows-1256">'), 0xe3]) });
  assert.equal((await kd.http({ url: 'u' })).body, '<meta charset="windows-1256">م');
  assert.deepEqual(JSON.parse(JSON.stringify(tCalls[0].args)), { o: { url: 'u', method: 'GET', headers: {}, binary: true } });
  reply = () => ({ status: 200, url: 'u', headers: {}, body: b64(Buffer.from('نص ✓')) });
  assert.equal((await kd.http({ url: 'u' })).body, 'نص ✓');
  reply = () => ({ status: 200, url: 'u', headers: { 'content-type': 'text/plain; charset=x-no-such-charset' }, body: b64(Buffer.from('نص')) });
  assert.equal((await kd.http({ url: 'u' })).body, 'نص');
  reply = () => ({ status: 201, url: 'u', headers: { 'content-type': 'text/plain; charset=windows-1256' }, body: 'AAEC' });
  r = await kd.http({ url: 'u', binary: true });
  assert.equal(r.body, 'AAEC'); assert.equal(r.status, 201);

  // Bytes: an ArrayBuffer whatever the IPC handed back.
  for (const form of [new Uint8Array([1, 2, 3]), [1, 2, 3], new Uint8Array([9, 1, 2, 3]).subarray(1), new Uint8Array([1, 2, 3]).buffer]) {
    reply = (cmd) => (cmd === 'kr_read_file' ? form : null);
    const got = await kd.readFile('/x');
    assert.ok(got instanceof ArrayBuffer || Object.prototype.toString.call(got) === '[object ArrayBuffer]', 'readFile: not an ArrayBuffer');
    assert.deepEqual([...new Uint8Array(got)], [1, 2, 3]);
  }
  // Errors: a command's string error becomes an Error with that message.
  reply = () => Promise.reject('boom');
  await assert.rejects(kd.fileSize('/x'), (e) => e instanceof Error && e.message === 'boom');

  // Stubs: never the IPC; each answers as STUBS says (and the way the page copes with — see PORTING.md).
  tCalls = [];
  const want = {
    appIcon: null, titleBar: null, downloadUpdate: 'unsupported', installDownloadedUpdate: false, archiveCancel: undefined, setFullscreen: false, setImmersive: false,
    copyImage: false, openWebView: { passed: false, blocked: false, title: '' }, browserReset: true, browserForget: { cleared: 0 }, notify: false, deleteDownload: false,
  };
  const rejecting = ['installUpdate', 'archiveList', 'archiveExtract', 'archiveCreate', 'archiveTest', 'archiveRestore', 'archiveFree', 'archiveExisting', 'printToPdf', 'browserFetch', 'download'];
  const sync = ['setZoom', 'onOpenFile', 'onUpdateProgress', 'onDownloadProgress', 'onOpenUrl', 'onCommand', 'setProgress'];
  const removers = ['onTitleBarState', 'onArchiveProgress', 'addDownloadListener'];
  assert.deepEqual([...Object.keys(want), ...rejecting, ...sync, ...removers, 'setDoh'].sort(), Object.keys(stubs).sort(), 'every stub is checked');
  for (const [k, v] of Object.entries(want)) assert.deepEqual(JSON.parse(JSON.stringify({ v: await kd[k]() })), JSON.parse(JSON.stringify({ v })), `${k}()`);
  for (const k of rejecting) await assert.rejects(kd[k]({}), (e) => e instanceof Error && new RegExp(`^${k} is not in this preview build yet \\(Tauri stage ${stubs[k]}\\)$`).test(e.message), k);
  for (const k of sync) assert.equal(kd[k](() => undefined), undefined, k);
  for (const k of removers) { const off = kd[k](() => undefined); assert.equal(typeof off, 'function', k); off(); }
  await assert.rejects(kd.appIcon({ set: 'data:image/png;base64,AA' }), /Tauri stage R5/);
  await assert.rejects(kd.appIcon({ set: null }), /Tauri stage R5/);
  assert.deepEqual(JSON.parse(JSON.stringify(await kd.setDoh())), { provider: 'off' });
  assert.deepEqual(JSON.parse(JSON.stringify(await kd.setDoh(null))), { provider: 'off' });
  const tested = await kd.setDoh(null, 'example.com'); assert.equal(tested.ok, false); assert.match(tested.error, /Tauri stage R3/);
  await assert.rejects(kd.setDoh('cloudflare'), /Tauri stage R3/);
  // (A stub's answer is a fresh copy: the page changing one changes no later answer.)
  (await kd.openWebView({})).passed = true; assert.equal((await kd.openWebView({})).passed, false);
  assert.equal(tCalls.length, 0, 'a stub reached the IPC');

  // Without IPC at all: a clear rejection, not a TypeError at load.
  const bare = loadBridge(null, {});
  await assert.rejects(bare.kurokawaDesktop.fileSize('/x'), /IPC/);
  assert.equal(bare.kurokawaDesktop.platform, '');
  // Through __TAURI_INTERNALS__ when window.__TAURI__ is not (yet) there.
  const icalls = [];
  const iwin = loadBridge({ os: 'win32' }, { __TAURI_INTERNALS__: { invoke: (cmd, args) => { icalls.push({ cmd, args }); return Promise.resolve(5); } } });
  assert.equal(await iwin.kurokawaDesktop.fileSize('C:\\a'), 5); assert.deepEqual(JSON.parse(JSON.stringify(icalls)), [{ cmd: 'kr_file_size', args: { p: 'C:\\a' } }]);
  assert.equal(iwin.kurokawaDesktop.platform, 'win32');
  // Loaded twice (a reload keeps none, but an iframe of the same page could): the first stays.
  const again = loadBridge({ os: 'linux' }); const first = again.kurokawaDesktop; vm.runInContext(BRIDGE, vm.createContext({ window: again, Promise, Object, Array, String, Error, ArrayBuffer, Uint8Array, JSON, TextDecoder, atob }));
  assert.equal(again.kurokawaDesktop, first);

  // Rust: every command the bridge and the self-test call is registered, with the argument names they send.
  const src = path.join(TAURI, 'src-tauri', 'src');
  const main = fs.readFileSync(path.join(src, 'main.rs'), 'utf8');
  const registered = [...main.matchAll(/(?:commands|selftest)::(kr_\w+)/g)].map((m) => m[1]);
  const params = {};
  for (const file of ['commands.rs', 'selftest.rs']) {
    const rs = fs.readFileSync(path.join(src, file), 'utf8');
    for (const m of rs.matchAll(/#\[tauri::command\]\s*pub async fn (kr_\w+)\(([^)]*)\)/g)) params[m[1]] = m[2].split(',').map((x) => x.trim()).filter(Boolean).filter((x) => !/:\s*(AppHandle|tauri::Window)$/.test(x)).map((x) => x.split(':')[0].trim());
  }
  assert.deepEqual([...registered].sort(), Object.keys(params).sort(), 'main.rs registers ≠ commands.rs + selftest.rs define');
  for (const [cmd, ks] of Object.entries(sent)) {
    assert.ok(registered.includes(cmd), `${cmd} not registered in main.rs`);
    assert.deepEqual([...ks].sort(), [...params[cmd]].sort(), `${cmd}: bridge sends ${ks}, Rust takes ${params[cmd]}`);
  }
  for (const c of ['kr_folder_pick', 'kr_archive_pick_dir', 'kr_default_apps']) assert.deepEqual(params[c], [], `${c} takes no argument`);
  // (One-word argument names only: Tauri maps a JS key to a snake_case parameter by camelCase, so a two-word name
  // would have to be sent as camelCase — none is used.)
  for (const [cmd, ks] of Object.entries(params)) for (const k of ks) assert.match(k, /^[a-z0-9]+$/, `${cmd}: argument ${k}`);
  const stSrc = fs.readFileSync(path.join(TAURI, 'selftest.js'), 'utf8');
  for (const m of stSrc.matchAll(/invoke\('(kr_\w+)', \{([^}]*)\}/g)) {
    const keys = m[2].split(',').map((x) => x.trim().split(':')[0].trim()).filter(Boolean);
    assert.ok(registered.includes(m[1]), `selftest.js calls ${m[1]}, which main.rs does not register`);
    assert.deepEqual([...keys].sort(), [...params[m[1]]].sort(), `selftest.js: ${m[1]} sends ${keys}, Rust takes ${params[m[1]]}`);
  }

  // The self-test script: inert without its settings; its list of names is the preload's; its verdict; a full run
  // against a fake bridge passes, and fails when one answer is wrong.
  const sw = { addEventListener() { throw new Error('should be inert'); } };
  vm.runInContext(stSrc, vm.createContext({ window: sw, Promise, Object, Array, String, Error, JSON, Uint8Array, Date, setTimeout, clearTimeout, unescape, encodeURIComponent }));
  const lib = sw.__KR_SELFTEST_LIB__;
  assert.ok(lib && typeof lib.run === 'function', 'selftest.js exposes its lib');
  assert.equal(sw.__KR_SELFTEST_STARTED__, undefined);
  assert.deepEqual([...lib.NAMES].sort(), Object.keys(pre).sort(), 'selftest.js NAMES ≠ preload names');
  assert.equal(lib.verdict([]), 1);
  assert.equal(lib.verdict([{ ok: true }, { ok: false, required: false }]), 0);
  assert.equal(lib.verdict([{ ok: true }, { ok: false }]), 1);
  assert.equal(lib.join('C:\\T\\', 'a', 'win32'), 'C:\\T\\a');
  assert.equal(lib.join('/tmp/', 'a', 'linux'), '/tmp/a');
  assert.deepEqual([...lib.utf8('a✓ن')], [...Buffer.from('a✓ن')]);
  assert.ok(lib.sameBytes(new Uint8Array([1, 2]).buffer, [1, 2]) && !lib.sameBytes([1], [1, 2]));
  const cfg = { base: 'http://127.0.0.1:1', temp: '/tmp', home: '/home/u', text: 'T ✓', gzText: 'G', latinText: 'مرحبا بالعالم', binB64: Buffer.from([...Array(256).keys()]).toString('base64'), os: 'linux', version: '0.61.0', minWidth: 420, minHeight: 600 };
  const releases = JSON.parse(fs.readFileSync(path.join(ROOT, '..', '..', 'shared', 'shell-rs', 'src', 'testserver.rs'), 'utf8').match(/pub const RELEASES: &str = r#"([\s\S]*?)"#;/)[1]);
  assert.equal(releases.length, 5, 'testserver.rs RELEASES parses as five releases');
  function fakeKd(bad) {
    const disk = new Map();
    const fake = loadBridge({ os: 'linux' }, { __TAURI__: { core: { invoke: () => Promise.reject('fake') } } }).kurokawaDesktop;
    return Object.assign({}, fake, {
      platform: 'linux',
      writeTextFile: async (p, t) => { disk.set(p, Buffer.from(t)); return true; },
      readTextFile: async (p) => (disk.has(p) ? disk.get(p).toString() : null),
      fileSize: async (p) => (disk.has(p) ? disk.get(p).length : -1),
      readFile: async (p) => { if (!disk.has(p)) throw new Error('ENOENT'); const b = disk.get(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); },
      writeBinary: async (p, s, append) => { const add = Buffer.from(s, 'base64'); disk.set(p, append && disk.has(p) ? Buffer.concat([disk.get(p), add]) : add); return true; },
      scanDevice: async (exts) => ({ root: '/home/u', truncated: false, files: [...disk.keys()].filter((p) => exts.some((e) => p.toLowerCase().endsWith('.' + e.toLowerCase()))).map((p) => ({ path: p, name: path.posix.basename(p), size: disk.get(p).length })) }),
      http: async (o) => {
        const u = o.url.slice(cfg.base.length);
        if (u === '/text' || u === '/redirect') return { status: 200, url: cfg.base + '/text', headers: { 'x-kt-test': '1', 'x-kt-multi': bad ? 'a' : 'a, b' }, body: cfg.text };
        if (u === '/gzip') return { status: 200, url: o.url, headers: {}, body: cfg.gzText };
        if (u === '/bin') return { status: 200, url: o.url, headers: {}, body: cfg.binB64 };
        if (u === '/echo') return { status: 200, url: o.url, headers: {}, body: String(o.method).toUpperCase() + ':' + (o.bodyBase64 ? Buffer.from(o.body, 'base64').toString() : o.body) };
        if (u === '/latin') return { status: 200, url: o.url, headers: {}, body: cfg.latinText };
        if (u === '/meta') return { status: 200, url: o.url, headers: {}, body: '<meta charset="windows-1256">' + cfg.latinText };
        if (u === '/releases') return { status: 200, url: o.url, headers: {}, body: JSON.stringify(releases) };
        return { status: 404, url: o.url, headers: {}, body: '' };
      },
      _disk: disk,
    });
  }
  const doc = { querySelector: (s) => (/library-view/.test(s) ? {} : null), querySelectorAll: (s) => (/rail-item/.test(s) ? [1, 2, 3] : []) };
  for (const bad of [false, true]) {
    const sent2 = []; const kdFake = fakeKd(bad);
    const env = {
      sleep: () => new Promise((ok) => setTimeout(ok, 2)), doc, now: () => Date.now(),
      invoke: (cmd, args) => {
        sent2.push({ cmd, args });
        if (cmd === 'kr_selftest_remove') { kdFake._disk.delete(args.p); return Promise.resolve(true); }
        if (cmd === 'kr_selftest_update') { const v = args.current === '0.62.0' ? null : { version: args.beta ? '0.63.0' : '0.62.0', url: 'https://example.invalid/v0.62.0', notes: 'notes م', asset: lib.ASSET.linux }; return Promise.resolve(v); }
        if (cmd === 'kr_selftest_winstate') return Promise.resolve({ path: '/c/window-state.json', file: { x: 1, y: 2, width: 1180, height: 820, maximized: false }, restored: { x: 1, y: 2, width: 1180, height: 820, maximized: false }, now: { width: 1180, height: 820 } });
        if (cmd === 'kr_selftest_clipboard') return Promise.resolve(args.text);
        return Promise.resolve();
      },
    };
    const res = JSON.parse(JSON.stringify(await lib.run(kdFake, loadBridge({ os: 'linux' }).__KR_BRIDGE_STUBS__, cfg, env)));
    assert.equal(sent2[sent2.length - 1].cmd, 'kr_selftest_done');
    const failed = res.filter((x) => x.required && !x.ok).map((x) => `${x.name}: ${x.detail}`);
    if (!bad) assert.deepEqual(failed, [], 'self-test against a good fake');
    else assert.deepEqual(res.filter((x) => x.required && !x.ok).map((x) => x.name), ['http text + headers']);
    assert.equal(lib.verdict(res), bad ? 1 : 0);
    assert.ok(res.some((x) => x.name === 'scanDevice' && x.ok) && res.some((x) => x.name === 'stubs answer as documented' && x.ok));
    assert.ok(sent2.some((c) => c.cmd === 'kr_selftest_progress'));
    assert.equal(kdFake._disk.size, 0, 'the self-test left files behind');
  }
  console.log(`tauribridge (node): ok — ${fns.length} functions + platform; ${ported.length} ported, ${Object.keys(stubs).length} stubs; ${registered.length} commands`);
  return { ported, stubs: Object.keys(stubs) };
}

// --- in Chromium: the built app with the bridge and a fake Tauri IPC.
const DIST = path.join(ROOT, 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.epub': 'application/epub+zip' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });

async function pagePart(ported) {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('no dist/: run node scripts/build.mjs first');
  const { chromium } = require('playwright');
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch(); const errors = [];
  try {
    const ctx = await br.newContext({ viewport: { width: 1280, height: 860 } }); const p = await ctx.newPage(); p.setDefaultTimeout(15000);
    p.on('pageerror', (e) => errors.push(e.message));
    // (What main.rs puts first: the fake IPC stands for Tauri's own, then the boot line and the bridge.)
    await p.addInitScript(() => {
      try { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); } catch (e) { /* first load */ }
      window.__calls = [];
      const replies = {
        kr_read_file: () => new Uint8Array([1, 2, 3]), kr_file_size: () => 3, kr_folder_read: () => 'text', kr_folder_write: () => true, kr_write_binary: () => true,
        kr_scan_device: () => ({ root: '/home/u', files: [], truncated: false }), kr_folder_pick: () => '/picked', kr_archive_pick_dir: () => '/picked', kr_archive_pick_file: () => ['/a.zip'],
        kr_default_apps: () => null, kr_http: (a) => ({ status: 200, url: a.o.url, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: btoa('ok') }),
      };
      window.__TAURI__ = { core: { invoke: (cmd, args) => { window.__calls.push({ cmd, args: JSON.parse(JSON.stringify(args || {})) }); return replies[cmd] ? Promise.resolve(replies[cmd](args)) : Promise.reject('unknown command ' + cmd); } } };
    });
    await p.addInitScript({ content: `window.__KR_BOOT__ = ${JSON.stringify({ os: 'linux', arch: 'x64' })};\n${BRIDGE}` });
    await p.goto(base + '#/');
    await p.waitForSelector('.library-view');
    await p.waitForSelector('.nav-rail .rail-item');
    const shape = await p.evaluate(() => ({ fns: Object.keys(window.kurokawaDesktop).filter((k) => typeof window.kurokawaDesktop[k] === 'function').length, platform: window.kurokawaDesktop.platform, frameless: document.documentElement.classList.contains('frameless'), bar: !!document.querySelector('.win-titlebar') }));
    assert.equal(shape.fns, 47, 'functions in the page'); assert.equal(shape.platform, 'linux');
    assert.ok(!shape.frameless && !shape.bar, 'the app\'s own title bar should be gone (titleBar answers null: the system frame for now)');
    const startup = await p.evaluate(() => window.__calls.map((c) => c.cmd));
    assert.ok(startup.every((c) => /^kr_/.test(c)), 'startup calls ' + startup);

    // A book: imported from the samples, opened in the reader.
    await p.setInputFiles('input[type=file]', path.join(DIST, 'samples', 'maqamat-al-hariri.epub'));
    await p.waitForSelector('.book-card:not(.folder-card)', { timeout: 30000 });
    // (On a computer the card opens the book's page; «Read» opens the reader — as tests/pcread.cjs does. The first
    // card is «On this device»: the whole-computer scan, there since scanDevice is.)
    assert.ok(await p.$('.book-card.device-card'), 'the «On this device» card (scanDevice) is missing');
    await p.click('.book-card:not(.folder-card)'); await p.waitForSelector('.book-read'); await p.click('.book-read');
    await p.waitForSelector('.reader-flow .kr-content, .reader-flow p', { timeout: 30000 });
    // Settings.
    await p.goto(base + '#/settings'); await p.waitForSelector('.settings-body', { timeout: 15000 }); await p.waitForTimeout(500);

    // Each ported function from the page: the command and the arguments the bridge sends.
    const got = await p.evaluate(async () => {
      const kd = window.kurokawaDesktop; const out = {};
      const runs = {
        readFile: async () => [...new Uint8Array(await kd.readFile('/x/a.epub'))], fileSize: () => kd.fileSize('/x/a.epub'), readTextFile: () => kd.readTextFile('/x/s.json'),
        writeTextFile: () => kd.writeTextFile('/x/s.json', 'نص'), writeBinary: () => kd.writeBinary('/x/b.bin', 'AAEC', true), scanDevice: () => kd.scanDevice(['epub']),
        pickFolder: () => kd.pickFolder(), archivePickDir: () => kd.archivePickDir(), archivePickFile: () => kd.archivePickFile({ multiple: true }), openDefaultApps: () => kd.openDefaultApps(),
        http: async () => (await kd.http({ url: 'https://example.org/', headers: { 'accept-encoding': 'br' } })).body, isPortable: () => kd.isPortable(),
      };
      for (const [k, f] of Object.entries(runs)) { const n = window.__calls.length; const r = await f(); out[k] = { r, calls: window.__calls.slice(n) }; }
      return out;
    });
    assert.deepEqual(Object.keys(got).sort(), [...ported].sort(), 'page checks ≠ ported functions');
    const want = {
      readFile: ['kr_read_file', { p: '/x/a.epub' }, [1, 2, 3]], fileSize: ['kr_file_size', { p: '/x/a.epub' }, 3], readTextFile: ['kr_folder_read', { p: '/x/s.json' }, 'text'],
      writeTextFile: ['kr_folder_write', { p: '/x/s.json', text: 'نص' }, true], writeBinary: ['kr_write_binary', { p: '/x/b.bin', b64: 'AAEC', append: true }, true],
      scanDevice: ['kr_scan_device', { exts: ['epub'] }, { root: '/home/u', files: [], truncated: false }], pickFolder: ['kr_folder_pick', {}, '/picked'], archivePickDir: ['kr_archive_pick_dir', {}, '/picked'],
      archivePickFile: ['kr_archive_pick_file', { o: { multiple: true } }, ['/a.zip']], openDefaultApps: ['kr_default_apps', {}, null],
      http: ['kr_http', { o: { url: 'https://example.org/', method: 'GET', headers: {}, binary: true } }, 'ok'],
    };
    for (const [k, [cmd, args, r]] of Object.entries(want)) {
      assert.equal(got[k].calls.length, 1, `${k}: one call`);
      assert.equal(got[k].calls[0].cmd, cmd, `${k}: command`);
      assert.deepEqual(got[k].calls[0].args, args, `${k}: arguments`);
      assert.deepEqual(got[k].r, r, `${k}: answer`);
    }
    assert.equal(got.isPortable.r, false); assert.equal(got.isPortable.calls.length, 0);
    assert.deepEqual(errors, [], 'page errors');
    await ctx.close();
    console.log('tauribridge (page): ok — library, a book in the reader, settings; ' + Object.keys(want).length + ' ported calls checked from the page');
  } finally { await br.close(); web.close(); }
}

(async () => {
  const { ported } = await nodePart();
  if (process.argv.includes('--node-only')) return;
  await pagePart(ported);
})().catch((e) => { console.error(e); process.exit(1); });
