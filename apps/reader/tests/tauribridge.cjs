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
// (Electron's app:titleBar — the channel both apps' shells share — is the Reader's kr_title_bar.)
const snake = (ch) => (ch === 'app:titleBar' ? 'kr_title_bar' : ch.replace(/^kr:/, 'kr_').replace(/-/g, '_'));

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
  const kd = win.kurokawaDesktop; const stubs = win.__KR_BRIDGE_STUBS__; const leftOut = win.__KR_BRIDGE_LEFT_OUT__; const extra = win.__KR_BRIDGE_EXTRA__;
  assert.ok(kd, 'bridge defined no window.kurokawaDesktop');
  assert.ok(stubs && typeof stubs === 'object', 'bridge lists no stubs');
  assert.ok(leftOut && typeof leftOut === 'object', 'bridge lists no left-out names');

  // Names: the preload's, less those left out until their stage (the page then takes its own way: see bridge.js),
  // and this shell's extras (EXTRA: scanFolder, cancelDownload), which Electron's has not.
  assert.deepEqual([...extra], ['scanFolder', 'cancelDownload'], 'the bridge\'s extras');
  for (const k of extra) assert.ok(!(k in pre), `extra ${k} is a preload name`);
  const want = Object.keys(pre).filter((k) => !(k in leftOut));
  assert.deepEqual(Object.keys(kd).sort(), [...want, ...extra].sort(), 'bridge names ≠ preload names less the left-out ones, and the extras');
  assert.equal(kd.platform, 'linux');
  for (const k of want) assert.equal(typeof kd[k], typeof pre[k], `${k}: ${typeof kd[k]} ≠ ${typeof pre[k]}`);
  const fns = Object.keys(pre).filter((k) => typeof pre[k] === 'function');
  const ported = fns.filter((k) => !(k in stubs) && !(k in leftOut));
  for (const k of Object.keys(stubs)) { assert.ok(fns.includes(k), `stub ${k} is no preload function`); assert.match(stubs[k], /^R[2-6]$/, `${k}: stage`); assert.ok(!(k in leftOut), `${k} both a stub and left out`); }
  for (const k of Object.keys(leftOut)) { assert.ok(fns.includes(k), `left-out ${k} is no preload function`); assert.match(leftOut[k], /^R[2-6]$/, `${k}: stage`); }
  // (Left out only where the page tests for the name before using it — never one it calls straight away.)
  for (const k of ['onOpenFile']) assert.ok(!(k in leftOut), `${k} is called by the page without a test: it cannot be left out`);
  for (const k of ['onOpenFile', 'onOpenUrl']) assert.ok(!(k in stubs), `${k} is ported (R2), not a stub`);

  // Arguments: each ported function sends what the preload sends, under the command named after its channel.
  const samples = {
    readFile: ['/x/a.epub'], fileSize: ['/x/a.epub'], readTextFile: ['/x/sync.json'], writeTextFile: ['/x/sync.json', 'نص'],
    writeBinary: ['/x/b.bin', 'AAEC', true], scanDevice: [['epub', 'pdf']], pickFolder: [], archivePickDir: [], archivePickFile: [{ multiple: true }],
    openDefaultApps: [], titleBar: [{ act: 'minimize' }],
    // (Stage R3.)
    download: ['https://example.org/a b.epub', 'a b.epub', 'dl-1'], deleteDownload: ['/data/downloads/a.epub'], setDoh: ['cloudflare', 'example.com'], notify: [{ title: 'T', body: 'B', hash: '/read/1' }],
  };
  const special = ['http', 'isPortable', 'onTitleBarState', 'onOpenFile', 'onOpenUrl', 'onDownloadProgress', 'addDownloadListener'];
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
  // titleBar with nothing: { o: {} } (the state asked for).
  tCalls = []; await kd.titleBar(); assert.deepEqual(JSON.parse(JSON.stringify(tCalls[0].args)), { o: {} });
  // onTitleBarState: the kr:titleBarState event's payloads to the callback, through Tauri's event API; its remover
  // ends the listening (also when it was set up after); without the event API, a remover alone.
  {
    const heard = []; let unlistened = 0; const listeners = [];
    const ew = loadBridge({ os: 'win32' }, { __TAURI__: { core: { invoke: () => Promise.resolve(null) }, event: { listen: (n, f) => { listeners.push([n, f]); return Promise.resolve(() => { unlistened++; }); } } } });
    const off = ew.kurokawaDesktop.onTitleBarState((st) => heard.push(st));
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(listeners.length, 1); assert.equal(listeners[0][0], 'kr:titleBarState');
    listeners[0][1]({ event: 'kr:titleBarState', payload: { maximized: true } });
    assert.deepEqual(JSON.parse(JSON.stringify(heard)), [{ maximized: true }]);
    off(); assert.equal(unlistened, 1);
    listeners[0][1]({ payload: { maximized: false } }); assert.equal(heard.length, 1, 'heard after the remover');
    const off2 = ew.kurokawaDesktop.onTitleBarState(() => {}); off2(); await new Promise((r) => setTimeout(r, 5)); assert.equal(unlistened, 2, 'a remover called before the listening was set up');
    const none = kd.onTitleBarState(() => {}); assert.equal(typeof none, 'function'); none();
    assert.equal(win.__KR_SHELL__, 'tauri', 'the bridge marks the Tauri shell');
  }
  // onOpenFile / onOpenUrl (R2): what the shell keeps is taken at once (kr_open_take, kind file / url) and again on
  // each kr:openPending event; each file's bytes read by path (kr_read_file) and handed over as main.cjs's
  // kr:open-file payload, { name, data: ArrayBuffer }; links as their text; a take that fails is quiet; each noted in
  // __KR_OPEN_LOG__. Without the event API, the first take alone.
  {
    const queue = { file: [{ name: 'a ✓.epub', path: '/x/a ✓.epub' }], url: ['kurokawareader://open?to=%2F'] }; const sent3 = []; const listeners = [];
    const ow = loadBridge({ os: 'linux' }, { __TAURI__: {
      core: { invoke: (cmd, args) => { sent3.push({ cmd, args: JSON.parse(JSON.stringify(args)) }); if (cmd === 'kr_open_take') { const l = queue[args.kind]; queue[args.kind] = []; return Promise.resolve(l); } if (cmd === 'kr_read_file') return Promise.resolve(args.p.includes('bad') ? Promise.reject('ENOENT') : new Uint8Array([7, 8, 9])); return Promise.resolve(null); } },
      event: { listen: (n, f) => { listeners.push([n, f]); return Promise.resolve(() => {}); } },
    } });
    const files = []; const links = [];
    assert.equal(ow.kurokawaDesktop.onOpenFile((p) => files.push(p)), undefined);
    assert.equal(ow.kurokawaDesktop.onOpenUrl((u) => links.push(u)), undefined);
    const settle = () => new Promise((r) => setTimeout(r, 20));
    await settle();
    assert.deepEqual(listeners.map((l) => l[0]), ['kr:openPending', 'kr:openPending']);
    assert.equal(files.length, 1); assert.equal(files[0].name, 'a ✓.epub');
    assert.ok(Object.prototype.toString.call(files[0].data) === '[object ArrayBuffer]'); assert.deepEqual([...new Uint8Array(files[0].data)], [7, 8, 9]);
    assert.deepEqual(links, ['kurokawareader://open?to=%2F']);
    assert.deepEqual(sent3.filter((c) => c.cmd === 'kr_open_take').map((c) => c.args.kind).sort(), ['file', 'url']);
    assert.deepEqual(sent3.find((c) => c.cmd === 'kr_read_file').args, { p: '/x/a ✓.epub' });
    // (A second launch's file: the event → taken again; a file that cannot be read is noted, not handed over.)
    queue.file = [{ name: 'b.pdf', path: '/x/b.pdf' }, { name: 'bad.pdf', path: '/x/bad.pdf' }];
    listeners.forEach((l) => l[1]({ event: 'kr:openPending', payload: {} }));
    await settle();
    assert.deepEqual(files.map((f) => f.name), ['a ✓.epub', 'b.pdf']);
    const byText = (l) => l.map((x) => JSON.stringify(x)).sort();
    assert.deepEqual(byText(JSON.parse(JSON.stringify(ow.__KR_OPEN_LOG__))), byText([{ kind: 'file', name: 'a ✓.epub', size: 3 }, { kind: 'url', url: 'kurokawareader://open?to=%2F' }, { kind: 'file', name: 'b.pdf', size: 3 }, { kind: 'file', name: 'bad.pdf', error: 'ENOENT' }]));
    // (No shell: quiet.)
    const quiet = loadBridge({ os: 'linux' }, { __TAURI__: { core: { invoke: () => Promise.reject('no') } } });
    assert.equal(quiet.kurokawaDesktop.onOpenFile(() => { throw new Error('called'); }), undefined); await settle();
    assert.equal(quiet.kurokawaDesktop.onOpenFile(), undefined);
    for (const k of ['onOpenFile', 'onOpenUrl']) { eCalls = []; pre[k](() => {}); assert.ok(eCalls.every((c) => c.ch === 'kr:ready'), `${k}: preload channels`); }
    sent.kr_open_take = ['kind'];
  }
  // Stage R3: setDoh's two forms (a provider kept; null and a host to try), download without an id, cancelDownload
  // (EXTRA) → kr_download_cancel { id }.
  for (const [a, want] of [[[null], { provider: null, test: null }], [[undefined, 'example.com'], { provider: null, test: 'example.com' }], [['off'], { provider: 'off', test: null }]]) { tCalls = []; await kd.setDoh(...a); assert.deepEqual(JSON.parse(JSON.stringify(tCalls[0].args)), want, 'setDoh ' + JSON.stringify(a)); }
  tCalls = []; await kd.download('u', 'n'); assert.deepEqual(JSON.parse(JSON.stringify(tCalls[0].args)), { url: 'u', name: 'n', id: null });
  tCalls = []; await kd.cancelDownload('dl-1'); assert.deepEqual(JSON.parse(JSON.stringify(tCalls)), [{ cmd: 'kr_download_cancel', args: { id: 'dl-1' } }]); sent.kr_download_cancel = ['id'];
  tCalls = []; await kd.notify(); assert.deepEqual(JSON.parse(JSON.stringify(tCalls[0].args)), { o: {} });
  // onDownloadProgress / addDownloadListener: main.cjs's kr:download-progress to every listener through one Tauri
  // listening; onDownloadProgress first removes them all (the preload's removeAllListeners), addDownloadListener's
  // remover takes away its own; without the event API they are kept and the listening tried again later.
  {
    const listeners = [];
    const dw = loadBridge({ os: 'linux' }, { __TAURI__: { core: { invoke: () => Promise.resolve(null) }, event: { listen: (n, f) => { listeners.push([n, f]); return Promise.resolve(() => {}); } } } });
    const a = []; const b = []; const c = [];
    assert.equal(dw.kurokawaDesktop.onDownloadProgress((p) => a.push(p)), undefined);
    const offB = dw.kurokawaDesktop.addDownloadListener((p) => b.push(p));
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(listeners.map((l) => l[0]), ['kr:download-progress'], 'one listening');
    const fire = (p) => listeners[0][1]({ event: 'kr:download-progress', payload: p });
    fire({ id: 'x', pct: 5 }); assert.equal(a.length, 1); assert.equal(b.length, 1);
    offB(); fire({ id: 'x', pct: 6 }); assert.equal(a.length, 2); assert.equal(b.length, 1, 'heard after its remover');
    dw.kurokawaDesktop.addDownloadListener((p) => b.push(p));
    dw.kurokawaDesktop.onDownloadProgress((p) => c.push(p)); fire({ id: '', pct: 7 });
    assert.deepEqual([a.length, b.length, c.length], [2, 1, 1], 'onDownloadProgress removes every listener first');
    assert.equal(listeners.length, 1, 'still one listening');
    assert.equal(typeof kd.addDownloadListener(() => {}), 'function'); assert.equal(typeof kd.addDownloadListener(), 'function');
    for (const k of ['onDownloadProgress', 'addDownloadListener']) { eCalls = []; pre[k](() => {}); assert.ok(eCalls.length === 0, `${k}: the preload invokes nothing`); }
  }
  // scanFolder (EXTRA): the scan's walk in one folder → kr_scan_folder { p, exts }.
  tCalls = []; reply = () => ({ root: '/r', files: [], truncated: false });
  assert.deepEqual(JSON.parse(JSON.stringify(await kd.scanFolder('/r', ['EPUB', 3]))), { root: '/r', files: [], truncated: false });
  assert.deepEqual(JSON.parse(JSON.stringify(tCalls)), [{ cmd: 'kr_scan_folder', args: { p: '/r', exts: ['EPUB', '3'] } }]);
  sent.kr_scan_folder = ['p', 'exts']; reply = () => null;
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
  const answers = { setImmersive: false, copyImage: false };
  const rejecting = ['installUpdate'];
  const sync = ['setZoom', 'onUpdateProgress', 'onCommand', 'setProgress'];
  const removers = [];
  assert.deepEqual([...Object.keys(answers), ...rejecting, ...sync, ...removers].sort(), Object.keys(stubs).sort(), 'every stub is checked');
  for (const [k, v] of Object.entries(answers)) assert.deepEqual(JSON.parse(JSON.stringify({ v: await kd[k]() })), JSON.parse(JSON.stringify({ v })), `${k}()`);
  for (const k of rejecting) await assert.rejects(kd[k]({}), (e) => e instanceof Error && new RegExp(`^${k} is not in this preview build yet \\(Tauri stage ${stubs[k]}\\)$`).test(e.message), k);
  for (const k of sync) assert.equal(kd[k](() => undefined), undefined, k);
  for (const k of removers) { const off = kd[k](() => undefined); assert.equal(typeof off, 'function', k); off(); }
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
  const registered = [...main.matchAll(/(?:commands|selftest|enginetest|titlebar|openfile)::(kr_\w+)/g)].map((m) => m[1]);
  const params = {};
  for (const file of ['commands.rs', 'selftest.rs', 'enginetest.rs', 'titlebar.rs', 'openfile.rs']) {
    const rs = fs.readFileSync(path.join(src, file), 'utf8');
    for (const m of rs.matchAll(/#\[tauri::command\]\s*pub async fn (kr_\w+)\(([^)]*)\)/g)) params[m[1]] = m[2].split(',').map((x) => x.trim()).filter(Boolean).filter((x) => !/:\s*(AppHandle|tauri::Window)$/.test(x)).map((x) => x.split(':')[0].trim());
  }
  assert.deepEqual([...registered].sort(), Object.keys(params).sort(), 'main.rs registers ≠ commands.rs + selftest.rs + enginetest.rs + titlebar.rs + openfile.rs define');
  // (Stage R2's plugin, registered first, and the files the system hands the app: the launch's own, a Mac's.)
  assert.match(main, /let mut builder = tauri::Builder::default\(\);\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*if openfile::single_instance_possible\(\) \{\s*builder = builder\.plugin\(tauri_plugin_single_instance::init\(/, 'single-instance registered first');
  assert.match(main, /openfile::at_start\(&handle\)/); assert.match(main, /RunEvent::Opened \{ urls \}/);
  const cargo = fs.readFileSync(path.join(TAURI, 'src-tauri', 'Cargo.toml'), 'utf8');
  assert.match(cargo, /^tauri-plugin-single-instance = "2"$/m); assert.match(cargo, /^name = "KurokawaReader"$/m);
  // (The kinds of file the system opens with the app: Electron's list, desktop/package.json's build.fileAssociations.)
  const conf = JSON.parse(fs.readFileSync(path.join(TAURI, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const eAssoc = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8')).build.fileAssociations;
  assert.deepEqual(conf.bundle.fileAssociations.map((a) => [a.ext.join(','), a.name, a.role, a.mimeType || null]), eAssoc.map((a) => [a.ext, a.name, a.role, a.mimeType || null]), 'file associations ≠ Electron\'s');
  assert.deepEqual(conf.plugins['deep-link'].desktop.schemes, ['kurokawareader']);
  // (openargs.rs's DOC_EXT is main.cjs's.)
  const docExt = /const DOC_EXT = \/\\\.\(([^)]*)\)\$\/i/.exec(fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8'))[1];
  const expand = (alt) => alt.split('|').flatMap((x) => (x === 'jpe?g' ? ['jpg', 'jpeg'] : x === 'html?' ? ['html', 'htm'] : x === 'woff2?' ? ['woff', 'woff2'] : [x]));
  const rsExt = [...fs.readFileSync(path.join(src, 'openargs.rs'), 'utf8').match(/pub const DOC_EXT: \[&str; \d+\] = \[([\s\S]*?)\];/)[1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual([...rsExt].sort(), expand(docExt).sort(), 'openargs.rs DOC_EXT ≠ main.cjs DOC_EXT');
  assert.equal(Number(/DOC_EXT: \[&str; (\d+)\]/.exec(fs.readFileSync(path.join(src, 'openargs.rs'), 'utf8'))[1]), rsExt.length);
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
  const bigBytes = Buffer.from([...Array(3000).keys()].map((i) => (i * 7) & 255)); const largeBytes = Buffer.concat([bigBytes, bigBytes]);
  const cfg = { base: 'http://127.0.0.1:1', temp: '/tmp', home: '/home/u', text: 'T ✓', gzText: 'G', latinText: 'مرحبا بالعالم', binB64: Buffer.from([...Array(256).keys()]).toString('base64'), os: 'linux', version: '0.61.0', minWidth: 420, minHeight: 600, bigSize: bigBytes.length, bigCrc: lib.crc32(bigBytes), largeSize: largeBytes.length, largeCrc: lib.crc32(largeBytes), cookie: 'jar-ok', dohHost: 'kr-doh-selftest.test' };
  // (testserver.rs's CRC-32 is the self-test's: «123456789» → CBF43926.)
  assert.equal(lib.crc32(Buffer.from('123456789')), 0xCBF43926); assert.equal(lib.crc32(new Uint8Array([1, 2]).buffer), lib.crc32([1, 2]));
  const releases = JSON.parse(fs.readFileSync(path.join(ROOT, '..', '..', 'shared', 'shell-rs', 'src', 'testserver.rs'), 'utf8').match(/pub const RELEASES: &str = r#"([\s\S]*?)"#;/)[1]);
  assert.equal(releases.length, 5, 'testserver.rs RELEASES parses as five releases');
  function fakeKd(bad) {
    const disk = new Map(); const dirs = new Set();
    const tb = { platform: 'linux', height: 32, own: true, wanted: true, controls: 'own', maximized: false, fullscreen: false, focused: true }; const tbSubs = [];
    const fake = loadBridge({ os: 'linux' }, { __TAURI__: { core: { invoke: () => Promise.reject('fake') } } }).kurokawaDesktop;
    // (Stage R3: a jar, a resolver, the downloads folder and its listeners, as the shell keeps them.)
    const jar = new Map(); let doh = 'off'; let dnsCount = 0; let dls = []; const running = new Map();
    const emit = (p) => dls.slice().forEach((f) => f(p));
    const safe = (n) => String(n).replace(/[\\/:*?"<>|]/g, '_');
    return Object.assign({}, fake, {
      platform: 'linux',
      writeTextFile: async (p, t) => { disk.set(p, Buffer.from(t)); return true; },
      readTextFile: async (p) => (disk.has(p) ? disk.get(p).toString() : null),
      fileSize: async (p) => (disk.has(p) ? disk.get(p).length : -1),
      readFile: async (p) => { if (!disk.has(p)) throw new Error('ENOENT'); const b = disk.get(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); },
      writeBinary: async (p, s, append) => { const add = Buffer.from(s, 'base64'); disk.set(p, append && disk.has(p) ? Buffer.concat([disk.get(p), add]) : add); return true; },
      scanDevice: async (exts) => ({ root: '/home/u', truncated: false, files: [...disk.keys()].filter((p) => exts.some((e) => p.toLowerCase().endsWith('.' + e.toLowerCase()))).map((p) => ({ path: p, name: path.posix.basename(p), size: disk.get(p).length })) }),
      scanFolder: async (root, exts) => { if (!dirs.has(root)) throw new Error('not a folder: ' + root); return { root, truncated: false, files: [...disk.keys()].filter((p) => p.startsWith(root + '/') && exts.some((e) => p.toLowerCase().endsWith('.' + e.toLowerCase()))).map((p) => ({ path: p, name: path.posix.basename(p), size: disk.get(p).length })) }; },
      http: async (o) => {
        if (o.url.startsWith('http://' + cfg.dohHost + ':1/')) { if (!/^http:\/\/127/.test(doh)) throw new Error('dns error: failed to lookup address'); dnsCount++; return { status: 200, url: o.url, headers: {}, body: cfg.text }; }
        const u = o.url.slice(cfg.base.length);
        const hs = {}; for (const [k, v] of Object.entries(o.headers || {})) hs[k.toLowerCase()] = v;
        if (u === '/cookie/set') { jar.set('kr_test', cfg.cookie); return { status: 200, url: o.url, headers: { 'set-cookie': 'kr_test=jar-ok; Path=/, kr_away=1; Path=/elsewhere' }, body: 'set' }; }
        if (u === '/cookie/echo' || u === '/cookie/hop') { if (u === '/cookie/hop') jar.set('kr_hop', '1'); return { status: 200, url: cfg.base + '/cookie/echo', headers: {}, body: [...jar].map(([k, v]) => k + '=' + v).join('; ') || '-' }; }
        if (u === '/chain/12') return { status: 200, url: cfg.base + '/text', headers: {}, body: cfg.text };
        if (u === '/headers') return { status: 200, url: o.url, headers: {}, body: Object.entries({ 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0.0.0', ...hs }).map(([k, v]) => k + ': ' + v + '\n').join('') };
        if (u === '/dns-count') return { status: 200, url: o.url, headers: {}, body: String(dnsCount) };
        if (u === '/text' || u === '/redirect') return { status: 200, url: cfg.base + '/text', headers: { 'x-kt-test': '1', 'x-kt-multi': bad ? 'a' : 'a, b' }, body: cfg.text };
        if (u === '/gzip') return { status: 200, url: o.url, headers: {}, body: cfg.gzText };
        if (u === '/bin') return { status: 200, url: o.url, headers: {}, body: cfg.binB64 };
        if (u === '/echo') return { status: 200, url: o.url, headers: {}, body: String(o.method).toUpperCase() + ':' + (o.bodyBase64 ? Buffer.from(o.body, 'base64').toString() : o.body) };
        if (u === '/latin') return { status: 200, url: o.url, headers: {}, body: cfg.latinText };
        if (u === '/meta') return { status: 200, url: o.url, headers: {}, body: '<meta charset="windows-1256">' + cfg.latinText };
        if (u === '/releases') return { status: 200, url: o.url, headers: {}, body: JSON.stringify(releases) };
        return { status: 404, url: o.url, headers: {}, body: '' };
      },
      titleBar: async (o) => { o = o || {}; if (o.act === 'maximize') { tb.maximized = !tb.maximized; const st = { ...tb }; setTimeout(() => tbSubs.forEach((f) => f(st)), 3); } return { ...tb }; },
      onTitleBarState: (f) => { tbSubs.push(f); return () => { const i = tbSubs.indexOf(f); if (i >= 0) tbSubs.splice(i, 1); }; },
      setDoh: async (provider, test) => { if (provider != null) doh = String(provider); if (!test) return { provider: doh }; return { provider: doh, ok: false, error: 'no such host' }; },
      download: async (url, name, id) => {
        const p = '/data/downloads/' + safe(name); const u = url.slice(cfg.base.length);
        if (!/^\/(big|large)\//.test(u)) throw new Error('HTTP 404');
        const bytes = u.startsWith('/large/') ? largeBytes : bigBytes; const conns = u.startsWith('/large/') ? 6 : 1;
        let stop = false; running.set(id, () => { stop = true; });
        try {
          for (let got = 1000; got <= bytes.length; got += 1000) {
            await new Promise((r) => setTimeout(r, id === 'kr-st-3' ? 20 : 1));
            if (stop) throw new Error('cancelled');
            emit({ id, got, total: bytes.length, pct: Math.round((got / bytes.length) * 100), speed: 1, connections: conns });
            if (id === 'kr-st-3') got = 0;
          }
        } finally { running.delete(id); }
        disk.set(p, bytes); return p;
      },
      cancelDownload: async (id) => { const f = running.get(id); if (f) f(); return !!f; },
      deleteDownload: async (p) => { if (!/^\/data\/downloads\/[^/]+$/.test(p)) return false; return disk.delete(p); },
      onDownloadProgress: (f) => { dls = [f]; },
      addDownloadListener: (f) => { dls.push(f); return () => { dls = dls.filter((x) => x !== f); }; },
      notify: async () => true,
      _disk: disk, _dirs: dirs,
    });
  }
  const doc = { querySelector: (s) => (/library-view/.test(s) ? {} : null), querySelectorAll: (s) => (/rail-item/.test(s) ? [1, 2, 3] : []) };
  for (const bad of [false, true]) {
    const sent2 = []; const kdFake = fakeKd(bad); const openLog = [{ kind: 'file', name: 'kr-open-first.txt', size: 5 }];
    const env = {
      openLog: () => openLog, home: () => {}, inReader: () => true,
      sleep: () => new Promise((ok) => setTimeout(ok, 2)), doc, now: () => Date.now(), leftOut: loadBridge({ os: 'linux' }).__KR_BRIDGE_LEFT_OUT__,
      invoke: (cmd, args) => {
        sent2.push({ cmd, args });
        if (cmd === 'kr_selftest_remove') { kdFake._disk.delete(args.p); return Promise.resolve(true); }
        if (cmd === 'kr_selftest_update') { const v = args.current === '0.62.0' ? null : { version: args.beta ? '0.63.0' : '0.62.0', url: 'https://example.invalid/v0.62.0', notes: 'notes م', asset: lib.ASSET.linux }; return Promise.resolve(v); }
        if (cmd === 'kr_selftest_winstate') return Promise.resolve({ path: '/c/window-state.json', file: { x: 1, y: 2, width: 1180, height: 820, maximized: false }, restored: { x: 1, y: 2, width: 1180, height: 820, maximized: false }, now: { width: 1180, height: 820 } });
        if (cmd === 'kr_selftest_clipboard') return Promise.resolve(args.text);
        if (cmd === 'kr_selftest_mkdir') { for (let d = args.p; d.includes('kr-scanfolder-'); d = path.posix.dirname(d)) kdFake._dirs.add(d); return Promise.resolve(true); }
        if (cmd === 'kr_selftest_rmdir') { for (const d of [...kdFake._dirs]) if (d.startsWith(args.p)) kdFake._dirs.delete(d); return Promise.resolve(true); }
        if (cmd === 'kr_selftest_launch') { const [p, link] = args.args; const b = kdFake._disk.get(p); setTimeout(() => { openLog.push({ kind: 'file', name: path.posix.basename(p), size: b.length }, { kind: 'url', url: link }); }, 5); return Promise.resolve({ code: 0, killed: false, ms: 300, singleInstance: true }); }
        return Promise.resolve();
      },
    };
    const res = JSON.parse(JSON.stringify(await lib.run(kdFake, loadBridge({ os: 'linux' }).__KR_BRIDGE_STUBS__, { ...cfg, openFirst: 'kr-open-first.txt', openFirstSize: 5, openDir: '/runner/temp', noWm: !bad }, env)));
    assert.equal(sent2[sent2.length - 1].cmd, 'kr_selftest_done');
    const failed = res.filter((x) => x.required && !x.ok).map((x) => `${x.name}: ${x.detail}`);
    if (!bad) assert.deepEqual(failed, [], 'self-test against a good fake');
    else assert.deepEqual(res.filter((x) => x.required && !x.ok).map((x) => x.name), ['http text + headers']);
    assert.equal(lib.verdict(res), bad ? 1 : 0);
    assert.ok(res.some((x) => x.name === 'scanDevice' && x.ok) && res.some((x) => x.name === 'stubs answer as documented' && x.ok));
    for (const n of ['open with: the file given at start reaches the page', 'scanFolder: a picked folder walked by path, its file read by path', 'second launch: hands its file and link over, and ends']) assert.ok(res.some((x) => x.name === n && x.ok), n + ': ' + JSON.stringify(res.find((x) => x.name === n)));
    const tbRow = res.find((x) => /^title bar/.test(x.name)); assert.ok(tbRow.ok && (bad ? /toggled/ : /^skipped: no window manager/).test(tbRow.detail), 'title bar row: ' + tbRow.detail);
    assert.equal(kdFake._dirs.size, 0, 'the self-test left folders behind');
    assert.ok(sent2.some((c) => c.cmd === 'kr_selftest_progress'));
    assert.equal(kdFake._disk.size, 0, 'the self-test left files behind');
  }
  console.log(`tauribridge (node): ok — ${fns.length} functions + platform; ${ported.length} ported, ${Object.keys(stubs).length} stubs, ${Object.keys(leftOut).length} left out; ${registered.length} commands`);
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
        kr_read_file: (a) => (a.p === '/x/Opened From Outside.txt' ? new TextEncoder().encode('Opened from outside, a line of text.\n') : new Uint8Array([1, 2, 3])), kr_file_size: () => 3, kr_folder_read: () => 'text', kr_folder_write: () => true, kr_write_binary: () => true,
        kr_scan_device: () => ({ root: '/home/u', files: [], truncated: false }), kr_folder_pick: () => '/picked', kr_archive_pick_dir: () => '/picked', kr_archive_pick_file: () => ['/a.zip'],
        kr_default_apps: () => null, kr_scan_folder: (a) => (a.p === '/picked' ? { root: '/picked', files: [{ path: '/picked/sub/Linked Book.epub', name: 'Linked Book.epub', size: 1234 }], truncated: false } : { root: a.p, files: [], truncated: false }),
        // (What the shell keeps of files and links handed to the app: nothing at first; the test puts some in later.)
        kr_download: (a) => '/data/downloads/' + a.name, kr_delete_download: () => true, kr_set_doh: (a) => ({ provider: a.provider || 'off' }), kr_notify: () => true, kr_download_cancel: () => false,
        kr_open_take: (a) => { const l = window.__openQueue[a.kind] || []; window.__openQueue[a.kind] = []; return l; }, kr_title_bar: (a) => ({ platform: 'linux', height: 32, own: true, wanted: true, controls: 'own', maximized: !!(a.o && a.o.act === 'maximize'), fullscreen: false, focused: true }), kr_http: (a) => ({ status: 200, url: a.o.url, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: btoa('ok') }),
      };
      window.__openQueue = { file: [], url: [] }; window.__listeners = [];
      window.__TAURI__ = {
        core: { invoke: (cmd, args) => { window.__calls.push({ cmd, args: JSON.parse(JSON.stringify(args || {})) }); return replies[cmd] ? Promise.resolve(replies[cmd](args)) : Promise.reject('unknown command ' + cmd); } },
        // (Tauri's event API: the shell's kr:openPending, sent by the test below.)
        event: { listen: (n, f) => { window.__listeners.push([n, f]); return Promise.resolve(() => {}); } },
      };
    });
    await p.addInitScript({ content: `window.__KR_BOOT__ = ${JSON.stringify({ os: 'linux', arch: 'x64' })};\n${BRIDGE}` });
    await p.goto(base + '#/');
    await p.waitForSelector('.library-view');
    await p.waitForSelector('.nav-rail .rail-item');
    const shape = await p.evaluate(() => ({ leftOut: Object.keys(window.__KR_BRIDGE_LEFT_OUT__).length, fns: Object.keys(window.kurokawaDesktop).filter((k) => typeof window.kurokawaDesktop[k] === 'function').length, platform: window.kurokawaDesktop.platform, frameless: document.documentElement.classList.contains('frameless'), bar: !!document.querySelector('.win-titlebar') }));
    assert.equal(shape.fns, 47 - shape.leftOut + 2, 'functions in the page (and the extras scanFolder, cancelDownload)'); assert.equal(shape.leftOut, 18, 'left out'); assert.equal(shape.platform, 'linux');
    const own = await p.evaluate(() => ({ winbar: document.documentElement.classList.contains('winbar'), bar: !!document.querySelector('.kr-winbar'), buttons: document.querySelectorAll('.kr-winbar .wb-btn').length }));
    assert.ok(!shape.frameless && !shape.bar, 'Electron\'s title bar (ui/titlebar.ts) in the Tauri shell');
    assert.ok(own.winbar && own.bar && own.buttons === 3, 'the Tauri shell\'s own title bar (ui/winbar.ts): ' + JSON.stringify(own));
    const startup = await p.evaluate(() => window.__calls.map((c) => c.cmd));
    assert.ok(startup.every((c) => /^kr_/.test(c)), 'startup calls ' + startup);
    // (The page takes what the shell kept at its start — onOpenFile and onOpenUrl, as main.cjs's kr:ready —, and
    // listens for more.)
    const took = await p.evaluate(() => ({ kinds: window.__calls.filter((c) => c.cmd === 'kr_open_take').map((c) => c.args.kind).sort(), listens: window.__listeners.map((l) => l[0]) }));
    assert.deepEqual(took.kinds, ['file', 'url'], 'the page took the kept files and links at start'); assert.deepEqual(took.listens.filter((n) => n === 'kr:openPending').length, 2);

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
        titleBar: async () => (await kd.titleBar({ act: 'maximize' })).maximized, onTitleBarState: () => { const off = kd.onTitleBarState(() => {}); off(); return typeof off; },
        onOpenFile: async () => { window.__openQueue.file = [{ name: 'x.epub', path: '/x/a.epub' }]; let got = null; kd.onOpenFile((f) => { got = { name: f.name, bytes: [...new Uint8Array(f.data)] }; }); for (let i = 0; i < 50 && !got; i++) await new Promise((r) => setTimeout(r, 10)); return got; },
        onOpenUrl: async () => { window.__openQueue.url = ['kurokawareader://x']; let got = null; kd.onOpenUrl((u) => { got = u; }); for (let i = 0; i < 50 && !got; i++) await new Promise((r) => setTimeout(r, 10)); return got; },
        download: () => kd.download('https://example.org/b.epub', 'b.epub', 'd1'), deleteDownload: () => kd.deleteDownload('/data/downloads/b.epub'), setDoh: () => kd.setDoh('quad9'), notify: () => kd.notify({ title: 'T', body: 'B', hash: '/' }),
        onDownloadProgress: () => { let n = 0; kd.onDownloadProgress(() => { n++; }); window.__listeners.filter((l) => l[0] === 'kr:download-progress').forEach((l) => l[1]({ payload: { id: '', pct: 1 } })); return n; },
        addDownloadListener: () => { let n = 0; const off = kd.addDownloadListener(() => { n++; }); window.__listeners.filter((l) => l[0] === 'kr:download-progress').forEach((l) => l[1]({ payload: { id: 'x', pct: 1 } })); off(); return n; },
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
      titleBar: ['kr_title_bar', { o: { act: 'maximize' } }, true],
      download: ['kr_download', { url: 'https://example.org/b.epub', name: 'b.epub', id: 'd1' }, '/data/downloads/b.epub'], deleteDownload: ['kr_delete_download', { p: '/data/downloads/b.epub' }, true],
      setDoh: ['kr_set_doh', { provider: 'quad9', test: null }, { provider: 'quad9' }], notify: ['kr_notify', { o: { title: 'T', body: 'B', hash: '/' } }, true],
    };
    // (onOpenFile / onOpenUrl: a take of their kind — and, for a file, its bytes read by path.)
    assert.deepEqual(got.onOpenFile.calls.map((c) => [c.cmd, c.args]), [['kr_open_take', { kind: 'file' }], ['kr_read_file', { p: '/x/a.epub' }]]);
    assert.deepEqual(got.onOpenFile.r, { name: 'x.epub', bytes: [1, 2, 3] });
    assert.deepEqual(got.onOpenUrl.calls.map((c) => [c.cmd, c.args]), [['kr_open_take', { kind: 'url' }]]);
    assert.equal(got.onOpenUrl.r, 'kurokawareader://x');
    for (const [k, [cmd, args, r]] of Object.entries(want)) {
      assert.equal(got[k].calls.length, 1, `${k}: one call`);
      assert.equal(got[k].calls[0].cmd, cmd, `${k}: command`);
      assert.deepEqual(got[k].calls[0].args, args, `${k}: arguments`);
      assert.deepEqual(got[k].r, r, `${k}: answer`);
    }
    assert.equal(got.isPortable.r, false); assert.equal(got.isPortable.calls.length, 0);
    assert.equal(got.onTitleBarState.r, 'function'); assert.equal(got.onTitleBarState.calls.length, 0);
    for (const k of ['onDownloadProgress', 'addDownloadListener']) { assert.equal(got[k].r, 1, `${k}: heard the event`); assert.equal(got[k].calls.length, 0, `${k}: no command`); }
    // (Stage R3: Settings shows the DNS-over-HTTPS choice here without an in-app browser, with this shell's hint.)
    await p.goto(base + '#/settings'); await p.waitForSelector('.settings-body');
    const dohHint = await p.evaluate(async () => { for (let i = 0; i < 50; i++) { const h = [...document.querySelectorAll('.settings-body .hint')].map((x) => x.textContent).find((x) => /app’s own requests/.test(x)); if (h) return h; await new Promise((r) => setTimeout(r, 100)); } return null; });
    assert.ok(dohHint, 'the DNS-over-HTTPS section (with the Tauri hint) is not in Settings');
    // scanFolder (the extra): kr_scan_folder { p, exts }.
    const sf = await p.evaluate(async () => { const n = window.__calls.length; const r = await window.kurokawaDesktop.scanFolder('/books', ['epub']); return { r, calls: window.__calls.slice(n) }; });
    assert.deepEqual(sf, { r: { root: '/books', files: [], truncated: false }, calls: [{ cmd: 'kr_scan_folder', args: { p: '/books', exts: ['epub'] } }] });

    // The scan sheet's «Choose folder» (src/ui/scan.ts): the folder dialog (kr_folder_pick), then the shell's walk of
    // it by path (kr_scan_folder) — its books listed, to be linked where they are —, not the web view's picker.
    await p.goto(base + '#/'); await p.waitForSelector('.library-view');
    await p.click('.book-card.device-card'); await p.waitForSelector('.sheet .btn:has-text("Choose folder")');
    await p.waitForTimeout(400);
    let n0 = await p.evaluate(() => window.__calls.length);
    await p.click('.sheet .btn:has-text("Choose folder")');
    await p.waitForSelector('.scan-row:not(.head) .name:has-text("Linked Book.epub")', { timeout: 10000 });
    const pickCalls = await p.evaluate((n) => window.__calls.slice(n).map((c) => [c.cmd, c.args]), n0);
    assert.deepEqual(pickCalls.slice(0, 2), [['kr_folder_pick', {}], ['kr_scan_folder', { p: '/picked', exts: pickCalls[1][1].exts }]], 'Choose folder: ' + JSON.stringify(pickCalls));
    assert.ok(pickCalls[1][1].exts.includes('epub') && pickCalls[1][1].exts.includes('pdf'));
    assert.match(await p.textContent('.sheet .scan-status, .sheet .hint, .sheet') , /picked/);
    await p.keyboard.press('Escape'); await p.waitForTimeout(300);

    // A file handed to the running app (a second launch, «Open with»): the shell keeps it and sends kr:openPending;
    // the page takes it, reads it by path, imports it into the library and opens it in the reader — main.cjs's
    // kr:open-file path, through the page's own onOpenFile (src/native.ts).
    await p.goto(base + '#/'); await p.waitForSelector('.library-view');
    await p.evaluate(() => { window.__openQueue.file = [{ name: 'Opened From Outside.txt', path: '/x/Opened From Outside.txt' }]; window.__listeners.filter((l) => l[0] === 'kr:openPending').forEach((l) => l[1]({ event: 'kr:openPending', payload: {} })); });
    await p.waitForFunction(() => /^#\/read\//.test(location.hash), null, { timeout: 15000 });
    await p.waitForSelector('.reader-flow', { timeout: 15000 });
    const inReader = await p.evaluate(() => document.querySelector('.reader-flow').textContent);
    assert.match(inReader, /Opened from outside, a line of text/, 'the file opened in the reader');
    assert.deepEqual(errors, [], 'page errors');
    await ctx.close();
    console.log('tauribridge (page): ok — library, a book in the reader, settings; ' + (Object.keys(want).length + 2) + ' ported calls and scanFolder checked from the page; a file handed over opened in the reader');
  } finally { await br.close(); web.close(); }
}

(async () => {
  const { ported } = await nodePart();
  if (process.argv.includes('--node-only')) return;
  await pagePart(ported);
})().catch((e) => { console.error(e); process.exit(1); });
