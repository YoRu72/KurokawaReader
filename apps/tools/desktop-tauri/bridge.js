// window.kurokawaTools for the Tauri shell: the same names, arguments and results as desktop/preload.cjs (the
// Electron shell's bridge; the typed shape is src/engine/desktop.ts), each channel kt:xyz a Tauri command kt_xyz.
// Run by src-tauri/src/main.rs as the window's initialization script — before the page's own scripts, on every
// load —, after a line that sets window.__KT_BOOT__ = { os, arch }.
// Only the ported slice is here (../PORTING.md: stage 1 files/dialogs/clipboard/http, stage 2 the download engine,
// stage P3 the recycle bin, free space, fonts, MEGA, the screen translator's fonts): the page asks for each feature by
// its method (d?.dohProbe, …), so whatever is not ported yet is absent, not a stub. Events (kt:tasks, kt:engineState,
// kt:files) come as Tauri events, listened to with window.__TAURI__.event.listen.
// Four methods are this shell's own, not the preload's: filesJob, filesCancel, filesAnswer and onFilesJob — the Files
// page's copy / move / delete jobs with the phone's shapes (src/views/files.ts uses them where they are; the Electron
// shell has none, so there Copy, Cut and Paste stay hidden).
(function () {
  'use strict';
  if (window.kurokawaTools) return;
  var boot = window.__KT_BOOT__ || {};
  var state = { available: false, reason: '', os: boot.os || '', arch: boot.arch || '' };

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
  var orNull = function (x) { return x === undefined ? null : x; };

  // (aria2c up later, or stopped: the page told, to pick its engine again — as the preload's news() does.)
  function news(s) {
    if (s && typeof s === 'object') Object.assign(state, s);
    try { if (typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') window.dispatchEvent(new CustomEvent('kt:engine-state')); } catch (e) { /* no DOM */ }
    return state;
  }
  // (Tauri's event listener, looked up at each try like the invoker; the plugin's own command when the global API
  // is not there.)
  function listener() {
    var t = window.__TAURI__;
    if (t && t.event && typeof t.event.listen === 'function') return function (n, f) { return t.event.listen(n, f); };
    var i = window.__TAURI_INTERNALS__;
    if (i && typeof i.invoke === 'function' && typeof i.transformCallback === 'function') return function (n, f) { return i.invoke('plugin:event|listen', { event: n, target: { kind: 'Any' }, handler: i.transformCallback(f) }); };
    return null;
  }
  // (One event's payloads to `cb` until the returned function is called — the title bar's state.)
  function subscribe(name, cb) {
    var on = listener(); var off = null; var gone = false;
    if (on && typeof cb === 'function') {
      try {
        Promise.resolve(on(name, function (ev) { if (!gone) { try { cb(ev && ev.payload); } catch (e) { /* the page's */ } } })).then(function (u) {
          if (typeof u === 'function') { if (gone) { try { u(); } catch (e) { /* gone */ } } else off = u; }
        }).catch(function () {});
      } catch (e) { /* no events: the remover alone */ }
    }
    return function () { gone = true; if (off) { try { off(); } catch (e) { /* gone */ } } };
  }
  var taskSubs = [];
  var fileSubs = [];
  var listening = false;
  // (Once: kt:tasks to every onTasks callback, kt:engineState to the state; then the state asked again, since an
  // event sent while the page was loading is lost — what Electron's did-finish-load resend does.)
  function listen() {
    if (listening) return;
    var on = listener();
    if (!on) return;
    listening = true;
    try {
      Promise.resolve(on('kt:tasks', function (ev) { var list = ev && ev.payload; taskSubs.slice().forEach(function (f) { try { f(list); } catch (e) { /* the page's */ } }); })).catch(function () { listening = false; });
      Promise.resolve(on('kt:files', function (ev) { var e = ev && ev.payload; fileSubs.slice().forEach(function (f) { try { f(e); } catch (x) { /* the page's */ } }); })).catch(function () {});
      Promise.resolve(on('kt:engineState', function (ev) { news(ev && ev.payload); })).then(function () { return call('kt_state').then(function (s) { if (s && (s.available !== state.available || s.reason !== state.reason)) news(s); else if (s) Object.assign(state, s); }); }).catch(function () {});
    } catch (e) { listening = false; }
  }
  try { if (typeof window.addEventListener === 'function') window.addEventListener('DOMContentLoaded', listen); } catch (e) { /* no DOM */ }
  var ready = null;

  var api = {
    platform: 'desktop',
    get available() { return state.available; },
    get reason() { return state.reason; },
    get os() { return state.os; },
    ready: function () { listen(); if (!ready) ready = call('kt_state').then(function (s) { Object.assign(state, s); return state; }).catch(function () { return state; }); return ready; },
    retryEngine: function () { return call('kt_engine_retry').then(news); },

    /* the engine (aria2c beside the app: src-tauri/src/engine.rs) */
    add: function (o) { return call('kt_add', { o: obj(o) }); },
    list: function () { return call('kt_list'); },
    pause: function (id) { return call('kt_pause', { id: orNull(id) }); },
    resume: function (id) { return call('kt_resume', { id: orNull(id) }); },
    remove: function (id, del) { return call('kt_remove', { id: orNull(id), del: !!del }); },
    setFiles: function (id, p) { return call('kt_set_files', { id: orNull(id), p: Array.isArray(p) ? p : [] }); },
    setUrl: function (id, url) { return call('kt_set_url', { id: orNull(id), url: str(url) }); },
    move: function (id, how) { return call('kt_move', { id: orNull(id), how: orNull(how) }); },
    setLimits: function (l) { return call('kt_set_limits', { l: obj(l) }); },
    configure: function (o) { return call('kt_configure', { o: obj(o) }); },
    torrentInfo: function (s) { return call('kt_torrent_info', { s: obj(s) }); },
    rename: function (o) { return call('kt_rename', { o: obj(o) }); },
    open: function (id, i) { return call('kt_open', { id: orNull(id), index: typeof i === 'number' ? i : null }); },
    onTasks: function (cb) {
      listen();
      taskSubs.push(cb);
      call('kt_list').then(cb).catch(function () {});
      return function () { var k = taskSubs.indexOf(cb); if (k >= 0) taskSubs.splice(k, 1); };
    },

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
    deletePath: function (p) { return call('kt_delete_path', { p: str(p) }); },
    archiveFree: function (o) { return call('kt_archive_free', { o: obj(o) }); },
    fontDirs: function () { return call('kt_font_dirs'); },
    fontIndex: function (dirs) { return call('kt_font_index', { dirs: (Array.isArray(dirs) ? dirs : []).map(str) }); },
    megaDecrypt: function (o) { return call('kt_mega_decrypt', { o: obj(o) }); },
    screenFontAdd: function (o) { return call('kt_screen_font_add', { o: obj(o) }); },
    screenFontRemove: function (o) { return call('kt_screen_font_remove', { o: obj(o) }); },

    /* the Files page's jobs (this shell's own: the phone plugin's shapes — { id, status, … } events as kt:files) */
    filesJob: function (o) { return call('kt_files_job', { o: obj(o) }); },
    filesCancel: function (o) { return call('kt_files_cancel', { o: obj(o) }); },
    filesAnswer: function (o) { return call('kt_files_answer', { o: obj(o) }); },
    onFilesJob: function (cb) {
      listen();
      fileSubs.push(cb);
      return function () { var k = fileSubs.indexOf(cb); if (k >= 0) fileSubs.splice(k, 1); };
    },
    openPath: function (p) { return call('kt_open_path', { p: str(p) }); },
    openExternal: function (u) { return call('kt_open_external', { u: str(u) }); },

    /* dialogs, clipboard */
    pickDir: function () { return call('kt_pick_dir'); },
    pickFile: function (o) { return call('kt_pick_file', { o: obj(o) }); },
    saveText: function (o) { return call('kt_save_text', { o: obj(o) }); },
    clipboardText: function () { return call('kt_clipboard_text'); },

    /* the window's own title bar (src-tauri/src/titlebar.rs, the Reader's): titleBar(o) — o.own asks for the app's own
       bar (true) or the system's frame (false), o.act works the window (minimize, maximize — or restore —, close,
       drag) — answers the bar's state { platform, height, own, wanted, controls, maximized, fullscreen, focused };
       onTitleBarState(cb) — each change of it (the kt:titleBarState event). The page draws the bar, its buttons too
       (src/ui/winbar.ts). */
    titleBar: function (o) { return call('kt_title_bar', { o: obj(o) }); },
    onTitleBarState: function (cb) { return subscribe('kt:titleBarState', cb); },

    /* network */
    http: function (o) { return call('kt_http', { o: obj(o) }); },
    checkUpdate: function (o) { return call('kt_check_update', { o: obj(o) }); },
  };
  // (Which shell this is: the page draws the window's whole title bar here — src/ui/winbar.ts —, and the Files page
  // has its jobs.)
  try { Object.defineProperty(window, '__KT_SHELL__', { value: 'tauri', configurable: true }); } catch (e) { /* the page then keeps Electron's bar */ }
  Object.defineProperty(window, 'kurokawaTools', { value: api, enumerable: true, configurable: false, writable: false });
})();
