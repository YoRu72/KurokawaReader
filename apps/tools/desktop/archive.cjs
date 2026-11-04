// Archives on the desktop: ZIP read by the app's own parser (and extracted in place the HatchZip way — last entry
// first, the archive truncated after each committed batch, a journal beside it for resuming); 7z, rar, tar and
// the rest through the 7-Zip binary that ships with the app (7zip-bin). Zip creation with yazl-free streaming
// (stored for what gains nothing by squeezing, deflate otherwise).
'use strict';
const fs = require('node:fs'); const fsp = fs.promises; const path = require('node:path'); const zlib = require('node:zlib'); const { spawn } = require('node:child_process'); const { pipeline } = require('node:stream/promises'); const { Transform, Readable } = require('node:stream');

const SIG = { zip: [0x50, 0x4b], sevenz: [0x37, 0x7a, 0xbc, 0xaf], rar: [0x52, 0x61, 0x72, 0x21], gz: [0x1f, 0x8b], xz: [0xfd, 0x37, 0x7a, 0x58, 0x5a], bz2: [0x42, 0x5a, 0x68] };
async function formatOf(file) {
  const fd = await fsp.open(file, 'r'); const b = Buffer.alloc(8); try { await fd.read(b, 0, 8, 0); } finally { await fd.close(); }
  const n = path.basename(file).toLowerCase(); const is = (s) => s.every((v, i) => b[i] === v);
  // (Split volumes — «x.7z.001», «x.zip.001», «x.zip» beside «x.z01» — go to 7-Zip, which joins them.)
  if (/\.(7z|zip)\.\d{3}$/.test(n) || (n.endsWith('.zip') && fs.existsSync(file.replace(/\.zip$/i, '.z01')))) return '7z';
  if (is(SIG.zip)) return 'zip'; if (is(SIG.sevenz)) return '7z'; if (is(SIG.rar)) return 'rar';
  if (is(SIG.gz)) return /\.(tar\.gz|tgz)$/.test(n) ? 'tar.gz' : 'gz'; if (is(SIG.xz)) return /\.(tar\.xz|txz)$/.test(n) ? 'tar.xz' : 'xz'; if (is(SIG.bz2)) return /\.(tar\.bz2|tbz2)$/.test(n) ? 'tar.bz2' : 'bz2';
  if (n.endsWith('.tar')) return 'tar'; throw new Error('notArchive');
}

/* ---------- ZIP: the central directory ---------- */
async function readZip(fd, length) {
  const tail = Math.min(length, 65557 + 22); const buf = Buffer.alloc(tail); await fd.read(buf, 0, tail, length - tail);
  let eocd = -1; for (let i = tail - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('notZip');
  let count = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdOff = buf.readUInt32LE(eocd + 16);
  if ((count === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) && eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50) {
    const z64 = Number(buf.readBigUInt64LE(eocd - 12)); const z = Buffer.alloc(56); await fd.read(z, 0, 56, z64); if (z.readUInt32LE(0) !== 0x06064b50) throw new Error('badZip64');
    count = Number(z.readBigUInt64LE(32)); cdSize = Number(z.readBigUInt64LE(40)); cdOff = Number(z.readBigUInt64LE(48));
  }
  const cd = Buffer.alloc(cdSize); await fd.read(cd, 0, cdSize, cdOff); const items = []; let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('badCentralDirectory');
    const flags = cd.readUInt16LE(p + 8); const it = { method: cd.readUInt16LE(p + 10), crc: cd.readUInt32LE(p + 16), csize: cd.readUInt32LE(p + 20), usize: cd.readUInt32LE(p + 24), offset: cd.readUInt32LE(p + 42), encrypted: !!(flags & 1) };
    const nl = cd.readUInt16LE(p + 28), xl = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32);
    it.name = cd.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nl).replace(/\\/g, '/');
    let xp = p + 46 + nl; const xe = xp + xl;
    while (xp + 4 <= xe) { const id = cd.readUInt16LE(xp), sz = cd.readUInt16LE(xp + 2); if (id === 1) { let q = xp + 4; if (it.usize === 0xffffffff) { it.usize = Number(cd.readBigUInt64LE(q)); q += 8; } if (it.csize === 0xffffffff) { it.csize = Number(cd.readBigUInt64LE(q)); q += 8; } if (it.offset === 0xffffffff) it.offset = Number(cd.readBigUInt64LE(q)); } xp += 4 + sz; }
    it.raw = cd.subarray(p, p + 46 + nl + xl + cl); it.dir = it.name.endsWith('/'); if (it.name) items.push(it); p += 46 + nl + xl + cl;
  }
  return { items, cdStart: cdOff, length };
}
async function dataStart(fd, it) { const h = Buffer.alloc(30); await fd.read(h, 0, 30, it.offset); if (h.readUInt32LE(0) !== 0x04034b50) throw new Error('badLocalHeader ' + it.name); return it.offset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28); }
const unsafe = (name) => name.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(name) || /^[a-zA-Z]:/.test(name);
const journalOf = (file) => file + '.kurokawa-unzip'; const tailOf = (file) => file + '.kurokawa-tail';
const hasJournal = (file) => fs.existsSync(journalOf(file));

