// CI's proof of the hand-over (Tools' stage P9; the Reader's handovercheck.js the model): run in the Tauri build's page,
// after bridge.js and handover-bridge.js, only with KTH_SELFTEST=<file> set (src-tauri/src/handover.rs check_script).
// The workflow first made an Electron profile (tests/handover-electron.cjs: settings, lists with watch progress, a
// sign-in, add-on records and files, history, a custom icon, the screen translator's font; aria2's session with a
// download that was moving and one the person had paused, its partial file and .aria2 control file), had the Electron
// build write its hand-over, and kept that profile's snapshot in window.__KTH_CHECK__.expect. Here, in a web view whose
// profile is empty:
//   1. the engine's files came before aria2c started: the session here holds the same downloads, the moving one set
//      going, the paused one still paused (handover.rs engine_prestart);
//   2. the offer shows with what it holds and where the old data stays; «Bring it now» brings it, the sheet says done;
//   3. after «Continue» (the page reloads): every key, record and kept file the same; the custom icon on the window;
//      marked restored and not offered again; the screen translator's settings point at this build's data folder.
// The results go to kt_handover_check_done (the shared frame writes them and ends the process: 0 / 1; its watchdog 2
// after KTH_SELFTEST_TIMEOUT seconds). The phase is kept in sessionStorage across the reload.
(function () {
  'use strict';
  var cfg = window.__KTH_CHECK__;
  if (!cfg || window.__KTH_RUNNING__) return;
  window.__KTH_RUNNING__ = true;
  var PHASE = 'kth.phase', RES = 'kth.results';
  function invoke(c, a) { var t = window.__TAURI__; if (t && t.core) return t.core.invoke(c, a); var i = window.__TAURI_INTERNALS__; return i.invoke(c, a); }
  function load() { try { return JSON.parse(sessionStorage.getItem(RES) || '[]'); } catch (e) { return []; } }
  var results = load();
  function short(x) { var s = typeof x === 'string' ? x : JSON.stringify(x); return String(s === undefined ? '' : s).slice(0, 600); }
  function rec(name, ok, detail, required) {
    results.push({ name: name, ok: !!ok, detail: short(detail === undefined ? '' : detail), required: required !== false });
    try { sessionStorage.setItem(RES, JSON.stringify(results)); } catch (e) { /* kept in memory */ }
    Promise.resolve(invoke('kt_handover_check_progress', { o: results })).catch(function () {});
    return !!ok;
  }
  function done() { try { sessionStorage.removeItem(PHASE); sessionStorage.removeItem(RES); } catch (e) { /* gone with the process */ } return Promise.resolve(invoke('kt_handover_check_done', { o: results })).catch(function () {}); }
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  function until(fn, ms) {
    var end = Date.now() + ms;
    return new Promise(function (resolve) {
      (function tick() { var v; try { v = fn(); } catch (e) { v = null; } if (v) resolve(v); else if (Date.now() > end) resolve(null); else setTimeout(tick, 200); })();
    });
  }
  // (Compared by content, not by the order of an object's keys — the Reader's run 43483872854. Arrays keep their order.)
  var canon = function (x) {
    if (Array.isArray(x)) return x.map(canon);
    if (x && typeof x === 'object') { var o = {}; Object.keys(x).sort().forEach(function (k) { o[k] = canon(x[k]); }); return o; }
    return x;
  };
  var same = function (a, b) { return JSON.stringify(canon(a === undefined ? null : a)) === JSON.stringify(canon(b === undefined ? null : b)); };
  // (Keys the app rewrites at each start — its own times and marks — are only required to be there; the screen
  // translator's settings are checked apart: their font paths now name this build's data folder.)
  var OWN = /^(kt\.update\.(lastCheck|ran)|kt\.screen|kt\.firstrun\.done|kt\.deviceId|kt\.recorder|kt\.pc\.starter)$/;
  var text = function (ab) { try { return new TextDecoder().decode(ab); } catch (e) { return ''; } };
  var sep = function (p) { return p && p.indexOf('\\') >= 0 ? '\\' : '/'; };

  async function phaseOffer() {
    var exp = cfg.expect;
    if (!rec('the Electron profile\'s snapshot given (KTH_EXPECT)', exp && exp.snapshot && exp.snapshot.local && exp.engine, exp ? Object.keys(exp) : 'none')) return done();
    var view = await until(function () { return document.querySelector('.downloads-view, #app > *'); }, 60000);
    rec('the page rendered', !!view);
    var f = await window.kurokawaHandover.find().catch(function (e) { return { found: false, problems: [String(e && e.message || e)] }; });
    rec('the hand-over found', f && f.found, f && (f.found ? f.dir + ' — ' + f.marker.files.length + ' files, ' + f.marker.bytes + ' bytes' : { looked: f.looked, problems: f.problems }));
    if (!f || !f.found) return done();
    // 1. The engine's files, before aria2c started.
    rec('the downloads came before the engine started', f.engine && f.engine.state === 'carried' && f.engine.id === f.marker.id && f.engine.downloads === exp.engine.gids.length, f.engine);
    var session = cfg.dataDir && window.kurokawaTools && window.kurokawaTools.readFile ? text(await window.kurokawaTools.readFile(cfg.dataDir + sep(cfg.dataDir) + 'aria2.session').catch(function () { return new ArrayBuffer(0); })) : '';
    var entries = session.split(/\r?\n(?=\S)/).filter(function (e) { return /gid=/.test(e); });
    var paused = function (gid) { var e = entries.filter(function (x) { return x.indexOf('gid=' + gid) >= 0; })[0]; return e === undefined ? null : /\n[ \t]+pause=true/.test(e); };
    rec('aria2\'s session here holds the same downloads', exp.engine.gids.every(function (g) { return paused(g) !== null; }), { here: entries.length, expected: exp.engine.gids });
    rec('the download that was moving goes on, the one paused by the person stays paused', exp.engine.moving.every(function (g) { return paused(g) === false; }) && exp.engine.pausedByUser.every(function (g) { return paused(g) === true; }), exp.engine.gids.map(function (g) { return g + ': ' + (paused(g) ? 'paused' : 'going'); }));
    rec('the screen translator\'s font copied in', !exp.font || (f.engine && f.engine.fonts >= 1), f.engine && f.engine.fonts);
    // 2. The offer.
    var sheet = await until(function () { return document.querySelector('[data-handover="offer"]'); }, 30000);
    if (!rec('the offer shown at the start', !!sheet)) return done();
    rec('it says what it holds', !!sheet.querySelector('.handover-count'), (sheet.querySelector('.handover-count') || sheet).textContent);
    rec('it says where the old data stays', (sheet.textContent || '').indexOf(f.dir) >= 0, f.dir);
    var go = sheet.querySelector('[data-handover-go]');
    try { sessionStorage.setItem(PHASE, 'restored'); } catch (e) { /* the reload then starts again: reported */ }
    var t0 = Date.now();
    go.click();
    var end = await until(function () { var s = document.querySelector('[data-handover]'); var st = s && s.getAttribute('data-handover'); return st === 'done' || st === 'failed' ? st : null; }, 240000);
    var said = (document.querySelector('[data-handover] [role="status"]') || {}).textContent;
    if (!rec('«Bring it now» brought it', end === 'done', (end || 'no answer') + ' in ' + Math.round((Date.now() - t0) / 1000) + ' s: ' + said)) return done();
    rec('«Free the space» offered after it', !!document.querySelector('[data-handover-free]'));
    var cont = document.querySelector('[data-handover-continue]');
    await sleep(300);
    cont.click();   // (the sheet closes and the page reloads with what it brought: phase 2)
    await sleep(15000);
    rec('the page reloaded after «Continue»', false, 'still here after 15 s');
    return done();
  }

  async function phaseCheck() {
    var exp = cfg.expect.snapshot;
    var view = await until(function () { return document.querySelector('.downloads-view, #app > *'); }, 60000);
    rec('the page rendered after the reload', !!view);
    var snap = await window.__KT_HANDOVER__.snapshot();
    var missing = Object.keys(exp.local).filter(function (k) { return !(k in snap.local); });
    rec('every localStorage key there', missing.length === 0, missing.length ? missing : Object.keys(exp.local).length + ' keys');
    var diff = Object.keys(exp.local).filter(function (k) { return !OWN.test(k) && snap.local[k] !== exp.local[k]; });
    rec('settings, lists, watch progress, sign-ins the same', diff.length === 0, diff.length ? diff : 'all');
    ['meta', 'history'].forEach(function (st) {
      var ks = Object.keys(exp.idb[st] || {}); var bad = ks.filter(function (k) { return !same((snap.idb[st] || {})[k], exp.idb[st][k]); });
      rec('the database\'s ' + st + ' records the same', bad.length === 0, bad.length ? bad.map(function (k) { return k + ': ' + short((snap.idb[st] || {})[k]).slice(0, 100) + ' ≠ ' + short(exp.idb[st][k]).slice(0, 100); }) : ks.length + ' records');
    });
    var fd = Object.keys(exp.files).filter(function (k) { return snap.files[k] !== exp.files[k]; });
    rec('the kept files the same, the same sizes', fd.length === 0, fd.length ? fd.map(function (k) { return k + ': ' + snap.files[k] + ' ≠ ' + exp.files[k]; }) : Object.keys(exp.files).length + ' files');
    if (exp.local['kt.screen'] && cfg.dataDir) rec('the screen translator\'s fonts named in this build\'s data folder', (snap.local['kt.screen'] || '').indexOf(JSON.stringify(cfg.dataDir).slice(1, -1)) >= 0, snap.local['kt.screen']);
    var f = await window.kurokawaHandover.find();
    rec('marked restored (never offered at the start again)', f && f.state && f.marker && f.state.id === f.marker.id && f.state.state === 'restored', f && f.state);
    var again = await until(function () { return document.querySelector('[data-handover="offer"]'); }, 5000);
    rec('the offer not shown again', !again);
    if (exp.local['app.icon']) {
      var icon = await window.kurokawaTools.appIcon().catch(function (e) { return 'error: ' + (e && e.message); });
      rec('the custom icon the app\'s again', icon === exp.local['app.icon'], typeof icon === 'string' ? icon.length + ' characters' : icon);
    }
    rec('the hand-over folder left as it was', f && f.found, f && f.dir);
    // The engine, now up: the downloads in its list (reported: aria2c may be missing on the runner's system build).
    var tasks = await window.kurokawaTools.list().catch(function () { return []; });
    rec('the downloads in the engine\'s list', Array.isArray(tasks) && cfg.expect.engine.gids.every(function (g) { return tasks.some(function (t) { return t.id === g; }); }), (tasks || []).map(function (t) { return t.id + ' ' + t.state; }), false);
    // 4. The downloads for real (required where the Electron step had aria2c: Windows): this app owns them
    //    (downloads-owner.json, ownerlock.rs), the one that was moving goes on to its end from the same partial file —
    //    every byte the server's (its pattern's SHA-256) —, the one the person paused stays paused.
    var eng = cfg.expect.engine || {}; var req = !!eng.available && eng.gids.length > 0;
    if (eng.gids && eng.gids.length) {
      var own = await window.kurokawaHandover.owner().catch(function (e) { return 'error: ' + (e && e.message); });
      rec('the handed-over downloads\' owner is this app (downloads-owner.json)', own && own.status === 'mine' && own.held === false && own.count >= eng.gids.length, own, req);
      var end = Date.now() + 240000, last = null;
      while (Date.now() < end) {
        var ts = await window.kurokawaTools.list().catch(function () { return []; });
        last = (ts || []).filter(function (t) { return eng.gids.indexOf(t.id) >= 0; });
        var slow = last.filter(function (t) { return t.id === eng.slow; })[0];
        if (slow && (slow.state === 'done' || slow.state === 'failed')) break;
        await sleep(500);
      }
      var sl = (last || []).filter(function (t) { return t.id === eng.slow; })[0];
      var h = sl && sl.state === 'done' ? await window.kurokawaTools.hashFile(eng.slowFile).catch(function (e) { return { error: String(e && e.message || e) }; }) : null;
      rec('the download that was moving went on to its end here, every byte the same', !!h && h.sha256 === eng.server.sha256 && h.size === eng.server.size, { task: sl && { state: sl.state, done: sl.done, total: sl.total }, hash: h && (h.sha256 || h.error), size: h && h.size, want: eng.server && eng.server.size }, req);
      var pz = (last || []).filter(function (t) { return eng.pausedByUser.indexOf(t.id) >= 0; });
      rec('the download the person paused is still paused', pz.length === eng.pausedByUser.length && pz.every(function (t) { return t.state === 'paused'; }), pz.map(function (t) { return t.id + ' ' + t.state; }), req);
    }
    return done();
  }

  async function run() {
    var phase = ''; try { phase = sessionStorage.getItem(PHASE) || ''; } catch (e) { /* first */ }
    if (phase === 'restored') return phaseCheck();
    return phaseOffer();
  }
  window.addEventListener('error', function (e) { if (results.length < 60) rec('page error', false, e && e.message, false); });
  var start = function () { setTimeout(function () { run().catch(function (e) { rec('the check script', false, (e && e.stack) || String(e)); done(); }); }, 500); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
