// window.kurokawaDesktop for the Tauri shell: every name desktop/preload.cjs (the Electron shell's bridge) gives the
// page, with the same arguments and results. Run by src-tauri/src/main.rs as the window's initialization script —
// before the page's own scripts, on every load —, after a line that sets window.__KR_BOOT__ = { os, arch }.
// Each Electron channel kr:a-b is the Tauri command kr_a_b (src-tauri/src/commands.rs). What is not ported yet
// (PORTING.md says which stage brings it) is a stub that answers as Electron answers when it cannot do the thing —
// false, null, 'unsupported', an empty result — or, where Electron has no such answer, rejects with an Error that
// names the stage; the page already copes with each (PORTING.md says how). The stubs are listed in STUBS below, so
// tests/tauribridge.cjs and the self-test can tell them from the ported ones.
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
    appIcon: ['R5', 'appIcon'], titleBar: ['R5', null], onTitleBarState: ['R5', 'off'], setZoom: ['R5', 'none'],
    onOpenFile: ['R2', 'none'],
    installUpdate: ['R6', 'reject'], downloadUpdate: ['R6', 'unsupported'], installDownloadedUpdate: ['R6', false], onUpdateProgress: ['R6', 'none'],
    archiveList: ['R5', 'reject'], archiveExtract: ['R5', 'reject'], archiveCancel: ['R5', undefined], archiveCreate: ['R5', 'reject'], archiveTest: ['R5', 'reject'],
    archiveRestore: ['R5', 'reject'], archiveFree: ['R5', 'reject'], archiveExisting: ['R5', 'reject'], onArchiveProgress: ['R5', 'off'],
    setFullscreen: ['R5', false], setImmersive: ['R5', false], copyImage: ['R5', false], printToPdf: ['R5', 'reject'],
    setDoh: ['R3', 'setDoh'], openWebView: ['R4', { passed: false, blocked: false, title: '' }], browserFetch: ['R4', 'reject'],
    browserReset: ['R4', true], browserForget: ['R4', { cleared: 0 }], notify: ['R3', false],
    download: ['R3', 'reject'], deleteDownload: ['R3', false], onDownloadProgress: ['R3', 'none'], addDownloadListener: ['R3', 'off'],
    onOpenUrl: ['R2', 'none'], onCommand: ['R5', 'none'], setProgress: ['R5', 'none'],
  };
  function notYet(name, stage) { return new Error(name + ' is not in this preview build yet (Tauri stage ' + stage + ')'); }
  function copy(v) { return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v; }
  function stub(name) {
    var stage = STUBS[name][0]; var how = STUBS[name][1];
    if (how === 'reject') return function () { return Promise.reject(notYet(name, stage)); };
    if (how === 'none') return function () { return undefined; };
    if (how === 'off') return function () { return function () { /* nothing to remove */ }; };
    // (appIcon(): asked which icon is in use → none chosen (null), as main.cjs answers; asked to set one → not yet.)
    if (how === 'appIcon') return function (o) { return o && typeof o === 'object' && 'set' in o ? Promise.reject(notYet(name, stage)) : Promise.resolve(null); };
    // (setDoh(): asked which resolver → 'off'; asked to test it → a failed test, saying why; asked to set one → not yet.)
    if (how === 'setDoh') {
      return function (provider, test) {
        if (provider !== undefined && provider !== null) return Promise.reject(notYet(name, stage));
        if (!test) return Promise.resolve({ provider: 'off' });
        return Promise.resolve({ provider: 'off', ok: false, error: notYet(name, stage).message });
      };
    }
    return function () { return Promise.resolve(copy(how)); };
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

    /* dialogs */
    pickFolder: function () { return call('kr_folder_pick'); },
    archivePickDir: function () { return call('kr_archive_pick_dir'); },
    archivePickFile: function (o) { return call('kr_archive_pick_file', { o: { multiple: !!(o && o.multiple) } }); },

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

  // (For the tests and the self-test: which names are stubs, and at what stage each is due.)
  var stages = {}; Object.keys(STUBS).forEach(function (k) { stages[k] = STUBS[k][0]; });
  try { Object.defineProperty(window, '__KR_BRIDGE_STUBS__', { value: Object.freeze(stages), configurable: true }); } catch (e) { /* not needed by the page */ }
  Object.defineProperty(window, 'kurokawaDesktop', { value: api, enumerable: true, configurable: false, writable: false });
})();
