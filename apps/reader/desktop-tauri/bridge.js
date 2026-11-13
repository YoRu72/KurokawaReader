// window.kurokawaDesktop for the Tauri shell: every name desktop/preload.cjs (the Electron shell's bridge) gives the
// page, with the same arguments and results. Run by src-tauri/src/main.rs as the window's initialization script —
// before the page's own scripts, on every load —, after a line that sets window.__KR_BOOT__ = { os, arch }.
// Each Electron channel kr:a-b is the Tauri command kr_a_b (src-tauri/src/commands.rs and the files beside it). What
// is not ported yet (PORTING.md says which stage brings it — nothing since R6b) is a stub that answers as Electron
// answers when it cannot do the thing — or, where Electron has no such answer, rejects with an Error that names the
// stage; the page already copes with each (PORTING.md says how). The stubs are listed in STUBS below, so
// tests/tauribridge.cjs and the self-test can tell them from the ported ones. Some names are LEFT OUT instead (LEFT_OUT
// below): the page tests for those before it uses them, and without them it takes a way that works — its picture PDF
// (printToPdf: this shell has no silent PDF printing, for good — 'fallback').
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
  // (None since R6b: the updater is here — see «updates» below.)
  var STUBS = {};
  // name → the stage that brings it, or 'fallback': left out for good, the page's own way being this shell's answer.
  // Not defined at all: the page looks for each before using it, and without it does what works here (src/:
  // convert.ts buildPdf → the picture PDF — searchable text over page pictures — where Electron prints a text PDF in
  // a hidden window: no web view this shell runs on prints a PDF silently through Tauri). (The in-app browser's four,
  // R4, R5's archives, app icon and full screen, and R6b's updater are here since their stages.)
  var LEFT_OUT = {
    printToPdf: 'fallback',
  };
  /* ---------- R5: pictures made with the page's canvas ---------- */
  // The .ico's sizes (src-tauri/src/iconlogic.rs ICO_SIZES) rendered from the 512 px icon the page cropped — halved
  // step by step down to twice the size, then drawn once, smoothed —, each a PNG in base64: [[16, '…'], …]; [] where
  // the page cannot draw (the shell then writes no .ico).
  var ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
  function b64Of(dataUrl) { var i = String(dataUrl).indexOf(','); return i >= 0 ? String(dataUrl).slice(i + 1) : ''; }
  function iconSizes(url) {
    return new Promise(function (resolve) {
      try {
        if (typeof document === 'undefined' || typeof Image === 'undefined') { resolve([]); return; }
        var img = new Image();
        img.onload = function () {
          var out = [];
          try {
            ICO_SIZES.forEach(function (n) {
              var src = img; var w = img.naturalWidth || img.width; var h = img.naturalHeight || img.height;
              while (w >= n * 4 && h >= n * 4) {
                var half = document.createElement('canvas'); half.width = Math.round(w / 2); half.height = Math.round(h / 2);
                var hg = half.getContext('2d'); hg.imageSmoothingEnabled = true; hg.imageSmoothingQuality = 'high'; hg.drawImage(src, 0, 0, half.width, half.height);
                src = half; w = half.width; h = half.height;
              }
              var c = document.createElement('canvas'); c.width = n; c.height = n;
              var g = c.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, n, n);
              out.push([n, b64Of(c.toDataURL('image/png'))]);
            });
          } catch (e) { out = []; }
          resolve(out);
        };
        img.onerror = function () { resolve([]); };
        img.src = url;
      } catch (e) { resolve([]); }
    });
  }
  // A picture for the clipboard as a PNG in base64: a PNG as it is; any other (JPEG, WebP…) drawn on a canvas and
  // made one (the shell reads PNG only); as it came where the page cannot draw (the shell then answers false).
  function asPng(b64) {
    b64 = String(b64 || '');
    if (b64.indexOf('iVBORw0KGgo') === 0) return Promise.resolve(b64);
    try {
      if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return Promise.resolve(b64);
      return createImageBitmap(new Blob([fromBase64(b64)])).then(function (bmp) {
        var c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
        c.getContext('2d').drawImage(bmp, 0, 0);
        try { bmp.close(); } catch (e) { /* gone */ }
        return b64Of(c.toDataURL('image/png'));
      }).catch(function () { return b64; });
    } catch (e) { return Promise.resolve(b64); }
  }
  // The window's changes (full screen, immersive, zoom) sent one after another, each once the one before has answered:
  // Tauri runs async commands side by side, so a book closed and another opened at once (immersive off, then on) or
  // the library's zoom and the reader's asked together could land in either order and leave the wrong one in force.
  var winQ = Promise.resolve(), winBusy = 0;
  function inOrder(fn) {
    var p = winBusy ? winQ.then(fn, fn) : fn();
    winBusy++;
    var done = function () { winBusy--; };
    winQ = p.then(done, done);
    return p;
  }
  // The interface's size where this build's Tauri cannot zoom the web view: the page zoomed with CSS (1: none).
  function cssZoom(v) { try { document.documentElement.style.zoom = v === 1 ? '' : String(v); } catch (e) { /* no page */ } }
  // Whether the web view's own zoom shows. Linux: WebKitGTK answered set_zoom without any change the page could see
  // (the page's width in CSS pixels stayed the same — CI run 43490057742: 1072 → 1072 px), so there it is learnt at
  // the first change of size and kept for this run of the window (sessionStorage outlives a reload, as the web view's
  // zoom does). WebView2 and WKWebView zoom (935 → 822, 930 → 819 px). `__KR_ZOOM_WAY__`: 'native' or 'css'.
  var zoomNow = 1, zoomNative = boot.os === 'linux' ? null : true;
  try { zoomNow = Number(sessionStorage.getItem('kr.zoom.now')) || 1; var zn = sessionStorage.getItem('kr.zoom.native'); if (zoomNative === null) zoomNative = zn === '1' ? true : zn === '0' ? false : null; } catch (e) { /* none */ }
  function zoomKeep(v, native) {
    zoomNow = v; if (native !== undefined) zoomNative = native; window.__KR_ZOOM_WAY__ = zoomNative === false ? 'css' : 'native';
    try { sessionStorage.setItem('kr.zoom.now', String(v)); if (zoomNative !== null) sessionStorage.setItem('kr.zoom.native', zoomNative ? '1' : '0'); } catch (e) { /* none */ }
  }
  /** Resolves true once the page's width moved from `w0` (the web view's zoom came through), false after `ms`. */
  function widthMoved(w0, ms) {
    if (typeof window.innerWidth !== 'number') return Promise.resolve(true);
    return new Promise(function (res) {
      var left = Math.ceil(ms / 40);
      (function look() { if (Math.abs(window.innerWidth - w0) >= 2) res(true); else if (left-- <= 0) res(false); else setTimeout(look, 40); })();
    });
  }
  function setZoomNow(v) {
    if (zoomNative === false) { cssZoom(v); zoomKeep(v); return Promise.resolve(false); }
    var w0 = window.innerWidth, from = zoomNow;
    return call('kr_set_zoom', { f: v }).then(function (ok) {
      // (This build's Tauri has no set_zoom: false, asked again each time — cheap —; only the width check is kept.)
      if (ok !== true) { cssZoom(v); zoomKeep(v); return false; }
      cssZoom(1);
      // (Known to work, or no change of size asked: nothing to see.)
      if (zoomNative === true || Math.abs(v - from) < 0.01) { zoomKeep(v); return true; }
      return widthMoved(w0, 700).then(function (moved) {
        if (moved) { zoomKeep(v, true); return true; }
        // (Said done, nothing changed: the web view back at 100 % and the page zoomed with CSS from now on.)
        return call('kr_set_zoom', { f: 1 }).catch(function () {}).then(function () { cssZoom(v); zoomKeep(v, false); return false; });
      });
    }, function () { cssZoom(v); zoomKeep(v); return false; });
  }

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

  /* ---------- downloads (stage R3: src-tauri/src/download.rs) ---------- */
  // main.cjs's kr:download-progress reaches every listener: onDownloadProgress(cb) first removes them all (the
  // preload's removeAllListeners) and adds cb; addDownloadListener(cb) adds one and answers its remover. One Tauri
  // listening serves them all (set up once Tauri's event API is there: tried again with each listener added).
  var dlListeners = []; var dlListening = false;
  function dlListen() {
    if (dlListening || !listener()) return; dlListening = true;
    subscribe('kr:download-progress', function (p) { dlListeners.slice().forEach(function (f) { try { f(p); } catch (e) { /* the page's */ } }); });
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
    // (The portable zip of this build — R6b: a KurokawaReader.portable file beside the program, update.rs —; never
    // Electron's portable .exe.)
    isPortable: function () { return Promise.resolve(boot.kind === 'portable'); },

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
    // DNS over HTTPS for the app's own requests (the shared net.rs, doh.rs): setDoh(provider) keeps and applies a
    // provider ('off', a name, an https:// address); setDoh(null, host) tries https://host/ with it → { provider, ok,
    // status, ms } / { provider, ok: false, error }. (The web view's own requests keep the system's DNS.)
    setDoh: function (provider, test) { return call('kr_set_doh', { provider: provider === undefined || provider === null ? null : str(provider), test: test ? str(test) : null }); },

    /* downloads: download(url, name, id) → the file's path in the app's downloads folder; progress events as main.cjs's
       { id, pct, got, total, speed, connections }; deleteDownload(p) → true when it was in that folder */
    download: function (url, name, id) { return call('kr_download', { url: str(url), name: str(name), id: id === undefined || id === null ? null : str(id) }); },
    deleteDownload: function (p) { return call('kr_delete_download', { p: str(p) }); },
    onDownloadProgress: function (cb) { dlListeners.length = 0; if (typeof cb === 'function') { dlListeners.push(cb); dlListen(); } return undefined; },
    addDownloadListener: function (cb) {
      if (typeof cb !== 'function') return function () {};
      dlListeners.push(cb); dlListen();
      return function () { var i = dlListeners.indexOf(cb); if (i >= 0) dlListeners.splice(i, 1); };
    },

    // A system notification (the notification plugin): → true when shown. (A click on it does not open the app at
    // o.hash, as Electron's does: the plugin gives no click on a computer.)
    notify: function (o) { return call('kr_notify', { o: obj(o) }); },

    /* the app's own browser, for the sites that answer only a browser (stage R4: src-tauri/src/browser.rs; main.cjs's
       kr:open-webview, kr:browser-fetch, kr:browser-reset, kr:browser-forget). openWebView(o) — a site's check passed
       out of sight ({hidden}) or by the reader in a window titled {message}; {stay} until the reader closes it;
       {until} until its address matches (given back as url); {browse} the browser as a browser — → { passed,
       blocked, title, url? }. browserFetch(o) — a request made by a page of the site itself (its cookies, its user
       agent) → { status, headers, body, url, via: 'browser' }, the body base64 from the shell and made text here in
       the page's charset unless o.binary, as http's is; a site that would not let the browser through answers 403
       with x-kr-lane. browserReset(url) — the site's window set aside → true. browserForget(url, all) — the site's
       clearance, or (all) every site's data, forgotten → { cleared }. */
    openWebView: function (o) { return call('kr_open_webview', { o: typeof o === 'string' ? { url: o } : obj(o) }); },
    browserFetch: function (o) {
      o = obj(o);
      return call('kr_browser_fetch', { o: o }).then(function (r) {
        r = obj(r); var rh = obj(r.headers);
        return { status: r.status, headers: rh, body: o.binary ? String(r.body || '') : decodeText(fromBase64(r.body), rh['content-type']), url: r.url, via: r.via || 'browser' };
      });
    },
    browserReset: function (url) { return call('kr_browser_reset', { url: str(url) }); },
    browserForget: function (url, all) { return call('kr_browser_forget', { url: str(url), all: !!all }); },

    /* archives (stage R5: src-tauri/src/archive.rs, archives.rs — desktop/archive.cjs's own ZIP and tar readers, and
       the 7-Zip program shipped with the app for the rest): the same objects in and out as main.cjs's kr:archive-*;
       progress as the kr:archive-progress event, { id, done, total, file }. */
    archiveList: function (o) { return call('kr_archive_list', { o: obj(o) }); },
    archiveExtract: function (o) { return call('kr_archive_extract', { o: obj(o) }); },
    archiveCancel: function (id) { return call('kr_archive_cancel', { id: str(id) }); },
    archiveCreate: function (o) { return call('kr_archive_create', { o: obj(o) }); },
    archiveTest: function (o) { return call('kr_archive_test', { o: obj(o) }); },
    archiveRestore: function (o) { return call('kr_archive_restore', { o: obj(o) }); },
    archiveFree: function (o) { return call('kr_archive_free', { o: obj(o) }); },
    archiveExisting: function (o) { return call('kr_archive_existing', { o: obj(o) }); },
    onArchiveProgress: function (cb) { return subscribe('kr:archive-progress', cb); },

    /* the app's icon of the user's choosing (stage R5: src-tauri/src/appicon.rs): appIcon() → the chosen one (a PNG
       data URL) or null; appIcon({ set: dataUrl }) → chosen — with the .ico's sizes drawn here — and put on the
       window, the taskbar and (Windows) the shortcuts, (Linux) the desktop entry → true; appIcon({ set: null }) →
       the app's own again → true. */
    appIcon: function (o) {
      o = obj(o);
      if (!('set' in o)) return call('kr_app_icon', { o: {} });
      if (!o.set) return call('kr_app_icon', { o: { set: null } });
      var url = str(o.set);
      return iconSizes(url).then(function (sizes) { return call('kr_app_icon', { o: { set: url, sizes: sizes } }); });
    },

    /* the window (stage R5: src-tauri/src/winbits.rs) */
    // The window full screen ('toggle': the other way) → its new state; the app's own title bar hides meanwhile.
    setFullscreen: function (v) { return inOrder(function () { return call('kr_fullscreen', { v: v === 'toggle' ? 'toggle' : !!v }); }); },
    // The reader's immersive mode: the window full screen → true.
    setImmersive: function (on) { return inOrder(function () { return call('kr_immersive', { on: !!on }); }); },
    // The interface's size (0.5–2): the web view's zoom, or — where this build cannot — the page's CSS zoom.
    setZoom: function (f) {
      var v = Number(f); if (!(v >= 0.5 && v <= 2)) return undefined;
      inOrder(function () { return setZoomNow(v); }).catch(function () { cssZoom(v); });
      return undefined;
    },
    // Long work's progress (0–1; below 0 takes it away) on the taskbar button.
    setProgress: function (p) { call('kr_progress', { p: typeof p === 'number' && isFinite(p) ? p : -1 }).catch(function () {}); return undefined; },
    // A picture on the system clipboard → true; false when it cannot (the page then tries the web's clipboard).
    copyImage: function (b64) { return asPng(b64).then(function (png) { return call('kr_copy_image', { b64: png }); }); },
    // The commands of a Mac's menu bar ('import', 'scan', 'library', 'settings', 'options', 'search', 'update'), as
    // main.cjs's kr:command; on Windows and Linux there is no menu bar (the page's own keys and buttons).
    onCommand: function (cb) { subscribe('kr:command', cb); return undefined; },
  };
  Object.keys(STUBS).forEach(function (k) { api[k] = stub(k); });

  /* ---------- updates (stage R6b: src-tauri/src/update.rs, updatelogic.rs) ---------- */
  // main.cjs's four, the same arguments and answers. installUpdate(url, o) — the release file for this kind of copy
  // downloaded (resumed if a connection breaks), checked against the release's size and SHA-256 (o.digest: GitHub's;
  // the release's SHA256SUMS file), installed → 'installing' / 'relaunching' / 'kr-update:deb-opened' /
  // 'kr-update:mac-opened'; refusals reject with «kr-update:…» codes the page turns into sentences (src/updates.ts).
  // downloadUpdate({beta}) — fetched and checked in the background → 'downloaded' / 'none' / 'unsupported';
  // installDownloadedUpdate() → whether there was one to install (installed now, the app started again).
  // onUpdateProgress(cb) — { pct, got, total, speed } (and { verifying: true }) as the kr:update-progress event; a new
  // callback replaces the last (the preload's removeAllListeners).
  var updCb = null; var updListening = false;
  api.installUpdate = function (url, o) { return call('kr_install_update', { url: str(url), o: obj(o) }); };
  api.downloadUpdate = function (o) { return call('kr_update_download', { o: obj(o) }); };
  api.installDownloadedUpdate = function () { return call('kr_update_install'); };
  api.onUpdateProgress = function (cb) {
    updCb = typeof cb === 'function' ? cb : null;
    if (!updListening && listener()) { updListening = true; subscribe('kr:update-progress', function (p) { if (updCb) updCb(p); }); }
    return undefined;
  };
  // The page's start, told to the shell (src-tauri/src/boot.rs): its first paint, its first screen in place (the
  // start-up times the self-test prints), and its interface's colour — kept for the next start, when the window
  // opens in it rather than in white.
  (function bootMarks() {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    function colour() { var m = document.querySelector('meta[name="theme-color"]'); return (m && m.getAttribute('content')) || null; }
    function mark(what) { call('kr_boot_mark', { what: what, bg: colour() }).catch(function () { /* no shell */ }); }
    var later = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : function (f) { return setTimeout(f, 16); };
    function painted() { later(function () { mark('paint'); }); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', painted); else painted();
    var tries = 0;
    (function ready() {
      var app = document.getElementById('app');
      if (app && app.firstElementChild) { mark('ready'); watchColour(); return; }
      if (++tries < 600) setTimeout(ready, 25);
    })();
    function watchColour() {
      var m = document.querySelector('meta[name="theme-color"]'); var last = colour(); var t = 0;
      if (!m || typeof MutationObserver !== 'function') return;
      new MutationObserver(function () { var c = colour(); if (c === last) return; last = c; clearTimeout(t); t = setTimeout(function () { mark('theme'); }, 500); }).observe(m, { attributes: true });
    }
  })();
  // Names this shell has that Electron's has not (EXTRA): scanFolder(root, exts) — the whole-computer scan's walk
  // in one folder the user picked, answered as scanDevice is. The library's «Pick a folder» scan uses it where it is
  // (src/ui/scan.ts), so its books can be linked by path; Electron, which has not, keeps the web view's folder picker.
  // cancelDownload(id) (R3) — the download started with that id stopped (it rejects with «cancelled») → whether one
  // was under way; the downloads list cancels with it where it is (src/downloads.ts; Electron's downloads run on).
  // menuText(labels) (R5) — a Mac's menu bar in the interface's words ({ about, settings, file, … }; src/native.ts
  // sends them) → true on a Mac, false elsewhere. printFile(b64, name) (R5, macOS and Linux only) — a PDF opened in
  // the system's PDF program to print (share.ts printPdf uses it where it is: a Mac's and Linux's web views print no
  // PDF in a frame; on Windows WebView2's own print dialog does, as Electron's).
  var EXTRA = {
    scanFolder: function (root, exts) { return call('kr_scan_folder', { p: str(root), exts: (Array.isArray(exts) ? exts : []).map(str) }); },
    cancelDownload: function (id) { return call('kr_download_cancel', { id: str(id) }); },
    menuText: function (labels) { return call('kr_menu', { labels: obj(labels) }); },
  };
  if (boot.os && boot.os !== 'win32') EXTRA.printFile = function (b64, name) { return call('kr_print_file', { b64: str(b64), name: str(name || 'document.pdf') }); };
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