/* ---------- listing ---------- */
async function list(file, password) {
  const entries = []; let total = 0, encrypted = false, format;
  if (hasJournal(file) && isTar(file)) { format = 'tar'; const fd = await fsp.open(file, 'r'); try { for (const it of await scanTar(fd)) { entries.push({ path: it.name, size: it.size, dir: it.type === '5' }); total += it.size; } } finally { await fd.close(); } }
  else if (hasJournal(file)) {
    format = 'zip'; const j = JSON.parse(await fsp.readFile(journalOf(file), 'utf8')); const t = await fsp.open(tailOf(file), 'r');
    try { const ix = await readZip(t, (await t.stat()).size); for (const it of ix.items) if (it.offset < j.committed) { entries.push({ path: it.name, size: it.usize, compressed: it.csize, dir: it.dir }); total += it.usize; } } finally { await t.close(); }
  } else if ((format = await formatOf(file)) === 'zip') {
    const fd = await fsp.open(file, 'r'); try { const ix = await readZip(fd, (await fd.stat()).size); for (const it of ix.items) { entries.push({ path: it.name, size: it.usize, compressed: it.csize, dir: it.dir }); total += it.usize; encrypted ||= it.encrypted; } } finally { await fd.close(); }
  } else if (format === 'tar') { const fd = await fsp.open(file, 'r'); try { for (const it of await scanTar(fd)) { entries.push({ path: it.name, size: it.size, dir: it.type === '5' }); total += it.size; } } finally { await fd.close(); } }
  else if (format === 'gz' || format === 'xz' || format === 'bz2') { entries.push({ path: path.basename(file).replace(/\.(gz|xz|bz2)$/i, ''), size: -1, dir: false }); }
  else {
    const out = await run7z(['l', '-slt', '-ba', ...(password ? [`-p${password}`] : ['-p']), file]);
    let cur = null; for (const line of out.split(/\r?\n/)) { const m = /^(\w[\w ]*) = (.*)$/.exec(line); if (!m) { if (cur) { entries.push(cur); cur = null; } continue; } if (m[1] === 'Path') cur = { path: m[2].replace(/\\/g, '/'), size: 0, dir: false }; else if (!cur) continue; else if (m[1] === 'Size') { cur.size = Number(m[2]) || 0; total += cur.size; } else if (m[1] === 'Packed Size' && m[2]) cur.compressed = Number(m[2]); else if (m[1] === 'Folder' || m[1] === 'Attributes') { if (m[2] === '+' || /^D/.test(m[2])) cur.dir = true; } else if (m[1] === 'Encrypted' && m[2] === '+') encrypted = true; }
    if (cur) entries.push(cur);
  }
  let largest = 0; const seen = new Set(); let duplicate, bad;
  for (const e of entries) { if (!e.dir) largest = Math.max(largest, e.size); if (!bad && unsafe(e.path)) bad = e.path; if (!e.dir) { const k = e.path.toLowerCase(); if (seen.has(k) && !duplicate) duplicate = e.path; seen.add(k); } }
  const sfv = sfvOf(file);
  return { format, entries, total, encrypted, inPlaceOk: (format === 'zip' && !encrypted) || format === 'tar', resumable: hasJournal(file), largest, free: await freeSpace(path.dirname(file)), ...(bad ? { unsafe: bad } : {}), ...(duplicate ? { duplicate } : {}), ...(sfv ? { sfv: path.basename(sfv) } : {}) };
}

