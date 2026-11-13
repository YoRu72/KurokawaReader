// The Reader's Tauri shell, its runtime self-test (CI only). Added after bridge.js to the window's initialization
// script by src-tauri/src/selftest.rs only when the KR_SELFTEST environment variable is set, after a line that sets
// window.__KR_SELFTEST__ = { base, temp, home, text, gzText, latinText, binB64, os, version, minWidth, minHeight,
// openFirst, openFirstSize, openDir, noWm, bigSize, bigCrc, largeSize, largeCrc, cookie, dohHost, site, browser }.
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
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function toB64(u) {
    var out = ''; var n = u.length; var i = 0;
    for (; i + 2 < n; i += 3) { var x = (u[i] << 16) | (u[i + 1] << 8) | u[i + 2]; out += B64[x >> 18] + B64[(x >> 12) & 63] + B64[(x >> 6) & 63] + B64[x & 63]; }
    if (n - i === 1) { var y = u[i] << 16; out += B64[y >> 18] + B64[(y >> 12) & 63] + '=='; }
    else if (n - i === 2) { var z = (u[i] << 16) | (u[i + 1] << 8); out += B64[z >> 18] + B64[(z >> 12) & 63] + B64[(z >> 6) & 63] + '='; }
    return out;
  }
  function le(n, k) { var a = []; for (var i = 0; i < k; i++) a.push(Math.floor(n / Math.pow(256, i)) & 255); return a; }
  function be32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
  /** A zip of stored entries, names as given (a hostile one too): [[name, bytes]…] → bytes. */
  function zipStored(entries) {
    var out = []; var cd = [];
    entries.forEach(function (e) {
      var name = utf8(e[0]); var data = e[1]; var crc = crc32(data); var off = out.length;
      out = out.concat([0x50, 0x4b, 3, 4, 20, 0, 0, 8, 0, 0, 0, 0, 0, 0], le(crc, 4), le(data.length, 4), le(data.length, 4), le(name.length, 2), [0, 0], name, data);
      cd = cd.concat([0x50, 0x4b, 1, 2, 20, 0, 20, 0, 0, 8, 0, 0, 0, 0, 0, 0], le(crc, 4), le(data.length, 4), le(data.length, 4), le(name.length, 2), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], le(off, 4), name);
    });
    var start = out.length;
    return out.concat(cd, [0x50, 0x4b, 5, 6, 0, 0, 0, 0], le(entries.length, 2), le(entries.length, 2), le(cd.length, 4), le(start, 4), [0, 0]);
  }
  /** A PNG of w×h made here (RGBA, a pattern; zlib of stored blocks): an icon to choose. */
  function makePng(w, h) {
    var raw = [];
    for (var y = 0; y < h; y++) { raw.push(0); for (var x = 0; x < w; x++) raw.push((x * 4) & 255, (y * 4) & 255, ((x + y) * 2) & 255, 255); }
    var a = 1, b = 0; for (var i = 0; i < raw.length; i++) { a = (a + raw[i]) % 65521; b = (b + a) % 65521; }
    var z = [0x78, 0x01];
    for (var j = 0; j < raw.length; j += 65535) { var n = Math.min(65535, raw.length - j); z.push(j + n >= raw.length ? 1 : 0, n & 255, n >> 8, ~n & 255, (~n >> 8) & 255); for (var k = 0; k < n; k++) z.push(raw[j + k]); }
    z = z.concat(be32(((b << 16) | a) >>> 0));
    function chunk(type, data) { var td = utf8(type).concat(data); return be32(data.length).concat(td, be32(crc32(td))); }
    return [137, 80, 78, 71, 13, 10, 26, 10].concat(chunk('IHDR', be32(w).concat(be32(h), [8, 6, 0, 0, 0])), chunk('IDAT', z), chunk('IEND', []));
  }
  function fromB64(s) { var bin = atob(String(s || '')); var u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  function dirOf(p) { var i = Math.max(String(p).lastIndexOf('/'), String(p).lastIndexOf('\\')); return i > 0 ? String(p).slice(0, i) : ''; }
  function short(x) { var s; try { s = typeof x === 'string' ? x : JSON.stringify(x); } catch (e) { s = String(x); } return s && s.length > 300 ? s.slice(0, 300) + '…' : String(s); }

  /**
   * The checks. kd: window.kurokawaDesktop. stubs: { name: stage } (window.__KR_BRIDGE_STUBS__).
   * env: { sleep(ms), invoke(cmd, args), doc (document), now(), leftOut ({ name: stage }: window.__KR_BRIDGE_LEFT_OUT__),
   * openLog() (window.__KR_OPEN_LOG__: what the bridge handed the page), home() (the library shown again), inReader(),
   * ua() (the page's user agent) }.
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

    /* (R6b) the updater (src-tauri/src/update.rs): the test server's 3 MiB file fetched as an update is — broken off
       after 1 MiB and resumed from there —, kept against its SHA-256 and refused (and removed) against a wrong one; a
       file no checksum names is refused. On a bare program (CI's) installing is refused before anything is fetched
       and there is no background download; an installed copy (the workflow's second run) skips those. */
    await check('updater: resume, checksum, refusals', true, async function () {
      var kind = (root.__KR_BOOT__ && root.__KR_BOOT__.kind) || '';
      var r = await env.invoke('kr_selftest_updatedl', { url: base + '/large/kr-update.bin' });
      must(r && r.size === cfg.largeSize, 'size ' + short(r));
      must(r.resumedFrom > 0 && r.resumedFrom < r.size, 'resumed from ' + r.resumedFrom);
      must(r.ok === true, 'its checksum ' + short(r));
      must(r.refused === 'kr-update:checksum' && r.removedWhenRefused === true, 'a wrong checksum ' + short(r));
      must(r.noChecksum === 'kr-update:nochecksum', 'no checksum ' + short(r));
      must(r.kind === kind, 'kind ' + r.kind + ' ≠ boot ' + kind);
      if (kind === 'bare') {
        var refused = null; try { await kd.installUpdate('https://example.invalid/KurokawaReader-9.9.9-windows-x64-setup.exe', {}); } catch (e) { refused = e && e.message; }
        must(refused === 'kr-update:bare', 'installing on a bare program ' + short(refused));
        var bg = await kd.downloadUpdate({ beta: false }); must(bg === 'unsupported', 'background ' + short(bg));
        must((await kd.installDownloadedUpdate()) === false, 'nothing downloaded');
      }
      return 'resumed at ' + r.resumedFrom + ' of ' + r.size + ' B; its sha256 kept, a wrong one refused; kind ' + r.kind + (r.file ? ' (updates from ' + r.file + ')' : '');
    }, 90000);

    /* (R6b) the start (src-tauri/src/boot.rs): first paint and app ready, in ms from the program's start */
    await check('start-up times', false, async function () {
      var t = await env.invoke('kr_boot_times', {});
      must(t && typeof t.paint === 'number' && typeof t.ready === 'number', 'times ' + short(t));
      return 'first paint ' + t.paint + ' ms, app ready ' + t.ready + ' ms after the program started' + (t.colourAtStart ? '; the window opens in the interface\'s colour' : '; background_color not found: no window colour before the first paint');
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

    /* stage R4 — the in-app browser (browser.rs): windows of the system's web view on the test server's small site
       (/site/: its page sets a session cookie, HttpOnly, and a clearance). Out of sight it passes and sets its
       cookies; a request made by the site's own page carries them (and the browser's user agent); binary, POST and a
       2 MiB answer come back whole; the site's page cannot call the app's commands; a link aimed at a new window
       stays in the window; a download the site offers is saved (where this build catches downloads); a check window
       and a sign-in's end (until) close by themselves; a site that keeps its check answers the refusal; reset opens
       the site afresh; forget clears the clearance, then everything; the browser as a browser ends when closed; no
       window is left. Required on Windows; reported elsewhere (Xvfb without a window manager, a Mac's runner). */
    var site = cfg.site || {}; var ab = cfg.browser || {}; var onWin = cfg.os === 'win32'; var siteUrl = base + '/site/';
    function browserAct(o) { return env.invoke('kr_selftest_browser', { o: o }); }
    // (When a signed-in page answers «signed out»: the cookies the browser holds for the site, and those its page's
    // own request sent — names only —, and how the answers came.)
    async function whySignedOut() {
      var held = null; var sent = null; var via = null;
      try { held = (await browserAct({ act: 'cookies', url: base + '/site/private' })).names; } catch (e) { held = 'error ' + e.message; }
      try { var ec = await kd.browserFetch({ url: base + '/cookie/echo' }); sent = String(ec.body).split(';').map(function (x) { return x.split('=')[0].trim(); }).join(','); } catch (e) { sent = 'error ' + e.message; }
      try { via = (await browserAct({ act: 'via' })).via; } catch (e) { via = '?'; }
      return '; the browser holds ' + short(held) + ' for the site; the page\'s request sent ' + short(sent) + '; answers by ' + via;
    }
    await check('in-app browser: a site opened out of sight passes and sets its cookies (openWebView hidden)', onWin, async function () {
      must(typeof kd.openWebView === 'function', 'no openWebView');
      var r = await kd.openWebView({ url: siteUrl, hidden: true, timeout: 15000 });
      must(r && r.passed === true && r.blocked === false, 'answer ' + short(r));
      must(r.title === site.title, 'title ' + short(r.title));
      return 'passed: «' + r.title + '»; this build: ' + short(ab);
    }, 40000);
    await check('browserFetch: the signed-in page through the browser\'s session (its HttpOnly cookie, its user agent)', onWin, async function () {
      var r = await kd.browserFetch({ url: base + '/site/private', timeout: 20000, openTimeout: 20000 });
      if (!(r && r.status === 200 && /^signed-in;clearance=1;ua=/.test(r.body) && r.via === 'browser')) must(false, 'answer ' + r.status + ' ' + short(r.body).slice(0, 40) + (await whySignedOut()));
      var ua = r.body.replace(/^signed-in;clearance=1;ua=/, ''); var mine = env.ua ? env.ua() : '';
      var via = await browserAct({ act: 'via' });
      return 'signed in; the browser\'s user agent ' + (ua === mine ? 'is the app\'s' : 'differs from the app\'s: ' + ua) + '; answers came by ' + (via && via.via);
    }, 60000);
    await check('browserFetch: binary, POST, a 2 MiB answer in parts', onWin, async function () {
      var b = await kd.browserFetch({ url: base + '/bin', binary: true });
      must(b.body === cfg.binB64, 'binary ' + short(b.body));
      var p = await kd.browserFetch({ url: base + '/echo', method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'نص ✓' });
      must(p.body === 'POST:نص ✓', 'POST ' + short(p.body));
      var e = await kd.browserFetch({ url: base + '/echo', method: 'POST', body: 'eHl6', bodyBase64: true });
      must(e.body === 'POST:xyz', 'POST from base64 ' + short(e.body));
      var t0 = env.now(); var big = await kd.browserFetch({ url: base + '/big/kr-browser.bin', binary: true, timeout: 60000 });
      var bytes = fromB64(big.body);
      must(bytes.length === cfg.bigSize && crc32(bytes) === cfg.bigCrc, 'the 2 MiB answer: ' + bytes.length + ' bytes, ' + (crc32(bytes) === cfg.bigCrc ? 'same' : 'other') + ' bytes');
      return '256 bytes, two POSTs, ' + bytes.length + ' bytes in ' + (env.now() - t0) + ' ms';
    }, 120000);
    await check('the app\'s own requests carry the browser\'s cookies', false, async function () {
      var r = await kd.http({ url: base + '/site/private' });
      if (ab.cookieRead || ab.cookieAll) must(r.status === 200, 'status ' + r.status + ' (this build reads the browser\'s cookies)');
      return r.status === 200 ? 'yes (' + (ab.cookieAll ? 'every cookie' : 'the site\'s') + ' shared)' : 'no: this build cannot read the browser\'s cookies (status ' + r.status + ')';
    });
    await check('the site\'s page cannot call the app (its commands refused)', onWin, async function () {
      var r = await browserAct({ act: 'probe', url: siteUrl, p: join(cfg.temp, 'kr-probe-nothing.txt', cfg.os) });
      must(r && !r.error, 'probe ' + short(r));
      var calls = ['appCommand', 'appCommand2', 'browserCommand', 'plugin', 'event'];
      var allowed = calls.filter(function (k) { return /^ALLOWED/.test(String(r[k])); });
      must(!allowed.length, 'allowed: ' + allowed.map(function (k) { return k + ' ' + r[k]; }).join('; '));
      must(r.bridge === 'undefined', 'the app\'s bridge is there: ' + r.bridge);
      return calls.map(function (k) { return k + ' ' + String(r[k]).slice(0, 50); }).join('; ') + '; __TAURI__ ' + r.tauri + '; channel ' + (r.mode || '?');
    }, 60000);
    await check('a link that opens a new window stays in the browser window', false, async function () {
      var r = await browserAct({ act: 'click', url: siteUrl, p: '#pop' });
      must(r && r.found === true, 'answer ' + short(r));
      must(/\/site\/popup$/.test(r.href || ''), 'went to ' + short(r.href));
      return r.href;
    }, 40000);
    await check('a download a site offers is saved', false, async function () {
      if (!ab.downloads) return 'not caught in this build: the web view\'s own way';
      var r = await browserAct({ act: 'click', url: siteUrl, p: '#dl' });
      must(r && r.found === true, 'answer ' + short(r));
      var d = null; var until = env.now() + 15000;
      while (!d && env.now() < until) { var l = (await browserAct({ act: 'downloads' })).downloads || []; d = l.filter(function (x) { return /\/site\/file\.epub$/.test(x.url) && 'ok' in x; })[0] || null; if (!d) await sleep(300); }
      var all = (await browserAct({ act: 'downloads' })).downloads || [];
      must(d && d.ok && d.path, 'download ' + short(d) + '; its events ' + short(all));
      var n = await kd.fileSize(d.path); await env.invoke('kr_selftest_remove', { p: d.path });
      must(n === site.fileSize, 'size ' + n + ' ≠ ' + site.fileSize);
      return d.path;
    }, 60000);
    await check('a check window closes by itself once the site shows its page', onWin, async function () {
      var r = await kd.openWebView({ url: siteUrl, timeout: 20000, message: 'KurokawaReader self-test' });
      must(r && r.passed === true && r.blocked === false, 'answer ' + short(r));
      return 'passed: «' + r.title + '»';
    }, 45000);
    await check('until: a sign-in\'s end address given back', onWin, async function () {
      var r = await kd.openWebView({ url: base + '/site/token', until: 'access_token=', stay: true, timeout: 20000, message: 'KurokawaReader self-test' });
      must(r && r.passed === true && /\/site\/landing#access_token=/.test(r.url || '') && r.url.indexOf(site.token) >= 0, 'answer ' + short(r && { passed: r.passed, url: String(r.url || '').replace(/access_token=.*/, 'access_token=…') }));
      return r.url.replace(/access_token=.*/, 'access_token=…');
    }, 45000);
    await check('a site that keeps its check: the request answers the refusal (x-kr-lane)', onWin, async function () {
      var other = 'http://localhost:' + port;
      var r = await kd.browserFetch({ url: other + '/site/private', page: other + '/site/check', openTimeout: 3000 });
      must(r && r.status === 403 && r.headers['x-kr-lane'] === 'challenge' && r.headers['cf-mitigated'] === 'challenge', 'answer ' + short(r));
      must(/Just a moment/.test(r.body), 'body ' + short(r.body));
      return '403, x-kr-lane: challenge';
    }, 40000);
    await check('browserReset: the site\'s window set aside, opened afresh by the next request (still signed in)', onWin, async function () {
      must((await kd.browserReset(siteUrl)) === true, 'reset did not answer true');
      await sleep(800);
      var w = await browserAct({ act: 'windows' });
      must(w && w.lanes.indexOf(base) < 0, 'its lane still there: ' + short(w));
      var r = await kd.browserFetch({ url: base + '/site/private' });
      if (r.status !== 200) must(false, 'status ' + r.status + (await whySignedOut()));
      return 'set aside; afresh and signed in';
    }, 60000);
    await check('browserForget: the clearance only, then every site\'s data', onWin && !!(ab.cookieDelete || ab.clearAll), async function () {
      var a = await kd.browserForget(siteUrl, false);
      must(a && typeof a.cleared === 'number', 'answer ' + short(a));
      var r1 = await kd.browserFetch({ url: base + '/site/private' });
      var left = (await browserAct({ act: 'forgetLeft' })).left;
      var said = 'the clearance: ' + a.cleared + ' cleared' + (left && left.length ? ' (still listed after 3 s: ' + left.join(',') + ')' : '') + ', then ' + r1.status + ' ' + short(r1.body).slice(0, 30);
      if (r1.status !== 200) said += await whySignedOut();
      if (ab.cookieDelete) must(r1.status === 200 && /clearance=0/.test(r1.body), said);
      var b = await kd.browserForget(siteUrl, true);
      var r2 = await kd.browserFetch({ url: base + '/site/private' });
      said += '; everything: ' + b.cleared + ' site(s), then ' + r2.status;
      if (ab.cookieDelete || ab.clearAll) must(r2.status === 401, said);
      var h = await kd.http({ url: base + '/site/private' });
      must(h.status === 401, said + '; the app\'s own requests still signed in');
      return said + (ab.cookieDelete || ab.clearAll ? '' : ' (this build cannot clear the browser\'s cookies)');
    }, 90000);
    await check('the browser as a browser (Settings): opens with its bar, ends when closed', false, async function () {
      var p = kd.openWebView({ url: siteUrl, browse: true, message: 'KurokawaReader self-test', back: 'Back', forward: 'Forward', reload: 'Reload', placeholder: 'Address', rtl: false });
      var over = null; p.then(function (r) { over = r || {}; }, function (e) { over = { error: (e && e.message) || String(e) }; });
      await sleep(2500);
      must(over === null, 'ended before it was closed: ' + short(over));
      var c = await browserAct({ act: 'close' });
      var r = await within(p, 10000, 'the answer once closed');
      must(r && r.passed === true, 'answer ' + short(r));
      return 'closed (' + c.closed + ' window(s)); ' + short(r);
    }, 30000);
    await check('no browser window left', onWin, async function () {
      await browserAct({ act: 'close' });
      var w = null; var until = env.now() + 8000;
      for (;;) { w = await browserAct({ act: 'windows' }); if (!w.windows.length || env.now() > until) break; await sleep(300); }
      must(!w.windows.length, 'still open: ' + short(w.windows));
      return 'none';
    }, 20000);

    /* stage R5 — archives (archive.rs, archives.rs): the 7-Zip shipped with the app found; a zip made of a folder and
       a file → listed → tested → extracted, every byte the same, progress heard; extracted in place (the archive gone
       after); a zip that would write outside its folder refused before anything is written; free space and files
       already there; with the shipped 7-Zip (required on Windows and Linux; reported on a Mac): a 7z with a password
       — refused without it, «wrongPassword» with a wrong one, extracted with it — and a tar.gz in two layers. The
       test's password is a made-up one and appears in no result. */
    var ownSeven = cfg.os !== 'darwin';
    await check('archives: the 7-Zip shipped with the app', ownSeven, async function () {
      var r = await env.invoke('kr_selftest_7z', { args: [] });
      must(r && r.path, 'no 7-Zip found');
      must(r.own, 'only the system\'s 7-Zip (' + r.path + '), not the app\'s own');
      return r.path;
    }, 15000);
    var adir = join(cfg.temp, 'kr-archive-' + env.now(), cfg.os);
    var aSrc = join(adir, 'Book Folder', cfg.os); var aSub = join(aSrc, 'sub ✓', cfg.os);
    var textBytes = utf8('Alice was beginning to get very tired ✓ نص. '.repeat(400));
    var binBytes = []; for (var bi = 0; bi < 3000; bi++) binBytes.push((bi * 37 + 11) & 255);
    var picBytes = makePng(32, 32);
    var aFiles = [[join(aSrc, 'a.txt', cfg.os), 'Book Folder/a.txt', textBytes], [join(aSub, 'b.bin', cfg.os), 'Book Folder/sub ✓/b.bin', binBytes], [join(adir, 'c.png', cfg.os), 'c.png', picBytes]];
    var aOk = false;
    async function sameFiles(dest) {
      for (var i = 0; i < aFiles.length; i++) {
        var p2 = join(dest, aFiles[i][1].split('/').join(cfg.os === 'win32' ? '\\' : '/'), cfg.os);
        var got = await kd.readFile(p2); must(sameBytes(got, aFiles[i][2]), aFiles[i][1] + ': ' + bytesOf(got).length + ' bytes, not the same');
      }
    }
    await check('archives: a zip made → listed → tested → extracted, every byte the same', true, async function () {
      must(typeof kd.archiveCreate === 'function' && typeof kd.archiveList === 'function', 'no archive functions');
      must((await env.invoke('kr_selftest_mkdir', { p: aSub })) === true, 'the test folder not made');
      for (var i = 0; i < aFiles.length; i++) must((await kd.writeBinary(aFiles[i][0], toB64(aFiles[i][2]), false)) === true, 'not written: ' + aFiles[i][0]);
      var heard = 0; var off = kd.onArchiveProgress(function (pr) { if (pr && pr.id === 'kr-st-zip') heard++; });
      var zip = join(adir, 'made.zip', cfg.os);
      try {
        var c = await kd.archiveCreate({ id: 'kr-st-zip', out: zip, inputs: [aSrc, aFiles[2][0]] });
        must(c && c.files === 3 && c.size > 0 && c.path === zip, 'made ' + short(c));
      } finally { await sleep(300); off(); }
      var info = await kd.archiveList({ path: zip });
      var names = (info.entries || []).filter(function (e) { return !e.dir; }).map(function (e) { return e.path; }).sort();
      must(info.format === 'zip' && !info.unsafe && !info.encrypted && info.inPlaceOk, 'listed ' + short(info));
      must(names.join('|') === aFiles.map(function (f) { return f[1]; }).sort().join('|'), 'entries ' + short(names));
      must(info.total === textBytes.length + binBytes.length + picBytes.length, 'total ' + info.total);
      var t = await kd.archiveTest({ id: 'kr-st-test', path: zip }); must(t && t.ok && t.files === 3, 'test ' + short(t));
      var out = join(adir, 'out', cfg.os);
      var x = await kd.archiveExtract({ id: 'kr-st-x', path: zip, dest: out, replace: 'replace' });
      must(x && x.files === 3 && x.dest === out, 'extracted ' + short(x));
      await sameFiles(out);
      var ex = await kd.archiveExisting({ dest: out, names: ['c.png', 'nope.txt', '../made.zip'] }); must(short(ex.existing) === '["c.png"]', 'existing ' + short(ex));
      var fr = await kd.archiveFree({ dir: join(out, 'not made yet', cfg.os) }); must(fr && fr.free > 0, 'free ' + short(fr));
      aOk = true;
      return '3 files, ' + c.size + ' bytes; tested; extracted and compared; progress events ' + heard + '; ' + Math.round(fr.free / 1048576) + ' MiB free';
    }, 60000);
    await check('archives: extracted in place (the archive gone after)', true, async function () {
      must(aOk, 'no zip made');
      var zip2 = join(adir, 'inplace.zip', cfg.os);
      var c = await kd.archiveCreate({ id: 'kr-st-zip2', out: zip2, inputs: [aSrc, aFiles[2][0]] });
      var info = await kd.archiveList({ path: zip2 }); must(info.inPlaceOk && !info.resumable, 'listed ' + short(info));
      var dest = join(adir, 'in place', cfg.os);
      var x = await kd.archiveExtract({ id: 'kr-st-ip', path: zip2, dest: dest, inPlace: true, replace: 'replace', keepFree: 0 });
      must(x.files === 3, 'extracted ' + short(x));
      must((await kd.fileSize(zip2)) === -1, 'the archive is still there');
      await sameFiles(dest);
      return c.size + ' bytes taken out in place';
    }, 60000);
    await check('archives: a zip that would write outside its folder is refused', true, async function () {
      var evil = '../kr-evil-' + env.now() + '.txt';
      var hz = join(adir, 'hostile.zip', cfg.os);
      must((await kd.writeBinary(hz, toB64(zipStored([['fine.txt', utf8('fine')], [evil, utf8('pwned')]])), false)) === true, 'not written');
      var info = await kd.archiveList({ path: hz }); must(info.unsafe === evil, 'listed without «unsafe»: ' + short(info));
      var dest = join(adir, 'hostile out', cfg.os);
      var e = await rejects(kd.archiveExtract({ id: 'kr-st-evil', path: hz, dest: dest, replace: 'replace' }));
      must(e instanceof Error && e.message === 'unsafePath ' + evil, 'answer ' + (e ? e.message : 'extracted'));
      must((await kd.fileSize(join(adir, evil.slice(3), cfg.os))) === -1 && (await kd.fileSize(join(cfg.temp, evil.slice(3), cfg.os))) === -1, 'the file was written outside');
      must((await kd.fileSize(join(dest, 'fine.txt', cfg.os))) === -1, 'something was written before the refusal');
      return 'refused: unsafePath ' + evil;
    }, 30000);
    var PW = 'kr-made-up-' + (env.now() % 1000);
    await check('archives: a 7z with a password (the shipped 7-Zip)', ownSeven, async function () {
      must(aOk, 'no test files');
      var z7 = join(adir, 'locked.7z', cfg.os);
      var make7z = ['a', '-t7z', '-mhe=on', '-p' + PW, z7, aSrc, aFiles[2][0]];
      var mk = await env.invoke('kr_selftest_7z', { args: make7z });
      must(mk && mk.code === 0, '7-Zip could not make it (exit ' + (mk && mk.code) + ')');
      var e1 = await rejects(kd.archiveList({ path: z7 })); must(e1 && /password/i.test(e1.message), 'listed without its password: ' + (e1 ? e1.message : 'yes'));
      var info = await kd.archiveList({ path: z7, password: PW });
      must(info.format === '7z' && info.encrypted && (info.entries || []).filter(function (x) { return !x.dir; }).length === 3, 'listed ' + short({ format: info.format, encrypted: info.encrypted, n: (info.entries || []).length }));
      var dest = join(adir, 'from 7z', cfg.os);
      var e2 = await rejects(kd.archiveExtract({ id: 'kr-st-7w', path: z7, dest: dest, password: PW + 'x', replace: 'replace' }));
      must(e2 && /password/i.test(e2.message), 'a wrong password: ' + (e2 ? e2.message : 'extracted'));
      var heard = 0; var off = kd.onArchiveProgress(function (pr) { if (pr && pr.id === 'kr-st-7z') heard++; });
      try { var x = await kd.archiveExtract({ id: 'kr-st-7z', path: z7, dest: dest, password: PW, replace: 'replace' }); must(x && typeof x.files === 'number', 'extracted ' + short(x)); } finally { await sleep(200); off(); }
      await sameFiles(dest);
      var t = await kd.archiveTest({ id: 'kr-st-7t', path: z7, password: PW }); must(t.ok, 'test ' + short(t.bad));
      return 'listed, refused without it and with a wrong one, extracted (' + x.files + ' named by 7-Zip, ' + heard + ' progress events) and tested';
    }, 90000);
    await check('archives: a tar.gz in two layers (the shipped 7-Zip)', ownSeven, async function () {
      must(aOk, 'no test files');
      var tar = join(adir, 'set.tar', cfg.os); var tgz = join(adir, 'set.tar.gz', cfg.os);
      var makeTar = ['a', '-ttar', tar, aSrc, aFiles[2][0]]; var makeGz = ['a', '-tgzip', tgz, tar];
      var a1 = await env.invoke('kr_selftest_7z', { args: makeTar }); must(a1 && a1.code === 0, 'tar not made (exit ' + (a1 && a1.code) + ')');
      var a2 = await env.invoke('kr_selftest_7z', { args: makeGz }); must(a2 && a2.code === 0, 'gzip not made (exit ' + (a2 && a2.code) + ')');
      var lt = await kd.archiveList({ path: tar }); must(lt.format === 'tar' && lt.inPlaceOk && (lt.entries || []).filter(function (x) { return !x.dir; }).length === 3, 'the tar listed ' + short(lt.entries));
      var info = await kd.archiveList({ path: tgz }); must(info.format === 'tar.gz', 'listed ' + short(info.format));
      var dest = join(adir, 'from tgz', cfg.os);
      var x = await kd.archiveExtract({ id: 'kr-st-tgz', path: tgz, dest: dest, replace: 'replace' });
      await sameFiles(dest);
      var tdest = join(adir, 'from tar in place', cfg.os);
      var y = await kd.archiveExtract({ id: 'kr-st-tip', path: tar, dest: tdest, inPlace: true, replace: 'replace', keepFree: 0 });
      must((await kd.fileSize(tar)) === -1, 'the tar is still there');
      await sameFiles(tdest);
      return 'tar.gz: ' + x.files + ' files out; the tar in place: ' + y.files;
    }, 90000);
    try { await env.invoke('kr_selftest_rmdir', { p: adir }); } catch (e) { /* gone */ }

    /* stage R5 — the window (winbits.rs, menu.rs): a menu command reaches the page (onCommand; a Mac's menu bar sends
       it so); full screen of the window and back (reported: Xvfb has no window manager); the interface's size;
       taskbar progress; a picture on the clipboard (reported: a headless desktop may have none). */
    await check('onCommand: a command of the shell reaches the page', true, async function () {
      var got = []; kd.onCommand(function (c) { got.push(c); });
      await sleep(300);
      must((await env.invoke('kr_selftest_command', { c: 'search' })) === true, 'not sent');
      await waitFor(function () { return got.indexOf('search') >= 0; }, 5000, 'the command (heard ' + short(got) + ')');
      return 'heard ' + short(got);
    }, 15000);
    await check('setFullscreen: the window full screen, then back', false, async function () {
      var on = await kd.setFullscreen(true); must(on === true, 'answer ' + short(on));
      var st = null; for (var fi = 0; fi < 25 && !st; fi++) { var s1 = await kd.titleBar({}); if (s1 && s1.fullscreen) st = s1; else await sleep(200); }
      var off = await kd.setFullscreen(false);
      await sleep(600);
      var s2 = await kd.titleBar({});
      return (st ? 'full screen (the title bar told)' : 'asked; the window manager did nothing') + ', then ' + (off === false && !s2.fullscreen ? 'back' : 'still ' + short(s2));
    }, 20000);
    await check('setZoom: the interface at 125 %, then 100 %', false, async function () {
      // (Back to the page's own size after: Appearance → size, 110 % unless chosen — src/ui/pcshell.ts.)
      var own = 1.1; try { own = Number(root.localStorage.getItem('kr.uiSize')) || 1.1; } catch (e) { /* the default */ }
      var w0 = root.innerWidth; kd.setZoom(1.25); await sleep(800); var w1 = root.innerWidth; var css = ''; try { css = root.document.documentElement.style.zoom; } catch (e) { /* no page */ }
      kd.setZoom(own); await sleep(800); var w2 = root.innerWidth;
      must(w2 === w0 || Math.abs(w2 - w0) < 2, 'not back: ' + w0 + ' → ' + w2);
      return (css ? 'CSS zoom (this build\'s Tauri has no set_zoom)' : 'the web view zoomed: ' + w0 + ' → ' + w1 + ' px wide');
    }, 10000);
    await check('setProgress: the taskbar\'s progress', false, async function () {
      must(kd.setProgress(0.4) === undefined, 'answered');
      var r = await env.invoke('kr_progress', { p: 0.5 }); var r2 = await env.invoke('kr_progress', { p: -1 });
      return r && r2 ? 'set and taken away' : 'this build\'s Tauri has no set_progress_bar';
    }, 10000);
    await check('copyImage: a picture on the system clipboard (read back)', false, async function () {
      var ok = await kd.copyImage(toB64(makePng(40, 24))); must(ok === true, 'answer ' + short(ok));
      var back = await env.invoke('kr_selftest_clipimage', {});
      must(back && back.width === 40 && back.height === 24, 'read back ' + short(back));
      return '40×24 put and read back';
    }, 15000);

    /* stage R5 — the app's icon of the user's choosing (appicon.rs): a picture chosen → the PNG and the .ico (its
       sizes drawn by the page) kept, the window's icon set (Windows; Linux under Xvfb; a Mac's windows have none);
       given back as the one in force; a picture that is no PNG refused; reset → no file, the default icon. (The title
       bar showing it, after a start: the engine test, with a screenshot.) */
    await check('app icon: chosen → kept, put on the window; refused when not a PNG; reset', cfg.os !== 'darwin', async function () {
      must(typeof kd.appIcon === 'function', 'no appIcon');
      var url = 'data:image/png;base64,' + toB64(makePng(64, 64));
      must((await kd.appIcon({ set: url })) === true, 'not set');
      var st = await env.invoke('kr_selftest_icon', {});
      must(st && st.png > 0, 'no picture kept: ' + short(st));
      must((await kd.appIcon()) === url, 'not given back as the one in force');
      var icoN = (st.ico || []).length;
      var win = st.last && st.last.window;
      if (cfg.os === 'win32') must(icoN === 7, 'the .ico has ' + icoN + ' sizes');
      if (st.setIcon) must(win === true, 'the window\'s icon: ' + short(win));
      var bad = await rejects(kd.appIcon({ set: 'data:image/png;base64,' + toB64(utf8('GIF89a not a png at all, no')) }));
      must(bad instanceof Error, 'a picture that is no PNG was taken');
      must((await kd.appIcon()) === url, 'the refused one replaced it');
      must((await kd.appIcon({ set: null })) === true, 'not reset');
      var st2 = await env.invoke('kr_selftest_icon', {});
      must(st2.png === null && !(st2.ico || []).length, 'files left: ' + short(st2));
      must((await kd.appIcon()) === null, 'still given back after reset');
      return 'kept in ' + st.dir + '; .ico of ' + icoN + ' sizes; window: ' + short(win) + (st.last && st.last.desktopEntry ? '; desktop entry: ' + short(st.last.desktopEntry) : '') + '; refused a non-PNG; reset (window: ' + short(st2.last && st2.last.window) + ')';
    }, 30000);

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

  var lib = { NAMES: NAMES, ASSET: ASSET, verdict: verdict, sameBytes: sameBytes, utf8: utf8, join: join, crc32: crc32, fromB64: fromB64, toB64: toB64, zipStored: zipStored, makePng: makePng, run: run };
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
      ua: function () { try { return root.navigator.userAgent; } catch (e) { return ''; } },
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
