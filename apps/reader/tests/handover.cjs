// node tests/handover.cjs: the hand-over from the Electron build to the Rust build (stage R6a — src/handover.ts,
// ui/handoversheet.ts, desktop/handover.cjs, desktop-tauri/handover-bridge.js; the Rust side's file rules are
// src-tauri/src/handoverlogic.rs's own tests, and CI runs the real thing: tests/handover-electron.cjs then
// desktop-tauri/handovercheck.js). The built app (dist/) in Chromium, in two shapes:
//   «Electron»: window.kurokawaHandover as preload.cjs gives it, its channels answered here by desktop/handover.cjs's
//     own Writer, in a temp «userData» folder;
//   «Rust»: desktop-tauri/bridge.js and handover-bridge.js over a fake Tauri IPC whose kr_handover_* commands do what
//     src-tauri/src/handover.rs does (the same rules, in Node).
// It checks: a profile filled — EPUB, PDF and text books, one book only linked, covers, places, highlights, notes,
// bookmarks, per-book settings, a font, translations, Anki, folders, tags, a custom icon, sign-ins — makes a hand-over
// (marker, sizes, hashes, the pointer); a fresh profile offers it at the start, with the count and where the old data
// stays, brings it, and is then the same (deep compare of every store and key; the text book opens at the same
// paragraph); the second start does not offer or restore it again; «Free the space» deletes only the copy; a broken-off
// write leaves no hand-over taken as valid (and an older complete one stands); a full disk refuses (nothing written,
// the reader told, false for the installer); a damaged copy is refused; a library that already has books gets the
// missing ones and merged notes; backups cross: a «phone» backup restores on the computer and the reverse (the PC-only
// icon left on the phone), a backup of a newer format version is read.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os'); const crypto = require('crypto');
const H = require('../desktop/handover.cjs');
const ROOT = path.resolve(__dirname, '..');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.join(ROOT, 'dist');
const BRIDGE = fs.readFileSync(path.join(ROOT, 'desktop-tauri', 'bridge.js'), 'utf8');
const HBRIDGE = fs.readFileSync(path.join(ROOT, 'desktop-tauri', 'handover-bridge.js'), 'utf8');
const FIX = path.join(__dirname, 'fixtures');
// (The books it imports: the copies in the repository — tests/fixtures/ is git-ignored, a local folder that CI never
// has; a local copy there is used when present.)
const pickFile = (...c) => c.find((f) => fs.existsSync(f)) || c[c.length - 1];
const EPUB_FILE = pickFile(path.join(FIX, 'alice-in-wonderland.epub'), path.join(__dirname, '..', 'public', 'samples', 'alice-in-wonderland.epub'));
const PDF_FILE = pickFile(path.join(FIX, 'sample.pdf'), path.join(__dirname, 'pdfsearch', 'sample.pdf'));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.epub': 'application/epub+zip', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 900))); if (!c) fails++; return !!c; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-handover-'));
const userData = path.join(TMP, 'electron-userData'); const tauriData = path.join(TMP, 'tauri-data'); fs.mkdirSync(userData, { recursive: true });
const ICON = 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'desktop', 'icon.png')).toString('base64');
const SKIP_LOCAL = /^(kr\.update\.lastCheck|kr\.libraryVisit|kr\.sources\.checkedAt|kr\.orphansCleaned)$/;   // (times the app writes itself at each start)

// ---------- the Electron shell's channels: desktop/handover.cjs's Writer, in TMP ----------
let writer = null; const E = { free: undefined, failVerify: false, lastBegin: null };
async function electronCall(cmd, a) {
  switch (cmd) {
    case 'begin': if (writer) await writer.abort(); writer = new H.Writer(userData, { free: E.free, pointers: [{ dir: tauriData, name: H.POINTER }], from: { version: 'test' } }); E.lastBegin = await writer.begin(a.need, { unknownOk: !!a.unknownOk }); return E.lastBegin;
    case 'write': return writer.write(a.rel, Buffer.from(a.b64, 'base64'), a.append);
    case 'shellFiles': return writer.shellFiles(userData);
    case 'readPart': return Buffer.from(await writer.read(a.rel)).toString('base64');
    case 'verify': if (E.failVerify) throw new Error('the process ended here'); return writer.verify(a.list);
    case 'finish': { const r = await writer.finish(a.info); writer = null; return r; }
    case 'abort': if (writer) await writer.abort(); writer = null; return true;
    case 'status': return H.status(userData);
  }
  throw new Error('unknown ' + cmd);
}
const ELECTRON_SHIM = () => {
  const call = (c, a) => window.__krhE(c, a || {});
  const toB64 = (u) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
  const fromB64 = (b) => { const s = atob(b); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; };
  window.kurokawaHandover = Object.freeze({ shell: 'electron', begin: (o) => call('begin', { need: o.need, unknownOk: !!o.unknownOk }), write: (rel, data, append) => call('write', { rel, b64: toB64(data), append: !!append }), shellFiles: () => call('shellFiles'), readPart: async (rel) => fromB64(await call('readPart', { rel })), verify: (list) => call('verify', { list }), finish: (info) => call('finish', { info }), abort: () => call('abort'), status: () => call('status') });
};

