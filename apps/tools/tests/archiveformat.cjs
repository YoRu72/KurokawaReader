// What a file is, decided by what is in it (desktop/archive.cjs formatOf): a «.tar» is a tar only with a tar header; «.tar.gz», «.tar.xz» and
// «.tar.bz2» only with a tar header inside — gzip looked into by Node's zlib, xz and bzip2 by the shipped 7-Zip (here a stand-in program on the PATH).
// And: a zip whose entries overlap is refused in place. Files made up here; nothing real is read. Run: node tests/archiveformat.cjs
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const zlib = require('node:zlib');
let fails = 0; const ok = (what, cond, x) => { console.log((cond ? 'ok   ' : 'FAIL ') + what + (cond || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 300))); if (!cond) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-fmt-')); const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
const tarHead = (name, size, magic = true) => { const h = Buffer.alloc(512); h.write(name, 0); h.write('0000644\0', 100); h.write(size.toString(8).padStart(11, '0') + '\0', 124); h.fill(32, 148, 156); h.write('0', 156); if (magic) h.write('ustar\0' + '00', 257); let sum = 0; for (const v of h) sum += v; h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148); return h; };
const tarOf = (magic = true) => Buffer.concat([tarHead('a.txt', 5, magic), Buffer.from('hello'.padEnd(512, '\0')), Buffer.alloc(1024)]);
// the stand-in 7-Zip: «e -so»: writes what KT_FAKE_INSIDE names (tar bytes or text) to the pipe
const fake = path.join(bin, '7z'); fs.writeFileSync(path.join(tmp, 'tar.bin'), tarOf()); fs.writeFileSync(path.join(tmp, 'text.bin'), 'just some words\n');
fs.writeFileSync(fake, `#!/bin/sh\ncat "${tmp}/$KT_FAKE_INSIDE.bin"\n`, { mode: 0o755 });
process.env.PATH = bin + path.delimiter + process.env.PATH; process.env.KT_SEVENZIP = fake;   // (the stand-in, whatever 7-Zip the machine has)
const A = require('../desktop/archive.cjs'); const w = (n, b) => { const f = path.join(tmp, n); fs.writeFileSync(f, b); return f; };
const fmt = async (f) => { try { return await A.formatOf(f); } catch (e) { return String(e.message); } };
(async () => {
  ok('a real tar named .tar: tar', (await fmt(w('real.tar', tarOf()))) === 'tar');
  ok('an old (v7) tar, no magic, valid checksum: tar', (await fmt(w('v7.tar', tarOf(false)))) === 'tar');
  ok('a text file merely named .tar: not an archive', (await fmt(w('fake.tar', 'this is only a text file\n'.repeat(40)))) === 'notArchive');
  ok('a tiny file named .tar: not an archive', (await fmt(w('tiny.tar', 'x'))) === 'notArchive');
  ok('a tar under another name (with the ustar magic): still a tar', (await fmt(w('noext.bin', tarOf()))) === 'tar');
  ok('a file full of zeros named .tar (an empty tar): tar', (await fmt(w('empty.tar', Buffer.alloc(10240)))) === 'tar');
  ok('a random 512 bytes named .tar: not an archive', (await fmt(w('rnd.tar', require('node:crypto').randomBytes(2048)))) === 'notArchive');
  ok('gzip of a tar named .tar.gz: tar.gz; named .tgz: tar.gz', (await fmt(w('t.tar.gz', zlib.gzipSync(tarOf())))) === 'tar.gz' && (await fmt(w('t.tgz', zlib.gzipSync(tarOf())))) === 'tar.gz');
  ok('gzip of plain text named .tar.gz: only a gzip', (await fmt(w('p.tar.gz', zlib.gzipSync('words '.repeat(500))))) === 'gz');
  ok('gzip of 5 bytes named .tgz: only a gzip', (await fmt(w('q.tgz', zlib.gzipSync('hello')))) === 'gz');
  ok('gzip of a tar under a plain .gz name: stays a gzip (the name does not claim a tar)', (await fmt(w('plain.gz', zlib.gzipSync(tarOf())))) === 'gz');
  ok('a damaged gzip named .tar.gz: the name\'s word stands (nothing to look at)', (await fmt(w('bad.tar.gz', Buffer.concat([Buffer.from([0x1f, 0x8b, 8, 0]), Buffer.alloc(30, 7)])))) === 'tar.gz');
  const xzHead = Buffer.concat([Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0]), Buffer.alloc(40)]); const bzHead = Buffer.concat([Buffer.from('BZh9'), Buffer.alloc(40)]);
  process.env.KT_FAKE_INSIDE = 'tar'; ok('xz / bzip2 named tar.* with a tar inside (by 7-Zip): tar.xz / tar.bz2', (await fmt(w('x.tar.xz', xzHead))) === 'tar.xz' && (await fmt(w('x.txz', xzHead))) === 'tar.xz' && (await fmt(w('x.tar.bz2', bzHead))) === 'tar.bz2');
  process.env.KT_FAKE_INSIDE = 'text'; ok('xz / bzip2 named tar.* with only text inside: xz / bz2', (await fmt(w('y.tar.xz', xzHead))) === 'xz' && (await fmt(w('y.tbz2', bzHead))) === 'bz2');
  ok('xz / bzip2 under plain names stay xz / bz2 (7-Zip not even asked)', (await fmt(w('z.xz', xzHead))) === 'xz' && (await fmt(w('z.bz2', bzHead))) === 'bz2');
  process.env.KT_SEVENZIP = path.join(tmp, 'no-such-7z'); const t0 = Date.now();
  ok('no 7-Zip to look with: the name\'s word stands for xz', (await fmt(w('n.tar.xz', xzHead))) === 'tar.xz' && Date.now() - t0 < 4000);
  process.env.KT_SEVENZIP = fake;
  ok('zip, 7z and rar are still known by their first bytes whatever the name', (await fmt(w('a.dat', Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0])))) === 'zip' && (await fmt(w('b.dat', Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4])))) === '7z' && (await fmt(w('c.dat', Buffer.from('Rar!\x1a\x07\x00\x00')))) === 'rar');

  // ---- in place: two entries whose bytes overlap (the first one's data holds the second one's local header and data) are refused before anything is cut
  { const T = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; }); const crc = (b) => { let c = 0xffffffff; for (const v of b) c = T[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const lh = (name, data) => { const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt32LE(crc(data), 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26); return Buffer.concat([h, Buffer.from(name)]); };
    const cd = (name, data, off) => { const h = Buffer.alloc(46); h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6); h.writeUInt32LE(crc(data), 16); h.writeUInt32LE(data.length, 20); h.writeUInt32LE(data.length, 24); h.writeUInt16LE(name.length, 28); h.writeUInt32LE(off, 42); return Buffer.concat([h, Buffer.from(name)]); };
    const mk = (overlap) => { const B = Buffer.from('BBBB'); const bh = lh('b.txt', B); const Adata = overlap ? Buffer.concat([bh, B]) : Buffer.from('AAAAAAAAAA'); const ah = lh('a.bin', Adata);
      const boff = overlap ? ah.length : ah.length + Adata.length; const body = overlap ? Buffer.concat([ah, Adata]) : Buffer.concat([ah, Adata, bh, B]); const c = Buffer.concat([cd('a.bin', Adata, 0), cd('b.txt', B, boff)]);
      const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(2, 8); e.writeUInt16LE(2, 10); e.writeUInt32LE(c.length, 12); e.writeUInt32LE(body.length, 16); return Buffer.concat([body, c, e]); };
    const pf = async (n, b) => (await A.preflight(w(n, b), path.join(tmp, 'o-' + n), { inPlace: true })).report;
    const bad = await pf('overlap.zip', mk(true)); const fine = await pf('fine.zip', mk(false));
    ok('overlapping entries: a «layout» problem naming the first one, in place refused', bad.problems.some((p) => p.kind === 'layout' && p.names.includes('a.bin')) && bad.recommend !== 'inPlace', bad.problems);
    ok('the same two entries side by side: no layout problem', !fine.problems.some((p) => p.kind === 'layout'), fine.problems); }
  fs.rmSync(tmp, { recursive: true, force: true }); console.log(fails ? `\n${fails} failed` : '\nall ok'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL', e); process.exit(1); });
