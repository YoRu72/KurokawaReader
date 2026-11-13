// The Reader's Tauri shell, its engine test (desktop-tauri/enginetest.js, stage R1) run in Chromium, so that what fails
// in CI's web views is a difference of engine, not a fault of the test:
//  1. in plain node: the test's own zip writer, inflater, unzipper, PDF and EPUB writers against zlib, JSZip and
//     pdf-lib; the script is inert without its settings; every command it calls is registered in main.rs with the
//     argument names it sends;
//  2. in Chromium (Playwright): the built app (dist/) with the bridge, a fake Tauri IPC and the engine test, which
//     reloads the page twice and reports through kr_selftest_progress / kr_selftest_done as it does in the app; every
//     required check must pass here. Screenshots (kr_engine_shot) are taken by Playwright into --shots <dir>.
// Run after `node scripts/build.mjs`: node tests/tauriengine.cjs [--node-only] [--shots <dir>]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const TAURI = path.join(ROOT, 'desktop-tauri');
const BRIDGE = fs.readFileSync(path.join(TAURI, 'bridge.js'), 'utf8');
const ENGINE = fs.readFileSync(path.join(TAURI, 'enginetest.js'), 'utf8');
const DIST = path.join(ROOT, 'dist');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };

async function nodePart() {
  // Inert without its settings; its lib exposed.
  const win = { addEventListener() { throw new Error('should be inert'); } };
  vm.runInContext(ENGINE, vm.createContext({ window: win, TextEncoder, TextDecoder, Uint8Array, Uint16Array, Uint32Array, Array, Object, String, JSON, Math, Error }));
  const lib = win.__KR_ENGINETEST_LIB__;
  assert.ok(lib && typeof lib.unzip === 'function', 'enginetest.js exposes its lib');
  assert.equal(win.__KR_ENGINETEST_STARTED__, undefined);

  // crc32 and inflate against zlib; the stored zip read by JSZip and by its own unzip.
  const bytes = (n, seed) => { const u = new Uint8Array(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; u[i] = (x >>> 16) % (i % 7 === 0 ? 256 : 16) + (i % 5 === 0 ? 65 : 0); } return u; };
  assert.equal(lib.crc32(Buffer.from('123456789')), 0xcbf43926);
  for (const [n, level] of [[0, 6], [1, 6], [1000, 0], [5000, 1], [70000, 6], [200000, 9]]) {
    const src = Buffer.concat([Buffer.from(bytes(n, n + 1)), Buffer.from('repeat repeat repeat '.repeat(n % 300))]);
    const out = lib.inflateRaw(zlib.deflateRawSync(src, { level }));
    assert.ok(Buffer.from(out).equals(src), `inflate ${n} bytes at level ${level}`);
  }
  // (Fixed Huffman codes: zlib uses them for short input.)
  assert.equal(Buffer.from(lib.inflateRaw(zlib.deflateRawSync(Buffer.from('abcabcabc'), { strategy: zlib.constants.Z_FIXED }))).toString(), 'abcabcabc');
  const JSZip = require('jszip');
  const stored = lib.zipStore([['mimetype', 'application/epub+zip'], ['a/b.txt', 'نص ✓'], ['bin', new Uint8Array([0, 1, 2, 255])]]);
  const jz = await JSZip.loadAsync(Buffer.from(stored));
  assert.equal(await jz.file('a/b.txt').async('string'), 'نص ✓');
  assert.deepEqual([...(await jz.file('bin').async('uint8array'))], [0, 1, 2, 255]);
  const z2 = new JSZip(); z2.file('word/document.xml', '<w:t>English words مرحبا</w:t>'.repeat(50)); z2.file('x.bin', Buffer.from(bytes(30000, 7)));
  const deflated = await z2.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  const un = lib.unzip(deflated);
  assert.equal(new TextDecoder().decode(un['word/document.xml']), '<w:t>English words مرحبا</w:t>'.repeat(50));
  assert.ok(Buffer.from(un['x.bin']).equals(Buffer.from(bytes(30000, 7))));
  assert.equal(new TextDecoder().decode(lib.unzip(stored)['a/b.txt']), 'نص ✓');
  assert.throws(() => lib.unzip(new Uint8Array(100)), /end of central directory/);

  // The PDF writer: pdf-lib reads it (pages, sizes, title); the EPUB: JSZip reads it, mimetype first and stored.
  const { PDFDocument } = require('pdf-lib');
  const pdf = lib.makePdf([{ w: 400, h: 560, lines: [{ x: 40, y: 500, size: 14, text: 'line (1) \\ of page 1' }, { x: 40, y: 460, size: 14, ar: 'مرحبا بالعالم' }] }, { w: 300, h: 300, lines: [] }], { title: 'T (x)' });
  assert.equal(Buffer.from(pdf.subarray(0, 5)).toString(), '%PDF-');
  const pd = await PDFDocument.load(pdf, { updateMetadata: false });
  assert.equal(pd.getPageCount(), 2); assert.deepEqual(pd.getPage(1).getSize(), { width: 300, height: 300 }); assert.equal(pd.getTitle(), 'T (x)');
  const ep = lib.makeEpub({ id: 'x', title: 'Ttl & co', lang: 'ar', chapters: [['One', '<p>نص</p>'], ['Two', '<p>b</p>']] });
  assert.equal(Buffer.from(ep.subarray(30, 38)).toString(), 'mimetype');
  const ez = await JSZip.loadAsync(Buffer.from(ep));
  assert.match(await ez.file('OEBPS/content.opf').async('string'), /<dc:title>Ttl &amp; co<\/dc:title>.*page-progression-direction="rtl"/);
  assert.match(await ez.file('OEBPS/c1.xhtml').async('string'), /dir="rtl".*<p>نص<\/p>/);
  assert.equal(lib.verdict([]), 1); assert.equal(lib.verdict([{ ok: true }, { ok: false, required: false }]), 0); assert.equal(lib.verdict([{ ok: false }]), 1);
  assert.match(lib.engineOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.80'), /^WebView2/);
  assert.match(lib.engineOf('Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)'), /WebKitGTK/);

  // Every command it calls is registered, with the argument names it sends.
  const src = path.join(TAURI, 'src-tauri', 'src');
  const main = fs.readFileSync(path.join(src, 'main.rs'), 'utf8');
  const registered = [...main.matchAll(/(?:commands|selftest|enginetest|titlebar)::(kr_\w+)/g)].map((m) => m[1]);
  const params = {};
  for (const file of ['commands.rs', 'selftest.rs', 'enginetest.rs', 'titlebar.rs']) {
    const rs = fs.readFileSync(path.join(src, file), 'utf8');
    for (const m of rs.matchAll(/#\[tauri::command\]\s*pub async fn (kr_\w+)\(([^)]*)\)/g)) params[m[1]] = m[2].split(',').map((x) => x.trim()).filter(Boolean).filter((x) => !/:\s*(AppHandle|tauri::Window)$/.test(x)).map((x) => x.split(':')[0].trim());
  }
  const calls = [...ENGINE.matchAll(/invoke\('(kr_\w+)', \{([^}]*)\}/g)];
  assert.ok(calls.length >= 4, 'enginetest.js calls');
  for (const m of calls) {
    const keys = m[2].split(',').map((x) => x.trim().split(':')[0].trim()).filter(Boolean);
    assert.ok(registered.includes(m[1]), `enginetest.js calls ${m[1]}, which main.rs does not register`);
    assert.deepEqual([...keys].sort(), [...params[m[1]]].sort(), `enginetest.js: ${m[1]} sends ${keys}, Rust takes ${params[m[1]]}`);
  }
  // No script of the built app with «%PDF» in its first kilobyte: a web view that guesses a file's type from it
  // (WKWebView in R0's run) refused such a chunk as 'application/pdf' (src/filecheck.ts now looks for the bytes).
  if (fs.existsSync(path.join(DIST, 'assets'))) {
    const pdfLike = fs.readdirSync(path.join(DIST, 'assets')).filter((f) => /\.(m?js|css)$/.test(f)).filter((f) => { const fd = fs.openSync(path.join(DIST, 'assets', f), 'r'); const b = Buffer.alloc(1024); const n = fs.readSync(fd, b, 0, 1024, 0); fs.closeSync(fd); return b.subarray(0, n).includes('%PDF'); });
    assert.deepEqual(pdfLike, [], 'scripts with «%PDF» in their first kilobyte');
  }
  console.log(`tauriengine (node): ok — zip, inflate, unzip, PDF and EPUB writers; ${calls.length} command calls registered`);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.epub': 'application/epub+zip', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });

async function pagePart() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('no dist/: run node scripts/build.mjs first');
  const shots = arg('--shots'); if (shots) fs.mkdirSync(shots, { recursive: true });
  const { chromium } = require('playwright');
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch();
  try {
    const ctx = await br.newContext({ viewport: { width: 1180, height: 820 }, ...(process.argv.includes('--webkit') ? { serviceWorkers: 'block' } : {}) }); const p = await ctx.newPage();
    let finished; const done = new Promise((res) => { finished = res; });
    let last = []; const logged = new Set();
    await p.exposeBinding('__krTest', async (_src, cmd, args) => {
      if (cmd === 'kr_selftest_progress') {
        last = args.results;
        for (const r of last) { const k = `${r.case}|${r.name}|${r.detail}`; if (!logged.has(k)) { logged.add(k); console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} [${r.case}] ${r.name}${r.ms != null ? ` (${r.ms} ms)` : ''} — ${String(r.detail).slice(0, 220)}`); } }
        return null;
      }
      if (cmd === 'kr_selftest_done') { finished(args.results); return null; }
      if (cmd === 'kr_engine_shot') { if (!shots) return 'not kept (no --shots)'; const f = path.join(shots, `${args.name}.png`); await p.screenshot({ path: f }); return f; }
      if (cmd === 'kr_engine_profile') return [{ name: 'chromium', path: '(Playwright context)', exists: true }];
      throw new Error('unknown command ' + cmd);
    });
    // (What main.rs puts first: the fake IPC stands for Tauri's own, then the boot line, the bridge and the test.)
    await p.addInitScript(() => {
      const replies = { kr_scan_device: () => ({ root: '/home/u', files: [], truncated: false }), kr_file_size: () => -1, kr_folder_read: () => null, kr_http: (a) => ({ status: 404, url: a.o.url, headers: {}, body: '' }),
        // (The window's own title bar: a window's state kept here, each change told as the kr:titleBarState event.)
        kr_title_bar: (a) => { const o = (a && a.o) || {}; const st = window.__wbState; if (o.act === 'maximize') { st.maximized = !st.maximized; setTimeout(() => window.__wbSubs.forEach((f) => f({ payload: { ...st } })), 5); } if (typeof o.own === 'boolean') st.own = o.own; return { ...st }; } };
      window.__wbState = { platform: 'linux', height: 32, own: true, wanted: true, controls: 'own', maximized: false, fullscreen: false, focused: true }; window.__wbSubs = [];
      window.__TAURI__ = { core: { invoke: (cmd, args) => (replies[cmd] ? Promise.resolve(replies[cmd](args)) : window.__krTest(cmd, JSON.parse(JSON.stringify(args || {})))) }, event: { listen: (n, f) => { if (n === 'kr:titleBarState') window.__wbSubs.push(f); return Promise.resolve(() => {}); } } };
    });
    // --webkit: Chromium made to lack what CI's WebKit lacks (found in the R1 reports) — in the page and, by rewriting
    // the scripts as they are served, in every worker — so that a missing fallback shows here before it shows there.
    if (process.argv.includes('--webkit')) {
      const LACK = `(() => { try { delete ReadableStream.prototype[Symbol.asyncIterator]; delete ReadableStream.prototype.values; } catch {}
        try { delete globalThis.requestIdleCallback; delete globalThis.cancelIdleCallback; } catch {}
        try { delete globalThis.scheduler; } catch {}
        try { Object.defineProperty(Object.getPrototypeOf(navigator), 'deviceMemory', { get: undefined, configurable: true }); delete Object.getPrototypeOf(navigator).deviceMemory; } catch {}
        try { delete Object.getPrototypeOf(performance).memory; } catch {} })();\n`;
      await p.addInitScript({ content: LACK });
      await ctx.route(/\/assets\/(pdf\.worker\.min\.mjs|[a-z]*worker\.js|pdf2docxlane\.js|pdflayout\.js|pdftoolsworker\.js|thumbworker\.js)(\?.*)?$/, async (route) => {
        const res = await route.fetch(); route.fulfill({ response: res, body: LACK + (await res.text()) });
      });
    }
    const runId = String(Date.now());
    await p.addInitScript({ content: `window.__KR_BOOT__ = ${JSON.stringify({ os: 'linux', arch: 'x64' })};\n${BRIDGE}\nwindow.__KR_ENGINETEST__ = ${JSON.stringify({ runId, os: 'linux', version: '0.0.0', budgetMs: 900000 })};\n${ENGINE}` });
    const t0 = Date.now();
    await p.goto(base + '#/');
    let timer = null;
    const results = await Promise.race([done, new Promise((_, no) => { timer = setTimeout(() => no(new Error('no verdict in 15 minutes; last: ' + JSON.stringify(last.slice(-3)))), 900000); })]).finally(() => clearTimeout(timer));
    const failed = results.filter((r) => r.required !== false && !r.ok);
    const soft = results.filter((r) => r.required === false && !r.ok);
    console.log(`tauriengine (page): ${results.length} checks in ${Math.round((Date.now() - t0) / 1000)} s; ${failed.length} required failed, ${soft.length} reported failed`);
    for (const r of soft) console.log(`  (reported) [${r.case}] ${r.name}: ${String(r.detail).slice(0, 200)}`);
    assert.deepEqual(failed.map((r) => `[${r.case}] ${r.name}: ${r.detail}`), [], 'required checks in Chromium');
    await ctx.close();
  } finally { await br.close(); web.closeAllConnections?.(); web.close(); }
}

(async () => {
  await nodePart();
  if (process.argv.includes('--node-only')) return;
  await pagePart();
})().catch((e) => { console.error(e); process.exit(1); });