// ---------- the Rust shell's kr_handover_* — src-tauri/src/handover.rs's rules, in Node ----------
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function check(dir) {
  const m = rj(path.join(dir, 'marker.json')); if (!m) return { bad: [`${dir}: no readable marker`] };
  if (m.app !== 'KurokawaReader' || m.kind !== 'handover') return { bad: ['not a hand-over'] };
  if (!(m.format >= 1 && m.format <= 1)) return { bad: [`format ${m.format}`] };
  const bad = [];
  for (const f of m.files || []) { if (!H.safeRel(f.rel)) { bad.push(f.rel); continue; } let st; try { st = fs.statSync(path.join(dir, ...f.rel.split('/'))); } catch { bad.push(`${f.rel}: missing`); continue; } if (st.size !== f.size) bad.push(`${f.rel}: ${st.size} bytes, ${f.size} expected`); }
  return bad.length ? { bad } : { m };
}
const resolveGiven = (p) => (fs.existsSync(path.join(p, 'marker.json')) ? p : fs.existsSync(path.join(p, 'handover', 'marker.json')) ? path.join(p, 'handover') : p);
const stateFile = () => path.join(tauriData, 'handover-state.json');
const rust = {
  kr_handover_find: ({ p }) => {
    const state = rj(stateFile());
    const ptr = rj(path.join(tauriData, H.POINTER));
    const list = p ? [resolveGiven(p)] : [...new Set([ptr && ptr.dir, path.join(userData, 'handover')].filter(Boolean))];
    const problems = [];
    for (const d of list) { if (!fs.existsSync(path.join(d, 'marker.json'))) continue; const c = check(d); if (c.m) return { found: true, dir: d, marker: c.m, state, looked: list }; problems.push(...c.bad); }
    return { found: false, state, looked: list, problems };
  },
  kr_handover_verify: ({ p }) => { const c = check(p); if (!c.m) return { ok: false, bad: c.bad }; const bad = c.m.files.filter((f) => sha(path.join(p, ...f.rel.split('/'))) !== f.sha256).map((f) => `${f.rel}: its contents changed`); return { ok: !bad.length, bad }; },
  // (With at/len: that piece only, at most 64 MiB, fewer bytes at the end — handover.rs's range read.)
  kr_handover_read: ({ p, rel, at, len }) => {
    if (!H.safeRel(rel)) throw new Error('not a path in the hand-over: ' + rel);
    const f = path.join(p, ...rel.split('/'));
    if (at === undefined && len === undefined) return { b64: fs.readFileSync(f).toString('base64') };
    const want = Math.min(len ?? 8 * 1024 * 1024, 64 * 1024 * 1024); const fd = fs.openSync(f, 'r');
    try { const b = Buffer.alloc(want); const n = fs.readSync(fd, b, 0, want, at ?? 0); return { b64: b.subarray(0, n).toString('base64') }; } finally { fs.closeSync(fd); }
  },
  kr_handover_mark: ({ o }) => { if (!o.id || !['restored', 'declined'].includes(o.state)) throw new Error('id and state'); fs.mkdirSync(tauriData, { recursive: true }); fs.writeFileSync(stateFile(), JSON.stringify({ id: o.id, state: o.state, at: Date.now(), counts: o.counts ?? null })); return true; },
  kr_handover_free: ({ p }) => { if (path.basename(p) !== 'handover' || rj(path.join(p, 'marker.json'))?.kind !== 'handover') throw new Error('not a hand-over folder: ' + p); let n = 0; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const q = path.join(d, e.name); if (e.isDirectory()) walk(q); else n += fs.statSync(q).size; } }; walk(p); fs.rmSync(p, { recursive: true, force: true }); return { freed: n }; },
};
const rustCalls = []; const shellState = { icon: null, doh: 'off' }; const checkRun = { progress: null, done: null };
const CHECK_JS = fs.readFileSync(path.join(ROOT, 'desktop-tauri', 'handovercheck.js'), 'utf8');
rust.kr_app_icon = ({ o }) => { if (o && 'set' in o) { shellState.icon = o.set; return true; } return shellState.icon; };
rust.kr_handover_check_progress = ({ o }) => { checkRun.progress = o; return null; };
rust.kr_handover_check_done = ({ o }) => { checkRun.done = o; return null; };
rust.kr_set_doh = ({ provider }) => { if (provider) shellState.doh = provider; return { provider: shellState.doh }; };
async function rustCall(cmd, a) { rustCalls.push({ cmd, a }); if (!rust[cmd]) throw new Error('unknown ' + cmd); return rust[cmd](a); }
// (tests/tauribridge.cjs's fake IPC, the commands the app calls at its start; kr_handover_* to Node; the icon kept.)
const TAURI_SHIM = () => {
  try { localStorage.setItem('kr.update.lastCheck', String(Date.now())); } catch { /* first load */ }
  const fromB64 = (b) => { const s = atob(b); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
  window.__icon = null; window.__doh = 'off';
  const replies = {
    kr_read_file: () => new Uint8Array([1, 2, 3]), kr_file_size: () => -1, kr_folder_read: () => null, kr_folder_write: () => true, kr_write_binary: () => true,
    kr_scan_device: () => ({ root: '/home/u', files: [], truncated: false }), kr_folder_pick: () => window.__pick || null, kr_archive_pick_dir: () => null, kr_archive_pick_file: () => [], kr_default_apps: () => null, kr_scan_folder: (a) => ({ root: a.p, files: [], truncated: false }),
    kr_download: (a) => '/data/downloads/' + a.name, kr_delete_download: () => true, kr_set_doh: (a) => { if (a.provider) window.__doh = a.provider; return { provider: window.__doh }; }, kr_notify: () => true, kr_download_cancel: () => false,
    kr_open_take: () => [], kr_title_bar: () => ({ platform: 'linux', height: 32, own: true, wanted: true, controls: 'own', maximized: false, fullscreen: false, focused: true }), kr_http: (a) => ({ status: 404, url: a.o.url, headers: {}, body: '' }),
    kr_open_webview: () => ({ passed: false, blocked: true }), kr_browser_fetch: (a) => ({ status: 404, url: a.o.url, headers: {}, body: '' }), kr_browser_reset: () => true, kr_browser_forget: () => ({ cleared: 0 }),
    kr_archive_list: () => ({ entries: [] }), kr_archive_free: () => ({ free: 1e9 }), kr_archive_existing: () => ({ existing: [] }),
    kr_app_icon: (a) => { if ('set' in (a.o || {})) { window.__icon = a.o.set; return true; } return window.__icon; }, kr_fullscreen: () => false, kr_immersive: () => true, kr_set_zoom: () => true, kr_progress: () => true, kr_copy_image: () => true, kr_menu: () => false, kr_print_file: () => true,
  };
  window.__TAURI__ = {
    core: { invoke: (cmd, args) => (/^kr_handover_|^kr_app_icon$|^kr_set_doh$/.test(cmd) ? window.__krhT(cmd, JSON.parse(JSON.stringify(args || {}))).then((r) => (r && typeof r.b64 === 'string' ? fromB64(r.b64) : r)) : replies[cmd] ? Promise.resolve(replies[cmd](args || {})) : Promise.reject('unknown command ' + cmd)) },
    event: { listen: () => Promise.resolve(() => {}) },
  };
};

const allBooks = (p) => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result.map((b) => ({ ...b, cover: b.cover ? b.cover.size : null, coverOrig: undefined }))); }; }));
async function importFile(p, file, re) {
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.waitForTimeout(600);
  await p.setInputFiles('.library-view input[type=file]', [file]);
  for (let i = 0; i < 200; i++) {
    const b = (await allBooks(p)).find((x) => new RegExp(re).test(x.title) || new RegExp(re).test(x.fileName ?? '')); if (b) return b;
    await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); s?.querySelector('.sheet-actions button, button.btn')?.click(); });
    await p.waitForTimeout(250);
  }
  throw new Error('not imported: ' + file);
}
const topPara = (p) => p.evaluate(() => { const sc = document.querySelector('.reader-scroll'); const top = sc.getBoundingClientRect().top + 10; const ps = [...document.querySelectorAll('.reader-flow p')].filter((x) => x.offsetParent); const hit = ps.find((x) => x.getBoundingClientRect().bottom > top); return /\[(P\d+)\]/.exec(hit?.textContent ?? '')?.[1] ?? (hit?.textContent ?? 'none').slice(0, 30); });
async function openBook(p, id) {
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.waitForTimeout(300);
  await p.evaluate((id) => { location.hash = `#/read/${id}`; }, id);
  await p.waitForFunction(() => [...document.querySelectorAll('.reader-flow .kr-content')].some((e) => e.offsetParent !== null), null, { timeout: 30000 }); await p.waitForTimeout(3200);
}
const snapshot = (p) => p.evaluate(() => window.__KR_HANDOVER__.snapshot());
function compare(a, b) {
  const out = [];
  const ids = (s) => s.books.map((x) => x.id).join(',');
  if (ids(a) !== ids(b)) out.push(`books ${ids(a)} ≠ ${ids(b)}`);
  for (const x of a.books) { const y = b.books.find((z) => z.id === x.id); if (!y) continue; const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => k !== 'lastOpenedAt'); for (const k of keys) if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) out.push(`book ${x.title} ${k}: ${JSON.stringify(x[k])?.slice(0, 100)} ≠ ${JSON.stringify(y[k])?.slice(0, 100)}`); }
  if (JSON.stringify(a.files) !== JSON.stringify(b.files)) out.push(`files ${JSON.stringify(a.files)} ≠ ${JSON.stringify(b.files)}`);
  const missMeta = a.meta.filter((k) => !b.meta.includes(k)); if (missMeta.length) out.push(`meta missing ${missMeta}`);
  if (JSON.stringify(a.opfs) !== JSON.stringify(b.opfs)) out.push(`private files ${JSON.stringify(a.opfs)} ≠ ${JSON.stringify(b.opfs)}`);
  for (const [k, v] of Object.entries(a.local)) if (!SKIP_LOCAL.test(k) && b.local[k] !== v) out.push(`local ${k}: ${String(b.local[k]).slice(0, 80)} ≠ ${String(v).slice(0, 80)}`);
  return out;
}

