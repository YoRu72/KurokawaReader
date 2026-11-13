// window.kurokawaDesktop for the Tauri shell: every name desktop/preload.cjs (the Electron shell's bridge) gives the
// page, with the same arguments and results. Run by src-tauri/src/main.rs as the window's initialization script —
// before the page's own scripts, on every load —, after a line that sets window.__KR_BOOT__ = { os, arch }.
// Each Electron channel kr:a-b is the Tauri command kr_a_b (src-tauri/src/commands.rs). What is not ported yet
// (PORTING.md says which stage brings it) is a stub that answers as Electron answers when it cannot do the thing —
// false, null, 'unsupported', an empty result — or, where Electron has no such answer, rejects with an Error that
// names the stage; the page already copes with each (PORTING.md says how). The stubs are listed in STUBS below, so
// tests/tauribridge.cjs and the self-test can tell them from the ported ones. Some names are LEFT OUT instead (LEFT_OUT
// below): the page tests for those before it uses them, and without them it takes a way that works — its own full
// screen, its picture PDF, a plain request — or shows no control that could not work (Archives, DNS-over-HTTPS, the
// in-app browser, the app icon); each comes back with the stage that ports it.
(function () {
  'use strict';
  if (window.kurokawaDesktop) return;
  var boot = window.__KR_BOOT__ || {};

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
  // (Tauri's event listener, looked up at each call like the invoker — the global API's, else the event plugin's own
  // command —; null where there is neither.)
  function listener() {
    var t = window.__TAURI__;
    if (t && t.event && typeof t.event.listen === 'function') return function (n, f) { return t.event.listen(n, f); };
    var i = window.__TAURI_INTERNALS__;
    if (i && typeof i.invoke === 'function' && typeof i.transformCallback === 'function') return function (n, f) { return i.invoke('plugin:event|listen', { event: n, target: { kind: 'Any' }, handler: i.transformCallback(f) }); };
    return null;
  }
  // A Tauri event's payloads to cb; the remover ends it (at once, or when the listening is set up).
  function subscribe(name, cb) {
    var on = listener(); var off = null; var gone = false;
    if (on && typeof cb === 'function') {
      try {
        Promise.resolve(on(name, function (ev) { if (!gone) { try { cb(ev && ev.payload); } catch (e) { /* the page's */ } } })).then(function (u) {
          if (typeof u === 'function') { if (gone) { try { u(); } catch (e) { /* gone */ } } else off = u; }
        }).catch(function () {});
      } catch (e) { /* no events: the remover alone */ }
    }
    return function () { gone = true; if (off) { try { off(); } catch (e) { /* gone */ } off = null; } };
  }
  var str = function (x) { return String(x); };
  var obj = function (o) { return o && typeof o === 'object' ? o : {}; };

  // A page's text in its own charset, as main.cjs's decodeText: the Content-Type's, else a <meta> in its first 2048
  // bytes, else UTF-8 (a charset TextDecoder does not know read as UTF-8).
  function fromBase64(b64) {
    var bin = atob(String(b64 || ''));
    var u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  function charsetOf(u8, contentType) {
    var m = /charset=["']?([\w-]+)/i.exec(contentType || '');
    if (m) return m[1];
    var head = ''; var n = Math.min(u8.length, 2048);
    for (var i = 0; i < n; i++) head += String.fromCharCode(u8[i]);
    m = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
    return m ? m[1] : '';
  }
  function decodeText(u8, contentType) {
    var cs = charsetOf(u8, contentType);
    try { return new TextDecoder(cs || 'utf-8').decode(u8); } catch (e) { return new TextDecoder('utf-8').decode(u8); }
  }

  /* ---------- stubs: what a later stage brings ---------- */
  // name → [stage, how it answers]. 'reject': an Error naming the stage; 'none': nothing (undefined, at once — the
  // preload's own answer for these); 'off': a remover function (the preload's subscribe answer); anything else: that
  // value, resolved.
  var STUBS = {
    setZoom: ['R5', 'none'],
    installUpdate: ['R6', 'reject'], onUpdateProgress: ['R6', 'none'],
    setImmersive: ['R5', false], copyImage: ['R5', false], notify: ['R3', false],
    onCommand: ['R5', 'none'], setProgress: ['R5', 'none'],
  };
  // name → the stage that brings it. Not defined at all until then: the page looks for each before using it, and
  // without it does what works here (src/: native.ts toggleFullscreen → the HTML full screen; convert.ts buildPdf →
  // the picture PDF; opds.ts / downloads.ts → a plain request through http; archives.ts canArchive, sources/http.ts
  // hasBrowser / hasDoh, native.ts appIconWay, updates.ts → no Archives button, no in-app browser or DNS-over-HTTPS
  // section, no app-icon option, no «download in the background» switch).
  var LEFT_OUT = {
    appIcon: 'R5', downloadUpdate: 'R6', installDownloadedUpdate: 'R6',
    archiveList: 'R5', archiveExtract: 'R5', archiveCancel: 'R5', archiveCreate: 'R5', archiveTest: 'R5', archiveRestore: 'R5', archiveFree: 'R5', archiveExisting: 'R5', onArchiveProgress: 'R5',
    setFullscreen: 'R5', printToPdf: 'R5',
    setDoh: 'R3', download: 'R3', deleteDownload: 'R3', onDownloadProgress: 'R3', addDownloadListener: 'R3',
    openWebView: 'R4', browserFetch: 'R4', browserReset: 'R4', browserForget: 'R4',
  };
  function notYet(name, stage) { return new Error(name + ' is not in this preview build yet (Tauri stage ' + stage + ')'); }
  function copy(v) { return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v; }
  function stub(name) {
    var stage = STUBS[name][0]; var how = STUBS[name][1];
    if (how === 'reject') return function () { return Promise.reject(notYet(name, stage)); };
    if (how === 'none') return function () { return undefined; };
    if (how === 'off') return function () { return function () { /* nothing to remove */ }; };
    return function () { return Promise.resolve(copy(how)); };
  }

  /* ---------- files and links the system hands the app (src-tauri/src/openfile.rs) ---------- */
  // What a launch carried — this one's command line, a second launch's (handed over), a Mac's Apple Events — is kept
  // in the shell until taken: on onOpenFile / onOpenUrl, and again on each kr:openPending event. A file comes as
  // { name, path }; its bytes are read here by path (kr_read_file) and given to the page as main.cjs gives them,
  // { name, data: ArrayBuffer }. (Each handed over is noted in window.__KR_OPEN_LOG__ for the self-test.)
  var openLog = [];
  try { Object.defineProperty(window, '__KR_OPEN_LOG__', { value: openLog, configurable: true }); } catch (e) { /* the self-test then says so */ }
  function note(x) { openLog.push(x); if (openLog.length > 50) openLog.shift(); }
  function takeFiles(cb) {
    return call('kr_open_take', { kind: 'file' }).then(function (list) {
      var chain = Promise.resolve();
      (Array.isArray(list) ? list : []).forEach(function (f) {
        chain = chain.then(function () {
          return call('kr_read_file', { p: str(f.path) }).then(toArrayBuffer).then(function (data) {
            note({ kind: 'file', name: str(f.name), size: data.byteLength });
            try { cb({ name: str(f.name), data: data }); } catch (e) { /* the page's */ }
          }, function (e) { note({ kind: 'file', name: str(f.name), error: asError(e).message }); });
        });
      });
      return chain;
    }).catch(function () { /* nothing kept, or no shell */ });
  }
  function takeLinks(cb) {
    return call('kr_open_take', { kind: 'url' }).then(function (list) {
      (Array.isArray(list) ? list : []).forEach(function (u) {
        note({ kind: 'url', url: str(u) });
        try { cb(str(u)); } catch (e) { /* the page's */ }
      });
    }).catch(function () { /* nothing kept, or no shell */ });
  }
  // (Taken one at a time: an event that comes while a take is under way takes again after it.)
  function opener(take) {
    return function (cb) {
      if (typeof cb !== 'function') return undefined;
      var busy = false, again = false;
      function run() {
        if (busy) { again = true; return; }
        busy = true;
        take(cb).then(function () { busy = false; if (again) { again = false; run(); } });
      }
      subscribe('kr:openPending', run);
      run();
      return undefined;
    };
  }

  var api = {
    // The OS, in Node's words (process.platform in the preload).
    platform: boot.os || '',

    /* files (the shared crate's files.rs) */
    readFile: function (p) { return call('kr_read_file', { p: str(p) }).then(toArrayBuffer); },
    fileSize: function (p) { return call('kr_file_size', { p: str(p) }); },
    readTextFile: function (p) { return call('kr_folder_read', { p: str(p) }); },
    writeTextFile: function (p, text) { return call('kr_folder_write', { p: str(p), text: str(text) }); },
    writeBinary: function (p, b64, append) { return call('kr_write_binary', { p: str(p), b64: str(b64), append: !!append }); },
    scanDevice: function (exts) { return call('kr_scan_device', { exts: (Array.isArray(exts) ? exts : []).map(str) }); },

    /* opened from outside (stage R2): main.cjs's kr:open-file (+ kr:ready) and kr:open-url */
    onOpenFile: opener(takeFiles),
    onOpenUrl: opener(takeLinks),

    /* dialogs */
    pickFolder: function () { return call('kr_folder_pick'); },
    archivePickDir: function () { return call('kr_archive_pick_dir'); },
    archivePickFile: function (o) { return call('kr_archive_pick_file', { o: { multiple: !!(o && o.multiple) } }); },

    /* the window's own title bar (src-tauri/src/titlebar.rs): titleBar(o) — o.own asks for the app's own bar (true) or
       the system's frame (false), o.act works the window ('minimize', 'maximize' — maximise or restore —, 'close',
       'drag') — answers the state { platform, height, own, wanted, controls, maximized, fullscreen, focused };
       onTitleBarState(cb) — each change of it (the kr:titleBarState event). The page draws the bar, its buttons too:
       src/ui/winbar.ts. */
    titleBar: function (o) { return call('kr_title_bar', { o: obj(o) }); },
    onTitleBarState: function (cb) { return subscribe('kr:titleBarState', cb); },

    /* the system */
    openDefaultApps: function () { return call('kr_default_apps'); },
    // (This build is never the portable one: that is Electron's portable .exe.)
    isPortable: function () { return Promise.resolve(false); },

    /* network: web requests without the page's cross-site limits (the shared crate's net.rs). The body comes as
       base64 and is made text here, in the page's charset, as main.cjs does; accept-encoding is left to the shell. */
    http: function (o) {
      o = obj(o);
      var hs = obj(o.headers); var headers = {};
      Object.keys(hs).forEach(function (k) { if (String(k).toLowerCase() !== 'accept-encoding') headers[k] = hs[k]; });
      var req = { url: o.url, method: o.method || 'GET', headers: headers, binary: true };
      if (o.body !== undefined && o.body !== null) { req.body = o.body; if (o.bodyBase64) req.bodyBase64 = true; }
      return call('kr_http', { o: req }).then(function (r) {
        r = obj(r); var rh = obj(r.headers);
        return { status: r.status, headers: rh, body: o.binary ? String(r.body || '') : decodeText(fromBase64(r.body), rh['content-type']), url: r.url };
      });
    },
  };
  Object.keys(STUBS).forEach(function (k) { api[k] = stub(k); });
  // Names this shell has that Electron's has not (EXTRA): scanFolder(root, exts) — the whole-computer scan's walk
  // in one folder the user picked, answered as scanDevice is. The library's «Pick a folder» scan uses it where it is
  // (src/ui/scan.ts), so its books can be linked by path; Electron, which has not, keeps the web view's folder picker.
  var EXTRA = {
    scanFolder: function (root, exts) { return call('kr_scan_folder', { p: str(root), exts: (Array.isArray(exts) ? exts : []).map(str) }); },
  };
  Object.keys(EXTRA).forEach(function (k) { api[k] = EXTRA[k]; });

  // (For the tests and the self-test: which names are stubs, which are left out, and at what stage each is due.)
  var stages = {}; Object.keys(STUBS).forEach(function (k) { stages[k] = STUBS[k][0]; });
  // (Which shell this is: the page draws the window's whole title bar here — src/ui/winbar.ts, src/platform.ts.)
  try { Object.defineProperty(window, '__KR_SHELL__', { value: 'tauri', configurable: true }); } catch (e) { /* the page then keeps the system's frame */ }
  try { Object.defineProperty(window, '__KR_BRIDGE_STUBS__', { value: Object.freeze(stages), configurable: true }); } catch (e) { /* not needed by the page */ }
  try { Object.defineProperty(window, '__KR_BRIDGE_LEFT_OUT__', { value: Object.freeze(LEFT_OUT), configurable: true }); } catch (e) { /* not needed by the page */ }
  try { Object.defineProperty(window, '__KR_BRIDGE_EXTRA__', { value: Object.freeze(Object.keys(EXTRA)), configurable: true }); } catch (e) { /* not needed by the page */ }
  Object.defineProperty(window, 'kurokawaDesktop', { value: api, enumerable: true, configurable: false, writable: false });
})();