/* ---------- 7-Zip ---------- */
function sevenZip() {
  try { const bin = require('7zip-bin'); return bin.path7za.replace('app.asar', 'app.asar.unpacked'); } catch { return process.platform === 'win32' ? '7z.exe' : '7z'; }
}
function run7z(args, onLine) {
  return new Promise((res, rej) => { const p = spawn(sevenZip(), args, { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = ''; p.stdout.on('data', (d) => { out += d; if (onLine) for (const l of String(d).split(/[\r\n]+/)) if (l) onLine(l); }); p.stderr.on('data', (d) => { err += d; }); p.on('error', rej); p.on('close', (code) => (code === 0 ? res(out) : rej(new Error((err || out).trim().split('\n').pop() || `7z exit ${code}`)))); return p; });
}

/* ---------- extracting ---------- */
// (`only`: just these entries and what is under these folders.)
const wanted = (only, name) => !only || !only.length || only.some((w) => name === w || (w.endsWith('/') && name.startsWith(w)));
async function targetFor(dest, name, replace, only) {
  if (unsafe(name)) throw new Error('unsafePath ' + name);
  if (!wanted(only, name)) return null;
  const out = path.resolve(dest, name); if (!out.startsWith(path.resolve(dest) + path.sep)) throw new Error('unsafePath ' + name);
  await fsp.mkdir(path.dirname(out), { recursive: true });
  if (fs.existsSync(out)) { if (replace === 'skip') return null; if (replace === 'both') { const ext = path.extname(out), base = out.slice(0, out.length - ext.length); for (let i = 2; ; i++) { const alt = `${base} (${i})${ext}`; if (!fs.existsSync(alt)) return alt; } } }
  return out;
}
function crcStream(state) { const T = crcTable(); return new Transform({ transform(chunk, _e, cb) { let c = state.crc; for (let i = 0; i < chunk.length; i++) c = T[(c ^ chunk[i]) & 0xff] ^ (c >>> 8); state.crc = c; state.n += chunk.length; cb(null, chunk); } }); }
/** The bytes of one entry read at their positions (the handle stays the caller's: nothing closes it on an error). */
function rangeStream(fd, start, len) {
  let pos = start; const end = start + len;
  return new Readable({ highWaterMark: 1 << 16, read(size) { if (pos >= end) { this.push(null); return; } const n = Math.min(size, end - pos); const b = Buffer.alloc(n); fd.read(b, 0, n, pos).then(({ bytesRead }) => { if (!bytesRead) { this.push(null); return; } pos += bytesRead; this.push(bytesRead === n ? b : b.subarray(0, bytesRead)); }).catch((e) => this.destroy(e)); } });
}
let TABLE; function crcTable() { if (TABLE) return TABLE; TABLE = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; TABLE[n] = c >>> 0; } return TABLE; }
async function writeEntry(fd, it, out, ctl) {
  const start = await dataStart(fd, it); const src = rangeStream(fd, start, it.csize);
  const state = { crc: 0xffffffff, n: 0 }; const part = out + '.part';
  const chain = [src, ...(it.method === 8 ? [zlib.createInflateRaw()] : it.method === 0 ? [] : [null]), crcStream(state), new Transform({ transform(c, _e, cb) { if (ctl.stopped()) return cb(new Error('stopped')); ctl.tick(c.length); cb(null, c); } }), fs.createWriteStream(part)];
  if (chain.includes(null)) throw new Error(`unsupportedMethod ${it.method} ${it.name}`);
  try { await pipeline(chain); } catch (e) { await fsp.rm(part, { force: true }); throw e; }
  if (((state.crc ^ 0xffffffff) >>> 0) !== it.crc) { await fsp.rm(part, { force: true }); throw new Error('crcMismatch ' + it.name); }
  await fsp.rm(out, { force: true }); await fsp.rename(part, out);
}
async function extractZip(file, dest, o, pr) {
  const fd = await fsp.open(file, 'r'); let n = 0;
  try {
    const ix = await readZip(fd, (await fd.stat()).size); const total = ix.items.reduce((a, x) => a + x.usize, 0); let done = 0;
    const ctl = { stopped: pr.stopped, tick: (k) => { done += k; pr.on(done, total, cur); } }; let cur = '';
    for (const it of ix.items) {
      if (pr.stopped()) throw new Error('stopped');
      if (it.dir) { if (unsafe(it.name)) throw new Error('unsafePath'); await fsp.mkdir(path.join(dest, it.name), { recursive: true }); continue; }
      const out = await targetFor(dest, it.name, o.replace, o.only); if (!out) { done += it.usize; continue; }
      cur = it.name; pr.on(done, total, cur); await writeEntry(fd, it, out, ctl); n++;
    }
    pr.on(total, total, '');
  } finally { await fd.close(); }
  return n;
}
const BATCH = { bytes: 512 * 1024 * 1024, count: 64 };
async function extractZipInPlace(file, dest, o, pr) {
  const journal = journalOf(file), tail = tailOf(file); let n = 0;
  const fd = await fsp.open(file, 'r+');
  try {
    let ix, committed;
    if (fs.existsSync(journal) && fs.existsSync(tail)) {
      const j = JSON.parse(await fsp.readFile(journal, 'utf8')); committed = j.committed; if ((await fd.stat()).size > committed) await fd.truncate(committed);
      const t = await fsp.open(tail, 'r'); try { ix = await readZip(t, (await t.stat()).size); } finally { await t.close(); }
      ix.items = ix.items.filter((it) => it.offset < committed);
    } else {
      ix = await readZip(fd, (await fd.stat()).size); committed = ix.length;
      const cd = Buffer.alloc(ix.length - ix.cdStart); await fd.read(cd, 0, cd.length, ix.cdStart);
      const t = await fsp.open(tail, 'w'); try { await t.write(cd, 0, cd.length, ix.cdStart); } finally { await t.close(); }   // sparse: the directory at its own offset
      await writeAtomic(journal, JSON.stringify({ version: 1, committed, output: dest, length: ix.length }));
    }
    const items = [...ix.items].sort((a, b) => b.offset - a.offset); const total = items.reduce((a, x) => a + x.usize, 0); let done = 0, cur = '';
    const ctl = { stopped: pr.stopped, tick: (k) => { done += k; pr.on(done, total, cur); } };
    let i = 0;
    while (i < items.length) {
      if (pr.stopped()) throw new Error('stopped');
      const free = await freeSpace(dest) - (o.keepFree ?? 64 * 1024 * 1024); let used = 0, end = i; const written = [];
      while (end < items.length && end - i < BATCH.count && (end === i || used + items[end].usize <= Math.min(free, BATCH.bytes))) { used += items[end].usize; end++; }
      if (items[i].usize > free) throw new Error('noSpace');
      for (let k = i; k < end; k++) {
        const it = items[k];
        if (it.dir) { if (unsafe(it.name)) throw new Error('unsafePath'); await fsp.mkdir(path.join(dest, it.name), { recursive: true }); continue; }
        const out = await targetFor(dest, it.name, o.replace, o.only); if (!out) { done += it.usize; continue; }
        cur = it.name; pr.on(done, total, cur); await writeEntry(fd, it, out, ctl); written.push(out); n++;
      }
      for (const w of written) { const h = await fsp.open(w, 'r+'); try { await h.sync(); } catch { /* fs without fsync */ } finally { await h.close(); } }
      committed = items[end - 1].offset;
      await writeAtomic(journal, JSON.stringify({ version: 1, committed, output: dest, length: ix.length }));
      await fd.truncate(committed); try { await fd.sync(); } catch { /* ignore */ }
      i = end;
    }
    pr.on(total, total, '');
  } finally { await fd.close(); }
  await fsp.rm(file, { force: true }); await fsp.rm(tail, { force: true }); await fsp.rm(journal, { force: true });
  return n;
}
async function writeAtomic(file, text) { await fsp.writeFile(file + '.tmp', text); await fsp.rename(file + '.tmp', file); }
async function freeSpace(dir) { try { const s = await fsp.statfs(dir); return Number(s.bavail) * Number(s.bsize); } catch { return Number.MAX_SAFE_INTEGER; } }

async function extract7z(file, dest, o, pr) {
  const args = ['x', '-y', '-bsp1', '-bb1', `-o${dest}`, o.replace === 'skip' ? '-aos' : o.replace === 'both' ? '-aou' : '-aoa', o.password ? `-p${o.password}` : '-p', file, ...(o.only || []).map((w) => w.replace(/\/$/, ''))];
  let n = 0; const p = { proc: null };
  const out = await new Promise((res, rej) => {
    const proc = spawn(sevenZip(), args, { stdio: ['ignore', 'pipe', 'pipe'] }); p.proc = proc; let buf = '', err = '';
    const timer = setInterval(() => { if (pr.stopped()) proc.kill(); }, 300);
    proc.stdout.on('data', (d) => { buf += d; for (const l of String(d).split(/[\r\n]+/)) { const m = /^\s*(\d+)%(?:\s+\d+)?\s*(?:- (.*))?$/.exec(l); if (m) pr.on(Number(m[1]), 100, m[2] || ''); if (/^- /.test(l)) n++; } });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', rej); proc.on('close', (code) => { clearInterval(timer); if (pr.stopped()) rej(new Error('stopped')); else if (code === 0) res(buf); else rej(new Error(/wrong password/i.test(err + buf) ? 'wrongPassword' : (err.trim().split('\n').pop() || `7z exit ${code}`))); });
  });
  void out; pr.on(100, 100, ''); return n;
}
async function extract(file, dest, o, pr) {
  await fsp.mkdir(dest, { recursive: true });
  if (hasJournal(file)) return isTar(file) ? extractTarInPlace(file, dest, o, pr) : extractZipInPlace(file, dest, o, pr);
  const fmt = await formatOf(file); let n;
  // HatchZip's rules before anything is touched: a hostile archive refused, an .sfv beside it checked, and with
  // «verify first» every checksum read before the archive is cut.
  const info = await list(file, o.password); if (info.unsafe) throw new Error('unsafePath ' + info.unsafe); if (info.duplicate && o.inPlace) throw new Error('duplicateEntry ' + info.duplicate);
  const sfv = sfvOf(file); if (sfv) { const c = await checkSfv(sfv, pr); if (c.bad.length) throw new Error('sfvMismatch ' + c.bad.join(', ')); }
  if (o.verifyFirst && o.inPlace && fmt === 'zip') { const tr = await test(file, o.password, pr); if (tr.bad.length) throw new Error('damaged ' + tr.bad.join(', ')); }
  if (o.inPlace && fmt === 'tar') return extractTarInPlace(file, dest, o, pr);
  if (fmt === 'zip') { const fd = await fsp.open(file, 'r'); let enc = false; try { enc = (await readZip(fd, (await fd.stat()).size)).items.some((x) => x.encrypted); } finally { await fd.close(); } n = enc ? await extract7z(file, dest, o, pr) : o.inPlace ? await extractZipInPlace(file, dest, o, pr) : await extractZip(file, dest, o, pr); }
  else if (fmt === 'tar.gz' || fmt === 'tar.xz' || fmt === 'tar.bz2') { // two layers: 7z needs the inner tar first
    const tmp = path.join(dest, `.${path.basename(file)}.tar`); await extract7z(file, path.dirname(tmp), { ...o, replace: 'replace' }, { on: (d, t) => pr.on(d / 2, t, file), stopped: pr.stopped });
    const inner = fs.readdirSync(dest).find((x) => /\.tar$/i.test(x)); const innerPath = path.join(dest, inner); n = await extract7z(innerPath, dest, o, { on: (d, t, f) => pr.on(50 + d / 2, t, f), stopped: pr.stopped }); await fsp.rm(innerPath, { force: true });
  } else n = await extract7z(file, dest, o, pr);
  if (o.deleteAfter && !o.inPlace && !pr.stopped()) await fsp.rm(file, { force: true });
  return n;
}

/* ---------- making a zip ---------- */
const STORED = /\.(png|jpe?g|gif|webp|avif|mp4|mkv|webm|mp3|m4a|ogg|opus|flac|zip|7z|rar|gz|xz|bz2|apk|woff2?)$/i;
async function createZip(out, inputs, pr) {
  const files = []; for (const i of inputs) { const st = await fsp.stat(i); if (st.isDirectory()) await walk(i, path.basename(i) + '/', files); else files.push([i, path.basename(i)]); }
  let total = 0; for (const [f] of files) total += (await fsp.stat(f)).size; let done = 0;
  const part = out + '.part'; const ws = fs.createWriteStream(part); let pos = 0; const central = []; const T = crcTable();
  const write = (b) => new Promise((res, rej) => { pos += b.length; ws.write(b, (e) => (e ? rej(e) : res())); });
  const dos = (d) => { const t = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff, dd = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff; return [t, dd]; };
  for (const [f, name] of files) {
    if (pr.stopped()) { ws.destroy(); await fsp.rm(part, { force: true }); throw new Error('stopped'); }
    const st = await fsp.stat(f); const store = STORED.test(name); const nameB = Buffer.from(name, 'utf8'); const [tm, dt] = dos(st.mtime);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(45, 4); h.writeUInt16LE(0x808, 6); h.writeUInt16LE(store ? 0 : 8, 8); h.writeUInt16LE(tm, 10); h.writeUInt16LE(dt, 12); h.writeUInt16LE(nameB.length, 26);
    const offset = pos; await write(Buffer.concat([h, nameB])); pr.on(done, total, name);
    let crc = 0xffffffff, usize = 0, csize = 0;
    const src = fs.createReadStream(f, { highWaterMark: 1 << 16 }); const counter = new Transform({ transform(c, _e, cb) { for (let i = 0; i < c.length; i++) crc = T[(crc ^ c[i]) & 0xff] ^ (crc >>> 8); usize += c.length; done += c.length; pr.on(done, total, name); cb(null, c); } });
    const sizer = new Transform({ transform(c, _e, cb) { csize += c.length; cb(null, c); } });
    await pipeline([src, counter, ...(store ? [] : [zlib.createDeflateRaw({ level: 6 })]), sizer, new Transform({ transform(c, _e, cb) { pos += c.length; cb(null, c); } }), ws], { end: false });
    crc = (crc ^ 0xffffffff) >>> 0;
    const dd = Buffer.alloc(24); dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc, 4); dd.writeBigUInt64LE(BigInt(csize), 8); dd.writeBigUInt64LE(BigInt(usize), 16); await write(dd);
    central.push({ nameB, crc, csize, usize, offset, tm, dt, store });
  }
  const cdStart = pos; const parts = [];
  for (const c of central) { const big = c.csize >= 0xffffffff || c.usize >= 0xffffffff || c.offset >= 0xffffffff; const extra = big ? Buffer.alloc(28) : Buffer.alloc(0); if (big) { extra.writeUInt16LE(1, 0); extra.writeUInt16LE(24, 2); extra.writeBigUInt64LE(BigInt(c.usize), 4); extra.writeBigUInt64LE(BigInt(c.csize), 12); extra.writeBigUInt64LE(BigInt(c.offset), 20); }
    const h = Buffer.alloc(46); h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(45, 4); h.writeUInt16LE(45, 6); h.writeUInt16LE(0x808, 8); h.writeUInt16LE(c.store ? 0 : 8, 10); h.writeUInt16LE(c.tm, 12); h.writeUInt16LE(c.dt, 14); h.writeUInt32LE(c.crc, 16); h.writeUInt32LE(big ? 0xffffffff : c.csize, 20); h.writeUInt32LE(big ? 0xffffffff : c.usize, 24); h.writeUInt16LE(c.nameB.length, 28); h.writeUInt16LE(extra.length, 30); h.writeUInt32LE(big ? 0xffffffff : c.offset, 42); parts.push(h, c.nameB, extra); }
  const cdBuf = Buffer.concat(parts); await write(cdBuf); const cdEnd = pos;
  const z64 = Buffer.alloc(56); z64.writeUInt32LE(0x06064b50, 0); z64.writeBigUInt64LE(44n, 4); z64.writeUInt16LE(45, 12); z64.writeUInt16LE(45, 14); z64.writeBigUInt64LE(BigInt(central.length), 24); z64.writeBigUInt64LE(BigInt(central.length), 32); z64.writeBigUInt64LE(BigInt(cdBuf.length), 40); z64.writeBigUInt64LE(BigInt(cdStart), 48);
  const loc = Buffer.alloc(20); loc.writeUInt32LE(0x07064b50, 0); loc.writeBigUInt64LE(BigInt(cdEnd), 8); loc.writeUInt32LE(1, 16);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(Math.min(central.length, 0xffff), 8); eocd.writeUInt16LE(Math.min(central.length, 0xffff), 10); eocd.writeUInt32LE(Math.min(cdBuf.length, 0xffffffff), 12); eocd.writeUInt32LE(Math.min(cdStart, 0xffffffff), 16);
  await write(Buffer.concat([z64, loc, eocd])); await new Promise((r) => ws.end(r));
  await fsp.rm(out, { force: true }); await fsp.rename(part, out); pr.on(total, total, ''); return files.length;
}
async function walk(dir, prefix, out) { for (const e of await fsp.readdir(dir, { withFileTypes: true })) { if (e.isDirectory()) await walk(path.join(dir, e.name), prefix + e.name + '/', out); else if (e.isFile()) out.push([path.join(dir, e.name), prefix + e.name]); } }

