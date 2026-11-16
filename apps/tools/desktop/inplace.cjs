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
const hostPlatform = () => (process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux');
const realIo = { freeSpace: async (d) => freeSpace(d), charge() {}, release() {}, async crash() {} };
class Crash extends Error { constructor(p) { super('crash ' + p); this.crash = true; } }
const fail = (code, extra) => Object.assign(new Error(code), extra || {});

async function freeSpace(dir) {
  let d = path.resolve(String(dir || '.'));
  for (let i = 0; i < 40; i++) { try { const s = await fsp.statfs(d); return Number(s.bavail) * Number(s.bsize); } catch { const up = path.dirname(d); if (up === d) break; d = up; } }
  return -1;
}
async function nearestDir(p) { let d = path.resolve(p); for (let i = 0; i < 60; i++) { try { if ((await fsp.stat(d)).isDirectory()) return d; } catch { /* up */ } const up = path.dirname(d); if (up === d) return d; d = up; } return d; }
async function fsyncPath(p, dir = false) { let h; try { h = await fsp.open(p, dir ? 'r' : 'r+'); await h.sync(); } catch { /* a system without directory sync */ } finally { await h?.close().catch(() => {}); } }
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
    while (xp + 4 <= xe) { const id = cd.readUInt16LE(xp), sz = cd.readUInt16LE(xp + 2); if (id === 1) { let q = xp + 4; if (it.usize === 0xffffffff) { it.usize = Number(cd.readBigUInt64LE(q)); q += 8; } if (it.csize === 0xffffffff) { it.csize = Number(cd.readBigUInt64LE(q)); q += 8; } if (it.offset === 0xffffffff) it.offset = Number(cd.readBigUInt64LE(q)); zip64 = true; } if (id === 0x9901 && sz >= 7) { it.aes = { strength: cd[xp + 8], method: cd.readUInt16LE(xp + 9) }; } xp += 4 + sz; }
    it.cd = cd.subarray(p, p + 46 + nl + xl + cl); it.dir = it.name.endsWith('/'); p += 46 + nl + xl + cl; items.push(it);
  }
  items.sort((a, b) => a.offset - b.offset); tailStart = cdOff;
  const layoutBad = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i]; it.start = it.offset; it.end = i + 1 < items.length ? items[i + 1].offset : tailStart;
    if (it.offset + 30 > size) { layoutBad.push(it.name); it.bad = true; continue; }
    const h = await readAll(fd, it.offset, 30);
    if (h.readUInt32LE(0) !== 0x04034b50) { layoutBad.push(it.name); it.bad = true; continue; }
    const lnl = h.readUInt16LE(26), lxl = h.readUInt16LE(28); it.dataStart = it.offset + 30 + lnl + lxl; it.dataEnd = it.dataStart + it.csize; it.dd = !!(h.readUInt16LE(6) & 8);
    const lname = await readAll(fd, it.offset + 30, lnl);
    // The local header must say what the directory says (else two readers would see two archives: refused in place).
    const lm = h.readUInt16LE(8), lcrc = h.readUInt32LE(14), lcs = h.readUInt32LE(18), lus = h.readUInt32LE(22);
    const sizesOk = it.dd || zip64 || (lcrc === it.crc && lcs === it.csize && lus === it.usize) || (lcs === 0xffffffff);
    if (!lname.equals(it.nameRaw) || lm !== it.method || !sizesOk || it.dataEnd > it.end) { layoutBad.push(it.name); it.bad = true; }
  }
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
    if (type === 'L') { longName = (await readAll(fd, data, sz)).toString('utf8').replace(/\0+$/, ''); pos = next; continue; }
    if (type === 'x') { for (const rec of (await readAll(fd, data, sz)).toString('utf8').split('\n')) { const i = rec.indexOf(' path='); if (i > 0) longName = rec.slice(i + 6); } pos = next; continue; }
    if (type === 'g') { pos = next; continue; }
    const nm = (longName ?? name).replace(/^\.\//, ''); const u = { name: nm, start: group, dataStart: data, dataEnd: data + sz, end: next, usize: sz, csize: sz, method: 0, type, dir: type === '5' || nm.endsWith('/'), link: type === '2' ? 'sym' : type === '1' ? 'hard' : undefined, target: link };
    if (!sumOk || next > size) { layoutBad.push(nm); u.bad = true; }
    if (nm && nm !== '.') units.push(u); longName = null; group = -1; pos = next;
  }
  const tailStart = units.length ? units[units.length - 1].end : 0;
  return { format: 'tar', units, tailStart, size, layoutBad, idCrc: units.length ? S.crc32(await readAll(fd, 0, Math.min(512, size))) : 0 };
}
async function formatOf(file) {
  const fd = await fsp.open(file, 'r'); const b = Buffer.alloc(8); try { await fd.read(b, 0, 8, 0); } finally { await fd.close(); }
  if (b[0] === 0x50 && b[1] === 0x4b) return 'zip'; if (/\.tar$/i.test(file)) return 'tar'; return null;
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
  const vols = volumesOf(file); const lock = file + SUFFIX.lock;
  const busy = exists(lock) && lockAlive(lock); const journal = exists(file + SUFFIX.journal);
  const f = {
    format: scan.format, size: scan.size, platform, destLen: S.measure(path.resolve(dest) + path.sep, S.SPEC.platforms[platform].unit),
    entries: scan.units.map((u) => ({ path: u.name, dir: u.dir, link: u.link, target: u.target, method: u.dir ? undefined : u.method, encrypted: u.encrypted, csize: u.csize, usize: u.usize, offset: u.start, unitBytes: u.end - u.start })),
    supported: OWN_METHODS, external: o.external || [], encrypted: scan.units.some((u) => u.encrypted), password, damaged, layoutBad: scan.layoutBad,
    volumes: vols ? { missing: vols.missing, odd: vols.odd } : null, archiveWritable: await writable(file), destWritable: await writable(destDir), saf: /^content:/.test(file), sameVolume, free, existing, busy: busy || journal,
    inPlaceFormat: (scan.format === 'zip' || scan.format === 'tar') && !vols, tailBytes: scan.size - scan.tailStart + scan.units.reduce((a, u) => a + (u.dataStart - u.start) + (u.end - u.dataEnd), 0), blockSize: 4096,
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
      const choice = S.conflictChoice(answers, u.name, false);
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
const journalOf = (file) => file + SUFFIX.journal; const tailOf = (file) => file + SUFFIX.tail;
async function saveJournal(p, body, io) { await writeAtomic(p, S.journalText(body)); await io.crash('journal'); }
/** The tail file: «KTTAIL2», the plan as JSON, then the archive's own tail bytes. */
function tailBuffer(plan, raw) { const j = Buffer.from(JSON.stringify(plan), 'utf8'); return Buffer.concat([Buffer.from(`KTTAIL2\n${j.length}\n`), j, raw]); }
function readTail(buf) { const a = buf.indexOf(10); const b = buf.indexOf(10, a + 1); if (buf.subarray(0, a).toString() !== 'KTTAIL2') throw fail('tailCorrupt'); const n = Number(buf.subarray(a + 1, b).toString()); const plan = JSON.parse(buf.subarray(b + 1, b + 1 + n).toString('utf8')); return { plan, raw: buf.subarray(b + 1 + n) }; }
/** A job's journal read and checked against its archive and tail. → { j, plan, raw } or an error whose message says why it is never replayed. */
async function openJob(journal) {
  let text; try { text = await fsp.readFile(journal, 'utf8'); } catch { throw fail('journalMissing'); }
  const r = S.journalRead(text); if (!r.ok) throw fail(r.why === 'future' ? 'journalFuture' : r.why === 'v1' ? 'journalV1' : 'journalCorrupt', { body: r.body });
  const j = r.body; let tail;
  try { tail = await fsp.readFile(j.tail); } catch { throw fail('tailMissing'); }
  if (tail.length !== j.tailLen || S.crc32(tail) !== j.tailCrc) throw fail('tailCorrupt');
  const { plan, raw } = readTail(tail);
  if (j.mode === 'inplace' && j.state !== 'done') {
    let size; try { size = (await fsp.stat(j.archive)).size; } catch { throw fail('archiveGone'); }
    if (size !== j.committed && size !== j.prevCommitted) throw fail('archiveChanged');
    // The bytes still in the archive must be the units the plan says: each remaining unit's header compared.
    const fd = await fsp.open(j.archive, 'r');
    try { const left = plan.units.length - j.next; for (const k of new Set([0, left - 1])) { if (k < 0 || k >= left) continue; const u = plan.units[k]; const h = Buffer.from(u.head, 'base64'); if (!(await readAll(fd, u.start, h.length).catch(() => Buffer.alloc(0))).equals(h)) throw fail('archiveChanged'); } } finally { await fd.close(); }
  }
  return { j, plan, raw };
}

/* ---------- writing one unit ---------- */
function meter(io, onBytes) { return new Transform({ transform(c, _e, cb) { try { io.charge(c.length); } catch (e) { return cb(e); } onBytes?.(c.length); cb(null, c); } }); }
async function writeUnit(fd, u, dest, ctx) {
  const target = path.join(dest, u.out); await fsp.mkdir(path.dirname(target), { recursive: true });
  const part = target + SUFFIX.part; const st = { crc: 0, raw: 0 };
  const rawTap = new Transform({ transform(c, _e, cb) { st.raw = S.crc32(c, st.raw); cb(null, c); } });
  const chain = [rangeStream(fd, u.dataStart, u.csize), rawTap, ...(u.encrypted ? [zipCryptoStream(ctx.password || '', u.dd ? (u.time >> 8) & 0xff : u.crc >>> 24)] : []), ...(u.method === 8 ? [zlib.createInflateRaw()] : []), new Transform({ transform(c, _e, cb) { st.crc = S.crc32(c, st.crc); cb(null, c); } }), meter(ctx.io, ctx.tick), fs.createWriteStream(part, { flags: 'wx' })];
  if (!OWN_METHODS.includes(u.method)) throw fail(`unsupportedMethod ${u.method} ${u.name}`);
  try { await pipeline(chain); } catch (e) { const sz = exists(part) ? fs.statSync(part).size : 0; await fsp.rm(part, { force: true }); ctx.io.release(sz); throw e.code === 'ENOSPC' ? fail('noSpace') : e; }
  if (ctx.format === 'zip' && st.crc !== u.crc) { const sz = fs.statSync(part).size; await fsp.rm(part, { force: true }); ctx.io.release(sz); throw fail('crcMismatch ' + u.name); }
  // A file that appeared since the pre-flight is never overwritten: ours takes the next free «name (n)».
  let out = u.out; if (exists(target)) { const dir = path.posix.dirname(out); const nm = S.keepBothName(path.posix.basename(out), (c) => exists(path.join(dest, dir === '.' ? c : `${dir}/${c}`))); out = dir === '.' ? nm : `${dir}/${nm}`; ctx.appeared.push(u.name); }
  await fsp.rename(part, path.join(dest, out)); return { out, crc: st.crc, raw: st.raw };
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
    try { raw = await readAll(fd0, scan.tailStart, scan.size - scan.tailStart); heads = []; for (const u of units) heads.push({ head: (await readAll(fd0, u.start, u.dataStart - u.start)).toString('base64'), trail: (await readAll(fd0, u.dataEnd, u.end - u.dataEnd)).toString('base64') }); } finally { await fd0.close(); }
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
async function clearUncommitted(j, plan, io) {
  const order = orderOf(j, plan);
  for (let k = j.next; k < order.length; k++) {
    const u = plan.units[order[k]]; if (u.kind !== 'file' && u.kind !== 'aside') continue; const t = path.join(j.dest, u.out);
    if (exists(t + SUFFIX.part)) { const sz = fs.statSync(t + SUFFIX.part).size; await fsp.rm(t + SUFFIX.part, { force: true }); io.release(sz); }
    if (exists(t)) { const st = fs.statSync(t); if (st.isFile() && st.size === u.usize && (u.crc == null || (await fileCrc(t)) === u.crc)) { await fsp.rm(t, { force: true }); io.release(st.size); } }
  }
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
    const wctx = { io, password: ctx.password, format: plan.format, appeared, tick: (n) => { done += n; pr?.on?.(done, total, cur); } }; let cur = '';
    let k = j.next;
    while (k < order.length) {
      if (pr?.stopped?.()) { j.state = 'paused'; await saveJournal(jpath, j, io); throw fail('stopped', { journal: jpath }); }
      const free = (await io.freeSpace(j.dest)) - ctx.keepFree; let used = 0; let end = k; const written = [];
      while (end < order.length && end - k < BATCH.count && (end === k || used + plan.units[order[end]].usize <= Math.min(free < 0 ? Infinity : free, BATCH.bytes))) { used += plan.units[order[end]].usize; end++; }
      if (free >= 0 && plan.units[order[k]].usize > free) { j.state = 'paused'; j.why = 'noSpace'; await saveJournal(jpath, j, io); throw fail('noSpace', { journal: jpath, kept: files }); }
      try {
        for (let x = k; x < end; x++) {
          const u = plan.units[order[x]]; cur = u.name;
          if (u.kind === 'dir') { await fsp.mkdir(path.join(j.dest, u.out), { recursive: true }); continue; }
          if (u.kind === 'link' || u.kind === 'skip') continue;
          let r; try { r = await writeUnit(fd, u, j.dest, wctx); } catch (e) { if (!e.crash && j.mode === 'normal' && /^crcMismatch /.test(e.message)) { damaged.push(u.name); continue; } throw e; }   // (a normal job leaves a damaged file out and goes on; in place stops at the last commit)
          written.push(r.out); if (r.out !== u.out) j.outs[u.i] = r.out; j.raws[u.i] = r.raw; if (u.kind === 'file') files++;
          await io.crash('unit');
        }
      } catch (e) {
        if (e.crash) throw e;
        const m = String(e.message || e); j.state = 'paused'; j.why = m.split(' ')[0]; await clearUncommitted(j, plan, io); await saveJournal(jpath, j, io); throw fail(m, { journal: jpath, kept: files });
      }
      // Commit: files flushed, the journal moved, then the archive cut back to the batch's first byte.
      for (const w of written) await fsyncPath(path.join(j.dest, w)); for (const d of new Set(written.map((w) => path.dirname(path.join(j.dest, w))))) await fsyncPath(d, true);
      await io.crash('synced');
      j.next = end; j.prevCommitted = j.committed; if (j.mode === 'inplace') j.committed = plan.units[order[end - 1]].start;
      await saveJournal(jpath, j, io);
      if (j.mode === 'inplace') { const before = (await fd.stat()).size; await fd.truncate(j.committed); await fd.sync().catch(() => {}); io.release(before - j.committed); await io.crash('cut'); }
      k = end;
    }
    pr?.on?.(total, total, '');
  } finally { await fd.close(); }
  // Done: an archive extracted in place is gone (its tail kept for Undo until the offer ends); the job stays on the shelf as «done».
  if (j.mode === 'inplace') { await fsp.rm(j.archive, { force: true }); }
  for (const u of plan.units) if (u.bad && !damaged.includes(u.name)) damaged.push(u.name);
  j.state = 'done'; j.finished = Date.now(); j.damaged = damaged; await saveJournal(jpath, j, io);
  return { files, dest: j.dest, job: jpath, appeared, damaged, undo: true };
}

/** A stopped or crashed job taken up again from its journal. */
async function finish(jpath, pr, io = realIo, o = {}) {
  const { j, plan } = await openJob(jpath); if (j.state === 'done') return { files: 0, dest: j.dest, job: jpath, appeared: [], damaged: j.damaged || [], undo: true };
  if (j.state === 'restoring' || j.state === 'undoing') throw fail('restoreUnfinished');
  const unlock = await takeLock(j.archive);
  try { await clearUncommitted(j, plan, io); j.state = 'running'; delete j.why; await saveJournal(jpath, j, io); return await run(jpath, j, plan, { pr, io, password: o.password, keepFree: o.keepFree || 0 }); }
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
  const { j, plan, raw } = await openJob(jpath); const unlock = j.mode === 'inplace' && j.state !== 'done' ? await takeLock(j.archive) : async () => {};
  try {
    if (j.mode === 'normal') return await undoNormal(jpath, j, plan, io);
    if (j.state !== 'restoring') { if (j.state !== 'done') await clearUncommitted(j, plan, io); j.restoreFrom = j.state === 'done' ? plan.units.length : j.next; j.state = 'restoring'; j.restored = 0; if (!exists(j.archive)) { await fsp.writeFile(j.archive, Buffer.alloc(0)); j.committed = 0; } await saveJournal(jpath, j, io); }
    const order = orderOf(j, plan); const back = []; let stopAt = -1;
    // (A restore taken up again: a unit already appended whose file a crash left behind is removed now.)
    for (let k = j.restoreFrom - j.restored; k < j.restoreFrom; k++) { const u = plan.units[order[k]]; if (u.kind !== 'file' && u.kind !== 'aside') continue; const p = path.join(j.dest, j.outs[u.i] || u.out); if (exists(p) && (await fileCrc(p)) === crcOf(j, u)) await fsp.rm(p, { force: true }); }
    const fd = await fsp.open(j.archive, 'r+');
    try {
      let size = (await fd.stat()).size; if (size > j.committed) { await fd.truncate(j.committed); size = j.committed; }
      // Units go back lowest offset first: the reverse of the order they came out.
      for (let k = j.restoreFrom - 1 - j.restored; k >= 0; k--) {
        const u = plan.units[order[k]]; if (u.start !== j.committed) { stopAt = k; break; }
        let data = Buffer.alloc(0);
        if (u.kind === 'file' || u.kind === 'aside') { const p = path.join(j.dest, j.outs[u.i] || u.out); let buf; try { buf = await fsp.readFile(p); } catch { stopAt = k; break; } data = rebuildData(u, buf, j.raws[u.i]); if (!data) { stopAt = k; break; } }
        else if (u.kind === 'skip') { stopAt = k; break; }
        const bytes = Buffer.concat([Buffer.from(u.head, 'base64'), data, Buffer.from(u.trail, 'base64')]);
        io.charge(bytes.length); await fd.write(bytes, 0, bytes.length, j.committed); await fd.sync().catch(() => {});
        j.committed += bytes.length; j.restored++; await saveJournal(jpath, j, io); back.push(u);
        if (u.kind === 'file' || u.kind === 'aside') { const p = path.join(j.dest, j.outs[u.i] || u.out); const sz = fs.statSync(p).size; await fsp.rm(p, { force: true }); io.release(sz); }
      }
      // The end: the saved tail (all units back: identical), else a new directory over what is there (ZIP) or two zero blocks (tar).
      let end;
      if (j.restoreFrom === 0) end = Buffer.alloc(0);   // (nothing was ever cut: the archive is whole already)
      else if (stopAt < 0) end = raw;
      else if (plan.format === 'tar') end = Buffer.alloc(1024);
      else { const kept = plan.units.filter((u) => u.end <= j.committed); const cd = Buffer.concat(kept.map((u) => Buffer.from(u.cd, 'base64'))); const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Math.min(kept.length, 0xffff), 8); e.writeUInt16LE(Math.min(kept.length, 0xffff), 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(j.committed, 16); end = Buffer.concat([cd, e]); }
      if (end.length) await fd.write(end, 0, end.length, j.committed); await fd.truncate(j.committed + end.length); await fd.sync().catch(() => {}); io.charge(end.length);
    } finally { await fd.close(); }
    await io.crash('restored');
    await putBack(j, io); const keptOut = stopAt < 0 ? [] : order.slice(0, stopAt + 1).map((i) => plan.units[i]).filter((u) => u.kind === 'file').map((u) => u.name);
    await removeDirs(j, plan); await forget(jpath, j);
    return { identical: stopAt < 0, back: back.length, keptOut };
  } finally { await unlock(); }
}
/** The old items moved aside put back where they were (never over something there; then left in the aside folder). */
async function putBack(j, io) { for (let k = j.aside.moved - 1; k >= 0; k--) { const m = j.aside.moves[k]; const from = path.join(j.dest, m.to), to = path.join(j.dest, m.from); if (exists(from) && !exists(to)) { await fsp.mkdir(path.dirname(to), { recursive: true }); await fsp.rename(from, to); } } void io; }
/** Folders the job made, removed when empty (deepest first). */
async function removeDirs(j, plan) { const dirs = new Set(); for (const u of plan.units) { const parts = u.out.split('/'); for (let i = 1; i <= parts.length - (u.kind === 'dir' ? 0 : 1); i++) dirs.add(parts.slice(0, i).join('/')); } for (const d of [...dirs].sort((a, b) => b.length - a.length)) { try { await fsp.rmdir(path.join(j.dest, d)); } catch { /* not empty or not ours */ } } }
async function forget(jpath, j) { const asideAbs = path.join(j.dest, j.aside.dir); await fsp.rm(asideAbs, { recursive: true, force: true }); await fsp.rm(j.tail, { force: true }); await fsp.rm(jpath, { force: true }); if (j.registry) await fsp.rm(path.join(j.registry, `${j.id}.ref`), { force: true }); }
/** A normal job undone: what it wrote removed (only a file still as it wrote it), what it moved aside put back. */
async function undoNormal(jpath, j, plan, io) {
  const upto = j.state === 'done' ? plan.units.length : j.next; if (j.state !== 'done' && j.state !== 'undoing') await clearUncommitted(j, plan, io);
  j.state = 'undoing'; j.upto = j.upto ?? upto; await saveJournal(jpath, j, io); const order = orderOf(j, plan); let removed = 0; const changed = [];
  for (let k = 0; k < j.upto; k++) { const u = plan.units[order[k]]; if (u.kind !== 'file') continue; const p = path.join(j.dest, j.outs[u.i] || u.out); if (!exists(p)) continue; if ((await fileCrc(p)) === crcOf(j, u)) { const sz = fs.statSync(p).size; await fsp.rm(p, { force: true }); io.release(sz); removed++; } else changed.push(u.name); }
  await putBack(j, io); await removeDirs(j, plan); await forget(jpath, j); return { identical: true, back: 0, removed, keptOut: changed };
}
/** Undo a finished job (in place: the archive made again whole; normal: its files removed); both put the old items back. */
async function undo(jpath, io = realIo) { return restore(jpath, io); }
/** The Undo offer ended: the aside folder, the saved tail and the journal removed. */
async function dismiss(jpath) { const { j } = await openJob(jpath).catch(async (e) => { const t = await fsp.readFile(jpath, 'utf8').catch(() => ''); const r = S.journalRead(t); if (r.ok) return { j: r.body }; throw e; }); if (j.state !== 'done') throw fail('notDone'); await forget(jpath, j); }

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
      if (j.state === 'done') { if (o.atStart || Date.now() - (j.finished || 0) > (o.undoMs ?? 3600e3)) { await forget(jpath, { ...j, registry }); continue; } out.push({ journal: jpath, id: j.id, archive: j.archive, dest: j.dest, mode: j.mode, state: 'done', done: plan.units.length, total: plan.units.length, can: ['undo', 'dismiss'] }); continue; }
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

module.exports = { extract, finish, restore, undo, dismiss, shelf, register, facts, preflightOf: async (file, dest, o) => { const { facts: f } = await facts(file, dest, o); return { facts: f, report: S.preflight(f, { margin: o.keepFree || 0 }) }; }, unitsOf, checkPassword, verifyAll, openJob, BATCH, SUFFIX, OWN_METHODS, hostPlatform, Crash, journalOf, tailOf };
