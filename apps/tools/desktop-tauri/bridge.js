// window.kurokawaTools for the Tauri shell: the same names, arguments and results as desktop/preload.cjs (the
// Electron shell's bridge; the typed shape is src/engine/desktop.ts), each channel kt:xyz a Tauri command kt_xyz.
// Run by src-tauri/src/main.rs as the window's initialization script — before the page's own scripts, on every
// load —, after a line that sets window.__KT_BOOT__ = { os, arch }.
// Only the ported slice is here (../PORTING.md: stage 1 files/dialogs/clipboard/http, stage 2 the download engine,
// stage P3 the recycle bin, free space, fonts, MEGA, the screen translator's fonts, P7 the archives, P4 streaming, P5 the video tools): the page asks for each feature by
// its method (d?.dohProbe, …), so whatever is not ported yet is absent, not a stub. Events (kt:tasks, kt:engineState,
// kt:files) come as Tauri events, listened to with window.__TAURI__.event.listen.
// Some methods are this shell's own, not the preload's: filesJob, filesCancel, filesAnswer and onFilesJob — the Files
// page's copy / move / delete jobs with the phone's shapes (src/views/files.ts uses them where they are; the Electron
// shell has none, so there Copy, Cut and Paste stay hidden) —, and homeDir, filesRoots, filesStat, filesMkdir and
// filesRename (the storages, new folder, rename — again the phone plugin's shapes).
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
  /* (Stage P6 part: the .ico's sizes — the shared iconlogic.rs ICO_SIZES — drawn with the page's canvas from the
     512 px icon the page cropped, halved step by step down to twice the size, then drawn once, smoothed; each a PNG in
     base64: [[16, '…'], …]; [] where the page cannot draw (the shell then writes no .ico). The Reader's bridge's.) */
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
    /* archives (stage P7: src-tauri/src/archives.rs over the shared crate's archive.rs — zip and tar read by the app,
       the rest by the 7-Zip it ships): list, extract (whole, in place, or `only` some entries; «cache:» the temp
       folder), test, make a zip, restore an extraction in place given up, the names already there, cancel; progress
       { id, done, total, file } as kt:archiveProgress (at most every 250 ms). */
    archiveList: function (o) { return call('kt_archive_list', { o: obj(o) }); },
    archiveExtract: function (o) { return call('kt_archive_extract', { o: obj(o) }); },
    archiveTest: function (o) { return call('kt_archive_test', { o: obj(o) }); },
    archiveCreate: function (o) { return call('kt_archive_create', { o: obj(o) }); },
    archiveRestore: function (o) { return call('kt_archive_restore', { o: obj(o) }); },
    archiveExisting: function (o) { return call('kt_archive_existing', { o: obj(o) }); },
    archiveCancel: function (id) { return call('kt_archive_cancel', { id: str(id) }); },
    onArchiveProgress: function (cb) { return subscribe('kt:archiveProgress', cb); },
    fontDirs: function () { return call('kt_font_dirs'); },
    fontIndex: function (dirs) { return call('kt_font_index', { dirs: (Array.isArray(dirs) ? dirs : []).map(str) }); },
    megaDecrypt: function (o) { return call('kt_mega_decrypt', { o: obj(o) }); },
    screenFontAdd: function (o) { return call('kt_screen_font_add', { o: obj(o) }); },
    screenFontRemove: function (o) { return call('kt_screen_font_remove', { o: obj(o) }); },

    /* the Files page's jobs (this shell's own: the phone plugin's shapes — { id, status, … } events as kt:files) */
    // (This shell's own: whether yt-dlp has a JavaScript runtime here — the «deno» pack offered when it has none;
    // vtools.rs. Electron gives yt-dlp its own Node.)
    videoJsRuntime: function () { return call('kt_video_js_runtime', {}); },
    filesJob: function (o) { return call('kt_files_job', { o: obj(o) }); },
    filesCancel: function (o) { return call('kt_files_cancel', { o: obj(o) }); },
    filesAnswer: function (o) { return call('kt_files_answer', { o: obj(o) }); },
    onFilesJob: function (cb) {
      listen();
      fileSubs.push(cb);
      return function () { var k = fileSubs.indexOf(cb); if (k >= 0) fileSubs.splice(k, 1); };
    },
    /* the Files page's storages and single-item changes (this shell's own, the phone plugin's shapes):
       homeDir() → the home folder; filesRoots() → { allFiles, roots: [{ kind: home | downloads | desktop | documents |
       drive, path, name, readable, free?, total? }] }; filesStat({ path }) → { exists, name, path, dir, size, mtime,
       readable, writable, hidden } (shallow); filesMkdir({ path }) / filesRename({ path, name }) → { ok, path } (a name
       taken: rejected with «exists»). */
    homeDir: function () { return call('kt_home_dir'); },
    filesRoots: function () { return call('kt_files_roots'); },
    filesStat: function (o) { return call('kt_files_stat', { o: obj(o) }); },
    filesMkdir: function (o) { return call('kt_files_mkdir', { o: obj(o) }); },
    filesRename: function (o) { return call('kt_files_rename', { o: obj(o) }); },
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

    /* the app's icon of the user's choosing (stage P6 part: src-tauri/src/appicon.rs over the shared appicon.rs):
       appIcon() → the chosen one (a PNG data URL) or null; appIcon({ set: dataUrl }) → chosen — with the .ico's sizes
       drawn here — and put on the window, the taskbar and (Windows) the shortcuts, (Linux) the desktop entry → true;
       appIcon({ set: null }) → the app's own again → true. */
    appIcon: function (o) {
      o = obj(o);
      if (!('set' in o)) return call('kt_app_icon', { o: {} });
      if (!o.set) return call('kt_app_icon', { o: { set: null } });
      var url = str(o.set);
      return iconSizes(url).then(function (sizes) { return call('kt_app_icon', { o: { set: url, sizes: sizes } }); });
    },
    onTitleBarState: function (cb) { return subscribe('kt:titleBarState', cb); },

    /* network */
    http: function (o) { return call('kt_http', { o: obj(o) }); },
    checkUpdate: function (o) { return call('kt_check_update', { o: obj(o) }); },
    /* stage P8: DNS over HTTPS for the app's own requests (the shared crate's resolver; kt-core's dohnames for Tools'
       names), the probe; the updater (src-tauri/src/update.rs over kt-core's updatelogic: this build's own release
       file, resumed, its size and SHA-256 checked, installed per system) and its progress as kt:update-progress.
       updateDownload({ beta }) / updateInstall() are this shell's own: a background download, installed now or silently
       when the app quits. */
    setDoh: function (o) { return call('kt_set_doh', { o: obj(o) }); },
    dohProbe: function () { return call('kt_doh_probe'); },
    installUpdate: function (u) { return call('kt_install_update', { url: str(u) }); },
    onUpdateProgress: function (cb) { return subscribe('kt:update-progress', cb); },
    updateDownload: function (o) { return call('kt_update_download', { o: obj(o) }); },
    updateInstall: function () { return call('kt_update_install'); },

    /* stage P4: torrent streaming and the local stream server (src-tauri/src/streamserver.rs: 127.0.0.1, a port of the
       system's choosing, a random token in every address; the engine behind stream_engine.rs's trait — aria2's
       in-order fetch today, librqbit only in a build with --features rqbit). streamUrl({ id, fileIndex }) → { url };
       streamDone({ id }) → { ok } (the address withdrawn); streamStats({ id }) → { down, up, peers, progress, buffered,
       engine } or null; fileUrl(path) → the address (a string) of a file on this computer, with ranges;
       audioUrl() / videoUrl() → { url } the page adds «?src=…» to (ffmpeg found as the video tools find it — the
       pack, else the PATH, a Mac's Homebrew —; the card's encoder, x264 after it fails); proxyUrl({ url,
       headers }) → the address (a string) that fetches it with those headers (HLS remuxed to MP4). */
    streamUrl: function (o) { return call('kt_stream_url', { o: obj(o) }); },
    streamDone: function (o) { return call('kt_stream_done', { o: obj(o) }); },
    streamStats: function (o) { return call('kt_stream_stats', { o: obj(o) }); },
    fileUrl: function (p) { return call('kt_file_url', { p: str(p) }); },
    audioUrl: function () { return call('kt_audio_url'); },
    videoUrl: function () { return call('kt_video_url'); },
    proxyUrl: function (o) { return call('kt_proxy_url', { o: obj(o) }); },
    /* stage P6 (src-tauri/src/desktop.rs, rules in desklogic.rs): the computer's side of the downloads — desktopPrefs(o)
       → the choices in force (keepAwake, whenDone, notifyDone, tray, hotkeys; this shell also takes o.labels, the
       interface's words for the tray's menu and a Mac's menu bar, and answers hotkeyErrors { mode: why } for a hotkey
       it could not register); mini({ action: open | close | main | auto, on }) → { open }; registerMagnet() → true;
       onHotkeyAdd(cb) ({ mode, text }: a clipboard hotkey pressed), onOpenTask(cb) (a finished download's notice
       followed: see PORTING.md — a computer's notices give no click, so it is the window brought to the front soon
       after). Links the system handed the app reach the page as the preload's kt:open DOM event (below). */
    desktopPrefs: function (o) { return call('kt_desktop_prefs', { o: obj(o) }); },
    mini: function (o) { return call('kt_mini', { o: obj(o) }); },
    registerMagnet: function () { return call('kt_register_magnet'); },
    onHotkeyAdd: function (cb) { return subscribe('kt:hotkeyAdd', cb); },
    onOpenTask: function (cb) { return subscribe('kt:openTask', cb); },
    /* stage P6 (src-tauri/src/sitewin.rs): captureUrl({ url, marker, title }) → the first address carrying the marker,
       or null when the window is closed first; siteWindow({ url, title }) → false unless https, else true once closed. */
    captureUrl: function (o) { return call('kt_capture_url', { o: obj(o) }); },
    siteWindow: function (o) { return call('kt_site_window', { o: obj(o) }); },
    /* stage P7 (src-tauri/src/browser.rs): browse({ url }) → true, the in-app browser; onBrowser(cb) — what it hands the
       app: { kind: 'download', url, name, referer, ua, cookie } (a file or a magnet), { kind: 'links', url, title, links,
       ua } (Grab). */
    browse: function (o) { return call('kt_browse', { o: obj(o) }); },
    onBrowser: function (cb) { return subscribe('kt:browser', cb); },
    /* stage P8 (src-tauri/src/lanshare.rs, rules in lanlogic.rs): shareWifi({ paths, names }) → { url, files };
       shareWifiStop(); shareWifiStatus() → { running, url, sent, hits }; localApi({ on, token, port }) → { on, token,
       port }; avScan({ cfg, file }) → { result, detail, scanner }; avAvailable() → { defender, clamav, platform }. */
    shareWifi: function (o) { return call('kt_share_wifi', { o: obj(o) }); },
    shareWifiStop: function () { return call('kt_share_wifi_stop'); },
    shareWifiStatus: function () { return call('kt_share_wifi_status'); },
    localApi: function (o) { return call('kt_local_api', { o: obj(o) }); },
    avScan: function (o) { return call('kt_av_scan', { o: obj(o) }); },
    avAvailable: function () { return call('kt_av_available'); },
    /* stage P5 — the video tools (src-tauri/src/vtools.rs, vtjobs.rs, vtffmpeg.rs over kt-core's
       videotools / vidjson): yt-dlp fetched, checked, updated, rolled back (videoReady's fetch progress as
       kt:update-progress with what: 'yt-dlp'), `-J` shaped for the Add sheet, a site yt-dlp is always asked about, the
       program of the user's own choosing; gallery-dl's listing; ffmpeg runs with progress (kt:ffmpegProgress), cancel,
       ffprobe's JSON; the ffmpeg pack (kt:packProgress). (videoUrl / audioUrl — the transcode stream and the sound
       track — are stage P4's above: one server, streamproxy.rs, with P5's ffmpeg and encoder rules.) A video
       download is kt_add with o.video, and its task comes in kt:tasks with the others. */
    videoInfo: function (o) { return call('kt_video_info', { o: obj(o) }); },
    videoReady: function () { return call('kt_video_ready'); },
    isVideoHost: function (u) { return call('kt_is_video_host', { u: str(u) }); },
    videoVersion: function () { return call('kt_video_version'); },
    videoRollback: function () { return call('kt_video_rollback'); },
    videoUpdate: function () { return call('kt_video_update'); },
    videoBinary: function (o) { return call('kt_video_binary', { o: obj(o) }); },
    galleryList: function (o) { return call('kt_gallery_list', { o: obj(o) }); },
    galleryReady: function () { return call('kt_gallery_ready'); },
    ffmpegAvailable: function () { return call('kt_ffmpeg_available'); },
    ffmpeg: function (o) { return call('kt_ffmpeg', { o: obj(o) }); },
    ffmpegCancel: function (id) { return call('kt_ffmpeg_cancel', { id: str(id) }); },
    ffprobe: function (p) { return call('kt_ffprobe', { p: str(p) }); },
    onFfmpegProgress: function (cb) { return subscribe('kt:ffmpegProgress', cb); },
    packStatus: function () { return call('kt_pack_status'); },
    packInstall: function (o) { return call('kt_pack_install', { o: obj(o) }); },
    packCancel: function (n) { return call('kt_pack_cancel', { n: str(n) }); },
    packRemove: function (n) { return call('kt_pack_remove', { n: str(n) }); },
    onPackProgress: function (cb) { return subscribe('kt:packProgress', cb); },
    /* screen translator (src-tauri/src/screentr.rs, the capture in screencap.rs, the rules in kt-core's
       screenlogic.rs): screenConfig({ config, clearFixed }) → the status; screenStatus() → { platform, on, keys {
       action: { acc, ok } }, tray, auto, region, ocr } (this shell adds capture { kind, why } and, on a Mac,
       permission 'granted' | 'denied'); screenAction(a) → true (region, full, repeat, auto, clipboard — and this
       shell's 'permission'); screenJob() → the frozen screen's job or null; screenRegion(r | null) → { blocks } or
       { ai, offset, scale }; screenClose(); screenOcrLangs() → { kind, langs | error }; screenCaptionSize({ height })
       (Electron's kt:screenCaption call); onScreenCaption(cb) — { text } for «auto»'s caption window. */
    screenConfig: function (o) { return call('kt_screen_config', { o: obj(o) }); },
    screenStatus: function () { return call('kt_screen_status'); },
    screenAction: function (a) { return call('kt_screen_action', { a: str(a) }); },
    screenJob: function () { return call('kt_screen_job'); },
    screenRegion: function (r) { return call('kt_screen_region', { r: r && typeof r === 'object' ? r : null }); },
    screenClose: function () { return call('kt_screen_close'); },
    screenOcrLangs: function () { return call('kt_screen_ocr_langs'); },
    screenCaptionSize: function (o) { return call('kt_screen_caption', { o: obj(o) }); },
    onScreenCaption: function (cb) { return subscribe('kt:screenCaption', cb); },
  };
  /* stage P6: magnets, links and .torrent files (as data: addresses) the system handed the app — this launch's, a
     second launch's, a Mac's Apple Events — kept by the shell (kt_open_take) and handed to the page as the preload's
     kt:open DOM event once the page listens for it (Electron waits for the page's load the same way), and again on each
     kt:openPending; each noted (its start) in window.__KT_OPEN_LOG__ for the self-test. The mini window: dragged by its
     top (.mini-head, not its buttons), as Electron's app-region. */
  (function () {
    var wanted = false;
    function flush() {
      call('kt_open_take').then(function (list) {
        (Array.isArray(list) ? list : []).forEach(function (u) {
          try { window.__KT_OPEN_LOG__ = (window.__KT_OPEN_LOG__ || []).concat([String(u).slice(0, 80)]); } catch (e) { /* frozen */ }
          try { window.dispatchEvent(new CustomEvent('kt:open', { detail: u })); } catch (e) { /* no DOM */ }
        });
      }).catch(function () {});
    }
    try {
      var add = window.addEventListener;
      if (typeof add === 'function') {
        window.addEventListener = function (type) {
          var r = add.apply(this, arguments);
          if (type === 'kt:open' && !wanted) {
            wanted = true;
            setTimeout(flush, 0);
            var on = listener();
            if (on) { try { Promise.resolve(on('kt:openPending', function () { flush(); })).catch(function () {}); } catch (e) { /* none */ } }
          }
          return r;
        };
        add.call(window, 'mousedown', function (e) {
          try {
            if (!String(location.hash).startsWith('#/mini') || e.button !== 0) return;
            var t = e.target; if (!t || !t.closest || !t.closest('.mini-head') || t.closest('button')) return;
            call('kt_title_bar', { o: { act: 'drag' } }).catch(function () {});
          } catch (x) { /* not a page */ }
        });
      }
    } catch (e) { /* no DOM */ }
  })();
  // (Start-up timing — the Reader's bootMarks, Tools' command: src-tauri/src/boot.rs. The page's first paint and its
  // first screen in place, from the program's start; its interface's colour (<meta name="theme-color">) kept so the
  // window opens in it at the next start. The main window only: the mini window and the screen translator's do not
  // mark.)
  (function bootMarks() {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    try { var w = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.metadata && window.__TAURI_INTERNALS__.metadata.currentWindow; if (w && w.label && w.label !== 'main') return; } catch (e) { return; }
    function colour() { var m = document.querySelector('meta[name="theme-color"]'); return (m && m.getAttribute('content')) || null; }
    function mark(what) { call('kt_boot_mark', { what: what, bg: colour() }).catch(function () { /* no shell */ }); }
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
  // (Which shell this is: the page draws the window's whole title bar here — src/ui/winbar.ts —, and the Files page
  // has its jobs.)
  try { Object.defineProperty(window, '__KT_SHELL__', { value: 'tauri', configurable: true }); } catch (e) { /* the page then keeps Electron's bar */ }
  Object.defineProperty(window, 'kurokawaTools', { value: api, enumerable: true, configurable: false, writable: false });
})();
