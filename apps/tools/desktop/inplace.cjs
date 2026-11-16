// The extraction engine for ZIP and tar (Electron; the shape the Rust port follows): every job is checked whole
// before anything changes (archsafe.cjs's pre-flight over facts gathered here), then run in units — in place the last
// unit first, the archive cut back after each committed batch — with a versioned, checksummed journal written
// atomically before the first change and after every commit. The saved tail (the archive's directory and end records,
// and each unit's own header bytes) lets a stopped job be FINISHED, or the archive RESTORED byte for byte from any
// committed point (each file's bytes put back; a deflated one only when it squeezes back to the very same bytes,
// else the archive is closed as a smaller whole one and those files stay out). Files that were there are moved
// aside in the same volume, never deleted at once, and a finished job can be undone until its offer is dismissed.
// `io` (tests): { freeSpace(dir), charge(n), release(n), crash(point), registry } — a fake volume with a quota and
// crash points; the real disk otherwise.
'use strict';
const fs = require('node:fs'); const fsp = fs.promises; const path = require('node:path'); const zlib = require('node:zlib'); const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises'); const { Transform, Readable } = require('node:stream');
const S = require('./archsafe.cjs');

const SUFFIX = { journal: S.SPEC.journalSuffix, tail: S.SPEC.tailSuffix, part: S.SPEC.tempSuffix, lock: '.kurokawa-lock' };
const OWN_METHODS = [0, 8];
const BATCH = { bytes: 512 * 1024 * 1024, count: 64 };
const STOP_EVERY = 8 * 1024 * 1024;
const MAX_TAIL = 64 * 1024 * 1024;
const JOB_SUFFIXES = ['.kurokawa-unzip', '.kurokawa-unzip.tmp', '.kurokawa-unzip.log', '.kurokawa-tail', '.kurokawa-tail.tmp', '.kurokawa-lock', '.kurokawa-lock.tmp'];
const hostPlatform = () => (process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux');
const realIo = { freeSpace: async (d) => freeSpace(d), charge() {}, release() {}, async crash() {} };
class Crash extends Error { constructor(p) { super('crash ' + p); this.crash = true; } }
const fail = (code, extra) => Object.assign(new Error(code), extra || {});

async function freeSpace(dir) {
  let d = path.resolve(String(dir || '.'));
  for (let i = 0; i < 40; i++) { try { const s = await fsp.statfs(d); return Number(s.bavail) * Number(s.bsize); } catch { const up = path.dirname(d); if (up === d) break; d = up; } }
  return -1;
}
/** Whether two folders are one (resolved through links and letter case — the system's own answer), not by spelling. */
function sameDir(a, b) { try { return fs.realpathSync.native(a) === fs.realpathSync.native(b); } catch { return false; } }
/** A file's path with its folder resolved (the file itself may be gone). */
function canonFile(p) { const a = path.resolve(p); try { return path.join(fs.realpathSync.native(path.dirname(a)), path.basename(a)); } catch { return a; } }
async function nearestDir(p) { let d = path.resolve(p); for (let i = 0; i < 60; i++) { try { if ((await fsp.stat(d)).isDirectory()) return d; } catch { /* up */ } const up = path.dirname(d); if (up === d) return d; d = up; } return d; }
/** A file or folder flushed to the disk; a failure fails the caller (nothing is cut on an unproved write) — except the answers of a system that
 *  cannot sync folders at all (EINVAL, ENOTSUP, EISDIR; on Windows also EPERM: a folder cannot be opened for it there). */
async function fsyncPath(p, dir = false) { let h; try { h = await fsp.open(p, dir ? 'r' : 'r+'); await h.sync(); } catch (e) { const none = dir && (['EINVAL', 'ENOTSUP', 'EISDIR'].includes(e.code) || (process.platform === 'win32' && e.code === 'EPERM')); if (!none) throw fail('syncFailed ' + (e.code || e.message)); } finally { await h?.close().catch(() => {}); } }
/** Written whole or not at all: a new file, synced, renamed over the old, the folder synced. */
async function writeAtomic(file, text) { const tmp = file + '.tmp'; const h = await fsp.open(tmp, 'w'); try { await h.writeFile(text); await h.sync(); } finally { await h.close(); } await fsp.rename(tmp, file); await fsyncPath(path.dirname(file), true); }
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

/* ---------- reading the archive: units ---------- */
async function readAll(fd, pos, len) { const b = Buffer.alloc(len); let at = 0; while (at < len) { const { bytesRead } = await fd.read(b, at, len - at, pos + at); if (!bytesRead) throw fail('truncated'); at += bytesRead; } return b; }
/** A ZIP's units in offset order: each entry's local header, data and what follows it up to the next (data descriptor, gap). */
async function zipUnits(fd, size) {
  const tailLen = Math.min(size, 65557 + 22); const buf = await readAll(fd, size - tailLen, tailLen);
  let eocd = -1; for (let i = tailLen - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw fail('notZip');
  let count = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdOff = buf.readUInt32LE(eocd + 16); let zip64 = false; let tailStart;
  if ((count === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) && eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50) {
    const z = await readAll(fd, Number(buf.readBigUInt64LE(eocd - 12)), 56); if (z.readUInt32LE(0) !== 0x06064b50) throw fail('badZip64');
    count = Number(z.readBigUInt64LE(32)); cdSize = Number(z.readBigUInt64LE(40)); cdOff = Number(z.readBigUInt64LE(48)); zip64 = true;
  }
  if (cdOff + cdSize > size) throw fail('badCentralDirectory');
  const cd = await readAll(fd, cdOff, cdSize); const items = []; let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw fail('badCentralDirectory');
    const flags = cd.readUInt16LE(p + 8); const nl = cd.readUInt16LE(p + 28), xl = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32);
    const it = { flags, method: cd.readUInt16LE(p + 10), time: cd.readUInt16LE(p + 12), crc: cd.readUInt32LE(p + 16), csize: cd.readUInt32LE(p + 20), usize: cd.readUInt32LE(p + 24), offset: cd.readUInt32LE(p + 42), encrypted: !!(flags & 1), nameRaw: cd.subarray(p + 46, p + 46 + nl) };
    it.name = it.nameRaw.toString(flags & 0x800 ? 'utf8' : 'latin1').replace(/\\/g, '/');
    let xp = p + 46 + nl; const xe = xp + xl;
    while (xp + 4 <= xe) { const id = cd.readUInt16LE(xp), sz = cd.readUInt16LE(xp + 2); if (id === 1) { let q = xp + 4; const lim = Math.min(xp + 4 + sz, xe); if (it.usize === 0xffffffff && q + 8 <= lim) { it.usize = Number(cd.readBigUInt64LE(q)); q += 8; } if (it.csize === 0xffffffff && q + 8 <= lim) { it.csize = Number(cd.readBigUInt64LE(q)); q += 8; } if (it.offset === 0xffffffff && q + 8 <= lim) it.offset = Number(cd.readBigUInt64LE(q)); zip64 = true; } if (id === 0x9901 && sz >= 7) { it.aes = { strength: cd[xp + 8], method: cd.readUInt16LE(xp + 9) }; } xp += 4 + sz; }
    it.cd = cd.subarray(p, p + 46 + nl + xl + cl); it.dir = it.name.endsWith('/'); p += 46 + nl + xl + cl; items.push(it);
  }
  items.sort((a, b) => a.offset - b.offset); tailStart = cdOff;
  const layoutBad = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i]; it.start = it.offset; it.end = Math.max(it.start, Math.min(i + 1 < items.length ? items[i + 1].offset : tailStart, tailStart));   // (an offset past the directory: no bytes)
    // (A unit whose header cannot be read, or whose data runs into the next one, keeps no data of its own: dataStart = dataEnd = start.)
    it.dataStart = it.offset; it.dataEnd = it.offset;
    if (it.offset + 30 > size || (i + 1 < items.length ? items[i + 1].offset : tailStart) < it.start) { layoutBad.push(it.name); it.bad = true; continue; }
    const h = await readAll(fd, it.offset, 30);
    if (h.readUInt32LE(0) !== 0x04034b50) { layoutBad.push(it.name); it.bad = true; continue; }
    const lnl = h.readUInt16LE(26), lxl = h.readUInt16LE(28); const ds = it.offset + 30 + lnl + lxl; const de = ds + it.csize; it.dd = !!(h.readUInt16LE(6) & 8);
    if (de > it.end) { layoutBad.push(it.name); it.bad = true; continue; }
    it.dataStart = ds; it.dataEnd = de;
    const lname = await readAll(fd, it.offset + 30, lnl);
    // The local header must say what the directory says (else two readers would see two archives: refused in place).
    const lm = h.readUInt16LE(8), lcrc = h.readUInt32LE(14), lcs = h.readUInt32LE(18), lus = h.readUInt32LE(22);
    const sizesOk = it.dd || zip64 || (lcrc === it.crc && lcs === it.csize && lus === it.usize) || (lcs === 0xffffffff);
    if (!lname.equals(it.nameRaw) || lm !== it.method || !sizesOk || it.dataEnd > it.end) { layoutBad.push(it.name); it.bad = true; }
  }
  // (Data before the first entry — a self-extractor's program —: a restore could not put it back; refused in place.)
  if (items.length && items[0].start > 0 && !layoutBad.includes(items[0].name)) layoutBad.push(items[0].name);
  return { format: 'zip', units: items, tailStart, size, zip64, layoutBad, idCrc: S.crc32(cd) };
}
/** A tar's units: each entry with its long-name/pax records; the end blocks are the tail. */
async function tarUnits(fd, size) {
  const units = []; const layoutBad = []; let pos = 0, longName = null, group = -1; const h = Buffer.alloc(512);
  const cstr = (b, o, l) => { let e = o; while (e < o + l && b[e] !== 0) e++; return b.toString('utf8', o, e); };
  const octal = (b, o, l) => { if (b[o] & 0x80) { let v = 0n; for (let i = o + 1; i < o + l; i++) v = (v << 8n) | BigInt(b[i]); return Number(v); } const s = cstr(b, o, l).trim(); return s ? parseInt(s, 8) : 0; };
  while (pos + 512 <= size) {
    await fd.read(h, 0, 512, pos); if (h.every((x) => x === 0)) break; if (group < 0) group = pos;
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    let name = cstr(h, 0, 100); const sz = octal(h, 124, 12); const type = h[156] ? String.fromCharCode(h[156]) : '0'; const link = cstr(h, 157, 100);
    if (cstr(h, 257, 6).startsWith('ustar')) { const pre = cstr(h, 345, 155); if (pre) name = pre + '/' + name; }
    const data = pos + 512, next = data + Math.ceil(sz / 512) * 512; const sumOk = octal(h, 148, 8) === sum;
    if ((type === 'L' || type === 'x') && sz > 1 << 20) throw fail('badTar');
    if (type === 'L') { longName = (await readAll(fd, data, sz)).toString('utf8').replace(/\0+$/, ''); pos = next; continue; }
    if (type === 'x') { for (const rec of (await readAll(fd, data, sz)).toString('utf8').split('\n')) { const i = rec.indexOf(' path='); if (i > 0) longName = rec.slice(i + 6); } pos = next; continue; }
    if (type === 'g') { pos = next; continue; }
    const nm = (longName ?? name).replace(/^\.\//, ''); const u = { name: nm, start: group, dataStart: data, dataEnd: data + sz, end: next, usize: sz, csize: sz, method: 0, type, dir: type === '5' || nm.endsWith('/'), link: type === '2' ? 'sym' : type === '1' ? 'hard' : undefined, target: link };
    // (A device, a FIFO or a sparse file is never made on a computer: «layout» — refused in place, left out of a normal extraction and reported.)
    if (!sumOk || next > size || '346S'.includes(type)) { layoutBad.push(nm); u.bad = true; u.dataEnd = u.dataStart; }
    if (nm && nm !== '.') units.push(u); longName = null; group = -1; pos = next;
  }
  const tailStart = units.length ? units[units.length - 1].end : 0;
  return { format: 'tar', units, tailStart, size, layoutBad, idCrc: units.length ? S.crc32(await readAll(fd, 0, Math.min(512, size))) : 0 };
}
/** zip by its first bytes; tar by its header (the «ustar» magic or a valid checksum), or by its name with nothing but zeros at its start (an empty tar). */
function isTarHead(h) {
  if (!h || h.length < 512) return false; if (h.toString('latin1', 257, 262) === 'ustar') return true;
  const f = h.toString('latin1', 148, 156).replace(/[\0 ]+$/, '').trim(); if (!/^[0-7]+$/.test(f)) return false;
  let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]; return sum === parseInt(f, 8) && h.some((v) => v !== 0);
}
async function formatOf(file) {
  const fd = await fsp.open(file, 'r'); const b = Buffer.alloc(512); let n = 0; try { n = (await fd.read(b, 0, 512, 0)).bytesRead; } finally { await fd.close(); }
  if (n >= 2 && b[0] === 0x50 && b[1] === 0x4b) return 'zip';
  if (n >= 512 && (isTarHead(b) || (/\.tar$/i.test(file) && b.every((v) => v === 0)))) return 'tar'; return null;
}
async function unitsOf(file) { const fmt = await formatOf(file); if (!fmt) throw fail('notArchive'); const fd = await fsp.open(file, 'r'); try { const size = (await fd.stat()).size; return fmt === 'zip' ? await zipUnits(fd, size) : await tarUnits(fd, size); } finally { await fd.close(); } }

