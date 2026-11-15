// node tests/directfile.cjs [en|ar]: a link that names a plain file is a plain download on every host — also on the sites
// yt-dlp is always asked about (an Internet Archive download host serving an Arabic-named PDF went to yt-dlp, which made no file).
// A local fake site on a free port (made-up names only; no real site is ever asked). Three parts:
//  1. the rule, table-driven — each link shape → the engine chosen (the page's own routing: isVideoHost / pageLike / the batch check),
//     the request line the fake site received (exactly as given), the name the link gives — and the same table through Electron's
//     (desktop/ytdlp.cjs) and the Rust core's (dlrules.rs, run with rustc when there is one) copies;
//  2. the fallback: the extractor ends with no file, the link answers with a file → the direct engine once, with a log line; never twice;
//  3. the task's page (en and ar, 360 px): the error on its own line with a gap, no percentage for an unknown size, an empty track,
//     one main action, buttons of one height that never touch.
// Also runs tests/native/direct.sh (the Android downloader's request line, redirects, resume, names — needs javac) when there is one.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const cp = require('node:child_process'); const Module = require('node:module');
const ROOT = path.join(__dirname, '..'); const DIST = path.join(ROOT, 'dist'); const lang = process.argv[2] || 'en';
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 500))); if (!c) fails++; };

