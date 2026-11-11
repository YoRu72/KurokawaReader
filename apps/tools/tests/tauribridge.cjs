// The Tauri shell's bridge (desktop-tauri/bridge.js) against the Electron one (desktop/preload.cjs): the ported
// methods have the same names and send the same arguments (kt:xyz → the command kt_xyz), nothing outside the slice
// is there, bytes come back as an ArrayBuffer, errors as Errors, the kt:tasks / kt:engineState events reach onTasks
// and the kt:engine-state DOM event; every command the bridge calls is registered in main.rs with the argument names
// the bridge sends; and the self-test script (desktop-tauri/selftest.js) is inert without its settings and passes /
// fails as it should against a fake bridge. Plain node.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const SLICE = ['retryEngine', 'add', 'pause', 'resume', 'remove', 'setFiles', 'setUrl', 'move', 'setLimits', 'configure', 'torrentInfo', 'rename', 'list', 'defaultDir', 'roots', 'listDir', 'pathInfo', 'exists', 'siblings', 'readFile', 'writeText', 'writeTemp', 'writeTempBytes', 'removeFile', 'hashFile', 'openPath', 'openExternal', 'open', 'pickDir', 'pickFile', 'saveText', 'clipboardText', 'http', 'checkUpdate'];
const BOOT = ['platform', 'available', 'reason', 'os', 'ready', 'onTasks'];
const snake = (ch) => ch.replace(/^kt:/, 'kt_').replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

// --- Electron's preload, with a fake electron that records each invoke.
let eCalls = [];
function loadPreload() {
  let exposed = null;
  const fake = {
    contextBridge: { exposeInMainWorld: (_n, o) => { exposed = o; } },
    ipcRenderer: { invoke: (ch, ...a) => { eCalls.push({ ch, a }); return Promise.resolve(ch === 'kt:state' ? {} : null); }, on() {}, removeListener() {} },
  };
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'electron' ? fake : orig.call(this, req, ...rest); };
  global.window = { dispatchEvent() {}, addEventListener() {} };
  try { require(path.join(ROOT, 'desktop', 'preload.cjs')); } finally { Module._load = orig; }
  return exposed;
}

// --- the Tauri bridge, in a context with a fake window.__TAURI__.
let tCalls = []; let reply = () => null; let listeners = {}; let dispatched = [];
class FakeCustomEvent { constructor(type, o) { this.type = type; this.detail = o && o.detail; } }
function loadBridge(boot) {
  const window = {
    __TAURI__: {
      core: { invoke: (cmd, args) => { tCalls.push({ cmd, args }); return Promise.resolve().then(() => reply(cmd, args)); } },
      event: { listen: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); return Promise.resolve(() => { listeners[name] = listeners[name].filter((f) => f !== fn); }); } },
    },
    dispatchEvent: (e) => { dispatched.push(e.type); return true; },
  };
  if (boot) window.__KT_BOOT__ = boot;
  const ctx = vm.createContext({ window, Promise, Object, Array, String, Error, ArrayBuffer, Uint8Array, JSON, CustomEvent: FakeCustomEvent });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'desktop-tauri', 'bridge.js'), 'utf8'), ctx, { filename: 'bridge.js' });
  return window;
}