/* ---------- passwords: proved before anything is written ---------- */
function zipCryptoKeys(pw) { const T = S.crcTable(); const k = [305419896, 591751049, 878082192]; const up = (c) => { k[0] = (T[(k[0] ^ c) & 0xff] ^ (k[0] >>> 8)) >>> 0; k[1] = (Math.imul((k[1] + (k[0] & 0xff)) >>> 0, 134775813) + 1) >>> 0; k[2] = (T[(k[2] ^ (k[1] >>> 24)) & 0xff] ^ (k[2] >>> 8)) >>> 0; }; for (const c of Buffer.from(pw, 'utf8')) up(c); return { up, byte: () => { const t = (k[2] | 2) & 0xffff; return ((Math.imul(t, t ^ 1)) >>> 8) & 0xff; } }; }
/** A decrypting stream for traditional («ZipCrypto») encryption; the 12-byte header checked first. */
function zipCryptoStream(pw, check) { const K = zipCryptoKeys(pw); let skip = 12; return new Transform({ transform(c, _e, cb) { const o = Buffer.alloc(c.length); let w = 0; for (let i = 0; i < c.length; i++) { const p = c[i] ^ K.byte(); K.up(p); if (skip > 0) { skip--; if (skip === 0 && p !== check) return cb(fail('wrongPassword')); continue; } o[w++] = p; } cb(null, o.subarray(0, w)); } }); }
async function checkPassword(file, scan, pw) {
  const enc = scan.units.filter((u) => u.encrypted && !u.dir); if (!enc.length) return 'none'; if (!pw) return 'missing';
  const u = enc.reduce((a, b) => (b.csize < a.csize ? b : a)); const fd = await fsp.open(file, 'r');
  try {
    if (u.method === 99 || u.aes) { const n = { 1: 8, 2: 12, 3: 16 }[u.aes?.strength] || 16; const keyLen = { 8: 16, 12: 24, 16: 32 }[n]; const b = await readAll(fd, u.dataStart, n + 2); const dk = crypto.pbkdf2Sync(Buffer.from(pw, 'utf8'), b.subarray(0, n), 1000, 2 * keyLen + 2, 'sha1'); return dk.subarray(2 * keyLen).equals(b.subarray(n, n + 2)) ? 'ok' : 'wrong'; }
    // ZipCrypto: the header's check byte, then the whole smallest file decoded and its CRC compared (1 in 256 passes the byte by chance).
    const check = u.dd ? (u.time >> 8) & 0xff : u.crc >>> 24; const st = { crc: 0 };
    try { await pipeline([rangeStream(fd, u.dataStart, u.csize), zipCryptoStream(pw, check), ...(u.method === 8 ? [zlib.createInflateRaw()] : []), new Transform({ transform(c, _e, cb) { st.crc = S.crc32(c, st.crc); cb(); } })]); } catch { return 'wrong'; }
    return st.crc === u.crc ? 'ok' : 'wrong';
  } finally { await fd.close(); }
}
function rangeStream(fd, start, len) { let pos = start; const end = start + len; return new Readable({ highWaterMark: 1 << 16, read(size) { if (pos >= end) { this.push(null); return; } const n = Math.min(size, end - pos); const b = Buffer.alloc(n); fd.read(b, 0, n, pos).then(({ bytesRead }) => { if (!bytesRead) { this.destroy(fail('truncated')); return; } pos += bytesRead; this.push(bytesRead === n ? b : b.subarray(0, bytesRead)); }).catch((e) => this.destroy(e)); } }); }

