// The Tauri shell's bridge (desktop-tauri/bridge.js) against the Electron one (desktop/preload.cjs): the ported
// methods have the same names and send the same arguments (kt:xyz → the command kt_xyz), nothing outside the slice
// is there, bytes come back as an ArrayBuffer, errors as Errors, the kt:tasks / kt:engineState events reach onTasks
// and the kt:engine-state DOM event; every command the bridge calls is registered in main.rs with the argument names
// the bridge sends; and the self-test script (desktop-tauri/selftest.js) is inert without its settings and passes /
// fails as it should against a fake bridge. Since stage P3 also the shell's own methods (the Files page's jobs —
// filesJob, filesCancel, filesAnswer, onFilesJob —, which the preload does not have) and their kt:files event; the
// commands are looked for in every file of src-tauri/src. Plain node.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const SLICE = ['retryEngine', 'add', 'pause', 'resume', 'remove', 'setFiles', 'setUrl', 'move', 'setLimits', 'configure', 'torrentInfo', 'rename', 'list', 'defaultDir', 'roots', 'listDir', 'pathInfo', 'exists', 'siblings', 'readFile', 'writeText', 'writeTemp', 'writeTempBytes', 'removeFile', 'hashFile', 'openPath', 'openExternal', 'open', 'pickDir', 'pickFile', 'saveText', 'clipboardText', 'http', 'checkUpdate', 'deletePath', 'archiveFree', 'fontDirs', 'fontIndex', 'megaDecrypt', 'screenFontAdd', 'screenFontRemove', 'titleBar',
  'archiveList', 'archiveExtract', 'archiveTest', 'archiveCreate', 'archiveRestore', 'archiveExisting', 'archiveCancel', 'setDoh', 'dohProbe', 'installUpdate', 'appIcon',
  // (Stage P5: the video tools.)
  'videoInfo', 'videoReady', 'isVideoHost', 'videoVersion', 'videoRollback', 'videoUpdate', 'videoBinary', 'galleryList', 'galleryReady', 'ffmpegAvailable', 'ffmpeg', 'ffmpegCancel', 'ffprobe',
  'packStatus', 'packInstall', 'packCancel', 'packRemove', 'videoUrl', 'audioUrl'];
// (The preload's channel → this shell's command, where the name is not kt:xyz → kt_xyz.)
const RENAMED = { titleBar: 'kt_title_bar' };
// (The Tauri shell's own: no channel in the preload; the page uses them where they are.)
const OWN = { filesJob: ['kt_files_job', ['o']], filesCancel: ['kt_files_cancel', ['o']], filesAnswer: ['kt_files_answer', ['o']],
  updateDownload: ['kt_update_download', ['o']], updateInstall: ['kt_update_install', []], homeDir: ['kt_home_dir', []], filesRoots: ['kt_files_roots', []], filesStat: ['kt_files_stat', ['o']], filesMkdir: ['kt_files_mkdir', ['o']], filesRename: ['kt_files_rename', ['o']] };