(async () => {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('no dist/: run node scripts/build.mjs first');
  await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
  const br = await chromium.launch(); const errors = [];
  const electronPage = async () => {
    const ctx = await br.newContext({ viewport: { width: 1100, height: 800 } }); const p = await ctx.newPage(); p.setDefaultTimeout(30000);
    p.on('pageerror', (e) => errors.push('E: ' + e.message));
    await p.exposeFunction('__krhE', (c, a) => electronCall(c, a));
    await p.addInitScript(ELECTRON_SHIM);
    await p.goto(base); await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.visual', JSON.stringify({ readingMode: 'continuous' })); });
    await p.reload(); await p.waitForSelector('.library-view'); return p;
  };
  const rustPage = async (o = {}) => {
    const ctx = await br.newContext({ viewport: { width: 1100, height: 800 } }); const p = await ctx.newPage(); p.setDefaultTimeout(30000);
    p.on('pageerror', (e) => errors.push('R: ' + e.message));
    await p.exposeFunction('__krhT', (c, a) => rustCall(c, a));
    await p.addInitScript(TAURI_SHIM);
    await p.addInitScript({ content: `window.__KR_BOOT__ = ${JSON.stringify({ os: 'linux', arch: 'x64' })};\n${BRIDGE}\n${HBRIDGE}` + (o.check ? `\nwindow.__KRH_CHECK__ = ${JSON.stringify(o.check)};\n${CHECK_JS}` : '') });
    if (o.lang) await p.addInitScript((l) => { if (!localStorage.getItem('kr.lang')) localStorage.setItem('kr.lang', l); }, o.lang);
    await p.goto(base); await p.waitForSelector('.library-view'); return p;
  };

  // ================= 1. the Electron profile, filled =================
  const A = await electronPage();
  const txt = path.join(TMP, 'Long Text.txt');
  fs.writeFileSync(txt, ['Long Text', ...Array.from({ length: 260 }, (_, i) => `[P${i + 1}] ` + `Words of paragraph ${i + 1}, a line to read on and on. `.repeat(6))].join('\n\n') + '\n');
  const epub = await importFile(A, EPUB_FILE, 'Alice');
  const pdf = await importFile(A, PDF_FILE, 'sample');
  const tb = await importFile(A, txt, 'Long Text');
  // The text book read to its 120th paragraph (the reader saves its place).
  await openBook(A, tb.id);
  await A.evaluate(() => { const sc = document.querySelector('.reader-scroll'); const el = [...document.querySelectorAll('.reader-flow p')].find((x) => x.textContent.startsWith('[P120]')); sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 2; });
  await A.waitForTimeout(1500); const placeA = await topPara(A);
  await A.evaluate(() => { location.hash = '#/'; }); await A.waitForSelector('.library-view'); await A.waitForTimeout(800);
  ok('the text book read to a paragraph', /^P1[12]\d$/.test(placeA), placeA);
  // Notes, highlights, places, a linked book, settings, keys, a font, translations… straight into the stores.
  const LINKED = path.join(TMP, 'outside', 'Linked Book.txt'); fs.mkdirSync(path.dirname(LINKED), { recursive: true }); fs.writeFileSync(LINKED, 'A book that lives in the reader\'s own folder.\n');
  await A.evaluate(async ({ epub, pdf, tb, ICON, LINKED }) => {
    const NOW = 1_700_000_000_000;
    const open = () => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => res(r.result); });
    const d = await open();
    await new Promise((res) => { const tx = d.transaction(['books', 'meta', 'files'], 'readwrite'); const st = tx.objectStore('books');
      const q1 = st.get(epub); q1.onsuccess = () => { const b = q1.result; b.progress = { bookId: epub, block: 14, offset: 0.3, pct: 0.12, chapter: 2, toc: 3 }; b.progressAt = NOW; b.highlights = [{ id: 'h1', text: 'Down the Rabbit-Hole', color: 'rose', note: 'a note', noteAt: NOW, createdAt: NOW, anchor: 'c1', at: 0, before: 'x', after: 'y' }, { id: 'h2', text: 'curiouser', color: 'mint', createdAt: NOW }]; b.bookmarks = [{ id: 'bm1', label: 'Here', locator: { bookId: epub, block: 9, pct: 0.1 }, createdAt: NOW }]; b.tags = ['fav', '★']; b.tagsAt = NOW; b.folderId = 'fA'; b.rating = 5; b.ratingAt = NOW; b.review = 'مراجعة'; b.reviewAt = NOW; b.chapterMarks = { 3: 1 }; b.stats = { ms: 9000, words: 700, sessionAt: NOW, days: { '2026-11-01': { ms: 9000, pct: 0.1, words: 700 } } }; b.prefs = { fontSize: 21 }; b.coverOrig = new Blob(['original cover'], { type: 'image/png' }); st.put(b); };
      const q2 = st.get(pdf); q2.onsuccess = () => { const b = q2.result; b.progress = { bookId: pdf, page: 1, pct: 0.5 }; b.progressAt = NOW; b.pdfHighlights = [{ id: 'ph1', page: 1, rects: [[0.1, 0.1, 0.3, 0.02]], text: 'pdf words', color: 'sky', createdAt: NOW }]; b.pins = [{ id: 'pin1', page: 1, x: 0.5, y: 0.5, note: 'a pin', color: 'amber', createdAt: NOW }]; b.ink = [{ id: 'ink1', page: 1, color: '#f00', w: 0.01, pts: [0.1, 0.1, 0.2, 0.2], createdAt: NOW }]; st.put(b); };
      const q3 = st.get(tb); q3.onsuccess = () => { const b = q3.result; b.highlights = [{ id: 'h3', text: 'paragraph 5', color: 'amber', createdAt: NOW, anchor: undefined }]; st.put(b); };
      st.put({ id: 'linked1', title: 'Linked Book', format: 'txt', fileName: 'Linked Book.txt', size: 47, addedAt: NOW, bookmarks: [], highlights: [{ id: 'hl', text: 'lives', color: 'violet', createdAt: NOW }], source: { path: LINKED }, progress: { bookId: 'linked1', block: 0, pct: 0.5 }, progressAt: NOW });
      const meta = tx.objectStore('meta');
      meta.put([{ id: 'fA', name: 'Shelf', createdAt: 1 }], 'folders'); meta.put([{ name: 'fav', createdAt: 1 }], 'tags');
      meta.put({ cards: { c1: { due: 5 } }, day: 1 }, `anki:${epub}`); meta.put({ k1: 'ترجمة' }, `tr:${epub}`); meta.put({ s1: 'src' }, `trs:${epub}`);
      meta.put([{ id: 'myfont', name: 'My Font', family: 'MyFont', file: 'my.ttf' }], 'fonts'); meta.put({ when: new Date(NOW), bytes: new Uint8Array([1, 2, 3]), pic: new Blob(['peek'], { type: 'image/jpeg' }), $kr: 'a user key' }, 'peek:odd');
      tx.objectStore('files').put(new File(['FONTDATA'], 'my.ttf', { type: 'font/ttf' }), 'font:myfont'); tx.objectStore('files').put(new Blob(['BG'], { type: 'image/png' }), 'bg-image');
      // (A file over two 8 MiB pieces: brought piece by piece, never read whole — its bytes checked at the seams.)
      { const big = new Uint8Array(17 * 1024 * 1024 + 123); for (let i = 0; i < big.length; i++) big[i] = (i * 7 + (i >>> 20)) & 255; tx.objectStore('files').put(new Blob([big], { type: 'application/octet-stream' }), 'big:pieces'); }
      tx.oncomplete = res; });
    d.close();
    const v = JSON.parse(localStorage.getItem('kr.visual') || '{}'); localStorage.setItem('kr.visual', JSON.stringify({ ...v, fontSize: 23, theme: 'sepia', aiKey: 'SECRET-aikey' }));
    localStorage.setItem('kr.bookVisual', JSON.stringify({ [epub]: { fontSize: 19 } })); localStorage.setItem('app.icon', ICON);
    localStorage.setItem('kr.dbx.access', JSON.stringify({ token: 'SECRET-dbx' })); localStorage.setItem('kr.anilist.token', 'SECRET-al');
    localStorage.setItem('kr.glossary', JSON.stringify([{ id: 'g1', from: 'Alice', to: 'أليس' }])); localStorage.setItem('kr.vocab', JSON.stringify([{ w: 'word', at: NOW }]));
    localStorage.setItem('kr.diag', 'diagnostics: not to cross');
    // A local AI model (the origin's private files).
    const root = await navigator.storage.getDirectory(); const dir = await root.getDirectoryHandle('models', { create: true }); const fh = await dir.getFileHandle('tiny.gguf', { create: true }); const w = await fh.createWritable(); await w.write(new Blob(['GGUF' + 'x'.repeat(5000)])); await w.close();
  }, { epub: epub.id, pdf: pdf.id, tb: tb.id, ICON, LINKED });
  fs.writeFileSync(path.join(userData, 'custom-icon.png'), Buffer.from(ICON.split(',')[1], 'base64')); fs.writeFileSync(path.join(userData, 'doh.json'), JSON.stringify({ provider: 'quad9' })); fs.writeFileSync(path.join(userData, 'window-state.json'), JSON.stringify({ x: 10, y: 20, width: 1000, height: 700, maximized: false }));
  await A.reload(); await A.waitForSelector('.library-view'); await A.waitForTimeout(1500);
  const snapA = await snapshot(A);
  ok('the Electron profile: a model in its private files', snapA.opfs.length === 1, snapA.opfs);
  ok('the Electron profile: 4 books (EPUB, PDF, text, one linked)', snapA.books.length === 4 && snapA.books.some((b) => b.source?.path === LINKED), snapA.books.map((b) => b.title));

  // ================= 2. a full disk: refused, nothing written, the reader told =================
  E.free = 10_000;
  const full = await A.evaluate(async () => { const r = await window.__KR_HANDOVER__.beforeInstall(); const s = document.querySelector('[data-handover="failed"]'); return { r, text: s?.textContent ?? '' }; });
  ok('short disk: the installer gets false', full.r === false);
  ok('short disk: the reader told plainly', /Not enough free space/.test(full.text) && /keeps working/.test(full.text), full.text.slice(0, 200));
  ok('short disk: nothing written', !fs.existsSync(path.join(userData, 'handover')) && !fs.existsSync(path.join(userData, 'handover.part')), fs.readdirSync(userData));
  await A.evaluate(() => document.querySelectorAll('.sheet').forEach((s) => s.__close ? s.__close() : s.remove()));
  E.free = undefined;

  // ================= 2b. free space unknown (statfs failed): asked, never gone on silently =================
  const askSpace = async (answer) => {
    E.free = -1;
    await A.evaluate(() => { window.__bi = window.__KR_HANDOVER__.beforeInstall(); });
    const sheet = await A.waitForSelector('[data-handover="ask-space"]', { timeout: 30000 }).catch(() => null);
    const text = sheet ? await sheet.textContent() : '';
    const madeBefore = fs.existsSync(path.join(userData, 'handover.part')) || fs.existsSync(path.join(userData, 'handover'));
    if (sheet) await A.click(`[data-act="${answer}"]`);
    const r = await A.evaluate(() => window.__bi);
    E.free = undefined;
    return { asked: !!sheet, text, madeBefore, r };
  };
  const unk = await askSpace('space-no');
  ok('free space unknown: the reader asked, with the estimate', unk.asked && /could not be read/.test(unk.text) && /needs about/.test(unk.text) && /data folder holds/.test(unk.text), unk.text.slice(0, 260));
  ok('…nothing written before the answer', !unk.madeBefore);
  ok('…«Cancel»: false for the installer, nothing written', unk.r === false && !fs.existsSync(path.join(userData, 'handover')) && !fs.existsSync(path.join(userData, 'handover.part')));
  ok('…the estimate is at least the profile on the disk', E.lastBegin && E.lastBegin.reason === 'unknown' && E.lastBegin.need >= E.lastBegin.profile && E.lastBegin.profile > 0, E.lastBegin);
  await A.evaluate(() => document.querySelectorAll('.sheet').forEach((s) => s.__close ? s.__close() : s.remove()));
  const unk2 = await askSpace('space-go');
  ok('…«Continue»: made after all, true for the installer', unk2.asked && unk2.r === true && !!rj(path.join(userData, 'handover', 'marker.json')), unk2);

  // ================= 3. the hand-over made =================
  const made = await A.evaluate(() => window.__KR_HANDOVER__.make());
  ok('the hand-over made', made.ok, made);
  const hdir = path.join(userData, 'handover'); const marker = rj(path.join(hdir, 'marker.json'));
  ok('its marker: format, id, counts', marker && marker.kind === 'handover' && marker.format === 1 && marker.id === made.id && marker.counts.books === 4 && marker.counts.linked === 1 && marker.counts.copied === 3, marker && { counts: marker.counts, id: marker.id });
  ok('every file listed with its size and SHA-256', marker && marker.files.every((f) => sha(path.join(hdir, ...f.rel.split('/'))) === f.sha256 && fs.statSync(path.join(hdir, ...f.rel.split('/'))).size === f.size), marker && marker.files.length);
  ok('the linked book\'s file not copied (its link is)', marker && !marker.files.some((f) => f.size === 47) && fs.readFileSync(path.join(hdir, 'handover', 'books.jsonl'), 'utf8').includes(JSON.stringify(LINKED).slice(1, -1)));
  ok('the pointer for the Rust build', rj(path.join(tauriData, H.POINTER))?.dir === hdir && rj(path.join(tauriData, H.POINTER))?.id === made.id);
  ok('no part folder left', !fs.existsSync(path.join(userData, 'handover.part')));
  ok('the shell\'s own files in it (icon, window, DNS)', ['shell/custom-icon.png', 'shell/window-state.json', 'shell/doh.json'].every((r) => marker.files.some((f) => f.rel === r)));
  ok('the keys in it (it never leaves this computer), the diagnostics not', (() => { const l = rj(path.join(hdir, 'handover', 'local.json')); return l['kr.dbx.access'] && JSON.parse(l['kr.visual']).aiKey === 'SECRET-aikey' && !('kr.diag' in l); })());
  ok('its kurokawa-backup.json is a backup\'s (no credential)', (() => { const m = rj(path.join(hdir, 'kurokawa-backup.json')); return m.app === 'KurokawaReader' && m.full === true && m.books.length === 4 && !JSON.stringify(m).includes('SECRET'); })());

  // ================= 4. a run broken off: no half folder taken as valid; the older one stands =================
  E.failVerify = true;
  const broken = await A.evaluate(() => window.__KR_HANDOVER__.make());
  E.failVerify = false;
  ok('a run broken off before the marker: an error', !broken.ok && broken.reason === 'error', broken);
  ok('…the hand-over before it untouched', rj(path.join(hdir, 'marker.json'))?.id === made.id && rust.kr_handover_verify({ p: hdir }).ok);
  // (A process killed mid-write: the part folder is there without a marker.)
  const killed = new H.Writer(path.join(TMP, 'killed'), {}); await killed.begin(10); await killed.write('books/0/file', Buffer.from('half a bo'), false);
  ok('…a killed write leaves no hand-over to find', !rust.kr_handover_find({ p: path.join(TMP, 'killed') }).found && fs.existsSync(path.join(TMP, 'killed', 'handover.part')));
  // (A marker whose files do not match: refused, cheaply and by hash.)
  const damaged = path.join(TMP, 'damaged', 'handover'); fs.cpSync(hdir, damaged, { recursive: true });
  const f0 = marker.files.find((f) => f.rel === 'books/0/file'); const fp = path.join(damaged, 'books', '0', 'file'); const buf = fs.readFileSync(fp); buf[100] ^= 0xff; fs.writeFileSync(fp, buf);
  ok('a damaged copy: found by size, refused by hash', rust.kr_handover_find({ p: damaged }).found && !rust.kr_handover_verify({ p: damaged }).ok && f0);
  fs.truncateSync(fp, 10);
  ok('a truncated copy: not even offered', !rust.kr_handover_find({ p: damaged }).found);

  // ================= 5. the Rust build's first start: offered, brought, the same =================
  const R = await rustPage();
  const offer = await R.waitForSelector('[data-handover="offer"]', { timeout: 15000 }).catch(() => null);
  ok('first start: the hand-over offered', !!offer);
  const offerText = offer ? await offer.textContent() : '';
  ok('…with the count and size', /Books: 4/.test(offerText) && /Size:/.test(offerText), offerText.slice(0, 300));
  ok('…and where the old data stays untouched', offerText.includes('untouched') && offerText.includes(hdir));
  await R.click('[data-handover-go]');
  await R.waitForSelector('[data-handover="done"]', { timeout: 60000 }).catch(() => null);
  const doneText = await R.evaluate(() => document.querySelector('[data-handover]')?.textContent ?? '');
  const hlA = snapA.books.reduce((a, b) => a + (b.highlights?.length ?? 0) + (b.pdfHighlights?.length ?? 0) + (b.pins?.length ?? 0), 0);
  ok('…brought: «Done», the counts', new RegExp(`Done\\. Books: 4; highlights and notes: ${hlA}\\.`).test(doneText), doneText.slice(-200));
  ok('…«Free the space» offered', !!(await R.$('[data-handover-free]')));
  {
    const bigRel = (rj(path.join(hdir, 'handover', 'files.json')) || []).find((x) => x.key === 'big:pieces')?.rel;
    const reads = rustCalls.filter((c) => c.cmd === 'kr_handover_read' && c.a.rel === bigRel);
    ok('a 17 MiB file brought in 8 MiB pieces, never read whole', !!bigRel && reads.length === 3 && reads.every((c) => c.a.at !== undefined && c.a.len <= 8 * 1024 * 1024) && reads.map((c) => c.a.at).join() === `0,${8 << 20},${16 << 20}`, reads.map((c) => c.a));
    const seams = await R.evaluate(async () => {
      const d = await new Promise((res) => { const q = indexedDB.open('kurokawa-reader'); q.onsuccess = () => res(q.result); });
      const b = await new Promise((res) => { const q = d.transaction('files').objectStore('files').get('big:pieces'); q.onsuccess = () => res(q.result); }); d.close();
      const at = [0, (8 << 20) - 1, 8 << 20, (16 << 20) + 5, b.size - 1]; const out = [];
      for (const i of at) out.push(new Uint8Array(await b.slice(i, i + 1).arrayBuffer())[0] === ((i * 7 + (i >>> 20)) & 255));
      return { size: b.size, ok: out.every(Boolean) };
    });
    ok('…its bytes right at the seams', seams.size === 17 * 1024 * 1024 + 123 && seams.ok, seams);
  }
  await Promise.all([R.waitForNavigation({ timeout: 15000 }).catch(() => null), R.click('[data-handover-continue]')]);
  await R.waitForSelector('.library-view'); await R.waitForTimeout(1500);
  const snapR = await snapshot(R);
  const diff = compare(snapA, snapR);
  ok('every store and key the same (deep)', diff.length === 0, diff.slice(0, 12));
  ok('the icon put on the window', shellState.icon === ICON);
  ok('the DNS choice carried', shellState.doh === 'quad9');
  ok('marked restored', rj(stateFile())?.state === 'restored' && rj(stateFile())?.id === made.id);
  await openBook(R, tb.id); const placeR = await topPara(R);
  ok('the text book opens at the same paragraph', placeR === placeA, { electron: placeA, rust: placeR });
  // Second start: not offered, not restored again.
  const before = (await snapshot(R)).books.length; rustCalls.length = 0;
  await R.evaluate(() => { location.hash = '#/'; }); await R.reload(); await R.waitForSelector('.library-view'); await R.waitForTimeout(3000);
  ok('second start: not offered again', !(await R.$('[data-handover="offer"]')));
  ok('…nothing read from it again', !rustCalls.some((c) => c.cmd === 'kr_handover_read' || c.cmd === 'kr_handover_verify') && (await snapshot(R)).books.length === before, rustCalls.map((c) => c.cmd));
  // Settings: the rows (and only on this computer's app), «Free the space» deletes only the copy.
  await R.evaluate(() => { location.hash = '#/settings'; }); await R.waitForSelector('.settings-body'); await R.waitForTimeout(800);
  const rows = await R.evaluate(() => [...document.querySelectorAll('.handover-rows button')].map((b) => b.textContent));
  ok('Settings: bring, from a folder, from a file, free', rows.length === 4 && /previous version/.test(rows[0]), rows);
  await R.evaluate(() => [...document.querySelectorAll('.handover-rows button')].pop().click());
  await R.click('[data-handover-free-yes]'); await R.waitForTimeout(500);
  ok('«Free the space»: the copy deleted', !fs.existsSync(hdir));
  ok('…Electron\'s own data left (its icon, window, DNS files)', ['custom-icon.png', 'window-state.json', 'doh.json'].every((n) => fs.existsSync(path.join(userData, n))));
  ok('…the library here kept', (await snapshot(R)).books.length === 4);

  // ================= 6. a library that already has books: the missing ones added, notes merged =================
  const made2 = await A.evaluate(() => window.__KR_HANDOVER__.make());
  ok('a new hand-over made', made2.ok, made2);
  const M = await rustPage();
  const m0 = await importFile(M, PDF_FILE, 'sample');
  await M.evaluate(async (id) => { const d = await new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => res(r.result); }); await new Promise((res) => { const tx = d.transaction('books', 'readwrite'); const st = tx.objectStore('books'); const q = st.get(id); q.onsuccess = () => { const b = q.result; b.pdfHighlights = [{ id: 'mine', page: 1, rects: [[0, 0, 0.1, 0.1]], text: 'mine', color: 'rose', createdAt: 1 }]; st.put(b); }; tx.oncomplete = res; }); d.close(); }, m0.id);
  await M.reload(); await M.waitForSelector('.library-view'); await M.waitForTimeout(2500);
  ok('a library with books: not offered at the start', !(await M.$('[data-handover="offer"]')));
  await M.evaluate(() => { location.hash = '#/settings'; }); await M.waitForSelector('.handover-rows', { state: 'attached' }); await M.evaluate(() => document.querySelector('.handover-rows button').click());
  await M.waitForSelector('[data-handover="offer"]'); await M.click('[data-handover-go]'); await M.waitForSelector('[data-handover="done"]', { timeout: 60000 }).catch(() => null);
  const mb = await allBooks(M);
  const mpdf = mb.find((b) => b.id === m0.id);
  ok('merged: the 3 missing books added, the one it had kept', mb.length === 4 && mb.filter((b) => b.id === m0.id).length === 1, mb.map((b) => b.title));
  ok('merged: its notes and the hand-over\'s both there', mpdf && mpdf.pdfHighlights.some((h) => h.id === 'mine') && mpdf.pdfHighlights.some((h) => h.id === 'ph1') && mpdf.pins?.some((x) => x.id === 'pin1'), mpdf?.pdfHighlights);
  ok('merged: a book added keeps its folder (by name)', await M.evaluate(async (eid) => { const d = await new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => res(r.result); }); const get = (s, k) => new Promise((res) => { const q = d.transaction(s).objectStore(s).get(k); q.onsuccess = () => res(q.result); }); const b = await get('books', eid); const f = await get('meta', 'folders'); return !!b && (f || []).some((x) => x.id === b.folderId && x.name === 'Shelf'); }, epub.id));

  // ================= 7. a picked folder; «Not now» at the start =================
  ok('merged: marked restored (the next start does not offer it)', rj(stateFile())?.state === 'restored' && rj(stateFile())?.id === made2.id);
  fs.rmSync(stateFile());   // (another computer, so to speak: not yet brought there)
  const N = await rustPage();
  await N.waitForSelector('[data-handover="offer"]', { timeout: 15000 });
  await N.evaluate(() => [...document.querySelectorAll('[data-handover="offer"] .sheet-actions button')][0].click()); await N.waitForTimeout(400);
  ok('«Not now»: marked declined, not asked at the start again', rj(stateFile())?.state === 'declined');
  await N.reload(); await N.waitForSelector('.library-view'); await N.waitForTimeout(2500);
  ok('…the next start does not ask', !(await N.$('[data-handover="offer"]')));
  fs.rmSync(path.join(tauriData, H.POINTER)); fs.rmSync(stateFile());
  await N.evaluate((d) => { window.__pick = d; location.hash = '#/settings'; }, userData); await N.waitForSelector('.handover-rows', { state: 'attached' });
  await N.evaluate(() => document.querySelectorAll('.handover-rows button')[1].click());
  ok('«From the previous version\'s folder»: Electron\'s data folder picked → its hand-over offered', !!(await N.waitForSelector('[data-handover="offer"]', { timeout: 10000 }).catch(() => null)));

  // ================= 8. CI's own check (desktop-tauri/handovercheck.js) run here, on a fresh profile =================
  fs.rmSync(path.join(tauriData, 'handover-state.json'), { force: true });
  await rustPage({ check: { expect: snapA, os: 'linux' } });
  for (let i = 0; i < 240 && !checkRun.done; i++) await new Promise((r) => setTimeout(r, 500));
  const cr = checkRun.done || checkRun.progress || [];
  const bad = cr.filter((r) => !r.ok && r.required !== false);
  ok('CI\'s check script: it ran to its verdict', !!checkRun.done, (checkRun.progress || []).slice(-3));
  ok('CI\'s check script: every required check passed', cr.length > 15 && bad.length === 0, bad.length ? bad : cr.length + ' checks');
  if (process.env.KRH_SHOW) for (const r of cr) console.log('     ' + (r.ok ? 'ok ' : 'no ') + r.name + ' — ' + r.detail);
  for (const r of cr.filter((r) => !r.ok)) console.log('     (check: ' + r.name + ' — ' + r.detail + (r.required === false ? ', not required)' : ')'));

  // ================= 9. backups across the builds and the phones =================
  await br.close(); server.close();
  // (The backups' own module checks run with the bundled modules: tests/backupsafe.cjs, and below.)
  const bc = await backupCross();
  for (const [n, c, x] of bc) ok(n, c, x);
  const pageErrors = errors.filter((e) => !/ResizeObserver|Failed to fetch|NetworkError|net::/.test(e));
  ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 5));
  console.log(fails ? `\nhandover: ${fails} FAILED` : '\nhandover: all ok');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