/* ---------- the facts and the pre-flight ---------- */
/** Split volumes complete? (all of «x.zip.001…» present in a row, every one but the last the same size). */
function volumesOf(file) { const m = /^(.*\.(?:zip|7z|tar))\.(\d{3})$/i.exec(file); if (!m) return null; const out = []; for (let i = 1; i < 1000; i++) { const v = `${m[1]}.${String(i).padStart(3, '0')}`; if (!exists(v)) break; out.push(v); } const missing = []; const odd = []; const dir = path.dirname(file); const base = path.basename(m[1]); for (const f of fs.readdirSync(dir)) { const k = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d{3})$`, 'i').exec(f); if (k && Number(k[1]) > out.length + 1) missing.push(`${base}.${String(out.length + 1).padStart(3, '0')}`); } const sizes = out.map((v) => fs.statSync(v).size); for (let i = 0; i < sizes.length - 1; i++) if (sizes[i] !== sizes[0]) odd.push(path.basename(out[i])); if (sizes.length > 1 && sizes[sizes.length - 1] > sizes[0]) odd.push(path.basename(out[out.length - 1])); return { parts: out, missing: [...new Set(missing)], odd }; }
async function writable(p) { try { await fsp.access(p, fs.constants.W_OK); return true; } catch { return false; } }
async function devOf(p) { try { return (await fsp.stat(await nearestDir(p))).dev; } catch { return -1; } }
/** Verify-first: every file's checksum read (nothing written). → the names that failed. */
async function verifyAll(file, scan, pr, password) {
  const bad = []; const fd = await fsp.open(file, 'r'); const total = scan.units.reduce((a, u) => a + (u.dir ? 0 : u.csize), 0); let done = 0;
  try {
    for (const u of scan.units) {
      if (u.dir || u.link) continue; if (pr?.stopped?.()) throw fail('stopped');
      if (u.bad) { bad.push(u.name); continue; }
      if (scan.format === 'tar') { done += u.csize; continue; }   // (a tar keeps no checksum of its data: its headers' were checked)
      if (!OWN_METHODS.includes(u.method)) continue;
      const st = { crc: 0 };
      try { await pipeline([rangeStream(fd, u.dataStart, u.csize), ...(u.encrypted ? [zipCryptoStream(password || '', u.dd ? (u.time >> 8) & 0xff : u.crc >>> 24)] : []), ...(u.method === 8 ? [zlib.createInflateRaw()] : []), new Transform({ transform(c, _e, cb) { st.crc = S.crc32(c, st.crc); cb(); } })]); if (st.crc !== u.crc) bad.push(u.name); } catch (e) { if (e.message === 'stopped') throw e; bad.push(u.name); }
      done += u.csize; pr?.on?.(done, total, u.name);
    }
  } finally { await fd.close(); }
  return bad;
}
/**
 * Everything the pre-flight needs, gathered without writing: o = { password, verify, platform, io, registry }.
 * → { facts (for archsafe.preflight), scan (the units) }.
 */
async function facts(file, dest, o = {}) {
  const io = o.io || realIo;
  // (A saved tail with no journal: a job killed before its first change — the archive whole; the leftover removed.)
  if (!exists(journalOf(file)) && exists(tailOf(file))) await fsp.rm(tailOf(file), { force: true }); const scan = await unitsOf(file); const platform = o.platform || hostPlatform();
  const password = scan.units.some((u) => u.encrypted) ? await checkPassword(file, scan, o.password) : 'none';
  const damaged = o.verify ? await verifyAll(file, scan, o.pr, password === 'ok' ? o.password : '') : [];
  const destDir = await nearestDir(dest); const free = await io.freeSpace(destDir);
  const sameVolume = (await devOf(path.dirname(file))) === (await devOf(destDir));
  const existing = []; for (const u of scan.units) { const r = S.pathRule(u.name, platform); if (r.action !== 'refuse' && !u.dir && exists(path.join(dest, r.out))) existing.push(r.out); }
  // (The job's own names, when the destination is the archive's folder: the archive, its journal, tail, lock, unit log and their temporary copies.)
  const reserved = []; if (sameDir(path.dirname(file), dest)) { const nm = path.basename(file); for (const s of ['', SUFFIX.journal, SUFFIX.tail, SUFFIX.lock]) reserved.push(nm + s, nm + s + '.tmp'); reserved.push(nm + SUFFIX.journal + '.log'); }
  const vols = volumesOf(file); const lock = file + SUFFIX.lock;
  const busy = exists(lock) && lockAlive(lock); const journal = exists(file + SUFFIX.journal);
  const f = {
    format: scan.format, size: scan.size, platform, destLen: S.measure(path.resolve(dest) + path.sep, S.SPEC.platforms[platform].unit),
    entries: scan.units.map((u) => ({ path: u.name, dir: u.dir, link: u.link, target: u.target, method: u.dir ? undefined : u.method, encrypted: u.encrypted, csize: u.csize, usize: u.usize, offset: u.start, unitBytes: u.end - u.start })),
    supported: OWN_METHODS, external: o.external || [], encrypted: scan.units.some((u) => u.encrypted), password, damaged, layoutBad: scan.layoutBad,
    volumes: vols ? { missing: vols.missing, odd: vols.odd } : null, archiveWritable: await writable(file), destWritable: await writable(destDir), saf: /^content:/.test(file), sameVolume, free, existing, busy: busy || journal,
    inPlaceFormat: (scan.format === 'zip' || scan.format === 'tar') && !vols, tailBytes: scan.size - scan.tailStart + scan.units.reduce((a, u) => a + Math.max(0, u.dataStart - u.start) + Math.max(0, u.end - u.dataEnd), 0), reserved, blockSize: 4096,
  };
  return { facts: f, scan };
}
function lockAlive(lock) { try { const pid = Number(fs.readFileSync(lock, 'utf8').split(' ')[0]); if (!pid) return true; if (pid === process.pid) return locks.has(lock); process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
const locks = new Set();
async function takeLock(file) {
  const lock = file + SUFFIX.lock;
  if (locks.has(lock)) throw fail('busy');
  let onDisk = true;
  try { await fsp.writeFile(lock, `${process.pid} ${Date.now()}`, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') onDisk = false; else { if (lockAlive(lock)) throw fail('busy'); await fsp.writeFile(lock, `${process.pid} ${Date.now()}`); } }   // (a folder we cannot write in: this process's lock only)
  locks.add(lock); return async () => { locks.delete(lock); if (onDisk) await fsp.rm(lock, { force: true }); };
}

/* ---------- the plan: each unit's output, conflicts settled ---------- */
function planOuts(scan, dest, platform, answers, inPlace, jobId, skip) {
  const taken = new Set(); const asideRel = `${S.SPEC.asideDir}-${jobId}`; const moves = []; const unanswered = [];
  const units = scan.units.map((u, i) => {
    const r = S.pathRule(u.name, platform); const base = { i, name: u.name, start: u.start, dataStart: u.dataStart, dataEnd: u.dataEnd, end: u.end, method: u.method, crc: u.crc, usize: u.usize, csize: u.csize, dir: u.dir, link: u.link || null, encrypted: !!u.encrypted, dd: !!u.dd, time: u.time || 0 };
    if (r.action === 'refuse') throw fail('unsafePath ' + u.name);
    if (u.dir) return { ...base, kind: 'dir', out: r.out };
    if (u.link) return { ...base, kind: 'link', out: r.out };
    if (u.bad && !inPlace) return { ...base, kind: 'skip', out: r.out, bad: true };   // (a damaged header: left out of a normal extraction, reported)
    if (skip && skip.includes(u.name)) return { ...base, kind: inPlace ? 'aside' : 'skip', out: inPlace ? `${asideRel}/damaged/${r.out}` : r.out };
    let out = r.out; const abs = path.join(dest, out); const there = exists(abs) || taken.has(S.foldKey(out, platform));
    if (there) {
      // (A file never replaces a folder: moving a whole folder aside — and a Dismiss deleting it — is never what «replace» meant for one file.)
      let choice = S.conflictChoice(answers, u.name, false); try { if (choice === 'replace' && fs.lstatSync(abs).isDirectory()) choice = 'both'; } catch { /* not there */ }
      if (!choice) { unanswered.push(u.name); return { ...base, kind: 'file', out }; }
      if (choice === 'replace') { if (exists(abs)) moves.push({ from: out, to: `${asideRel}/replaced/${out}` }); }
      else if (choice === 'skip') return { ...base, kind: inPlace ? 'aside' : 'skip', out: inPlace ? `${asideRel}/skipped/${out}` : out };
      else { const dir = path.posix.dirname(out); const nm = S.keepBothName(path.posix.basename(out), (c) => { const p = dir === '.' ? c : `${dir}/${c}`; return exists(path.join(dest, p)) || taken.has(S.foldKey(p, platform)); }); out = dir === '.' ? nm : `${dir}/${nm}`; }
    }
    taken.add(S.foldKey(out, platform)); return { ...base, kind: 'file', out };
  });
  if (unanswered.length) throw fail('conflictsUnanswered', { names: unanswered });
  return { units, moves, aside: asideRel };
}

/* ---------- the journal and the saved tail ---------- */
/** The archive a restore writes: `restoreAt` when set (a finished job's: its path if free, else a free name beside it), else the archive's own. */
const targetOf = (j) => j.restoreAt || j.archive;
const journalOf = (file) => file + SUFFIX.journal; const tailOf = (file) => file + SUFFIX.tail;
async function saveJournal(p, body, io) { await writeAtomic(p, S.journalText(body)); await io.crash('journal'); }
/** The tail file: «KTTAIL2», the plan as JSON, then the archive's own tail bytes. */
function tailBuffer(plan, raw) { const j = Buffer.from(JSON.stringify(plan), 'utf8'); return Buffer.concat([Buffer.from(`KTTAIL2\n${j.length}\n`), j, raw]); }
function readTail(buf) { const a = buf.indexOf(10); const b = buf.indexOf(10, a + 1); if (buf.subarray(0, a).toString() !== 'KTTAIL2') throw fail('tailCorrupt'); const n = Number(buf.subarray(a + 1, b).toString()); const plan = JSON.parse(buf.subarray(b + 1, b + 1 + n).toString('utf8')); return { plan, raw: buf.subarray(b + 1 + n) }; }
/** A job's journal read and checked against its archive and tail. → { j, plan, raw } or an error whose message says why it is never replayed. */
/** A journal is trusted only when it is where and what this engine writes: an in-place job's beside its archive (journalOf / tailOf the archive), a
 *  normal job's in its registry (<registry>/<id>.kurokawa-unzip and -tail); its id plain, its aside folder `.kurokawa-replaced-<id>`, its destination
 *  absolute, every name in it (outputs, moves, the plan's units) relative and already safe for its platform, each unit's saved header the shape of a
 *  ZIP or tar header. Anything else is never replayed: «journalCorrupt», nothing touched. (kt-core extractjob.rs validate: the same rules.) */
function validate(jpath, j, plan) {
  const bad = () => { throw fail('journalCorrupt'); }; const str = (x) => typeof x === 'string';
  if (!str(j.id) || !/^[A-Za-z0-9]{1,64}$/.test(j.id) || !j.aside || j.aside.dir !== `${S.SPEC.asideDir}-${j.id}`) bad();
  if (!S.SPEC.platforms[j.platform] || !str(j.dest) || !path.isAbsolute(j.dest) || !str(j.archive) || !path.isAbsolute(j.archive) || !str(j.tail)) bad();
  const relOk = (x) => str(x) && x !== '' && (() => { const r = S.pathRule(x, j.platform); return r.action !== 'refuse' && r.out === x; })();
  const me = canonFile(jpath);
  if (j.mode === 'inplace') {
    if (me !== canonFile(journalOf(j.archive)) || canonFile(j.tail) !== canonFile(tailOf(j.archive))) bad();
    if (j.restoreAt != null && (!str(j.restoreAt) || !path.isAbsolute(j.restoreAt) || canonFile(path.dirname(j.restoreAt)) !== canonFile(path.dirname(j.archive)) || jobFileName(j.restoreAt))) bad();
  } else if (j.mode === 'normal') {
    const dir = path.dirname(path.resolve(jpath));
    if (path.basename(jpath) !== `${j.id}${SUFFIX.journal}` || !str(j.registry) || !sameDir(j.registry, dir) || canonFile(j.tail) !== canonFile(path.join(dir, `${j.id}${SUFFIX.tail}`))) bad();
  } else bad();
  if (Object.values(j.outs || {}).some((o) => !relOk(o))) bad();
  if ((j.aside.moves || []).some((m) => !relOk(m.from) || !relOk(m.to) || m.to !== `${j.aside.dir}/replaced/${m.from}`)) bad();
  if (plan) {
    for (const u of plan.units || []) {
      if (!relOk(u.out)) bad(); if (u.kind === 'aside' && !u.out.startsWith(j.aside.dir + '/')) bad();
      if (j.outs && j.outs[u.i] != null && !ownOutput(u.out, j.outs[u.i])) bad();
      if (j.mode === 'inplace' && !u.bad) { const h = Buffer.from(u.head || '', 'base64'); const ok = plan.format === 'zip' ? h.length >= 30 && h.readUInt32LE(0) === 0x04034b50 : h.length >= 512 && h.length % 512 === 0; if (!ok) bad(); }
    }
    if (Object.keys(j.outs || {}).some((k) => !/^\d+$/.test(k) || Number(k) >= (plan.units || []).length)) bad();
  }
}
/** Whether a path's last name ends like one of a job's own files (any letter case, in any folder). */
const jobFileName = (p) => { const last = String(p).split(/[\\/]/).pop().toLowerCase(); return JOB_SUFFIXES.some((s) => last.endsWith(s)); };
async function openJob(journal) {
  let text; try { text = await fsp.readFile(journal, 'utf8'); } catch { throw fail('journalMissing'); }
  const r = S.journalRead(text); if (!r.ok) throw fail(r.why === 'future' ? 'journalFuture' : r.why === 'v1' ? 'journalV1' : 'journalCorrupt', { body: r.body });
  const j = r.body; let tail; validate(journal, j, null);
  try { tail = await fsp.readFile(j.tail); } catch { throw fail('tailMissing'); }
  if (tail.length !== j.tailLen || S.crc32(tail) !== j.tailCrc) throw fail('tailCorrupt');
  const { plan, raw } = readTail(tail); validate(journal, j, plan);
  if (j.mode === 'inplace' && j.state !== 'done' && !(j.next >= plan.units.length && !exists(j.archive) && !j.restoreAt)) {
    // What is about to be cut or extended must be this job's: its size what the journal says (a restore: its last commit, plus at most the
    // write it announced), and the units' own header bytes where they should be.
    const target = targetOf(j); const restoring = j.state === 'restoring'; const unmade = restoring && j.restoreAt && j.committed === 0 && !j.restored;
    let size = null; try { size = (await fsp.stat(target)).size; } catch { if (!unmade) throw fail('archiveGone'); }
    if (size !== null) {
      const fits = restoring ? size >= j.committed && size <= j.committed + (j.pending || 0) : size === j.committed || size === j.prevCommitted;
      if (!fits) throw fail('archiveChanged');
      const check = [];
      if (!j.restoreAt) { const left = plan.units.length - j.next; if (left > 0) check.push(0, left - 1); }
      if (restoring && j.restored > 0 && j.restored <= j.restoreFrom) { const order = orderOf(j, plan); check.push(order[j.restoreFrom - 1], order[j.restoreFrom - j.restored]); }
      const fd = await fsp.open(target, 'r');
      try { for (const k of new Set(check)) { const u = plan.units[k]; const h = Buffer.from(u.head, 'base64'); if (u.start + h.length > Math.max(size, j.committed)) throw fail('archiveChanged'); if (!(await readAll(fd, u.start, h.length).catch(() => Buffer.alloc(0))).equals(h)) throw fail('archiveChanged'); } } finally { await fd.close(); }
    }
  }
  return { j, plan, raw };
}

/* ---------- writing one unit ---------- */
/** Bytes charged to the volume and counted; a Cancel is heard inside a large file too (asked every 8 MiB). */
function meter(io, onBytes, stopped) { let since = 0; return new Transform({ transform(c, _e, cb) { since += c.length; if (since >= STOP_EVERY) { since = 0; if (stopped?.()) return cb(fail('stopped')); } try { io.charge(c.length); } catch (e) { return cb(e); } onBytes?.(c.length); cb(null, c); } }); }
/** No output is written through a link: every folder from the destination down to the unit's own must be a real folder. */
function throughLink(dest, out) { const parts = out.split('/'); let p = dest; for (let i = 0; i < parts.length - 1; i++) { p = path.join(p, parts[i]); try { if (fs.lstatSync(p).isSymbolicLink()) return true; } catch { return false; } } return false; }
/** This job's part file for a unit: named for the job and the unit alone, made exclusively, beside the output. */
const partOf = (j, u) => path.join(path.dirname(path.join(j.dest, u.out)), `.kt${j.id}-${u.i}${SUFFIX.part}`);
/** The unit log beside a journal: «unit<TAB>name<TAB>crc» for every output placed since the last commit (what a stopped job's leftovers are cleaned by). */
const logOf = (jpath) => jpath + '.log';
/** The log's records (one JSON object per line: {"i","out","crc"} — JSON, so no name can make a second record), each kept only when well formed. */
function parseLog(text) { const out = []; for (const l of String(text).split('\n')) { let o; try { o = JSON.parse(l); } catch { continue; } if (!o || typeof o !== 'object' || Array.isArray(o) || !Number.isInteger(o.i) || o.i < 0 || typeof o.out !== 'string' || !Number.isInteger(o.crc) || o.crc < 0 || o.crc > 0xffffffff) continue; out.push({ i: o.i, out: o.out, crc: o.crc }); } return out; }
function readLog(jpath) { try { return parseLog(fs.readFileSync(logOf(jpath), 'utf8')); } catch { return []; } }
async function logRecord(log, i, out, crc) { const h = await fsp.open(log, 'a'); try { await h.appendFile(JSON.stringify({ i, out, crc }) + '\n'); await h.sync(); } finally { await h.close(); } }
/** Whether a logged name may be a unit's output: its planned name, or a «name (n)» the job gives it in the same folder. */
function ownOutput(planned, out) {
  if (out === planned) return true; const d0 = path.posix.dirname(planned), d1 = path.posix.dirname(out); if (d0 !== d1) return false;
  const n0 = path.posix.basename(planned), n1 = path.posix.basename(out); const dot = n0.lastIndexOf('.'); const base = dot > 0 ? n0.slice(0, dot) : n0; const ext = dot > 0 ? n0.slice(dot) : '';
  if (!n1.startsWith(base + ' (') || !n1.endsWith(')' + ext)) return false; const k = n1.slice(base.length + 2, n1.length - ext.length - 1); return /^[1-9][0-9]{0,8}$/.test(k);
}
/** Flushed through a handle that may write; a failure fails the unit (nothing is cut on an unproved write). */
async function syncFile(p) { const h = await fsp.open(p, 'r+'); try { await h.sync(); } finally { await h.close(); } }
async function writeUnit(fd, u, j, ctx) {
  const dest = j.dest; const target = path.join(dest, u.out);
  if (throughLink(dest, u.out)) throw fail('throughLink ' + u.name);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  if (!OWN_METHODS.includes(u.method)) throw fail(`unsupportedMethod ${u.method} ${u.name}`);
  const part = partOf(j, u); const st = { crc: 0, raw: 0 };
  const rawTap = new Transform({ transform(c, _e, cb) { st.raw = S.crc32(c, st.raw); cb(null, c); } });
  const chain = [rangeStream(fd, u.dataStart, u.csize), rawTap, ...(u.encrypted ? [zipCryptoStream(ctx.password || '', u.dd ? (u.time >> 8) & 0xff : u.crc >>> 24)] : []), ...(u.method === 8 ? [zlib.createInflateRaw()] : []), new Transform({ transform(c, _e, cb) { st.crc = S.crc32(c, st.crc); cb(null, c); } }), meter(ctx.io, ctx.tick, ctx.stopped), fs.createWriteStream(part, { flags: 'wx' })];
  try { await pipeline(chain); await syncFile(part); } catch (e) { const sz = exists(part) ? fs.statSync(part).size : 0; await fsp.rm(part, { force: true }); ctx.io.release(sz); throw e.code === 'ENOSPC' ? fail('noSpace') : e.message === 'stopped' ? fail('stopped') : e; }
  if (ctx.format === 'zip' && st.crc !== u.crc) { const sz = fs.statSync(part).size; await fsp.rm(part, { force: true }); ctx.io.release(sz); throw fail('crcMismatch ' + u.name); }
  // A file that appeared since the pre-flight is never overwritten: ours takes the next free «name (n)» (a hard link that fails when the name is taken; a rename after a check where links cannot be made).
  let out = u.out; let first = true;
  for (;;) {
    const at = path.join(dest, out);
    if (!exists(at)) {
      // (Recorded as this job's own BEFORE it is linked: a crash after the link leaves nothing unrecorded; nothing the job did not write is ever removed.)
      try { await logRecord(logOf(ctx.jpath), u.i, out, st.crc); } catch (e) { await fsp.rm(part, { force: true }); throw fail(`syncFailed ${u.name} ${e.message}`); }
      let placed = false; try { await fsp.link(part, at); await fsp.rm(part, { force: true }); placed = true; } catch (e) { if (e.code !== 'EEXIST') { if (!exists(at)) { await fsp.rename(part, at); placed = true; } } }
      // (A crash right after the link: the name is in the log, so a Finish removes it — never «name (2)» beside it.)
      if (placed) { await ctx.io.crash('placed'); break; }
    }
    const dir = path.posix.dirname(u.out); const nm = S.keepBothName(path.posix.basename(u.out), (c) => exists(path.join(dest, dir === '.' ? c : `${dir}/${c}`))); out = dir === '.' ? nm : `${dir}/${nm}`;
    if (first) { ctx.appeared.push(u.name); first = false; }
  }
  try { await syncFile(path.join(dest, out)); } catch (e) { await fsp.rm(path.join(dest, out), { force: true }); throw fail(`syncFailed ${u.name} ${e.message}`); }
  return { out, crc: st.crc, raw: st.raw };
}

/* ---------- running a job ---------- */
/**
 * Extract `file` into `dest`. o = { inPlace, answers, password, verifyFirst, keepFree, platform, skip (names to leave:
 * damaged ones), only, registry }. Refused before any change when the pre-flight says so. → { files, dest, job, appeared, damaged }.
 */
async function extract(file, dest, o, pr, io = realIo) {
  const unlock = await takeLock(file);
  try {
    if (exists(journalOf(file))) throw fail('journalExists');
    const platform = o.platform || hostPlatform();
    const { facts: f, scan } = await facts(file, dest, { password: o.password, verify: !!(o.inPlace && o.verifyFirst), platform, io, pr });
    f.busy = false; // (this job holds the lock)
    if (o.skip?.length) f.damaged = (f.damaged || []).filter((n) => !o.skip.includes(n));
    const rep = S.preflight(f, { margin: o.keepFree || 0 });
    const mode = o.inPlace ? rep.inPlace : rep.normal;
    if (!mode.ok) { const first = rep.problems.find((p) => mode.why.includes(p.kind)) || { kind: mode.why[0], names: [] }; throw fail(`refused ${first.kind}${first.names?.length ? ' ' + first.names[0] : ''}`, { report: rep, nothingChanged: true }); }
    const id = crypto.randomBytes(6).toString('hex');
    const { units, moves, aside } = planOuts(scan, dest, platform, o.answers, !!o.inPlace, id, o.skip);
    if (o.only) for (const u of units) if (!(o.only.some((w) => u.name === w || (w.endsWith('/') && u.name.startsWith(w))))) u.kind = 'skip';
    await fsp.mkdir(dest, { recursive: true });
    // The plan and the archive's own tail saved (CRC'd) before the first change; then the journal; then the aside moves.
    const fd0 = await fsp.open(file, 'r'); let raw, heads;
    // (Only an in-place job keeps the archive's own tail — and only a sane one: past MAX_TAIL the job is refused.)
    const tailLen = Math.max(0, scan.size - scan.tailStart); if (o.inPlace && tailLen > MAX_TAIL) throw fail('refused layout', { nothingChanged: true });
    try { raw = o.inPlace ? await readAll(fd0, scan.tailStart, tailLen) : Buffer.alloc(0); heads = []; for (const u of units) if (scan.units[u.i].bad) heads.push({ head: '', trail: '' }); else heads.push({ head: (await readAll(fd0, u.start, u.dataStart - u.start)).toString('base64'), trail: (await readAll(fd0, u.dataEnd, u.end - u.dataEnd)).toString('base64') }); } finally { await fd0.close(); }
    const plan = { format: scan.format, size: scan.size, tailStart: scan.tailStart, idCrc: scan.idCrc, dest: path.resolve(dest), units: units.map((u, k) => ({ ...u, ...heads[k], cd: scan.units[k].cd ? scan.units[k].cd.toString('base64') : undefined })) };
    const registry = o.registry || io.registry; const jpath = o.inPlace ? journalOf(file) : path.join(registry, `${id}${SUFFIX.journal}`); if (!o.inPlace) await fsp.mkdir(registry, { recursive: true });
    const tpath = o.inPlace ? tailOf(file) : path.join(registry, `${id}${SUFFIX.tail}`);
    const tb = tailBuffer(plan, o.inPlace ? raw : Buffer.alloc(0));
    try { io.charge(tb.length); await writeAtomic(tpath, tb); } catch (e) { await fsp.rm(tpath, { force: true }); await fsp.rm(tpath + '.tmp', { force: true }); throw e.code === 'ENOSPC' ? fail('noSpace', { nothingChanged: true }) : e; }
    await io.crash('tail');
    if (registry) await register(registry, jpath, id);
    const j = { registry: registry || null, id, mode: o.inPlace ? 'inplace' : 'normal', format: scan.format, archive: path.resolve(file), dest: path.resolve(dest), tail: tpath, tailLen: tb.length, tailCrc: S.crc32(tb), committed: scan.size, prevCommitted: scan.size, next: 0, outs: {}, raws: {}, aside: { dir: aside, moves, moved: 0 }, state: 'running', platform, created: Date.now(), password: !!o.password };
    await saveJournal(jpath, j, io);
    return await run(jpath, j, plan, { pr, io, password: o.password, keepFree: o.keepFree || 0 });
  } finally { await unlock(); }
}
/** Moves the old items aside (journalled count; a move already done is seen as done). */
async function settleAside(jpath, j, io) {
  for (let k = j.aside.moved; k < j.aside.moves.length; k++) {
    const m = j.aside.moves[k]; const from = path.join(j.dest, m.from), to = path.join(j.dest, m.to);
    if (exists(from) && !exists(to)) { await fsp.mkdir(path.dirname(to), { recursive: true }); await fsp.rename(from, to); }
    j.aside.moved = k + 1; await saveJournal(jpath, j, io);
  }
}
/** Outputs of units not committed yet (a crash or a stop mid-batch): removed so the run goes on exactly. */
/** Outputs of units not committed yet (a crash or a stop mid-batch): removed so the run goes on exactly — only what this job wrote: its part files
 *  (named for this job alone; an older build's «<out>.kt-part» left alone) and the outputs its unit log records (the name each got, «name (2)» too),
 *  each only while it is still as written (same size and CRC). Nothing else at those names is touched. */
async function clearUncommitted(jpath, j, plan, io) {
  const order = orderOf(j, plan); const open = new Set(order.slice(j.next));
  for (const i of open) { const u = plan.units[i]; if (u.kind !== 'file' && u.kind !== 'aside') continue; const p = partOf(j, u); if (exists(p)) { const sz = fs.lstatSync(p).size; await fsp.rm(p, { force: true }); io.release(sz); } }
  for (const r of readLog(jpath)) { if (!open.has(r.i) || !plan.units[r.i] || !ownOutput(plan.units[r.i].out, r.out)) continue; const t = path.join(j.dest, r.out); let st; try { st = fs.lstatSync(t); } catch { continue; } if (st.isFile() && st.size === plan.units[r.i].usize && (await fileCrc(t)) === r.crc) { await fsp.rm(t, { force: true }); io.release(st.size); } }
  await fsp.rm(logOf(jpath), { force: true });
}
async function fileCrc(p) { let c = 0; for await (const b of fs.createReadStream(p, { highWaterMark: 1 << 20 })) c = S.crc32(b, c); return c; }
/** The CRC a unit's file must have: the archive's (ZIP), or the one taken while it was written (tar keeps none). */
const crcOf = (j, u) => u.crc ?? j.raws[u.i];
const orderOf = (j, plan) => (j.mode === 'inplace' ? plan.units.map((_, i) => plan.units.length - 1 - i) : plan.units.map((_, i) => i));

async function run(jpath, j, plan, ctx) {
  const { pr, io } = ctx; const order = orderOf(j, plan); const appeared = []; const damaged = []; let files = 0;
  await settleAside(jpath, j, io); await io.crash('aside');
  const fd = await fsp.open(j.archive, j.mode === 'inplace' ? 'r+' : 'r'); const sizeNow = (await fd.stat()).size;
  try {
    if (j.mode === 'inplace' && sizeNow > j.committed) { await fd.truncate(j.committed); await fd.sync().catch(() => {}); io.release(sizeNow - j.committed); }
    const total = plan.units.reduce((a, u) => a + (u.kind === 'file' || u.kind === 'aside' ? u.usize : 0), 0); let done = 0; for (let x = 0; x < j.next; x++) { const u = plan.units[order[x]]; if (u.kind === 'file' || u.kind === 'aside') done += u.usize; }
    const wctx = { io, jpath, password: ctx.password, format: plan.format, appeared, stopped: () => !!pr?.stopped?.(), tick: (n) => { done += n; pr?.on?.(done, total, cur); } }; let cur = '';
    let k = j.next;
    while (k < order.length) {
      if (pr?.stopped?.()) { j.state = 'paused'; await saveJournal(jpath, j, io); throw fail('stopped', { journal: jpath }); }
      const free = (await io.freeSpace(j.dest)) - ctx.keepFree; let used = 0; let end = k; const written = []; const wcrc = [];
      while (end < order.length && end - k < BATCH.count && (end === k || used + plan.units[order[end]].usize <= Math.min(free < 0 ? Infinity : free, BATCH.bytes))) { used += plan.units[order[end]].usize; end++; }
      if (free >= 0 && plan.units[order[k]].usize > free) { j.state = 'paused'; j.why = 'noSpace'; await saveJournal(jpath, j, io); throw fail('noSpace', { journal: jpath, kept: files }); }
      try {
        for (let x = k; x < end; x++) {
          const u = plan.units[order[x]]; cur = u.name;
          if (u.kind === 'dir') { if (throughLink(j.dest, u.out + '/x')) throw fail('throughLink ' + u.name); await fsp.mkdir(path.join(j.dest, u.out), { recursive: true }); continue; }
          if (u.kind === 'link' || u.kind === 'skip') continue;
          let r; try { r = await writeUnit(fd, u, j, wctx); } catch (e) { if (!e.crash && j.mode === 'normal' && /^crcMismatch /.test(e.message)) { damaged.push(u.name); continue; } throw e; }   // (a normal job leaves a damaged file out and goes on; in place stops at the last commit)
          written.push(r.out); wcrc.push(r.crc); if (r.out !== u.out) j.outs[u.i] = r.out; else delete j.outs[u.i]; j.raws[u.i] = r.raw; if (u.kind === 'file') files++;
          await io.crash('unit');
        }
        // Commit: each file was flushed as it was placed; then their folders (where the system can); and, before an archive is cut, each read back and its CRC compared.
        for (const d of new Set(written.map((w) => path.dirname(path.join(j.dest, w))))) await fsyncPath(d, true);
        if (j.mode === 'inplace') for (let x = 0; x < written.length; x++) if ((await fileCrc(path.join(j.dest, written[x]))) !== wcrc[x]) throw fail('readBack ' + written[x]);
      } catch (e) {
        if (e.crash) throw e;
        // (This batch's own outputs are not committed: removed — a file that failed its read-back is bad, and a Finish then writes it again under its own name, never «name (2)» beside a bad one.)
        for (const w of written) { const p = path.join(j.dest, w); try { const sz = fs.lstatSync(p).size; await fsp.rm(p, { force: true }); io.release(sz); } catch { /* gone */ } }
        for (let x = k; x < end; x++) delete j.outs[plan.units[order[x]].i];
        const m = String(e.message || e); j.state = 'paused'; j.why = m.split(' ')[0]; await clearUncommitted(jpath, j, plan, io); await saveJournal(jpath, j, io); throw fail(m, { journal: jpath, kept: files });
      }
      await io.crash('synced');
      j.next = end; j.prevCommitted = j.committed; if (j.mode === 'inplace') j.committed = plan.units[order[end - 1]].start;
      await saveJournal(jpath, j, io); await fsp.rm(logOf(jpath), { force: true });
      if (j.mode === 'inplace') { const before = (await fd.stat()).size; await fd.truncate(j.committed); await fd.sync().catch(() => {}); io.release(before - j.committed); await io.crash('cut'); }
      k = end;
    }
    pr?.on?.(total, total, '');
  } finally { await fd.close(); }
  // Done: «done» saved first, then the archive extracted in place (this run holds the lock and has just cut it) removed — a power loss between
  // the two leaves a finished job and an empty file it removes later (removeLeftover), never a job that can do nothing.
  for (const u of plan.units) if (u.bad && !damaged.includes(u.name)) damaged.push(u.name);
  j.state = 'done'; j.finished = Date.now(); j.damaged = damaged; await saveJournal(jpath, j, io);
  if (j.mode === 'inplace') await fsp.rm(j.archive, { force: true });
  return { files, dest: j.dest, job: jpath, appeared, damaged, undo: true };
}

/** A stopped or crashed job taken up again from its journal. */
/** An in-place job's archive after its last cut: nothing left in it (size 0, the last commit 0) — removed; any other file there is left alone. */
function removeLeftover(j) { try { const st = fs.lstatSync(j.archive); if (j.mode === 'inplace' && j.committed === 0 && st.isFile() && st.size === 0) fs.rmSync(j.archive, { force: true }); } catch { /* not there */ } }
/** The password proved against a locked unit still in the archive before a Finish: none → «passwordNeeded»; wrong → «wrongPassword». */
async function finishPassword(j, plan, password) {
  const order = orderOf(j, plan); const left = order.slice(j.next).map((i) => plan.units[i]).filter((u) => u.encrypted && (u.kind === 'file' || u.kind === 'aside')); if (!left.length) return;
  if (!password) throw fail('passwordNeeded'); const r = await checkPassword(j.archive, { units: left }, password); if (r !== 'ok') throw fail('wrongPassword');
}
/** A job found beside an archive (journal v2) finished — only an in-place job of that very archive; anything else there is never replayed. */
async function finishBeside(file, pr, io = realIo, o = {}) { const jp = journalOf(file); const { j } = await openJob(jp); if (j.mode !== 'inplace' || canonFile(j.archive) !== canonFile(file)) throw fail('journalCorrupt'); return finish(jp, pr, io, o); }
async function finish(jpath, pr, io = realIo, o = {}) {
  const { j, plan } = await openJob(jpath);
  // (Every unit out and the archive gone: a power loss after the last cut — finished.)
  if (!['done', 'restoring', 'undoing'].includes(j.state) && j.mode === 'inplace' && j.next >= plan.units.length && !exists(j.archive)) { j.state = 'done'; j.finished = Date.now(); await saveJournal(jpath, j, io); }
  if (j.state === 'done') { removeLeftover(j); return { files: 0, dest: j.dest, job: jpath, appeared: [], damaged: j.damaged || [], undo: true }; }
  if (j.state === 'restoring' || j.state === 'undoing') throw fail('restoreUnfinished');
  const unlock = await takeLock(j.archive);
  try { await finishPassword(j, plan, o.password); await clearUncommitted(jpath, j, plan, io); j.state = 'running'; delete j.why; await saveJournal(jpath, j, io); return await run(jpath, j, plan, { pr, io, password: o.password, keepFree: o.keepFree || 0 }); }
  finally { await unlock(); }
}

/** A unit's data made again from its extracted file: stored as is; deflated only when it squeezes back to the same bytes. */
function rebuildData(u, buf, rawCrc) {
  if (u.method === 0 && !u.encrypted) return buf.length === u.csize && S.crc32(buf) === (u.crc ?? rawCrc) ? buf : null;
  if (u.method !== 8 || u.encrypted) return null;
  for (const level of [6, 9, 1, 5, 4, 3, 2, 7, 8]) for (const memLevel of [8, 9]) { const d = zlib.deflateRawSync(buf, { level, memLevel }); if (d.length === u.csize && S.crc32(d) === rawCrc) return d; }
  return null;
}
/**
 * Give up and put the archive back: every extracted unit appended again in order (its own header bytes, its data from
 * the file, its trailing bytes), then the saved tail — the original archive byte for byte. A unit that cannot be made
 * again exactly stops the appending: the archive is closed there as a smaller whole one and the files from there on
 * stay extracted. Old items moved aside are put back; what was extracted (and put back) is removed.
 * → { identical, back (units put back), keptOut (names left extracted) }.
 */
async function restore(jpath, io = realIo) {
  const { j, plan, raw } = await openJob(jpath); const unlock = j.mode === 'inplace' ? await takeLock(j.archive) : async () => {};
  try {
    if (j.mode === 'normal') return await undoNormal(jpath, j, plan, io);
    if (j.state !== 'restoring') {
      if (j.state !== 'done') await clearUncommitted(jpath, j, plan, io);
      // (Every unit out and the archive gone — a power loss after the last cut — is a finished job too.)
      const finished = j.state === 'done' || (j.next >= plan.units.length && !exists(j.archive)); if (finished) removeLeftover(j);
      j.restoreFrom = finished ? plan.units.length : j.next;
      // (The archive was removed when the job finished: whatever is at its path now is not this job's and is never touched — the archive is
      //  made again beside it under a free name, said in the answer: `restoredTo`.)
      if (finished) { const dir = path.dirname(j.archive); j.restoreAt = exists(j.archive) ? path.join(dir, S.keepBothName(path.basename(j.archive), (c) => exists(path.join(dir, c)))) : j.archive; j.committed = 0; }
      j.state = 'restoring'; j.restored = 0; delete j.pending; await saveJournal(jpath, j, io);
    }
    const target = targetOf(j);
    // (Made by this restore alone: exclusively, so a file that took the name meanwhile is never written into.)
    // (Always created exclusively — never an exists-check first; the one file accepted already there is the empty one this restore made before a crash.)
    if (j.restoreAt && j.committed === 0 && !j.restored) { try { await fsp.writeFile(target, Buffer.alloc(0), { flag: 'wx' }); } catch (e) { let empty = false; try { const st = fs.lstatSync(target); empty = st.isFile() && st.size === 0; } catch { /* gone */ } if (e.code !== 'EEXIST' || !empty) throw fail('archiveChanged'); } }
    const order = orderOf(j, plan); const back = []; let stopAt = -1;
    // (A restore taken up again: a unit already appended whose file a crash left behind is removed now.)
    for (let k = j.restoreFrom - j.restored; k < j.restoreFrom; k++) { const u = plan.units[order[k]]; if (u.kind !== 'file' && u.kind !== 'aside') continue; const p = path.join(j.dest, j.outs[u.i] || u.out); if (exists(p) && (await fileCrc(p)) === crcOf(j, u)) await fsp.rm(p, { force: true }); }
    const fd = await fsp.open(target, 'r+');
    try {
      // (openJob proved what lies past the last commit is this restore's own unfinished write: cut off again.)
      let size = (await fd.stat()).size; if (size > j.committed) { await fd.truncate(j.committed); size = j.committed; }
      // Units go back lowest offset first: the reverse of the order they came out.
      for (let k = j.restoreFrom - 1 - j.restored; k >= 0; k--) {
        const u = plan.units[order[k]]; if (u.start !== j.committed) { stopAt = k; break; }
        let data = Buffer.alloc(0);
        if (u.kind === 'file' || u.kind === 'aside') { const p = path.join(j.dest, j.outs[u.i] || u.out); let buf; try { buf = await fsp.readFile(p); } catch { stopAt = k; break; } data = rebuildData(u, buf, j.raws[u.i]); if (!data) { stopAt = k; break; } }
        else if (u.kind === 'skip') { stopAt = k; break; }
        const bytes = Buffer.concat([Buffer.from(u.head, 'base64'), data, Buffer.from(u.trail, 'base64')]);
        // (The write announced first: a restore killed in it finds exactly so many bytes of its own past the commit.)
        io.charge(bytes.length); j.pending = bytes.length; await saveJournal(jpath, j, io); await fd.write(bytes, 0, bytes.length, j.committed); await fd.sync();
        j.committed += bytes.length; j.restored++; delete j.pending; await saveJournal(jpath, j, io); back.push(u);
        if (u.kind === 'file' || u.kind === 'aside') { const p = path.join(j.dest, j.outs[u.i] || u.out); const sz = fs.statSync(p).size; await fsp.rm(p, { force: true }); io.release(sz); }
      }
      // The end: the saved tail (all units back: identical), else a new directory over what is there (ZIP; ZIP64 records when they are needed) or two zero blocks (tar).
      let end;
      if (j.restoreFrom === 0) end = Buffer.alloc(0);   // (nothing was ever cut: the archive is whole already)
      else if (stopAt < 0) end = raw;
      else if (plan.format === 'tar') end = Buffer.alloc(1024);
      else { const kept = plan.units.filter((u) => u.end <= j.committed); const cd = Buffer.concat(kept.map((u) => Buffer.from(u.cd || '', 'base64'))); end = Buffer.concat([cd, zipEnd(kept.length, cd.length, j.committed)]); }
      if (end.length) { j.pending = end.length; await saveJournal(jpath, j, io); await fd.write(end, 0, end.length, j.committed); }
      await fd.truncate(j.committed + end.length); await fd.sync(); io.charge(end.length);
    } finally { await fd.close(); }
    await io.crash('restored');
    const originals = await putBack(j, io); const keptOut = stopAt < 0 ? [] : order.slice(0, stopAt + 1).map((i) => plan.units[i]).filter((u) => u.kind === 'file').map((u) => u.name);
    await removeDirs(j, plan); const asideKept = await forget(jpath, j);
    return { identical: stopAt < 0, back: back.length, keptOut, originals, ...(targetOf(j) !== j.archive ? { restoredTo: targetOf(j) } : {}), ...(asideKept ? { asideKept } : {}) };
  } finally { await unlock(); }
}
/** A ZIP's end records for `count` entries whose directory (`cdLen` bytes) starts at `cdStart`: the ZIP64 record and its locator first when a
 *  count or an offset does not fit the plain record (65,535 entries, 4 GB). */
function zipEnd(count, cdLen, cdStart) {
  const z64 = count >= 0xffff || cdLen >= 0xffffffff || cdStart >= 0xffffffff; const parts = [];
  if (z64) { const z = Buffer.alloc(56); z.writeUInt32LE(0x06064b50, 0); z.writeBigUInt64LE(44n, 4); z.writeUInt16LE(45, 12); z.writeUInt16LE(45, 14); z.writeBigUInt64LE(BigInt(count), 24); z.writeBigUInt64LE(BigInt(count), 32); z.writeBigUInt64LE(BigInt(cdLen), 40); z.writeBigUInt64LE(BigInt(cdStart), 48);
    const l = Buffer.alloc(20); l.writeUInt32LE(0x07064b50, 0); l.writeBigUInt64LE(BigInt(cdStart + cdLen), 8); l.writeUInt32LE(1, 16); parts.push(z, l); }
  const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Math.min(count, 0xffff), 8); e.writeUInt16LE(Math.min(count, 0xffff), 10); e.writeUInt32LE(Math.min(cdLen, 0xffffffff), 12); e.writeUInt32LE(Math.min(cdStart, 0xffffffff), 16); parts.push(e);
  return Buffer.concat(parts);
}
/** «name (original).ext» — then «name (original 2).ext»… — the first not taken. */
function originalName(name, taken) { const dot = name.lastIndexOf('.'); const base = dot > 0 ? name.slice(0, dot) : name; const ext = dot > 0 ? name.slice(dot) : ''; for (let i = 1; ; i++) { const c = i === 1 ? `${base} (original)${ext}` : `${base} (original ${i})${ext}`; if (!taken(c)) return c; } }
/** The old items moved aside put back where they were; where the name is taken now (the extracted file edited and kept, a unit that stayed out),
 *  under «name (original)» beside it — never left behind, never over anything. → the names put back under another name. */
async function putBack(j, io) {
  const other = [];
  for (let k = j.aside.moved - 1; k >= 0; k--) {
    const m = j.aside.moves[k]; const from = path.join(j.dest, m.to); if (!exists(from)) continue;
    let rel = m.from; if (exists(path.join(j.dest, rel))) { const dir = path.posix.dirname(m.from); const nm = originalName(path.posix.basename(m.from), (c) => exists(path.join(j.dest, dir === '.' ? c : `${dir}/${c}`))); rel = dir === '.' ? nm : `${dir}/${nm}`; other.push(rel); }
    const to = path.join(j.dest, rel); await fsp.mkdir(path.dirname(to), { recursive: true });
    try { await fsp.link(from, to); await fsp.rm(from, { force: true }); } catch (e) { if (e.code !== 'EEXIST' && !exists(to)) await fsp.rename(from, to); }
  }
  void io; return other;
}
/** Folders the job made, removed when empty (deepest first). */
async function removeDirs(j, plan) { const dirs = new Set(); for (const u of plan.units) { const parts = u.out.split('/'); for (let i = 1; i <= parts.length - (u.kind === 'dir' ? 0 : 1); i++) dirs.add(parts.slice(0, i).join('/')); } for (const d of [...dirs].sort((a, b) => b.length - a.length)) { try { await fsp.rmdir(path.join(j.dest, d)); } catch { /* not empty or not ours */ } } }
/** Whether a folder holds anything but empty folders. */
function holdsFiles(d) { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return false; } return es.some((e) => (e.isDirectory() ? holdsFiles(path.join(d, e.name)) : true)); }
/** The job's own records removed (journal, tail, unit log, registry pointer). The aside folder only when nothing is left in it: anything still
 *  there (an original that could not go back, an entry set aside in place) is kept → that folder. `ended`: the Undo offer ended (dismissed, or a
 *  finished job tidied at start) — the replaced originals' folder goes then (the user chose «replace»: the replace completing); what an in-place
 *  job set aside (entries skipped or damaged: the archive is gone, they exist nowhere else) is kept. */
async function forget(jpath, j, ended = false) {
  const asideAbs = path.join(j.dest, j.aside.dir || ''); let kept = null;
  if (j.aside.dir && exists(asideAbs)) { if (ended) await fsp.rm(path.join(asideAbs, 'replaced'), { recursive: true, force: true }); if (holdsFiles(asideAbs)) kept = asideAbs; else await fsp.rm(asideAbs, { recursive: true, force: true }); }
  // (The journal first: a crash in between leaves at most a tail nobody reads, never a journal whose tail is gone.)
  await fsp.rm(jpath, { force: true }); await fsp.rm(logOf(jpath), { force: true }); await fsp.rm(j.tail, { force: true }); if (j.registry) await fsp.rm(path.join(j.registry, `${j.id}.ref`), { force: true });
  return kept;
}
/** A normal job undone: what it wrote removed (only a file still as it wrote it), what it moved aside put back. */
async function undoNormal(jpath, j, plan, io) {
  const upto = j.state === 'done' ? plan.units.length : j.next; if (j.state !== 'done' && j.state !== 'undoing') await clearUncommitted(jpath, j, plan, io);
  j.state = 'undoing'; j.upto = j.upto ?? upto; await saveJournal(jpath, j, io); const order = orderOf(j, plan); let removed = 0; const changed = [];
  for (let k = 0; k < j.upto; k++) { const u = plan.units[order[k]]; if (u.kind !== 'file') continue; const p = path.join(j.dest, j.outs[u.i] || u.out); if (!exists(p)) continue; if ((await fileCrc(p)) === crcOf(j, u)) { const sz = fs.statSync(p).size; await fsp.rm(p, { force: true }); io.release(sz); removed++; } else changed.push(u.name); }
  const originals = await putBack(j, io); await removeDirs(j, plan); const asideKept = await forget(jpath, j); return { identical: true, back: 0, removed, keptOut: changed, originals, ...(asideKept ? { asideKept } : {}) };
}
/** Undo a finished job (in place: the archive made again whole; normal: its files removed); both put the old items back. */
async function undo(jpath, io = realIo) { return restore(jpath, io); }
/** The Undo offer ended: the aside folder, the saved tail and the journal removed. */
async function dismiss(jpath) { const { j } = await openJob(jpath).catch(async (e) => { const t = await fsp.readFile(jpath, 'utf8').catch(() => ''); const r = S.journalRead(t); if (r.ok) { validate(jpath, r.body, null); return { j: r.body }; } throw e; }); if (j.state !== 'done') throw fail('notDone'); const asideKept = await forget(jpath, j, true); return asideKept ? { asideKept } : {}; }

/**
 * The shelf: every job the registry knows. Finished ones whose Undo offer ended (older than `undoMs`, or every finished
 * one at start) are cleaned; the rest come back with what can be done: { journal, id, archive, dest, mode, state, done,
 * total, why, can: [finish|restore|leave] }.
 */
async function shelf(registry, o = {}) {
  const out = []; let names = []; try { names = await fsp.readdir(registry); } catch { return out; }
  for (const n of names.filter((x) => x.endsWith('.ref'))) {
    const ref = path.join(registry, n); const jpath = (await fsp.readFile(ref, 'utf8').catch(() => '')).trim();
    if (!jpath || !exists(jpath)) { await fsp.rm(ref, { force: true }); continue; }
    try {
      const { j, plan } = await openJob(jpath);
      if (j.state === 'done') { if (o.atStart || Date.now() - (j.finished || 0) > (o.undoMs ?? 3600e3)) { await forget(jpath, { ...j, registry }, true); continue; } out.push({ journal: jpath, id: j.id, archive: j.archive, dest: j.dest, mode: j.mode, state: 'done', done: plan.units.length, total: plan.units.length, can: ['undo', 'dismiss'] }); continue; }
      out.push({ journal: jpath, id: j.id, archive: j.archive, dest: j.dest, mode: j.mode, state: j.state, why: j.why, done: j.next, total: plan.units.length, can: j.state === 'restoring' || j.state === 'undoing' ? ['restore', 'leave'] : ['finish', 'restore', 'leave'] });
    } catch (e) {
      const why = String(e.message || e); const body = e.body || {};
      out.push({ journal: jpath, id: n.replace(/\.ref$/, ''), archive: body.archive || jpath.replace(/\.kurokawa-unzip$/, ''), dest: body.dest || body.output || '', mode: body.mode || 'inplace', state: 'blocked', why, done: 0, total: 0, can: why === 'journalV1' ? ['restoreV1', 'leave'] : ['leave'] });
    }
  }
  return out;
}
/** A job registered so the shelf finds it (in-place jobs written by the phone or an older build: their journal beside the archive). */
async function register(registry, jpath, id) { await fsp.mkdir(registry, { recursive: true }); await writeAtomic(path.join(registry, `${id}.ref`), jpath); }

/** What is still in an archive whose in-place job (journal v2 beside it) is unfinished: the units not taken out yet (a v1 reader would read the saved tail as a directory). */
async function leftOf(file) { const { j, plan } = await openJob(journalOf(file)); const n = plan.units.length; const left = j.mode === 'inplace' && j.state !== 'restoring' ? n - j.next : n; return { format: plan.format, entries: plan.units.slice(0, left).map((u) => ({ path: u.name, size: u.usize, compressed: u.csize, dir: u.dir })) }; }
module.exports = { finishBeside, parseLog, ownOutput, jobFileName, leftOf, planOuts, zipEnd, extract, finish, restore, undo, dismiss, shelf, register, facts, preflightOf: async (file, dest, o) => { const { facts: f } = await facts(file, dest, o); return { facts: f, report: S.preflight(f, { margin: o.keepFree || 0 }) }; }, unitsOf, checkPassword, verifyAll, openJob, BATCH, SUFFIX, OWN_METHODS, hostPlatform, Crash, journalOf, tailOf };
