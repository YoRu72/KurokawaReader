// CI's proof of the hand-over (stage R6a): run in the Tauri build's page, after bridge.js and handover-bridge.js, only
// with KRH_SELFTEST=<file> set (src-tauri/src/handover.rs check_script). The workflow first made an Electron profile
// (tests/handover-electron.cjs: books — EPUB, PDF, text, one only linked —, covers, places, highlights, bookmarks,
// per-book settings, a custom icon), had the Electron build write its hand-over, and kept that profile's snapshot in
// window.__KRH_CHECK__.expect. Here, in a web view whose profile is empty:
//   1. the first-run screen offers it, with the count; «Bring it now» brings it, the screen says done;
//   2. after «Continue» (the page reloads): the same books with the same ids, files of the same sizes, the same
//      places, highlights, bookmarks, covers, per-book settings; every key kept; the custom icon on the window;
//      the screen not offered again (restored, marked); the text book opened at its place.
// The results go to kr_handover_check_done (the shared frame writes them and ends the process: 0 / 1; its watchdog
// 2 after KRH_SELFTEST_TIMEOUT seconds). The phase is kept in sessionStorage across the reload.
(function () {
  'use strict';
  var cfg = window.__KRH_CHECK__;
  if (!cfg || window.__KRH_RUNNING__) return;
  window.__KRH_RUNNING__ = true;
  var PHASE = 'krh.phase', RES = 'krh.results';
  function invoke(c, a) { var t = window.__TAURI__; if (t && t.core) return t.core.invoke(c, a); var i = window.__TAURI_INTERNALS__; return i.invoke(c, a); }
  function load() { try { return JSON.parse(sessionStorage.getItem(RES) || '[]'); } catch (e) { return []; } }
  var results = load();
  function short(x) { var s = typeof x === 'string' ? x : JSON.stringify(x); return String(s === undefined ? '' : s).slice(0, 600); }
  function rec(name, ok, detail, required) {
    results.push({ name: name, ok: !!ok, detail: short(detail === undefined ? '' : detail), required: required !== false });
    try { sessionStorage.setItem(RES, JSON.stringify(results)); } catch (e) { /* kept in memory */ }
    Promise.resolve(invoke('kr_handover_check_progress', { o: results })).catch(function () {});
    return !!ok;
  }
  function done() { try { sessionStorage.removeItem(PHASE); sessionStorage.removeItem(RES); } catch (e) { /* gone with the process */ } return Promise.resolve(invoke('kr_handover_check_done', { o: results })).catch(function () {}); }
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  function until(fn, ms) {
    var end = Date.now() + ms;
    return new Promise(function (resolve) {
      (function tick() { var v; try { v = fn(); } catch (e) { v = null; } if (v) resolve(v); else if (Date.now() > end) resolve(null); else setTimeout(tick, 200); })();
    });
  }
  var same = function (a, b) { return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b); };
  var FIELDS = ['title', 'author', 'fileName', 'size', 'format', 'progress', 'progressAt', 'highlights', 'bookmarks', 'pdfHighlights', 'pins', 'ink', 'tags', 'folderId', 'source', 'remote', 'rating', 'review', 'prefs', 'coverSize', 'addedAt'];
  // (Keys the app itself rewrites at each start — times of its own checks — are only required to be there.)
  var KEYS = ['kr.visual', 'kr.bookVisual', 'kr.lang', 'app.icon', 'kr.glossary', 'kr.glossaryFolders', 'kr.vocab', 'kr.textRules', 'kr.dbx.access', 'kr.anilist.token'];

  async function phaseOffer() {
    var exp = cfg.expect;
    if (!rec('the Electron profile\'s snapshot given (KRH_EXPECT)', exp && Array.isArray(exp.books) && exp.books.length > 0, exp ? (exp.books || []).length + ' books' : 'none')) return done();
    var lib = await until(function () { return document.querySelector('.library-view'); }, 60000);
    rec('the library rendered', !!lib);
    var f = await window.kurokawaHandover.find().catch(function (e) { return { found: false, problems: [String(e && e.message || e)] }; });
    rec('the hand-over found', f && f.found, f && (f.found ? f.dir + ' — ' + f.marker.files.length + ' files, ' + f.marker.bytes + ' bytes' : { looked: f.looked, problems: f.problems }));
    if (!f || !f.found) return done();
    rec('the hand-over\'s counts are the profile\'s', f.marker.counts && f.marker.counts.books === exp.books.length, f.marker.counts);
    var sheet = await until(function () { return document.querySelector('[data-handover="offer"]'); }, 30000);
    if (!rec('the first-run screen offers it', !!sheet)) return done();
    var digits = String(exp.books.length);
    rec('it says how many books', (sheet.textContent || '').indexOf(digits) >= 0 || /[٠-٩]/.test(sheet.textContent || ''), (sheet.querySelector('.handover-count') || sheet).textContent);
    rec('it says where the old data stays', (sheet.textContent || '').indexOf(f.dir) >= 0, f.dir);
    var go = sheet.querySelector('[data-handover-go]');
    try { sessionStorage.setItem(PHASE, 'restored'); } catch (e) { /* the reload then starts again: reported */ }
    var t0 = Date.now();
    go.click();
    var end = await until(function () { var s = document.querySelector('[data-handover]'); var st = s && s.getAttribute('data-handover'); return st === 'done' || st === 'failed' ? st : null; }, 240000);
    var said = (document.querySelector('[data-handover] [role="status"]') || {}).textContent;
    if (!rec('«Bring it now» brought it', end === 'done', (end || 'no answer') + ' in ' + Math.round((Date.now() - t0) / 1000) + ' s: ' + said)) return done();
    var cont = document.querySelector('[data-handover-continue]');
    rec('«Free the space» offered after it', !!document.querySelector('[data-handover-free]'));
    await sleep(300);
    cont.click();   // (the sheet closes and the page reloads with the settings it brought: phase 2)
    await sleep(15000);
    rec('the page reloaded after «Continue»', false, 'still here after 15 s');
    return done();
  }

  async function phaseCheck() {
    var exp = cfg.expect;
    var lib = await until(function () { return document.querySelector('.library-view'); }, 60000);
    rec('the library rendered after the reload', !!lib);
    var snap = await window.__KR_HANDOVER__.snapshot();
    var byId = {}; snap.books.forEach(function (b) { byId[b.id] = b; });
    rec('the same books (ids)', same(snap.books.map(function (b) { return b.id; }), exp.books.map(function (b) { return b.id; })), { here: snap.books.length, there: exp.books.length });
    exp.books.forEach(function (eb) {
      var b = byId[eb.id];
      var diff = FIELDS.filter(function (k) { return !b || !same(b[k], eb[k]); });
      rec('book «' + eb.title + '» as it was', b && diff.length === 0, diff.length ? diff.map(function (k) { return k + ': ' + short(b && b[k]).slice(0, 120) + ' ≠ ' + short(eb[k]).slice(0, 120); }).join('; ') : (eb.source ? 'linked: ' + short(eb.source) : eb.format + ', ' + eb.size + ' bytes'));
    });
    var fileDiff = Object.keys(exp.files).filter(function (k) { return snap.files[k] !== exp.files[k]; });
    rec('the same files kept, the same sizes', fileDiff.length === 0, fileDiff.length ? fileDiff.map(function (k) { return k + ': ' + snap.files[k] + ' ≠ ' + exp.files[k]; }).join('; ') : Object.keys(exp.files).length + ' files');
    var metaMissing = exp.meta.filter(function (k) { return snap.meta.indexOf(k) < 0; });
    rec('every other record there', metaMissing.length === 0, metaMissing.length ? metaMissing : exp.meta.length + ' records');
    var localMissing = Object.keys(exp.local).filter(function (k) { return !(k in snap.local); });
    rec('every localStorage key there', localMissing.length === 0, localMissing.length ? localMissing : Object.keys(exp.local).length + ' keys');
    var localDiff = KEYS.filter(function (k) { return (k in exp.local) && snap.local[k] !== exp.local[k]; });
    rec('settings, per-book settings, glossary, sign-ins the same', localDiff.length === 0, localDiff.length ? localDiff : KEYS.filter(function (k) { return k in exp.local; }).join(', '));
    var opfsMissing = (exp.opfs || []).filter(function (k) { return (snap.opfs || []).indexOf(k) < 0; });
    rec('the local AI\'s models (private files) there', opfsMissing.length === 0, opfsMissing.length ? { missing: opfsMissing, models: snap.local['kr.localModels'] } : (exp.opfs || []).length + ' files', false);
    var f = await window.kurokawaHandover.find();
    rec('marked restored (never offered at the start again)', f && f.state && f.marker && f.state.id === f.marker.id && f.state.state === 'restored', f && f.state);
    var again = await until(function () { return document.querySelector('[data-handover="offer"]'); }, 5000);
    rec('the first-run screen not shown again', !again);
    if (exp.local['app.icon']) {
      var icon = await window.kurokawaDesktop.appIcon().catch(function (e) { return 'error: ' + (e && e.message); });
      rec('the custom icon the app\'s again', icon === exp.local['app.icon'], typeof icon === 'string' ? icon.length + ' characters' : icon);
    }
    rec('the hand-over folder left as it was', f && f.found, f && f.dir);
    // The text book opened: at the same paragraph (its saved place unchanged by opening it).
    var tb = exp.books.filter(function (b) { return b.format === 'txt' && b.progress && b.progress.block; })[0];
    if (tb) {
      location.hash = '#/read/' + tb.id;
      var content = await until(function () { return document.querySelector('.kr-content'); }, 30000);
      await sleep(4000);
      var now = (await window.__KR_HANDOVER__.snapshot()).books.filter(function (b) { return b.id === tb.id; })[0];
      rec('the text book opens at its paragraph', !!content && now && now.progress && now.progress.block === tb.progress.block, { opened: !!content, block: now && now.progress && now.progress.block, expected: tb.progress.block }, false);
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