// Backups across the shells: the backup module bundled into blank pages shaped as a phone (Capacitor, Android) and as
// the computer's Rust build (its bridge marks it): one made on each restores on the other; the computer's icon is
// not put on the phone; a backup of a newer version (fields this app does not know) is read.
async function backupCross() {
  const esbuild = require('esbuild'); const out = [];
  const entry = path.join(TMP, 'entry.ts');
  fs.writeFileSync(entry, `import * as db from ${JSON.stringify(path.join(ROOT, 'src', 'db'))}; import * as B from ${JSON.stringify(path.join(ROOT, 'src', 'backup'))};\n(window as any).T = { db, B };\n`);
  const code = esbuild.buildSync({ entryPoints: [entry], bundle: true, format: 'iife', write: false, platform: 'browser', logLevel: 'error', define: { 'import.meta.url': '"http://127.0.0.1/"' } }).outputFiles[0].text;
  const srv = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta charset="utf-8"><body>'); }); await new Promise((r) => srv.listen(0, r));
  const br = await chromium.launch();
  const page = async (shape) => {
    const ctx = await br.newContext(); const p = await ctx.newPage();
    await p.goto(`http://127.0.0.1:${srv.address().port}/`);
    await p.evaluate((shape) => {
      localStorage.setItem('kr.lang', 'en');
      window.__setIcon = [];
      if (shape === 'phone') window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {} };
      if (shape === 'rust') { window.kurokawaDesktop = { platform: 'linux', appIcon: async (o) => { window.__setIcon.push(o); return true; }, onOpenFile() {} }; window.__KR_SHELL__ = 'tauri'; }
      navigator.canShare = () => true; navigator.share = async ({ files }) => { window.__shared = files[0]; };
    }, shape);
    await p.addScriptTag({ content: code }); await p.waitForFunction(() => !!window.T);
    return p;
  };
  const seed = (p, id, extra) => p.evaluate(async ([id, extra]) => { await T.db.db.putBook({ id, title: 'Book ' + id, format: 'txt', fileName: id + '.txt', size: 5, addedAt: 1, bookmarks: [], highlights: [{ id: 'h-' + id, text: 'x', color: 'rose', createdAt: 1 }], progress: { bookId: id, block: 3, pct: 0.3 }, progressAt: 5, ...extra }); await T.db.db.putFile(id, new File(['hello'], id + '.txt')); }, [id, extra]);
  const full = async (p) => { await p.evaluate(() => { window.__shared = null; return T.B.backupFull(); }); return p.evaluate(async () => { const f = window.__shared; return { name: f.name, b64: btoa(String.fromCharCode(...new Uint8Array(await f.arrayBuffer()))) }; }); };
  const restore = (p, f) => p.evaluate(async (f) => { const bin = atob(f.b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); const n = await T.B.restoreBackup(new File([u], f.name, { type: 'application/zip' })); const all = await T.db.db.allBooks(); return { n, books: all.map((b) => ({ fileName: b.fileName, hl: b.highlights.map((h) => h.id), block: b.progress?.block })), icon: window.__setIcon, brand: localStorage.getItem('app.icon') }; }, f);
  const phone = await page('phone'); const pc = await page('rust');
  await seed(phone, 'ph'); await seed(pc, 'pc');
  await pc.evaluate((ICON) => localStorage.setItem('app.icon', ICON), ICON);
  const fromPhone = await full(phone); const fromPc = await full(pc);
  const onPc = await restore(pc, fromPhone);
  out.push(['backups: a phone\'s full backup restores on the computer (book, highlight, place)', onPc.n === 1 && onPc.books.some((b) => b.fileName === 'ph.txt' && b.hl.includes('h-ph') && b.block === 3), onPc]);
  const onPhone = await restore(phone, fromPc);
  out.push(['backups: the computer\'s full backup restores on a phone', onPhone.n === 1 && onPhone.books.some((b) => b.fileName === 'pc.txt' && b.hl.includes('h-pc') && b.block === 3), onPhone]);
  out.push(['backups: the computer\'s icon not put on a phone (PC-only)', onPhone.icon.length === 0 && onPhone.brand === null, { icon: onPhone.icon.length, brand: onPhone.brand && onPhone.brand.length }]);
  const pc2 = await page('rust'); const onPc2 = await restore(pc2, fromPc);
  out.push(['backups: the computer\'s icon back on another computer\'s app', onPc2.icon.length === 1 && onPc2.icon[0].set === ICON, onPc2.icon.length]);
  // A backup from a newer app: a version above this one's, fields it does not know — read, what it shares restored.
  const newer = await pc2.evaluate(async () => {
    const m = { app: 'KurokawaReader', version: 99, createdAt: 1, full: false, settings: { fontSize: 31, aNewSetting: { deep: 1 } }, local: {}, folders: [], fonts: [], books: [{ key: 'pc.txt:5', id: 'zz', title: 'Book pc', fileName: 'pc.txt', size: 5, format: 'txt', addedAt: 1, bookmarks: [], highlights: [{ id: 'from-newer', text: 'y', color: 'mint', createdAt: 2 }], aNewField: [1, 2] }], aNewPart: { x: 1 } };
    const n = await T.B.restoreBackup(new File([JSON.stringify(m)], 'b.json', { type: 'application/json' }));
    const b = (await T.db.db.allBooks()).find((x) => x.fileName === 'pc.txt');
    let refused = ''; try { await T.B.restoreBackup(new File(['{"app":"Other","books":[]}'], 'x.json', { type: 'application/json' })); } catch (e) { refused = e.message; }
    return { n, hl: b?.highlights.map((h) => h.id), font: JSON.parse(localStorage.getItem('kr.visual') || '{}').fontSize, refused, v: T.B.readManifest(JSON.stringify({ app: 'KurokawaReader', books: [] })).version };
  });
  out.push(['backups: a newer version\'s backup read (unknown fields passed by)', newer.n === 1 && newer.hl.includes('from-newer') && newer.font === 31, newer]);
  out.push(['backups: a file that is not one refused; one without a version read as version 1', /not a KurokawaReader backup/.test(newer.refused) && newer.v === 1, newer]);
  await br.close(); srv.close();
  return out;
}
