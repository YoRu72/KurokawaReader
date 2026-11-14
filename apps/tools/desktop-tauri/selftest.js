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

    /* stage P3: the recycle bin, free space, fonts, MEGA; the Files page's jobs */
    await runP3(kt, cfg, env, check, must, waitFor);

    /* the engine */
    var engine = !!cfg.aria2Bin;
    rec('aria2c binary', cfg.wantBundled ? !!cfg.aria2Bundled : true, (cfg.aria2Bin || 'none found') + (cfg.aria2Bundled ? ' (bundled)' : ''), !!cfg.wantBundled);
    var up = await check('engine available', engine, async function () {
      if (!kt.available) await kt.retryEngine();
      await waitFor(function () { return kt.available; }, 30000, 'engine');
      return 'available';
    }, 45000);
    if (up) await runDownload(kt, cfg, env, check, must, waitFor, engine);
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
    await check('files: delete a folder and all in it', true, async function () {
      var r = await fileJob(kt, { id: id(), op: 'delete', paths: [base] });
      must(r.end.status === 'done' && r.end.failed.length === 0, short(r.end)); must((await has([base]))[0] === false, 'still there');
      return r.end.files + ' items';
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

  var lib = { ABC: ABC, verdict: verdict, sameBytes: sameBytes, join: join, find: find, b64bytes: b64bytes, run: run };
  try { Object.defineProperty(root, '__KT_SELFTEST_LIB__', { value: lib, configurable: true }); } catch (e) { root.__KT_SELFTEST_LIB__ = lib; }

  var cfg = root.__KT_SELFTEST__;
  if (!cfg || root.__KT_SELFTEST_STARTED__) return;
  root.__KT_SELFTEST_STARTED__ = true;
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
    setTimeout(function () {
      run(root.kurokawaTools, cfg, env, results).catch(function (e) {
        results.push({ name: 'self-test script', ok: false, detail: short((e && e.message) || String(e)), required: true });
        Promise.resolve(invoke('kt_selftest_done', { results: results })).catch(function () {});
      });
    }, 500);
  }
  if (root.document && root.document.readyState === 'complete') start(); else root.addEventListener('load', start);
})(window);