const BOOT = ['platform', 'available', 'reason', 'os', 'ready', 'onTasks', 'onTitleBarState', 'onArchiveProgress', 'onUpdateProgress', 'onFfmpegProgress', 'onPackProgress'];
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
  assert.deepEqual(keys, [...new Set([...SLICE, ...BOOT, ...Object.keys(OWN), 'onFilesJob'])].sort(), 'bridge methods ≠ slice + boot-safe + own');
  for (const k of keys) assert.ok(k in pre || k in OWN || k === 'onFilesJob', `${k} is not in preload.cjs`);
  for (const k of [...Object.keys(OWN), 'onFilesJob']) assert.ok(!(k in pre), `${k} is the Tauri shell's own, not the preload's`);
  assert.equal(kt.platform, 'desktop');
  assert.equal(kt.available, false);
  assert.equal(kt.reason, '');
  assert.equal(kt.os, 'linux');
  for (const k of ['streamUrl', 'streamDone', 'mini', 'screenStatus', 'shareWifi', 'browse', 'avScan']) assert.ok(!(k in kt), `${k} should be absent`);

  // Arguments: each slice method sends what the preload sends, under the command named after its channel.
  const samples = {
    retryEngine: [], add: [{ source: { url: 'https://x.org/a.bin', headers: { Referer: 'https://x.org/' } }, dir: '/d', name: 'a.bin', connections: 4, meta: { title: 'A' } }], pause: ['t1'], resume: ['t1'], remove: ['t1', true],
    setFiles: ['t1', [1, 0, 2]], setUrl: ['t1', 'https://x.org/b.bin'], move: ['t1', -1], setLimits: [{ down: 1048576, up: 0 }], configure: [{ maxConnections: 8, seed: false }],
    torrentInfo: [{ magnet: 'magnet:?xt=urn:btih:abc' }], rename: [{ id: 't1', name: 'b.mkv' }],
    list: [], defaultDir: [], roots: [], listDir: ['/x'], pathInfo: ['/x/a.mkv'], exists: [['/a', '/b']], siblings: ['/x/a.mkv'], readFile: ['/x/a.ass'],
    writeText: [{ path: '/x/a.ass', text: 'نص' }], writeTemp: ['a.ass', 'text'], writeTempBytes: [{ name: 'f.ttf', b64: 'AAEC', sub: 'fonts' }], removeFile: ['/x/a'],
    hashFile: ['/x/a'], openPath: ['/x/a'], openExternal: ['https://example.org/'], open: ['t1', -1], pickDir: [], pickFile: [{ multiple: true, filters: [{ name: 'Subs', extensions: ['ass', 'srt'] }] }],
    saveText: [{ name: 'a.txt', text: 't' }], clipboardText: [], http: [{ url: 'https://example.org/', method: 'POST', headers: { a: 'b' }, body: 'x', binary: true }], checkUpdate: [{ beta: false }],
    deletePath: ['/x/a.mkv'], archiveFree: [{ dir: '/x' }], fontDirs: [], fontIndex: [['/usr/share/fonts', '/home/u/.fonts']], megaDecrypt: [{ path: '/x/a.mp4', key: 'abc_-' }],
    screenFontAdd: [{ name: 'a.ttf', b64: 'AAEC' }], screenFontRemove: [{ path: '/d/screen-fonts/1-a.ttf' }], titleBar: [{ own: true, act: 'maximize' }],
    archiveList: [{ path: '/x/a.7z', password: 'p' }], archiveExtract: [{ id: 'a1', path: '/x/a.zip', dest: 'cache:', only: ['d/', 'e.txt'], replace: 'both' }], archiveTest: [{ id: 'a2', path: '/x/a.7z', password: 'p' }],
    archiveCreate: [{ id: 'a3', out: '/x/b.zip', inputs: ['/x/c', '/x/d.txt'] }], archiveRestore: [{ path: '/x/a.zip' }], archiveExisting: [{ dest: '/y', names: ['a', 'b/c'] }], archiveCancel: ['a1'],
    appIcon: [{ set: null }], setDoh: [{ provider: 'mullvad' }], dohProbe: [], installUpdate: ['https://github.com/o/r/releases/download/tools-v9.9.9/KurokawaTools-9.9.9-win-x64.exe'],
    // (Stage P5.)
    videoInfo: [{ url: 'https://www.youtube.com/watch?v=x', playlist: true, cookiesFromBrowser: 'firefox' }], videoReady: [], isVideoHost: ['https://youtu.be/x'], videoVersion: [], videoRollback: [], videoUpdate: [],
    videoBinary: [{ path: '/opt/yt-dlp' }], galleryList: [{ url: 'https://x.org/g', range: '1-100', cookies: '/c.txt' }], galleryReady: [], ffmpegAvailable: [], ffmpeg: [{ id: 'c1', args: ['-i', '/a.mkv', '/b.mp4'] }],
    ffmpegCancel: ['c1'], ffprobe: ['/a.mkv'], packStatus: [], packInstall: [{ name: 'ffmpeg', url: 'https://x.org/p.gz', sha256: 'ab', version: '7' }], packCancel: ['ffmpeg'], packRemove: ['ffmpeg'], videoUrl: [], audioUrl: [],
  };
  assert.deepEqual(Object.keys(samples).sort(), [...SLICE].sort());
  const sent = {};
  for (const m of SLICE) {
    eCalls = []; tCalls = [];
    await pre[m](...samples[m]); await kt[m](...samples[m]).catch(() => undefined);
    tCalls = tCalls.filter((c) => c.cmd !== 'kt_state');
    assert.equal(eCalls.length, 1, `${m}: preload calls`); assert.equal(tCalls.length, 1, `${m}: bridge calls`);
    const { ch, a } = eCalls[0]; const { cmd, args } = tCalls[0];
    assert.equal(cmd, RENAMED[m] || snake(ch), `${m}: ${ch} → ${cmd}`);
    assert.deepEqual(JSON.parse(JSON.stringify(Object.values(args))), JSON.parse(JSON.stringify(a)), `${m}: arguments`);
    sent[cmd] = Object.keys(args);
  }

  // The shell's own methods: each one command, its object under «o».
  const ownSamples = { filesJob: { id: 'fj-1', op: 'move', paths: ['/a/x', '/a/D'], dest: '/b', conflict: 'ask' }, filesCancel: { id: 'fj-1' }, filesAnswer: { id: 'fj-1', answer: 'keepAll' },
    updateDownload: { beta: false }, filesStat: { path: '/a/x' }, filesMkdir: { path: '/a/New' }, filesRename: { path: '/a/x', name: 'y' } };
  for (const [m, [cmd, ks]] of Object.entries(OWN)) {
    tCalls = []; await kt[m](ownSamples[m]);
    tCalls = tCalls.filter((c) => c.cmd !== 'kt_state');
    assert.equal(tCalls.length, 1, `${m}: bridge calls`); assert.equal(tCalls[0].cmd, cmd, `${m} → ${cmd}`);
    assert.deepEqual(Object.keys(tCalls[0].args), ks); if (ks.length) assert.deepEqual(JSON.parse(JSON.stringify(tCalls[0].args.o)), ownSamples[m]);
    sent[cmd] = ks;
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
  assert.equal((listeners['kt:files'] || []).length, 1, 'kt:files listened to once');
  // kt:files: each event to every onFilesJob callback, as it came, until unsubscribed.
  const jobs = []; const offJ = fresh.onFilesJob((e) => jobs.push(JSON.parse(JSON.stringify(e)))); fresh.onFilesJob(() => undefined);
  assert.equal((listeners['kt:files'] || []).length, 1, 'kt:files still listened to once');
  listeners['kt:files'][0]({ event: 'kt:files', payload: { id: 'fj-1', status: 'conflict', to: '/b/x', dir: false } });
  offJ(); listeners['kt:files'][0]({ event: 'kt:files', payload: { id: 'fj-1', status: 'done' } });
  assert.deepEqual(jobs, [{ id: 'fj-1', status: 'conflict', to: '/b/x', dir: false }]);
  assert.deepEqual(seen, [[]]);
  listeners['kt:tasks'][0]({ event: 'kt:tasks', payload: [{ id: 'g1', state: 'downloading' }] });
  assert.deepEqual(seen, [[], [{ id: 'g1', state: 'downloading' }]]);
  off();
  listeners['kt:tasks'][0]({ event: 'kt:tasks', payload: [] });
  assert.equal(seen.length, 2, 'unsubscribed');
  // kt:archiveProgress: to each onArchiveProgress callback until it is removed.
  const prog = []; const offP = fresh.onArchiveProgress((p) => prog.push(p)); await new Promise((ok) => setTimeout(ok, 5));
  listeners['kt:archiveProgress'][0]({ event: 'kt:archiveProgress', payload: { id: 'a1', done: 1, total: 2, file: 'x' } });
  offP(); assert.equal((listeners['kt:archiveProgress'] || []).length <= 1, true);
  assert.deepEqual(JSON.parse(JSON.stringify(prog)), [{ id: 'a1', done: 1, total: 2, file: 'x' }]);
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
  assert.deepEqual(ls.map((a) => a.event).sort(), ['kt:engineState', 'kt:files', 'kt:tasks']);
  assert.ok(ls.every((a) => a.handler === 7 && a.target && a.target.kind === 'Any'));
  // No IPC at all: a clear rejection, not a TypeError at load.
  const bare = vm.createContext({ window: {}, Promise, Object, Array, String, Error, ArrayBuffer, Uint8Array });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'desktop-tauri', 'bridge.js'), 'utf8'), bare);
  await assert.rejects(bare.window.kurokawaTools.list(), /IPC/);

  // Rust: every command the bridge calls is registered, with the argument names the bridge sends.
  const src = path.join(ROOT, 'desktop-tauri', 'src-tauri', 'src');
  const main = fs.readFileSync(path.join(src, 'main.rs'), 'utf8');
  const handler = main.slice(main.indexOf('generate_handler!['), main.indexOf(']', main.indexOf('generate_handler![')));
  const registered = [...handler.matchAll(/\b\w+::(kt_\w+)/g)].map((m) => m[1]);
  const params = {};
  for (const f of fs.readdirSync(src).filter((x) => x.endsWith('.rs'))) {
    const code = fs.readFileSync(path.join(src, f), 'utf8');
    for (const m of code.matchAll(/#\[tauri::command\]\s*pub async fn (kt_\w+)\(([^)]*)\)/g)) {
      assert.ok(!(m[1] in params), `${m[1]} defined twice`);
      params[m[1]] = m[2].split(',').map((x) => x.trim()).filter(Boolean).filter((x) => !/:\s*(AppHandle|tauri::Window)$/.test(x)).map((x) => x.split(':')[0].trim());
    }
  }
  assert.deepEqual([...registered].sort(), Object.keys(params).sort(), 'main.rs registers ≠ the commands src-tauri/src defines');
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
  const megaPlain = Buffer.from('mega ✓ '.repeat(20)); const megaEnc = Buffer.from(megaPlain.map((b) => b ^ 0x5a));
  assert.deepEqual(JSON.parse(JSON.stringify(lib.b64bytes(megaPlain.toString('base64')))), [...megaPlain]);
  const cfg = { otherTemp: '/other', megaKey: 'k', megaPlainB64: megaPlain.toString('base64'), megaEncB64: megaEnc.toString('base64'), base: 'http://127.0.0.1:1', temp: '/tmp', aria2Bin: '/r/aria2/linux-x64/aria2c', aria2Bundled: true, wantBundled: true, text: 'T ✓', gzText: 'G', binB64: Buffer.from([...Array(256).keys()]).toString('base64'), bigSize: 2097152, bigSha256: 'ab', os: 'linux', dohHost: 'kr-doh-selftest.test', largeSize: 3145728 };
  for (const k of ['md5', 'sha1', 'sha256']) assert.equal(lib.ABC[k], crypto.createHash(k).update('abc').digest('hex'), `known ${k} of abc`);
  // (A pretend disk for the P3 checks: files by path, folders implied by them; the jobs with the phone's rules, enough
  // for the script's checks — questions, apply-to-all, skip, into itself, pace + cancel, moves, deletes.)
  function fakeDisk() {
    const files = new Map(); const fileSubs = []; const jobs = {}; const early = new Set(); const zips = new Map(); const arcSubs = [];
    // (A stored zip's names, from its central directory.)
    const zipNames = (raw) => { const b = Buffer.from(raw, 'latin1'); const e = b.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6])); if (e < 0) return []; const out = []; let p = b.readUInt32LE(e + 16); for (let k = 0; k < b.readUInt16LE(e + 10); k++) { const nl = b.readUInt16LE(p + 28); out.push(b.subarray(p + 46, p + 46 + nl).toString('utf8')); p += 46 + nl + b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32); } return out; };
    const under = (d) => [...files.keys()].filter((k) => k.startsWith(d + '/'));
    const isDir = (p) => under(p).length > 0;
    const base = (p) => p.split('/').pop();
    const emit = (e) => setTimeout(() => fileSubs.slice().forEach((f) => f(JSON.parse(JSON.stringify(e)))), 1);
    const keepBoth = (to) => { const m = /^(.*?)(\.[^./]*)?$/.exec(to); for (let i = 2; ; i++) { const c = `${m[1]} (${i})${m[2] || ''}`; if (!files.has(c) && !isDir(c)) return c; } };
    const run = async (o) => {
      const j = (jobs[o.id] = { cancel: early.delete(o.id), standing: o.conflict || 'ask', answer: null, wake: null }); const end = { id: o.id, failed: [], skipped: 0, files: 0 }; const remaining = []; let left = 0;
      const ask = (from, to) => new Promise((ok) => { if (j.standing !== 'ask') return ok(j.standing); j.wake = ok; emit({ id: o.id, status: 'conflict', from, to, size: (files.get(from) || '').length, existingSize: (files.get(to) || '').length, dir: false }); });
      for (const p of o.paths) {
        if (j.cancel) { if (o.op === 'move') { left++; remaining.push(p); } continue; }
        if (o.op === 'delete') { for (const k of [p, ...under(p)]) if (files.delete(k)) end.files++; continue; }
        if (isDir(p) && (o.dest + '/').startsWith(p + '/')) { end.failed.push(base(p) + ': into itself'); continue; }
        const list = isDir(p) ? under(p).map((k) => [k, o.dest + '/' + base(p) + k.slice(p.length)]) : [[p, o.dest + '/' + base(p)]];
        for (const [from, to0] of list) {
          let to = to0;
          if (o.pace) { emit({ id: o.id, status: 'progress', done: 1, total: 2, files: 0, ofFiles: 1, name: base(from) }); await new Promise((ok) => setTimeout(ok, 30)); if (j.cancel) { if (o.op === 'move') { left++; remaining.push(p); } break; } }
          if (files.has(to)) { const a = await ask(from, to); if (a === 'skip') { end.skipped++; if (o.op === 'move') { left++; remaining.push(p); } continue; } if (a === 'keep') to = keepBoth(to); }
          files.set(to, files.get(from)); end.files++; if (o.op === 'move') files.delete(from);
        }
      }
      delete jobs[o.id]; emit({ ...end, status: j.cancel ? 'cancelled' : 'done', ...(o.op === 'move' ? { left, remaining } : {}) });
    };
    return {
      files,
      has: (p) => files.has(p) || isDir(p),
      writeText: async (o) => { files.set(o.path, o.text); return { ok: true }; },
      deletePath: async (p) => { for (const k of [p, ...under(p)]) files.delete(k); return { ok: true, trashed: true }; },
      archiveFree: async () => ({ free: 5e9 }), fontDirs: async () => ['/usr/share/fonts'], fontIndex: async () => [{ path: '/usr/share/fonts/a.ttf', size: 9, mtime: 1, families: ['A'] }],
      megaDecrypt: async (o) => { const b = files.get(o.path); files.set(o.path, Buffer.from(b, 'latin1').map((x) => x ^ 0x5a).toString('latin1')); return true; },
      filesJob: async (o) => { void run(o); return { id: o.id }; },
      filesCancel: async (o) => { const j = jobs[o.id]; if (j) { j.cancel = true; if (j.wake) j.wake('skip'); } else early.add(o.id); },
      homeDir: async () => '/home/u',
      filesRoots: async () => ({ allFiles: true, roots: [{ kind: 'home', path: '/home/u', name: 'u', readable: true }, { kind: 'drive', path: '/', name: '/', readable: true, free: 5e9, total: 9e9 }] }),
      filesStat: async (o) => { const d = isDir(o.path); const f = files.has(o.path); const p = o.path; return { exists: d || f, name: base(p), path: p, dir: d, size: f ? files.get(p).length : 0, mtime: d || f ? 1 : 0, readable: d || f, writable: d || f, hidden: false }; },
      filesMkdir: async (o) => { files.set(o.path + '/.dir', ''); return { ok: true, path: o.path }; },
      filesRename: async (o) => { if (/[\\/]/.test(o.name)) throw new Error('bad name'); const to = o.path.replace(/[^/]*$/, o.name); if (files.has(to) || isDir(to)) throw new Error('exists'); for (const k of [o.path, ...under(o.path)]) { const v = files.get(k); files.delete(k); files.set(to + k.slice(o.path.length), v); } return { ok: true, path: to }; },
      filesAnswer: async (o) => { const j = jobs[o.id]; if (!j) return; if (/All$/.test(o.answer)) j.standing = o.answer.replace(/All$/, ''); const w = j.wake; j.wake = null; if (w) w(o.answer.replace('All', '')); },
      onFilesJob: (cb) => { fileSubs.push(cb); return () => { const i = fileSubs.indexOf(cb); if (i >= 0) fileSubs.splice(i, 1); }; },
      // (Archives, stage P7: a zip made here is its entries kept by path; one written as bytes — the hostile one — is
      // read for its names; extracting writes the entries chosen, refuses a name that leaves the folder.)
      __write: (o) => { files.set(o.p, Buffer.from(o.b64, 'base64').toString('latin1')); return true; },
      archiveCreate: async (o) => { const ents = []; for (const inp of o.inputs) { const b = base(inp); if (files.has(inp)) ents.push([b, files.get(inp)]); for (const k of under(inp).sort()) ents.push([b + k.slice(inp.length), files.get(k)]); } zips.set(o.out, ents); files.set(o.out, 'PK'); arcSubs.forEach((f) => f({ id: o.id, done: 1, total: 1, file: '' })); return { files: ents.length, path: o.out, size: 2 }; },
      archiveList: async (o) => { const z = zips.get(o.path) || zipNames(files.get(o.path) || '').map((n) => [n, '']); const evil = z.map((e) => e[0]).find((n) => n.startsWith('../')); return { format: 'zip', entries: z.map(([p, d]) => ({ path: p, size: Buffer.from(d, 'latin1').length, dir: false, mtime: Date.now() })), total: 0, encrypted: false, inPlaceOk: true, resumable: false, largest: 0, free: 5e9, ...(evil ? { unsafe: evil } : {}) }; },
      archiveExtract: async (o) => { const z = zips.get(o.path) || zipNames(files.get(o.path) || '').map((n) => [n, '']); const evil = z.map((e) => e[0]).find((n) => n.startsWith('../')); if (evil) throw new Error('unsafePath ' + evil); const want = (n) => !o.only || o.only.some((w) => n === w || (w.endsWith('/') && n.startsWith(w))); let n = 0; for (const [p, d] of z) if (want(p)) { files.set(o.dest + '/' + p, d); n++; } if (o.inPlace) { files.delete(o.path); zips.delete(o.path); } return { files: n, dest: o.dest }; },
      archiveTest: async (o) => ({ ok: true, files: (zips.get(o.path) || []).length, bad: [] }),
      archiveExisting: async (o) => ({ existing: o.names.filter((n) => !n.startsWith('..') && files.has(o.dest + '/' + n)) }),
      onArchiveProgress: (cb) => { arcSubs.push(cb); return () => { const i = arcSubs.indexOf(cb); if (i >= 0) arcSubs.splice(i, 1); }; },
    };
  }
  function fakeKt(bad) {
    let subs = []; let task = null; const disk = fakeDisk(); let doh = 'off'; let dnsCount = 0; let icon = null;
    const push = () => subs.forEach((f) => f(task ? [JSON.parse(JSON.stringify(task))] : []));
    const later = (f) => setTimeout(f, 5);
    return {
      platform: 'desktop', available: false, reason: '', os: 'linux',
      ready: async () => ({ os: 'linux', arch: 'x64', available: false }), async retryEngine() { this.available = true; },
      roots: async () => ({ roots: ['/d'] }), defaultDir: async () => '/d/Kurokawa', listDir: async () => ({ exists: true, entries: [] }),
      writeTemp: async () => '/tmp/kt-selftest.txt', pathInfo: async () => ({ exists: true, dir: false, size: 3 }),
      readFile: async (p) => (disk.files.has(p) ? new Uint8Array(Buffer.from(disk.files.get(p), 'latin1')).buffer : p.endsWith('.txt') ? new Uint8Array([97, 98, 99]).buffer : new Uint8Array([0, 1, 2, 255]).buffer),
      writeTempBytes: async (o) => { if (/mega/.test(o.name)) { disk.files.set('/tmp/kt-selftest/' + o.name, Buffer.from(o.b64, 'base64').toString('latin1')); return '/tmp/kt-selftest/' + o.name; } return '/tmp/kt-selftest/kt-selftest.bin'; },
      ...Object.fromEntries(['writeText', 'deletePath', 'archiveFree', 'fontDirs', 'fontIndex', 'megaDecrypt', 'filesJob', 'filesCancel', 'filesAnswer', 'onFilesJob', 'homeDir', 'filesRoots', 'filesStat', 'filesMkdir', 'filesRename', '__write', 'archiveCreate', 'archiveList', 'archiveExtract', 'archiveTest', 'archiveExisting', 'onArchiveProgress'].map((k) => [k, disk[k]])),
      hashFile: async (p) => (p.endsWith('.txt') ? { ...lib.ABC, size: 3 } : { sha256: cfg.bigSha256, size: cfg.bigSize }),
      removeFile: async (p) => { disk.files.delete(p); }, exists: async (ps) => ps.map((p) => disk.has(p) || p.includes('renamed')),
      // (Stage P8: the pretend resolver — the made-up name found while it is chosen —, the probe, the updater.)
      setDoh: async (o) => { doh = o.provider; dnsCount++; return { provider: o.provider }; },
      dohProbe: async () => ({ ok: false, ms: 3, why: 'no such name' }),
      installUpdate: async () => { throw new Error('kt-update:bare'); }, updateDownload: async () => 'unsupported', updateInstall: async () => false,
      onUpdateProgress: () => () => undefined, __icon: () => icon,
      appIcon: async (o) => { if (!o || !('set' in o)) return icon; if (o.set && !/^data:image\/png;base64,iVBOR/.test(o.set)) throw new Error('not a PNG'); icon = o.set || null; return true; },
      http: async (o) => {
        if (o.url.includes(cfg.dohHost)) { if (doh === 'off') throw new Error('dns error'); return { status: 200, url: o.url, headers: {}, body: cfg.text }; }
        if (o.url.endsWith('/dns-count')) return { status: 200, url: o.url, headers: {}, body: String(dnsCount) };
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
    const kt2 = fakeKt(bad);
    const env = { sleep: () => new Promise((ok) => setTimeout(ok, 2)), invoke: (cmd, args) => { sent2.push({ cmd, args }); return Promise.resolve(cmd === 'kt_selftest_icon' ? { png: kt2.__icon() ? 9 : null, ico: [], dir: '/c', last: { window: true }, setIcon: true } : cmd === 'kt_selftest_write' ? kt2.__write(args) : cmd === 'kt_selftest_updatedl' ? { size: cfg.largeSize, resumedFrom: 1048576, ok: true, refused: 'kt-update:checksum', removedWhenRefused: true, noChecksum: 'kt-update:nochecksum', kind: 'bare', file: null } : undefined); }, doc, now: () => Date.now() };
    const res = JSON.parse(JSON.stringify(await lib.run(kt2, cfg, env)));
    const last = sent2[sent2.length - 1];
    assert.equal(last.cmd, 'kt_selftest_done');
    const failed = res.filter((r) => r.required && !r.ok).map((r) => `${r.name}: ${r.detail}`);
    if (!bad) assert.deepEqual(failed, [], 'self-test against a good fake');
    else assert.deepEqual(res.filter((r) => r.required && !r.ok).map((r) => r.name), ['http text + headers']);
    assert.equal(lib.verdict(res), bad ? 1 : 0);
    assert.ok(res.some((r) => r.name === 'remove' && r.ok) && res.some((r) => r.name === 'kt:tasks events' && r.ok));
    const p7 = res.filter((r) => /^archives:/.test(r.name));
    assert.ok(p7.length === 8 && p7.filter((r) => r.required).every((r) => r.ok) && p7.filter((r) => !r.required).length === 3, 'the P7 checks against the pretend disk (the 7-Zip ones not required without wantSeven): ' + JSON.stringify(p7.filter((r) => r.required && !r.ok)));
    const p3 = res.filter((r) => /^(files|deletePath|archiveFree|font|megaDecrypt)/.test(r.name));
    assert.ok(p3.length >= 15 && p3.every((r) => r.ok), 'the P3 checks against the pretend disk: ' + JSON.stringify(p3.filter((r) => !r.ok)));
    assert.ok(sent2.some((c) => c.cmd === 'kt_selftest_progress'));
  }

  console.log(`tauribridge: ok (${SLICE.length} slice methods, ${BOOT.length} boot-safe, ${registered.length} commands)`);
})().catch((e) => { console.error(e); process.exit(1); });
