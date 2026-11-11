// window.kurokawaTools for the Tauri shell: the same names, arguments and results as desktop/preload.cjs (the
// Electron shell's bridge; the typed shape is src/engine/desktop.ts), each channel kt:xyz a Tauri command kt_xyz.
// Run by src-tauri/src/main.rs as the window's initialization script — before the page's own scripts, on every
// load —, after a line that sets window.__KT_BOOT__ = { os, arch }.
// Only the stage-1 slice is here (../PORTING.md): the page asks for each feature by its method (d?.dohProbe, …),
// so whatever is not ported yet is absent, not a stub — except what the page uses without asking (the engine's
// methods, which DesktopEngine calls as they are): those answer «not in this preview build».
(function () {
  'use strict';
  if (window.kurokawaTools) return;
  var REASON = 'The download engine is not in this preview build yet';
  var boot = window.__KT_BOOT__ || {};
  var state = { available: false, reason: REASON, os: boot.os || '', arch: boot.arch || '' };

  // (Looked up at each call: Tauri's own scripts may run after this one.)
  function invoker() {
    var t = window.__TAURI__;
    if (t && t.core && typeof t.core.invoke === 'function') return function (c, a) { return t.core.invoke(c, a); };
    var i = window.__TAURI_INTERNALS__;
    if (i && typeof i.invoke === 'function') return function (c, a) { return i.invoke(c, a); };
    return null;
  }
  // (A command's error comes back as a string: made an Error, as ipcRenderer.invoke's rejections are.)
  function asError(e) { return e instanceof Error ? e : new Error(typeof e === 'string' ? e : (e && e.message) || String(e)); }
  function call(cmd, args) {
    var inv = invoker();
    if (!inv) return Promise.reject(new Error('Tauri IPC is not available'));
    try { return Promise.resolve(inv(cmd, args || {})).catch(function (e) { throw asError(e); }); } catch (e) { return Promise.reject(asError(e)); }
  }
  // (The file's bytes as the page wants them, an ArrayBuffer — whatever form the IPC handed them in.)
  function toArrayBuffer(r) {
    if (r instanceof ArrayBuffer) return r;
    if (r && r.buffer instanceof ArrayBuffer && typeof r.byteLength === 'number') return r.buffer.slice(r.byteOffset || 0, (r.byteOffset || 0) + r.byteLength);
    if (Array.isArray(r)) return new Uint8Array(r).buffer;
    return new ArrayBuffer(0);
  }
  var str = function (x) { return String(x); };
  var obj = function (o) { return o && typeof o === 'object' ? o : {}; };
  var noEngine = function () { return Promise.reject(new Error(REASON)); };
  // (Asked on the first ready(), when the page boots — by then Tauri's IPC is surely in place.)
  var ready = null;

  var api = {
    platform: 'desktop',
    get available() { return state.available; },
    get reason() { return state.reason; },
    get os() { return state.os; },
    ready: function () { if (!ready) ready = call('kt_state').then(function (s) { Object.assign(state, s); return state; }).catch(function () { return state; }); return ready; },
    retryEngine: function () { return call('kt_state').then(function (s) { Object.assign(state, s); return state; }); },

    /* the engine (stage 2): asked for without feature checks by DesktopEngine, so present, and refusing */
    add: noEngine, pause: noEngine, resume: noEngine, remove: noEngine, setFiles: noEngine, setLimits: noEngine, torrentInfo: noEngine, rename: noEngine,
    list: function () { return call('kt_list'); },
    onTasks: function (cb) { call('kt_list').then(cb).catch(function () {}); return function () {}; },
    open: function (id, i) { return call('kt_open', { id: id === undefined ? null : id, index: typeof i === 'number' ? i : null }); },

    /* files */
    defaultDir: function () { return call('kt_default_dir'); },
    roots: function () { return call('kt_roots'); },
    listDir: function (p) { return call('kt_list_dir', { p: str(p) }); },
    pathInfo: function (p) { return call('kt_path_info', { p: str(p) }); },
    exists: function (ps) { return call('kt_exists', { ps: (Array.isArray(ps) ? ps : []).map(str) }); },
    siblings: function (p) { return call('kt_siblings', { p: str(p) }); },
    readFile: function (p) { return call('kt_read_file', { p: str(p) }).then(toArrayBuffer); },
    writeText: function (o) { return call('kt_write_text', { o: obj(o) }); },
    writeTemp: function (name, text) { return call('kt_write_temp', { o: { name: name, text: text } }); },
    writeTempBytes: function (o) { return call('kt_write_temp_bytes', { o: obj(o) }); },
    removeFile: function (p) { return call('kt_remove_file', { p: str(p) }); },
    hashFile: function (p) { return call('kt_hash_file', { p: str(p) }); },
    openPath: function (p) { return call('kt_open_path', { p: str(p) }); },
    openExternal: function (u) { return call('kt_open_external', { u: str(u) }); },

    /* dialogs, clipboard */
    pickDir: function () { return call('kt_pick_dir'); },
    pickFile: function (o) { return call('kt_pick_file', { o: obj(o) }); },
    saveText: function (o) { return call('kt_save_text', { o: obj(o) }); },
    clipboardText: function () { return call('kt_clipboard_text'); },

    /* network */
    http: function (o) { return call('kt_http', { o: obj(o) }); },
    checkUpdate: function (o) { return call('kt_check_update', { o: obj(o) }); },
  };
  Object.defineProperty(window, 'kurokawaTools', { value: api, enumerable: true, configurable: false, writable: false });
})();
