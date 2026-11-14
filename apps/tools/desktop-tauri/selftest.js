// The Tauri shell's runtime self-test (CI only). Added after bridge.js to the window's initialization script by
// src-tauri/src/selftest.rs only when the KT_SELFTEST environment variable is set, after a line that sets
// window.__KT_SELFTEST__ = { base, temp, otherTemp, otherWhy, aria2Bin, aria2Bundled, wantBundled, text, gzText, binB64,
// bigSize, bigSha256, megaKey, megaPlainB64, megaEncB64, os }. Without that object it does nothing. Once the page has loaded it runs its checks through
// window.kurokawaTools — the same calls the page makes —, sends the results so far to kt_selftest_progress after
// each, and the whole list to kt_selftest_done, which writes them and ends the process (0 all required checks
// passed, 1 not). A check is { name, ok, detail, required }. The pure parts are on window.__KT_SELFTEST_LIB__ for
// tests/tauribridge.cjs.
(function (root) {
  'use strict';
  // md5 / sha1 / sha256 of «abc».
  var ABC = { md5: '900150983cd24fb0d6963f7d28e17f72', sha1: 'a9993e364706816aba3e25717850c26c9cd0d89d', sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' };

  /** 0 when there are results and every required one passed, 1 otherwise (what selftest.rs decides too). */
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
  function join(dir, name, os) { var sep = os === 'win32' ? '\\' : '/'; return String(dir).replace(/[\\/]+$/, '') + sep + name; }
  function find(list, id) { if (!Array.isArray(list)) return null; for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i]; return null; }
  /** Base64 → bytes (no atob needed). */
  function b64bytes(s) {
    var A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'; var out = []; var acc = 0; var bits = 0;
    for (var i = 0; i < s.length; i++) { var v = A.indexOf(s.charAt(i)); if (v < 0) continue; acc = (acc << 6) | v; bits += 6; if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); acc &= (1 << bits) - 1; } }
    return out;
  }
  function latin(buf) { var a = bytesOf(buf); var s = ''; for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return s; }
  function utf8(s) { var out = []; var b = unescape(encodeURIComponent(s)); for (var i = 0; i < b.length; i++) out.push(b.charCodeAt(i)); return out; }
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function toB64(u) {
    var out = ''; var n = u.length; var i = 0;
    for (; i + 2 < n; i += 3) { var x = (u[i] << 16) | (u[i + 1] << 8) | u[i + 2]; out += B64[x >> 18] + B64[(x >> 12) & 63] + B64[(x >> 6) & 63] + B64[x & 63]; }
    if (n - i === 1) { var y = u[i] << 16; out += B64[y >> 18] + B64[(y >> 12) & 63] + '=='; }
    else if (n - i === 2) { var z = (u[i] << 16) | (u[i + 1] << 8); out += B64[z >> 18] + B64[(z >> 12) & 63] + B64[(z >> 6) & 63] + '='; }
    return out;
  }
  var CRC_TABLE = null;
  function crc32(u) {
    if (!CRC_TABLE) { CRC_TABLE = []; for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE.push(c >>> 0); } }
    var crc = 0xFFFFFFFF; for (var i = 0; i < u.length; i++) crc = CRC_TABLE[(crc ^ u[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function le(n, k) { var a = []; for (var i = 0; i < k; i++) a.push(Math.floor(n / Math.pow(256, i)) & 255); return a; }
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
  function short(x) { var s; try { s = typeof x === 'string' ? x : JSON.stringify(x); } catch (e) { s = String(x); } return s && s.length > 300 ? s.slice(0, 300) + '…' : String(s); }

  /**
   * The checks. kt: window.kurokawaTools. env: { sleep(ms), invoke(cmd, args), doc (document), now() }.
   * Resolves with the results, after kt_selftest_done was sent.
   */
  async function run(kt, cfg, env, results) {
    results = results || [];
    var sleep = env.sleep;
    function progress() { try { Promise.resolve(env.invoke('kt_selftest_progress', { results: results })).catch(function () {}); } catch (e) { /* none */ } }
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

    await check('bridge', true, function () { must(kt && kt.platform === 'desktop', 'no window.kurokawaTools'); must(typeof kt.add === 'function' && typeof kt.onTasks === 'function', 'engine methods missing'); return 'present'; });
    if (!kt) { await env.invoke('kt_selftest_done', { results: results }); return results; }
    await check('ready', true, async function () { var s = await kt.ready(); must(s && ['win32', 'darwin', 'linux'].indexOf(s.os) >= 0, 'os ' + (s && s.os)); must(s.arch, 'no arch'); must(kt.os === cfg.os, 'os ' + kt.os + ' ≠ ' + cfg.os); return s.os + '/' + s.arch + ' available=' + s.available; });
    await check('roots', true, async function () { var r = await kt.roots(); must(r && Array.isArray(r.roots) && r.roots.length > 0, 'no roots'); return r.roots; });
    await check('defaultDir', true, async function () { var d = await kt.defaultDir(); must(typeof d === 'string' && d.length > 0, 'empty'); return d; });
    await check('listDir', true, async function () { var r = await kt.listDir(cfg.temp); must(r && r.exists === true && Array.isArray(r.entries), 'not listed'); return r.entries.length + ' entries in ' + cfg.temp; });
    var txt = '', bin = '';
    await check('writeTemp → pathInfo → readFile', true, async function () {
      txt = await kt.writeTemp('kt-selftest.txt', 'abc'); must(typeof txt === 'string' && txt, 'no path');
      var i = await kt.pathInfo(txt); must(i && i.exists && !i.dir && i.size === 3, 'pathInfo ' + short(i));
      var b = await kt.readFile(txt); must(sameBytes(b, [97, 98, 99]), 'bytes ' + short(bytesOf(b)));
      return txt;
    });
    await check('writeTempBytes', true, async function () {
      bin = await kt.writeTempBytes({ name: 'kt-selftest.bin', b64: 'AAEC/w==', sub: 'kt-selftest' }); must(typeof bin === 'string' && bin, 'no path');
      var b = await kt.readFile(bin); must(sameBytes(b, [0, 1, 2, 255]), 'bytes ' + short(bytesOf(b)));
      return bin;
    });
    await check('hashFile', true, async function () { var h = await kt.hashFile(txt); must(h && h.md5 === ABC.md5 && h.sha1 === ABC.sha1 && h.sha256 === ABC.sha256 && h.size === 3, short(h)); return 'md5 sha1 sha256 of abc'; });
    await check('removeFile → exists', true, async function () { await kt.removeFile(txt); await kt.removeFile(bin); var e = await kt.exists([txt, bin]); must(Array.isArray(e) && e[0] === false && e[1] === false, short(e)); return 'gone'; });

    var base = cfg.base;
    await check('http text + headers', true, async function () { must(base, 'no test server'); var r = await kt.http({ url: base + '/text' }); must(r.status === 200, 'status ' + r.status); must(r.body === cfg.text, 'body ' + short(r.body)); must(r.headers['x-kt-test'] === '1', 'x-kt-test ' + r.headers['x-kt-test']); must(r.headers['x-kt-multi'] === 'a, b', 'x-kt-multi ' + r.headers['x-kt-multi']); return r.body; });
    await check('http redirect', true, async function () { var r = await kt.http({ url: base + '/redirect' }); must(r.status === 200 && r.body === cfg.text, 'status ' + r.status + ' ' + short(r.body)); must(/\/text$/.test(r.url), 'url ' + r.url); return r.url; });
    await check('http gzip', true, async function () { var r = await kt.http({ url: base + '/gzip' }); must(r.body === cfg.gzText, 'body ' + short(r.body)); return 'decoded'; });
    await check('http binary', true, async function () { var r = await kt.http({ url: base + '/bin', binary: true }); must(r.body === cfg.binB64, 'base64 ' + short(r.body)); return '256 bytes'; });
    await check('http POST', true, async function () { var body = 'نص ✓'; var r = await kt.http({ url: base + '/echo', method: 'post', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: body }); must(r.body === 'POST:' + body, 'body ' + short(r.body)); return r.body; });
    await check('clipboardText', false, async function () { var t = await kt.clipboardText(); must(typeof t === 'string', typeof t); return 'string of ' + t.length; });
    await check('UI rendered', true, async function () {
      var n = await waitFor(function () { var d = env.doc; var nav = d && d.querySelector && d.querySelector('.nav-rail, .bottom-nav'); return nav && d.querySelectorAll('[data-dest]').length > 0 ? nav : null; }, 20000, 'navigation');
      return (n.className || 'nav') + ', ' + env.doc.querySelectorAll('[data-dest]').length + ' places';
    }, 25000);
    // (Start-up timing, as the Reader's: the page's first paint and its first screen in place, in ms from the program's
    // start — boot.rs. Printed in every part, so CI's summary shows it per system; whether the window took the page's
    // colour before it painted is said too.)
    await check('start-up: first paint and app ready (ms from the program\'s start)', true, async function () {
      var t = null, until = env.now() + 15000;
      while (!t) { var x = await env.invoke('kt_boot_times', {}); if (x && x.paint != null && x.ready != null) t = x; else if (env.now() > until) throw new Error('timeout: both marks ' + short(x)); else await env.sleep(200); }
      must(t.paint > 0 && t.ready > 0 && t.ready < 120000, short(t));
      return t.line + (t.colourAtStart ? '; the window opens in the page\'s colour' : '; no window colour before the page (background_color not in this Tauri)');
    }, 20000);

    // (KT_SELFTEST_PART — cfg.part: 1 the first half below, 2 the second, 0 all. The rows above run in both.)
    var part = cfg.part === 1 || cfg.part === 2 ? cfg.part : 0;
    rec('self-test part', true, part ? part + ' of 2' : 'whole', false);
    if (part !== 2) {
    /* stage P3: the recycle bin, free space, fonts, MEGA; the Files page's jobs */
    await runP3(kt, cfg, env, check, must, waitFor);

    /* stage P7: archives */
    await runP7(kt, cfg, env, check, must);
    /* stage P8: DNS over HTTPS, the updater */
    await runP8(kt, cfg, env, check, must);
    /* stage P6 part: the app's icon */
    await runIcon(kt, cfg, env, check, must);
    /* stage P5: the video tools (stand-in programs, a loopback release server) */
    await runP5(kt, cfg, env, check, must, waitFor);
    }
    if (part !== 1) {
    /* the engine */
    var engine = !!cfg.aria2Bin;
    rec('aria2c binary', cfg.wantBundled ? !!cfg.aria2Bundled : true, (cfg.aria2Bin || 'none found') + (cfg.aria2Bundled ? ' (bundled)' : ''), !!cfg.wantBundled);
    var up = await check('engine available', engine, async function () {
      if (!kt.available) await kt.retryEngine();
      await waitFor(function () { return kt.available; }, 30000, 'engine');
      return 'available';
    }, 45000);
    if (up) await runDownload(kt, cfg, env, check, must, waitFor, engine);
    /* stage P4: torrent streaming and the local stream server */
    await runP4(kt, cfg, env, check, must, waitFor, !!up);
    /* stage P8: the Wi-Fi share, the local API, the antivirus check — from loopback */
    await runLan(kt, cfg, env, check, must);
    /* stage P7: the in-app browser on the test site */
    await runBrowser(kt, cfg, env, check, must, waitFor);
    /* screen translator: capture, the overlay / caption / popup windows, OCR, keys and tray — left off */
    await runScreen(kt, cfg, env, check, must);
    /* stage P6: the computer's side of the downloads (last: a second launch opens the add sheet) */
    await runP6(kt, cfg, env, check, must, waitFor);
    }
    try { await env.invoke('kt_selftest_done', { results: results }); } catch (e) { /* the watchdog writes what there is */ }
    return results;
  }

  /** One file job run to its end through filesJob / onFilesJob: `answers` the replies to its questions in turn,
   *  `cancelAt` 'progress' to cancel at the first progress. Resolves with { end, asked, progress }. */
  function fileJob(kt, o, answers, cancelAt) {
    return new Promise(function (ok, no) {
      var asked = []; var progress = 0; var id = o.id; var done = false;
      var t = setTimeout(function () { if (!done) { done = true; off(); no(new Error('timeout: job ' + id)); } }, 30000);
      var off = kt.onFilesJob(function (ev) {
        if (!ev || ev.id !== id || done) return;
        if (ev.status === 'progress') { progress++; if (cancelAt === 'progress' && progress === 1) kt.filesCancel({ id: id }); return; }
        if (ev.status === 'conflict') { asked.push(ev); var a = (answers || [])[asked.length - 1] || 'skip'; kt.filesAnswer({ id: id, answer: a }); return; }
        done = true; clearTimeout(t); off(); ok({ end: ev, asked: asked, progress: progress });
      });
      Promise.resolve(kt.filesJob(o)).catch(function (e) { if (!done) { done = true; clearTimeout(t); off(); no(e); } });
    });
  }

  /* screen translator (screentr.rs, screencap.rs; rules in kt-core's screenlogic.rs). A window this test draws (colour
     bars, black text on white) is captured as the app captures it and its pixels compared; the frozen screen's window
     opens and its job holds the monitor's picture; a region drawn comes back as its crop (the AI path: no OCR, no
     network); the system's OCR reads the drawn text where there is one (Tesseract on CI's Linux; reported elsewhere);
     «auto»'s caption opens click-through and stopping leaves no window or helper; the clipboard's window opens and
     closes; everything off again. Translations the windows ask for go to the loopback test server only (the page's
     screen settings point an «AI» engine there, put back after). Required on Windows and on Linux under X11 (Xvfb);
     a Mac's rows are reported (its runners have no Screen Recording permission). */
  async function runScreen(kt, cfg, env, check, must) {
    if (!kt.screenStatus) { await check('screen: in the bridge', true, async function () { must(false, 'screenStatus is missing'); }); return; }
    var S = function (o) { return env.invoke('kt_selftest_screen', { o: o }); };
    var waitA = async function (fn, ms, what) { var until = env.now() + ms; for (;;) { var v = await fn(); if (v) return v; if (env.now() > until) throw new Error('timeout: ' + what); await env.sleep(200); } };
    var near = function (a, b, tol) { return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol; };
    var st0 = {}; try { st0 = (await S({ act: 'state' })) || {}; } catch (e) { st0 = { error: String((e && e.message) || e) }; }
    var win = cfg.os === 'win32'; var mac = cfg.os === 'darwin';
    var can = win || (cfg.os === 'linux' && st0.capture === 'x11');
    // (A Mac without the Screen Recording permission — CI's runners —: the capture rows say so instead of asking.)
    var noPerm = mac && st0.permission === false ? 'skipped: this Mac has not given the Screen Recording permission' : '';
    var shown = function (label) { return async function () { var x = ((await S({ act: 'state' })) || {}).windows || []; for (var i = 0; i < x.length; i++) if (x[i].label === label && x[i].visible) return x[i]; return null; }; };
    var gone = function (label) { return async function () { var x = ((await S({ act: 'state' })) || {}).windows || []; for (var i = 0; i < x.length; i++) if (x[i].label === label) return null; return true; }; };
    // (The page's screen settings kept, an «AI» engine on the loopback test server put in their place.)
    var KEY = 'kt.screen'; var keep = null; var store = env.storage || null;
    try { if (store) { keep = store.getItem(KEY); store.setItem(KEY, JSON.stringify({ engine: 'ai', source: 'en', target: 'ar', ai: { preset: 'custom', style: 'openai', base: cfg.base + '/no-translator', key: 'k', model: 'm', prompt: '' } })); } } catch (e) { /* no storage */ }
    var base = { engine: 'ai', source: 'en', target: 'ar', interval: 1, autoStop: 0, read: 'auto', labels: { region: 'R', translateScreen: 'F', bubble: 'Screen' },
      ai: { style: 'openai', base: cfg.base + '/no-translator', key: 'k', model: 'm', prompt: '', headers: {} } };
    var conf = function (on, extra) { var c = JSON.parse(JSON.stringify(base)); c.pcOn = on; c.pc = Object.assign({ keys: { region: 'Alt+Shift+T', full: 'Alt+Shift+F', repeat: 'Alt+Shift+R', auto: 'Alt+Shift+A', clipboard: 'Alt+Shift+C' }, tray: false, startup: false, ocr: 'ai', closeOnBlur: true }, extra || {}); return c; };
    await check('screen: status answered in Electron\'s shape (+ how this system captures)', true, async function () {
      var s = await kt.screenStatus();
      must(s && s.platform === cfg.os && typeof s.on === 'boolean' && typeof s.tray === 'boolean' && typeof s.auto === 'boolean', short(s));
      must(s.keys && ['region', 'full', 'repeat', 'auto', 'clipboard'].every(function (k) { return s.keys[k] && typeof s.keys[k].acc === 'string' && typeof s.keys[k].ok === 'boolean'; }), 'keys ' + short(s.keys));
      must(['windows', 'vision', 'tesseract', 'ai', 'none'].indexOf(s.ocr) >= 0, 'ocr ' + s.ocr);
      must(s.capture && typeof s.capture.kind === 'string', 'capture ' + short(s.capture));
      return 'capture ' + s.capture.kind + (s.capture.why ? ' (' + s.capture.why + ')' : '') + ', OCR ' + s.ocr + (s.permission ? ', permission ' + s.permission : '') + ', monitors ' + short(st0.monitors) + ', mouse ' + short(st0.cursor);
    });
    await check('screen: turned on — its shortcuts registered beside the hotkeys', win, async function () {
      var s = await kt.screenConfig({ config: conf(true) });
      must(s && s.on === true, short(s));
      var st = (await S({ act: 'state' })) || {};
      if (!st.shortcuts) return 'no global shortcuts here (' + short(st) + ')';
      must(s.keys.region.ok && s.keys.clipboard.ok, 'keys ' + short(s.keys));
      return 'bound ' + short(st.bound);
    });
    await check('screen: its tray icon, and the window then closes to the tray', !mac, async function () {
      var s = await kt.screenConfig({ config: conf(true, { tray: true }) });
      var st = (await S({ act: 'state' })) || {};
      if (!st.tray && st.trayWhy) return 'no tray here: ' + st.trayWhy;
      must(s.tray === true && st.keepInTray === true, short({ tray: s.tray, st: st }));
      s = await kt.screenConfig({ config: conf(true) });
      st = (await S({ act: 'state' })) || {};
      must(s.tray === false && st.keepInTray === false, 'still kept in the tray ' + short(st));
      return 'made, closing kept the app in the tray; taken away';
    });
    var drawn = null;
    var sample = function (d) { return [[d.w * 0.25, d.h / 6, [255, 0, 0]], [d.w * 0.25, d.h / 2, [0, 255, 0]], [d.w * 0.25, d.h * 5 / 6, [0, 0, 255]], [d.w * 0.95, d.h * 0.06, [255, 255, 255]]]; };
    var compare = async function (url, ox, oy, d) {
      must(env.pixels, 'no pixel reader');
      var pts = sample(d); var got = await env.pixels(url, pts.map(function (p) { return [ox + p[0], oy + p[1]]; }));
      var bad = []; pts.forEach(function (p, i) { if (!near(got.px[i], p[2], 40)) bad.push(short(p[2]) + '≠' + short(got.px[i])); });
      must(!bad.length, 'pixels ' + bad.join(', ') + ' in ' + got.w + '×' + got.h);
      return got;
    };
    await check('screen: a window the test draws, captured as the app captures it — its pixels', can, async function () {
      if (noPerm) return noPerm;
      drawn = await S({ act: 'draw', w: 480, h: 240 });
      must(drawn && drawn.w === 480, short(drawn));
      // (Where this shell can look at the screen, «draw» waits until the window is painted and says how: a window that
      // never paints is the failure itself — in run 43549144577 Linux's showed only its grey.)
      must(drawn.painted !== false, 'the test window: ' + drawn.how);
      var g = await S({ act: 'grab', x: drawn.x, y: drawn.y, w: drawn.w, h: drawn.h });
      must(g && /^data:image\/png;base64,/.test(g.png) && g.w > 0, short(g));
      var got = await compare(g.png, 0, 0, { w: g.w, h: g.h });
      return st0.capture + ': ' + got.w + '×' + got.h + ' at ' + drawn.x + ',' + drawn.y + ' on ' + drawn.monitor + (drawn.how ? '; ' + drawn.how : '');
    }, 45000);
    // (Reported: whether a window made hidden and then shown — the app's frozen screen, caption and clipboard window are
    // made so — paints without help; «after a size nudge» or «hidden and shown again» would say those windows need it.)
    await check('screen: a window made hidden, then shown, paints without help', false, async function () {
      if (!drawn || drawn.painted == null) return 'not looked at here';
      must(/^painted shown /.test(drawn.how || ''), drawn.how);
      return drawn.how;
    });
    var job = null;
    await check('screen: the frozen screen — its window opens frameless on top, its job holds the monitor\'s picture', can, async function () {
      if (noPerm) return noPerm;
      must(drawn, 'nothing drawn');
      await kt.screenAction('region');
      var w = await waitA(shown('kts-overlay'), 15000, 'the overlay window');
      must(w.decorated === false, 'decorated ' + short(w));
      job = await kt.screenJob();
      must(job && job.mode === 'region' && /^data:image\/png;base64,/.test(job.image) && job.width > 0 && job.scale > 0, short(job && { mode: job.mode, width: job.width, scale: job.scale }));
      await compare(job.image, drawn.x, drawn.y, drawn);
      return job.width + '×' + job.height + ', scale ' + job.scale;
    }, 40000);
    await check('screen: a region drawn comes back as its crop (the scale applied), and is kept', can, async function () {
      if (noPerm) return noPerm;
      must(job && drawn, 'no job');
      var s = job.scale; var r = { x: drawn.x / s, y: drawn.y / s, width: drawn.w / s, height: drawn.h / s };
      var res = await kt.screenRegion(r);
      must(res && /^data:image\/png;base64,/.test(res.ai || ''), short(res));
      must(Math.abs(res.offset.x - r.x) < 1 && Math.abs(res.offset.y - r.y) < 1 && Math.abs(res.scale - s) < 1e-6, 'offset ' + short(res.offset) + ' scale ' + res.scale);
      var got = await compare(res.ai, 0, 0, drawn);
      var st = await kt.screenStatus();
      must(st.region && Math.abs(st.region.width - r.width) < 0.01 && typeof st.region.display === 'string', 'region ' + short(st.region));
      return 'crop ' + got.w + '×' + got.h + ', kept on ' + st.region.display;
    }, 30000);
    await check('screen: closed — no frozen screen left', can, async function () {
      if (noPerm) return noPerm;
      await kt.screenClose();
      await waitA(gone('kts-overlay'), 10000, 'the overlay closed');
      return 'closed';
    });
    await check('screen: the system\'s OCR reads the drawn text', cfg.os === 'linux' && st0.ocr === 'tesseract' && can, async function () {
      if (noPerm) return noPerm;
      must(drawn, 'nothing drawn');
      var r = await S({ act: 'ocr', x: drawn.x + drawn.w / 2, y: drawn.y, w: drawn.w / 2, h: drawn.h, lang: 'en' });
      if (r.kind === 'none') return 'no OCR engine here';
      var t = (r.lines || []).join(' ');
      must(/2468/.test(t) || /TOOLS/i.test(t), r.kind + ' read ' + short(t));
      return r.kind + ': ' + t;
    }, 90000);
    await check('screen: OCR languages', false, async function () { var l = await kt.screenOcrLangs(); must(l && typeof l.kind === 'string', short(l)); return short(l); }, 60000);
    await check('screen: auto — the caption opens click-through, and stopping leaves no window or helper', can, async function () {
      if (noPerm) return noPerm;
      await kt.screenConfig({ config: conf(true, { ocr: 'system' }) });
      await kt.screenAction('auto');
      var c, st, sent, focus = [];
      try {
        c = await waitA(shown('kts-caption'), 15000, 'the caption window');
        st = (await S({ act: 'state' })) || {};
        must(st.auto === true, 'auto ' + st.auto);
        must(st.clickThrough !== false, 'not click-through');
        // (Never focused on Windows — looked at again for a second: the focus is given back once the show is done —;
        // an X server without a window manager — CI's Xvfb — gives the focus by the pointer.)
        for (var i = 0; i < 5; i++) { await env.sleep(250); var cc = await shown('kts-caption')(); focus.push(cc ? cc.focused : null); }
        await env.sleep(1250);
        st = (await S({ act: 'state' })) || {};
        sent = st.sent;
      } finally {
        // (Stopped whatever failed above, so the rows after this one do not run beside a caption and its helper.)
        var now = (await S({ act: 'state' })) || {};
        if (now.auto) await kt.screenAction('auto');
      }
      await waitA(async function () { var x = (await S({ act: 'state' })) || {}; return !x.auto && x.ocrRunning === 0 && (await gone('kts-caption')()) ? x : null; }, 15000, 'auto stopped, no caption, no helper');
      if (win) must(focus.length === 5 && focus.every(function (f) { return f === false; }), 'the caption took the focus: ' + short(focus));
      return 'click-through ' + (st.clickThrough === null ? 'not in this build' : st.clickThrough) + ', focused ' + short(focus) + ', captions sent ' + sent + (st.lastError ? ', last error: ' + st.lastError : '');
    }, 60000);
    await check('screen: the clipboard\'s translation opens by the mouse and closes', can, async function () {
      await S({ act: 'popup', text: 'Good night' });
      await waitA(shown('kts-popup'), 15000, 'the popup');
      var j = await kt.screenJob(); must(j && j.mode === 'text' && j.text === 'Good night', short(j));
      await kt.screenClose();
      await waitA(gone('kts-popup'), 10000, 'the popup closed');
      return 'opened, closed';
    }, 40000);
    try { await S({ act: 'undraw' }); } catch (e) { /* gone */ }
    await check('screen: turned off — no shortcut, tray, window or helper left', true, async function () {
      var s = await kt.screenConfig({ config: conf(false) });
      must(s && s.on === false && s.tray === false && s.auto === false, short(s));
      var st = await waitA(async function () { var x = (await S({ act: 'state' })) || {}; return (x.windows || []).length === 0 ? x : null; }, 10000, 'no screen window');
      must((st.bound || []).length === 0 && st.ocrRunning === 0, short(st));
      return 'off';
    }, 30000);
    if (mac) await rec2(check, 'screen: macOS Screen Recording permission', st0.permission);
    try { if (store) { if (keep === null) store.removeItem(KEY); else store.setItem(KEY, keep); } } catch (e) { /* no storage */ }
  }
  function rec2(check, name, v) { return check(name, false, async function () { return v === true ? 'granted' : v === false ? 'not granted (the system asks the user once)' : 'not asked here'; }); }

  /* stage P8 (lanshare.rs): every row required everywhere (loopback only; the stand-in scanner is the system's own
     shell told to exit with a code). */
  async function runLan(kt, cfg, env, check, must) {
    if (typeof kt.shareWifi !== 'function') return;
    var lan = function (o) { return env.invoke('kt_selftest_lan', { o: o }); };
    var bytes = []; for (var i = 0; i < 3000; i++) bytes.push((i * 7) & 255);
    var b64 = btoa(String.fromCharCode.apply(null, bytes));
    var file = null, sh = null, base = '';
    await check('wifi share: started, its list page from loopback', true, async function () {
      file = await kt.writeTempBytes({ name: 'kt-share.bin', b64: b64, sub: 'kt-selftest-share' });
      var r = await kt.shareWifi({ paths: [file, file + '.missing'], names: ['a <b>.bin'] }); must(r && r.files === 1, short(r));
      sh = await lan({ act: 'share' }); must(sh && sh.port && sh.key && sh.key.length === 24, short(sh));
      base = 'http://127.0.0.1:' + sh.port + '/';
      var p = await kt.http({ url: base + sh.key + '/' }); must(p.status === 200 && p.body.indexOf('a &lt;b&gt;.bin') > 0 && p.body.indexOf("href='d/0/") > 0, p.status + ' ' + short(p.body));
      return 'url ' + (r.url || 'none (no LAN address here)');
    });
    await check('wifi share: a wrong key, a path out and a number out refused', true, async function () {
      var bad = [base + sh.key.replace(/.$/, function (c) { return c === '0' ? '1' : '0'; }) + '/', base + sh.key + '/../../etc/passwd', base + sh.key + '/d/0/..%2F..%2F..%2Fetc%2Fpasswd', base + sh.key + '/d/%2e%2e/x', base + sh.key + '/d/1/x', base + 'kt-selftest-share/kt-share.bin'];
      for (var k = 0; k < bad.length; k++) { var r = await kt.http({ url: bad[k] }); must(r.status === 404, bad[k].slice(base.length) + ' → ' + r.status); }
      return bad.length + ' refused (404)';
    });
    await check('wifi share: a range download byte for byte', true, async function () {
      var r = await kt.http({ url: base + sh.key + '/d/0/x', headers: { Range: 'bytes=1000-1999' }, binary: true });
      must(r.status === 206 && /^bytes 1000-1999\/3000$/.test(r.headers['content-range'] || ''), r.status + ' ' + short(r.headers));
      must(sameBytes(b64bytes(r.body), bytes.slice(1000, 2000)), 'bytes differ');
      var w = await kt.http({ url: base + sh.key + '/d/0/x', binary: true }); must(w.status === 200 && sameBytes(b64bytes(w.body), bytes), 'whole: ' + w.status);
      var e = await kt.http({ url: base + sh.key + '/d/0/x', headers: { Range: 'bytes=5000-' } }); must(e.status === 416, 'past the end: ' + e.status);
      var st = await kt.shareWifiStatus(); must(st.running && st.sent >= 4000 && st.hits >= 3, short(st));
      return 'sent ' + st.sent + ', hits ' + st.hits;
    });
    await check('wifi share: an upload refused, then stopped', true, async function () {
      var u = await kt.http({ url: base + sh.key + '/d/0/x', method: 'POST', body: 'x'.repeat(2048) }); must(u.status === 405, 'POST → ' + u.status);
      await kt.shareWifiStop();
      var st = await kt.shareWifiStatus(); must(!st.running, 'still running');
      var gone = false; try { await kt.http({ url: base + sh.key + '/' }); } catch (e) { gone = true; } must(gone, 'still answering');
      return 'POST 405; stopped';
    });
    await check('local API: the token on every request (wrong or none refused; Bearer or ?token=)', true, async function () {
      var port = await lan({ act: 'freeport' }); var tok = 'kt-selftest-' + Date.now();
      var r = await kt.localApi({ on: true, token: tok, port: port }); must(r && r.on === true && r.port === port && r.token === tok, short(r));
      var b = 'http://127.0.0.1:' + port;
      var none = await kt.http({ url: b + '/version' }); must(none.status === 401, 'none → ' + none.status);
      var wrong = await kt.http({ url: b + '/version', headers: { Authorization: 'Bearer ' + tok + 'x' } }); must(wrong.status === 401, 'wrong → ' + wrong.status);
      var q = await kt.http({ url: b + '/version?token=' + encodeURIComponent(tok) }); must(q.status === 200 && JSON.parse(q.body).app === 'Kurokawa Tools', 'query → ' + q.status);
      var t = await kt.http({ url: b + '/tasks', headers: { Authorization: 'Bearer ' + tok } }); must(t.status === 200 && Array.isArray(JSON.parse(t.body).tasks), 'tasks → ' + t.status);
      var pre = await kt.http({ url: b + '/add', method: 'OPTIONS' }); must(pre.status === 204 && pre.headers['access-control-allow-origin'] === '*', 'preflight → ' + pre.status);
      var big = await kt.http({ url: b + '/add', method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'x'.repeat(1100000) }) }); must(big.status === 413, 'big body → ' + big.status);
      var nf = await kt.http({ url: b + '/nothing', headers: { Authorization: 'Bearer ' + tok } }); must(nf.status === 404, 'route → ' + nf.status);
      var off = await kt.localApi({ on: false }); must(off.on === false, short(off));
      var gone = false; try { await kt.http({ url: b + '/version?token=' + tok }); } catch (e) { gone = true; } must(gone, 'still answering');
      return 'none/wrong 401, query and Bearer 200, preflight 204, 1.1 MB 413, off';
    });
    await check('antivirus: available answered, a stand-in scanner\'s verdicts', true, async function () {
      var a = await kt.avAvailable(); must(a && typeof a.defender === 'boolean' && typeof a.clamav === 'boolean' && a.platform === cfg.os, short(a));
      var f = file || (await kt.writeTemp('kt-av.txt', 'x'));
      var sh = cfg.os === 'win32' ? { command: 'cmd.exe', ok: '/c exit 0', bad: '/c exit 3' } : { command: '/bin/sh', ok: '-c "exit 0" {file}', bad: '-c "exit 3" {file}' };
      var c = await kt.avScan({ cfg: { kind: 'custom', command: sh.command, args: sh.ok }, file: f }); must(c.result === 'clean', 'exit 0 → ' + short(c));
      var i = await kt.avScan({ cfg: { kind: 'custom', command: sh.command, args: sh.bad }, file: f }); must(i.result === 'infected', 'exit 3 → ' + short(i));
      var s = await kt.avScan({ cfg: { kind: 'custom', command: sh.command, args: sh.bad, extensions: ['exe'] }, file: f }); must(s.result === 'skipped', 'not an .exe → ' + short(s));
      var n = await kt.avScan({ cfg: { kind: 'custom', command: '' }, file: f }); must(n.result === 'error' && n.detail === 'no-scanner', short(n));
      return 'defender ' + a.defender + ', clamav ' + a.clamav + '; clean, infected, skipped, no scanner';
    }, 30000);
  }

  /* stage P7 (browser.rs): the browser opened on the test site; Grab, a magnet and a download handed to the app
     (kt:browser) with the site's cookies; the app's requests then carry them; a link aimed at a new window kept; closed.
     Required on Windows (and the download where build.rs found on_download); elsewhere reported with the reason. */
  async function runBrowser(kt, cfg, env, check, must, waitFor) {
    if (typeof kt.browse !== 'function') return;
    var win = cfg.os === 'win32';
    var b = function (o) { return env.invoke('kt_selftest_browse', { o: o }); };
    var waitA = async function (fn, ms, what) { var until = env.now() + ms; for (;;) { var v = await fn(); if (v) return v; if (env.now() > until) throw new Error('timeout: ' + what); await env.sleep(250); } };
    var seen = []; var off = kt.onBrowser(function (o) { seen.push(o); });
    var browseWin = async function () { return ((await b({ act: 'list' })) || []).filter(function (w) { return w.label.indexOf('ktb-browse') === 0; })[0] || null; };
    var opened = await check('browser: opened on the test site', win, async function () {
      must(await kt.browse({ url: cfg.base + '/site/' }) === true, 'browse did not answer true');
      var w = await waitA(async function () { var x = await browseWin(); return x && x.url.indexOf('/site/') > 0 ? x : null; }, 20000, 'the browser window on /site/');
      await env.sleep(2000);
      return w.label + (cfg.os !== 'darwin' ? ', keeper: ' + ((await b({ act: 'list' })) || []).some(function (x) { return x.label.indexOf('ktb-keep') === 0; }) : '');
    }, 30000);
    if (!opened) { off(); return; }
    await check('browser: Grab hands the page\'s links to the app (kt:browser links)', win, async function () {
      seen.length = 0; await b({ act: 'cmd', cmd: 'grab' });
      var o = await waitFor(function () { return seen.filter(function (x) { return x && x.kind === 'links'; })[0]; }, 20000, 'kt:browser links');
      must((o.links || []).some(function (l) { return /\/site\/file\.epub$/.test(l.href); }) && o.url.indexOf('/site/') > 0 && o.title, short(o));
      return (o.links || []).length + ' links, ua ' + (o.ua ? 'given' : 'none');
    }, 30000);
    await check('browser: a magnet the page goes to reaches the app, the page stays', win, async function () {
      seen.length = 0; var m = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=kt-browser';
      await b({ act: 'eval', js: 'location.href = ' + JSON.stringify(m) + ';' });
      var o = await waitFor(function () { return seen.filter(function (x) { return x && x.kind === 'download' && x.url === m; })[0]; }, 15000, 'kt:browser magnet');
      var w = await browseWin(); must(w && w.url.indexOf('/site/') > 0, 'the page left: ' + short(w));
      return 'handed over';
    }, 25000);
    var api = await b({ act: 'cookies', url: cfg.base + '/site/' }).catch(function () { return {}; });
    await check('browser: a download handed to the app with the site\'s cookies', win && !!api.download, async function () {
      must(api.download, 'no on_download in this build');
      seen.length = 0; await b({ act: 'eval', js: 'document.getElementById("dl").click();' });
      var o = await waitFor(function () { return seen.filter(function (x) { return x && x.kind === 'download' && /\/site\/file\.epub$/.test(x.url); })[0]; }, 20000, 'kt:browser download');
      must(o.name && o.referer && o.referer.indexOf('/site/') > 0, short(o));
      if (api.api) must(/kr_site=/.test(o.cookie || ''), 'no site cookie: ' + short(o));
      return o.name + (o.cookie ? ', cookies given' : ', no cookie API');
    }, 30000);
    await check('browser: the app\'s requests carry the browser\'s cookies', false, async function () {
      must(api.api, 'no cookies_for_url in this build');
      var r = await kt.http({ url: cfg.base + '/site/private' });
      must(r.status === 200 && /^signed-in/.test(r.body), r.status + ' ' + short(r.body));
      return r.body.slice(0, 40);
    });
    await check('browser: a link aimed at a new window opens in the same window', false, async function () {
      await b({ act: 'eval', js: 'document.getElementById("pop").click();' });
      await waitA(async function () { var x = await browseWin(); return x && /\/site\/popup/.test(x.url) ? x : null; }, 15000, 'the popup in the same window');
      var n = ((await b({ act: 'list' })) || []).filter(function (x) { return x.label.indexOf('ktb-browse') === 0; }).length; must(n === 1, n + ' browser windows');
      return 'kept';
    }, 25000);
    await check('browser: closed', win, async function () {
      await b({ act: 'close' });
      await waitA(async function () { return !(await browseWin()); }, 10000, 'the window closed');
      return 'closed';
    }, 15000);
    off();
  }

  /* stage P6 (desktop.rs): prefs, the tray, the clipboard hotkeys (one registered, one refused plainly; a press's way to
     the page), the taskbar, keep-awake, a notice, the mini window, a second launch's hand-over. Required on Windows (the
     owner's system and CI's fullest); elsewhere each says why when it cannot be. */
  async function runP6(kt, cfg, env, check, must, waitFor) {
    if (typeof kt.desktopPrefs !== 'function') return;
    var win = cfg.os === 'win32'; var mac = cfg.os === 'darwin';
    var st = async function () { return (await env.invoke('kt_selftest_desk', { o: { act: 'state' } })) || {}; };
    await check('desktop: prefs answered as Electron\'s deskPrefs', true, async function () {
      var r = await kt.desktopPrefs({ keepAwake: true, whenDone: 'nothing', notifyDone: true, tray: false, hotkeys: {} });
      must(r && r.keepAwake === true && r.whenDone === 'nothing' && r.notifyDone === true && r.tray === false && r.hotkeys && typeof r.hotkeys === 'object', short(r));
      var r2 = await kt.desktopPrefs({ whenDone: 'reboot' }); must(r2.whenDone === 'nothing', 'took an unknown whenDone');
      return 'ok';
    });
    var s0 = await st().catch(function () { return {}; });
    await check('desktop: tray icon made, then hidden', !!s0.trayPossible && !mac, async function () {
      must(s0.trayPossible, s0.trayWhy || 'no tray here');
      await kt.desktopPrefs({ tray: true, labels: { app: 'Kurokawa Tools', quit: 'Quit' } });
      var s1 = null; for (var i = 0; i < 25; i++) { s1 = await st(); if (s1.tray) break; await env.sleep(200); }
      must(s1 && s1.tray, 'not made: ' + (s1 && s1.trayWhy));
      await kt.desktopPrefs({ tray: false });
      var s2 = null; for (var k = 0; k < 25; k++) { s2 = await st(); if (!s2.tray) break; await env.sleep(200); }
      must(s2 && !s2.tray, 'still shown');
      return 'made and hidden';
    });
    await check('desktop: a hotkey registered, a bad one refused plainly', win, async function () {
      must(s0.shortcuts, 'global shortcuts not available here (' + s0.os + ')');
      var r = await kt.desktopPrefs({ hotkeys: { clip: 'CommandOrControl+Shift+F11', video: 'AltGr+V' } });
      must(r.hotkeyErrors && r.hotkeyErrors.video && !r.hotkeyErrors.clip, short(r.hotkeyErrors));
      var s1 = await st(); must((s1.bound || []).some(function (b) { return b[1] === 'clip'; }), 'clip not bound: ' + short(s1.bound));
      var r2 = await kt.desktopPrefs({ hotkeys: {} }); must(!r2.hotkeyErrors, short(r2.hotkeyErrors));
      var s2 = await st(); must(!(s2.bound || []).length, 'still bound');
      return 'bound ' + s1.bound[0][0] + '; refused: ' + r.hotkeyErrors.video;
    });
    await check('desktop: a hotkey\'s press reaches the page (kt:hotkeyAdd)', true, async function () {
      var got = null; var off = kt.onHotkeyAdd(function (p) { got = p; });
      await env.sleep(300);
      await env.invoke('kt_selftest_desk', { o: { act: 'hotkey', mode: 'clip' } });
      await waitFor(function () { return got; }, 8000, 'kt:hotkeyAdd'); off();
      must(got.mode === 'clip' && typeof got.text === 'string', short(got));
      return 'mode ' + got.mode;
    });
    await check('desktop: taskbar progress', win, async function () {
      var a = await env.invoke('kt_selftest_desk', { o: { act: 'progress', p: 0.5 } }); var b = await env.invoke('kt_selftest_desk', { o: { act: 'progress', p: -1 } });
      must(a === true && b === true, 'set ' + a + ', cleared ' + b + (s0.progressApi ? '' : ' (no set_progress_bar in this build)'));
      return 'set and cleared';
    });
    await check('desktop: kept awake, then let go', win, async function () {
      var a = await env.invoke('kt_selftest_desk', { o: { act: 'awake', on: true } }); var b = await env.invoke('kt_selftest_desk', { o: { act: 'awake', on: false } });
      must(a && a.awake && a.alive, 'not held: ' + short(a)); must(b && !b.awake, 'not let go');
      return a.how;
    });
    await check('desktop: a notice shown', false, async function () { var r = await env.invoke('kt_selftest_desk', { o: { act: 'notify' } }); must(r === true, 'not shown'); return 'shown'; });
    await check('desktop: the mini window (no frame) opened and closed', !mac, async function () {
      var r = await kt.mini({ action: 'open' }); must(r && r.open === true, short(r));
      var w = null; for (var i = 0; i < 40; i++) { var l = await env.invoke('kt_selftest_desk', { o: { act: 'windows' } }); w = (l || []).filter(function (x) { return x.label === 'mini'; })[0]; if (w) break; await env.sleep(200); }
      must(w, 'no mini window'); must(w.decorated === false, 'it has a frame');
      await env.sleep(1500);
      var c = await kt.mini({ action: 'close' }); must(c && c.open === false, short(c));
      for (var k = 0; k < 40; k++) { var l2 = await env.invoke('kt_selftest_desk', { o: { act: 'windows' } }); if (!(l2 || []).some(function (x) { return x.label === 'mini'; })) return 'opened, closed'; await env.sleep(200); }
      throw new Error('still open');
    }, 30000);
    var site = function (o) { return env.invoke('kt_selftest_site', { o: o }); };
    await check('desktop: a sign-in window gives the address with the marker, then closes (captureUrl)', !mac, async function () {
      var p = kt.captureUrl({ url: cfg.base + '/text', marker: 'kt_marker=', title: 'Kurokawa Tools' });
      var w = null; for (var i = 0; i < 50 && !w; i++) { w = ((await site({ act: 'list' })) || [])[0] || null; if (!w) await env.sleep(200); }
      must(w, 'no sign-in window');
      await env.sleep(800);
      await site({ act: 'go', label: w.label, url: cfg.base + '/text?kt_marker=1#access_token=abc' });
      var got = await Promise.race([p, new Promise(function (ok) { setTimeout(function () { ok('timeout'); }, 15000); })]);
      must(typeof got === 'string' && got.indexOf('kt_marker=1') > 0, 'answered ' + short(got));
      var p2 = kt.captureUrl({ url: cfg.base + '/text', marker: 'never-there', title: 'x' });
      var w2 = null; for (var k = 0; k < 50 && !w2; k++) { w2 = ((await site({ act: 'list' })) || [])[0] || null; if (!w2) await env.sleep(200); }
      must(w2, 'no second sign-in window'); await site({ act: 'close', label: w2.label });
      var got2 = await Promise.race([p2, new Promise(function (ok) { setTimeout(function () { ok('timeout'); }, 15000); })]);
      must(got2 === null, 'closed: answered ' + short(got2));
      return 'marker caught; closed → null';
    }, 45000);
    await check('desktop: a site window refuses a plain http address (siteWindow)', true, async function () {
      var r = await kt.siteWindow({ url: cfg.base + '/text', title: 'x' }); must(r === false, 'answered ' + short(r)); return 'refused';
    });
    await check('desktop: a second launch hands over a magnet and a .torrent, and ends', win, async function () {
      must(s0.single, 'no single-instance here (Linux without a D-Bus session bus)');
      var tor = await kt.writeTempBytes({ name: 'kt-selftest.torrent', b64: 'ZDQ6aW5mb2Rl' });
      var mag = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=kt-selftest';
      var r = await env.invoke('kt_selftest_desk', { o: { act: 'second', args: [mag, tor] } });
      must(r && r.ended, 'the second launch did not end: ' + short(r));
      var log = await waitFor(function () { var l = (env.openLog ? env.openLog() : root.__KT_OPEN_LOG__) || []; return l.some(function (x) { return x.indexOf('magnet:?xt=urn:btih:0123') === 0; }) && l.some(function (x) { return x.indexOf('data:application/x-bittorrent;base64,ZDQ6aW5mb2Rl') === 0; }) ? l : null; }, 10000, 'kt:open');
      return log.length + ' handed over';
    }, 30000);
  }

  async function runP3(kt, cfg, env, check, must, waitFor) {
    var os = cfg.os; var J = function (d, n) { return join(d, n, os); };
    var text = async function (p) { return latin(await kt.readFile(p)); };
    var trashed = false;
    var has = async function (ps) { return kt.exists(ps); };
    await check('deletePath (to the recycle bin)', true, async function () {
      var f = J(J(cfg.temp, 'kt-selftest-trash-' + env.now()), 'gone.txt');
      await kt.writeText({ path: f, text: 'bin' }); must((await has([f]))[0] === true, 'not written');
      var r = await kt.deletePath(f); must(r && r.ok === true, short(r)); must((await has([f]))[0] === false, 'still there');
      trashed = r.trashed === true;
      await kt.deletePath(f.replace(/[\\/]gone\.txt$/, ''));
      return trashed ? 'in the recycle bin' : 'removed (the recycle bin refused it)';
    });
    // (Linux's is this shell's own — the freedesktop.org layout —, so it must work there; Windows' and a Mac's are the
    // system's own calls, reported.)
    await check('deletePath went to the recycle bin', os === 'linux', function () { must(trashed, 'removed instead'); return 'yes'; });
    await check('archiveFree (free space)', true, async function () { var r = await kt.archiveFree({ dir: J(cfg.temp, 'no-such-folder-' + env.now()) }); must(r && typeof r.free === 'number' && r.free > 0 && r.free < 1e15, short(r)); return Math.round(r.free / 1048576) + ' MB free'; });
    var fdirs = [];
    await check('fontDirs', true, async function () { fdirs = await kt.fontDirs(); must(Array.isArray(fdirs), short(fdirs)); return fdirs.length ? fdirs : 'none on this system'; });
    await check('fontIndex', true, async function () {
      var ix = await kt.fontIndex(fdirs); must(Array.isArray(ix), short(ix));
      for (var i = 0; i < ix.length; i++) must(ix[i] && typeof ix[i].path === 'string' && Array.isArray(ix[i].families) && ix[i].families.length > 0, short(ix[i]));
      return ix.length + ' fonts' + (ix[0] ? ', e.g. ' + ix[0].families[0] : '');
    }, 60000);
    await check('megaDecrypt', true, async function () {
      var p = await kt.writeTempBytes({ name: 'kt-selftest-mega.bin', b64: cfg.megaEncB64, sub: 'kt-selftest' });
      var r = await kt.megaDecrypt({ path: p, key: cfg.megaKey }); must(r === true, short(r));
      var b = await kt.readFile(p); must(sameBytes(b, b64bytes(cfg.megaPlainB64)), 'bytes differ');
      await kt.removeFile(p); return bytesOf(b).length + ' bytes decrypted';
    });

    /* the Files page's jobs, on temp folders */
    var jobsHere = typeof kt.filesJob === 'function' && typeof kt.onFilesJob === 'function';
    if (!(await check('files: the jobs are there', true, function () { must(jobsHere, 'no filesJob / onFilesJob'); return 'filesJob, filesCancel, filesAnswer, onFilesJob'; }))) return;
    var base = J(cfg.temp, 'kt-selftest-files-' + env.now()); var src = J(base, 'src'); var dst = J(base, 'dst'); var n = 0;
    var id = function () { n++; return 'st-' + n + '-' + env.now(); };
    await kt.writeText({ path: J(src, 'a.txt'), text: 'A' }); await kt.writeText({ path: J(J(src, 'D'), 'x.txt'), text: 'X' }); await kt.writeText({ path: J(J(J(src, 'D'), 'sub'), 'y.txt'), text: 'Y' });
    await kt.writeText({ path: J(dst, '.keep'), text: '' });
    await check('files: copy files and a folder', true, async function () {
      var r = await fileJob(kt, { id: id(), op: 'copy', paths: [J(src, 'a.txt'), J(src, 'D')], dest: dst, conflict: 'ask' });
      must(r.end.status === 'done' && r.end.files === 3 && r.end.failed.length === 0, short(r.end));
      must((await text(J(dst, 'a.txt'))) === 'A' && (await text(J(J(J(dst, 'D'), 'sub'), 'y.txt'))) === 'Y', 'contents');
      must((await has([J(src, 'a.txt')]))[0] === true, 'a copy removed its original');
      return r.end.files + ' files, ' + r.progress + ' progress events';
    });
    await check('files: a name taken — keep both', true, async function () {
      var r = await fileJob(kt, { id: id(), op: 'copy', paths: [J(src, 'a.txt')], dest: dst, conflict: 'ask' }, ['keep']);
      must(r.asked.length === 1 && r.asked[0].to === J(dst, 'a.txt') && r.asked[0].size === 1 && r.asked[0].dir === false, short(r.asked));
      must((await text(J(dst, 'a (2).txt'))) === 'A', 'no «a (2).txt»'); return 'a (2).txt';
    });
    await check('files: replace, the same for all that follow', true, async function () {
      await kt.writeText({ path: J(src, 'b.txt'), text: 'B2' }); await kt.writeText({ path: J(dst, 'b.txt'), text: 'B1' });
      var r = await fileJob(kt, { id: id(), op: 'copy', paths: [J(src, 'a.txt'), J(src, 'b.txt')], dest: dst, conflict: 'ask' }, ['replaceAll']);
      must(r.asked.length === 1, 'asked ' + r.asked.length + ' times'); must((await text(J(dst, 'b.txt'))) === 'B2', 'not replaced');
      must((await has([J(dst, 'b.txt.ktpart'), J(dst, 'b.txt.ktold')])).every(function (x) { return !x; }), 'a part file left');
      return 'asked once, both replaced';
    });
    await check('files: a move skipped keeps its original', true, async function () {
      await kt.writeText({ path: J(src, 'c.txt'), text: 'C2' }); await kt.writeText({ path: J(dst, 'c.txt'), text: 'C1' });
      var r = await fileJob(kt, { id: id(), op: 'move', paths: [J(src, 'c.txt')], dest: dst, conflict: 'ask' }, ['skip']);
      must(r.end.skipped === 1 && r.end.left === 1 && r.end.remaining.length === 1, short(r.end));
      must((await text(J(src, 'c.txt'))) === 'C2' && (await text(J(dst, 'c.txt'))) === 'C1', 'contents');
      return 'left in place';
    });
    await check('files: a folder into itself refused', true, async function () {
      var r = await fileJob(kt, { id: id(), op: 'copy', paths: [J(src, 'D')], dest: J(J(src, 'D'), 'sub'), conflict: 'ask' });
      must(r.end.failed.length === 1 && /itself/.test(r.end.failed[0]), short(r.end)); must((await has([J(J(J(src, 'D'), 'sub'), 'D')]))[0] === false, 'copied into itself');
      return r.end.failed[0];
    });
    var big = 'x'.repeat(4 << 20);
    await check('files: cancelled mid-copy — the file it replaced kept whole, no part left', true, async function () {
      await kt.writeText({ path: J(src, 'big.bin'), text: big }); await kt.writeText({ path: J(dst, 'big.bin'), text: 'OLD' });
      var r = await fileJob(kt, { id: id(), op: 'copy', paths: [J(src, 'big.bin')], dest: dst, conflict: 'replace', pace: 120 }, [], 'progress');
      must(r.end.status === 'cancelled', short(r.end)); must((await text(J(dst, 'big.bin'))) === 'OLD', 'the old file changed');
      must((await has([J(dst, 'big.bin.ktpart')]))[0] === false, 'a part file left'); return 'cancelled after ' + r.progress + ' progress event(s)';
    });
    var other = cfg.otherTemp;
    if (other) {
      await check('files: a folder moved to another disk', true, async function () {
        var r = await fileJob(kt, { id: id(), op: 'move', paths: [J(src, 'D')], dest: other, conflict: 'ask' });
        must(r.end.status === 'done' && r.end.left === 0 && r.end.remaining.length === 0, short(r.end));
        must((await has([J(src, 'D')]))[0] === false && (await text(J(J(J(other, 'D'), 'sub'), 'y.txt'))) === 'Y', 'not moved whole');
        return other;
      });
      await check('files: a move to another disk cancelled — the original stays, nothing half there', true, async function () {
        var r = await fileJob(kt, { id: id(), op: 'move', paths: [J(src, 'big.bin')], dest: other, conflict: 'ask', pace: 120 }, [], 'progress');
        must(r.end.status === 'cancelled' && r.end.left === 1, short(r.end));
        var e = await has([J(src, 'big.bin'), J(other, 'big.bin'), J(other, 'big.bin.ktpart')]); must(e[0] === true && e[1] === false && e[2] === false, short(e));
        return 'original kept';
      });
      await fileJob(kt, { id: id(), op: 'delete', paths: [other] }).catch(function () {});
    } else {
      await check('files: moves across disks', false, function () { throw new Error('skipped: ' + (cfg.otherWhy || 'no second disk')); });
    }
    /* the storages, new folder, rename, stat (the phone plugin's shapes), and a cancel sent at once */
    await check('files: storages (filesRoots)', true, async function () {
      must(typeof kt.filesRoots === 'function' && typeof kt.homeDir === 'function', 'no filesRoots / homeDir');
      var r = await kt.filesRoots(); var roots = (r && r.roots) || [];
      var home = await kt.homeDir(); must(typeof home === 'string' && home.length > 0, 'homeDir ' + short(home));
      must(roots.length > 0 && roots[0].kind === 'home' && roots[0].path === home, 'home first ' + short(roots[0]));
      var drives = roots.filter(function (x) { return x.kind === 'drive'; });
      must(drives.length > 0, 'no disk listed');
      for (var i = 0; i < roots.length; i++) { var x = roots[i]; must(typeof x.path === 'string' && x.path && typeof x.name === 'string' && typeof x.readable === 'boolean', short(x)); }
      must(drives.every(function (d) { return typeof d.free === 'number' && typeof d.total === 'number' && d.total > 0 && d.free <= d.total; }), 'space ' + short(drives));
      return roots.map(function (x) { return x.kind + ' ' + x.name; }).join(', ');
    });
    await check('files: new folder, rename, stat', true, async function () {
      var made = J(base, 'New folder'); var r = await kt.filesMkdir({ path: made }); must(r && r.ok === true, 'mkdir ' + short(r));
      var st = await kt.filesStat({ path: made }); must(st.exists === true && st.dir === true && st.writable === true && st.readable === true && st.name === 'New folder', 'stat ' + short(st));
      var rn = await kt.filesRename({ path: made, name: 'Renamed' }); must(rn && rn.ok === true && rn.path === J(base, 'Renamed'), 'rename ' + short(rn));
      var taken = ''; try { await kt.filesRename({ path: J(base, 'Renamed'), name: 'src' }); } catch (e) { taken = e.message; }
      must(taken === 'exists', 'a name taken: «' + taken + '»');
      var bad = ''; try { await kt.filesRename({ path: J(base, 'Renamed'), name: 'a/b' }); } catch (e) { bad = e.message; }
      must(bad, 'a name with a separator accepted');
      var f = await kt.filesStat({ path: J(src, 'a.txt') }); must(f.exists && !f.dir && f.size === 1 && f.mtime > 0, 'file ' + short(f));
      var none = await kt.filesStat({ path: J(base, 'none') }); must(none.exists === false, 'none ' + short(none));
      return 'made, renamed, «exists» refused, stat';
    });
    await check('files: a cancel sent at once is not lost', true, async function () {
      // (filesJob and filesCancel sent together, neither awaited: the shell registers the job before its thread.)
      var j1 = id(); var p1 = fileJob(kt, { id: j1, op: 'copy', paths: [J(src, 'big.bin')], dest: J(base, 'Renamed'), conflict: 'ask', pace: 50 });
      kt.filesCancel({ id: j1 });
      var r1 = await p1; must(r1.end.status === 'cancelled', 'together: ' + short(r1.end));
      // (A Cancel that came even before the job: kept for it.)
      var j2 = id(); await kt.filesCancel({ id: j2 });
      var r2 = await fileJob(kt, { id: j2, op: 'copy', paths: [J(src, 'big.bin')], dest: J(base, 'Renamed'), conflict: 'ask', pace: 50 });
      must(r2.end.status === 'cancelled', 'before: ' + short(r2.end));
      must((await has([J(J(base, 'Renamed'), 'big.bin')]))[0] === false, 'copied anyway');
      return 'both cancelled';
    });
    await check('files: delete a folder and all in it', true, async function () {
      var r = await fileJob(kt, { id: id(), op: 'delete', paths: [base] });
      must(r.end.status === 'done' && r.end.failed.length === 0, short(r.end)); must((await has([base]))[0] === false, 'still there');
      return r.end.files + ' items';
    });
  }

  /* stage P7 — archives (archives.rs over the shared archive.rs): the 7-Zip shipped with the app found; a zip made of a
     folder and a file → listed (with its entries' dates) → tested → extracted, every byte the same; a part of it taken
     out (only what was chosen, no other folder made); entries copied out the Files page's way (extracted into a hidden
     «.kurokawa-extract-*» folder at the destination, moved in by a file job, the hidden folder removed); extracted in
     place; a zip that would write outside its folder refused before anything is written; with the shipped 7-Zip
     (required where CI bundles it: Windows and Linux): a 7z with a made-up password — refused without it and with a
     wrong one, extracted with it — and a tar.gz in two layers. */
  async function runP7(kt, cfg, env, check, must) {
    var os = cfg.os; var J = function (d, n) { return join(d, n, os); }; var sep = os === 'win32' ? '\\' : '/';
    var write = function (p, bytes) { return env.invoke('kt_selftest_write', { p: p, b64: toB64(bytes) }); };
    var gone = async function (p) { return (await kt.exists([p]))[0] === false; };
    var rejects = async function (p) { try { await p; return null; } catch (e) { return e; } };
    var wantSeven = !!cfg.wantSeven;
    await check('archives: the 7-Zip shipped with the app', wantSeven, async function () {
      var r = await env.invoke('kt_selftest_7z', { args: [] });
      must(r && r.path, 'no 7-Zip found'); must(r.own, 'only the system\'s 7-Zip (' + r.path + '), not the app\'s own');
      return r.path;
    }, 15000);
    var adir = J(cfg.temp, 'kt-archive-' + env.now()); var aSrc = J(adir, 'Book Folder'); var aSub = J(aSrc, 'sub ✓');
    var textBytes = utf8('Alice was beginning to get very tired ✓ نص. '.repeat(300));
    var binBytes = []; for (var bi = 0; bi < 3000; bi++) binBytes.push((bi * 37 + 11) & 255);
    var aFiles = [[J(aSrc, 'a.txt'), 'Book Folder/a.txt', textBytes], [J(aSub, 'b.bin'), 'Book Folder/sub ✓/b.bin', binBytes], [J(adir, 'c.dat'), 'c.dat', utf8('c ✓')]];
    var at = function (dest, rel) { return J(dest, rel.split('/').join(sep)); };
    async function same(dest, which) {
      for (var i = 0; i < aFiles.length; i++) {
        if (which && which.indexOf(i) < 0) continue;
        var got = await kt.readFile(at(dest, aFiles[i][1])); must(sameBytes(got, aFiles[i][2]), aFiles[i][1] + ': ' + bytesOf(got).length + ' bytes, not the same');
      }
    }
    var zip = J(adir, 'made.zip'); var aOk = false;
    await check('archives: a zip made → listed (with dates) → tested → extracted, every byte the same', true, async function () {
      must(typeof kt.archiveCreate === 'function' && typeof kt.archiveList === 'function' && typeof kt.onArchiveProgress === 'function', 'no archive functions');
      for (var i = 0; i < aFiles.length; i++) must((await write(aFiles[i][0], aFiles[i][2])) === true, 'not written: ' + aFiles[i][0]);
      var heard = 0; var off = kt.onArchiveProgress(function (pr) { if (pr && pr.id === 'kt-st-zip') heard++; });
      var c;
      try { c = await kt.archiveCreate({ id: 'kt-st-zip', out: zip, inputs: [aSrc, aFiles[2][0]] }); } finally { await env.sleep(300); off(); }
      must(c && c.files === 3 && c.size > 0 && c.path === zip, 'made ' + short(c));
      var info = await kt.archiveList({ path: zip });
      var files = (info.entries || []).filter(function (e) { return !e.dir; });
      must(info.format === 'zip' && !info.unsafe && !info.encrypted && info.inPlaceOk, 'listed ' + short(info));
      must(files.map(function (e) { return e.path; }).sort().join('|') === aFiles.map(function (f) { return f[1]; }).sort().join('|'), 'entries ' + short(files));
      var now = env.now(); must(files.every(function (e) { return typeof e.mtime === 'number' && Math.abs(e.mtime - now) < 86400000; }), 'dates ' + short(files.map(function (e) { return e.mtime; })));
      var t = await kt.archiveTest({ id: 'kt-st-test', path: zip }); must(t && t.ok && t.files === 3, 'test ' + short(t));
      var out = J(adir, 'out'); var x = await kt.archiveExtract({ id: 'kt-st-x', path: zip, dest: out, replace: 'replace' });
      must(x && x.files === 3 && x.dest === out, 'extracted ' + short(x));
      await same(out);
      var ex = await kt.archiveExisting({ dest: out, names: ['c.dat', 'nope.txt', '../made.zip'] }); must(short(ex.existing) === '["c.dat"]', 'existing ' + short(ex));
      aOk = true;
      return '3 files, ' + c.size + ' bytes; dated; tested; extracted and compared; ' + heard + ' progress events';
    }, 60000);
    await check('archives: part of a zip taken out — only what was chosen, no other folder made', true, async function () {
      must(aOk, 'no zip made');
      var out = J(adir, 'part'); var x = await kt.archiveExtract({ id: 'kt-st-part', path: zip, dest: out, only: ['Book Folder/sub ✓/'], replace: 'replace' });
      must(x && x.files === 1, 'extracted ' + short(x));
      await same(out, [1]);
      must(await gone(at(out, 'Book Folder/a.txt')) && await gone(J(out, 'c.dat')), 'more than was chosen');
      var x2 = await kt.archiveExtract({ id: 'kt-st-part2', path: zip, dest: J(adir, 'part2'), only: ['c.dat'], replace: 'replace' });
      must(x2.files === 1 && await gone(J(J(adir, 'part2'), 'Book Folder')), 'a folder made for nothing');
      return 'a folder and a file, each alone';
    }, 30000);
    await check('archives: copied out the Files page\'s way (a hidden folder at the destination, a file job, the folder removed)', true, async function () {
      must(aOk, 'no zip made'); must(typeof kt.filesJob === 'function', 'no file jobs');
      var dest = J(adir, 'pasted'); await kt.filesMkdir({ path: dest });
      var stage = J(dest, '.kurokawa-extract-st' + env.now());
      await kt.archiveExtract({ id: 'kt-st-stage', path: zip, dest: stage, only: ['Book Folder/'], replace: 'replace' });
      var r = await fileJob(kt, { id: 'kt-st-in-' + env.now(), op: 'move', paths: [J(stage, 'Book Folder')], dest: dest, conflict: 'ask' });
      must(r.end.status === 'done' && r.end.left === 0, 'moved in ' + short(r.end));
      var d = await fileJob(kt, { id: 'kt-st-rm-' + env.now(), op: 'delete', paths: [stage] });
      must(d.end.status === 'done' && await gone(stage), 'the hidden folder left');
      await same(dest, [0, 1]);
      return 'in place, the hidden folder gone';
    }, 30000);
    await check('archives: extracted in place (the archive gone after)', true, async function () {
      must(aOk, 'no zip made');
      var zip2 = J(adir, 'inplace.zip'); var c = await kt.archiveCreate({ id: 'kt-st-zip2', out: zip2, inputs: [aSrc, aFiles[2][0]] });
      var dest = J(adir, 'in place'); var x = await kt.archiveExtract({ id: 'kt-st-ip', path: zip2, dest: dest, inPlace: true, replace: 'replace', keepFree: 0 });
      must(x.files === 3, 'extracted ' + short(x)); must(await gone(zip2), 'the archive is still there');
      await same(dest);
      return c.size + ' bytes taken out in place';
    }, 60000);
    await check('archives: a zip that would write outside its folder is refused', true, async function () {
      var evil = '../kt-evil-' + env.now() + '.txt'; var hz = J(adir, 'hostile.zip');
      must((await write(hz, zipStored([['fine.txt', utf8('fine')], [evil, utf8('pwned')]]))) === true, 'not written');
      var info = await kt.archiveList({ path: hz }); must(info.unsafe === evil, 'listed without «unsafe»: ' + short(info));
      var dest = J(adir, 'hostile out');
      var e = await rejects(kt.archiveExtract({ id: 'kt-st-evil', path: hz, dest: dest, replace: 'replace' }));
      must(e instanceof Error && e.message === 'unsafePath ' + evil, 'answer ' + (e ? e.message : 'extracted'));
      must(await gone(J(adir, evil.slice(3))) && await gone(J(dest, 'fine.txt')), 'something was written');
      return 'refused: unsafePath ' + evil;
    }, 30000);
    var PW = 'kt-made-up-' + (env.now() % 1000);
    await check('archives: a 7z with a password (the shipped 7-Zip)', wantSeven, async function () {
      must(aOk, 'no test files');
      var z7 = J(adir, 'locked.7z');
      var mk = await env.invoke('kt_selftest_7z', { args: ['a', '-t7z', '-mhe=on', '-p' + PW, z7, aSrc, aFiles[2][0]] }); must(mk && mk.code === 0, '7-Zip could not make it (exit ' + (mk && mk.code) + ')');
      var e1 = await rejects(kt.archiveList({ path: z7 })); must(e1 && /password/i.test(e1.message), 'listed without its password: ' + (e1 ? e1.message : 'yes'));
      var info = await kt.archiveList({ path: z7, password: PW });
      must(info.format === '7z' && info.encrypted && (info.entries || []).filter(function (x) { return !x.dir; }).length === 3, 'listed ' + short({ format: info.format, encrypted: info.encrypted, n: (info.entries || []).length }));
      var dest = J(adir, 'from 7z');
      var e2 = await rejects(kt.archiveExtract({ id: 'kt-st-7w', path: z7, dest: dest, password: PW + 'x', replace: 'replace' })); must(e2 && /password/i.test(e2.message), 'a wrong password: ' + (e2 ? e2.message : 'extracted'));
      var x = await kt.archiveExtract({ id: 'kt-st-7z', path: z7, dest: dest, password: PW, replace: 'replace' }); must(x && typeof x.files === 'number', 'extracted ' + short(x));
      await same(dest);
      return 'refused without it and with a wrong one, extracted with it';
    }, 90000);
    await check('archives: a tar.gz in two layers (the shipped 7-Zip)', wantSeven, async function () {
      must(aOk, 'no test files');
      var tar = J(adir, 'set.tar'); var tgz = J(adir, 'set.tar.gz');
      var a1 = await env.invoke('kt_selftest_7z', { args: ['a', '-ttar', tar, aSrc, aFiles[2][0]] }); must(a1 && a1.code === 0, 'tar not made (exit ' + (a1 && a1.code) + ')');
      var a2 = await env.invoke('kt_selftest_7z', { args: ['a', '-tgzip', tgz, tar] }); must(a2 && a2.code === 0, 'gzip not made (exit ' + (a2 && a2.code) + ')');
      var info = await kt.archiveList({ path: tgz }); must(info.format === 'tar.gz', 'listed ' + short(info.format));
      var dest = J(adir, 'from tgz'); var x = await kt.archiveExtract({ id: 'kt-st-tgz', path: tgz, dest: dest, replace: 'replace' });
      await same(dest);
      return 'tar.gz: ' + x.files + ' files out';
    }, 90000);
    await fileJob(kt, { id: 'kt-st-clean-' + env.now(), op: 'delete', paths: [adir] }).catch(function () {});
  }
  /* stage P8 — DNS over HTTPS (the shared resolver under Tools' names): with the test server's resolver chosen, a name no
     real DNS knows reaches the test server, the probe answers in its shape, «off» gives the system's DNS back; the
     updater (update.rs over kt-core's updatelogic): the test server's 3 MiB file fetched as an update — broken off after
     1 MiB and resumed —, checked against its SHA-256 (kept) and a wrong one (refused, removed), no checksum refused;
     this bare program refuses to install before fetching anything. */
  async function runP8(kt, cfg, env, check, must) {
    var base = cfg.base; var port = String(base).split(':').pop();
    var rejects = async function (p) { try { await p; return null; } catch (e) { return e; } };
    await check('DNS over HTTPS: a made-up name found through the chosen resolver', true, async function () {
      must(typeof kt.setDoh === 'function' && typeof kt.dohProbe === 'function', 'no setDoh / dohProbe');
      var resolver = base + '/dns-query';
      var before = Number((await kt.http({ url: base + '/dns-count' })).body);
      var s = await kt.setDoh({ provider: resolver }); must(s && s.provider === resolver, 'setDoh ' + short(s));
      try {
        var r = await kt.http({ url: 'http://' + cfg.dohHost + ':' + port + '/text' });
        must(r.status === 200 && r.body === cfg.text, 'status ' + r.status + ' ' + short(r.body));
        var after = Number((await kt.http({ url: base + '/dns-count' })).body);
        must(after > before, 'the resolver was not asked (' + before + ' → ' + after + ')');
        var p = await kt.dohProbe();
        must(p && p.ok === false && typeof p.ms === 'number' && typeof p.why === 'string', 'probe (example.com is not the test resolver\'s) ' + short(p));
        return cfg.dohHost + ' → 127.0.0.1 (' + (after - before) + ' queries); probe: ' + short(p.why).slice(0, 60);
      } finally { var o = await kt.setDoh({ provider: 'off' }); must(o && o.provider === 'off', 'off ' + short(o)); }
    }, 40000);
    await check('DNS over HTTPS off: the made-up name is the system\'s again (not found)', false, async function () {
      var e = await rejects(kt.http({ url: 'http://' + cfg.dohHost + ':' + port + '/text' }));
      must(e instanceof Error, 'found without the resolver');
      return 'not found: ' + short(e.message).slice(0, 80);
    }, 25000);
    await check('updater: resume, checksum, refusals', true, async function () {
      must(typeof kt.installUpdate === 'function' && typeof kt.onUpdateProgress === 'function', 'no installUpdate / onUpdateProgress');
      var r = await env.invoke('kt_selftest_updatedl', { url: base + '/large/kt-update.bin' });
      must(r && r.size === cfg.largeSize, 'size ' + short(r));
      must(r.resumedFrom > 0 && r.resumedFrom < r.size, 'resumed from ' + r.resumedFrom);
      must(r.ok === true, 'its checksum ' + short(r));
      must(r.refused === 'kt-update:checksum' && r.removedWhenRefused === true, 'a wrong checksum ' + short(r));
      must(r.noChecksum === 'kt-update:nochecksum', 'no checksum ' + short(r));
      if (r.kind === 'bare') {
        var refused = null; try { await kt.installUpdate('https://example.invalid/KurokawaTools-9.9.9-win-x64.exe'); } catch (e) { refused = e && e.message; }
        must(refused === 'kt-update:bare', 'installing on a bare program ' + short(refused));
        must((await kt.updateDownload({ beta: false })) === 'unsupported', 'a background download on a bare program');
        must((await kt.updateInstall()) === false, 'nothing downloaded');
      }
      return 'resumed from ' + r.resumedFrom + ' of ' + r.size + '; refused: ' + r.refused + '; kind ' + r.kind + (r.file ? ', its file ' + r.file : '');
    }, 60000);
  }
  /* stage P5 — the video tools (vtools.rs, vtjobs.rs, vtffmpeg.rs over kt-core's videotools / vidjson; the transcode
     stream on P4's stream server, streamproxy.rs),
     with no real program or site: the app's own executable stands in for yt-dlp, gallery-dl, ffmpeg and ffprobe
     (vtfake.rs, active only in this run), fetched from a loopback release server (kt_selftest_vt). yt-dlp fetched — its
     first download broken off and resumed —, checked against SHA2-256SUMS, asked its version; `-J` shaped for the Add
     sheet; a video job's progress, phases and file; a running job removed with its whole tree; a failing job's error;
     an update to a newer release (the one before kept), a broken newer one rolled back at once, a wrong checksum
     refused, a rollback by hand; gallery-dl's listing; the ffmpeg pack (a wrong checksum refused, a cancel mid-way, a
     download resumed); ffmpeg's run with its progress, a cancel ending the tree; ffprobe's JSON; the transcode stream's
     and the sound track's bytes; the pack removed. Absent methods (a build without them): nothing is checked. */
  async function runP5(kt, cfg, env, check, must, waitFor) {
    if (typeof kt.videoReady !== 'function') return;
    var rejects = async function (p) { try { await p; return null; } catch (e) { return e || new Error('rejected'); } };
    var op = function (o) { return env.invoke('kt_selftest_vt', { o: o }); };
    var vt = null;
    var up = await check('video tools: the stand-ins\' release server', true, async function () {
      vt = await op({ op: 'setup' }); must(vt && vt.base && vt.dir, 'setup ' + short(vt)); return vt.base + ' (' + vt.os + ')';
    });
    if (!up) return;
    var os = vt.os; var dir = join(vt.dir, 'videos', os);
    var latest = []; var off = kt.onTasks(function (l) { if (Array.isArray(l)) latest = l; });
    var snaps = {};
    var off2 = kt.onTasks(function (l) { (l || []).forEach(function (t) { if (t && t.kind === 'video') (snaps[t.id] = snaps[t.id] || []).push(JSON.parse(JSON.stringify(t))); }); });
    var cur = function (id) { return find(latest, id); };
    var pids = async function (file) {
      var until = env.now() + 15000;
      for (;;) { try { var p = await op({ op: 'pids', file: file }); if (Array.isArray(p) && p.length === 2 && p[0] > 0 && p[1] > 0) return p; } catch (e) { /* not written yet */ } if (env.now() > until) throw new Error('no pids in ' + file); await env.sleep(150); }
    };
    var gone = async function (ps, ms) { var until = env.now() + ms; for (;;) { var a = await op({ op: 'alive', pids: ps }); if (a.every(function (x) { return !x; })) return true; if (env.now() > until) throw new Error('still running: ' + short(a)); await env.sleep(200); } };
    try {
      var fetched = await check('yt-dlp: fetched (resumed), checked, its version', true, async function () {
        var before = await kt.videoVersion(); must(before && before.ready === false && before.version === null, 'already there ' + short(before));
        var prog = 0; var offP = kt.onUpdateProgress(function (p) { if (p && p.what === 'yt-dlp' && p.got > 0) prog++; });
        try {
          var r = await kt.videoReady(); must(r && r.ok === true && r.version === vt.version, 'ready ' + short(r));
          var seen = await op({ op: 'seen' }); must(seen.some(function (l) { return /^GET \/yt\/download\/\S+ bytes=\d+-$/.test(l); }), 'not resumed: ' + short(seen));
          await waitFor(function () { return prog > 0; }, 5000, 'kt:update-progress');
        } finally { offP(); }
        var v = await kt.videoVersion(); must(v.ready === true && v.version === vt.version, short(v));
        return 'yt-dlp ' + v.version + ', ' + prog + ' progress events';
      }, 90000);
      if (!fetched) return;
      await check('isVideoHost', true, async function () {
        must((await kt.isVideoHost('https://m.youtube.com/watch?v=x')) === true, 'youtube'); must((await kt.isVideoHost('https://example.org/a.mp4')) === false, 'example.org');
        return 'youtube yes, example.org no';
      });
      await check('yt-dlp: -J read and shaped (video, playlist, error)', true, async function () {
        var i = await kt.videoInfo({ url: 'https://fake.test/watch?v=abc' });
        must(i && i.kind === 'video' && i.title === 'Fake video' && i.id === 'abc', short(i));
        must(i.choices.length === 2 && i.choices[0].id === '137+140' && i.choices[0].label === '1080p' && i.choices[1].id === '18', 'choices ' + short(i.choices));
        must(i.audio.length === 1 && i.audio[0].id === '140' && i.subtitles.join() === 'en,ar' && i.chapters === 1, 'audio/subs ' + short(i));
        var p = await kt.videoInfo({ url: 'https://fake.test/playlist?list=p', playlist: true });
        must(p.kind === 'playlist' && p.count === 2 && p.entries[1].id === 'b', short(p));
        var e = await rejects(kt.videoInfo({ url: 'https://fake.test/fail' })); must(e && /Unsupported URL/.test(e.message), 'error ' + short(e && e.message));
        return i.choices.map(function (c) { return c.label; }).join(', ') + '; playlist of ' + p.count + '; ' + e.message.slice(0, 50);
      }, 30000);
      await check('yt-dlp: a video job — progress, phases, fragments, its file', true, async function () {
        var t = await kt.add({ source: { url: 'https://fake.test/watch?v=abc' }, dir: dir, video: { title: 'Fake video', args: ['-f', '137+140', '--merge-output-format', 'mp4', '-o', '%(title)s [%(id)s].%(ext)s'], expect: 120000, label: '1080p' } });
        must(t && /^v/.test(t.id) && t.kind === 'video' && t.engine === 'native', short(t));
        var d = await waitFor(function () { var x = cur(t.id); return x && (x.state === 'done' || x.state === 'failed') ? x : null; }, 30000, 'done');
        must(d.state === 'done', d.state + ' ' + (d.error || ''));
        var phases = (snaps[t.id] || []).map(function (x) { return x.meta && x.meta.phase; }).filter(Boolean);
        must(phases.indexOf('video') >= 0 && phases.indexOf('audio') >= 0 && phases.indexOf('merge') >= 0, 'phases ' + short(phases));
        must((snaps[t.id] || []).some(function (x) { return x.meta && x.meta.frags === 40; }), 'no fragment counts');
        must(d.files[0] && d.files[0].path === 'Fake video [abc].mp4' && d.name === 'Fake video [abc]' && d.meta.quality === '1080p', 'file ' + short(d.files) + ' ' + d.name);
        var i = await kt.pathInfo(join(dir, 'Fake video [abc].mp4', os)); must(i.exists && i.size === 120000, 'on disk ' + short(i));
        var l = await kt.list(); must(find(l, t.id), 'not in kt:list');
        await kt.remove(t.id, true);
        var e = await kt.exists([join(dir, 'Fake video [abc].mp4', os)]); must(e[0] === false, 'its file stayed');
        return phases.filter(function (x, k) { return phases.indexOf(x) === k; }).join(' → ') + '; ' + (snaps[t.id] || []).length + ' pushes';
      }, 45000);
      await check('yt-dlp: removing a running job ends its whole tree', true, async function () {
        var d2 = join(dir, 'slow', os);
        var t = await kt.add({ source: { url: 'https://fake.test/slow' }, dir: d2, video: { title: 'Slow', args: ['-f', 'b'] } });
        var ps = await pids(join(d2, 'kt-fake-pids.txt', os));
        var a = await op({ op: 'alive', pids: ps }); must(a[0] && a[1], 'not both running ' + short(a));
        await waitFor(function () { var x = cur(t.id); return x && x.state === 'downloading' && x.done > 0 ? x : null; }, 10000, 'progress');
        await kt.remove(t.id, false);
        await gone(ps, 10000);
        must(!find(await kt.list(), t.id), 'still listed');
        return 'yt-dlp ' + ps[0] + ' and its child ' + ps[1] + ' ended';
      }, 40000);
      await check('yt-dlp: a failing job shows yt-dlp\'s error', true, async function () {
        var t = await kt.add({ source: { url: 'https://fake.test/fail' }, dir: dir, video: { title: 'Fail', args: ['-f', 'b'] } });
        var d = await waitFor(function () { var x = cur(t.id); return x && (x.state === 'failed' || x.state === 'done') ? x : null; }, 20000, 'failed');
        must(d.state === 'failed' && /^\[generic\] Unsupported URL/.test(d.error || ''), d.state + ' ' + d.error);
        var bad = await kt.add({ source: { url: 'https://fake.test/x' }, dir: dir, video: { title: 'Bad', args: ['-f', 'b', '--exec', 'x'] } });
        var b = await waitFor(function () { var x = cur(bad.id); return x && x.state === 'failed' ? x : null; }, 10000, 'refused');
        must(b.error === 'invalid options', 'a list with --exec ' + short(b.error));
        await kt.remove(t.id, false); await kt.remove(bad.id, false);
        return d.error + '; --exec refused';
      }, 30000);
      await check('yt-dlp: an update to a newer release, the one before kept', true, async function () {
        await op({ op: 'serve', version: '2025.12.01' });
        var u = await kt.videoUpdate(); must(u && u.updated === true && u.version === '2025.12.01' && u.latest === '2025.12.01', short(u));
        var b = await kt.videoBinary({}); must(b.managed === true && b.olds[0] === vt.version && b.min, 'kept ' + short(b));
        return vt.version + ' → ' + u.version + ', kept: ' + b.olds.join(', ');
      }, 60000);
      await check('yt-dlp: a broken newer release is rolled back at once', true, async function () {
        await op({ op: 'serve', version: '2025.12.24', mode: 'broken' });
        var e = await rejects(kt.videoUpdate()); must(e && e.message === 'kt-video:rolledback:yt-dlp:2025.12.01', 'update ' + short(e && e.message));
        var v = await kt.videoVersion(); must(v.version === '2025.12.01', 'running ' + short(v));
        return e.message;
      }, 60000);
      await check('yt-dlp: a wrong checksum is refused', true, async function () {
        await op({ op: 'serve', version: '2025.12.30', badSum: true });
        var e = await rejects(kt.videoUpdate()); must(e && /checksum mismatch/.test(e.message), 'update ' + short(e && e.message));
        var v = await kt.videoVersion(); must(v.version === '2025.12.01', 'running ' + short(v));
        return e.message;
      }, 60000);
      await check('yt-dlp: rolled back by hand', true, async function () {
        var r = await kt.videoRollback(); must(r && r.version === vt.version, short(r));
        var v = await kt.videoVersion(); must(v.version === vt.version, 'running ' + short(v));
        var b = await kt.videoBinary({}); must(b.olds.indexOf(vt.version) < 0, 'still kept ' + short(b.olds));
        return 'back to ' + v.version;
      }, 30000);
      await check('gallery-dl: fetched, checked, a gallery listed', vt.gallery, async function () {
        var g0 = await kt.galleryReady(); must(g0 && g0.ready === false, 'already there ' + short(g0));
        if (!vt.gallery) { var n = await rejects(kt.galleryList({ url: 'https://fake.test/g' })); must(n && /no binary/.test(n.message), short(n && n.message)); return 'no standalone gallery-dl for ' + os + ': ' + n.message; }
        var g = await kt.galleryList({ url: 'https://fake.test/g', range: '1-10' });
        must(g.title === 'Fake gallery' && g.items.length === 2 && g.items[0].name === 'one.jpg' && g.items[1].name === '2.png' && g.items[1].headers.Referer === 'https://fake.test/', short(g));
        var r = await kt.galleryReady(); must(r.ready === true && r.version === '1.30.2', short(r));
        var e = await rejects(kt.galleryList({ url: 'https://fake.test/fail' })); must(e && /No suitable extractor/.test(e.message), 'error ' + short(e && e.message));
        return g.items.length + ' items; gallery-dl ' + r.version;
      }, 60000);
      var packed = await check('ffmpeg pack: a wrong checksum refused, a cancel, a resumed install', true, async function () {
        var s0 = await kt.packStatus(); must(s0 && s0.ffmpeg && s0.ffmpeg.version === null && s0.python && s0.platform === os, short(s0));
        var bad = await rejects(kt.packInstall({ name: 'ffmpeg', url: vt.base + '/pack/ffmpeg.gz', sha256: '0'.repeat(64), version: '7.1-kt' }));
        must(bad && bad.message === 'checksum', 'wrong checksum ' + short(bad && bad.message));
        must((await kt.packStatus()).ffmpeg.version === null, 'installed anyway');
        var ev = []; var offP = kt.onPackProgress(function (p) { ev.push(p); });
        try {
          var p = kt.packInstall({ name: 'ffmpeg', url: vt.base + '/pack/slow.gz', sha256: vt.packSha256, version: '7.1-kt' });
          var caught = rejects(p);
          await waitFor(function () { return ev.length > 0; }, 15000, 'kt:packProgress');
          await kt.packCancel('ffmpeg');
          var c = await caught; must(c && c.message === 'cancelled', 'cancel ' + short(c && c.message));
          await kt.packInstall({ name: 'ffmpeg', url: vt.base + '/pack/cut.gz', sha256: vt.packSha256, version: '7.1-kt' });
        } finally { offP(); }
        var s = await kt.packStatus(); must(s.ffmpeg.version === '7.1-kt' && s.ffmpeg.size > 0, short(s));
        var seen = await op({ op: 'seen' }); must(seen.some(function (l) { return /^GET \/pack\/cut\.gz bytes=\d+-$/.test(l); }), 'not resumed ' + short(seen.slice(-5)));
        var last = ev[ev.length - 1]; must(last && last.name === 'ffmpeg' && last.done === vt.packSize && last.total === vt.packSize, 'progress ' + short(last));
        return 'installed ' + s.ffmpeg.version + ' (' + s.ffmpeg.size + ' bytes), ' + ev.length + ' progress events';
      }, 90000);
      if (!packed) return;
      var inPath = '';
      await check('ffmpeg: available (the pack\'s), a run with its progress and file', true, async function () {
        var a = await kt.ffmpegAvailable(); must(a && a.ok === true && /kt-fake/.test(a.version), short(a));
        inPath = await kt.writeTempBytes({ name: 'kt-vt-in.bin', b64: 'AAEC/w==', sub: 'kt-selftest-vt' });
        var out = inPath + '.out.mkv'; var ev = [];
        var offF = kt.onFfmpegProgress(function (p) { if (p && p.id === 'vt-run') ev.push(p); });
        var r; try { r = await kt.ffmpeg({ id: 'vt-run', args: ['-i', inPath, '-c', 'copy', '-progress', 'pipe:1', '-nostats', out] }); } finally { setTimeout(offF, 1000); }
        must(r && r.code === 0 && typeof r.log === 'string', short(r));
        await waitFor(function () { return ev.some(function (p) { return p.done === true; }); }, 3000, 'the last progress');
        var end = ev.filter(function (p) { return p.done; })[0]; must(end.time === 5 && end.size === 5000 && end.speed === 2.5, 'progress ' + short(end));
        must(sameBytes(await kt.readFile(out), [0, 1, 2, 255]), 'its file');
        await kt.removeFile(out);
        return a.version.slice(0, 40) + '; ' + ev.length + ' progress events';
      }, 30000);
      await check('ffmpeg: cancel ends its whole tree', true, async function () {
        var slowIn = await kt.writeTempBytes({ name: 'kt-slow-in.bin', b64: 'AAEC', sub: 'kt-selftest-vt' });
        var out = slowIn + '.out.mkv';
        var run = kt.ffmpeg({ id: 'vt-cancel', args: ['-i', slowIn, '-progress', 'pipe:1', '-nostats', out] });
        // (Each phase named when it fails: in run 43551417003 the installed app's copy of this row timed out at 40 s
        // with no word of where; the bare program's passed.)
        var phase = 'the stand-in\'s pids';
        var ps = await pids(out + '.pids');
        phase = 'cancel'; var t0 = env.now();
        await kt.ffmpegCancel('vt-cancel');
        phase = 'the run\'s end after cancel';
        var r = null, again = false;
        for (var k = 0; k < 3 && !r; k++) {
          r = await Promise.race([run, env.sleep(10000).then(function () { return null; })]);
          if (!r) { again = true; await kt.ffmpegCancel('vt-cancel'); }
        }
        must(r && r.code !== 0, 'ended ' + short(r) + ' (' + phase + ')');
        phase = 'the tree gone'; await gone(ps, 12000);
        return 'code ' + r.code + ' after ' + (env.now() - t0) + ' ms' + (again ? ' (a second cancel was needed)' : '') + '; ffmpeg ' + ps[0] + ' and its child ' + ps[1] + ' ended';
      }, 75000);
      await check('ffprobe: its JSON (ffprobe beside the pack\'s ffmpeg)', true, async function () {
        await op({ op: 'probeBeside' });
        var j = await kt.ffprobe(inPath); must(j && j.streams && j.streams.length === 2 && j.streams[0].codec_type === 'video' && j.format.duration === '12.500000', short(j));
        must((await kt.ffprobe(join(dir, 'no-such-file.mkv', os))) === null, 'a missing file');
        return j.streams.map(function (s) { return s.codec_name; }).join(' + ') + ', ' + j.format.duration + ' s';
      }, 20000);
      await check('transcode stream: the bytes ffmpeg makes, x264 after the cards\' encoders fail', true, async function () {
        var u = await kt.videoUrl(); must(u && /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/video$/.test(u.url), short(u));
        // (One server since the merge: P4's stream server, its token in the address — a wrong one refused.)
        var forged = await kt.http({ url: u.url.replace(/\/([0-9a-f])([0-9a-f]{31})\/video$/, function (_m, c, r) { return '/' + (c === '0' ? '1' : '0') + r + '/video'; }) + '?src=x' });
        must(forged.status === 403, 'wrong token: ' + forged.status);
        var r = await kt.http({ url: u.url + '?src=' + encodeURIComponent(inPath) + '&ss=5&a=1', binary: true });
        must(r.status === 200 && r.headers['x-kt-encoder'] === 'libx264' && /video\/mp4/.test(r.headers['content-type'] || ''), r.status + ' ' + short(r.headers));
        var head = latin(b64bytes(String(r.body).slice(0, 80)));
        must(head.indexOf('KTFAKE-STREAM enc=libx264 ss=5 map=0:v:0,0:a:1?') === 0, 'first bytes ' + short(head));
        must(r.body.length > 600000, 'only ' + r.body.length + ' base64 characters');
        var none = await kt.http({ url: u.url }); must(none.status === 400, 'no src: ' + none.status);
        var a = await kt.audioUrl(); must(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/audio$/.test(a.url) && a.url.split('/')[3] === u.url.split('/')[3], short(a));
        var s = await kt.http({ url: a.url + '?src=' + encodeURIComponent(inPath) + '&ss=2&a=0', binary: true });
        var sh = latin(b64bytes(String(s.body).slice(0, 60)));
        must(s.status === 200 && /audio\/aac/.test(s.headers['content-type'] || '') && sh.indexOf('KTFAKE-STREAM enc=aac ss=2 map=0:a:0') === 0, s.status + ' ' + short(sh));
        return 'video ' + Math.round(r.body.length * 0.75) + ' bytes (' + r.headers['x-kt-encoder'] + '), sound ' + Math.round(s.body.length * 0.75) + ' bytes';
      }, 60000);
      await check('ffmpeg pack removed', true, async function () {
        await kt.packRemove('ffmpeg'); var s = await kt.packStatus(); must(s.ffmpeg.version === null && s.ffmpeg.size === 0, short(s));
        if (inPath) await kt.removeFile(inPath);
        return 'gone';
      });
      // (yt-dlp without a JavaScript runtime — the stand-in prints yt-dlp's warning — → the page's offer (jsRuntime:
      // missing; videoJsRuntime says so) → the «deno» pack fetched from loopback (a stand-in deno) → the next look has it
      // named (--js-runtimes) and first on yt-dlp's PATH → no warning. The runner's own node is never used here.)
      if (kt.videoJsRuntime) await check('deno pack: yt-dlp\'s missing JavaScript runtime said, fetched, then used (args and PATH)', true, async function () {
        var u = 'https://fake.test/watch?v=jswarn';
        var st0 = await kt.videoJsRuntime(); must(st0 && st0.missing === true && st0.installed === null, 'before ' + short(st0));
        var i1 = await kt.videoInfo({ url: u }); must(i1 && i1.jsRuntime === 'missing', 'not said: ' + short(i1 && { title: i1.title, jsRuntime: i1.jsRuntime }));
        must((await kt.videoJsRuntime()).seen === true, 'not seen');
        await kt.packInstall({ name: 'deno', url: vt.base + '/pack/deno.gz', sha256: vt.denoSha256, version: '2.5-kt' });
        var s = await kt.packStatus(); must(s.deno && s.deno.version === '2.5-kt' && s.deno.size > 0, short(s.deno));
        var st1 = await kt.videoJsRuntime(); must(st1.missing === false && st1.runtime === 'deno', 'after ' + short(st1));
        var i2 = await kt.videoInfo({ url: u + '&again=1' }); must(!i2.jsRuntime && /js: args\+PATH/.test(i2.title || ''), 'still missing: ' + short({ title: i2.title, jsRuntime: i2.jsRuntime }));
        await kt.packRemove('deno'); must((await kt.packStatus()).deno.version === null, 'not removed');
        return 'offered, installed (' + s.deno.size + ' bytes), then «' + i2.title + '»; removed';
      }, 60000);
    } finally { off(); off2(); }
  }
  /* stage P6 part — the app's icon of the user's choosing (appicon.rs over the shared appicon.rs): a picture chosen →
     the PNG and the .ico (its sizes drawn by the page) kept, the window's icon set (Windows; Linux under Xvfb; a Mac's
     windows have none); given back as the one in force; a picture that is no PNG refused; reset → no file. */
  function makePng(w, h) {
    var be32 = function (n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; };
    var raw = [];
    for (var y = 0; y < h; y++) { raw.push(0); for (var x = 0; x < w; x++) raw.push((x * 4) & 255, (y * 4) & 255, ((x + y) * 2) & 255, 255); }
    var a = 1, b = 0; for (var i = 0; i < raw.length; i++) { a = (a + raw[i]) % 65521; b = (b + a) % 65521; }
    var z = [0x78, 0x01];
    for (var j = 0; j < raw.length; j += 65535) { var n = Math.min(65535, raw.length - j); z.push(j + n >= raw.length ? 1 : 0, n & 255, n >> 8, ~n & 255, (~n >> 8) & 255); for (var k = 0; k < n; k++) z.push(raw[j + k]); }
    z = z.concat(be32(((b << 16) | a) >>> 0));
    function chunk(type, data) { var td = utf8(type).concat(data); return be32(data.length).concat(td, be32(crc32(td))); }
    return [137, 80, 78, 71, 13, 10, 26, 10].concat(chunk('IHDR', be32(w).concat(be32(h), [8, 6, 0, 0, 0])), chunk('IDAT', z), chunk('IEND', []));
  }
  async function runIcon(kt, cfg, env, check, must) {
    var rejects = async function (p) { try { await p; return null; } catch (e) { return e; } };
    await check('app icon: chosen → kept, put on the window; refused when not a PNG; reset', cfg.os !== 'darwin', async function () {
      must(typeof kt.appIcon === 'function', 'no appIcon');
      var url = 'data:image/png;base64,' + toB64(makePng(64, 64));
      must((await kt.appIcon({ set: url })) === true, 'not set');
      var st = await env.invoke('kt_selftest_icon', {});
      must(st && st.png > 0, 'no picture kept: ' + short(st));
      must((await kt.appIcon()) === url, 'not given back as the one in force');
      var icoN = (st.ico || []).length; var win = st.last && st.last.window;
      if (cfg.os === 'win32') must(icoN === 7, 'the .ico has ' + icoN + ' sizes');
      if (st.setIcon) must(win === true, 'the window\'s icon: ' + short(win));
      var bad = await rejects(kt.appIcon({ set: 'data:image/png;base64,' + toB64(utf8('GIF89a not a png at all, no')) }));
      must(bad instanceof Error, 'a picture that is no PNG was taken');
      must((await kt.appIcon()) === url, 'the refused one replaced it');
      must((await kt.appIcon({ set: null })) === true, 'not reset');
      var st2 = await env.invoke('kt_selftest_icon', {});
      must(st2.png === null && !(st2.ico || []).length, 'files left: ' + short(st2));
      must((await kt.appIcon()) === null, 'still given back after reset');
      return 'kept in ' + st.dir + '; .ico of ' + icoN + ' sizes; window: ' + short(win) + (st.last && st.last.desktopEntry ? '; desktop entry: ' + short(st.last.desktopEntry) : '') + '; refused a non-PNG; reset';
    }, 30000);
  }
  /* stage P4 — torrent streaming and the local stream server (streamserver.rs over kt-core's streamlogic.rs): every
     check reads the server as the page's player does, with fetch. Required on every system: a stand-in engine whose
     pieces the test lets in (HEAD, ranges, a read that waits for its pieces while the start is served — a seek while
     buffering —, eight readers at once, 416, a wrong token, an unknown session, the stats, kt:streamDone ending a
     reader that waits and withdrawing the address), a file on this computer (kt:fileUrl), the audio / video addresses,
     the proxy against the test server (its headers sent, ranges passed through, every byte), and the server stopped with
     its port free and no connection left; and, wherever aria2c runs, a real swarm on loopback — a torrent made from
     made-up bytes, a second aria2c seeding it on 127.0.0.1, the app's engine fetching it and the page streaming its
     start, middle and end (and its second file) while it comes (required since CI run 43543045018 passed it on Linux,
     Windows and both macOS builds). */
  async function runP4(kt, cfg, env, check, must, waitFor, engineUp) {
    var F = env.fetch;
    if (!kt.streamUrl || !kt.fileUrl || !F) { await check('stream: server present', false, function () { throw new Error('no streamUrl / fileUrl / fetch here'); }); return; }
    function req(url, range, method) { var h = {}; if (range) h.Range = range; return F(url, { method: method || 'GET', headers: h, cache: 'no-store' }); }
    async function body(r) { return new Uint8Array(await r.arrayBuffer()); }
    function same(a, b) { if (!a || !b || a.length !== b.length) return false; for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
    function part(u8, from, to) { return u8.subarray ? u8.subarray(from, to + 1) : u8.slice(from, to + 1); }
    function u8(arr) { return new Uint8Array(arr); }
    function hd(r, k) { return r.headers.get(k); }
    var st = function (o) { return env.invoke('kt_selftest_stream', { o: o }); };
    function badToken(url) { return url.replace(/\/([0-9a-f]{32})\//, function (_m, t) { return '/' + (t.charAt(0) === '0' ? '1' : '0') + t.slice(1) + '/'; }); }

    /* the stand-in engine */
    var f = null; var data = null;
    var ok = await check('stream: torrent address, HEAD', true, async function () {
      f = await st({ op: 'fake', size: 1048576 + 4321, piece: 65536, seed: 7 }); data = u8(b64bytes(f.b64));
      must(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/t\/[0-9a-f]{20}\/stream%20test\.mp4$/.test(f.url), 'url ' + f.url);
      var r = await req(f.url, null, 'HEAD');
      must(r.status === 200, 'status ' + r.status); must(hd(r, 'content-length') === String(data.length), 'length ' + hd(r, 'content-length'));
      must(hd(r, 'accept-ranges') === 'bytes' && hd(r, 'content-type') === 'video/mp4', hd(r, 'accept-ranges') + ' ' + hd(r, 'content-type'));
      return f.url;
    });
    if (ok) {
      await check('stream: a read waits for its pieces (seek while buffering)', true, async function () {
        await st({ op: 'release', from: 0, to: 1 });
        var r = await req(f.url, 'bytes=0-65535'); must(r.status === 206, 'status ' + r.status);
        must(hd(r, 'content-range') === 'bytes 0-65535/' + data.length, 'range ' + hd(r, 'content-range'));
        must(same(await body(r), part(data, 0, 65535)), 'the start differs');
        var ended = false; var res = null;
        var mid = req(f.url, 'bytes=600000-700000').then(function (x) { res = x; return body(x); }).then(function (b) { ended = true; return b; });
        await waitFor(function () { return res; }, 10000, 'the middle\'s head');
        await env.sleep(300);
        must(!ended, 'the middle came before its pieces');
        await st({ op: 'release', from: 0, to: 99 });
        var b = await mid; must(res.status === 206 && same(b, part(data, 600000, 700000)), 'the middle differs (' + res.status + ')');
        return 'held, then sent once its pieces were in';
      }, 30000);
      await check('stream: eight readers at once', true, async function () {
        var asks = [[0, 99], [65530, 65545], [131072, 262143], [500000, 500000], [900000, data.length - 1], [-1000], [1000000], [12345, 1048575]];
        var got = await Promise.all(asks.map(function (a) {
          var range = a.length === 1 ? (a[0] < 0 ? 'bytes=' + a[0] : 'bytes=' + a[0] + '-') : 'bytes=' + a[0] + '-' + a[1];
          return req(f.url, range).then(function (r) { return body(r).then(function (b) { return { r: r, b: b, a: a }; }); });
        }));
        got.forEach(function (g) {
          var from = g.a.length === 1 ? (g.a[0] < 0 ? data.length + g.a[0] : g.a[0]) : g.a[0]; var to = g.a.length === 1 ? data.length - 1 : g.a[1];
          must(g.r.status === 206 && same(g.b, part(data, from, to)), 'range ' + g.a.join('-') + ' differs (' + g.r.status + ')');
        });
        return asks.length + ' ranges, every byte';
      }, 30000);
      await check('stream: 416, wrong token, unknown session', true, async function () {
        var r = await req(f.url, 'bytes=' + data.length + '-'); must(r.status === 416 && hd(r, 'content-range') === 'bytes */' + data.length, '416? ' + r.status + ' ' + hd(r, 'content-range'));
        r = await req(badToken(f.url)); must(r.status === 403, 'wrong token ' + r.status);
        r = await req(f.url.replace(/\/t\/[0-9a-f]{20}\//, '/t/00000000000000000000/')); must(r.status === 404, 'unknown session ' + r.status);
        r = await req(f.url, null, 'OPTIONS'); must(r.status === 204, 'OPTIONS ' + r.status);
        return '416, 403, 404, 204';
      });
      await check('streamStats', true, async function () {
        var s = await kt.streamStats({ id: f.id }); must(s && s.engine === 'selftest' && s.progress === 1 && typeof s.down === 'number' && typeof s.peers === 'number', short(s));
        must(Array.isArray(s.buffered) && s.buffered.length === 1 && s.buffered[0][1] === data.length - 1, 'buffered ' + short(s.buffered));
        var none = await kt.streamStats({ id: 'no-such-download' }); must(none === null, 'stats of nothing ' + short(none));
        return short(s);
      });
      await check('streamDone ends a waiting reader and withdraws the address', true, async function () {
        var g = await st({ op: 'fake', size: 300000, piece: 65536, seed: 8 });
        var r = await req(g.url, 'bytes=200000-'); must(r.status === 206, 'status ' + r.status);
        var outcome = body(r).then(function (b) { return 'ended with ' + b.length + ' bytes'; }, function (e) { return 'cut: ' + ((e && e.message) || e); });
        var d = await kt.streamDone({ id: g.id }); must(d && d.ok === true, short(d));
        var how = await outcome;
        var r2 = await req(g.url); must(r2.status === 404, 'after streamDone ' + r2.status);
        var live = 1;
        for (var i = 0; i < 50 && live !== 0; i++) { live = (await st({ op: 'live' })).live; if (live) await env.sleep(100); }
        must(live === 0, live + ' connections left');
        return how + '; 404 after; no connection left';
      }, 20000);
    }

    /* a file on this computer */
    var fp = null; var fdata = []; for (var k = 0, x = 12345; k < 70000; k++) { x = (x * 1103515245 + 12345) % 2147483648; fdata.push(x >> 16 & 255); }
    fdata = u8(fdata);
    await check('fileUrl: ranges, types, refusals', true, async function () {
      fp = await kt.writeTempBytes({ name: 'kt stream ✓.srt', b64: toB64(fdata), sub: 'kt-selftest-stream' });
      var u = await kt.fileUrl(fp); must(typeof u === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/f\?p=/.test(u), 'url ' + u);
      var r = await req(u); must(r.status === 200 && same(await body(r), fdata), 'whole ' + r.status);
      r = await req(u, 'bytes=100-199'); must(r.status === 206 && same(await body(r), part(fdata, 100, 199)), 'part ' + r.status);
      r = await req(u, 'bytes=-10'); must(r.status === 206 && same(await body(r), part(fdata, 69990, 69999)), 'suffix ' + r.status);
      r = await req(u, null, 'HEAD'); must(hd(r, 'content-type') === 'text/plain; charset=utf-8' && hd(r, 'content-length') === '70000', 'head ' + hd(r, 'content-type') + ' ' + hd(r, 'content-length'));
      r = await req(u, 'bytes=70000-'); must(r.status === 416, '416? ' + r.status);
      r = await req(badToken(u)); must(r.status === 403, 'wrong token ' + r.status);
      r = await req(await kt.fileUrl(fp + '.none')); must(r.status === 404, 'missing ' + r.status);
      return u.replace(/\/[0-9a-f]{32}\//, '/…/');
    });
    var au = null, vu = null;
    await check('audioUrl / videoUrl', true, async function () {
      au = (await kt.audioUrl()).url; vu = (await kt.videoUrl()).url;
      must(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/audio$/.test(au) && /\/video$/.test(vu), au + ' ' + vu);
      var r = await req(vu + '?src=x', null, 'HEAD'); must(r.status === 200 && hd(r, 'content-type') === 'video/mp4', 'video HEAD ' + r.status);
      r = await req(vu + '?src=x&c=vp9', null, 'HEAD'); must(hd(r, 'content-type') === 'video/webm', 'vp9 HEAD ' + hd(r, 'content-type'));
      r = await req(vu, null, 'HEAD'); must(r.status === 400, 'no src ' + r.status);
      r = await req(au, null, 'HEAD'); must(r.status === 200 && hd(r, 'content-type') === 'audio/aac', 'audio HEAD ' + r.status);
      return 'heads as Electron\'s';
    });
    // (The bytes of /audio and /video — ffmpeg's AAC and the transcode with its encoder fallback — are checked by
    // stage P5's «transcode stream» row (runP5) through these same routes, with the app's stand-in ffmpeg: a self-test
    // run never starts an ffmpeg of the machine's — vtffmpeg::binary(). P4's reported «AAC from ffmpeg» row, which
    // needed a real ffmpeg and found none on any runner, is gone with the merge.)
    await check('proxyUrl: the page\'s headers, ranges, every byte', true, async function () {
      must(cfg.base, 'no test server');
      var p = await kt.proxyUrl({ url: cfg.base + '/headers', headers: { 'X-KT-Proxy': 'yes', Referer: 'http://127.0.0.1/ref' } });
      must(typeof p === 'string' && /\/p\?u=/.test(p), 'url ' + short(p));
      var t = (await (await req(p)).text()).toLowerCase();
      must(t.indexOf('x-kt-proxy: yes') >= 0 && t.indexOf('referer: http://127.0.0.1/ref') >= 0 && t.indexOf('chrome/130') >= 0, 'headers sent: ' + short(t));
      var big = await kt.proxyUrl({ url: cfg.base + '/big/kt-proxy.bin', headers: {} });
      var whole = await body(await req(big)); must(whole.length === cfg.bigSize, 'size ' + whole.length);
      if (env.sha256) { var h = await env.sha256(whole); must(h === cfg.bigSha256, 'sha256 ' + h); }
      var r = await req(big, 'bytes=100-199'); must(r.status === 206 && hd(r, 'content-range') === 'bytes 100-199/' + cfg.bigSize, 'range ' + r.status + ' ' + hd(r, 'content-range'));
      must(same(await body(r), part(whole, 100, 199)), 'the range differs');
      return 'headers, 206, ' + cfg.bigSize + ' bytes';
    }, 30000);

    /* a real swarm on loopback (required where aria2c runs: passed on every system in CI run 43543045018) */
    if (engineUp && cfg.aria2Bin) {
      var sw = null; var id = null;
      var started = await check('swarm: torrent made, seeder on 127.0.0.1', true, async function () {
        sw = await st({ op: 'swarm' }); must(sw && !sw.skip, sw && sw.skip);
        var t = await kt.add({ source: { torrent: sw.torrentB64 }, dir: sw.dir }); id = t && t.id; must(id, 'not added');
        return sw.infoHash + ', seeder :' + sw.seedPort + ', tracker :' + sw.trackerPort;
      }, 40000);
      if (started) {
        var u0 = null;
        await check('swarm: start, middle and end streamed while it comes', true, async function () {
          u0 = (await kt.streamUrl({ id: id, fileIndex: 0 })).url;
          var size = sw.sizes[0]; var r = await req(u0, null, 'HEAD'); must(r.status === 200 && hd(r, 'content-length') === String(size), 'HEAD ' + r.status + ' ' + hd(r, 'content-length'));
          var mid = Math.floor(size / 2); var asks = [[0, 65535], [mid, mid + 65535], [size - 65536, size - 1]];
          var got = await Promise.all(asks.map(function (a) { return req(u0, 'bytes=' + a[0] + '-' + a[1]).then(body); }));
          for (var i = 0; i < asks.length; i++) {
            var want = u8(b64bytes((await st({ op: 'bytes', file: 0, from: asks[i][0], len: asks[i][1] - asks[i][0] + 1 })).b64));
            must(same(got[i], want), 'range ' + asks[i].join('-') + ' differs');
          }
          var s = await kt.streamStats({ id: id }); must(s && s.engine && typeof s.peers === 'number', 'stats ' + short(s));
          return '3 ranges, every byte; ' + short(s);
        }, 90000);
        await check('swarm: the second file (from inside a piece of the first)', true, async function () {
          var u1 = (await kt.streamUrl({ id: id, fileIndex: 1 })).url; var r = await req(u1);
          must(hd(r, 'content-type') === 'text/plain; charset=utf-8', 'type ' + hd(r, 'content-type'));
          var want = u8(b64bytes((await st({ op: 'bytes', file: 1, from: 0, len: sw.sizes[1] })).b64));
          must(same(await body(r), want), 'differs');
          return sw.sizes[1] + ' bytes';
        }, 60000);
        await check('swarm: streamDone withdraws the address', true, async function () {
          await kt.streamDone({ id: id }); var r = await req(u0); must(r.status === 404, 'status ' + r.status); return '404';
        });
      }
      if (id) { try { await kt.remove(id, true); } catch (e) { /* gone */ } }
      try { await st({ op: 'swarmStop' }); } catch (e) { /* gone */ }
    } else {
      await check('swarm: torrent streamed on loopback', false, async function () { throw new Error('no aria2c running here'); });
    }

    await check('stream server stopped: its port free, no connection left', true, async function () {
      var r = await st({ op: 'serverStop' }); must(r.ended && r.portFree && r.live === 0, short(r));
      var u = await kt.fileUrl(fp); var r2 = await req(u, 'bytes=0-9'); must(r2.status === 206, 'started again: ' + r2.status);
      return 'port ' + r.port + ' free; started again on demand';
    });
  }

  async function runDownload(kt, cfg, env, check, must, waitFor, required) {
    var latest = null; var pushes = 0; var id = '';
    var dir = join(cfg.temp, 'kt-selftest-dl', cfg.os);
    var name = 'kt-selftest-' + env.now() + '.bin';
    var renamed = name.replace(/\.bin$/, '-renamed.bin');
    var off = kt.onTasks(function (list) { pushes++; latest = list; });
    await check('setLimits', required, async function () { await kt.setLimits({ down: 0, up: 0 }); return 'none'; });
    var added = await check('add (HTTP, 4 connections)', required, async function () {
      var t = await kt.add({ source: { url: cfg.base + '/big/' + name }, dir: dir, name: name, connections: 4 });
      must(t && t.id && t.kind === 'http' && t.engine === 'native', short(t)); id = t.id; return t.id + ' ' + t.state;
    });
    if (!added) { off(); return; }
    var cur = function () { return find(latest, id); };
    await check('pause mid-way', required, async function () {
      var t = await waitFor(function () { var x = cur(); return x && (x.state === 'done' || (x.state === 'downloading' && x.done > 0 && x.done < x.total)) ? x : null; }, 25000, 'progress');
      must(t.state !== 'done', 'finished before it could be paused');
      await kt.pause(id);
      var p = await waitFor(function () { var x = cur(); return x && (x.state === 'paused' || x.state === 'done') ? x : null; }, 20000, 'paused');
      must(p.state === 'paused', 'state ' + p.state);
      return p.done + ' / ' + p.total + ' bytes when paused';
    }, 50000);
    await check('resume → done', required, async function () {
      var x0 = cur(); if (x0 && x0.state === 'paused') await kt.resume(id);
      var d = await waitFor(function () { var x = cur(); return x && (x.state === 'done' || x.state === 'failed') ? x : null; }, 40000, 'done');
      must(d.state === 'done', 'state ' + d.state + ' ' + (d.error || ''));
      must(d.total === cfg.bigSize && d.done === cfg.bigSize, d.done + '/' + d.total);
      must(Array.isArray(d.files) && d.files[0] && d.files[0].path === name, 'file ' + short(d.files));
      must(d.source && /\/big\//.test(d.source.url || ''), 'source ' + short(d.source));
      must(typeof d.addedAt === 'number' && typeof d.doneAt === 'number', 'times');
      return d.name + ' in ' + d.dir;
    }, 45000);
    await check('kt:tasks events', required, async function () { must(pushes >= 3, pushes + ' lists'); return pushes + ' lists (1 asked, the rest pushed)'; });
    await check('downloaded file hash', required, async function () { var h = await kt.hashFile(join(dir, name, cfg.os)); must(h.sha256 === cfg.bigSha256 && h.size === cfg.bigSize, short(h)); return 'sha256 ok, ' + h.size + ' bytes'; });
    await check('rename', required, async function () {
      var r = await kt.rename({ id: id, name: renamed }); must(r === renamed, short(r));
      var e = await kt.exists([join(dir, renamed, cfg.os), join(dir, name, cfg.os)]); must(e[0] === true && e[1] === false, short(e));
      var l = await kt.list(); var t = find(l, id); must(t && t.name === renamed && t.files[0].path === renamed, short(t));
      return renamed;
    });
    await check('remove', required, async function () {
      await kt.remove(id, true);
      var l = await kt.list(); must(!find(l, id), 'still listed');
      await kt.removeFile(join(dir, renamed, cfg.os));
      return 'removed';
    });
    off();
  }

  var lib = { ABC: ABC, verdict: verdict, sameBytes: sameBytes, join: join, find: find, b64bytes: b64bytes, run: run, runP4: runP4, runP5: runP5, runScreen: runScreen };
  try { Object.defineProperty(root, '__KT_SELFTEST_LIB__', { value: lib, configurable: true }); } catch (e) { root.__KT_SELFTEST_LIB__ = lib; }

  var cfg = root.__KT_SELFTEST__;
  if (!cfg || root.__KT_SELFTEST_STARTED__) return;
  root.__KT_SELFTEST_STARTED__ = true;
  // (The page's first-start helper — desktopStarter.ts: every add-on and the ffmpeg pack fetched from the app's real
  // release 4 s after the start — kept off: in run 43545725648 it put the release's real ffmpeg into this run's pack
  // folder before the pack's row ran, on all three systems. A self-test reaches no network; the rows install what
  // they need from the loopback server. Set before the page's scripts run: this script is in the initialization
  // script.)
  try { root.localStorage.setItem('kt.pc.starter', '1'); root.localStorage.setItem('kt.playerPacksAsked', 'ffmpeg'); } catch (e) { /* no storage */ }
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
    var env = { sleep: function (ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }, invoke: invoke, doc: root.document, now: function () { return Date.now(); } };
    // (Stage P4: the player's own fetch for the stream server, and SHA-256 for the proxy's bytes.)
    env.fetch = typeof root.fetch === 'function' ? root.fetch.bind(root) : null;
    // (Screen translator: a picture's pixels at some points — the page's canvas —, and the page's storage.)
    env.pixels = function (url, pts) {
      return new Promise(function (ok, no) {
        var img = new root.Image();
        img.onload = function () { try { var c = root.document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; var x = c.getContext('2d'); x.drawImage(img, 0, 0); ok({ w: c.width, h: c.height, px: pts.map(function (p) { var d = x.getImageData(Math.max(0, Math.min(c.width - 1, Math.round(p[0]))), Math.max(0, Math.min(c.height - 1, Math.round(p[1]))), 1, 1).data; return [d[0], d[1], d[2], d[3]]; }) }); } catch (e) { no(e); } };
        img.onerror = function () { no(new Error('the picture did not load')); };
        img.src = url;
      });
    };
    try { env.storage = root.localStorage; } catch (e) { env.storage = null; }
    env.sha256 = root.crypto && root.crypto.subtle ? function (u) { return root.crypto.subtle.digest('SHA-256', u).then(function (d) { return Array.prototype.map.call(new Uint8Array(d), function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join(''); }); } : null;
    setTimeout(function () {
      run(root.kurokawaTools, cfg, env, results).catch(function (e) {
        results.push({ name: 'self-test script', ok: false, detail: short((e && e.message) || String(e)), required: true });
        Promise.resolve(invoke('kt_selftest_done', { results: results })).catch(function () {});
      });
    }, 500);
  }
  if (root.document && root.document.readyState === 'complete') start(); else root.addEventListener('load', start);
})(window);
