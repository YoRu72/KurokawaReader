// (A helper, not a test of its own.) A pretend phone for the Files tests (tests/filesclip.cjs, tests/filesback.cjs): the plugin's files methods answered
// from an in-memory tree that copy / move / delete jobs really change — names taken asked about (and «apply to all»),
// «keep both» numbered «name (2)», a folder into itself refused, an unreadable file failing while the others go on,
// Cancel mid-way — and a real zip, built here with dated entries, nested folders, a long name, an Arabic name and
// names with brackets, listed by the desktop's own zip reader (desktop/archive.cjs) and «extracted» into the tree.
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const zlib = require('node:zlib'); const http = require('node:http');

const K = '/storage/emulated/0/Download/Kurokawa', P = '/storage/emulated/0', SD = '/storage/1234-5678';
const ZIP = 'HOREMAJO_03_KARAOKE_OP_ED (1).ZIP';
const LONG = '[ReDEJA] Horemajo - 03 (1080p) [B6A1C0D2] Karaoke Signs Final Version.ass';
const ARABIC = 'أغنية النهاية (كاريوكي).ass';
const WHEN = new Date(2025, 2, 9, 14, 30, 20).getTime();

/** A zip of stored entries (folders included), each dated `WHEN` plus its index in minutes. */
function buildZip(file) {
  const items = [['Fonts/', null], ['Fonts/Arial (Bold).ttf', 'font-a'], ['Fonts/sub/', null], ['Fonts/sub/Noto.otf', 'font-b'], [LONG, 'long'], ['Horemajo_03_ED_Karaoke (Arabic Version Final).ass', 'ed'], [ARABIC, 'ar'], ['notes.txt', 'hello'], ['Horemajo_03_OP_Karaoke.ass', 'op']];
  const locals = []; const central = []; let off = 0;
  items.forEach(([name, text], i) => {
    const data = Buffer.from(text ?? '', 'utf8'); const nb = Buffer.from(name, 'utf8'); const d = new Date(WHEN + i * 60000);
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1); const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const crc = zlib.crc32(data) >>> 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(0, 8); lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(0, 10); ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, data); central.push(ch, nb); off += 30 + nb.length + data.length;
  });
  const cd = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(items.length, 8); end.writeUInt16LE(items.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, cd, end]));
}
/** The zip's listing as the app gets it — read by the desktop app's zip reader, the dates included. */
async function zipListing() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-fzip-')); const f = path.join(dir, ZIP); buildZip(f);
  const info = await require(path.join(__dirname, '..', 'desktop', 'archive.cjs')).list(f); fs.rmSync(dir, { recursive: true, force: true }); return info;
}