/* ---------- HatchZip: test, restore, .sfv, tar in place ---------- */
async function test(file, password, pr) {
  const fmt = await formatOf(file); const bad = []; let files = 0;
  if (fmt === 'zip') {
    const fd = await fsp.open(file, 'r');
    try {
      const ix = await readZip(fd, (await fd.stat()).size);
      if (!ix.items.some((x) => x.encrypted)) {
        const total = ix.items.reduce((a, x) => a + x.usize, 0); let done = 0; const T = crcTable();
        for (const it of ix.items) {
          if (it.dir) continue; if (pr.stopped()) throw new Error('stopped'); pr.on(done, total, it.name); files++;
          try { const start = await dataStart(fd, it); const src = rangeStream(fd, start, it.csize); const state = { crc: 0xffffffff };
            await pipeline([src, ...(it.method === 8 ? [zlib.createInflateRaw()] : []), new Transform({ transform(c, _e, cb) { let x = state.crc; for (let i = 0; i < c.length; i++) x = T[(x ^ c[i]) & 0xff] ^ (x >>> 8); state.crc = x; done += c.length; cb(); } })]);
            if (((state.crc ^ 0xffffffff) >>> 0) !== it.crc) bad.push(it.name);
          } catch (e) { if (e.message === 'stopped') throw e; bad.push(it.name); }
        }
        pr.on(total, total, ''); return { ok: !bad.length, files, bad };
      }
    } finally { await fd.close(); }
  }
  // 7-Zip tests the rest (and encrypted zips): every file decoded, its checksum compared.
  try { const out = await run7z(['t', '-bb1', password ? `-p${password}` : '-p', file]); files = (out.match(/^T /gm) || []).length; } catch (e) { bad.push(e.message); }
  return { ok: !bad.length, files, bad };
}
/** Giving up an extraction in place: what is left becomes a normal ZIP again (the remaining entries' directory
 *  records written after them, then the end records); a cut tar is a valid tar already. */
