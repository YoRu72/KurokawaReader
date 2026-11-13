// The Reader's Tauri shell, its runtime self-test (CI only). Added after bridge.js to the window's initialization
// script by src-tauri/src/selftest.rs only when the KR_SELFTEST environment variable is set, after a line that sets
// window.__KR_SELFTEST__ = { base, temp, home, text, gzText, latinText, binB64, os, version, minWidth, minHeight }.
// Without that object it does nothing. Once the page has loaded it waits for the library to render, then runs its
// checks through window.kurokawaDesktop — the same calls the page makes — and a few kr_selftest_* commands (the
// shared crate's clipboard, window state and update check, which the Reader's bridge does not expose), sends the
// results so far to kr_selftest_progress after each, and the whole list to kr_selftest_done, which writes them and
// ends the process (0 all required checks passed, 1 not). A check is { name, ok, detail, required }. The pure parts
// are on window.__KR_SELFTEST_LIB__ for tests/tauribridge.cjs.
(function (root) {
  'use strict';
  // Every name desktop/preload.cjs gives the page (tests/tauribridge.cjs keeps this list equal to the preload's).
  var NAMES = ['appIcon', 'titleBar', 'onTitleBarState', 'setZoom', 'onOpenFile', 'platform', 'installUpdate', 'downloadUpdate', 'installDownloadedUpdate', 'onUpdateProgress', 'isPortable', 'archiveList', 'archiveExtract', 'archiveCancel', 'archiveCreate', 'archiveTest', 'archiveRestore', 'archiveFree', 'archiveExisting', 'archivePickFile', 'archivePickDir', 'onArchiveProgress', 'scanDevice', 'readFile', 'openDefaultApps', 'setFullscreen', 'setImmersive', 'copyImage', 'printToPdf', 'http', 'setDoh', 'openWebView', 'browserFetch', 'browserReset', 'browserForget', 'notify', 'pickFolder', 'readTextFile', 'writeTextFile', 'download', 'deleteDownload', 'onDownloadProgress', 'addDownloadListener', 'writeBinary', 'fileSize', 'onOpenUrl', 'onCommand', 'setProgress'];
  // The release the canned list offers, and its asset for each OS (shared/shell-rs/src/testserver.rs's RELEASES).
  var ASSET = { win32: 'https://example.invalid/s/w.exe', darwin: 'https://example.invalid/s/m.dmg', linux: 'https://example.invalid/s/l.AppImage' };

  /** 0 when there are results and every required one passed, 1 otherwise (what the shared selftest.rs decides too). */
  function verdict(results) {
    if (!Array.isArray(results) || !results.length) return 1;
    for (var i = 0; i < results.length; i++) { var r = results[i]; if (r.required !== false && r.ok !== true) return 1; }
    return 0;
  }
  function bytesOf(buf) {
    if (!buf) return [];
    if (Array.isArray(buf)) return buf;
    try { return Array.prototype.slice.call(new Uint8Array(buf)); } catch (e) { return []; }
  }
  function sameBytes(buf, want) { var a = bytesOf(buf); if (a.length !== want.length) return false; for (var i = 0; i < a.length; i++) if (a[i] !== want[i]) return false; return true; }
  function utf8(s) { var out = []; var b = unescape(encodeURIComponent(s)); for (var i = 0; i < b.length; i++) out.push(b.charCodeAt(i)); return out; }
  function join(dir, name, os) { var sep = os === 'win32' ? '\\' : '/'; return String(dir).replace(/[\\/]+$/, '') + sep + name; }
  function short(x) { var s; try { s = typeof x === 'string' ? x : JSON.stringify(x); } catch (e) { s = String(x); } return s && s.length > 300 ? s.slice(0, 300) + '…' : String(s); }

  /**
   * The checks. kd: window.kurokawaDesktop. stubs: { name: stage } (window.__KR_BRIDGE_STUBS__).
   * env: { sleep(ms), invoke(cmd, args), doc (document), now(), leftOut ({ name: stage }: window.__KR_BRIDGE_LEFT_OUT__) }.
   * Resolves with the results, after kr_selftest_done.
   */
  async function run(kd, stubs, cfg, env, results) {
    results = results || [];
    var sleep = env.sleep;
    function progress() { try { Promise.resolve(env.invoke('kr_selftest_progress', { results: results })).catch(function () {}); } catch (e) { /* none */ } }
    function rec(name, ok, detail, required) { results.push({ name: name, ok: !!ok, detail: short(detail === undefined ? '' : detail), required: required !== false }); progress(); return !!ok; }
    function within(p, ms, what) {
      var t = null;
      var limit = new Promise(function (_ok, no) { t = setTimeout(function () { no(new Error('timeout: ' + what)); }, ms); });
      return Promise.race([p, limit]).then(function (v) { clearTimeout(t); return v; }, function (e) { clearTimeout(t); throw e; });
    }
    async function check(name, required, fn, ms) {
      try { var d = await within(Promise.resolve().then(fn), ms || 20000, name); return rec(name, true, d, required); }
      catch (e) { return rec(name, false, (e && e.message) || String(e), required); }
    }
    function must(cond, what) { if (!cond) throw new Error(what); }
    async function waitFor(fn, ms, what) { var until = env.now() + ms; for (;;) { var v = fn(); if (v) return v; if (env.now() > until) throw new Error('timeout: ' + what); await sleep(200); } }
    async function rejects(p) { try { await p; return null; } catch (e) { return e; } }
    function done() { return Promise.resolve(env.invoke('kr_selftest_done', { results: results })).catch(function () { /* the watchdog writes what there is */ }); }

    var leftOut = env.leftOut || {};
    await check('bridge: every preload name (or left out until its stage)', true, function () {
      must(kd, 'no window.kurokawaDesktop');
      var missing = NAMES.filter(function (k) { return !(k in leftOut) && (k === 'platform' ? typeof kd.platform !== 'string' : typeof kd[k] !== 'function'); });
      must(!missing.length, 'missing ' + missing.join(', '));
      var there = Object.keys(leftOut).filter(function (k) { return k in kd; });
      must(!there.length, 'left out but there: ' + there.join(', '));
      must(kd.platform === cfg.os, 'platform ' + kd.platform + ' ≠ ' + cfg.os);
      var n = Object.keys(leftOut).length;
      return (NAMES.length - 1 - n) + ' functions + platform ' + kd.platform + ', ' + Object.keys(stubs || {}).length + ' of them stubs; ' + n + ' left out';
    });
    if (!kd) { await done(); return results; }

    await check('library rendered', true, async function () {
      var d = env.doc;
      await waitFor(function () { return d && d.querySelector && d.querySelector('.library-view'); }, 30000, 'the library view');
      // (The computer's sidebar comes with a window 720 px wide or more — the bridge's presence is what makes it a
      // computer.)
      await sleep(300);
      var rail = d.querySelectorAll('.nav-rail .rail-item').length;
      return 'library view, ' + (rail ? 'sidebar with ' + rail + ' places' : 'no sidebar (narrow window?)');
    }, 35000);

    /* files: write → read → size → append → overwrite → remove */
    var txt = join(cfg.temp, 'kr-selftest-' + env.now() + '.txt', cfg.os);
    var text = 'abc ✓ نص';
    await check('writeTextFile → readTextFile → fileSize → readFile', true, async function () {
      must((await kd.writeTextFile(txt, text)) === true, 'writeTextFile did not answer true');
      var back = await kd.readTextFile(txt); must(back === text, 'readTextFile ' + short(back));
      var n = await kd.fileSize(txt); must(n === utf8(text).length, 'fileSize ' + n + ' ≠ ' + utf8(text).length);
      var b = await kd.readFile(txt); must(sameBytes(b, utf8(text)), 'readFile ' + short(bytesOf(b)));
      return txt + ', ' + n + ' bytes';
    });
    await check('writeBinary (append, then overwrite)', true, async function () {
      var before = await kd.fileSize(txt);
      must((await kd.writeBinary(txt, 'AAEC/w==', true)) === true, 'append did not answer true');
      must((await kd.fileSize(txt)) === before + 4, 'size after append');
      var b = bytesOf(await kd.readFile(txt)); must(sameBytes(b.slice(-4), [0, 1, 2, 255]), 'appended bytes ' + short(b.slice(-4)));
      await kd.writeBinary(txt, 'eHl6', false);
      must((await kd.readTextFile(txt)) === 'xyz', 'overwrite');
      return 'appended 4 bytes, then overwrote with 3';
    });
    await check('remove → fileSize -1, readTextFile null, readFile rejects', true, async function () {
      must((await env.invoke('kr_selftest_remove', { p: txt })) === true, 'not removed');
      must((await kd.fileSize(txt)) === -1, 'fileSize of a missing file');
      must((await kd.readTextFile(txt)) === null, 'readTextFile of a missing file');
      var e = await rejects(kd.readFile(txt)); must(e instanceof Error, 'readFile of a missing file did not reject with an Error');
      return 'gone';
    });

    /* the whole-computer scan finds a file put in the home folder */
    await check('scanDevice', true, async function () {
      var ext = 'krselftest';
      var name = 'kr-selftest-' + env.now() + '.' + ext;
      var p = join(cfg.home, name, cfg.os);
      await kd.writeTextFile(p, 'scan me');
      try {
        var r = await kd.scanDevice([ext.toUpperCase()]);
        must(r && Array.isArray(r.files) && typeof r.root === 'string' && r.root.length > 0, 'answer ' + short(r));
        var f = r.files.filter(function (x) { return x.name === name; })[0];
        must(f && f.size === 7 && f.path === p, 'not found: ' + short(r.files.slice(0, 5)));
        return r.files.length + ' file(s) in ' + r.root + (r.truncated ? ' (truncated)' : '');
      } finally { await env.invoke('kr_selftest_remove', { p: p }); }
    }, 120000);

    /* web requests (the shared net.rs, and the bridge's charset decoding) against the loopback test server */
    var base = cfg.base;
    await check('http text + headers', true, async function () { must(base, 'no test server'); var r = await kd.http({ url: base + '/text' }); must(r.status === 200, 'status ' + r.status); must(r.body === cfg.text, 'body ' + short(r.body)); must(r.headers['x-kt-test'] === '1', 'x-kt-test ' + r.headers['x-kt-test']); must(r.headers['x-kt-multi'] === 'a, b', 'x-kt-multi ' + r.headers['x-kt-multi']); return r.body; });
    await check('http redirect', true, async function () { var r = await kd.http({ url: base + '/redirect' }); must(r.status === 200 && r.body === cfg.text, 'status ' + r.status + ' ' + short(r.body)); must(/\/text$/.test(r.url), 'url ' + r.url); return r.url; });
    await check('http gzip', true, async function () { var r = await kd.http({ url: base + '/gzip', headers: { 'Accept-Encoding': 'identity' } }); must(r.body === cfg.gzText, 'body ' + short(r.body)); return 'decoded'; });
    await check('http binary', true, async function () { var r = await kd.http({ url: base + '/bin', binary: true }); must(r.body === cfg.binB64, 'base64 ' + short(r.body)); return '256 bytes'; });
    await check('http POST', true, async function () { var body = 'نص ✓'; var r = await kd.http({ url: base + '/echo', method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: body }); must(r.body === 'POST:' + body, 'body ' + short(r.body)); return r.body; });
    await check('http POST bodyBase64', true, async function () { var r = await kd.http({ url: base + '/echo', method: 'POST', body: 'eHl6', bodyBase64: true }); must(r.body === 'POST:xyz', 'body ' + short(r.body)); return r.body; });
    await check('http charset from Content-Type (windows-1256)', true, async function () { var r = await kd.http({ url: base + '/latin' }); must(r.body === cfg.latinText, 'body ' + short(r.body)); return r.body; });
    await check('http charset from <meta> (windows-1256)', true, async function () { var r = await kd.http({ url: base + '/meta' }); must(r.body.indexOf(cfg.latinText) >= 0, 'body ' + short(r.body)); return 'decoded'; });
    await check('http 404', true, async function () { var r = await kd.http({ url: base + '/nope' }); must(r.status === 404, 'status ' + r.status); return '404'; });

    /* the update check (the shared net.rs) against a canned releases list */
    await check('update check (canned releases)', true, async function () {
      var list = JSON.parse((await kd.http({ url: base + '/releases' })).body); must(Array.isArray(list) && list.length === 5, 'list ' + short(list));
      var u = await env.invoke('kr_selftest_update', { url: base + '/releases', current: '0.1.0', beta: false });
      must(u && u.version === '0.62.0', 'stable ' + short(u));
      must(u.asset === ASSET[cfg.os], 'asset ' + u.asset);
      must(u.url === 'https://example.invalid/v0.62.0' && /notes/.test(u.notes), 'url/notes ' + short(u));
      var b = await env.invoke('kr_selftest_update', { url: base + '/releases', current: '0.1.0', beta: true });
      must(b && b.version === '0.63.0', 'beta ' + short(b));
      var none = await env.invoke('kr_selftest_update', { url: base + '/releases', current: '0.62.0', beta: false });
      must(none === null, 'up to date ' + short(none));
      return 'stable 0.62.0, beta 0.63.0, none after 0.62.0';
    });

    /* window state (the shared winstate.rs): saved now, read back as the next start would */
    await check('window state save → restore', true, async function () {
      var w = await env.invoke('kr_selftest_winstate', {});
      must(w && w.file && typeof w.file.width === 'number' && typeof w.file.height === 'number', 'file ' + short(w && w.file));
      // (A maximized window keeps the size it comes back to, which is not the size it has now — macOS calls a
      // window maximized when its default size fills a small screen, as on CI's runner.)
      if (!w.file.maximized) must(Math.abs(w.file.width - w.now.width) < 2 && Math.abs(w.file.height - w.now.height) < 2, 'saved ' + w.file.width + '×' + w.file.height + ' ≠ now ' + w.now.width + '×' + w.now.height);
      if (w.file.width >= cfg.minWidth && w.file.height >= cfg.minHeight) must(w.restored.width === w.file.width && w.restored.height === w.file.height, 'restored ' + short(w.restored));
      must(w.restored.maximized === !!w.file.maximized, 'maximized ' + short(w.restored));
      var scr = ''; try { scr = ', screen ' + root.screen.availWidth + '×' + root.screen.availHeight; } catch (e) { /* none */ }
      return Math.round(w.file.width) + '×' + Math.round(w.file.height) + (w.file.maximized ? ' (maximized; the size to come back to)' : '') + ' in ' + w.path + scr;
    });

    /* clipboard (the shared shell.rs): not required — a headless desktop may have none */
    await check('clipboard write → read', false, async function () { var t = 'kr selftest ✓ نص'; var back = await env.invoke('kr_selftest_clipboard', { text: t }); must(back === t, 'read ' + short(back)); return 'round trip'; });

    /* the stubs answer as bridge.js says (never throw, never hang) */
    await check('stubs answer as documented', true, async function () {
      var names = Object.keys(stubs || {}); var bad = [];
      for (var i = 0; i < names.length; i++) {
        var k = names[i];
        try {
          var v = kd[k]();
          if (v && typeof v.then === 'function') { try { await within(v, 3000, k); } catch (e) { if (!(e instanceof Error) || !/Tauri stage R\d/.test(e.message)) bad.push(k + ': ' + ((e && e.message) || e)); } }
        } catch (e) { bad.push(k + ' threw ' + ((e && e.message) || e)); }
      }
      must(!bad.length, bad.join('; '));
      return names.length + ' stubs';
    });

    await done();
    return results;
  }

  var lib = { NAMES: NAMES, ASSET: ASSET, verdict: verdict, sameBytes: sameBytes, utf8: utf8, join: join, run: run };
  try { Object.defineProperty(root, '__KR_SELFTEST_LIB__', { value: lib, configurable: true }); } catch (e) { root.__KR_SELFTEST_LIB__ = lib; }

  var cfg = root.__KR_SELFTEST__;
  if (!cfg || root.__KR_SELFTEST_STARTED__) return;
  root.__KR_SELFTEST_STARTED__ = true;
  var results = [];
  var errors = 0;
  function invoke(cmd, args) {
    var t = root.__TAURI__;
    if (t && t.core && typeof t.core.invoke === 'function') return t.core.invoke(cmd, args);
    var i = root.__TAURI_INTERNALS__;
    if (i && typeof i.invoke === 'function') return i.invoke(cmd, args);
    return Promise.reject(new Error('no IPC'));
  }
  // (The page's own uncaught errors, logged — not counted against the run.)
  function pageError(what) { if (++errors > 20) return; results.push({ name: 'page error', ok: false, detail: short(what), required: false }); }
  root.addEventListener('error', function (e) { pageError((e && (e.message || (e.error && e.error.message))) || 'error'); });
  root.addEventListener('unhandledrejection', function (e) { var r = e && e.reason; pageError('unhandled rejection: ' + ((r && r.message) || String(r))); });
  var started = false;
  function start() {
    if (started) return; started = true;
    var env = { sleep: function (ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }, invoke: invoke, doc: root.document, now: function () { return Date.now(); }, leftOut: root.__KR_BRIDGE_LEFT_OUT__ || {} };
    setTimeout(function () {
      run(root.kurokawaDesktop, root.__KR_BRIDGE_STUBS__ || {}, cfg, env, results).catch(function (e) {
        results.push({ name: 'self-test script', ok: false, detail: short((e && e.message) || String(e)), required: true });
        Promise.resolve(invoke('kr_selftest_done', { results: results })).catch(function () {});
      });
    }, 500);
  }
  if (root.document && root.document.readyState === 'complete') start(); else root.addEventListener('load', start);
})(window);
