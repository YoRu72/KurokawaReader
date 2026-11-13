// The Reader's Tauri shell, its runtime self-test (CI only). Added after bridge.js to the window's initialization
// script by src-tauri/src/selftest.rs only when the KR_SELFTEST environment variable is set, after a line that sets
// window.__KR_SELFTEST__ = { base, temp, home, text, gzText, latinText, binB64, os, version, minWidth, minHeight,
// openFirst, openFirstSize, openDir, noWm, bigSize, bigCrc, largeSize, largeCrc, cookie, dohHost }.
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
  // CRC-32 of bytes (an ArrayBuffer or a list): a downloaded file compared with what the test server sent.
  var CRC_TABLE = null;
  function crc32(buf) {
    if (!CRC_TABLE) { CRC_TABLE = []; for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE.push(c >>> 0); } }
    var u = buf instanceof ArrayBuffer ? new Uint8Array(buf) : (Array.isArray(buf) ? buf : new Uint8Array(buf || []));
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < u.length; i++) crc = CRC_TABLE[(crc ^ u[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function dirOf(p) { var i = Math.max(String(p).lastIndexOf('/'), String(p).lastIndexOf('\\')); return i > 0 ? String(p).slice(0, i) : ''; }
  function short(x) { var s; try { s = typeof x === 'string' ? x : JSON.stringify(x); } catch (e) { s = String(x); } return s && s.length > 300 ? s.slice(0, 300) + '…' : String(s); }

  /**
   * The checks. kd: window.kurokawaDesktop. stubs: { name: stage } (window.__KR_BRIDGE_STUBS__).
   * env: { sleep(ms), invoke(cmd, args), doc (document), now(), leftOut ({ name: stage }: window.__KR_BRIDGE_LEFT_OUT__),
   * openLog() (window.__KR_OPEN_LOG__: what the bridge handed the page), home() (the library shown again), inReader() }.
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

    /* opened from outside (stage R2): the file CI gave this launch on its command line reaches the page (its name
       and every byte, read by path — on Windows from another drive, D:) through onOpenFile, as a double-click or
       «Open with» hands one over. Required on Windows; reported elsewhere. (The page then opens it in the reader:
       the library is shown again after.) */
    var opened = function () { return (env.openLog && env.openLog()) || []; };
    if (cfg.openFirst) {
      await check('open with: the file given at start reaches the page', cfg.os === 'win32', async function () {
        var hit = await waitFor(function () { return opened().filter(function (x) { return x.kind === 'file' && x.name === cfg.openFirst; })[0]; }, 20000, cfg.openFirst + ' handed to the page (heard ' + short(opened()) + ')');
        must(!hit.error, 'not read: ' + hit.error);
        must(hit.size === cfg.openFirstSize, hit.size + ' bytes ≠ ' + cfg.openFirstSize);
        // (The page then imports it and opens it in the reader, as a double-click does: said, not required here.)
        var read = false; try { await waitFor(function () { return env.inReader && env.inReader(); }, 8000, 'the reader'); read = true; } catch (e) { /* said below */ }
        return hit.name + ', ' + hit.size + ' bytes; ' + (read ? 'opened in the reader' : 'not opened in the reader within 8 s');
      }, 35000);
      if (env.home) env.home();
    }

    await check('library rendered', true, async function () {
      var d = env.doc;
      await waitFor(function () { var v = d && d.querySelector && d.querySelector('.library-view'); if (!v && env.home) env.home(); return v; }, 30000, 'the library view');
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

    /* a folder picked by the user, walked by path (the Tauri shell's scanFolder: the library's «Pick a folder»), its
       file read by path — outside the home folder where CI's temp folder is (Linux /tmp; Windows' runner on D:) */
    await check('scanFolder: a picked folder walked by path, its file read by path', true, async function () {
      must(typeof kd.scanFolder === 'function', 'no scanFolder');
      var dir = join(cfg.openDir || cfg.temp, 'kr-scanfolder-' + env.now(), cfg.os);
      var sub = join(dir, 'sub ✓', cfg.os);
      var p = join(sub, 'book ✓.krselftest', cfg.os);
      must((await env.invoke('kr_selftest_mkdir', { p: sub })) === true, 'the test folder not made');
      try {
        await kd.writeTextFile(p, 'folder ✓');
        var r = await kd.scanFolder(dir, ['KRSELFTEST']);
        must(r && Array.isArray(r.files) && r.root === dir, 'answer ' + short(r));
        var f = r.files.filter(function (x) { return x.path === p; })[0];
        must(f && f.size === utf8('folder ✓').length, 'not found: ' + short(r.files.slice(0, 5)));
        var b = await kd.readFile(f.path); must(sameBytes(b, utf8('folder ✓')), 'read ' + short(bytesOf(b)));
        var e = await rejects(kd.scanFolder(join(dir, 'no-such-folder', cfg.os), ['x'])); must(e instanceof Error, 'a missing folder did not reject');
        return f.path + ' (' + r.files.length + ' found)';
      } finally { await env.invoke('kr_selftest_remove', { p: p }); await env.invoke('kr_selftest_rmdir', { p: dir }); }
    }, 60000);

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

    /* stage R3 — the app's own requests keep cookies, follow long redirect chains, send the headers browsers forbid a
       page to set, as Electron's session does (the shared net.rs, cookiejar.rs) */
    await check('http cookies: set → sent back (path kept), and one set on a redirect', true, async function () {
      var a = await kd.http({ url: base + '/cookie/set' }); must(a.status === 200, 'status ' + a.status);
      var shown = /kr_test=/.test(a.headers['set-cookie'] || '');
      var e = (await kd.http({ url: base + '/cookie/echo' })).body;
      must(e.indexOf('kr_test=' + cfg.cookie) >= 0, 'kr_test did not come back (sent: ' + (e === '-' ? 'no cookie' : 'other cookies') + ')');
      must(e.indexOf('kr_away') < 0, 'a cookie of another path was sent');
      var h = await kd.http({ url: base + '/cookie/hop' });
      must(/\/cookie\/echo$/.test(h.url), 'url ' + h.url);
      must(h.body.indexOf('kr_hop=1') >= 0 && h.body.indexOf('kr_test=' + cfg.cookie) >= 0, 'the redirect\'s cookie did not come with the next request');
      return 'kr_test came back, kr_away (another path) did not, kr_hop set on a redirect came along; set-cookie ' + (shown ? 'shown to the page' : 'not shown to the page');
    });
    await check('http redirect chain (12 hops)', true, async function () { var r = await kd.http({ url: base + '/chain/12' }); must(r.status === 200 && r.body === cfg.text, 'status ' + r.status + ' ' + short(r.body)); must(/\/text$/.test(r.url), 'url ' + r.url); return r.url; });
    await check('http headers a page may not set (Referer, Origin, User-Agent, Cookie) go as given', true, async function () {
      var r = await kd.http({ url: base + '/headers', headers: { Referer: 'https://ref.example/page', Origin: 'https://ref.example', 'User-Agent': 'KR-Selftest/1', Cookie: 'manual=1' } });
      var b = r.body; var miss = ['referer: https://ref.example/page', 'origin: https://ref.example', 'user-agent: KR-Selftest/1', 'cookie: manual=1'].filter(function (x) { return b.indexOf(x) < 0; });
      must(!miss.length, 'not sent: ' + miss.join(', '));
      var d = (await kd.http({ url: base + '/headers' })).body;
      must(/user-agent: Mozilla\/5\.0 [^\n]*Chrome\//.test(d), 'the default user agent is not a plain Chrome\'s: ' + short((/user-agent: [^\n]*/.exec(d) || [''])[0]));
      return 'all four as given; default user agent a plain Chrome\'s';
    });

    /* downloads (download.rs): into the app's downloads folder, progress events, the name made safe, in parts when
       large, cancelled by its id, the file deleted only inside that folder */
    var dlDir = '';
    await check('download: progress, the whole file, the name made safe; deleteDownload', true, async function () {
      var only = []; kd.onDownloadProgress(function (p) { only.push(p); });
      var heard = []; var off = kd.addDownloadListener(function (p) { heard.push(p); });
      var p;
      try { p = await kd.download(base + '/big/kr-selftest.bin', 'kr-selftest ../x:y.bin', 'kr-st-1'); } finally { off(); }
      must(typeof p === 'string' && /kr-selftest \.\._x_y\.bin$/.test(p), 'path ' + p);
      dlDir = dirOf(p); must(/downloads$/.test(dlDir), 'folder ' + dlDir);
      must((await kd.fileSize(p)) === cfg.bigSize, 'size ' + (await kd.fileSize(p)));
      must(crc32(await kd.readFile(p)) === cfg.bigCrc, 'the bytes differ from the server\'s');
      var mine = heard.filter(function (e) { return e && e.id === 'kr-st-1'; });
      must(mine.length >= 2, 'progress events ' + heard.length);
      must(mine.some(function (e) { return e.got > 0 && e.got < cfg.bigSize; }) && mine[mine.length - 1].pct === 100 && mine[mine.length - 1].total === cfg.bigSize, 'events ' + short(mine.slice(-2)));
      must(typeof mine[0].speed === 'number' && mine[0].connections === 1, 'event fields ' + short(mine[0]));
      must(only.length === mine.length, 'onDownloadProgress heard ' + only.length + ' ≠ ' + mine.length);
      must((await kd.deleteDownload(p)) === true, 'deleteDownload did not answer true');
      must((await kd.fileSize(p)) === -1, 'still there after deleteDownload');
      var outside = join(cfg.temp, 'kr-selftest-keep-' + env.now() + '.txt', cfg.os);
      await kd.writeTextFile(outside, 'keep');
      try {
        must((await kd.deleteDownload(outside)) === false && (await kd.fileSize(outside)) === 4, 'a file outside the downloads folder was deleted');
        must((await kd.deleteDownload(join(dlDir, '..', cfg.os) + (cfg.os === 'win32' ? '\\' : '/') + 'x')) === false, '«..» left the folder');
      } finally { await env.invoke('kr_selftest_remove', { p: outside }); }
      return mine.length + ' progress events; ' + p;
    }, 60000);
    await check('download in parts (3 MiB, several connections)', true, async function () {
      var heard = []; var off = kd.addDownloadListener(function (p) { if (p && p.id === 'kr-st-2') heard.push(p); });
      var p;
      try { p = await kd.download(base + '/large/kr-selftest-large.bin', 'kr-selftest-large.bin', 'kr-st-2'); } finally { off(); }
      must(crc32(await kd.readFile(p)) === cfg.largeCrc, 'the bytes differ from the server\'s');
      var conns = heard.reduce(function (n, e) { return Math.max(n, e.connections || 0); }, 0);
      must(conns > 1, 'connections ' + conns);
      await kd.deleteDownload(p);
      return conns + ' connections, ' + heard.length + ' events';
    }, 60000);
    await check('download cancelled by its id (cancelDownload)', true, async function () {
      must(typeof kd.cancelDownload === 'function', 'no cancelDownload');
      var first = null; var off = kd.addDownloadListener(function (p) { if (p && p.id === 'kr-st-3' && !first) first = p; });
      var run = kd.download(base + '/big/kr-selftest-cancel.bin', 'kr-selftest-cancel.bin', 'kr-st-3');
      var outcome = run.then(function () { return null; }, function (e) { return e; });
      try {
        await waitFor(function () { return first; }, 15000, 'a progress event');
        must((await kd.cancelDownload('kr-st-3')) === true, 'cancelDownload did not find it');
        var e = await outcome;
        must(e instanceof Error && e.message === 'cancelled', 'the download ' + (e ? 'failed with ' + e.message : 'finished'));
      } finally { off(); }
      if (dlDir) must((await kd.fileSize(join(dlDir, 'kr-selftest-cancel.bin', cfg.os))) === -1, 'the part written was left');
      must((await kd.cancelDownload('kr-st-3')) === false, 'still under way');
      return 'cancelled after ' + first.got + ' bytes; nothing left';
    }, 40000);
    await check('download of a missing file rejects', true, async function () { var e = await rejects(kd.download(base + '/nope', 'kr-selftest-404.bin', 'kr-st-4')); must(e instanceof Error && /HTTP 404/.test(e.message), 'answer ' + (e ? e.message : 'resolved')); return e.message; });

    /* DNS over HTTPS (net.rs, doh.rs): with the test server's resolver chosen, a name no real DNS knows reaches it */
    var port = String(base).split(':').pop();
    await check('DNS over HTTPS: a made-up name found through the chosen resolver', true, async function () {
      var resolver = base + '/dns-query';
      var before = Number((await kd.http({ url: base + '/dns-count' })).body);
      var s = await kd.setDoh(resolver); must(s && s.provider === resolver, 'setDoh ' + short(s));
      try {
        var r = await kd.http({ url: 'http://' + cfg.dohHost + ':' + port + '/text' });
        must(r.status === 200 && r.body === cfg.text, 'status ' + r.status + ' ' + short(r.body));
        var after = Number((await kd.http({ url: base + '/dns-count' })).body);
        must(after > before, 'the resolver was not asked (' + before + ' → ' + after + ')');
        var kept = await kd.setDoh(null); must(kept.provider === resolver, 'kept ' + short(kept));
        var t = await kd.setDoh(null, 'kr-doh-nowhere.test');
        must(t && t.ok === false && typeof t.error === 'string' && t.provider === resolver, 'test ' + short(t));
        return cfg.dohHost + ' → 127.0.0.1 (' + (after - before) + ' queries); a name it does not know: ' + short(t.error).slice(0, 80);
      } finally { var o = await kd.setDoh('off'); must(o && o.provider === 'off', 'off ' + short(o)); }
    }, 40000);
    await check('DNS over HTTPS off: the made-up name is the system\'s again (not found)', false, async function () {
      var e = await rejects(kd.http({ url: 'http://' + cfg.dohHost + ':' + port + '/text' }));
      must(e instanceof Error, 'found without the resolver');
      return 'not found: ' + short(e.message).slice(0, 80);
    }, 25000);

    /* a system notification (the notification plugin): the call answers — a person sees whether one shows */
    await check('notify answers', false, async function () { var r = await kd.notify({ title: 'KurokawaReader self-test', body: 'A notification ✓', hash: '/' }); must(typeof r === 'boolean', 'answer ' + short(r)); return 'answered ' + r; }, 10000);

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

    /* the window's own title bar (titlebar.rs): its state; maximise → the state event → restore. Required on Windows;
       elsewhere reported (Xvfb has no window manager to maximise a window; a Mac's runner may say it is maximised
       already). After the window state's check, so that one sees the window as it was made. */
    await check('title bar: state, maximise → state event → restore', cfg.os === 'win32', async function () {
      must(typeof kd.titleBar === 'function' && typeof kd.onTitleBarState === 'function', 'no titleBar / onTitleBarState');
      var s0 = await kd.titleBar({});
      // (CI's Linux runs under Xvfb with no window manager — the workflow says so with KR_SELFTEST_NO_WM —: nothing
      // there maximises a window, so the toggle is not tried.)
      if (cfg.noWm) { must(s0 && typeof s0.maximized === 'boolean' && s0.platform === cfg.os, 'state ' + short(s0)); return 'skipped: no window manager (state read: own bar ' + s0.own + ', ' + (s0.maximized ? 'maximised' : 'not maximised') + ')'; }
      must(s0 && typeof s0.own === 'boolean' && typeof s0.maximized === 'boolean' && s0.platform === cfg.os && s0.height > 0, 'state ' + short(s0));
      var heard = []; var off = kd.onTitleBarState(function (st) { heard.push(st); });
      try {
        await sleep(300);
        await kd.titleBar({ act: 'maximize' });
        await waitFor(function () { return heard.some(function (e) { return e && e.maximized === !s0.maximized; }); }, 8000, 'a kr:titleBarState event with maximized ' + !s0.maximized + ' (heard ' + short(heard) + ')');
        await kd.titleBar({ act: 'maximize' });
        await waitFor(function () { var e = heard[heard.length - 1]; return e && e.maximized === s0.maximized; }, 8000, 'the window back as it was (heard ' + short(heard) + ')');
        var s2 = await kd.titleBar({});
        must(s2.maximized === s0.maximized, 'state after ' + short(s2));
      } finally { off(); }
      return 'own bar ' + s0.own + ' (' + s0.controls + ' buttons), ' + (s0.maximized ? 'maximised' : 'not maximised') + ' → toggled → back; ' + heard.length + ' event(s)';
    });

    /* a second launch with a file and a link (single instance, stage R2): it hands them to this window and ends at
       once; the page receives both. Required on Windows; reported elsewhere (Linux needs a D-Bus session bus, which
       the workflow starts; a Mac's runner is reported). */
    await check('second launch: hands its file and link over, and ends', cfg.os === 'win32', async function () {
      var name = 'kr-open-second-' + env.now() + '.txt';
      var p = join(cfg.openDir || cfg.temp, name, cfg.os);
      var link = 'kurokawareader://open?to=%2F&selftest=' + env.now();
      await kd.writeTextFile(p, 'second ✓');
      try {
        var argv = [p, link];
        var r = await env.invoke('kr_selftest_launch', { args: argv });
        must(r && !r.killed && r.code === 0, 'the second launch ' + (r && r.killed ? 'was still running after 12 s (nothing took its file; single instance ' + (r.singleInstance ? 'on' : 'off: no D-Bus session bus') + ')' : 'ended with ' + short(r)));
        var f = await waitFor(function () { return opened().filter(function (x) { return x.kind === 'file' && x.name === name; })[0]; }, 10000, name + ' handed to the page (heard ' + short(opened()) + ')');
        must(!f.error && f.size === utf8('second ✓').length, 'file ' + short(f));
        await waitFor(function () { return opened().some(function (x) { return x.kind === 'url' && x.url === link; }); }, 5000, 'the link handed to the page (heard ' + short(opened()) + ')');
        return 'ended in ' + r.ms + ' ms; ' + name + ' (' + f.size + ' bytes) and the link received';
      } finally { await env.invoke('kr_selftest_remove', { p: p }); if (env.home) env.home(); }
    }, 40000);

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

  var lib = { NAMES: NAMES, ASSET: ASSET, verdict: verdict, sameBytes: sameBytes, utf8: utf8, join: join, crc32: crc32, run: run };
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
    var env = {
      sleep: function (ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }, invoke: invoke, doc: root.document, now: function () { return Date.now(); }, leftOut: root.__KR_BRIDGE_LEFT_OUT__ || {},
      openLog: function () { return root.__KR_OPEN_LOG__ || []; },
      // (Back to the library: a file opened from outside opens in the reader.)
      home: function () { try { if (root.location.hash !== '#/') root.location.hash = '#/'; } catch (e) { /* stays */ } },
      inReader: function () { try { return /^#\/read\//.test(root.location.hash); } catch (e) { return false; } },
    };
    setTimeout(function () {
      run(root.kurokawaDesktop, root.__KR_BRIDGE_STUBS__ || {}, cfg, env, results).catch(function (e) {
        results.push({ name: 'self-test script', ok: false, detail: short((e && e.message) || String(e)), required: true });
        Promise.resolve(invoke('kr_selftest_done', { results: results })).catch(function () {});
      });
    }, 500);
  }
  if (root.document && root.document.readyState === 'complete') start(); else root.addEventListener('load', start);
})(window);
