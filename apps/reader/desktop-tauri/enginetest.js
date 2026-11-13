// The Reader's Tauri shell, its engine test (stage R1, CI only): the web app's key cases run inside the built app, in
// the system's own web view (WebView2, WKWebView, WebKitGTK), to learn what works there. Added after bridge.js to the
// window's initialization script by src-tauri/src/enginetest.rs only when KR_ENGINETEST is set, after a line that sets
// window.__KR_ENGINETEST__ = { runId, os, version, budgetMs }. Without that object it does nothing.
//
// It drives the real page as a person would (a small driver: wait for a selector or a condition, click, type, read
// texts and boxes), and makes every book it needs here, in code: EPUBs (a zip writer below), PDFs (a PDF writer below,
// text in Helvetica; Arabic as letters mapped by a ToUnicode table), plain text. The page is reloaded twice — to see
// the library kept, and to see the interface in Arabic —, so where it stands is kept in localStorage under
// kr.enginetest.<runId> and it goes on after each load. Each check is { name, ok, detail, required, ms, case }; the
// list goes to kr_selftest_progress after each and to kr_selftest_done at the end (the shared self-test frame writes
// it and ends the process: 0 when every required check passed). The frame's watchdog ends a run that stalls; each
// case has its own time limit too, and the whole run a budget (budgetMs), after which the remaining cases are written
// as skipped. Screenshots for a person to compare are asked of the shell (kr_engine_shot). The pure parts are on
// window.__KR_ENGINETEST_LIB__ for tests/tauriengine.cjs, which runs the whole test in Chromium.
(function (root) {
  'use strict';

  /* ---------------- pure helpers: bytes, zip, inflate, PDF, EPUB ---------------- */

  function utf8(s) { return new TextEncoder().encode(String(s)); }
  function latin1(s) { var u = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; }
  function concat(parts) { var n = 0, i; for (i = 0; i < parts.length; i++) n += parts[i].length; var out = new Uint8Array(n), o = 0; for (i = 0; i < parts.length; i++) { out.set(parts[i], o); o += parts[i].length; } return out; }
  var CRC = (function () { var t = new Uint32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u) { var c = 0xffffffff; for (var i = 0; i < u.length; i++) c = CRC[(c ^ u[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  function le(n, bytes) { var u = new Uint8Array(bytes); for (var i = 0; i < bytes; i++) u[i] = (n >>> (8 * i)) & 255; return u; }

  /** A zip of [name, bytes|string] entries, stored (no compression) — what an EPUB needs. */
  function zipStore(entries) {
    var parts = [], central = [], off = 0;
    entries.forEach(function (e) {
      var name = utf8(e[0]), data = typeof e[1] === 'string' ? utf8(e[1]) : e[1], crc = crc32(data);
      var local = concat([le(0x04034b50, 4), le(20, 2), le(0x0800, 2), le(0, 2), le(0, 2), le(0x21, 2), le(crc, 4), le(data.length, 4), le(data.length, 4), le(name.length, 2), le(0, 2), name]);
      central.push(concat([le(0x02014b50, 4), le(20, 2), le(20, 2), le(0x0800, 2), le(0, 2), le(0, 2), le(0x21, 2), le(crc, 4), le(data.length, 4), le(data.length, 4), le(name.length, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 4), le(off, 4), name]));
      parts.push(local, data); off += local.length + data.length;
    });
    var cd = concat(central);
    return concat(parts.concat([cd, concat([le(0x06054b50, 4), le(0, 2), le(0, 2), le(entries.length, 2), le(entries.length, 2), le(cd.length, 4), le(off, 4), le(0, 2)])]));
  }

  /** Raw DEFLATE (RFC 1951) undone — to read the converter's .docx without counting on the engine's own. */
  var LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  var LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  var DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  var DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  var CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  function inflateRaw(data) {
    var pos = 0, bitbuf = 0, bitcnt = 0, out = new Uint8Array(Math.max(1024, data.length * 4)), n = 0;
    function bits(k) { while (bitcnt < k) { if (pos >= data.length) throw new Error('inflate: out of data'); bitbuf |= data[pos++] << bitcnt; bitcnt += 8; } var v = bitbuf & ((1 << k) - 1); bitbuf >>>= k; bitcnt -= k; return v; }
    function put(b) { if (n === out.length) { var o = new Uint8Array(out.length * 2); o.set(out); out = o; } out[n++] = b; }
    function table(lengths, count) {
      var cnt = new Uint16Array(16), offs = new Uint16Array(16), sym = new Uint16Array(count), i;
      for (i = 0; i < count; i++) cnt[lengths[i]]++;
      cnt[0] = 0; for (i = 1; i < 15; i++) offs[i + 1] = offs[i] + cnt[i];
      for (i = 0; i < count; i++) if (lengths[i]) sym[offs[lengths[i]]++] = i;
      return { cnt: cnt, sym: sym };
    }
    function decode(h) { var code = 0, first = 0, index = 0; for (var len = 1; len < 16; len++) { code |= bits(1); var c = h.cnt[len]; if (code - c < first) return h.sym[index + (code - first)]; index += c; first += c; first <<= 1; code <<= 1; } throw new Error('inflate: bad code'); }
    var fixed = null;
    for (;;) {
      var last = bits(1), type = bits(2), lit, dist, i;
      if (type === 0) {
        bitbuf = 0; bitcnt = 0;
        var len = data[pos] | (data[pos + 1] << 8); pos += 4;
        for (i = 0; i < len; i++) put(data[pos++]);
      } else {
        if (type === 1) {
          if (!fixed) { var l = new Uint8Array(288); for (i = 0; i < 288; i++) l[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8; var d = new Uint8Array(30); for (i = 0; i < 30; i++) d[i] = 5; fixed = [table(l, 288), table(d, 30)]; }
          lit = fixed[0]; dist = fixed[1];
        } else if (type === 2) {
          var hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4, cl = new Uint8Array(19);
          for (i = 0; i < hclen; i++) cl[CLORDER[i]] = bits(3);
          var clt = table(cl, 19), lens = new Uint8Array(hlit + hdist);
          for (i = 0; i < hlit + hdist;) {
            var s = decode(clt);
            if (s < 16) lens[i++] = s;
            else { var rep = 0, val = 0; if (s === 16) { if (!i) throw new Error('inflate: repeat with nothing'); val = lens[i - 1]; rep = 3 + bits(2); } else if (s === 17) rep = 3 + bits(3); else rep = 11 + bits(7); while (rep--) lens[i++] = val; }
          }
          lit = table(lens.subarray(0, hlit), hlit); dist = table(lens.subarray(hlit), hdist);
        } else throw new Error('inflate: bad block type');
        for (;;) {
          var sym = decode(lit);
          if (sym < 256) put(sym);
          else if (sym === 256) break;
          else {
            sym -= 257; var ln = LBASE[sym] + bits(LEXT[sym]); var ds = decode(dist); var back = DBASE[ds] + bits(DEXT[ds]);
            if (back > n) throw new Error('inflate: distance too far');
            for (i = 0; i < ln; i++) put(out[n - back]);
          }
        }
      }
      if (last) break;
    }
    return out.subarray(0, n);
  }

  /** A zip's entries: { name: bytes } (stored or deflated). Throws when it is no zip. */
  function unzip(u) {
    var eocd = -1;
    for (var i = u.length - 22; i >= Math.max(0, u.length - 65557); i--) if (u[i] === 0x50 && u[i + 1] === 0x4b && u[i + 2] === 5 && u[i + 3] === 6) { eocd = i; break; }
    if (eocd < 0) throw new Error('no end of central directory');
    var r16 = function (o) { return u[o] | (u[o + 1] << 8); }, r32 = function (o) { return (u[o] | (u[o + 1] << 8) | (u[o + 2] << 16) | (u[o + 3] << 24)) >>> 0; };
    var count = r16(eocd + 10), p = r32(eocd + 16), out = {};
    for (var k = 0; k < count; k++) {
      if (r32(p) !== 0x02014b50) throw new Error('bad central directory');
      var method = r16(p + 10), csize = r32(p + 20), nlen = r16(p + 28), xlen = r16(p + 30), clen = r16(p + 32), loc = r32(p + 42);
      var name = new TextDecoder().decode(u.subarray(p + 46, p + 46 + nlen));
      var start = loc + 30 + r16(loc + 26) + r16(loc + 28), raw = u.subarray(start, start + csize);
      out[name] = method === 0 ? raw : method === 8 ? inflateRaw(raw) : null;
      p += 46 + nlen + xlen + clen;
    }
    return out;
  }

  function pdfEsc(s) { return String(s).replace(/[\\()]/g, function (c) { return '\\' + c; }); }
  /** A PDF of pages [{ w, h, lines: [{ x, y, size, text } | { x, y, size, ar: 'نص' }] }], meta { title }. Latin text in
   *  Helvetica; Arabic (`ar`) as one byte per letter in a font whose ToUnicode table maps each byte to its letter,
   *  written in visual order (as PDF producers write it), so a reader's text — pdf.js's — comes out as Arabic. */
  function makePdf(pages, meta) {
    var arChars = [], code = {};
    pages.forEach(function (pg) { pg.lines.forEach(function (l) { if (l.ar) Array.from(l.ar).forEach(function (c) { if (c !== ' ' && !(c in code)) { code[c] = 0x41 + arChars.length; arChars.push(c); } }); }); });
    var objs = [];
    var add = function (body) { objs.push(body); return objs.length; };
    var catalog = add(null), pagesId = add(null), f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    var f2 = 0;
    if (arChars.length) {
      var hex2 = function (n) { return ('0' + n.toString(16).toUpperCase()).slice(-2); }, hex4 = function (n) { return ('000' + n.toString(16).toUpperCase()).slice(-4); };
      var map = ['<20> <0020>'].concat(arChars.map(function (c) { return '<' + hex2(code[c]) + '> <' + hex4(c.charCodeAt(0)) + '>'; }));
      var cmap = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n' + map.length + ' beginbfchar\n' + map.join('\n') + '\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n';
      var tu = add('<< /Length ' + cmap.length + ' >>\nstream\n' + cmap + 'endstream');
      f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode ' + tu + ' 0 R >>');
    }
    var kids = [];
    pages.forEach(function (pg) {
      var ops = pg.lines.map(function (l) {
        if (l.ar) { var hex = Array.from(l.ar).reverse().map(function (c) { return c === ' ' ? '20' : ('0' + code[c].toString(16)).slice(-2); }).join(''); return 'BT /F2 ' + l.size + ' Tf ' + l.x + ' ' + l.y + ' Td <' + hex + '> Tj ET'; }
        return 'BT /F1 ' + l.size + ' Tf ' + l.x + ' ' + l.y + ' Td (' + pdfEsc(l.text) + ') Tj ET';
      }).join('\n');
      var content = add('<< /Length ' + ops.length + ' >>\nstream\n' + ops + '\nendstream');
      kids.push(add('<< /Type /Page /Parent ' + pagesId + ' 0 R /MediaBox [0 0 ' + pg.w + ' ' + pg.h + '] /Resources << /Font << /F1 ' + f1 + ' 0 R' + (f2 ? ' /F2 ' + f2 + ' 0 R' : '') + ' >> >> /Contents ' + content + ' 0 R >>'));
    });
    objs[catalog - 1] = '<< /Type /Catalog /Pages ' + pagesId + ' 0 R >>';
    objs[pagesId - 1] = '<< /Type /Pages /Count ' + kids.length + ' /Kids [' + kids.map(function (k) { return k + ' 0 R'; }).join(' ') + '] >>';
    var info = add('<< /Title (' + pdfEsc((meta && meta.title) || 'Untitled') + ') /Producer (KurokawaReader engine test) >>');
    var s = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', offs = [];
    objs.forEach(function (body, i) { offs.push(s.length); s += (i + 1) + ' 0 obj\n' + body + '\nendobj\n'; });
    var x = s.length;
    s += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + offs.map(function (o) { return ('000000000' + o).slice(-10) + ' 00000 n \n'; }).join('');
    s += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root ' + catalog + ' 0 R /Info ' + info + ' 0 R >>\nstartxref\n' + x + '\n%%EOF\n';
    return latin1(s);
  }

  function xmlEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  /** An EPUB 3: { id, title, lang, chapters: [[title, bodyHtml]] }. */
  function makeEpub(o) {
    var rtl = o.lang === 'ar';
    var files = [['mimetype', 'application/epub+zip'], ['META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>']];
    o.chapters.forEach(function (c, i) { files.push(['OEBPS/c' + (i + 1) + '.xhtml', '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="' + o.lang + '"' + (rtl ? ' dir="rtl"' : '') + '><head><title>' + xmlEsc(c[0]) + '</title></head><body><h1>' + xmlEsc(c[0]) + '</h1>' + c[1] + '</body></html>']); });
    files.push(['OEBPS/nav.xhtml', '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Nav</title></head><body><nav epub:type="toc"><ol>' + o.chapters.map(function (c, i) { return '<li><a href="c' + (i + 1) + '.xhtml">' + xmlEsc(c[0]) + '</a></li>'; }).join('') + '</ol></nav></body></html>']);
    files.push(['OEBPS/content.opf', '<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">' + xmlEsc(o.id) + '</dc:identifier><dc:title>' + xmlEsc(o.title) + '</dc:title><dc:language>' + o.lang + '</dc:language><meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' + o.chapters.map(function (c, i) { return '<item id="c' + (i + 1) + '" href="c' + (i + 1) + '.xhtml" media-type="application/xhtml+xml"/>'; }).join('') + '</manifest><spine' + (rtl ? ' page-progression-direction="rtl"' : '') + '>' + o.chapters.map(function (c, i) { return '<itemref idref="c' + (i + 1) + '"/>'; }).join('') + '</spine></package>']);
    return zipStore(files);
  }

  /** 0 when there are results and every required one passed, 1 otherwise (what the shared selftest.rs decides). */
  function verdict(results) {
    if (!Array.isArray(results) || !results.length) return 1;
    for (var i = 0; i < results.length; i++) { var r = results[i]; if (r.required !== false && r.ok !== true) return 1; }
    return 0;
  }
  function short(x) { var s; try { s = typeof x === 'string' ? x : JSON.stringify(x); } catch (e) { s = String(x); } return s && s.length > 400 ? s.slice(0, 400) + '…' : String(s); }

  /** What the user agent says of the engine. */
  function engineOf(ua) {
    var m;
    if ((m = /Edg\/([\d.]+)/.exec(ua))) return 'WebView2 / Edge ' + m[1];
    if ((m = /Chrome\/([\d.]+)/.exec(ua))) return 'Chromium ' + m[1];
    if ((m = /AppleWebKit\/([\d.]+)/.exec(ua))) { var v = /Version\/([\d.]+)/.exec(ua); return 'WebKit ' + m[1] + (v ? ' (Version ' + v[1] + ')' : '') + (/Linux/.test(ua) ? ' — WebKitGTK' : /Mac OS X/.test(ua) ? ' — WKWebView' : ''); }
    if ((m = /Firefox\/([\d.]+)/.exec(ua))) return 'Gecko ' + m[1];
    return 'unknown';
  }

  var lib = { utf8: utf8, crc32: crc32, zipStore: zipStore, inflateRaw: inflateRaw, unzip: unzip, makePdf: makePdf, makeEpub: makeEpub, verdict: verdict, engineOf: engineOf };
  try { Object.defineProperty(root, '__KR_ENGINETEST_LIB__', { value: lib, configurable: true }); } catch (e) { root.__KR_ENGINETEST_LIB__ = lib; }

  /* ---------------- the run ---------------- */

  var cfg = root.__KR_ENGINETEST__;
  if (!cfg || root.__KR_ENGINETEST_STARTED__) return;
  root.__KR_ENGINETEST_STARTED__ = true;
  var KEY = 'kr.enginetest.' + cfg.runId;
  var BUDGET = cfg.budgetMs || 360000;
  var ls = (function () { try { return root.localStorage; } catch (e) { return null; } })();
  function load() { try { var v = ls && ls.getItem(KEY); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function save() { try { if (ls) ls.setItem(KEY, JSON.stringify(st)); } catch (e) { /* full: the shell has the progress */ } }
  var now = function () { return Date.now(); };

  // (First load of this run: the interface in English — the checks find controls by their English names —, no update
  // check, books scrolled as one flow. Before the page's own scripts read them.)
  var st = load();
  if (!st) {
    st = { phase: 'start', results: [], data: {}, done: {}, t0: now(), loads: 0, errors: 0 };
    try {
      ls.setItem('kr.lang', 'en'); ls.setItem('kr.update.lastCheck', String(now()));
      var vis = {}; try { vis = JSON.parse(ls.getItem('kr.visual') || '{}') || {}; } catch (e) { vis = {}; }
      vis.readingMode = 'continuous'; ls.setItem('kr.visual', JSON.stringify(vis));
    } catch (e) { /* no storage: the case that needs it says so */ }
  }
  st.loads++; save();

  function invoke(cmd, args) {
    var t = root.__TAURI__;
    if (t && t.core && typeof t.core.invoke === 'function') return t.core.invoke(cmd, args);
    var i = root.__TAURI_INTERNALS__;
    if (i && typeof i.invoke === 'function') return i.invoke(cmd, args);
    return Promise.reject(new Error('no IPC'));
  }
  function progress() { try { Promise.resolve(invoke('kr_selftest_progress', { results: st.results })).catch(function () {}); } catch (e) { /* none */ } }
  function rec(cs, name, ok, detail, required, ms) { st.results.push({ case: cs, name: name, ok: !!ok, detail: short(detail === undefined ? '' : detail), required: required !== false, ms: ms === undefined ? null : Math.round(ms) }); save(); progress(); return !!ok; }
  function pageError(what) { if (++st.errors > 15) return; rec('page', 'page error', false, what, false); }
  root.addEventListener('error', function (e) { pageError((e && (e.message || (e.error && e.error.message))) || 'error'); });
  root.addEventListener('unhandledrejection', function (e) { var r = e && e.reason; pageError('unhandled rejection: ' + ((r && r.message) || String(r))); });

  /* ---- the driver ---- */
  var sleep = function (ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); };
  var doc = root.document;
  function $(sel, from) { return (from || doc).querySelector(sel); }
  function $$(sel, from) { return Array.prototype.slice.call((from || doc).querySelectorAll(sel)); }
  function visible(el) { if (!el || !el.getClientRects().length) return false; var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
  async function waitFor(fn, ms, what) {
    var until = now() + ms;
    for (;;) { var v; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (now() > until) throw new Error('timeout (' + Math.round(ms / 1000) + ' s): ' + what); await sleep(120); }
  }
  function within(p, ms, what) {
    var t = null;
    var limit = new Promise(function (_ok, no) { t = setTimeout(function () { no(new Error('timeout (' + Math.round(ms / 1000) + ' s): ' + what)); }, ms); });
    return Promise.race([p, limit]).then(function (v) { clearTimeout(t); return v; }, function (e) { clearTimeout(t); throw e; });
  }
  function must(c, what) { if (!c) throw new Error(what); return c; }
  function click(el) { must(el, 'nothing to click'); el.click(); }
  function type(input, text) { input.focus(); input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }
  function key(k, target) { (target || doc.body).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); }
  function command(c) { doc.dispatchEvent(new CustomEvent('kr:command', { detail: c })); }
  function byText(sel, re, from) { return $$(sel, from).filter(function (e) { return re.test(e.textContent || ''); })[0] || null; }

  /* ---- the app's library (IndexedDB) ---- */
  function allBooks() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open('kurokawa-reader');
      r.onerror = function () { rej(r.error); };
      r.onsuccess = function () { try { var d = r.result; var q = d.transaction('books').objectStore('books').getAll(); q.onsuccess = function () { d.close(); res(q.result || []); }; q.onerror = function () { d.close(); rej(q.error); }; } catch (e) { rej(e); } };
    });
  }
  async function bookById(id) { return (await allBooks()).filter(function (b) { return b.id === id; })[0] || null; }
  function closeSheets() { for (var i = 0; i < 3; i++) key('Escape'); }
  async function toLibrary() {
    if (!/^#\/?$/.test(root.location.hash)) root.location.hash = '#/';
    await waitFor(function () { return visible($('.library-view')); }, 20000, 'the library view');
    await sleep(400);
  }
  /** Hands `files` to an <input type=file> as a person picking them would (DataTransfer; else the property set). */
  function setFiles(input, files) {
    try { var dt = new DataTransfer(); files.forEach(function (f) { dt.items.add(f); }); input.files = dt.files; if (input.files && input.files.length === files.length) return 'DataTransfer'; } catch (e) { /* below */ }
    Object.defineProperty(input, 'files', { configurable: true, get: function () { return files; } });
    return 'files property';
  }
  async function importFile(file, match) {
    await toLibrary();
    var input = must($('.library-view input[type=file]'), 'no file input in the library');
    var how = setFiles(input, [file]);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    var b = await waitFor(async function () {
      var hit = (await allBooks()).filter(match)[0];
      // (A library with books asks where the new ones go: the library.)
      if (!hit) { var sh = $$('.sheet').pop(); var btn = sh && $('.sheet-actions button, button.btn', sh); if (btn) btn.click(); }
      return hit;
    }, 90000, 'the book in the library: ' + file.name);
    b.__how = how;
    return b;
  }
  async function openReader(id, sel) {
    await toLibrary();
    root.location.hash = '#/read/' + id;
    return waitFor(function () { return $$(sel).filter(visible)[0]; }, 45000, 'the book open (' + sel + ')');
  }
  function scroller() { return $('.reader-scroll'); }
  function topPara() {
    var sc = scroller(); if (!sc) return null;
    var top = sc.getBoundingClientRect().top + 10;
    var hit = $$('.reader-flow p').filter(function (x) { return x.offsetParent; }).filter(function (x) { return x.getBoundingClientRect().bottom > top; })[0];
    var m = /\[P(\d+)\]/.exec((hit && hit.textContent) || ''); return m ? Number(m[1]) : null;
  }
  /** How much of a canvas is drawn (dark pixels, out of 128×128), read through a copy. */
  function ink(canvas) {
    var c = doc.createElement('canvas'); c.width = 128; c.height = 128; var g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, 128, 128); g.drawImage(canvas, 0, 0, 128, 128);
    var d = g.getImageData(0, 0, 128, 128).data, dark = 0;
    for (var i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 600) dark++;
    return dark;
  }
  function pageInk(page) { return $$('canvas', page).reduce(function (n, c) { try { return n + (c.width && c.height ? ink(c) : 0); } catch (e) { return n; } }, 0); }
  async function shot(cs, name) {
    var t0 = now();
    await sleep(900);
    try { var r = await within(Promise.resolve(invoke('kr_engine_shot', { name: name })), 40000, 'screenshot'); rec(cs, 'screenshot: ' + name, true, r, false, now() - t0); }
    catch (e) { rec(cs, 'screenshot: ' + name, false, (e && e.message) || String(e), false, now() - t0); }
  }

  /* ---- cases ---- */
  function Stop(msg) { this.message = msg; }
  async function runCase(id, title, ms, body) {
    if (st.done[id]) return;
    st.results = st.results.filter(function (r) { return r.case !== id; }); save();
    if (now() - st.t0 > BUDGET) { rec(id, title + ': skipped', false, 'out of time (the run\'s budget of ' + Math.round(BUDGET / 1000) + ' s is spent)', true); st.done[id] = true; save(); return; }
    var stepper = async function (name, required, fn, stepMs) {
      var t0 = now();
      try { var d = await within(Promise.resolve().then(fn), stepMs || 30000, name); rec(id, name, true, d, required, now() - t0); return d; }
      catch (e) { rec(id, name, false, (e && e.message) || String(e), required, now() - t0); if (required) throw new Stop(name); return undefined; }
    };
    try { await within(body(stepper), ms, title); }
    catch (e) { if (!(e instanceof Stop)) rec(id, title + ': stopped', false, (e && e.message) || String(e), true); }
    try { closeSheets(); if (doc.fullscreenElement) await doc.exitFullscreen(); } catch (e) { /* none */ }
    st.done[id] = true; save();
  }

  var TAG = String(cfg.runId).slice(-6);

  async function caseEnvironment() {
    await runCase('env', '1 environment', 60000, async function (step) {
      await step('engine', false, function () {
        var nav = root.navigator;
        return { engine: engineOf(nav.userAgent), ua: nav.userAgent, os: cfg.os, dpr: root.devicePixelRatio, deviceMemory: nav.deviceMemory === undefined ? 'n/a' : nav.deviceMemory, cores: nav.hardwareConcurrency, screen: root.screen.width + '×' + root.screen.height + ' (avail ' + root.screen.availWidth + '×' + root.screen.availHeight + ')', window: root.innerWidth + '×' + root.innerHeight, lang: nav.language, origin: root.location.origin };
      });
      var feats = {};
      var has = function (k, v) { feats[k] = !!v; };
      has('IndexedDB', root.indexedDB);
      has('Worker', root.Worker);
      has('OffscreenCanvas', root.OffscreenCanvas);
      try { has('OffscreenCanvas 2d', root.OffscreenCanvas && new OffscreenCanvas(1, 1).getContext('2d')); } catch (e) { has('OffscreenCanvas 2d', false); }
      has('createImageBitmap', root.createImageBitmap);
      has('content-visibility', root.CSS && CSS.supports && CSS.supports('content-visibility', 'auto'));
      has('Intl.Segmenter', root.Intl && Intl.Segmenter);
      has('structuredClone', root.structuredClone);
      has('CompressionStream', root.CompressionStream);
      has('DecompressionStream', root.DecompressionStream);
      try { has('DecompressionStream deflate-raw', root.DecompressionStream && new DecompressionStream('deflate-raw')); } catch (e) { has('DecompressionStream deflate-raw', false); }
      has('showDirectoryPicker (absent is fine: the scan uses the shell)', root.showDirectoryPicker);
      has('Clipboard API', root.navigator.clipboard);
      has('ClipboardItem', root.ClipboardItem);
      has('speechSynthesis', root.speechSynthesis);
      has('ResizeObserver', root.ResizeObserver);
      has('IntersectionObserver', root.IntersectionObserver);
      has('requestIdleCallback', root.requestIdleCallback);
      has('performance.memory', root.performance && root.performance.memory);
      has(':has()', root.CSS && CSS.supports && CSS.supports('selector(:has(a))'));
      has('container queries', root.CSS && CSS.supports && CSS.supports('container-type', 'inline-size'));
      has('text-wrap', root.CSS && CSS.supports && (CSS.supports('text-wrap', 'balance') || CSS.supports('text-wrap-style', 'balance')));
      has('CSS.highlights (search marks)', root.CSS && CSS.highlights);
      has('popover', root.HTMLElement && 'popover' in HTMLElement.prototype);
      has('<dialog>', root.HTMLDialogElement);
      has('WebAssembly', root.WebAssembly);
      has('crypto.subtle', root.crypto && root.crypto.subtle);
      has('FontFace', root.FontFace);
      has('BroadcastChannel', root.BroadcastChannel);
      has('Notification', root.Notification);
      has('navigator.storage', root.navigator.storage);
      has('navigator.share', root.navigator.share);
      has('mediaSession', root.navigator.mediaSession);
      has('Fullscreen API', doc.documentElement.requestFullscreen);
      has('serviceWorker', root.navigator.serviceWorker);
      has('scheduler', root.scheduler);
      // A module worker (pdf.js's and the converter's are).
      feats['module Worker'] = await new Promise(function (res) {
        try {
          var u = URL.createObjectURL(new Blob(['import.meta; postMessage(42);'], { type: 'text/javascript' }));
          var w = new Worker(u, { type: 'module' }); var t = setTimeout(function () { res(false); w.terminate(); }, 4000);
          w.onmessage = function (e) { clearTimeout(t); res(e.data === 42); w.terminate(); }; w.onerror = function () { clearTimeout(t); res(false); };
        } catch (e) { res(false); }
      });
      var core = ['IndexedDB', 'Worker', 'module Worker', 'WebAssembly', 'ResizeObserver', 'IntersectionObserver', 'createImageBitmap', 'FontFace'];
      var missing = Object.keys(feats).filter(function (k) { return !feats[k]; });
      await step('features the app relies on', true, function () {
        var lack = core.filter(function (k) { return !feats[k]; });
        must(!lack.length, 'missing core: ' + lack.join(', ') + ' (absent: ' + missing.join(', ') + ')');
        return missing.length ? 'absent: ' + missing.join(', ') : 'all ' + Object.keys(feats).length + ' present';
      });
      // What the shell serves each of the app's files as (a module refused for its type breaks part of the app).
      await step('the app\'s files served with their types', true, async function () {
        var sw = await (await fetch('sw.js')).text();
        var m = /const ASSETS = new Set\((\[[\s\S]*?\])\.map/.exec(sw); must(m, 'no asset list in sw.js');
        var list = JSON.parse(m[1]).filter(function (p) { return /\.(m?js|css|wasm|woff2|json)$/.test(p) && p !== '/sw.js'; });
        var want = { js: /javascript|ecmascript/, mjs: /javascript|ecmascript/, css: /^text\/css/, wasm: /^application\/wasm/, woff2: /font|woff2|octet-stream/, json: /json/ };
        var bad = [], pdfLike = [];
        for (var i = 0; i < list.length; i++) {
          var p = list[i].replace(/^\//, ''); var r = await fetch(p); var ct = r.headers.get('content-type') || '';
          var ext = /\.(\w+)$/.exec(p)[1]; var head = ext === 'js' || ext === 'mjs' ? new Uint8Array(await r.arrayBuffer()).subarray(0, 1024) : null;
          if (head) { var t = ''; for (var j = 0; j < head.length; j++) t += String.fromCharCode(head[j]); if (t.indexOf('%PDF') >= 0) pdfLike.push(p); }
          if (!want[ext].test(ct) && (ext === 'js' || ext === 'mjs')) bad.push(p + ' → ' + (ct || '(none)'));
          else if (!want[ext].test(ct)) feats['type of ' + p] = ct;
        }
        must(!bad.length, 'scripts with another type: ' + bad.slice(0, 6).join('; ') + (pdfLike.length ? ' — «%PDF» in the first KB of: ' + pdfLike.join(', ') : ''));
        must(!pdfLike.length, '«%PDF» in the first KB of ' + pdfLike.join(', ') + ' (a web view that sniffs would take it for a PDF)');
        return list.length + ' files fetched; scripts all JavaScript';
      }, 60000);
      // Whether the web view itself guesses a script's type from its first bytes (macOS R0: a chunk was refused as
      // 'application/pdf'): a module with «%PDF» in its first line, served by blob: with an explicit type.
      await step('a module with «%PDF» near its start (sniffing check)', false, async function () {
        var u = URL.createObjectURL(new Blob(['/* %PDF-1.4 */ export default 7;'], { type: 'text/javascript' }));
        var mod = await import(u);
        must(mod && mod.default === 7, 'not run');
        return 'runs (the engine does not sniff a declared type)';
      }, 10000);
    });
  }

  async function caseFonts() {
    await runCase('fonts', '9 fonts', 60000, async function (step) {
      await step('bundled reading fonts load', false, async function () {
        var fams = {}; doc.fonts.forEach(function (f) { fams[String(f.family).replace(/["']/g, '')] = true; });
        var names = Object.keys(fams); must(names.length, 'no @font-face');
        var ok = [], bad = [];
        for (var i = 0; i < names.length; i++) {
          var ar = /Arabic|Uthman|Sultan|Mohanad/i.test(names[i]); var spec = '16px "' + names[i] + '"';
          try { await within(doc.fonts.load(spec, ar ? 'بسم' : 'Abc'), 8000, names[i]); } catch (e) { /* checked below */ }
          (doc.fonts.check(spec, ar ? 'بسم' : 'Abc') ? ok : bad).push(names[i]);
        }
        must(!bad.length, 'not loaded: ' + bad.join(', ') + ' (loaded ' + ok.length + ')');
        return ok.length + ' families: ' + ok.join(', ');
      }, 50000);
      await step('an Arabic font renders (not a fallback)', true, async function () {
        await doc.fonts.load('24px "Noto Naskh Arabic"', 'بسم الله');
        var span = function (fam) { var s = doc.createElement('span'); s.textContent = 'بسم الله الرحمن الرحيم'; s.style.cssText = 'position:fixed;left:-9999px;top:0;font-size:24px;white-space:pre;font-family:' + fam; doc.body.appendChild(s); var w = s.getBoundingClientRect().width; s.remove(); return w; };
        var naskh = span('"Noto Naskh Arabic"'), fb = span('"KrNoSuchFont", monospace');
        must(doc.fonts.check('24px "Noto Naskh Arabic"', 'بسم'), 'Noto Naskh Arabic not loaded');
        must(Math.abs(naskh - fb) > 2, 'same width as the fallback (' + naskh.toFixed(1) + ' px)');
        return 'Noto Naskh Arabic ' + naskh.toFixed(1) + ' px, fallback ' + fb.toFixed(1) + ' px';
      });
    });
  }

  function millEpub() {
    var filler = function (n, w) { var s = ''; for (var i = 1; i <= n; i++) s += '<p>Filler paragraph ' + i + ' of ' + w + ', words and nothing more to find in it.</p>'; return s; };
    return new File([makeEpub({ id: 'kr-engine-mill-' + cfg.runId, title: 'Engine Mill ' + TAG, lang: 'en', chapters: [
      ['Chapter One', '<p>The first chapter opens here with plain words.</p>' + filler(40, 'one') + '<p>The <b>quick</b> brown <i>fox</i> jumps over the lazy dog today.</p>' + filler(10, 'one')],
      ['Chapter Two', '<p>Morning came to the valley and the miller woke.</p><p>At noon the old bell rang over the square. Nobody came.</p>' + filler(30, 'two')],
    ] })], 'engine-mill.epub', { type: 'application/epub+zip' });
  }
  var AR_WORD = 'العربية';
  function arabicEpub() {
    var paras = ''; for (var i = 1; i <= 25; i++) paras += '<p>هذه الفقرة رقم ' + i + ' من الكتاب، وفيها كلام عربي موصول الحروف ليُرى كيف تُرسم اللغة ' + AR_WORD + ' في هذا العارض.</p>';
    return new File([makeEpub({ id: 'kr-engine-ar-' + cfg.runId, title: 'كتاب التجربة ' + TAG, lang: 'ar', chapters: [['الباب الأول', '<p>بسم الله الرحمن الرحيم. هذا كتاب صغير يُصنع في أثناء التجربة.</p>' + paras], ['الباب الثاني', paras]] })], 'engine-arabic.epub', { type: 'application/epub+zip' });
  }

  async function caseStorageImport() {
    await runCase('storage', '2 storage (import)', 120000, async function (step) {
      await toLibrary();
      var b = await step('import an EPUB → in IndexedDB', true, async function () {
        var bk = await importFile(millEpub(), function (x) { return /Engine Mill/.test(x.title || ''); });
        st.data.mill = bk.id; save();
        return bk.title + ' (' + bk.id + ', via ' + bk.__how + ')';
      }, 100000);
      return b;
    });
  }
  async function caseStorageReload() {
    await runCase('storage2', '2 storage (after a reload)', 60000, async function (step) {
      await step('the book is still there after the web view reloaded', true, async function () {
        must(st.data.mill, 'no book was imported before the reload');
        var b = await bookById(st.data.mill); must(b, 'not in IndexedDB after the reload');
        await toLibrary();
        await waitFor(function () { return byText('.book-card', /Engine Mill/); }, 15000, 'its card in the library');
        return b.title + ' (load ' + st.loads + ')';
      });
      await step('where the profile lives', false, async function () {
        var p = await within(Promise.resolve(invoke('kr_engine_profile', {})), 20000, 'kr_engine_profile');
        var est = null; try { est = root.navigator.storage && (await root.navigator.storage.estimate()); } catch (e) { est = null; }
        var persisted = null; try { persisted = root.navigator.storage && root.navigator.storage.persisted ? await root.navigator.storage.persisted() : null; } catch (e) { persisted = null; }
        return { dirs: p, estimate: est && { usage: est.usage, quota: est.quota }, persisted: persisted };
      });
    });
  }

  async function caseEpub() {
    await runCase('epub', '3 EPUB', 180000, async function (step) {
      must(st.data.mill, 'the EPUB was not imported (case 2)');
      await step('open: first text shown', true, async function () {
        await openReader(st.data.mill, '.reader-flow p');
        var p = await waitFor(function () { return $$('.reader-flow p').filter(function (x) { return visible(x) && /first chapter opens here/.test(x.textContent); })[0]; }, 20000, 'the first paragraph');
        return 'shown: «' + p.textContent.slice(0, 40) + '…»';
      }, 60000);
      await step('chapter change (contents → Chapter Two)', true, async function () {
        command('toc');
        var btn = await waitFor(function () { return byText('.panel.open .toc-list button', /Chapter Two/); }, 10000, 'Chapter Two in the contents');
        click(btn);
        var sc = scroller();
        var h = await waitFor(function () { var x = byText('.reader-flow h1', /Chapter Two/); if (!x) return null; var r = x.getBoundingClientRect(), s = sc.getBoundingClientRect(); return r.top >= s.top - 40 && r.top < s.top + s.height / 2 ? x : null; }, 10000, 'Chapter Two at the top');
        var close = $('.panel.open .panel-head button'); if (close) click(close);
        return 'Chapter Two heading at ' + Math.round(h.getBoundingClientRect().top - sc.getBoundingClientRect().top) + ' px';
      });
      await step('search finds a phrase across bold text', true, async function () {
        command('search');
        var input = await waitFor(function () { return $('.panel.open input[type=search]'); }, 10000, 'the search field');
        type(input, 'quick brown');
        var hits = await waitFor(function () { var h = $$('.panel.open .hit'); return h.length ? h : null; }, 15000, 'a hit');
        var line = hits[0].textContent.replace(/\s+/g, ' ').trim();
        must(/quick brown/i.test(line), 'hit «' + line + '»');
        click($('button', hits[0]) || hits[0]); await sleep(700);
        var marked = root.CSS && CSS.highlights && CSS.highlights.get('kr-search-current');
        var close = $('.panel.open .panel-head button'); if (close) click(close);
        return hits.length + ' hit(s): «' + line.slice(0, 60) + '»; marked ' + (marked ? 'with CSS.highlights' : '(no CSS.highlights)');
      });
      var para = 'At noon the old bell rang over the square';
      await step('a highlight added', true, async function () {
        var blk = must($$('.reader-flow p').filter(function (x) { return x.textContent.indexOf(para) >= 0; })[0], 'no paragraph to select in');
        var w = doc.createTreeWalker(blk, NodeFilter.SHOW_TEXT), n, i = -1; while ((n = w.nextNode())) { i = n.data.indexOf('old bell rang'); if (i >= 0) break; }
        must(n, 'the words are not in one text node');
        var r = doc.createRange(); r.setStart(n, i); r.setEnd(n, i + 'old bell rang'.length);
        // (In view, and staying there: the search's own scroll to its hit may still be under way.)
        await waitFor(async function () { blk.scrollIntoView({ block: 'center' }); await sleep(500); var rr = r.getBoundingClientRect(); return rr.top > 60 && rr.bottom < root.innerHeight - 60; }, 8000, 'the words in view');
        if (doc.activeElement && doc.activeElement !== doc.body && doc.activeElement.blur) doc.activeElement.blur();
        var sel = root.getSelection(); sel.removeAllRanges(); sel.addRange(r);
        var dot = await waitFor(function () { return $('.sel-toolbar .sel-colors .dot'); }, 6000, 'the selection toolbar').catch(function (e) {
          var g = root.getSelection(); var rr = r.getBoundingClientRect(); var scs = $$('.reader-scroll');
          throw new Error(e.message + ' (range ' + Math.round(rr.top) + '..' + Math.round(rr.bottom) + ' of ' + root.innerHeight + ', scrollers ' + scs.length + ' holding it ' + scs.filter(function (x) { return x.contains(r.commonAncestorContainer); }).length + ', selected «' + (g ? g.toString() : '') + '», toolbar ' + ($('.sel-toolbar') ? 'there: ' + $('.sel-toolbar').outerHTML.slice(0, 120) : 'none') + ', focus ' + (doc.activeElement && doc.activeElement.tagName) + ', panel ' + ($('.panel.open') ? 'open' : 'closed') + ')');
        });
        click(dot);
        var m = await waitFor(function () { return $('.reader-flow mark.kr-hl'); }, 6000, 'the mark');
        return 'marked «' + m.textContent + '»';
      });
      await step('the highlight comes back at the same place when reopened', true, async function () {
        await openReader(st.data.mill, '.reader-flow p');
        var ms = await waitFor(function () { var x = $$('.reader-flow mark.kr-hl'); return x.length ? x : null; }, 15000, 'the mark after reopening');
        var paras = ms.map(function (m) { var p = m.closest('p'); return p ? p.textContent : ''; });
        must(paras.every(function (t) { return t.indexOf(para) >= 0; }), 'in another paragraph: ' + short(paras));
        var b = await bookById(st.data.mill);
        return ms.map(function (m) { return m.textContent; }).join('|') + ' — ' + ((b && b.highlights && b.highlights.length) || 0) + ' kept in IndexedDB';
      }, 60000);
      // An Arabic book: direction, shaping, digits.
      await step('Arabic book: import and open', true, async function () {
        var bk = await importFile(arabicEpub(), function (x) { return /كتاب التجربة/.test(x.title || ''); });
        st.data.ar = bk.id; save();
        await openReader(bk.id, '.reader-flow p');
        await waitFor(function () { return $$('.reader-flow p').filter(function (x) { return visible(x) && /بسم الله/.test(x.textContent); })[0]; }, 20000, 'the first Arabic paragraph');
        return bk.title;
      }, 120000);
      await step('Arabic: right to left', true, function () {
        var p = $$('.reader-flow p').filter(visible)[0];
        var d = root.getComputedStyle(p).direction; must(d === 'rtl', 'direction ' + d);
        return 'direction rtl; text-align ' + root.getComputedStyle(p).textAlign;
      });
      await step('Arabic: letters joined (shaping)', true, async function () {
        var p = $$('.reader-flow p').filter(visible)[0]; var cs = root.getComputedStyle(p);
        var mk = function (txt) { var s = doc.createElement('span'); s.textContent = txt; s.style.cssText = 'display:inline-block;white-space:pre;font-size:' + cs.fontSize + ';font-family:' + cs.fontFamily; return s; };
        var box = doc.createElement('div'); box.dir = 'rtl'; box.style.cssText = 'position:fixed;top:0;left:-5000px;';
        var whole = mk(AR_WORD); box.appendChild(whole);
        var letters = Array.from(AR_WORD).map(function (c) { var s = mk(c); box.appendChild(s); return s; });
        doc.body.appendChild(box);
        var w = whole.getBoundingClientRect().width, sum = letters.reduce(function (n, s) { return n + s.getBoundingClientRect().width; }, 0);
        box.remove();
        must(Math.abs(w - sum) > Math.max(1.5, w * 0.03), 'the word is as wide as its letters apart: ' + w.toFixed(1) + ' vs ' + sum.toFixed(1) + ' px — not joined?');
        return '«' + AR_WORD + '» ' + w.toFixed(1) + ' px joined, ' + sum.toFixed(1) + ' px as separate letters (font ' + cs.fontFamily.split(',')[0] + ')';
      });
      await step('Arabic: digits as the app writes them (Intl)', true, function () {
        var arab = new Intl.NumberFormat('ar-SA-u-ca-gregory-nu-arab').format(123);
        var latn = new Intl.NumberFormat('ar-SA-u-ca-gregory-nu-latn').format(123);
        must(arab === '١٢٣', 'nu-arab gives ' + arab); must(latn === '123', 'nu-latn gives ' + latn);
        var pct = new Intl.NumberFormat('ar-SA-u-ca-gregory-nu-arab', { style: 'percent', maximumFractionDigits: 0 }).format(0.15);
        var hijri = ''; try { var f = new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura-nu-arab', { dateStyle: 'medium' }); hijri = f.format(new Date(2026, 0, 15)) + ' [' + f.resolvedOptions().calendar + ']'; } catch (e) { hijri = 'error ' + e.message; }
        return 'nu-arab ' + arab + ', nu-latn ' + latn + ', percent ' + pct + ', Hijri ' + hijri;
      });
      await shot('epub', '01-arabic-book');
    });
  }

  async function caseText() {
    await runCase('text', '4 text book', 150000, async function (step) {
      var id = await step('import and open a long text book', true, async function () {
        var lines = ['Engine Text ' + TAG]; for (var i = 1; i <= 700; i++) lines.push('[P' + i + '] Paragraph ' + i + ' of the long text book, words to read on and on, so that the book runs long enough. ' + (i % 3 ? '' : 'Another sentence here.'));
        var bk = await importFile(new File([lines.join('\n\n') + '\n'], 'engine-text-' + TAG + '.txt', { type: 'text/plain' }), function (x) { return /Engine Text/.test(x.title || '') || /engine-text/.test(x.fileName || ''); });
        st.data.text = bk.id; save();
        await openReader(bk.id, '.reader-flow p');
        await sleep(1200);
        return bk.id;
      }, 120000);
      await step('content-visibility in use', false, function () {
        var n = $$('.reader-flow *').filter(function (e) { var cv = root.getComputedStyle(e).contentVisibility; return cv === 'auto'; }).length;
        must(n, 'no element with content-visibility: auto (' + (root.CSS && CSS.supports('content-visibility', 'auto') ? 'supported' : 'unsupported by this engine') + ')');
        return n + ' elements';
      });
      var at = await step('scroll to the middle', true, async function () {
        var sc = must(scroller(), 'no .reader-scroll');
        sc.scrollTop = (sc.scrollHeight - sc.clientHeight) / 2; await sleep(800);
        sc.scrollTop = (sc.scrollHeight - sc.clientHeight) / 2; await sleep(1500);
        var p = must(topPara(), 'no paragraph at the top'); st.data.textAt = p; save();
        return 'paragraph ' + p + ' at the top (scrollTop ' + Math.round(sc.scrollTop) + ' of ' + sc.scrollHeight + ')';
      });
      await step('the place saved and restored', true, async function () {
        await toLibrary(); await sleep(600);
        var b = await bookById(st.data.text);
        await openReader(st.data.text, '.reader-flow p');
        var back = await waitFor(async function () { await sleep(400); var p = topPara(); return p && Math.abs(p - st.data.textAt) <= 2 ? p : null; }, 12000, 'back at paragraph ' + st.data.textAt + ' (now ' + topPara() + ', saved ' + short(b && b.progress) + ')');
        return 'paragraph ' + back + ' (left at ' + st.data.textAt + '; saved ' + short(b && b.progress) + ')';
      }, 60000);
      return at;
    });
  }

  function pdfFile(name, title, pages, w, h, lines) {
    var list = []; for (var p = 1; p <= pages; p++) list.push({ w: w, h: h, lines: lines(p) });
    return new File([makePdf(list, { title: title })], name, { type: 'application/pdf' });
  }

  async function casePdf() {
    await runCase('pdf', '5 PDF', 240000, async function (step) {
      var pages = null;
      await step('open a PDF: first page drawn', true, async function () {
        var f = pdfFile('engine-small-' + TAG + '.pdf', 'Engine Paper ' + TAG, 3, 400, 560, function (p) { var l = []; for (var i = 1; i <= 12; i++) l.push({ x: 40, y: 520 - i * 36, size: 14, text: 'line ' + i + ' of page ' + p + (p === 2 && i === 4 ? ' needle here' : '') }); return l; });
        var bk = await importFile(f, function (x) { return /Engine Paper/.test(x.title || '') || /engine-small/.test(x.fileName || ''); });
        st.data.pdf = bk.id; save();
        await openReader(bk.id, '.pdf-page');
        pages = $$('.pdf-page');
        var n = await waitFor(function () { var k = pageInk(pages[0]); return k > 20 ? k : null; }, 20000, 'ink on page 1');
        return pages.length + ' pages; page 1: ' + n + ' dark samples';
      }, 90000);
      await step('text layer', true, async function () {
        var t = await waitFor(function () { var x = $('.textLayer', pages[0]); return x && /line 1 of page 1/.test(x.textContent) ? x.textContent : null; }, 15000, 'the text layer of page 1');
        return $$('span', $('.textLayer', pages[0])).length + ' spans';
      });
      await step('page 2 drawn after a scroll', true, async function () {
        var sc = must($('.pdf-scroll'), 'no .pdf-scroll');
        sc.scrollTop = pages[1].offsetTop; await sleep(300);
        var n = await waitFor(function () { var k = pageInk($$('.pdf-page')[1]); return k > 20 ? k : null; }, 20000, 'ink on page 2');
        return n + ' dark samples; ' + ((($('.pcount') || {}).textContent) || '');
      });
      await step('search finds a word', true, async function () {
        command('search');
        var input = await waitFor(function () { return $('.panel.open input[type=search]'); }, 3000, 'the search field').catch(function () { key('/'); return waitFor(function () { return $('.panel.open input[type=search]'); }, 8000, 'the search field'); });
        type(input, 'needle');
        var hits = await waitFor(function () { var h = $$('.panel.open .hit'); return h.length ? h : null; }, 20000, 'a hit');
        var close = $('.panel.open .panel-head button'); if (close) click(close);
        return hits.length + ' hit(s): «' + hits[0].textContent.replace(/\s+/g, ' ').trim().slice(0, 60) + '»';
      });
      await step('zoom in', true, async function () {
        var w0 = $$('.pdf-page')[1].getBoundingClientRect().width;
        key('+'); await sleep(1000);
        var w1 = $$('.pdf-page')[1].getBoundingClientRect().width;
        must(w1 > w0 * 1.05, 'width ' + w0.toFixed(0) + ' → ' + w1.toFixed(0));
        key('-'); await sleep(600);
        return 'page width ' + w0.toFixed(0) + ' → ' + w1.toFixed(0) + ' px';
      });
      var sc0 = $('.pdf-scroll'); if (sc0) { sc0.scrollTop = 0; await sleep(1200); }
      await shot('pdf', '02-pdf-page');
      // A long one: 300 pages, scrolled to page 250 (times reported; it fails only if it never gets there).
      var big = null, t0 = now();
      await step('300 pages: made and imported', true, async function () {
        var f = pdfFile('engine-long-' + TAG + '.pdf', 'Engine Long ' + TAG, 300, 400, 560, function (p) { return [{ x: 40, y: 500, size: 20, text: 'Page ' + p + ' of the long paper.' }, { x: 40, y: 460, size: 12, text: 'Some words on page ' + p + ' to draw.' }]; });
        var made = now() - t0;
        big = await importFile(f, function (x) { return /Engine Long/.test(x.title || '') || /engine-long/.test(x.fileName || ''); });
        return Math.round(f.size / 1024) + ' KB made in ' + made + ' ms, imported in ' + (now() - t0 - made) + ' ms';
      }, 120000);
      var tOpen = now();
      await step('300 pages: opened (first page drawn)', true, async function () {
        await openReader(big.id, '.pdf-page');
        await waitFor(function () { var p = $$('.pdf-page')[0]; return p && pageInk(p) > 10; }, 30000, 'ink on page 1');
        return $$('.pdf-page').length + ' pages in ' + (now() - tOpen) + ' ms';
      }, 60000);
      var tGo = now();
      await step('300 pages: page 250 reached and drawn', true, async function () {
        var sc = must($('.pdf-scroll'), 'no .pdf-scroll');
        var target = function () { return $$('.pdf-page')[249]; };
        await waitFor(function () { return target(); }, 10000, 'page 250 in the list');
        sc.scrollTop = target().offsetTop; await sleep(400); sc.scrollTop = target().offsetTop;
        await waitFor(function () { var p = target(); if (Math.abs(sc.scrollTop - p.offsetTop) > p.offsetHeight) sc.scrollTop = p.offsetTop; return pageInk(p) > 10; }, 60000, 'ink on page 250');
        return 'in ' + (now() - tGo) + ' ms; ' + ((($('.pcount') || {}).textContent) || '');
      }, 80000);
    });
  }

  async function caseConvert() {
    await runCase('convert', '6 converter', 240000, async function (step) {
      var bk = null;
      await step('a PDF with Arabic and English text imported', true, async function () {
        var f = pdfFile('engine-convert-' + TAG + '.pdf', 'Engine Convert ' + TAG, 2, 595, 842, function (p) { return [
          { x: 60, y: 760, size: 18, text: 'English words for the converter, page ' + p + '.' },
          { x: 60, y: 720, size: 18, ar: 'مرحبا بالعالم من صفحة' },
          { x: 60, y: 680, size: 12, text: 'A second English line with more words in it to lay out.' },
        ]; });
        bk = await importFile(f, function (x) { return /Engine Convert/.test(x.title || '') || /engine-convert/.test(x.fileName || ''); });
        return bk.title;
      }, 90000);
      var got = null, t0 = 0;
      await step('PDF → Word finishes', true, async function () {
        await toLibrary();
        var card = await waitFor(function () { return byText('.book-card', /Engine Convert/); }, 15000, 'the book\'s card');
        // (Right-click: on a computer the book's menu; on a touch screen the selection bar, Convert in it or in More.)
        card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
        var conv = await waitFor(function () { return byText('.sheet .dest-row', /Convert/) || byText('.sel-actions button', /Convert/) || (byText('.sel-actions button', /More/) && 'more'); }, 8000, 'the book\'s menu');
        if (conv === 'more') { click(byText('.sel-actions button', /More/)); conv = await waitFor(function () { return byText('.sheet button', /Convert/); }, 8000, 'Convert in More'); }
        click(conv);
        var word = await waitFor(function () { return $$('.convert-target').filter(function (b) { return /Word/.test(($('b', b) || b).textContent); })[0]; }, 10000, 'the Word target');
        t0 = now(); click(word);
        await waitFor(function () { var r = $('.convert-result:not([hidden]) button'); var s = $$('.sheet .src').filter(function (x) { return /failed|unsupported|memory/i.test(x.textContent); })[0]; if (s) throw new Error(s.textContent); return r; }, 180000, 'the result');
        return 'in ' + (now() - t0) + ' ms';
      }, 200000);
      await step('the .docx holds the text (word/document.xml)', true, async function () {
        var saveBtn = must(byText('.convert-result button', /Save/), 'no Save button');
        var cap = new Promise(function (res) { root.__krEngineCapture = res; });
        click(saveBtn);
        got = await within(cap, 10000, 'the saved file');
        root.__krEngineCapture = null;
        var u = new Uint8Array(await got.blob.arrayBuffer());
        must(u[0] === 0x50 && u[1] === 0x4b, 'not a zip');
        var z = unzip(u); var xml = z['word/document.xml']; must(xml, 'no word/document.xml in ' + Object.keys(z).join(', '));
        var text = new TextDecoder().decode(xml).replace(/<[^>]+>/g, '');
        must(/English words for the converter/.test(text), 'English text missing: ' + text.slice(0, 200));
        var logical = text.indexOf('مرحبا') >= 0, reversed = text.indexOf('ابحرم') >= 0;
        must(logical || reversed, 'Arabic text missing: ' + text.slice(0, 200));
        return got.name + ', ' + Math.round(got.blob.size / 1024) + ' KB; Arabic ' + (logical ? 'in reading order' : 'REVERSED');
      }, 30000);
      closeSheets();
    });
  }

  // (The converter's «Save» is a download link: caught here while the case waits for it, left alone otherwise.)
  try {
    var anchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      var cap = root.__krEngineCapture;
      if (cap && this.download && /^blob:/.test(this.href)) { var name = this.download; fetch(this.href).then(function (r) { return r.blob(); }).then(function (b) { cap({ name: name, blob: b }); }); return undefined; }
      return anchorClick.apply(this, arguments);
    };
  } catch (e) { /* the converter case says so */ }

  async function caseSpeech() {
    await runCase('speech', '7 read-aloud', 60000, async function (step) {
      var ss = root.speechSynthesis;
      await step('speechSynthesis and its voices', false, async function () {
        must(ss, 'no speechSynthesis');
        var v = ss.getVoices();
        if (!v.length) { await new Promise(function (res) { var t = setTimeout(res, 4000); ss.addEventListener && ss.addEventListener('voiceschanged', function () { clearTimeout(t); res(); }); }); v = ss.getVoices(); }
        var ar = v.filter(function (x) { return /^ar/i.test(x.lang); }).length;
        must(v.length, 'no voices');
        return v.length + ' voices (' + ar + ' Arabic): ' + v.slice(0, 4).map(function (x) { return x.name + ' ' + x.lang; }).join('; ');
      }, 10000);
      await step('speak / cancel does not throw', false, async function () {
        must(ss, 'no speechSynthesis');
        var u = new SpeechSynthesisUtterance('test'); u.volume = 0; ss.speak(u); await sleep(400); ss.cancel();
        return 'ok';
      });
      await step('the reader\'s read-aloud starts and stops', false, async function () {
        must(st.data.mill, 'no book');
        await openReader(st.data.mill, '.reader-flow p');
        var e0 = st.errors; command('speak'); await sleep(1500); command('speak'); await sleep(500);
        if (ss) ss.cancel();
        must(st.errors === e0, 'page errors meanwhile');
        return 'no errors';
      }, 45000);
    });
  }

  async function caseWindow() {
    await runCase('window', '8 full screen, printing, drag and drop', 60000, async function (step) {
      await step('full screen from the reader (F11, the page\'s own way)', false, async function () {
        must(st.data.mill, 'no book');
        await openReader(st.data.mill, '.reader-flow p');
        var view = $('.reader-view') || doc.body;
        key('F11'); await sleep(1200);
        var how = doc.fullscreenElement ? 'HTML full screen' : $('.immersive') ? 'immersive mode (no Fullscreen API)' : '';
        if (!how) { command('fullscreen'); await sleep(1200); how = doc.fullscreenElement ? 'HTML full screen (command)' : $('.immersive') ? 'immersive mode (command)' : ''; }
        must(how, 'nothing happened' + (doc.documentElement.requestFullscreen ? '' : ' (no Fullscreen API)'));
        if (doc.fullscreenElement) { try { await doc.exitFullscreen(); } catch (e) { /* none */ } } else key('Escape');
        await sleep(400);
        return how + (view ? '' : '');
      });
      await step('printing API', false, function () {
        must(typeof root.print === 'function', 'no window.print');
        return 'window.print present (not called: it would open the system dialog)';
      });
      await step('drag and drop a file onto the library (simulated)', false, async function () {
        await toLibrary();
        var f = new File(['Engine Dropped ' + TAG + '\n\nA dropped text book.\n'], 'engine-dropped-' + TAG + '.txt', { type: 'text/plain' });
        var view = must($('.library-view'), 'no library view');
        var ev;
        try { var dt = new DataTransfer(); dt.items.add(f); ev = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }); if (!ev.dataTransfer || !ev.dataTransfer.files.length) throw new Error('no files'); }
        catch (e) { ev = new Event('drop', { bubbles: true, cancelable: true }); Object.defineProperty(ev, 'dataTransfer', { value: { files: [f], types: ['Files'], getData: function () { return ''; } } }); }
        view.dispatchEvent(ev);
        await waitFor(async function () { var hit = (await allBooks()).filter(function (x) { return /engine-dropped/.test(x.fileName || '') || /Engine Dropped/.test(x.title || ''); })[0]; if (!hit) { var sh = $$('.sheet').pop(); var b = sh && $('.sheet-actions button, button.btn', sh); if (b) b.click(); } return hit; }, 20000, 'the dropped book');
        return 'imported (a DOM drop event; a real drag from the system is not tested)';
      }, 30000);
    });
  }

  async function caseArabicUi() {
    await runCase('arui', '3 Arabic interface', 60000, async function (step) {
      await step('the interface in Arabic, right to left', false, async function () {
        await toLibrary();
        var dir = doc.documentElement.dir || root.getComputedStyle(doc.body).direction;
        must(dir === 'rtl', 'dir ' + dir);
        return 'dir rtl, lang ' + doc.documentElement.lang;
      });
      if (st.data.ar) {
        await step('the Arabic book open in the Arabic interface', false, async function () {
          await openReader(st.data.ar, '.reader-flow p'); await sleep(800);
          return (($('.pcount, .reader-status, .status-line') || {}).textContent || '').slice(0, 60) || 'open';
        }, 40000);
        await shot('arui', '03-arabic-interface');
      }
    });
  }

  async function finish() {
    st.phase = 'done'; save();
    try { await within(Promise.resolve(invoke('kr_selftest_done', { results: st.results })), 10000, 'kr_selftest_done'); } catch (e) { /* the watchdog writes what there is */ }
    if (root.__KR_ENGINETEST_DONE__) root.__KR_ENGINETEST_DONE__(st.results);
  }
  function reload(phase) { st.phase = phase; save(); progress(); setTimeout(function () { root.location.reload(); }, 300); }

  async function main() {
    if (st.loads > 8) { rec('run', 'the run', false, 'reloaded too often (' + st.loads + ' loads)', true); return finish(); }
    if (st.phase === 'done') return finish();
    try { await waitFor(function () { return visible($('.library-view')) || visible($('.reader-flow')) || visible($('.pdf-page')); }, 40000, 'the app\'s first view'); }
    catch (e) { rec('run', 'the app starts', false, e.message, true); return finish(); }
    if (st.phase === 'start') {
      rec('run', 'the app starts', true, 'load ' + st.loads + ', ' + (now() - st.t0) + ' ms after the test began', true, now() - st.t0);
      await caseEnvironment();
      await caseFonts();
      await caseStorageImport();
      return reload('reloaded');
    }
    if (st.phase === 'reloaded') {
      await caseStorageReload();
      await caseEpub();
      await caseText();
      await casePdf();
      await caseConvert();
      await caseSpeech();
      await caseWindow();
      try { ls.setItem('kr.lang', 'ar'); } catch (e) { /* stays English */ }
      return reload('arabic-ui');
    }
    if (st.phase === 'arabic-ui') {
      await caseArabicUi();
      try { ls.setItem('kr.lang', 'en'); } catch (e) { /* none */ }
      return finish();
    }
    return finish();
  }

  var started = false;
  function start() {
    if (started) return; started = true;
    setTimeout(function () { main().catch(function (e) { rec('run', 'engine test script', false, (e && e.message) || String(e), true); finish(); }); }, 600);
  }
  if (doc.readyState === 'complete') start(); else root.addEventListener('load', start);
})(window);