(async () => {
  const pre = loadPreload();
  assert.ok(pre, 'preload exposed nothing');
  const win = loadBridge({ os: 'linux', arch: 'x64' });
  const kt = win.kurokawaTools;
  assert.ok(kt, 'bridge defined no window.kurokawaTools');

  // Names: the slice and the boot-safe ones, every one of them a name the preload has; nothing else.
  const keys = Object.keys(kt).sort();
  assert.deepEqual(keys, [...new Set([...SLICE, ...BOOT])].sort(), 'bridge methods ≠ slice + boot-safe');
  for (const k of keys) assert.ok(k in pre, `${k} is not in preload.cjs`);
  assert.equal(kt.platform, 'desktop');
  assert.equal(kt.available, false);
  assert.equal(kt.reason, '');
  assert.equal(kt.os, 'linux');
  for (const k of ['dohProbe', 'titleBar', 'installUpdate', 'streamUrl', 'streamDone', 'mini', 'screenStatus', 'onTitleBarState', 'megaDecrypt', 'deletePath', 'fontIndex', 'videoInfo']) assert.ok(!(k in kt), `${k} should be absent`);

  // Arguments: each slice method sends what the preload sends, under the command named after its channel.
  const samples = {
    retryEngine: [], add: [{ source: { url: 'https://x.org/a.bin', headers: { Referer: 'https://x.org/' } }, dir: '/d', name: 'a.bin', connections: 4, meta: { title: 'A' } }], pause: ['t1'], resume: ['t1'], remove: ['t1', true],
    setFiles: ['t1', [1, 0, 2]], setUrl: ['t1', 'https://x.org/b.bin'], move: ['t1', -1], setLimits: [{ down: 1048576, up: 0 }], configure: [{ maxConnections: 8, seed: false }],
    torrentInfo: [{ magnet: 'magnet:?xt=urn:btih:abc' }], rename: [{ id: 't1', name: 'b.mkv' }],
    list: [], defaultDir: [], roots: [], listDir: ['/x'], pathInfo: ['/x/a.mkv'], exists: [['/a', '/b']], siblings: ['/x/a.mkv'], readFile: ['/x/a.ass'],
    writeText: [{ path: '/x/a.ass', text: 'نص' }], writeTemp: ['a.ass', 'text'], writeTempBytes: [{ name: 'f.ttf', b64: 'AAEC', sub: 'fonts' }], removeFile: ['/x/a'],
    hashFile: ['/x/a'], openPath: ['/x/a'], openExternal: ['https://example.org/'], open: ['t1', -1], pickDir: [], pickFile: [{ multiple: true, filters: [{ name: 'Subs', extensions: ['ass', 'srt'] }] }],
    saveText: [{ name: 'a.txt', text: 't' }], clipboardText: [], http: [{ url: 'https://example.org/', method: 'POST', headers: { a: 'b' }, body: 'x', binary: true }], checkUpdate: [{ beta: false }],
  };
  assert.deepEqual(Object.keys(samples).sort(), [...SLICE].sort());
  const sent = {};
  for (const m of SLICE) {
    eCalls = []; tCalls = [];
    await pre[m](...samples[m]); await kt[m](...samples[m]).catch(() => undefined);
    tCalls = tCalls.filter((c) => c.cmd !== 'kt_state');
    assert.equal(eCalls.length, 1, `${m}: preload calls`); assert.equal(tCalls.length, 1, `${m}: bridge calls`);
    const { ch, a } = eCalls[0]; const { cmd, args } = tCalls[0];
    assert.equal(cmd, snake(ch), `${m}: ${ch} → ${cmd}`);
    assert.deepEqual(JSON.parse(JSON.stringify(Object.values(args))), JSON.parse(JSON.stringify(a)), `${m}: arguments`);
    sent[cmd] = Object.keys(args);
  }

  // Bytes: an ArrayBuffer whatever the IPC handed back.
  for (const form of [new Uint8Array([1, 2, 3]), [1, 2, 3], new Uint8Array([9, 1, 2, 3]).subarray(1), new Uint8Array([1, 2, 3]).buffer]) {
    reply = (cmd) => (cmd === 'kt_read_file' ? form : null);
    const r = await kt.readFile('/x');
    assert.ok(r instanceof ArrayBuffer || Object.prototype.toString.call(r) === '[object ArrayBuffer]', 'readFile: not an ArrayBuffer');
    assert.deepEqual([...new Uint8Array(r)], [1, 2, 3]);
  }
  // Errors: a command's string error becomes an Error with that message.
  reply = () => Promise.reject('boom');
  await assert.rejects(kt.pathInfo('/x'), (e) => e instanceof Error && e.message === 'boom');
  // State: ready() asks once and merges (the event listeners' catch-up may ask once more).
  reply = (cmd) => (cmd === 'kt_state' ? { available: false, reason: 'R', os: 'win32', arch: 'x64' } : cmd === 'kt_list' ? [] : null);
  const fresh = loadBridge({ os: 'linux', arch: 'x64' }).kurokawaTools;
  listeners = {}; tCalls = [];
  await fresh.ready(); await fresh.ready();
  assert.equal(tCalls.filter((c) => c.cmd === 'kt_state').length <= 2, true);
  assert.equal(fresh.os, 'win32'); assert.equal(fresh.reason, 'R');
  // Events: kt:tasks to every onTasks callback (after the asked list) until unsubscribed; listened to once.
  const seen = [];
  const off = fresh.onTasks((l) => seen.push(JSON.parse(JSON.stringify(l))));
  assert.equal(typeof off, 'function');
  fresh.onTasks(() => undefined);
  await new Promise((ok) => setTimeout(ok, 10));
  assert.equal((listeners['kt:tasks'] || []).length, 1, 'kt:tasks listened to once');
  assert.equal((listeners['kt:engineState'] || []).length, 1, 'kt:engineState listened to once');
  assert.deepEqual(seen, [[]]);
  listeners['kt:tasks'][0]({ event: 'kt:tasks', payload: [{ id: 'g1', state: 'downloading' }] });
  assert.deepEqual(seen, [[], [{ id: 'g1', state: 'downloading' }]]);
  off();
  listeners['kt:tasks'][0]({ event: 'kt:tasks', payload: [] });
  assert.equal(seen.length, 2, 'unsubscribed');
  // kt:engineState: the state merged and the page told with the kt:engine-state DOM event, as the preload does.
  dispatched = [];
  listeners['kt:engineState'][0]({ event: 'kt:engineState', payload: { available: true, reason: '', os: 'win32', arch: 'x64' } });
  assert.equal(fresh.available, true); assert.equal(fresh.reason, '');
  assert.deepEqual(dispatched, ['kt:engine-state']);
  // retryEngine: the state it answers merged, and the page told.
  dispatched = []; reply = (cmd) => (cmd === 'kt_engine_retry' ? { available: false, reason: 'aria2c missing', os: 'win32', arch: 'x64' } : null);
  await fresh.retryEngine();
  assert.equal(fresh.available, false); assert.equal(fresh.reason, 'aria2c missing'); assert.deepEqual(dispatched, ['kt:engine-state']);
  // Without window.__TAURI__.event: the event plugin's own listen command, through __TAURI_INTERNALS__.
  const icalls = [];
  const iwin = { __TAURI_INTERNALS__: { invoke: (cmd, args) => { icalls.push({ cmd, args }); return Promise.resolve(cmd === 'kt_list' ? [] : 1); }, transformCallback: (f) => (typeof f === 'function' ? 7 : 0) } };
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'desktop-tauri', 'bridge.js'), 'utf8'), vm.createContext({ window: iwin, Promise, Object, Array, String, Error, ArrayBuffer, Uint8Array, JSON }));
  iwin.kurokawaTools.onTasks(() => undefined);
  await new Promise((ok) => setTimeout(ok, 10));
  const ls = icalls.filter((c) => c.cmd === 'plugin:event|listen').map((c) => c.args);
  assert.deepEqual(ls.map((a) => a.event).sort(), ['kt:engineState', 'kt:tasks']);
  assert.ok(ls.every((a) => a.handler === 7 && a.target && a.target.kind === 'Any'));
  // No IPC at all: a clear rejection, not a TypeError at load.
  const bare = vm.createContext({ window: {}, Promise, Object, Array, String, Error, ArrayBuffer, Uint8Array });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'desktop-tauri', 'bridge.js'), 'utf8'), bare);
  await assert.rejects(bare.window.kurokawaTools.list(), /IPC/);

  // Rust: every command the bridge calls is registered, with the argument names the bridge sends.
  const src = path.join(ROOT, 'desktop-tauri', 'src-tauri', 'src');
  const main = fs.readFileSync(path.join(src, 'main.rs'), 'utf8');
  const registered = [...main.matchAll(/commands::(kt_\w+)/g)].map((m) => m[1]);
  const cmds = fs.readFileSync(path.join(src, 'commands.rs'), 'utf8');
  const params = {};
  for (const m of cmds.matchAll(/#\[tauri::command\]\s*pub async fn (kt_\w+)\(([^)]*)\)/g)) params[m[1]] = m[2].split(',').map((x) => x.trim()).filter(Boolean).filter((x) => !/:\s*AppHandle$/.test(x)).map((x) => x.split(':')[0].trim());
  assert.deepEqual([...registered].sort(), Object.keys(params).sort(), 'main.rs registers ≠ commands.rs defines');
  sent.kt_state = []; sent.kt_list = sent.kt_list || [];
  for (const [cmd, ks] of Object.entries(sent)) {
    assert.ok(registered.includes(cmd), `${cmd} not registered in main.rs`);
    assert.deepEqual([...ks].sort(), [...params[cmd]].sort(), `${cmd}: bridge sends ${ks}, Rust takes ${params[cmd]}`);
  }
  // The self-test script: inert without its settings; its verdict; a full run against a fake bridge passes, and fails
  // when one answer is wrong.
  const stSrc = fs.readFileSync(path.join(ROOT, 'desktop-tauri', 'selftest.js'), 'utf8');
  const sw = { addEventListener() { throw new Error('should be inert'); } };
  vm.runInContext(stSrc, vm.createContext({ window: sw, Promise, Object, Array, String, Error, JSON, Uint8Array, Date, setTimeout, clearTimeout }));
  const lib = sw.__KT_SELFTEST_LIB__;
  assert.ok(lib && typeof lib.run === 'function', 'selftest.js exposes its lib');
  assert.equal(sw.__KT_SELFTEST_STARTED__, undefined);
  assert.equal(lib.verdict([]), 1);
  assert.equal(lib.verdict([{ ok: true }, { ok: false, required: false }]), 0);
  assert.equal(lib.verdict([{ ok: true }, { ok: false }]), 1);
  assert.equal(lib.join('C:\\T\\', 'a', 'win32'), 'C:\\T\\a');
  assert.equal(lib.join('/tmp/', 'a', 'linux'), '/tmp/a');
  assert.ok(lib.sameBytes(new Uint8Array([1, 2]).buffer, [1, 2]) && !lib.sameBytes([1], [1, 2]));
  const crypto = require('node:crypto');
  const cfg = { base: 'http://127.0.0.1:1', temp: '/tmp', aria2Bin: '/r/aria2/linux-x64/aria2c', aria2Bundled: true, wantBundled: true, text: 'T ✓', gzText: 'G', binB64: Buffer.from([...Array(256).keys()]).toString('base64'), bigSize: 2097152, bigSha256: 'ab', os: 'linux' };
  for (const k of ['md5', 'sha1', 'sha256']) assert.equal(lib.ABC[k], crypto.createHash(k).update('abc').digest('hex'), `known ${k} of abc`);
  function fakeKt(bad) {
    let subs = []; let task = null;
    const push = () => subs.forEach((f) => f(task ? [JSON.parse(JSON.stringify(task))] : []));
    const later = (f) => setTimeout(f, 5);
    return {
      platform: 'desktop', available: false, reason: '', os: 'linux',
      ready: async () => ({ os: 'linux', arch: 'x64', available: false }), async retryEngine() { this.available = true; },
      roots: async () => ({ roots: ['/d'] }), defaultDir: async () => '/d/Kurokawa', listDir: async () => ({ exists: true, entries: [] }),
      writeTemp: async () => '/tmp/kt-selftest.txt', pathInfo: async () => ({ exists: true, dir: false, size: 3 }),
      readFile: async (p) => (p.endsWith('.txt') ? new Uint8Array([97, 98, 99]).buffer : new Uint8Array([0, 1, 2, 255]).buffer),
      writeTempBytes: async () => '/tmp/kt-selftest/kt-selftest.bin',
      hashFile: async (p) => (p.endsWith('.txt') ? { ...lib.ABC, size: 3 } : { sha256: cfg.bigSha256, size: cfg.bigSize }),
      removeFile: async () => undefined, exists: async (ps) => ps.map((p) => p.includes('renamed')),
      http: async (o) => {
        const u = o.url.slice(cfg.base.length);
        if (u === '/text' || u === '/redirect') return { status: 200, url: cfg.base + '/text', headers: { 'x-kt-test': '1', 'x-kt-multi': bad ? 'a' : 'a, b' }, body: cfg.text };
        if (u === '/gzip') return { status: 200, url: o.url, headers: {}, body: cfg.gzText };
        if (u === '/bin') return { status: 200, url: o.url, headers: {}, body: cfg.binB64 };
        if (u === '/echo') return { status: 200, url: o.url, headers: {}, body: String(o.method).toUpperCase() + ':' + o.body };
        return { status: 404, url: o.url, headers: {}, body: '' };
      },
      clipboardText: async () => '',
      onTasks(cb) { subs.push(cb); cb([]); return () => { subs = subs.filter((f) => f !== cb); }; },
      setLimits: async () => undefined,
      add: async (o) => { task = { id: 'g1', kind: 'http', engine: 'native', state: 'downloading', done: 100, total: cfg.bigSize, name: o.name, dir: o.dir, files: [{ path: o.name }], source: o.source, addedAt: 1 }; later(push); setTimeout(push, 10); return { ...task }; },
      pause: async () => { task.state = 'paused'; later(push); },
      resume: async () => { Object.assign(task, { state: 'done', done: cfg.bigSize, doneAt: 2 }); later(push); },
      rename: async (o) => { task.name = o.name; task.files[0].path = o.name; return o.name; },
      list: async () => (task ? [JSON.parse(JSON.stringify(task))] : []),
      remove: async () => { task = null; },
    };
  }
  const doc = { querySelector: () => ({ className: 'nav-rail' }), querySelectorAll: () => [1, 2, 3] };
  for (const bad of [false, true]) {
    const sent2 = [];
    const env = { sleep: () => new Promise((ok) => setTimeout(ok, 2)), invoke: (cmd, args) => { sent2.push({ cmd, args }); return Promise.resolve(); }, doc, now: () => Date.now() };
    const res = JSON.parse(JSON.stringify(await lib.run(fakeKt(bad), cfg, env)));
    const last = sent2[sent2.length - 1];
    assert.equal(last.cmd, 'kt_selftest_done');
    const failed = res.filter((r) => r.required && !r.ok).map((r) => `${r.name}: ${r.detail}`);
    if (!bad) assert.deepEqual(failed, [], 'self-test against a good fake');
    else assert.deepEqual(res.filter((r) => r.required && !r.ok).map((r) => r.name), ['http text + headers']);
    assert.equal(lib.verdict(res), bad ? 1 : 0);
    assert.ok(res.some((r) => r.name === 'remove' && r.ok) && res.some((r) => r.name === 'kt:tasks events' && r.ok));
    assert.ok(sent2.some((c) => c.cmd === 'kt_selftest_progress'));
  }

  console.log(`tauribridge: ok (${SLICE.length} slice methods, ${BOOT.length} boot-safe, ${registered.length} commands)`);
})().catch((e) => { console.error(e); process.exit(1); });