// ---- the fake site ----
const AR = '%D8%AB%D9%84%D8%A7%D8%AB%20%20%D8%B1%D8%B3%D8%A7%D8%A6%D9%84%D8%8C%201688';   // «ثلاث  رسائل، 1688» (two spaces, U+060C)
const AR_NAME = 'ثلاث  رسائل، 1688';
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2000, 7)]);
const seen = []; const table = new Map();   // table: raw path+query → { status, type, headers, body, redirect }
const site = http.createServer((q, r) => {
  seen.push({ method: q.method, raw: q.url, host: q.headers.host, range: q.headers.range });
  const e = table.get(q.url); if (!e) { r.writeHead(404, { 'content-type': 'text/html' }); r.end('<!doctype html><html><body>nothing</body></html>'); return; }
  if (e.redirect) { r.writeHead(302, { location: e.redirect }); r.end(); return; }
  r.writeHead(e.status ?? 200, { 'content-type': e.type ?? 'application/pdf', 'accept-ranges': 'bytes', 'content-length': String((e.body ?? PDF).length), ...(e.headers ?? {}) });
  if (q.method === 'HEAD') { r.end(); return; }
  r.end(e.body ?? PDF);
});
let SITE_PORT = 0;
// What the desktop's main process does for page.http (the shells' request): the address asked exactly as given, redirects followed (every host is the fake site).
function bridge(o) {
  return new Promise((res, rej) => {
    let url = o.url; let hops = 0;
    const go = () => {
      const u = new URL(url); const reqPath = u.pathname + u.search;
      const rq = http.request({ host: '127.0.0.1', port: SITE_PORT, method: o.method || 'GET', path: reqPath, headers: { ...(o.headers || {}), host: u.host } }, (rs) => {
        if (rs.statusCode >= 300 && rs.statusCode < 400 && rs.headers.location && hops++ < 10) { url = new URL(rs.headers.location, url).href; rs.resume(); go(); return; }
        const bufs = []; rs.on('data', (b) => bufs.push(b)); rs.on('end', () => { const buf = Buffer.concat(bufs); const headers = {}; for (const [k, v] of Object.entries(rs.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : String(v); res({ status: rs.statusCode, url, headers, body: o.binary ? buf.toString('base64') : buf.toString('utf8') }); });
      }); rq.on('error', rej); rq.end();
    }; go();
  });
}
const STUB = () => {
  window.__calls = []; window.__tasks = JSON.parse(sessionStorage.getItem('kt.test.tasks') || '[]');
  const plugin = new Proxy({ addListener: () => ({ remove() {} }), list: async () => ({ tasks: window.__tasks }),
    add: async (o) => { window.__calls.push(['add', o.source.url, o]); return { task: { id: 'n1', kind: 'http', name: 'x', source: o.source, dir: o.dir || '/d', state: 'downloading', done: 0, total: 0, downSpeed: 0, upSpeed: 0, files: [], addedAt: Date.now(), engine: 'native' } }; },
    resume: async (o) => { window.__calls.push(['resume', o.id]); } },
  { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
};
const MODS_STUB = () => { window.__calls = []; window.kurokawaTools = { http: (o) => window.__http(o), platform: 'web' }; };

(async () => {
  const esbuild = require(require.resolve('esbuild', { paths: [ROOT, path.join(ROOT, '..', '..')] }));
  const entry = "import * as D from './src/downloads/direct'; import * as Y from './src/video/ytdlp'; import * as V from './src/views/addVideo'; import * as P from './src/downloads/probe'; import * as F from './src/downloads/fallback'; import * as ER from './src/downloads/errors'; import * as PF from './src/downloads/preflight'; import * as T from './src/views/task'; import * as TM from './src/views/taskmap'; import * as I from './src/i18n'; (window as any).__m = { D, Y, V, P, F, ER, PF, T, TM, I };";
  const bundle = (await esbuild.build({ stdin: { contents: entry, resolveDir: ROOT, loader: 'ts' }, bundle: true, write: false, format: 'iife', logLevel: 'silent', loader: { '.woff2': 'empty', '.png': 'empty', '.svg': 'text' } })).outputFiles[0].text;
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]);
    if (p === '/blank.html') { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><html><body></body></html>'); return; }
    if (p === '/bundle.js') { r.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); r.end(bundle); return; }
    if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : p.endsWith('.json') ? 'application/json' : 'text/html' }); r.end(fs.readFileSync(f));
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res)); const base = `http://127.0.0.1:${srv.address().port}`;
  await new Promise((res) => site.listen(0, '127.0.0.1', res)); SITE_PORT = site.address().port;

  // ---- the table ----
  const IA = 'https://dn721300.ca.archive.org'; const MIRROR = 'https://mirror-two.example.test';
  const cases = [
    { n: 'the owner\'s link: an Arabic percent-encoded name, double spaces, U+060C, digits (archive.org download host)', url: `${IA}/0/items/made-up-item/${AR}.pdf`, engine: 'direct', name: `${AR_NAME}.pdf`, file: true },
    { n: '%2B in the name is a plus', url: `${IA}/0/items/m/a%2Bb.pdf`, engine: 'direct', name: 'a+b.pdf', file: true },
    { n: '«+» in the name stays a plus (not a space)', url: `${IA}/0/items/m/a+b.pdf`, engine: 'direct', name: 'a+b.pdf', file: true },
    { n: '%23 (#) in the name', url: `${IA}/0/items/m/h%23k.pdf`, engine: 'direct', name: 'h#k.pdf', file: true },
    { n: '%3F (?) in the name', url: `${IA}/0/items/m/q%3Fq.pdf`, engine: 'direct', name: 'q?q.pdf', file: true },
    { n: 'an uppercase extension', url: `${IA}/0/items/m/UP.PDF`, engine: 'direct', name: 'UP.PDF', file: true, ext: 'pdf' },
    { n: 'a query string after the extension', url: `${IA}/0/items/m/file.pdf?token=a%20b&x=%2B`, engine: 'direct', name: 'file.pdf', file: true },
    { n: 'a zip on a known site', url: 'https://www.dailymotion.com/files/archive.zip', engine: 'direct', name: 'archive.zip', file: true, type: 'application/zip', body: 'PK\u0003\u0004made-up' },
    { n: 'a long extension (appimage) on a known site', url: 'https://archive.org/download/m/tool.AppImage', engine: 'direct', name: 'tool.AppImage', file: true, ext: 'appimage', type: 'application/octet-stream', body: '\u007fELF made-up' },
    { n: 'media by extension is direct too (mp4 on a known site)', url: 'https://archive.org/download/m/film.mp4', engine: 'direct', name: 'film.mp4', file: true },
    { n: 'a redirect chain to another mirror host', url: `${IA}/0/items/m/chain.pdf`, engine: 'direct', name: 'chain.pdf', file: true, redirect: [`${MIRROR}/hop/chain.pdf`], expectRaw: ['/0/items/m/chain.pdf', '/hop/chain.pdf'] },
    { n: 'Content-Disposition filename* (UTF-8) wins over the link\'s name', url: `${IA}/0/items/m/link-name.pdf`, engine: 'direct', name: 'ملف  النسخة +١.pdf', file: true, headers: { 'content-disposition': "attachment; filename=\"fallback.pdf\"; filename*=UTF-8''%D9%85%D9%84%D9%81%20%20%D8%A7%D9%84%D9%86%D8%B3%D8%AE%D8%A9%20%2B%D9%A1.pdf" } },
    { n: 'no extension, application/pdf, an unknown site: the extractor looks first, the link answers with a file', url: 'https://files.example.test/get/abc', engine: 'extractor-first', name: 'abc.pdf', file: true, type: 'application/pdf' },
    { n: 'no extension on a known site: the extractor first, the fallback then (part 2)', url: 'https://archive.org/download/m/document', engine: 'extractor', file: true, type: 'application/pdf' },
    { n: '.php that returns a file (a known site): asked first, then plain', url: 'https://archive.org/get.php?id=m1', engine: 'direct-by-answer', file: true, type: 'application/pdf', script: true },
    { n: '.php that returns a page (a known site): stays the extractor\'s', url: 'https://archive.org/get.php?id=m2', engine: 'extractor', file: false, type: 'text/html', body: '<!doctype html><html><body>sign in</body></html>', script: true },
    { n: 'a real page ending .html (a known site) stays the page / extractor path', url: 'https://archive.org/details/made-up/page.html', engine: 'extractor', file: false, type: 'text/html', body: '<!doctype html><html><body>page</body></html>' },
    { n: 'a real page ending .html (an unknown site)', url: 'https://files.example.test/docs/page.html', engine: 'extractor-first', file: false, type: 'text/html', body: '<!doctype html><html><body>page</body></html>' },
    { n: 'an HLS manifest is NOT direct (a known site)', url: 'https://archive.org/download/m/master.m3u8', engine: 'extractor', file: false, type: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n' },
    { n: 'a DASH manifest is NOT direct', url: 'https://files.example.test/live/manifest.mpd', engine: 'extractor-first', file: false, type: 'application/dash+xml', body: '<MPD/>' },
    { n: 'a video site\'s page (YouTube watch) is the extractor\'s', url: 'https://www.youtube.com/watch?v=abc', engine: 'extractor' },
    { n: 'a repository\'s blob page that looks like a file is not taken for one by name (the plain path then asks it: a page)', url: 'https://github.com/made-up/repo/blob/main/doc.pdf', engine: 'direct', file: false, type: 'text/html', body: '<!doctype html><html><body>blob</body></html>', notByName: true },
  ];
  for (const c of cases) {
    const u = new URL(c.url); const raw = u.pathname + u.search;
    if (c.redirect) { table.set(raw, { redirect: c.redirect[0] }); const m = new URL(c.redirect[0]); table.set(m.pathname + m.search, { type: c.type, headers: c.headers }); }
    else table.set(raw, { type: c.type, headers: c.headers, body: c.body !== undefined ? Buffer.from(c.body) : undefined });
  }
  const b = await chromium.launch(); const errs = [];
  const P = await b.newPage(); P.on('pageerror', (e) => errs.push('modules: ' + e.message)); await P.exposeFunction('__http', bridge);
  await P.addInitScript(MODS_STUB); await P.goto(`${base}/blank.html`); await P.addScriptTag({ url: `${base}/bundle.js` }); await P.waitForFunction(() => !!window.__m, null, { timeout: 8000 }).catch(() => console.log('bundle did not load'));
  // Electron's copy (desktop/ytdlp.cjs, with electron stubbed) and the Rust core's table.
  const stubLoad = Module._load; Module._load = function (req, ...r) { return req === 'electron' ? { app: {}, net: {} } : stubLoad.call(this, req, ...r); };
  const Y = require(path.join(ROOT, 'desktop/ytdlp.cjs')); Module._load = stubLoad;
  const RS = fs.readFileSync(path.join(ROOT, 'core/kt-core/src/dlrules.rs'), 'utf8'); const rsExts = (/pub const DIRECT_EXTS: &\[&str\] = &\[([\s\S]*?)\];/.exec(RS) || [])[1]; const rust = rsExts ? [...rsExts.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort() : null;
  const tsExts = await P.evaluate(() => [...window.__m.D.DIRECT_EXTS].sort());
  ok('the extension table is the same in the page, Electron\'s copy and the Rust core', JSON.stringify(tsExts) === JSON.stringify([...Y.DIRECT_EXTS].sort()) && JSON.stringify(tsExts) === JSON.stringify(rust), { ts: tsExts.length, ele: Y.DIRECT_EXTS.length, rust: rust && rust.length });
  ok('the table has the documents, archives, apps, subtitles/fonts, images, torrents and media of the brief', ['pdf', 'epub', 'mobi', 'azw3', 'djvu', 'cbz', 'cbr', 'docx', 'xlsx', 'pptx', 'txt', 'zip', '7z', 'rar', 'tar', 'gz', 'xz', 'bz2', 'zst', 'iso', 'apk', 'xapk', 'apks', 'apkm', 'exe', 'msi', 'dmg', 'deb', 'appimage', 'ass', 'ssa', 'srt', 'vtt', 'sub', 'ttf', 'otf', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg', 'mkv', 'mp4', 'webm', 'avi', 'mov', 'm4v', 'ts', 'flac', 'mp3', 'm4a', 'opus', 'ogg', 'wav', 'aac'].every((e) => tsExts.includes(e)) && !tsExts.includes('m3u8') && !tsExts.includes('mpd'));

  for (const c of cases) {
    const r = await P.evaluate(async (c) => {
      const { D, Y, V, P, PF } = window.__m; const out = {};
      out.hostKnown = Y.isVideoHost(c.url) ; out.direct = D.directByName(c.url); out.pageLike = V.pageLike(c.url); out.script = D.scriptNamed(c.url);
      const pre = await PF.preflight([{ url: c.url }], { videoEnabled: true, isVideoHost: Y.isVideoHost, pageLike: V.pageLike, dir: '' }).catch((e) => ({ items: [{ verdict: 'threw ' + e.message }] }));
      out.verdict = pre.items[0].verdict;
      if (c.file !== undefined) { try { const p = await P.probeUrl(c.url); out.probe = { name: p.name, stem: p.stem, ext: p.ext, page: p.page, type: p.type, finalUrl: p.finalUrl, status: p.status }; out.says = D.probeSaysFile(p); } catch (e) { out.probeErr = String(e.message || e); } }
      if (c.script && out.says) { D.markDirect(c.url); out.afterProve = { host: Y.isVideoHost(c.url), pageLike: V.pageLike(c.url) }; }
      return out;
    }, c);
    // the engine chosen by the page's routing: a direct file never goes to the extractor; the rest is the extractor's page path or its look-first path
    const engine = r.pageLike ? (r.hostKnown ? 'extractor' : 'extractor-first') : 'direct';
    const expectEngine = c.engine === 'direct-by-answer' ? 'extractor' : c.engine;   // (a script's name says nothing: the page-side check comes first)
    ok(`${c.n}: engine ${expectEngine}`, engine === expectEngine, { engine, r });
    if (c.engine === 'direct') ok(`  batch check gives a plain file, not a video: ${r.verdict}`, r.verdict === (c.file === false ? 'page' : 'ok'), r.verdict);
    if (c.notByName) ok('  not a file by its name', r.direct === false, r);
    if (c.engine === 'extractor' || c.engine === 'direct-by-answer') ok('  batch check sends it to the extractor (video)', r.verdict === 'video', r.verdict);
    if (c.script) { ok('  the script name is told apart (asked before the extractor)', r.script === true, r); if (c.file) ok('  the answer is a file: after proving it the link is plain (not a page)', r.afterProve && r.afterProve.host === false && r.afterProve.pageLike === false, r.afterProve); else ok('  the answer is a page: not proved plain', !r.says, r); }
    if (c.file !== undefined && !r.probeErr) {
      ok(`  probe says ${c.file ? 'a file' : 'not a file'}`, r.says === c.file, r.probe);
      if (c.file && c.name) { const nm = r.probe.stem + (r.probe.ext ? '.' + r.probe.ext : ''); const want = c.name; ok(`  the saved name: «${want}»`, nm === want || (c.ext && nm.toLowerCase() === want.toLowerCase()), r.probe); }
      if (c.expectRaw) { const got = seen.filter((s) => c.expectRaw.includes(s.raw.split('?')[0]) || c.expectRaw.includes(s.raw)).map((s) => s.raw); ok('  both hosts asked, each with its path as given', c.expectRaw.every((x) => got.includes(x)), seen.map((s) => s.raw)); ok('  the final address is the other mirror\'s', /mirror-two\.example\.test/.test(r.probe.finalUrl || ''), r.probe.finalUrl); }
    }
    if (c.file) { const u = new URL(c.url); const raw = u.pathname + u.search; const hit = seen.filter((s) => s.raw === raw); ok('  the request line the site received is the link exactly as given', hit.length > 0, { raw, seen: seen.map((s) => s.raw).slice(-6) }); }
  }
  // Electron's and the Rust core's routing agree with the page's, over the whole table.
  { const plainByAnswer = (c) => c.script && c.file; const list = cases.filter((c) => !plainByAnswer(c)); const pageSays = await P.evaluate((urls) => urls.map((u) => window.__m.Y.isVideoHost(u)), list.map((c) => c.url)); const eleSays = list.map((c) => Y.isVideoPage(c.url));
    ok('Electron\'s isVideoPage agrees with the page\'s isVideoHost on every link of the table', JSON.stringify(pageSays) === JSON.stringify(eleSays), list.map((c, i) => pageSays[i] !== eleSays[i] ? c.url : null).filter(Boolean));
  }
  const hasRustc = cp.spawnSync('rustc', ['--version']).status === 0;
  if (hasRustc) { const outBin = path.join(require('node:os').tmpdir(), `kt-dlrules-${process.pid}`); const c1 = cp.spawnSync('rustc', ['--edition', '2021', '--test', path.join(ROOT, 'core/kt-core/src/dlrules.rs'), '-o', outBin], { encoding: 'utf8' }); const run = c1.status === 0 ? cp.spawnSync(outBin, ['direct_file_links'], { encoding: 'utf8' }) : c1; ok('Rust core: dlrules.rs direct_file_links (the same table, rustc --test)', run.status === 0 && /1 passed/.test(run.stdout || ''), (run.stdout || '') + (run.stderr || '')); try { fs.unlinkSync(outBin); } catch { /* none */ } }
  else console.log('skip Rust core test (no rustc here): cargo test dlrules::tests::direct_file_links');
  const hasJava = cp.spawnSync('javac', ['-version']).status === 0;
  if (hasJava) { const j = cp.spawnSync('sh', [path.join(__dirname, 'native/direct.sh')], { encoding: 'utf8', timeout: 150000 }); const outp = j.stdout || ''; ok('Android downloader (Java): request line, redirects to a mirror, resume by Range, names, the cut', j.status === 0 && /direct: all passed/.test(outp), outp.split('\n').filter((l) => /^FAIL/.test(l)).concat((j.stderr || '').split('\n').filter((l) => !/Picked up/.test(l)).slice(0, 5))); }
  else console.log('skip Java downloader test (no javac here): sh tests/native/direct.sh');

  // ---- the TS cut of a long name ----
  { const r = await P.evaluate(() => { const { D } = window.__m; const long = 'عبد'.repeat(150) + '.pdf'; const c = D.clipName(long); const em = D.clipName('\u{1F600}'.repeat(80) + '.mkv'); const enc = new TextEncoder();
      return { len: enc.encode(c).length, ext: c.endsWith('.pdf'), valid: !new TextDecoder('utf-8', { fatal: false }).decode(enc.encode(c)).includes('�'), emLen: enc.encode(em).length, emExt: em.endsWith('.mkv'), emSplit: /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(em), short: D.clipName('a.pdf') }; });
    ok('a too-long Arabic name is cut to 200 bytes between characters, extension kept', r.len <= 200 && r.ext && r.valid, r); ok('a name of surrogate pairs is never cut inside one', r.emLen <= 200 && r.emExt && !r.emSplit, r); ok('a short name is left alone', r.short === 'a.pdf', r); }

  // ---- part 2: the fallback ----
  table.set('/0/items/m/needs-retry.pdf', { type: 'application/pdf' }); table.set('/0/items/m/a-page.pdf', { type: 'text/html', body: Buffer.from('<!doctype html><html><body>sign in</body></html>') });
  const fb = await P.evaluate(async () => {
    const { F, ER, TM, I } = window.__m; const log = []; const mk = (id, url, error, extra = {}) => ({ id, kind: 'video', name: 'x', source: { url }, dir: '/d', state: 'failed', done: 0, total: 0, downSpeed: 0, upSpeed: 0, files: [], addedAt: Date.now(), engine: 'native', error, ...extra });
    const eng = { removed: [], added: [], async remove(id) { this.removed.push(id); }, async add(o) { this.added.push(o); return { id: 'new' + this.added.length, kind: 'http', name: '', source: o.source, dir: o.dir, state: 'queued', done: 0, total: 0, downSpeed: 0, upSpeed: 0, files: [], addedAt: Date.now(), engine: 'native', meta: o.meta }; } };
    const out = {};
    const t1 = mk('v1', 'https://dn721300.ca.archive.org/0/items/m/needs-retry.pdf', 'yt-dlp made no file', { meta: { wifiOnly: true } });
    out.eligible = F.eligible(t1); const n1 = await F.directRetry(t1, eng); out.n1 = n1 && { id: n1.id, kind: n1.kind, directTried: n1.meta.directTried, wifi: n1.meta.wifiOnly, url: eng.added[0].source.url, dir: eng.added[0].dir }; out.removed = eng.removed.slice();
    out.logLine = TM.historyOf(n1).log.map((l) => l.text); out.expectLog = I.t('logDirectRetry');
    out.again = await F.directRetry(t1, eng); out.addsAfterAgain = eng.added.length;           // once only
    const t2 = { ...n1, state: 'failed', error: 'HTTP 404' }; out.noLoop = !F.eligible(t2) && (await F.directRetry(t2, eng)) === null;
    const t3 = mk('v3', 'https://dn721300.ca.archive.org/0/items/m/a-page.pdf', 'yt-dlp made no file'); out.page = await F.directRetry(t3, eng); out.addsAfterPage = eng.added.length;
    const t4 = mk('v4', 'https://dn721300.ca.archive.org/0/items/m/needs-retry.pdf', 'ERROR: Unsupported URL: https://x'); out.unsupported = (await F.directRetry(t4, eng)) !== null;
    const t5 = mk('v5', 'https://dn721300.ca.archive.org/0/items/m/needs-retry.pdf', 'HTTP 403'); out.other = F.eligible(t5);
    const t6 = mk('v6', 'https://dn721300.ca.archive.org/0/items/m/needs-retry.pdf', 'yt-dlp made no file', { meta: { directTried: true } }); out.marked = F.eligible(t6);
    out.plain = [ER.plainEngineError('yt-dlp made no file'), ER.plainEngineError('ERROR: Unsupported URL: https://x'), ER.plainEngineError('HTTP 404')];
    return out;
  });
  ok('failed extractor task on a file link: eligible', fb.eligible === true, fb);
  ok('  the direct engine is tried: the task replaced by a plain add of the same link and folder, its holds kept, marked tried', fb.n1 && fb.n1.kind === 'http' && fb.n1.directTried === true && fb.n1.wifi === true && /needs-retry\.pdf$/.test(fb.n1.url) && fb.n1.dir === '/d' && fb.removed[0] === 'v1', fb);
  ok('  its log says so', fb.logLine.includes(fb.expectLog), fb.logLine);
  ok('  once only: the same task again adds nothing', fb.again === null && fb.addsAfterAgain === 1, fb);
  ok('  never a loop: a failed plain task is not looked at, one marked tried is not either', fb.noLoop && fb.marked === false, fb);
  ok('  a link that answers with a page is not retried', fb.page === null && fb.addsAfterPage === 1, fb);
  ok('  «Unsupported URL» is retried too; another error is not', fb.unsupported === true && fb.other === false, fb);
  ok('  the raw engine errors have plain words', typeof fb.plain[0] === 'string' && !/yt-dlp/.test(fb.plain[0]) && typeof fb.plain[1] === 'string' && fb.plain[2] === null, fb.plain);

  // ---- part 3: the task's page ----
  for (const L of lang === 'ar' ? ['ar', 'en'] : ['en', 'ar']) {
    const ctx = await b.newContext({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true }); const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(`card ${L}: ` + e.message));
    const now = Date.now(); const NAME = `${AR_NAME}.pdf`; const url = `${IA}/0/items/made-up-item/${AR}.pdf`;
    const mk = (id, over) => ({ id, kind: 'video', name: NAME, source: { url }, dir: '/d', state: 'failed', done: 0, total: 0, downSpeed: 0, upSpeed: 0, files: [], addedAt: now, engine: 'native', error: 'yt-dlp made no file', ...over });
    const tasks = [mk('c1', {}), mk('c2', { done: 4e6, total: 9e6, error: 'HTTP 503' }), mk('c3', { kind: 'http', state: 'downloading', done: 0, total: -1, downSpeed: 1e5, connections: 1 }), mk('c4', { kind: 'http', done: 1, total: 0, error: 'Connection refused' })];
    await p.addInitScript(STUB); await p.addInitScript(([lg, ts]) => { localStorage.setItem('kr.lang', lg); localStorage.setItem('kt.settings', JSON.stringify({ downloadDir: '/storage/emulated/0/Download' })); sessionStorage.setItem('kt.test.tasks', JSON.stringify(ts)); }, [L, tasks]);
    const read = async (id) => { await p.goto(`${base}/#/task/${id}`); await p.reload(); await p.waitForSelector('.task-detail .kt-meter', { timeout: 15000 }); await p.waitForTimeout(500);
      return p.evaluate(() => { const r = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, h: b.height, w: b.width }; };
        const btns = [...document.querySelectorAll('.task-detail-actions .btn')]; const err = document.querySelector('.task-error'); const line = document.querySelector('.task-error .err-line'); const eb = [...document.querySelectorAll('.task-error .btn')];
        const rects = btns.map(r); let touch = false; for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) { const a = rects[i], c = rects[j]; const gx = Math.max(a.l - c.r, c.l - a.r), gy = Math.max(a.t - c.b, c.t - a.b); if (Math.max(gx, gy) < 6) touch = true; }
        return { pct: !!document.querySelector('.kt-pct'), pctText: document.querySelector('.kt-pct')?.textContent ?? null, busy: !!document.querySelector('.kt-meter .task-bar.busy-any'), fill: document.querySelector('.kt-meter .task-bar i')?.getBoundingClientRect().width ?? -1, fillStyle: document.querySelector('.kt-meter .task-bar i')?.style.width,
          errText: line?.textContent ?? null, errRaw: document.querySelector('.task-error .err-raw')?.textContent ?? null, errBottom: line ? line.getBoundingClientRect().bottom : null, errBtnTop: eb.length ? Math.min(...eb.map((x) => x.getBoundingClientRect().top)) : null,
          primary: btns.filter((x) => x.dataset.act === 'try-again' || x.dataset.act === 'resume').map((x) => `${x.dataset.act}:${x.textContent.trim()}`), allText: btns.map((x) => x.textContent.trim()), heights: [...new Set(btns.map((x) => Math.round(x.getBoundingClientRect().height)))], touch, radii: [...new Set(btns.map((x) => getComputedStyle(x).borderRadius))],
          removeClass: document.querySelector('.task-detail-actions .btn.danger')?.className ?? null, errBtns: eb.map((x) => x.textContent.trim()), bodyScroll: document.documentElement.scrollWidth > innerWidth + 1, nameBidi: getComputedStyle(document.querySelector('.kt-name')).unicodeBidi, nameDir: document.querySelector('.kt-name').getAttribute('dir'), title: document.querySelector('.topbar .title span')?.getAttribute('dir') }; }); };
    const TT = await P.evaluate(() => 0);   // (the strings of this language are read from the page itself below)
    const c1 = await read('c1'); const shot = (name) => p.screenshot({ path: path.join(process.env.KT_SHOTS || require('node:os').tmpdir(), `card-${name}-${L}.png`) }).catch(() => undefined);
    await shot('failed-nothing');
    ok(`[${L}] failed with nothing received: no percentage at all`, c1.pct === false, c1);
    ok(`[${L}]   an empty track (no stub, no busy animation)`, c1.busy === false && c1.fill <= 0.5, c1);
    ok(`[${L}]   one main action, «try again» (not Resume besides)`, c1.primary.length === 1 && /^try-again:/.test(c1.primary[0]), c1.primary);
    ok(`[${L}]   the error in plain words (not «yt-dlp made no file»), the raw line under it`, !!c1.errText && !/yt-dlp made no file/.test(c1.errText) && c1.errRaw === 'yt-dlp made no file', c1);
    ok(`[${L}]   the error and any button of it have a gap (>= 8 px), the error wraps`, c1.errBtnTop === null || c1.errBtnTop - c1.errBottom >= 8, c1);
    ok(`[${L}]   the action buttons: one height, one shape, never touching, no sideways scroll`, c1.heights.length === 1 && c1.radii.length === 1 && !c1.touch && !c1.bodyScroll, c1);
    ok(`[${L}]   «Remove» is the destructive text button`, /(^| )text( |$)/.test(c1.removeClass || '') && /danger/.test(c1.removeClass || ''), c1.removeClass);
    ok(`[${L}]   the name has its own direction (the card's and the title's, from its first letter; isolated; the extension apart)`, (L === 'ar' ? c1.nameDir === 'rtl' && c1.title === 'rtl' : true) && /isolate/.test(c1.nameBidi) && ['auto', 'rtl', 'ltr'].includes(c1.title), c1);
    const c2 = await read('c2'); await shot('failed-partial');
    ok(`[${L}] failed with part of the file: the percentage shown, «Resume» is the one main action`, c2.pct && c2.primary.length === 1 && /^resume:/.test(c2.primary[0]) && c2.fill > 0, c2);
    const c3 = await read('c3'); await shot('running-unknown');
    ok(`[${L}] running, size unknown: no percentage, the moving bar`, c3.pct === false && c3.busy === true, c3);
    const c4 = await read('c4');
    ok(`[${L}] failed with a network error and a byte or so here: Resume, no second «try again» in the error`, c4.primary.length === 1 && !c4.errBtns.some((x) => /^(retry|try again|أعد|أعِد)/i.test(x)), c4);
    await ctx.close();
  }
  ok('no page errors', errs.length === 0, errs); await b.close(); srv.close(); site.close();
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})();
