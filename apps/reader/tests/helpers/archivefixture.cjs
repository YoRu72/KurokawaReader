// Made-up comic archives for tests/comicarchives.cjs (and tests/uihunt.cjs): the pages are those of tests/helpers/comicfixture.cjs
// (numbered pages of made-up art), put in a 7z or a tar (+ gzip) by libarchive.js itself under Node, in a RAR 4 and in a
// zip with the old (ZipCrypt) password, both written here by hand — libarchive.js cannot write either. No archive tool is used.
//   pagesOf({ pages, folders, ... })   -> [{ name, data }] in the order given (shuffled with `shuffle`), system files and a ComicInfo.xml added
//   makeTar(files, { gzip })           -> Buffer (a tar, or a .tar.gz)
//   make7z(files)                      -> Buffer
//   makeRar4(files)                    -> Buffer (the «store» method: no compression)
//   makeZipCrypt(files, password)      -> Buffer
//   makeZip(files)                     -> Buffer (stored)
const path = require('path'); const zlib = require('zlib');
const { page } = require('./comicfixture.cjs');

const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (buf, c0 = 0) => { let c = ~c0; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return ~c >>> 0; };

/** Pages 1..n as files; with `folders` (page counts) they sit in «Chapter 01/…»; `extra`: more files. System files and a ComicInfo.xml are added. */
function pagesOf(o = {}) {
  const n = o.pages ?? 12, w = o.width ?? 300, h = o.height ?? 450; const files = [];
  const at = (i) => { if (!o.folders) return ''; let k = 0, left = i; while (k < o.folders.length && left >= o.folders[k]) { left -= o.folders[k]; k++; } return `Chapter ${String(k + 1).padStart(2, '0')}/`; };
  for (let i = 1; i <= n; i++) files.push({ name: `${at(i - 1)}page-${i}.png`, data: page(i, w, h, { noise: o.noise }), n: i });
  if (o.system !== false) files.push({ name: '__MACOSX/._page-1.png', data: Buffer.from('x') }, { name: '.hidden.png', data: Buffer.from('x') }, { name: 'Thumbs.db', data: Buffer.from('thumbs') }, { name: 'info.txt', data: Buffer.from('made-up comic') }, { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Title>Made up</Title></ComicInfo>') });
  if (o.shuffle !== false) { let s = 12345; const r = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; for (let i = files.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [files[i], files[j]] = [files[j], files[i]]; } }
  return files;
}

async function libarchive() { return import(path.resolve(__dirname, '../../node_modules/libarchive.js/dist/libarchive-node.mjs')); }
// (libarchive.js writes through a filter whose output buffer is a little larger than the files: with no filter the
// headers do not fit and nothing is written. So the archive is written inside gzip and the gzip taken off again.)
async function viaLibarchive(files, format, gzipOut) {
  const { Archive, ArchiveCompression, ArchiveFormat } = await libarchive();
  const f = await Archive.write({ files: files.map((x) => ({ file: new Blob([x.data]), pathname: x.name })), outputFileName: 'x', compression: ArchiveCompression.GZIP, format: ArchiveFormat[format], passphrase: null });
  const gz = Buffer.from(await f.arrayBuffer());
  return gzipOut ? gz : zlib.gunzipSync(gz);
}
const makeTar = (files, o = {}) => viaLibarchive(files, 'USTAR', !!o.gzip);
const make7z = (files) => viaLibarchive(files, 'SEVEN_ZIP', false);

/** RAR 4.x, every file stored (method 0x30), headers with their CRC-16 (the low half of a CRC-32) and data with CRC-32. */
function makeRar4(files) {
  const out = [Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])];
  const head = (type, flags, rest) => { const b = Buffer.alloc(7 + rest.length); b[2] = type; b.writeUInt16LE(flags, 3); b.writeUInt16LE(b.length, 5); rest.copy(b, 7); b.writeUInt16LE(crc32(b.subarray(2)) & 0xffff, 0); return b; };
  out.push(head(0x73, 0, Buffer.alloc(6)));
  const date = ((2026 - 1980) << 25) | (1 << 21) | (1 << 16);
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'); const r = Buffer.alloc(25 + name.length);
    r.writeUInt32LE(f.data.length, 0); r.writeUInt32LE(f.data.length, 4); r[8] = 3; r.writeUInt32LE(crc32(f.data), 9); r.writeUInt32LE(date >>> 0, 13); r[17] = 29; r[18] = 0x30; r.writeUInt16LE(name.length, 19); r.writeUInt32LE(0x81a4, 21); name.copy(r, 25);
    out.push(head(0x74, 0x8000, r), f.data);
  }
  out.push(head(0x7b, 0x4000, Buffer.alloc(0)));
  return Buffer.concat(out);
}

/** A zip of stored entries; with `password`, each entry under the zip's old password scheme (ZipCrypt). */
function makeZip(files, password) {
  const parts = []; const cd = []; let off = 0;
  const keys = [305419896, 591751049, 878082192];
  const upd = (b) => { keys[0] = (CRC[(keys[0] ^ b) & 0xff] ^ (keys[0] >>> 8)) | 0; keys[1] = (Math.imul((keys[1] + (keys[0] & 0xff)) | 0, 134775813) + 1) | 0; keys[2] = (CRC[(keys[2] ^ (keys[1] >>> 24)) & 0xff] ^ (keys[2] >>> 8)) | 0; };
  const next = () => { const t = (keys[2] | 2) & 0xffff; return ((Math.imul(t, t ^ 1) >>> 8) & 0xff); };
  const enc = (buf) => { const o = Buffer.alloc(buf.length); for (let i = 0; i < buf.length; i++) { const c = next(); o[i] = buf[i] ^ c; upd(buf[i]); } return o; };
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'); const crc = crc32(f.data); let body = f.data; const flags = 0x0800 | (password ? 1 : 0);
    if (password) { keys[0] = 305419896; keys[1] = 591751049; keys[2] = 878082192; for (const ch of Buffer.from(password)) upd(ch); const hdr = Buffer.alloc(12, 0x41); hdr[11] = crc >>> 24; body = Buffer.concat([enc(hdr), enc(f.data)]); }
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(flags, 6); l.writeUInt16LE(0, 8); l.writeUInt16LE(0, 10); l.writeUInt16LE(0x21, 12); l.writeUInt32LE(crc, 14); l.writeUInt32LE(body.length, 18); l.writeUInt32LE(f.data.length, 22); l.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(flags, 8); c.writeUInt16LE(0, 10); c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(f.data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    parts.push(l, name, body); cd.push(c, name); off += 30 + name.length + body.length;
  }
  const cdb = Buffer.concat(cd); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cdb.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cdb, end]);
}
const makeZipCrypt = (files, password) => makeZip(files, password);

module.exports = { pagesOf, makeTar, make7z, makeRar4, makeZip, makeZipCrypt, crc32 };
