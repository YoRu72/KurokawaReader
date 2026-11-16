// Generates apps/tools/tests/data/extractjob-vectors.tsv from the JavaScript engine (the reference). Run once; both
// engines then check themselves against the file.
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const ROOT = process.argv[2]; const S = require(path.join(ROOT, 'desktop/archsafe.cjs')); const E = require(path.join(ROOT, 'desktop/inplace.cjs'));
const out = [];
out.push('# Shared vectors of the extraction engine: run by tests/extractsafe.cjs (desktop/inplace.cjs over archsafe.cjs) and by');
out.push('# kt-core extractjob.rs (rustc --test stdroots/extractjob.rs). Made from the JavaScript engine; both must give these answers.');
out.push('# preflight<TAB>facts JSON<TAB>margin<TAB>normal.ok<TAB>inPlace.ok<TAB>recommend<TAB>why<TAB>problem kinds:severity (sorted)<TAB>space.normal<TAB>space.inPlace');
out.push('# units<TAB>label<TAB>archive (hex)<TAB>file name<TAB>units name:start:dataStart:dataEnd:end:bad (|)<TAB>layoutBad (,)');
out.push('# plan<TAB>entries (| ; «/» at the end: a folder)<TAB>files already there (| or -)<TAB>answers JSON or -<TAB>in place 1|0<TAB>platform<TAB>kind:out (|) or the error<TAB>moves from>to (|) or -');
out.push('# journal<TAB>body JSON<TAB>the journal text (\\n for its newlines)');
out.push('# tail<TAB>plan JSON<TAB>raw tail (hex)<TAB>CRC-32 of the tail file (hex)');
out.push('# log<TAB>a unit log\'s text (as a JSON string)<TAB>the records kept (JSON)');
out.push('# own<TAB>planned name<TAB>logged name<TAB>1 when the log may name that unit\'s output');
out.push('# zipend<TAB>entries<TAB>directory bytes<TAB>directory offset<TAB>the end records (hex)');
const facts = (o) => ({ format: 'zip', platform: 'linux', entries: [{ path: 'a', usize: 1000, csize: 900, method: 8, offset: 0 }, { path: 'b', usize: 9000, csize: 8900, method: 8, offset: 1000 }], supported: [0, 8], password: 'none', archiveWritable: true, destWritable: true, sameVolume: true, free: 12000, inPlaceFormat: true, blockSize: 1, ...o });
const F = [
  facts({}), facts({ free: 70000, sameVolume: false }), facts({ free: 75000 }), facts({ free: 1e9 }), facts({ archiveWritable: false, free: 1e9 }), facts({ saf: true, free: 1e9 }),
  facts({ entries: [{ path: 'bomb', usize: 5 * 1024 ** 3, csize: 5 * 1024 ** 2, method: 8 }], free: 1e12 }), facts({ volumes: { missing: ['x.zip.003'], odd: [] }, free: 1e9 }), facts({ existing: ['a'], free: 1e9 }),
  facts({ free: 1e9, entries: [{ path: 'x.zst', usize: 10, csize: 10, method: 93 }, { path: 'y', usize: 1, csize: 1, method: 8 }] }), facts({ free: 1e9, external: [93], entries: [{ path: 'x.zst', usize: 10, csize: 10, method: 93 }] }),
  facts({ free: 1e9, encrypted: true, password: 'wrong' }), facts({ free: 1e9, encrypted: true, password: 'ok' }), facts({ free: 1e9, busy: true }), facts({ free: 1e9, oldJob: true }), facts({ free: 1e9, destWritable: false }),
  facts({ free: 1e9, platform: 'windows', entries: [{ path: 'a:b.txt', usize: 1, csize: 1, method: 0 }, { path: 'CON.txt', usize: 1, csize: 1, method: 0 }, { path: '../up', usize: 1, csize: 1, method: 0 }] }),
  facts({ free: 1e9, platform: 'windows', entries: [{ path: 'A.txt', usize: 1, csize: 1, method: 0 }, { path: 'a.txt', usize: 1, csize: 1, method: 0 }, { path: 'd/', dir: true }, { path: 'D', usize: 1, csize: 1, method: 0 }] }),
  facts({ free: 1e9, entries: [{ path: 'l', link: 'sym', target: '../../etc' }, { path: 'x\u202eb.txt', usize: 1, csize: 1, method: 0 }] }),
  facts({ free: 5000, sameVolume: false, inPlaceFormat: false }), facts({ free: -1, layoutBad: ['a'], damaged: ['b'] }), facts({ free: 1e9, inPlaceFormat: false, tailBytes: 300 }),
  facts({ free: 76000, tailBytes: 500, blockSize: 4096 }),
  // the job's own names (the destination is the archive's folder) and the aside folder's: refused as unsafe names
  facts({ free: 1e9, reserved: ['a.zip', 'a.zip.kurokawa-unzip', 'a.zip.kurokawa-unzip.tmp', 'a.zip.kurokawa-tail', 'a.zip.kurokawa-lock'], entries: [{ path: 'a.zip.kurokawa-unzip.tmp', usize: 1, csize: 1, method: 0 }, { path: 'ok.txt', usize: 1, csize: 1, method: 0 }] }),
  facts({ free: 1e9, entries: [{ path: '.kurokawa-replaced-abc/replaced/x.txt', usize: 1, csize: 1, method: 0 }, { path: 'ok.txt', usize: 1, csize: 1, method: 0 }] }),
  facts({ free: 1e9, entries: [{ path: 'sub/x.KUROKAWA-TAIL', usize: 1, csize: 1, method: 0 }, { path: 'a.zip.kurokawa-unzip.log', usize: 1, csize: 1, method: 0 }, { path: 'deep/b.kurokawa-lock.tmp', usize: 1, csize: 1, method: 0 }, { path: 'fine.kurokawa-unzipped', usize: 1, csize: 1, method: 0 }] }),
  facts({ free: 1e9, platform: 'windows', reserved: ['a.zip'], entries: [{ path: 'A.ZIP', usize: 1, csize: 1, method: 0 }, { path: '.Kurokawa-Replaced/x', usize: 1, csize: 1, method: 0 }] }),
];
for (const f of F) { for (const margin of [0, 4000]) { const r = S.preflight(f, { margin }); const kinds = r.problems.map((p) => `${p.kind}:${p.severity}`).sort().join(',') || '-'; out.push(['preflight', JSON.stringify(f), margin, r.normal.ok ? 1 : 0, r.inPlace.ok ? 1 : 0, r.recommend, r.why, kinds, r.space.normal, r.space.inPlace].join('\t')); } }
// units: the overlap regression (archiveformat.cjs), the same entries side by side, a tar with a FIFO and a device, a bad checksum
const T = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; }); const crc = (b) => { let c = 0xffffffff; for (const v of b) c = T[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const lh = (name, data) => { const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt32LE(crc(data), 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26); return Buffer.concat([h, Buffer.from(name)]); };
const cd = (name, data, off) => { const h = Buffer.alloc(46); h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6); h.writeUInt32LE(crc(data), 16); h.writeUInt32LE(data.length, 20); h.writeUInt32LE(data.length, 24); h.writeUInt16LE(name.length, 28); h.writeUInt32LE(off, 42); return Buffer.concat([h, Buffer.from(name)]); };
const mk = (overlap) => { const B = Buffer.from('BBBB'); const bh = lh('b.txt', B); const Adata = overlap ? Buffer.concat([bh, B]) : Buffer.from('AAAAAAAAAA'); const ah = lh('a.bin', Adata); const boff = overlap ? ah.length : ah.length + Adata.length; const body = overlap ? Buffer.concat([ah, Adata]) : Buffer.concat([ah, Adata, bh, B]); const c = Buffer.concat([cd('a.bin', Adata, 0), cd('b.txt', B, boff)]); const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(2, 8); e.writeUInt16LE(2, 10); e.writeUInt32LE(c.length, 12); e.writeUInt32LE(body.length, 16); return Buffer.concat([body, c, e]); };
const th = (name, size, type, sumBad) => { const h = Buffer.alloc(512); h.write(name, 0); h.write('0000644\0', 100); h.write(size.toString(8).padStart(11, '0') + '\0', 124); h.fill(32, 148, 156); h.write(type, 156); h.write('ustar\0' + '00', 257); let s = 0; for (const v of h) s += v; h.write(s.toString(8).padStart(6, '0') + '\0 ', 148); if (sumBad) h[150] ^= 1; return h; };
const tar = (list) => Buffer.concat([...list.flatMap(([n, d, t, b]) => [th(n, d.length, t, b), Buffer.concat([Buffer.from(d), Buffer.alloc((512 - (d.length % 512)) % 512)])]), Buffer.alloc(1024)]);
const badLocal = (() => { const b = mk(false); b[45] = 0; return b; })(); const prepended = (() => { const stub = Buffer.from('PK-stub!'); const A = Buffer.from('AAAA'); const ah = lh('a.bin', A); const B = Buffer.from('BB'); const bh = lh('b.txt', B); const body = Buffer.concat([stub, ah, A, bh, B]); const c = Buffer.concat([cd('a.bin', A, 8), cd('b.txt', B, 8 + ah.length + 4)]); const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(2, 8); e.writeUInt16LE(2, 10); e.writeUInt32LE(c.length, 12); e.writeUInt32LE(body.length, 16); return Buffer.concat([body, c, e]); })();
const pastCd = (() => { const b = mk(false); const e = b.length - 22; const cdo = b.readUInt32LE(e + 16); const p2 = cdo + 46 + 5; b.writeUInt32LE(5000, p2 + 42); return b; })();
const shortZ64 = (() => { const A = Buffer.from('AAAA'); const ah = lh('a.bin', A); const c = cd('a.bin', A, 0); const cx = Buffer.concat([c.subarray(0, 46), c.subarray(46), Buffer.from([1, 0, 0, 0])]); cx.writeUInt32LE(0xffffffff, 24); cx.writeUInt16LE(4, 30); const body = Buffer.concat([ah, A]); const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(1, 8); e.writeUInt16LE(1, 10); e.writeUInt32LE(cx.length, 12); e.writeUInt32LE(body.length, 16); return Buffer.concat([body, cx, e]); })();
const bigLong = tar([['././@LongLink', 'n'.repeat((1 << 20) + 10), 'L'], ['a.txt', 'hello', '0']]);
const U = [['zip overlap', mk(true), 'o.zip'], ['zip offset past the directory', pastCd, 'pc.zip'], ['zip64 field shorter than it says', shortZ64, 'z64.zip'], ['tar long name over 1 MiB', bigLong, 'big.tar'], ['zip bad local header', badLocal, 'bl.zip'], ['zip prepended data', prepended, 'pre.zip'], ['zip side by side', mk(false), 'f.zip'], ['tar fifo and device', tar([['a.txt', 'hello', '0'], ['pipe', '', '6'], ['dev', '', '3'], ['sparse', 'xy', 'S'], ['z.txt', 'zz', '0']]), 's.tar'], ['tar bad checksum', tar([['a.txt', 'hello', '0', true], ['b/', '', '5']]), 'b.tar']];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-genvec-'));
(async () => {
  for (const [label, buf, name] of U) { const f = path.join(tmp, name); fs.writeFileSync(f, buf); let s; try { s = await E.unitsOf(f); } catch (e) { out.push(['units', label, buf.toString('hex'), name, 'ERR ' + e.message, '-'].join('\t')); continue; } out.push(['units', label, buf.toString('hex'), name, s.units.map((u) => [u.name, u.start, u.dataStart, u.dataEnd, u.end, u.bad ? 1 : 0].join(':')).join('|'), s.layoutBad.join(',') || '-'].join('\t')); }
  const P = [
    [['a.txt', 'd/', 'd/b.txt', 'c.txt'], [], null, 0, 'linux'], [['a.txt', 'c.txt'], ['a.txt'], null, 0, 'linux'], [['a.txt', 'c.txt', 'd/e.txt'], ['a.txt', 'c.txt', 'd/e.txt'], { default: 'replace', per: { 'c.txt': 'skip' } }, 0, 'linux'],
    [['a.txt', 'c.txt', 'd/e.txt'], ['a.txt', 'c.txt', 'd/e.txt'], { default: 'replace', per: { 'c.txt': 'skip' } }, 1, 'linux'], [['a.txt', 'a (2).txt'], ['a.txt'], { files: 'both' }, 0, 'linux'],
    [['A.txt', 'a.txt'], [], { default: 'both' }, 0, 'windows'], [['x.tar.gz', 'noext', '.hidden'], ['x.tar.gz', 'noext', '.hidden'], { default: 'both' }, 0, 'linux'], [['ok.txt', '../up.txt'], [], null, 0, 'linux'],
    [['meeting 10:30.txt'], ['meeting 10_30.txt'], { default: 'both' }, 1, 'windows'],
    [['d', 'x.txt'], ['d/', 'x.txt'], { default: 'replace' }, 0, 'linux'], [['d', 'x.txt'], ['d/', 'x.txt'], { default: 'replace' }, 1, 'linux'],
    // (Round four: «keep both» of a name at the limit stays within it — the base is cut.)
    [['n'.repeat(243) + '.txt', 'd/' + 'n'.repeat(247)], ['n'.repeat(243) + '.txt', 'd/' + 'n'.repeat(247), 'd/' + 'n'.repeat(243) + ' (2)'], { default: 'both' }, 1, 'linux'],
  ];
  for (const [names, ex, answers, ip, plat] of P) {
    const dest = fs.mkdtempSync(path.join(tmp, 'd-')); for (const e of ex) { if (e.endsWith('/')) { fs.mkdirSync(path.join(dest, e), { recursive: true }); continue; } fs.mkdirSync(path.dirname(path.join(dest, e)), { recursive: true }); fs.writeFileSync(path.join(dest, e), 'old'); }
    const scan = { units: names.map((n) => ({ name: n, dir: n.endsWith('/'), start: 0, dataStart: 0, dataEnd: 0, end: 0, method: 0, usize: 0, csize: 0 })) };
    let got, mv; try { const r = E.planOuts(scan, dest, plat, answers || undefined, !!ip, 'ID'); got = r.units.map((u) => `${u.kind}:${u.out}`).join('|'); mv = r.moves.map((m) => `${m.from}>${m.to}`).join('|') || '-'; } catch (e) { got = e.message + (e.names ? ' ' + e.names.join(',') : ''); mv = '-'; }
    out.push(['plan', names.join('|'), ex.join('|') || '-', answers ? JSON.stringify(answers) : '-', ip, plat, got, mv].join('\t'));
  }
  const bodies = [{ registry: null, id: 'abc123', mode: 'inplace', format: 'zip', archive: '/x/a.zip', dest: '/x/out', tail: '/x/a.zip.kurokawa-tail', tailLen: 12345, tailCrc: 3735928559, committed: 999, prevCommitted: 1999, next: 3, outs: { 2: 'b (2).txt' }, raws: { 0: 1, 2: 4294967295 }, aside: { dir: '.kurokawa-replaced-abc123', moves: [{ from: 'a.txt', to: '.kurokawa-replaced-abc123/replaced/a.txt' }], moved: 1 }, state: 'paused', platform: 'linux', created: 1760000000000, password: false, why: 'noSpace' },
    { registry: '/reg', id: 'q', mode: 'normal', archive: 'C:\\Users\\Ä\\x "q".tar', dest: 'كتب\t\u0001', state: 'done', damaged: ['a\nb'], finished: 1.5 }];
  for (const b of bodies) out.push(['journal', JSON.stringify(b), S.journalText(b).replace(/\n/g, '\\n')].join('\t'));
  const plan = { format: 'zip', size: 100, tailStart: 60, idCrc: 7, dest: '/o', units: [{ i: 0, name: 'a', start: 0, dataStart: 31, dataEnd: 40, end: 40, method: 0, crc: 5, usize: 9, csize: 9, dir: false, link: null, encrypted: false, dd: false, time: 0, kind: 'file', out: 'a', head: Buffer.from('h').toString('base64'), trail: '', cd: Buffer.from('cd!').toString('base64') }] };
  for (const raw of [Buffer.alloc(0), Buffer.from('504b0506', 'hex')]) { const j = Buffer.from(JSON.stringify(plan), 'utf8'); const tb = Buffer.concat([Buffer.from(`KTTAIL2\n${j.length}\n`), j, raw]); out.push(['tail', JSON.stringify(plan), raw.toString('hex') || '-', S.crc32(tb).toString(16).padStart(8, '0')].join('\t')); }
  const logs = ['{"i":0,"out":"a.txt","crc":5}\n{"i":1,"out":"x\\n0\\t/etc/passwd\\t9","crc":7}\n', 'x\n0\t/etc/victim\t123\n{"i":2,"out":"b (2).txt","crc":4294967295}', '{"i":-1,"out":"a","crc":1}\n{"i":1.5,"out":"a","crc":1}\n{"i":1,"out":5,"crc":1}\n{"i":1,"out":"a","crc":4294967296}\n[1,2]\n{"i":3,"out":"c","crc":0}\n'];
  logs.push('0\ta (2).txt\t4294967295\n1\tb\t4294967296\n2\tc\t5\textra\n-1\td\t5\n3\te\tff\n4\tf\t7\n{"i":5,"out":"g","crc":1}\n');
  for (const l of logs) out.push(['log', JSON.stringify(l), JSON.stringify(E.parseLog(l))].join('\t'));
  for (const [a, b] of [['a.txt', 'a.txt'], ['a.txt', 'a (2).txt'], ['d/a.txt', 'd/a (12).txt'], ['d/a.txt', 'a (2).txt'], ['a.txt', 'a (02).txt'], ['a.txt', 'a ().txt'], ['a.txt', '/etc/passwd'], ['a.txt', '../a (2).txt'], ['noext', 'noext (3)'], ['a.tar.gz', 'a.tar (2).gz'], ['a.txt', 'a (2).txt/x']]) out.push(['own', a, b, E.ownOutput(a, b) ? 1 : 0].join('\t'));
  const L = 'n'.repeat(243) + '.txt'; const AR = 'ب'.repeat(121) + '.txt'; const EM = '😀'.repeat(60) + '.txt'; const LE = 'a.' + 'e'.repeat(244);
  for (const [a, b, plat] of [[L, S.bothForm(L, 2, 247), 'linux'], [L, 'n'.repeat(243) + ' (2).txt', 'linux'], [L, 'n'.repeat(238) + ' (2).txt', 'linux'], [L, 'n'.repeat(236) + ' (12).txt', 'linux'], [L, S.bothForm(L, 12, 247), 'linux'],
    [AR, S.bothForm(AR, 2, 247), 'linux'], [AR, S.bothForm(AR, 2, 247, 'utf16'), 'linux'], ['ب'.repeat(243) + '.txt', S.bothForm('ب'.repeat(243) + '.txt', 3, 247, 'utf16'), 'windows'], ['ب'.repeat(243) + '.txt', S.bothForm('ب'.repeat(243) + '.txt', 3, 247), 'windows'],
    [EM, S.bothForm(EM, 2, 247), 'linux'], [LE, S.bothForm(LE, 2, 247), 'linux'], [LE, 'a (2)', 'linux'], ['abc.txt', 'ab (2).txt', 'linux'], ['d/' + L, 'd/' + S.bothForm(L, 2, 247), 'linux'], ['d/' + L, S.bothForm(L, 2, 247), 'linux']])
    out.push(['own', a, b, E.ownOutput(a, b, plat) ? 1 : 0, plat].join('\t'));
  for (const [c, l, o] of [[2, 100, 300], [0, 0, 0], [70000, 5000000, 123456], [3, 10, 5e9]]) out.push(['zipend', c, l, o, E.zipEnd(c, l, o).toString('hex')].join('\t'));
  fs.writeFileSync(path.join(ROOT, 'tests/data/extractjob-vectors.tsv'), out.join('\n') + '\n'); fs.rmSync(tmp, { recursive: true, force: true }); console.log(out.length, 'lines');
})();
