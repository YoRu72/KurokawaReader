// The Tauri shell's bridge (desktop-tauri/bridge.js) against the Electron one (desktop/preload.cjs): the stage-1
// methods have the same names and send the same arguments (kt:xyz → the command kt_xyz), nothing outside the slice
// is there but what the page uses without asking, bytes come back as an ArrayBuffer, errors as Errors; and every
// command the bridge calls is registered in main.rs with the argument names the bridge sends. Plain node.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const SLICE = ['list', 'defaultDir', 'roots', 'listDir', 'pathInfo', 'exists', 'siblings', 'readFile', 'writeText', 'writeTemp', 'writeTempBytes', 'removeFile', 'hashFile', 'openPath', 'openExternal', 'open', 'pickDir', 'pickFile', 'saveText', 'clipboardText', 'http', 'checkUpdate'];
const BOOT = ['platform', 'available', 'reason', 'os', 'ready', 'retryEngine', 'onTasks', 'add', 'pause', 'resume', 'remove', 'setFiles', 'setLimits', 'torrentInfo', 'rename'];
const REFUSING = ['add', 'pause', 'resume', 'remove', 'setFiles', 'setLimits', 'torrentInfo', 'rename'];
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
let tCalls = []; let reply = () => null;
function loadBridge(boot) {
  const window = { __TAURI__: { core: { invoke: (cmd, args) => { tCalls.push({ cmd, args }); return Promise.resolve().then(() => reply(cmd, args)); } } } };
  if (boot) window.__KT_BOOT__ = boot;
  const ctx = vm.createContext({ window, Promise, Object, Array, String, Error, ArrayBuffer, Uint8Array, JSON });
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
  assert.match(kt.reason, /not in this preview build/);
  assert.equal(kt.os, 'linux');
  for (const k of ['dohProbe', 'titleBar', 'installUpdate', 'configure', 'streamUrl', 'mini', 'screenStatus', 'onTitleBarState']) assert.ok(!(k in kt), `${k} should be absent`);

  // Arguments: each slice method sends what the preload sends, under the command named after its channel.
  const samples = {
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
  // The engine: refusing, plainly.
  for (const m of REFUSING) await assert.rejects(kt[m]('x'), /not in this preview build/);
  // State: ready() asks once and merges; onTasks hands the (empty) list and gives an unsubscribe.
  reply = (cmd) => (cmd === 'kt_state' ? { available: false, reason: 'R', os: 'win32', arch: 'x64' } : cmd === 'kt_list' ? [] : null);
  tCalls = [];
  await kt.ready(); await kt.ready();
  assert.equal(tCalls.filter((c) => c.cmd === 'kt_state').length, 1);
  assert.equal(kt.os, 'win32'); assert.equal(kt.reason, 'R');
  const got = await new Promise((ok) => { const off = kt.onTasks(ok); assert.equal(typeof off, 'function'); });
  assert.deepEqual(JSON.parse(JSON.stringify(got)), []);
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
  console.log(`tauribridge: ok (${SLICE.length} slice methods, ${BOOT.length} boot-safe, ${registered.length} commands)`);
})().catch((e) => { console.error(e); process.exit(1); });
