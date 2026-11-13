// The hand-over (stage R6a of docs/RUST-PORT-READER.md): the last Electron build — the bridge build — writes the
// user's whole library and settings, as the page reads them out of its own storage, into a folder of the app's data
// folder, before it installs the Rust (Tauri) build; that build finds the folder on its first start and brings
// everything back into its own web view (desktop-tauri: src-tauri/src/handover.rs, handover-bridge.js; the page's
// side: src/handover.ts). Nothing of the old profile is touched, here or there.
//
// The folder, <userData>/handover/ (see desktop-tauri/PORTING.md «The hand-over»):
//   kurokawa-backup.json, books/…, fonts/…  the full backup's manifest and files (src/backup.ts), folder form
//   handover/*.jsonl, *.json             the page's stores copied whole (src/handover.ts)
//   shell/…                              this shell's own files: the custom icon, window state, DNS choice
//   marker.json                          written last: every file with its size and SHA-256 — no marker, no hand-over
// It is written into <userData>/handover.part/ — each file hashed as it arrives, then read back from the disk and
// hashed again, flushed to the disk, the marker written (temp file, flush, rename), and only then the folder renamed
// to handover/ (a hand-over made before is replaced only then). A run broken off at any point leaves no folder that
// is taken for a hand-over. A pointer to it is written where the Rust build looks first (its own data folder) and,
// for the portable .exe, beside the program.
//
// The writing half (Writer) needs no Electron: tests/handover.cjs drives it from Node; install() wires it to the
// page (preload.cjs: window.kurokawaHandover); prepare() is the switch's gate (main.cjs rustSwitch).
const fs = require('node:fs'); const fsp = fs.promises; const path = require('node:path'); const crypto = require('node:crypto'); const os = require('node:os');

const FORMAT = 1;
const DIR = 'handover'; const PART = 'handover.part'; const MARKER = 'marker.json';
/** The pointer the Rust build reads in its own data folder (desktop-tauri/src-tauri/src/handoverlogic.rs POINTER). */
const POINTER = 'handover-from.json';
/** The pointer beside the portable .exe (handoverlogic.rs PORTABLE_POINTER). */
const PORTABLE_POINTER = 'KurokawaReader-handover.json';
/** tauri.conf.json's identifier: the Rust build's data folder is named after it. */
const IDENTIFIER = 'app.kurokawa.reader';
/** Room kept free beyond the hand-over itself (the system and the install need some). */
const MARGIN = 256 * 1024 * 1024;

/** A path inside the hand-over: plain names joined by «/», nothing that climbs out. */
function safeRel(rel) {
  return typeof rel === 'string' && rel.length > 0 && rel.length < 300 && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(rel) && !rel.split('/').some((s) => s === '.' || s === '..');
}
/** The Rust build's data folder (Tauri's app_data_dir: the system's data folder + the identifier). */
function tauriDataDir(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') return env.APPDATA ? path.join(env.APPDATA, IDENTIFIER) : null;
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', IDENTIFIER);
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), IDENTIFIER);
}
/** Free bytes on the disk that holds `dir` (-1: not known). */
function freeBytes(dir) {
  try { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return -1; }
}
/** Bytes in the files under `dir` (folders named in `skip` left out, links not followed) — the profile's size, for
 *  an estimate when the free space cannot be read. */