const DIST = path.join(__dirname, '..', 'dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = () => new Promise((res) => { const s = http.createServer((req, r) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); r.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(r); }); s.listen(0, () => res(s)); });

/** The in-page pretend phone (runs in the browser). `z`: the zip's listing; `lang`: the page's language. */
function phone({ z, lang, K, P, SD, ZIP, many }) {
  localStorage.setItem('kr.lang', lang);
  localStorage.setItem('kt.settings', JSON.stringify({ addons: ['files', 'archives'] }));
  localStorage.setItem('kt.files.prefs', JSON.stringify({ view: 'list', sort: 'name', desc: false, hidden: false, kind: 'all', last: K }));
  const T = 1760000000000; const tree = new Map(); window.__tree = tree; window.__calls = []; window.__slow = 0; window.__failName = 'broken.bin';
  const put = (p, dir, size = 0, mtime = T) => { tree.set(p, { dir, size, mtime }); };
  const parent = (p) => p.replace(/\/[^/]*$/, '');
  const base = (p) => p.split('/').pop();
  for (const d of [P, K, `${K}/Sub`, `${K}/Sub/Deeper`, `${K}/Many`, SD, `${P}/ReadOnly`, `${P}/Music`]) put(d, true);
  put(`${K}/${ZIP}`, false, 1234567); put(`${K}/Song.mp3`, false, 5e6); put(`${K}/photo.jpg`, false, 25e5); put(`${K}/broken.bin`, false, 300); put(`${K}/Sub/in.txt`, false, 10); put(`${K}/Sub/Deeper/deep.txt`, false, 10);
  put(`${K}/undated.bin`, false, 2048, 0);
  if (many > 20) put(`${K}/Many/Inner`, true);
  for (let i = 0; i < (many || 0); i++) put(`${K}/Many/file ${String(i).padStart(3, '0')}.txt`, false, 100 + i);
  const kids = (dir) => [...tree.keys()].filter((k) => parent(k) === dir && k !== dir);
  const entry = (p) => { const n = tree.get(p); const name = base(p); return { name, path: p, dir: n.dir, size: n.size, mtime: n.mtime, ext: n.dir ? undefined : (name.includes('.') ? name.split('.').pop().toLowerCase() : ''), count: n.dir ? kids(p).length : undefined }; };
  const keepBoth = (to, dir) => { const n = base(to); const m = dir ? null : /^(.*)(\.[^.]{1,7})$/.exec(n); const stem = m && m[1] ? m[1] : n, ext = m && m[1] ? m[2] : ''; for (let i = 2; ; i++) { const c = `${parent(to)}/${stem} (${i})${ext}`; if (!tree.has(c)) return c; } };
  const subtree = (p) => [...tree.keys()].filter((k) => k === p || k.startsWith(p + '/'));
  const copyTree = (from, to) => { for (const k of subtree(from)) { const n = tree.get(k); tree.set(to + k.slice(from.length), { ...n }); } };
  const removeTree = (p) => { for (const k of subtree(p)) tree.delete(k); };
  const ls = {}; const emit = (ev, o) => (ls[ev] || []).forEach((f) => f(o));
  const jobs = new Map(); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const runJob = async ({ id, op, paths, dest, conflict }) => {
    const j = { cancel: false, standing: conflict && conflict !== 'ask' ? conflict : null, answer: null, wake: null }; jobs.set(id, j);
    const failed = []; let files = 0, skipped = 0, left = 0; const remaining = []; const total = paths.length;
    await sleep(20);
    for (const p of paths) {
      if (j.cancel) { if (op === 'move' && tree.has(p)) { left++; remaining.push(p); } continue; }
      if (window.__slow) await sleep(window.__slow);
      if (j.cancel) { if (op === 'move' && tree.has(p)) { left++; remaining.push(p); } continue; }
      if (!tree.has(p)) { failed.push(`${base(p)}: not found`); continue; }
      if (op === 'delete') { removeTree(p); files++; continue; }
      const n = tree.get(p);
      if (n.dir && (dest === p || dest.startsWith(p + '/'))) { failed.push(`${base(p)}: into itself`); if (op === 'move') { left++; remaining.push(p); } continue; }
      if (base(p) === window.__failName) { failed.push(`${base(p)}: read error`); if (op === 'move') { left++; remaining.push(p); } continue; }
      let to = `${dest}/${base(p)}`;
      if (to === p) { if (op === 'move') continue; to = keepBoth(to, n.dir); }
      if (tree.has(to)) {
        let a = j.standing;
        if (!a) { const ex = tree.get(to); emit('files', { id, status: 'conflict', from: p, to, size: n.size, existingSize: ex.size, mtime: n.mtime, existingMtime: ex.mtime, dir: n.dir }); a = await new Promise((r) => { j.wake = r; }); }
        if (j.cancel) { if (op === 'move') { left++; remaining.push(p); } continue; }
        if (a === 'skip') { skipped++; files++; if (op === 'move') { left++; remaining.push(p); } continue; }
        if (a === 'keep') to = keepBoth(to, n.dir); else removeTree(to);
      }
      copyTree(p, to); if (op === 'move') removeTree(p); files++;
      emit('files', { id, status: 'progress', done: files, total, files, ofFiles: total, name: base(p) });
    }
    jobs.delete(id);
    emit('files', { id, status: j.cancel ? 'cancelled' : 'done', done: files, total, files, failed, skipped, ...(op === 'move' ? { left, remaining } : {}) });
  };
  // the archive: the zip's real listing; an extraction writes its chosen entries into the tree (slowly when asked)
  const arcJobs = new Map();
  const Kurokawa = new Proxy({
    addListener: async (ev, fn) => { (ls[ev] = ls[ev] || []).push(fn); return { remove() { ls[ev] = (ls[ev] || []).filter((f) => f !== fn); } }; },
    filesRoots: async () => ({ allFiles: true, roots: [{ kind: 'app', path: K, name: 'Kurokawa', readable: true, free: 12e9, total: 64e9 }, { kind: 'phone', path: P, name: 'Phone', readable: true, free: 12e9, total: 64e9 }, { kind: 'sd', path: SD, name: 'SD card', readable: true, free: 3e10, total: 6.4e10 }] }),
    filesList: async ({ path: d }) => { if (!tree.has(d)) return { exists: false, entries: [] }; return { exists: true, entries: kids(d).map(entry).filter((e) => !e.name.startsWith('.') || JSON.parse(localStorage.getItem('kt.files.prefs') || '{}').hidden) }; },
    filesStat: async ({ path: p, shallow }) => { window.__calls.push('stat:' + (shallow ? 'shallow:' : '') + p); const n = tree.get(p) || { dir: true, size: 0, mtime: T }; return { name: base(p), path: p, exists: tree.has(p), dir: n.dir, size: n.size, mtime: n.mtime, readable: true, writable: !p.startsWith(`${P}/ReadOnly`) }; },
    filesThumb: async () => ({ url: null }), filesAccess: async () => ({ all: true }), filesCollection: async () => ({ entries: [] }),
    filesMkdir: async ({ path: p }) => { put(p, true); return { ok: true, path: p }; },
    filesRename: async ({ path: p, name }) => { const to = `${parent(p)}/${name}`; copyTree(p, to); removeTree(p); return { ok: true, path: to }; },
    filesJob: async (o) => { window.__calls.push(`${o.op}:${o.paths.map(base).join('|')}>${o.dest ?? ''}`); void runJob(o); return { id: o.id }; },
    filesAnswer: async ({ id, answer }) => { window.__calls.push('answer:' + answer); const j = jobs.get(id); if (!j) return; if (answer.endsWith('All')) j.standing = answer.slice(0, -3); const w = j.wake; j.wake = null; w && w(answer.replace('All', '')); },
    filesCancel: async ({ id }) => { window.__calls.push('cancel'); const j = jobs.get(id); if (!j) return; j.cancel = true; const w = j.wake; j.wake = null; w && w('skip'); },
    archiveList: async ({ path: p }) => { window.__calls.push('arcList:' + base(p)); if (!tree.has(p)) throw new Error('not found'); return z; },
    archiveEntryUrl: async () => ({ url: null }), archiveThumb: async () => ({ url: null }),
    archiveExtract: async ({ id, path: arc, dest, only, replace }) => {
      window.__calls.push(`arcExtract:${(only || []).join('|')}>${dest}:${replace}`); const job = { stop: false }; arcJobs.set(id, job);
      const want = (n) => !only || only.some((w) => n === w || (w.endsWith('/') && n.startsWith(w)));
      const chosen = z.entries.filter((e) => want(e.path)); const total = chosen.reduce((a, e) => a + Math.max(0, e.size), 0); let done = 0;
      if (dest !== 'cache:') put(dest, true);
      for (const e of chosen) {
        if (window.__slowArc) await new Promise((r) => setTimeout(r, window.__slowArc));
        if (job.stop) throw new Error('stopped');
        const to = `${dest === 'cache:' ? '/cache/archive-view' : dest}/${e.path.replace(/\/$/, '')}`; const parts = to.split('/'); for (let i = 2; i < parts.length; i++) { const d = parts.slice(0, i).join('/'); if (!tree.has(d)) put(d, true); }
        put(to, e.dir, e.size, e.mtime || T); done += Math.max(0, e.size); emit('archiveProgress', { id, done, total, file: e.path });
      }
      return { files: chosen.length, dest: dest === 'cache:' ? '/cache/archive-view' : dest };
    },
    archiveCancel: async ({ id }) => { const j = arcJobs.get(id); if (j) j.stop = true; },
    pickDir: async () => ({ dir: window.__pickDir || SD }),
    openChooser: async ({ path: p }) => { window.__calls.push('open:' + base(p)); }, openWith: async ({ path: p }) => { window.__calls.push('openWith:' + base(p)); }, shareFile: async ({ path: p }) => { window.__calls.push('share:' + base(p)); },
    filesTrash: async ({ paths }) => ({ moved: paths, failed: [] }),
  }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
  const App = { addListener: (ev, fn) => { if (ev === 'backButton') window.__back = fn; return Promise.resolve({ remove() {} }); }, minimizeApp: () => { window.__min = (window.__min || 0) + 1; }, exitApp: async () => { window.__exit = true; } };
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: Kurokawa, Filesystem: {}, App }, PluginHeaders: [] };
}

/** A browser page on the pretend phone: `phoneLayout` 412×915, else a computer's 1280×800; pictures at twice the pixels. */
async function open(browser, { lang = 'en', pc = false, z, many = 0 }) {
  const page = await browser.newPage({ viewport: pc ? { width: 1280, height: 800 } : { width: 412, height: 915 }, deviceScaleFactor: 2, hasTouch: !pc, isMobile: false });
  const errors = []; page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|blocked by CORS policy/.test(m.text())) errors.push(m.text()); });
  await page.route(/api\.github\.com/, (r) => r.fulfill({ json: [], headers: { 'access-control-allow-origin': '*' } }));
  await page.addInitScript(phone, { z, lang, K, P, SD, ZIP, many });
  return { page, errors };
}
module.exports = { K, P, SD, ZIP, LONG, ARABIC, WHEN, zipListing, serve, open, buildZip };