async function restore(file) {
  const journal = journalOf(file), tail = tailOf(file); if (!fs.existsSync(journal)) throw new Error('nothingToRestore');
  if (isTar(file)) { await fsp.rm(journal, { force: true }); return -1; }
  const committed = JSON.parse(await fsp.readFile(journal, 'utf8')).committed;
  const t = await fsp.open(tail, 'r'); let left; try { left = (await readZip(t, (await t.stat()).size)).items.filter((x) => x.offset < committed).sort((a, b) => a.offset - b.offset); } finally { await t.close(); }
  const fd = await fsp.open(file, 'r+');
  try {
    if ((await fd.stat()).size > committed) await fd.truncate(committed);
    const cd = Buffer.concat(left.map((x) => x.raw)); const cdStart = committed, cdEnd = cdStart + cd.length; const z64 = left.length >= 0xffff || cdStart >= 0xffffffff || cd.length >= 0xffffffff;
    const parts = [cd];
    if (z64) { const z = Buffer.alloc(56); z.writeUInt32LE(0x06064b50, 0); z.writeBigUInt64LE(44n, 4); z.writeUInt16LE(45, 12); z.writeUInt16LE(45, 14); z.writeBigUInt64LE(BigInt(left.length), 24); z.writeBigUInt64LE(BigInt(left.length), 32); z.writeBigUInt64LE(BigInt(cd.length), 40); z.writeBigUInt64LE(BigInt(cdStart), 48); const loc = Buffer.alloc(20); loc.writeUInt32LE(0x07064b50, 0); loc.writeBigUInt64LE(BigInt(cdEnd), 8); loc.writeUInt32LE(1, 16); parts.push(z, loc); }
    const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Math.min(left.length, 0xffff), 8); e.writeUInt16LE(Math.min(left.length, 0xffff), 10); e.writeUInt32LE(Math.min(cd.length, 0xffffffff), 12); e.writeUInt32LE(Math.min(cdStart, 0xffffffff), 16); parts.push(e);
    const all = Buffer.concat(parts); await fd.write(all, 0, all.length, committed); try { await fd.sync(); } catch { /* ignore */ }
  } finally { await fd.close(); }
  await fsp.rm(journal, { force: true }); await fsp.rm(tail, { force: true }); return left.length;
}
function sfvOf(file) { const dir = path.dirname(file), n = path.basename(file); for (const c of [n + '.sfv', n.replace(/\.(zip|7z|rar|tar)(\.\d{3})?$/i, '') + '.sfv', n.replace(/\.part\d+\.rar$|\.\d{3}$/i, '') + '.sfv']) { const p = path.join(dir, c); try { if (fs.statSync(p).isFile()) return p; } catch { /* none */ } } return null; }
async function checkSfv(sfv, pr) {
  const bad = []; let files = 0; const T = crcTable();
  for (let line of (await fsp.readFile(sfv, 'latin1')).split(/\r?\n/)) {
    line = line.trim(); if (!line || line.startsWith(';')) continue; const sp = line.lastIndexOf(' '); if (sp < 0) continue;
    const name = line.slice(0, sp).trim(); const want = parseInt(line.slice(sp + 1), 16); if (!Number.isFinite(want)) continue; files++;
    const p = path.join(path.dirname(sfv), name); if (!fs.existsSync(p)) { bad.push(name); continue; }
    let c = 0xffffffff; let done = 0; const total = fs.statSync(p).size;
    for await (const chunk of fs.createReadStream(p, { highWaterMark: 1 << 20 })) { if (pr.stopped()) throw new Error('stopped'); for (let i = 0; i < chunk.length; i++) c = T[(c ^ chunk[i]) & 0xff] ^ (c >>> 8); done += chunk.length; pr.on(done, total, name); }
    if (((c ^ 0xffffffff) >>> 0) !== want >>> 0) bad.push(name);
  }
  return { files, bad };
}
const isTar = (file) => /\.tar$/i.test(file);
async function scanTar(fd) {
  const out = []; const len = (await fd.stat()).size; const h = Buffer.alloc(512); let pos = 0, longName = null, group = -1;
  const cstr = (b, o, l) => { let e = o; while (e < o + l && b[e] !== 0) e++; return b.toString('utf8', o, e); };
  const octal = (b, o, l) => { if (b[o] & 0x80) { let v = 0n; for (let i = o + 1; i < o + l; i++) v = (v << 8n) | BigInt(b[i]); return Number(v); } const s = cstr(b, o, l).trim(); return s ? parseInt(s, 8) : 0; };
  while (pos + 512 <= len) {
    await fd.read(h, 0, 512, pos); if (h.every((x) => x === 0)) break; if (group < 0) group = pos;
    let name = cstr(h, 0, 100); const size = octal(h, 124, 12); const type = h[156] ? String.fromCharCode(h[156]) : '0';
    if (cstr(h, 257, 6).startsWith('ustar')) { const pre = cstr(h, 345, 155); if (pre) name = pre + '/' + name; }
    const data = pos + 512, next = data + Math.ceil(size / 512) * 512;
    if (type === 'L') { const b = Buffer.alloc(size); await fd.read(b, 0, size, data); longName = b.toString('utf8').replace(/\0+$/, ''); pos = next; continue; }
    if (type === 'x') { const b = Buffer.alloc(size); await fd.read(b, 0, size, data); for (const rec of b.toString('utf8').split('\n')) { const i = rec.indexOf(' path='); if (i > 0) longName = rec.slice(i + 6); } pos = next; continue; }
    if (type === 'g') { pos = next; continue; }
    out.push({ name: (longName ?? name).replace(/^\.\//, ''), head: group, data, size, type }); longName = null; group = -1; pos = next;
  }
  return out.filter((x) => x.name && x.name !== '.');
}
async function extractTarInPlace(file, dest, o, pr) {
  const journal = journalOf(file); let n = 0; const fd = await fsp.open(file, 'r+');
  try {
    if (fs.existsSync(journal)) { const c = JSON.parse(await fsp.readFile(journal, 'utf8')).committed; if ((await fd.stat()).size > c) await fd.truncate(c); }
    else await writeAtomic(journal, JSON.stringify({ version: 1, format: 'tar', committed: (await fd.stat()).size, output: dest }));
    const items = await scanTar(fd); const total = items.reduce((a, x) => a + x.size, 0); let done = 0;
    for (const it of items) if (unsafe(it.name)) throw new Error('unsafePath ' + it.name);
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]; if (pr.stopped()) throw new Error('stopped');
      if (it.type === '5') await fsp.mkdir(path.join(dest, it.name), { recursive: true });
      else if (it.type === '0' || it.type === '7') {
        if (it.size > await freeSpace(dest) - (o.keepFree ?? 64 * 1024 * 1024)) throw new Error('noSpace');
        const out = await targetFor(dest, it.name, o.replace);
        if (out) { pr.on(done, total, it.name); const part = out + '.part'; try { await pipeline([rangeStream(fd, it.data, it.size), new Transform({ transform(c, _e, cb) { if (pr.stopped()) return cb(new Error('stopped')); cb(null, c); } }), fs.createWriteStream(part)]); } catch (e) { await fsp.rm(part, { force: true }); throw e; } const h = await fsp.open(part, 'r+'); try { await h.sync(); } catch { /* ignore */ } finally { await h.close(); } await fsp.rm(out, { force: true }); await fsp.rename(part, out); n++; }
      }
      done += it.size;
      await writeAtomic(journal, JSON.stringify({ version: 1, format: 'tar', committed: it.head, output: dest }));
      await fd.truncate(it.head); try { await fd.sync(); } catch { /* ignore */ }
    }
    pr.on(total, total, '');
  } finally { await fd.close(); }
  await fsp.rm(file, { force: true }); await fsp.rm(journal, { force: true });
  return n;
}
async function existing(dest, names) { const out = []; for (const n of names) { try { if (fs.statSync(path.join(dest, n)).isFile()) out.push(n); } catch { /* not there */ } } return out; }

module.exports = { formatOf, list, extract, createZip, hasJournal, BATCH, test, restore, checkSfv, freeSpace, existing };