async function dirSize(dir, skip = []) {
  let n = 0; const stack = [dir];
  while (stack.length) {
    const d = stack.pop(); let list = [];
    try { list = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of list) {
      const q = path.join(d, e.name);
      if (e.isDirectory()) { if (!(d === dir && skip.includes(e.name))) stack.push(q); }
      else if (e.isFile()) { try { n += (await fsp.stat(q)).size; } catch { /* gone meanwhile */ } }
    }
  }
  return n;
}
async function flush(p) {
  // ('r+': Windows flushes only a file opened for writing.)
  const fh = await fsp.open(p, 'r+'); try { await fh.sync(); } finally { await fh.close(); }
}
async function flushDir(d) {
  if (process.platform === 'win32') return;   // (a folder cannot be opened there; NTFS keeps its renames in its journal)
  try { const fh = await fsp.open(d, 'r'); try { await fh.sync(); } finally { await fh.close(); } } catch { /* not every system allows it */ }
}
async function writeAtomic(p, text) {
  const tmp = `${p}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, text); await flush(tmp); await fsp.rename(tmp, p); await flushDir(path.dirname(p));
}
function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256'); const s = fs.createReadStream(p, { highWaterMark: 1 << 20 });
    s.on('data', (c) => h.update(c)); s.on('error', reject); s.on('end', () => resolve(h.digest('hex')));
  });
}
const asBuffer = (data) => (Buffer.isBuffer(data) ? data : data instanceof ArrayBuffer ? Buffer.from(data) : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(String(data ?? ''), 'utf8'));

/** One hand-over being written into <root>/handover.part/. */
class Writer {
  /** o.free: the free space to assume (tests); o.pointers: [{ dir, name }] where pointers to the result go. */
  constructor(root, o = {}) {
    this.root = root; this.part = path.join(root, PART); this.final = path.join(root, DIR);
    this.free = o.free; this.pointers = o.pointers || []; this.from = o.from || {};
    this.files = new Map();   // rel → { hash, size }
    this.checked = null;      // after verify: [{ rel, size, sha256 }]
  }
  /** A clean part folder, when the disk has room for `need` bytes (and the margin): { ok, part, free, need } or
   *  { ok: false, reason: 'space', free, need }. When the free space cannot be read (statfs failed: free -1) nothing
   *  is begun silently: { ok: false, reason: 'unknown', need, profile } — `need` the larger of the page's figure and
   *  the profile's size on the disk (+ the margin) — and the page asks the reader; o.unknownOk (they said go on)
   *  begins it. */
  async begin(need, o = {}) {
    let want = Math.ceil(Math.max(0, Number(need) || 0) * 1.02) + MARGIN;
    await fsp.mkdir(this.root, { recursive: true });
    const free = Number.isFinite(this.free) ? this.free : freeBytes(this.root);
    if (free >= 0 && free < want) return { ok: false, reason: 'space', free, need: want };
    if (free < 0 && !(o && o.unknownOk)) {
      const profile = await dirSize(this.root, [DIR, PART]);
      want = Math.max(want, Math.ceil(profile * 1.02) + MARGIN);
      return { ok: false, reason: 'unknown', free: -1, need: want, profile };
    }
    await fsp.rm(this.part, { recursive: true, force: true });
    await fsp.mkdir(this.part, { recursive: true });
    this.files.clear(); this.checked = null;
    return { ok: true, part: this.part, free, need: want };
  }
  /** Bytes written to a file of the part folder (append: added at its end), hashed as they come → { size }. */
  async write(rel, data, append) {
    if (!safeRel(rel)) throw new Error(`not a path in the hand-over: ${rel}`);
    const p = path.join(this.part, ...rel.split('/')); const buf = asBuffer(data);
    let f = this.files.get(rel);
    if (!append || !f) { f = { hash: crypto.createHash('sha256'), size: 0 }; this.files.set(rel, f); await fsp.mkdir(path.dirname(p), { recursive: true }); await fsp.writeFile(p, buf); }
    else await fsp.appendFile(p, buf);
    f.hash.update(buf); f.size += buf.length; this.checked = null;
    return { size: f.size };
  }
  /** A file of the part folder read back (the page checks what it wrote). */
  async read(rel) {
    if (!safeRel(rel)) throw new Error(`not a path in the hand-over: ${rel}`);
    const b = await fsp.readFile(path.join(this.part, ...rel.split('/')));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
  /** This shell's own files copied in (they cross like the rest): the custom icon, the window's state, the DNS choice
   *  → [{ rel, size }]. */
  async shellFiles(userData) {
    const out = [];
    for (const [name, rel] of [['custom-icon.png', 'shell/custom-icon.png'], ['window-state.json', 'shell/window-state.json'], ['doh.json', 'shell/doh.json']]) {
      let b; try { b = await fsp.readFile(path.join(userData, name)); } catch { continue; }
      await this.write(rel, b, false); out.push({ rel, size: b.length });
    }
    return out;
  }
  /** Every file the page lists read back from the disk: its size and SHA-256 the same as when it was written, nothing
   *  missing, nothing unlisted; each flushed to the disk → { ok, files, bytes } or { ok: false, bad: [why…] }. */
  async verify(list) {
    const bad = []; const listed = new Map();
    for (const x of Array.isArray(list) ? list : []) { if (x && safeRel(x.rel)) listed.set(x.rel, Number(x.size)); else bad.push(`bad entry ${JSON.stringify(x)}`); }
    for (const rel of this.files.keys()) if (!listed.has(rel)) bad.push(`${rel}: written but not listed`);
    const out = [];
    for (const [rel, size] of listed) {
      const f = this.files.get(rel); if (!f) { bad.push(`${rel}: listed but not written`); continue; }
      const p = path.join(this.part, ...rel.split('/'));
      let st; try { st = await fsp.stat(p); } catch { bad.push(`${rel}: missing on the disk`); continue; }
      if (f.size !== size || st.size !== size) { bad.push(`${rel}: ${st.size} bytes on the disk, ${f.size} written, ${size} expected`); continue; }
      if (!f.digest) f.digest = f.hash.digest('hex');
      const disk = await sha256File(p);
      if (disk !== f.digest) { bad.push(`${rel}: what is on the disk differs from what was written`); continue; }
      await flush(p);
      out.push({ rel, size, sha256: disk });
    }
    if (bad.length) return { ok: false, bad };
    this.checked = out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
    return { ok: true, files: out.length, bytes: out.reduce((a, x) => a + x.size, 0) };
  }
  /** After a verify that passed: the marker written, the part folder made THE hand-over (an older one replaced), the
   *  pointers written → { ok, dir, id, bytes, files }. */
  async finish(info = {}) {
    if (!this.checked) throw new Error('not verified');
    const id = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
    const bytes = this.checked.reduce((a, x) => a + x.size, 0);
    const marker = { app: 'KurokawaReader', kind: 'handover', format: FORMAT, id, createdAt: Date.now(), from: { shell: 'electron', platform: process.platform, ...this.from }, counts: info.counts || {}, bytes, files: this.checked };
    await writeAtomic(path.join(this.part, MARKER), JSON.stringify(marker, null, 1));
    await flushDir(this.part);
    let old = null;
    if (fs.existsSync(this.final)) { old = `${this.final}.old-${Date.now()}`; await fsp.rename(this.final, old); }
    try { await fsp.rename(this.part, this.final); }
    catch (e) { if (old) await fsp.rename(old, this.final).catch(() => undefined); throw e; }
    await flushDir(this.root);
    if (old) await fsp.rm(old, { recursive: true, force: true }).catch(() => undefined);
    const pointer = JSON.stringify({ app: 'KurokawaReader', kind: 'handover-pointer', dir: this.final, id, createdAt: marker.createdAt });
    const pointed = [];
    for (const p of this.pointers) { try { await fsp.mkdir(p.dir, { recursive: true }); await writeAtomic(path.join(p.dir, p.name), pointer); pointed.push(path.join(p.dir, p.name)); } catch { /* the Rust build also looks in the default place */ } }
    this.files.clear(); this.checked = null;
    return { ok: true, dir: this.final, id, bytes, files: marker.files.length, pointers: pointed };
  }
  /** The part folder let go (a failed or cancelled run). */
  async abort() { this.files.clear(); this.checked = null; await fsp.rm(this.part, { recursive: true, force: true }).catch(() => undefined); return true; }
}

/** The hand-over made before, if any: { dir, marker } or null. */
function status(root) {
  try { const dir = path.join(root, DIR); const marker = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')); return marker && marker.kind === 'handover' ? { dir, marker } : null; } catch { return null; }
}

/** The page's channels (preload.cjs: window.kurokawaHandover). KR_HANDOVER_FREE (bytes): the free space to assume —
 *  for tests of a full disk. */
function install({ ipcMain, app }) {
  let w = null;
  const root = () => app.getPath('userData');
  const pointers = () => [tauriDataDir() && { dir: tauriDataDir(), name: POINTER }, process.env.PORTABLE_EXECUTABLE_DIR && { dir: process.env.PORTABLE_EXECUTABLE_DIR, name: PORTABLE_POINTER }].filter(Boolean);
  const need = () => { if (!w) throw new Error('no hand-over begun'); return w; };
  ipcMain.handle('kr:handover-begin', async (_e, o) => {
    if (w) await w.abort();
    const free = process.env.KR_HANDOVER_FREE ? Number(process.env.KR_HANDOVER_FREE) : undefined;
    w = new Writer(root(), { free, pointers: pointers(), from: { version: app.getVersion(), portable: !!process.env.PORTABLE_EXECUTABLE_DIR } });
    return w.begin(o && o.need, { unknownOk: !!(o && o.unknownOk) });
  });
  ipcMain.handle('kr:handover-write', (_e, rel, data, append) => need().write(String(rel), data, !!append));
  ipcMain.handle('kr:handover-shell', () => need().shellFiles(root()));
  ipcMain.handle('kr:handover-read', (_e, rel) => need().read(String(rel)));
  ipcMain.handle('kr:handover-verify', (_e, list) => need().verify(list));
  ipcMain.handle('kr:handover-finish', async (_e, info) => { const r = await need().finish(info || {}); w = null; return r; });
  ipcMain.handle('kr:handover-abort', async () => { if (w) await w.abort(); w = null; return true; });
  ipcMain.handle('kr:handover-status', () => status(root()));
}

/** The bridge build's gate before it installs the Rust build (main.cjs rustSwitch, stage R6b's switch): the page that
 *  asked makes the hand-over — with its progress sheet, and on failure its own plain words (ui/handoversheet.ts
 *  handoverBeforeInstall, through window.__KR_HANDOVER__.beforeInstall()) — and the answer is { ok: true, dir, id,
 *  counts } ONLY when the page said true AND a hand-over marked since this call is on the disk; else { ok: false,
 *  reason } and nothing may be installed. Never deletes or changes the profile's data. */
async function prepare({ app, webContents }) {
  if (!webContents || (webContents.isDestroyed && webContents.isDestroyed())) return { ok: false, reason: 'no window to make the hand-over in' };
  const t0 = Date.now();
  let said;
  try { said = await webContents.executeJavaScript('window.__KR_HANDOVER__ ? window.__KR_HANDOVER__.beforeInstall() : "missing"', true); }
  catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
  if (said === 'missing') return { ok: false, reason: 'this window cannot make the hand-over' };
  if (said !== true) return { ok: false, reason: 'not made' };
  const st = status(app.getPath('userData'));
  if (!st || !(Number(st.marker.createdAt) >= t0 - 1000)) return { ok: false, reason: 'no new hand-over on the disk' };
  return { ok: true, dir: st.dir, id: st.marker.id, counts: st.marker.counts || {} };
}

module.exports = { install, prepare, Writer, status, safeRel, tauriDataDir, freeBytes, dirSize, FORMAT, DIR, PART, MARKER, POINTER, PORTABLE_POINTER, IDENTIFIER, MARGIN };
