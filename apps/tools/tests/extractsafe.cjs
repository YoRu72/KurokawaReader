// Safe extraction (Tools 0.21 P5): the failure matrix, table-driven, on made-up archives built here (a tiny ZIP and
// tar writer), run through the PC's engine (desktop/inplace.cjs over desktop/archsafe.cjs) on a fake volume with a
// quota and crash points; plus the one name table's vectors in the three languages (JS here, Java through
// tests/native/namesafe.sh, Rust through rustc --test) and the twins' constants compared with desktop/namesafe.json.
// Run: node tests/extractsafe.cjs [--quick] (--quick skips Java and Rust).
'use strict';
const fs = require('node:fs'); const fsp = fs.promises; const path = require('node:path'); const os = require('node:os'); const zlib = require('node:zlib'); const crypto = require('node:crypto'); const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..'); const S = require('../desktop/archsafe.cjs'); const E = require('../desktop/inplace.cjs');
const QUICK = process.argv.includes('--quick');
let fails = 0; let passes = 0; const ok = (what, c, more = '') => { if (c) passes++; else { fails++; console.log('FAIL', what, more); } };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-extractsafe-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* none */ } });

/* ---------- writers (made-up data only) ---------- */
function zipCryptoEncrypt(pw, data, crc) { const T = S.crcTable(); const k = [305419896, 591751049, 878082192]; const up = (c) => { k[0] = (T[(k[0] ^ c) & 0xff] ^ (k[0] >>> 8)) >>> 0; k[1] = (Math.imul((k[1] + (k[0] & 0xff)) >>> 0, 134775813) + 1) >>> 0; k[2] = (T[(k[2] ^ (k[1] >>> 24)) & 0xff] ^ (k[2] >>> 8)) >>> 0; }; for (const c of Buffer.from(pw)) up(c); const db = () => { const t = (k[2] | 2) & 0xffff; return (Math.imul(t, t ^ 1) >>> 8) & 0xff; }; const head = Buffer.alloc(12, 7); head[11] = crc >>> 24; const all = Buffer.concat([head, data]); const out = Buffer.alloc(all.length); for (let i = 0; i < all.length; i++) { const p = all[i]; out[i] = p ^ db(); up(p); } return out; }
/** entries: [{ name, data?, method? (0|8|any id), dir?, badCrc?, pw?, dd?, nonUtf8? }] → a ZIP. */
function mkZip(entries) {
  const parts = []; const cds = []; let pos = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'); const data = e.dir ? Buffer.alloc(0) : Buffer.from(e.data ?? `body of ${e.name}\n`.repeat(e.rep ?? 3));
    const method = e.dir ? 0 : e.method ?? 8; const crc = S.crc32(data); let body = method === 8 ? zlib.deflateRawSync(data) : method === 0 ? data : Buffer.from(data);
    if (e.pw) body = zipCryptoEncrypt(e.pw, body, crc);
    const storedCrc = e.badCrc ? (crc ^ 1) >>> 0 : crc; const flags = 0x800 | (e.pw ? 1 : 0);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(flags, 6); h.writeUInt16LE(method, 8); h.writeUInt16LE(0x6000, 10); h.writeUInt16LE(0x5a21, 12); h.writeUInt32LE(storedCrc, 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(flags, 8); c.writeUInt16LE(method, 10); c.writeUInt16LE(0x6000, 12); c.writeUInt16LE(0x5a21, 14); c.writeUInt32LE(storedCrc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(pos, 42);
    parts.push(h, name, body); cds.push(c, name); pos += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(cds); const eo = Buffer.alloc(22); eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(entries.length, 8); eo.writeUInt16LE(entries.length, 10); eo.writeUInt32LE(cd.length, 12); eo.writeUInt32LE(pos, 16);
  return Buffer.concat([...parts, cd, eo]);
}
/** entries: [{ name, data?, dir?, link?, badSum? }] → a ustar tar (GNU long names past 100 bytes), two zero blocks at the end. */
function mkTar(entries) {
  const out = [];
  const header = (name, size, type, link = '') => { const h = Buffer.alloc(512); h.write(name.slice(0, 100), 0, 'utf8'); h.write('0000644\0', 100); h.write('0001750\0', 108); h.write('0001750\0', 116); h.write(size.toString(8).padStart(11, '0') + '\0', 124); h.write('14700000000\0', 136); h.write(type, 156); h.write(link, 157); h.write('ustar\0', 257); h.write('00', 263); h.fill(32, 148, 156); let s = 0; for (const b of h) s += b; h.write(s.toString(8).padStart(6, '0') + '\0 ', 148); return h; };
  const pad = (b) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
  for (const e of entries) {
    const data = e.dir || e.link ? Buffer.alloc(0) : Buffer.from(e.data ?? `body of ${e.name}\n`.repeat(e.rep ?? 3)); const nb = Buffer.from(e.name, 'utf8');
    if (nb.length > 100) { out.push(header('././@LongLink', nb.length + 1, 'L'), pad(Buffer.concat([nb, Buffer.alloc(1)]))); }
    const h = header(nb.length > 100 ? nb.subarray(0, 100).toString('latin1') : e.name, data.length, e.dir ? '5' : e.link ? '2' : '0', e.link || ''); if (e.badSum) h[148] = 0x37 ^ h[148];
    out.push(h, pad(data));
  }
  out.push(Buffer.alloc(1024)); return Buffer.concat(out);
}
const dataOf = (e) => (e.dir ? null : Buffer.from(e.data ?? `body of ${e.name}\n`.repeat(e.rep ?? 3)));
let seq = 0;
function setup(buf, ext) { const d = path.join(TMP, `c${++seq}`); fs.mkdirSync(path.join(d, 'src'), { recursive: true }); const file = path.join(d, 'src', `a.${ext}`); fs.writeFileSync(file, buf); return { d, file, dest: path.join(d, 'src', 'out'), registry: path.join(d, 'reg') }; }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
function tree(dir, base = dir, out = {}) { if (!fs.existsSync(dir)) return out; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.name.startsWith(S.SPEC.asideDir)) continue; if (e.isDirectory()) { out[path.relative(base, p).split(path.sep).join('/') + '/'] = 'dir'; tree(p, base, out); } else out[path.relative(base, p).split(path.sep).join('/')] = sha(fs.readFileSync(p)); } return out; }
function expected(entries, rename = (n) => n) { const out = {}; for (const e of entries) { if (e.link) continue; const n = rename(e.name.replace(/\/$/, '')); if (e.dir) out[n + '/'] = 'dir'; else { out[n] = sha(dataOf(e)); const parts = n.split('/'); for (let i = 1; i < parts.length; i++) out[parts.slice(0, i).join('/') + '/'] = 'dir'; } } return out; }
const filesOf = (t) => Object.fromEntries(Object.entries(t).filter(([k]) => !k.endsWith('/')));
const same = (a, b) => JSON.stringify(Object.keys(a).sort().map((k) => [k, a[k]])) === JSON.stringify(Object.keys(b).sort().map((k) => [k, b[k]]));
/** A fake volume: `fillAt` bytes written before ENOSPC (another program filling the disk), crash at the n-th crash point, a hook per point. */
function fakeIo(o = {}) { let used = 0; let hits = 0; const io = { registry: o.registry, hits: () => hits, points: [], async freeSpace() { return o.free ?? 1e12; }, charge(n) { if (o.fillAt != null && used + n > o.fillAt) { const e = new Error('ENOSPC: no space left'); e.code = 'ENOSPC'; throw e; } used += n; }, release(n) { void n; }, async crash(p) { hits++; io.points.push(p); if (o.hook) await o.hook(p, hits); if (o.crashAt === hits) throw new E.Crash(p); } }; return io; }
const pr = (o = {}) => { let n = 0; return { on() {}, stopped: () => (o.stopAfter != null ? ++n > o.stopAfter : false) }; };
const noTraces = (c) => !fs.existsSync(c.file + '.kurokawa-unzip') && !fs.existsSync(c.file + '.kurokawa-tail') && !fs.existsSync(c.file + '.kurokawa-lock');
const lists = async (file) => { try { await E.unitsOf(file); return true; } catch { return false; } };
async function attempt(fn) { try { return { r: await fn() }; } catch (e) { return { e }; } }

const ENTRIES = [{ name: 'readme.txt', rep: 40 }, { name: 'docs/', dir: true }, { name: 'docs/guide.md', method: 0, rep: 30 }, { name: 'docs/deep/note.txt', rep: 200 }, { name: 'pics/a.bin', data: crypto.randomBytes(3000), method: 0 }, { name: 'pics/b.bin', data: Buffer.alloc(5000, 3) }, { name: 'empty.txt', data: '' }, { name: 'last.txt', rep: 9 }];
const build = (fmt, entries) => (fmt === 'zip' ? mkZip(entries) : mkTar(entries));

(async () => {
  const t0 = Date.now();
  /* ---- 1. the name table: vectors in JS; the twins' constants; Java and Rust on the same file ---- */
  {
    const un = (s) => s.replace(/\\u\{([0-9a-f]+)\}|\\\\/gi, (m, h) => (h ? String.fromCodePoint(parseInt(h, 16)) : '\\')); let n = 0;
    for (const line of fs.readFileSync(path.join(__dirname, 'data', 'namesafe-vectors.tsv'), 'utf8').split('\n')) {
      if (!line || line.startsWith('#')) continue; const [kind, pl, inp, act, out, rs, fl] = line.split('\t'); n++; let got;
      if (kind === 'set') { const es = un(inp).split(' | ').filter(Boolean).map((x) => { const t = x[0], r = x.slice(2); if (t === 'd') return { path: r, dir: true }; if (t === 's' || t === 'h') { const [p, tg] = r.split('>'); return { path: p, link: t === 's' ? 'sym' : 'hard', target: tg }; } return { path: r }; }); got = [S.checkSet(es, pl).problems.map((x) => `${x.kind}:${x.path}`).sort().join(',') || '-', '-', '-', '-']; }
      else { const r = kind === 'name' ? S.nameRule(un(inp), pl) : S.pathRule(un(inp), pl); got = [r.action, r.action === 'refuse' ? '-' : r.out, r.reasons.join(',') || '-', r.flags.join(',') || '-']; }
      const want = [kind === 'set' ? un(act) : act, un(out), rs, fl]; ok(`vector ${kind} ${pl} ${inp.slice(0, 40)}`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
    }
    ok('vectors read', n > 100, String(n));
    const spec = S.SPEC; const java = fs.readFileSync(path.join(ROOT, 'native/android/KtNameSafe.java'), 'utf8'); const rust = fs.readFileSync(path.join(ROOT, 'core/kt-core/src/archsafe.rs'), 'utf8');
    const res = spec.reservedNames.map((x) => `"${x}"`).join(', '); ok('Java reserved names = namesafe.json', java.includes(`{ ${res} }`)); ok('Rust reserved names = namesafe.json', rust.includes(`[${res}]`));
    ok('bidi set the same', java.includes(`{ ${spec.bidi.join(', ')} }`) && rust.includes(`[${spec.bidi.join(', ')}]`));
    for (const [name, p] of Object.entries(spec.platforms)) {
      const ill = JSON.stringify(p.illegal); const j = `new Platform("${name}", ${ill}, ${p.control === 'rewrite'}, ${p.trailing === 'rewrite'}, ${p.reserved}, ${p.maxName}, ${p.unit === 'utf16'}, ${p.maxPath}, ${p.longPath}, ${p.foldCase}, ${p.foldForm})`;
      const r = `Platform { name: "${name}", illegal: ${ill}, control_rewrite: ${p.control === 'rewrite'}, trailing_rewrite: ${p.trailing === 'rewrite'}, reserved: ${p.reserved}, max_name: ${p.maxName}, utf16: ${p.unit === 'utf16'}, max_path: ${p.maxPath}, long_path: ${p.longPath}, fold_case: ${p.foldCase}, fold_form: ${p.foldForm} }`;
      ok(`Java platform ${name} = namesafe.json`, java.includes(j), j); ok(`Rust platform ${name} = namesafe.json`, rust.includes(r), r);
    }
    for (const k of ['tempSuffix', 'asideDir']) { ok(`twins' ${k}`, java.includes(`"${spec[k]}"`) && rust.includes(`"${spec[k]}"`)); }
    if (!QUICK) {
      try { const o = execFileSync('sh', [path.join(__dirname, 'native', 'namesafe.sh')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); ok('Java vectors (namesafe.sh)', /all passed/.test(o), o.slice(-300)); } catch (e) { ok('Java vectors (namesafe.sh)', false, String(e.stdout || e.message).slice(-400)); }
      try { const bin = path.join(TMP, 'archsafe_t'); execFileSync('rustc', ['--edition', '2021', '--test', path.join(ROOT, 'core/kt-core/src/archsafe.rs'), '-o', bin], { stdio: 'pipe' }); const o = execFileSync(bin, [], { encoding: 'utf8', stdio: 'pipe' }); ok('Rust vectors (rustc --test archsafe.rs)', /test result: ok/.test(o), o.slice(-300)); } catch (e) { ok('Rust vectors (rustc --test archsafe.rs)', false, String(e.stdout || e.stderr || e.message).slice(-400)); }
    }
  }
  /* ---- 1b. the space replay and the journal check: the same vectors as archsafe.rs ---- */
  for (const line of fs.readFileSync(path.join(__dirname, 'data', 'extractsafe-vectors.tsv'), 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue; const f = line.split('\t');
    if (f[0] === 'replay') { const units = f[1] === '-' ? [] : f[1].split(',').map((u) => { const [o, r] = u.split(':').map(Number); return { out: o, freed: r }; }); const r = S.replaySpace(units, { sameVolume: f[2] === '1', blockSize: Number(f[3]), overhead: Number(f[4]) }); ok(`replay vector ${f[1]}`, r.normal === Number(f[5]) && r.inPlace === Number(f[6]) && r.peakAt === Number(f[7]), JSON.stringify(r)); }
    else { const r = S.journalRead(f[1].replace(/\\n/g, '\n')); ok(`journal vector ${f[2]}`, (r.ok ? 'ok' : r.why) === f[2]); }
  }
  /* ---- 1c. the engine's shared vectors (pre-flight, units, plan, journal and tail text): the same file kt-core's extractjob.rs runs ---- */
  {
    let n = 0; const vt = fs.mkdtempSync(path.join(TMP, 'vec-'));
    for (const line of fs.readFileSync(path.join(__dirname, 'data', 'extractjob-vectors.tsv'), 'utf8').split('\n')) {
      if (!line || line.startsWith('#')) continue; const f = line.split('\t'); n++; let got, want;
      if (f[0] === 'preflight') { const r = S.preflight(JSON.parse(f[1]), { margin: Number(f[2]) }); got = [r.normal.ok ? 1 : 0, r.inPlace.ok ? 1 : 0, r.recommend, r.why, r.problems.map((p) => `${p.kind}:${p.severity}`).sort().join(',') || '-', r.space.normal, r.space.inPlace].join('\t'); want = f.slice(3, 10).join('\t'); }
      else if (f[0] === 'units') { const p = path.join(vt, f[3]); fs.writeFileSync(p, Buffer.from(f[2], 'hex')); let s; try { s = await E.unitsOf(p); } catch (e) { s = null; got = `ERR ${e.message}\t-`; } if (s) got = s.units.map((u) => [u.name, u.start, u.dataStart, u.dataEnd, u.end, u.bad ? 1 : 0].join(':')).join('|') + '\t' + (s.layoutBad.join(',') || '-'); want = f[4] + '\t' + f[5]; }
      else if (f[0] === 'plan') { const dest = fs.mkdtempSync(path.join(vt, 'p-')); if (f[2] !== '-') for (const x of f[2].split('|')) { if (x.endsWith('/')) { fs.mkdirSync(path.join(dest, x), { recursive: true }); continue; } fs.mkdirSync(path.dirname(path.join(dest, x)), { recursive: true }); fs.writeFileSync(path.join(dest, x), 'old'); }
        const scan = { units: f[1].split('|').map((nm) => ({ name: nm, dir: nm.endsWith('/'), start: 0, dataStart: 0, dataEnd: 0, end: 0, method: 0, usize: 0, csize: 0 })) };
        try { const r = E.planOuts(scan, dest, f[5], f[3] === '-' ? undefined : JSON.parse(f[3]), f[4] === '1', 'ID'); got = r.units.map((u) => `${u.kind}:${u.out}`).join('|') + '\t' + (r.moves.map((m) => `${m.from}>${m.to}`).join('|') || '-'); } catch (e) { got = e.message + (e.names ? ' ' + e.names.join(',') : '') + '\t-'; }
        want = f[6] + '\t' + f[7]; }
      else if (f[0] === 'log') { got = JSON.stringify(E.parseLog(JSON.parse(f[1]))); want = f[2]; }
      else if (f[0] === 'own') { got = E.ownOutput(f[1], f[2], f[4] || 'linux') ? '1' : '0'; want = f[3]; }
      else if (f[0] === 'zipend') { got = E.zipEnd(Number(f[1]), Number(f[2]), Number(f[3])).toString('hex'); want = f[4]; }
      else if (f[0] === 'journal') { got = S.journalText(JSON.parse(f[1])).replace(/\n/g, '\\n'); want = f[2]; }
      else if (f[0] === 'tail') { const j = Buffer.from(f[1], 'utf8'); const tb = Buffer.concat([Buffer.from(`KTTAIL2\n${j.length}\n`), j, f[2] === '-' ? Buffer.alloc(0) : Buffer.from(f[2], 'hex')]); got = S.crc32(tb).toString(16).padStart(8, '0'); want = f[3]; }
      ok(`engine vector ${f[0]} ${f[1].slice(0, 50)}`, got === want, `want ${want}\n  got  ${got}`);
    }
    ok('engine vectors read', n >= 60, String(n));
    if (!QUICK) { try { const bin = path.join(TMP, 'extractjob_t'); execFileSync('rustc', ['--edition', '2021', '--test', path.join(ROOT, 'core/kt-core/stdroots/extractjob.rs'), '-o', bin], { stdio: 'pipe' }); const o = execFileSync(bin, [], { encoding: 'utf8', stdio: 'pipe' }); ok('Rust engine (rustc --test stdroots/extractjob.rs): the same vectors and the failure matrix', /test result: ok/.test(o), o.slice(-300)); } catch (e) { ok('Rust engine (rustc --test stdroots/extractjob.rs)', false, String(e.stdout || e.stderr || e.message).slice(-600)); } }
  }
  /* ---- 2. pre-flight: unsupported method in the first / middle / last entry ---- */
  for (const at of [0, 3, 7]) for (const inPlace of [true, false]) {
    const es = ENTRIES.map((e, i) => (i === at ? { ...e, dir: false, name: e.dir ? 'x.zst' : e.name, method: 93 } : e)); const c = setup(mkZip(es), 'zip'); const orig = fs.readFileSync(c.file);
    const { e } = await attempt(() => E.extract(c.file, c.dest, { inPlace, verifyFirst: true, registry: c.registry, answers: { default: 'both' } }, pr(), fakeIo({ registry: c.registry })));
    ok(`unsupported method at ${at} (${inPlace ? 'in place' : 'normal'}) refused before any change`, e && /^refused method/.test(e.message) && e.nothingChanged && fs.readFileSync(c.file).equals(orig) && !fs.existsSync(c.dest) && noTraces(c), e?.message);
    const { report } = await E.preflightOf(c.file, c.dest, {}); ok(`report names the method (${at})`, report.problems.some((p) => p.kind === 'method' && p.methods.includes(93) && p.names.length === 1));
  }
  /* ---- 3. wrong password: proved on the smallest locked file before anything is written ---- */
  {
    const es = [{ name: 'secret/a.txt', rep: 50, pw: 'sesame' }, { name: 'secret/b.txt', rep: 5, pw: 'sesame', method: 0 }]; const c = setup(mkZip(es), 'zip'); const orig = fs.readFileSync(c.file);
    for (const pw of [undefined, 'wrong', 'Sesame']) { const { e } = await attempt(() => E.extract(c.file, c.dest, { password: pw, registry: c.registry }, pr(), fakeIo())); ok(`password ${pw ?? '(none)'} refused before anything is written`, e && /^refused password/.test(e.message) && !fs.existsSync(c.dest) && fs.readFileSync(c.file).equals(orig), e?.message); }
    const pf = await E.preflightOf(c.file, c.dest, { password: 'wrong' }); ok('pre-flight says: wrong password', pf.facts.password === 'wrong' && pf.report.problems.some((p) => p.kind === 'password' && p.names[0] === 'wrong'));
    const { e: ip } = await attempt(() => E.extract(c.file, c.dest, { password: 'sesame', inPlace: true, registry: c.registry }, pr(), fakeIo())); ok('encrypted: never in place', ip && /^refused (encryptedInPlace|method)/.test(ip.message), ip?.message);
    const r = await E.extract(c.file, c.dest, { password: 'sesame', registry: c.registry }, pr(), fakeIo()); ok('right password: extracted and checked', r.files === 2 && same(tree(c.dest), expected(es)));
    // AES: the PBKDF2 verifier (made here: salt + two bytes) checked without 7-Zip.
    const salt = crypto.randomBytes(16); const dk = crypto.pbkdf2Sync('open', salt, 1000, 66, 'sha1'); const scan = { units: [{ encrypted: true, dir: false, csize: 30, method: 99, aes: { strength: 3 }, dataStart: 0 }] }; const af = path.join(TMP, 'aes.bin'); fs.writeFileSync(af, Buffer.concat([salt, dk.subarray(64), Buffer.alloc(12)]));
    ok('AES password verifier', (await E.checkPassword(af, scan, 'open')) === 'ok' && (await E.checkPassword(af, scan, 'shut')) === 'wrong');
  }
  /* ---- 4. damaged entry (CRC) first / middle / last ---- */
  for (const at of [0, 3, 7]) {
    const es = ENTRIES.map((e, i) => (i === at ? { ...e, badCrc: true } : e)); const bad = es[at].name;
    { const c = setup(mkZip(es), 'zip'); const orig = fs.readFileSync(c.file); const { e } = await attempt(() => E.extract(c.file, c.dest, { inPlace: true, verifyFirst: true, registry: c.registry }, pr(), fakeIo()));
      ok(`damaged ${bad}: verify-first refuses in place before any change`, e && /^refused damaged/.test(e.message) && fs.readFileSync(c.file).equals(orig) && noTraces(c), e?.message);
      const r = await E.extract(c.file, c.dest, { inPlace: false, registry: c.registry }, pr(), fakeIo()); const want = expected(es.filter((x) => x.name !== bad));
      ok(`damaged ${bad}: «extract the rest normally» leaves it out and says so`, r.damaged.includes(bad) && same(filesOf(tree(c.dest)), filesOf(want)) && fs.readFileSync(c.file).equals(orig), JSON.stringify(r.damaged)); }
    { const c = setup(mkZip(es), 'zip'); const orig = fs.readFileSync(c.file); E.BATCH.count = 2; const { e } = await attempt(() => E.extract(c.file, c.dest, { inPlace: true, verifyFirst: false, registry: c.registry }, pr(), fakeIo())); E.BATCH.count = 64;
      ok(`damaged ${bad}, verify off: stops at a committed point`, e && /^crcMismatch/.test(e.message) && fs.existsSync(c.file + '.kurokawa-unzip'), e?.message);
      const rr = await E.restore(c.file + '.kurokawa-unzip', fakeIo()); ok(`damaged ${bad}, verify off: Restore gives the archive back byte for byte`, rr.identical && fs.readFileSync(c.file).equals(orig) && noTraces(c) && (await lists(c.file)) && Object.keys(tree(c.dest)).filter((k) => !k.endsWith('/')).length === 0, JSON.stringify(rr)); }
  }
  for (const at of [0, 3, 7]) { // tar: a broken header checksum
    const es = ENTRIES.map((e, i) => (i === at ? { ...e, badSum: true } : e)); const c = setup(mkTar(es), 'tar'); const orig = fs.readFileSync(c.file);
    const { e } = await attempt(() => E.extract(c.file, c.dest, { inPlace: true, verifyFirst: true, registry: c.registry }, pr(), fakeIo())); ok(`tar header ${at} damaged: in place refused before any change`, e && /^refused (layout|damaged)/.test(e.message) && fs.readFileSync(c.file).equals(orig) && noTraces(c), e?.message);
  }
  /* ---- 5. the disk fills at 10 / 50 / 90 % (another program writing), then Finish — and, separately, Restore ---- */
  for (const fmt of ['zip', 'tar']) for (const inPlace of [true, false]) for (const pct of [10, 50, 90]) for (const after of ['finish', 'restore']) {
    const c = setup(build(fmt, ENTRIES), fmt); const orig = fs.readFileSync(c.file); const outBytes = ENTRIES.reduce((a, e) => a + (dataOf(e)?.length ?? 0), 0); E.BATCH.count = 2;
    const { e } = await attempt(() => E.extract(c.file, c.dest, { inPlace, registry: c.registry, answers: { default: 'both' } }, pr(), fakeIo({ fillAt: 400 + Math.floor((outBytes * pct) / 100) + 8000 })));
    const j = inPlace ? c.file + '.kurokawa-unzip' : (fs.readdirSync(c.registry).find((x) => x.endsWith('.kurokawa-unzip')) ? path.join(c.registry, fs.readdirSync(c.registry).find((x) => x.endsWith('.kurokawa-unzip'))) : '');
    const label = `${fmt} ${inPlace ? 'in place' : 'normal'} disk full at ${pct}%`;
    if (!e) { ok(`${label}: (finished before the disk filled)`, true); E.BATCH.count = 64; continue; }
    if (!j || !fs.existsSync(j)) { ok(`${label}: full before the first change — refused, nothing changed`, /^noSpace/.test(e.message) && e.nothingChanged && fs.readFileSync(c.file).equals(orig) && noTraces(c), e.message); E.BATCH.count = 64; continue; }
    ok(`${label}: «noSpace», progress kept`, /^noSpace/.test(e.message) && !!j && fs.existsSync(j), e.message);
    const sh = await E.shelf(c.registry); ok(`${label}: on the shelf with Finish / Restore / Leave`, sh.length === 1 && sh[0].can.join() === 'finish,restore,leave' && sh[0].why === 'noSpace', JSON.stringify(sh));
    if (after === 'finish') { await E.finish(j, pr(), fakeIo()); ok(`${label}: Finish — every file right`, same(tree(c.dest), expected(ENTRIES)) && (inPlace ? !fs.existsSync(c.file) : fs.readFileSync(c.file).equals(orig))); }
    else { const rr = await E.restore(j, fakeIo()); ok(`${label}: Restore — the archive as it was, nothing left extracted`, fs.readFileSync(c.file).equals(orig) && rr.identical && Object.keys(tree(c.dest)).filter((k) => !k.endsWith('/')).length === 0 && noTraces(c) && (await lists(c.file)), JSON.stringify(rr)); }
    E.BATCH.count = 64;
  }
  /* ---- 6. unsafe names, each class, per target ---- */
  {
    const cases = [['meeting 10:30.txt', 'linux', 'meeting 10:30.txt'], ['dosdevices/c:', 'linux', 'dosdevices/c:'], ['meeting 10:30.txt', 'windows', 'meeting 10_30.txt'], ['dir/a:b', 'android-fat', 'dir/a_b'], ['CON.txt', 'windows', '_CON.txt'], ['name.', 'windows', 'name_'], ['a\u0007b', 'windows', 'a_b'], ['a\u0007b', 'linux', 'a\u0007b'], ['.hidden', 'linux', '.hidden'], ['-rf', 'linux', '-rf'], ['\u202egpj.exe', 'linux', '\u202egpj.exe']];
    for (const [name, plat, want] of cases) for (const fmt of ['zip', 'tar']) { const es = [{ name }, { name: 'ok.txt' }]; const c = setup(build(fmt, es), fmt); const r = await E.extract(c.file, c.dest, { inPlace: true, platform: plat, registry: c.registry }, pr(), fakeIo()); ok(`${fmt} «${JSON.stringify(name)}» on ${plat} → «${JSON.stringify(want)}»`, r.files === 2 && fs.existsSync(path.join(c.dest, want)) && !fs.existsSync(c.file), JSON.stringify(tree(c.dest))); }
    for (const [name, plat] of [['C:/x.txt', 'linux'], ['c:x', 'macos'], ['C:\\x', 'windows'], ['../up.txt', 'linux'], ['a/../../b', 'android'], ['/etc/x', 'linux'], ['x.kt-part', 'linux']]) for (const fmt of ['zip', 'tar']) for (const inPlace of [true, false]) {
      const es = [{ name: 'ok.txt' }, { name }]; const c = setup(build(fmt, es), fmt); const orig = fs.readFileSync(c.file);
      const { e } = await attempt(() => E.extract(c.file, c.dest, { inPlace, platform: plat, registry: c.registry }, pr(), fakeIo())); ok(`${fmt} «${name}» on ${plat} (${inPlace ? 'in place' : 'normal'}) refused before any change`, e && /^refused names/.test(e.message) && fs.readFileSync(c.file).equals(orig) && !fs.existsSync(c.dest) && noTraces(c), e?.message);
    }
    const pf = await E.preflightOf(setup(mkZip([{ name: 'a:b.txt' }, { name: 'ab:c.txt' }]), 'zip').file, '/tmp/x', { platform: 'windows' }); ok('the preview lists each rewrite with its reason', pf.report.rewrites.length === 1 && pf.report.rewrites[0].to === 'ab_c.txt' && pf.report.rewrites[0].reasons[0] === 'colon' && pf.report.problems.some((p) => p.kind === 'names'), JSON.stringify(pf.report.rewrites));
  }
  /* ---- 7. duplicate and case-clashing entries ---- */
  for (const fmt of ['zip', 'tar']) for (const [names, plat, inPlaceOk] of [[['a.txt', 'a.txt'], 'linux', false], [['A.txt', 'a.txt'], 'windows', false], [['A.txt', 'a.txt'], 'linux', true], [['Caf\u00e9.txt', 'Cafe\u0301.txt'], 'macos', false]]) {
    const es = names.map((n, i) => ({ name: n, data: `v${i}` })); const c = setup(build(fmt, es), fmt); const orig = fs.readFileSync(c.file);
    const { e, r } = await attempt(() => E.extract(c.file, c.dest, { inPlace: true, platform: plat, registry: c.registry }, pr(), fakeIo()));
    if (inPlaceOk) ok(`${fmt} ${names.join(' + ')} on ${plat}: both kept in place`, r && r.files === 2); else ok(`${fmt} ${names.join(' + ')} on ${plat}: in place refused, nothing changed`, e && /^refused clash/.test(e.message) && fs.readFileSync(c.file).equals(orig) && noTraces(c), e?.message);
    if (!inPlaceOk) { const r2 = await E.extract(c.file, c.dest, { inPlace: false, platform: plat, registry: c.registry, answers: { default: 'both' } }, pr(), fakeIo()); ok(`${fmt} ${names.join(' + ')} on ${plat}: a normal extraction keeps both («(2)»)`, r2.files === 2 && Object.keys(tree(c.dest)).some((k) => k.includes(' (2)')), JSON.stringify(tree(c.dest))); }
  }
  /* ---- 8. a destination file appearing between the pre-flight and the write ---- */
  for (const fmt of ['zip', 'tar']) for (const inPlace of [true, false]) {
    const c = setup(build(fmt, ENTRIES), fmt); const io = fakeIo({ hook: async (p) => { if (p === 'aside') { fs.mkdirSync(c.dest, { recursive: true }); fs.writeFileSync(path.join(c.dest, 'last.txt'), 'theirs'); } } });
    const r = await E.extract(c.file, c.dest, { inPlace, registry: c.registry }, pr(), io); ok(`${fmt} ${inPlace ? 'in place' : 'normal'}: a file that appeared is never overwritten`, fs.readFileSync(path.join(c.dest, 'last.txt'), 'utf8') === 'theirs' && fs.readFileSync(path.join(c.dest, 'last (2).txt')).equals(dataOf(ENTRIES[7])) && r.appeared.includes('last.txt'));
  }
  /* ---- 9. killed after every single step, then Finish — and, from the same point, Restore ---- */
  for (const fmt of ['zip', 'tar']) for (const inPlace of [true, false]) {
    let k = 1; let steps = 0; const label = `${fmt} ${inPlace ? 'in place' : 'normal'}`; let allFinish = true, allRestore = true; E.BATCH.count = 3;
    for (; k < 200; k++) {
      let crashed = false;
      for (const after of ['finish', 'restore']) {
        const c = setup(build(fmt, ENTRIES), fmt); const orig = fs.readFileSync(c.file);
        const { e } = await attempt(() => E.extract(c.file, c.dest, { inPlace, registry: c.registry }, pr(), fakeIo({ crashAt: k, registry: c.registry })));
        if (!e) { if (after === 'finish') ok(`${label}: run to the end with no crash`, same(tree(c.dest), expected(ENTRIES))); continue; }
        crashed = true; if (!e.crash) { ok(`${label} crash ${k}: only the crash stops it`, false, e.message); continue; }
        const sh = await E.shelf(c.registry); const jp = sh[0]?.journal;
        if (after === 'finish') {
          if (!jp) { const r = await E.extract(c.file, c.dest, { inPlace, registry: c.registry }, pr(), fakeIo()); if (!(r && same(tree(c.dest), expected(ENTRIES)))) allFinish = false; continue; }
          await E.finish(jp, pr(), fakeIo()); const good = same(tree(c.dest), expected(ENTRIES)) && (inPlace ? !fs.existsSync(c.file) : fs.readFileSync(c.file).equals(orig));
          if (!good) { allFinish = false; console.log('  finish after crash', k, e.message, JSON.stringify(tree(c.dest)).slice(0, 300)); }
        } else {
          if (jp) await E.restore(jp, fakeIo()); else await E.preflightOf(c.file, c.dest, {});   // (no journal: killed before the first change; the sheet, opened again, tidies)
          const good = fs.readFileSync(c.file).equals(orig) && (await lists(c.file)) && Object.keys(tree(c.dest)).filter((x) => !x.endsWith('/')).length === 0 && noTraces(c);
          if (!good) { allRestore = false; console.log('  restore after crash', k, e.message, fs.existsSync(c.file) ? fs.statSync(c.file).size : 'gone', orig.length); }
        }
      }
      if (!crashed) break; steps++;
    }
    E.BATCH.count = 64;
    ok(`${label}: killed at each of ${steps} steps, Finish always ends with every file right`, allFinish && steps > 5, String(steps));
    ok(`${label}: killed at each of ${steps} steps, Restore always gives the archive back byte for byte`, allRestore && steps > 5, String(steps));
  }
  /* ---- 9b. a Restore itself killed after every step, then taken up again: the archive back byte for byte (a restore killed
     after it wrote the archive's end left it longer than its journal said, and was refused «archiveChanged» before) ---- */
  for (const fmt of ['zip', 'tar']) {
    let k = 1; let good = true;
    for (; k < 100; k++) {
      const c = setup(build(fmt, ENTRIES), fmt); const orig = fs.readFileSync(c.file); E.BATCH.count = 2;
      await attempt(() => E.extract(c.file, c.dest, { inPlace: true, registry: c.registry }, pr({ stopAfter: 2 }), fakeIo())); E.BATCH.count = 64;
      const j = c.file + '.kurokawa-unzip'; const { e } = await attempt(() => E.restore(j, fakeIo({ crashAt: k }))); if (!e) break;
      const { e: e2 } = await attempt(() => E.restore(j, fakeIo()));
      if (!(e.crash && !e2 && fs.readFileSync(c.file).equals(orig) && noTraces(c) && Object.keys(tree(c.dest)).filter((x) => !x.endsWith('/')).length === 0)) { good = false; console.log('  restore crash', k, e.message, e2?.message); }
    }
    ok(`${fmt}: a Restore killed at each of ${k - 1} steps, taken up again, gives the archive back byte for byte`, good && k > 3, String(k));
  }
  /* ---- 10. the journal corrupted, cut, of a later version; the archive changed after the crash; a v1 journal ---- */
  for (const fmt of ['zip', 'tar']) {
    const crashed = async () => { const c = setup(build(fmt, ENTRIES), fmt); E.BATCH.count = 2; await attempt(() => E.extract(c.file, c.dest, { inPlace: true, registry: c.registry }, pr(), fakeIo({ crashAt: 9 }))); E.BATCH.count = 64; return { c, j: c.file + '.kurokawa-unzip' }; };
    for (const [what, spoil, why] of [['corrupted', (t) => t.replace('"next":', '"next" :'), 'journalCorrupt'], ['cut short', (t) => t.slice(0, t.length / 2), 'journalCorrupt'], ['of a later version', (t) => { const o = JSON.parse(t.split('\n')[0]); o.version = 9; const s = JSON.stringify(o); return `${s}\n${S.crc32(s).toString(16).padStart(8, '0')}\n`; }, 'journalFuture']]) {
      const { c, j } = await crashed(); const before = fs.readFileSync(c.file); fs.writeFileSync(j, spoil(fs.readFileSync(j, 'utf8')));
      const { e } = await attempt(() => E.finish(j, pr(), fakeIo())); const sh = await E.shelf(c.registry);
      ok(`${fmt} journal ${what}: never replayed, nothing touched`, e && e.message === why && fs.readFileSync(c.file).equals(before) && sh[0]?.state === 'blocked' && sh[0].why === why && sh[0].can.join() === 'leave', `${e?.message} ${JSON.stringify(sh)}`);
    }
    { const { c, j } = await crashed(); fs.appendFileSync(c.file, 'x'); const before = fs.readFileSync(c.file); const { e } = await attempt(() => E.finish(j, pr(), fakeIo())); const { e: e2 } = await attempt(() => E.restore(j, fakeIo()));
      ok(`${fmt} archive changed after the crash: neither Finish nor Restore replays the journal`, e?.message === 'archiveChanged' && e2?.message === 'archiveChanged' && fs.readFileSync(c.file).equals(before)); }
    { const { c, j } = await crashed(); const fd = fs.openSync(c.file, 'r+'); fs.writeSync(fd, Buffer.from('ZZ'), 0, 2, 0); fs.closeSync(fd); const { e } = await attempt(() => E.finish(j, pr(), fakeIo())); ok(`${fmt} archive's first bytes rewritten after the crash: refused`, e?.message === 'archiveChanged', e?.message); }
  }
  { const c = setup(mkZip(ENTRIES), 'zip'); fs.writeFileSync(c.file + '.kurokawa-unzip', JSON.stringify({ version: 1, committed: 100, output: c.dest, length: 999 })); await E.register(c.registry, c.file + '.kurokawa-unzip', 'old1'); const sh = await E.shelf(c.registry); ok('a v1 journal: offered restore-only (the old way)', sh[0]?.why === 'journalV1' && sh[0].can.join() === 'restoreV1,leave', JSON.stringify(sh)); }
  /* ---- 11. two jobs on the same archive ---- */
  { const c = setup(mkZip(ENTRIES), 'zip'); let release; const gate = new Promise((r) => { release = r; }); let reached; const at = new Promise((r) => { reached = r; });
    const a = E.extract(c.file, c.dest, { inPlace: true, registry: c.registry }, pr(), fakeIo({ hook: async (p) => { if (p === 'unit') { reached(); await gate; } } }));
    await at; const { e } = await attempt(() => E.extract(c.file, path.join(c.d, 'other'), { inPlace: false, registry: c.registry }, pr(), fakeIo())); release(); const r = await a;
    ok('a second job on the same archive is refused while the first runs', e?.message === 'busy' && r.files === 7 && same(tree(c.dest), expected(ENTRIES)), e?.message); }
  /* ---- 12. cancel mid-run: the unit in flight finished, stopped at a committed point ---- */
  for (const fmt of ['zip', 'tar']) { const c = setup(build(fmt, ENTRIES), fmt); E.BATCH.count = 2; const { e } = await attempt(() => E.extract(c.file, c.dest, { inPlace: true, registry: c.registry }, pr({ stopAfter: 2 }), fakeIo())); E.BATCH.count = 64;
    const sh = await E.shelf(c.registry); ok(`${fmt} cancel: stopped at a committed point, on the shelf`, e?.message === 'stopped' && sh[0]?.state === 'paused' && sh[0].done > 0, e?.message);
    await E.finish(sh[0].journal, pr(), fakeIo()); ok(`${fmt} cancel, then Finish: every file right`, same(tree(c.dest), expected(ENTRIES)) && !fs.existsSync(c.file)); }
  /* ---- 13. Undo of a job with replacements (and skip, keep both) ---- */
  for (const fmt of ['zip', 'tar']) for (const inPlace of [true, false]) {
    const c = setup(build(fmt, ENTRIES), fmt); const orig = fs.readFileSync(c.file); fs.mkdirSync(path.join(c.dest, 'docs'), { recursive: true }); fs.writeFileSync(path.join(c.dest, 'readme.txt'), 'old readme'); fs.writeFileSync(path.join(c.dest, 'docs/guide.md'), 'old guide'); fs.writeFileSync(path.join(c.dest, 'last.txt'), 'old last');
    const { e: un } = await attempt(() => E.extract(c.file, c.dest, { inPlace, registry: c.registry }, pr(), fakeIo())); ok(`${fmt}: existing files must be answered first`, un?.message === 'conflictsUnanswered' && un.names.length === 3 && fs.readFileSync(c.file).equals(orig));
    const r = await E.extract(c.file, c.dest, { inPlace, registry: c.registry, answers: { default: 'replace', per: { 'last.txt': 'skip' }, files: undefined } }, pr(), fakeIo());
    const t = tree(c.dest); ok(`${fmt} ${inPlace ? 'in place' : 'normal'}: replaced (old aside), skipped kept`, fs.readFileSync(path.join(c.dest, 'readme.txt')).equals(dataOf(ENTRIES[0])) && fs.readFileSync(path.join(c.dest, 'last.txt'), 'utf8') === 'old last' && fs.readdirSync(c.dest).some((x) => x.startsWith(S.SPEC.asideDir)), JSON.stringify(t));
    await E.undo(r.job, fakeIo()); const back = tree(c.dest);
    ok(`${fmt} ${inPlace ? 'in place' : 'normal'}: Undo puts every replaced file back and removes what was extracted`, fs.readFileSync(path.join(c.dest, 'readme.txt'), 'utf8') === 'old readme' && fs.readFileSync(path.join(c.dest, 'docs/guide.md'), 'utf8') === 'old guide' && fs.readFileSync(path.join(c.dest, 'last.txt'), 'utf8') === 'old last' && Object.keys(back).filter((x) => !x.endsWith('/')).length === 3 && !fs.readdirSync(c.dest).some((x) => x.startsWith(S.SPEC.asideDir)) && fs.readFileSync(c.file).equals(orig), JSON.stringify(back));
    // keep both, then the offer dismissed: the aside folder and the saved tail cleaned
    const c2 = setup(build(fmt, ENTRIES), fmt); fs.mkdirSync(c2.dest, { recursive: true }); fs.writeFileSync(path.join(c2.dest, 'readme.txt'), 'old');
    const r2 = await E.extract(c2.file, c2.dest, { inPlace, registry: c2.registry, answers: { files: 'both' } }, pr(), fakeIo()); ok(`${fmt}: keep both — «readme (2).txt»`, fs.readFileSync(path.join(c2.dest, 'readme (2).txt')).equals(dataOf(ENTRIES[0])) && fs.readFileSync(path.join(c2.dest, 'readme.txt'), 'utf8') === 'old');
    await E.dismiss(r2.job); ok(`${fmt}: the Undo offer dismissed — nothing of the job left`, !fs.existsSync(r2.job) && !fs.readdirSync(c2.dest).some((x) => x.startsWith(S.SPEC.asideDir)) && (await E.shelf(c2.registry)).length === 0);
  }
  { const c = setup(mkZip(ENTRIES), 'zip'); fs.mkdirSync(c.dest, { recursive: true }); fs.writeFileSync(path.join(c.dest, 'readme.txt'), 'old'); await E.extract(c.file, c.dest, { inPlace: true, registry: c.registry, answers: { default: 'replace' } }, pr(), fakeIo()); const sh = await E.shelf(c.registry, { atStart: true }); ok('at the next start a finished job\'s aside folder is cleaned', sh.length === 0 && !fs.readdirSync(c.dest).some((x) => x.startsWith(S.SPEC.asideDir))); }
  /* ---- 14. 5,000 entries within a counted budget ---- */
  for (const fmt of ['zip', 'tar']) {
    const es = Array.from({ length: 5000 }, (_, i) => ({ name: `d${i % 50}/f${i}.txt`, data: `#${i}`, method: i % 2 ? 8 : 0 })); const c = setup(build(fmt, es), fmt); const io = fakeIo(); const t1 = Date.now();
    const r = await E.extract(c.file, c.dest, { inPlace: true, registry: c.registry }, pr(), io); const ms = Date.now() - t1; const journals = io.points.filter((p) => p === 'journal').length;
    ok(`${fmt} 5,000 entries in place: right, ≤ ${Math.ceil(5000 / 64) + 3} journal writes, under 60 s`, r.files === 5000 && journals <= Math.ceil(5000 / 64) + 3 && ms < 60000 && Object.keys(tree(c.dest)).length === 5050, `${journals} journals, ${ms} ms`);
  }
  /* ---- 15. names from every script; zero-byte files, folders only, nested empty folders, an empty archive ---- */
  for (const fmt of ['zip', 'tar']) for (const inPlace of [true, false]) {
    const sets = { scripts: [{ name: 'كتب/إعجاز القرآن.txt' }, { name: '日本語/進撃の巨人.txt' }, { name: '\u{1f600}/\u{1f389}.txt' }, { name: 'Cafe\u0301.txt' }, { name: 'a'.repeat(120) + '/long name.txt' }], empty: [{ name: 'z1', data: '' }, { name: 'z/z2', data: '' }], dirs: [{ name: 'only/', dir: true }, { name: 'only/nested/', dir: true }, { name: 'only/nested/deeper/', dir: true }], none: [] };
    for (const [k, es] of Object.entries(sets)) { const c = setup(build(fmt, es), fmt); const r = await E.extract(c.file, c.dest, { inPlace, registry: c.registry }, pr(), fakeIo()); ok(`${fmt} ${inPlace ? 'in place' : 'normal'} ${k}`, r.files === es.filter((e) => !e.dir).length && same(tree(c.dest), expected(es)) && (inPlace ? !fs.existsSync(c.file) : true), JSON.stringify(tree(c.dest)).slice(0, 200)); }
  }
  /* ---- 15b. tar devices, FIFOs and sparse files are never made: refused in place, left out of a normal extraction and reported ---- */
  { const es = [{ name: 'a.txt' }, { name: 'z.txt' }]; const tarOf = () => { const b = mkTar(es); const dev = mkTar([{ name: 'pipe' }]).subarray(0, 512); dev[156] = 0x36; dev.fill(32, 148, 156); dev.write('0000000', 124); let s = 0; for (const v of dev) s += v; dev.write(s.toString(8).padStart(6, '0') + '\0 ', 148); return Buffer.concat([dev, b]); };
    const c = setup(tarOf(), 'tar'); const orig = fs.readFileSync(c.file); const { e } = await attempt(() => E.extract(c.file, c.dest, { inPlace: true, registry: c.registry }, pr(), fakeIo()));
    ok('a FIFO in a tar: in place refused before any change', e && /^refused layout/.test(e.message) && fs.readFileSync(c.file).equals(orig) && noTraces(c), e?.message);
    const r = await E.extract(c.file, c.dest, { registry: c.registry }, pr(), fakeIo()); ok('a FIFO in a tar: a normal extraction leaves it out and says so', r.damaged.includes('pipe') && !fs.existsSync(path.join(c.dest, 'pipe')) && fs.existsSync(path.join(c.dest, 'z.txt')), JSON.stringify(r)); }
  /* ---- 16. the report: space (peak, both modes, other volume), volumes, read-only, ratio ---- */
  {
    const f = { format: 'zip', platform: 'linux', entries: [{ path: 'a', usize: 1000, csize: 900, method: 8, offset: 0 }, { path: 'b', usize: 9000, csize: 8900, method: 8, offset: 1000 }], supported: [0, 8], password: 'none', archiveWritable: true, destWritable: true, sameVolume: true, free: 12000, inPlaceFormat: true, blockSize: 1 };
    const r = S.preflight(f); ok('space: normal = every output; in place = the peak', r.space.normal === 65536 + 10000 && r.space.inPlace === 65536 + 9000, JSON.stringify(r.space));
    const sp = S.replaySpace([{ out: 9000, freed: 8900 }, { out: 1000, freed: 900 }], { blockSize: 1 }); ok('replay: peak after the first unit', sp.inPlace === 9000 && sp.normal === 10000 && sp.peakAt === 0, JSON.stringify(sp));
    ok('replay: another volume frees nothing', S.replaySpace([{ out: 9000, freed: 8900 }, { out: 1000, freed: 900 }], { blockSize: 1, sameVolume: false }).inPlace === 10000);
    const r2 = S.preflight({ ...f, free: 70000, sameVolume: false }); ok('another volume: in place refused, said why', !r2.inPlace.ok && r2.inPlace.why.includes('otherVolume'));
    const r3 = S.preflight({ ...f, free: 75000 }); ok('only in place fits: recommended', r3.recommend === 'inPlace' && r3.why === 'onlyInPlaceFits' && !r3.normal.ok, JSON.stringify([r3.recommend, r3.why]));
    const r4 = S.preflight({ ...f, free: 1e9 }); ok('both fit: normal recommended', r4.recommend === 'normal' && r4.why === 'bothFit');
    const r5 = S.preflight({ ...f, archiveWritable: false, free: 1e9 }); ok('a read-only archive: in place off, the reason given', !r5.inPlace.ok && r5.problems.some((p) => p.kind === 'readonly'));
    const r6 = S.preflight({ ...f, saf: true, free: 1e9 }); ok('a SAF-only place: in place off', !r6.inPlace.ok && r6.inPlace.why.includes('saf'));
    const r7 = S.preflight({ ...f, entries: [{ path: 'bomb', usize: 5 * 1024 ** 3, csize: 5 * 1024 ** 2, method: 8 }], free: 1e12 }); ok('a zip bomb ratio flagged calmly with the numbers', r7.problems.some((p) => p.kind === 'ratio' && p.ratio === 1024 && p.severity === 'info') && r7.normal.ok);
    const r8 = S.preflight({ ...f, volumes: { missing: ['x.zip.003'], odd: [] }, free: 1e9 }); ok('a missing volume refuses both', !r8.ok && r8.problems.some((p) => p.kind === 'volumes' && p.names[0] === 'x.zip.003'));
    const r9 = S.preflight({ ...f, existing: ['a'], free: 1e9 }); ok('existing files counted to ask', r9.problems.some((p) => p.kind === 'existing' && p.count === 1));
  }
  /* ---- 17. P11 review (the same as kt-core extractjob.rs's tests): Undo never touches a file that took the archive's name; originals never lost;
     the job's own names refused; a bad local header left out (no throw); only the job's own leftovers removed ---- */
  for (const fmt of ['zip', 'tar']) {
    const c = setup(build(fmt, ENTRIES), fmt); const orig = fs.readFileSync(c.file); const r = await E.extract(c.file, c.dest, { inPlace: true, registry: c.registry }, pr(), fakeIo());
    fs.writeFileSync(c.file, 'MY OTHER IMPORTANT FILE'); const u = await E.undo(r.job, fakeIo());
    ok(`${fmt}: Undo of a finished job never touches a new file at the archive's path; the archive made again beside it`, fs.readFileSync(c.file, 'utf8') === 'MY OTHER IMPORTANT FILE' && path.basename(u.restoredTo || '') === `a (2).${fmt}` && u.identical && fs.readFileSync(u.restoredTo).equals(orig), JSON.stringify(u));
  }
  { let k = 1; let good = true;
    for (; k < 100; k++) { const c = setup(mkZip(ENTRIES), 'zip'); const r = await E.extract(c.file, c.dest, { inPlace: true, registry: c.registry }, pr(), fakeIo()); const { e } = await attempt(() => E.restore(r.job, fakeIo({ crashAt: k }))); if (!e) break;
      const j = JSON.parse(fs.readFileSync(r.job, 'utf8').split('\n')[0]); if (j.restoreAt && fs.existsSync(j.restoreAt)) { fs.writeFileSync(j.restoreAt, Buffer.alloc(100000, 7)); const { e: e2 } = await attempt(() => E.restore(r.job, fakeIo())); if (e2?.message !== 'archiveChanged' || !fs.readFileSync(j.restoreAt).equals(Buffer.alloc(100000, 7))) { good = false; console.log('  restore crash', k, e2?.message); } } }
    ok(`a finished job's restore killed at each of ${k - 1} steps, its file then replaced: never cut or extended`, good && k > 5, String(k)); }
  for (const fmt of ['zip', 'tar']) for (const inPlace of [true, false]) {
    const c = setup(build(fmt, ENTRIES), fmt); fs.mkdirSync(c.dest, { recursive: true }); fs.writeFileSync(path.join(c.dest, 'readme.txt'), 'ORIGINAL');
    const r = await E.extract(c.file, c.dest, { inPlace, registry: c.registry, answers: { default: 'replace' } }, pr(), fakeIo()); fs.writeFileSync(path.join(c.dest, 'readme.txt'), 'edited after'); const u = await E.undo(r.job, fakeIo());
    ok(`${fmt} ${inPlace ? 'in place' : 'normal'}: Undo puts the replaced original back as «readme (original).txt» when the name is taken`, fs.readFileSync(path.join(c.dest, 'readme (original).txt'), 'utf8') === 'ORIGINAL' && fs.readFileSync(path.join(c.dest, 'readme.txt'), 'utf8') === 'edited after' && JSON.stringify(u.originals) === '["readme (original).txt"]', JSON.stringify(u));
  }
  for (const name of ['a.zip.kurokawa-unzip.tmp', 'a.zip.kurokawa-tail', 'a.zip.kurokawa-lock', 'a.zip', '.kurokawa-replaced-x/a.txt']) for (const inPlace of [true, false]) {
    const c = setup(mkZip([{ name, data: 'precious data' }, { name: 'y.txt' }]), 'zip'); const orig = fs.readFileSync(c.file);
    const { e } = await attempt(() => E.extract(c.file, path.dirname(c.file), { inPlace, registry: c.registry }, pr(), fakeIo())); ok(`an entry «${name}» (${inPlace ? 'in place' : 'normal'}): refused as a name, nothing changed`, /^refused names/.test(e?.message) && fs.readFileSync(c.file).equals(orig), e?.message);
  }
  { const b = mkZip([{ name: 'x.txt' }, { name: 'y.txt' }]); b[30 + 5 + zlib.deflateRawSync(Buffer.from('body of x.txt\n'.repeat(3))).length] = 0; const c = setup(b, 'zip'); const orig = fs.readFileSync(c.file);
    const { e } = await attempt(() => E.extract(c.file, c.dest, { inPlace: true, registry: c.registry }, pr(), fakeIo())); ok('a bad local header: in place refused before any change', /^refused layout/.test(e?.message) && fs.readFileSync(c.file).equals(orig) && noTraces(c), e?.message);
    const { r, e: e2 } = await attempt(() => E.extract(c.file, c.dest, { registry: c.registry }, pr(), fakeIo())); ok('a bad local header: a normal extraction leaves it out and says so (no throw)', r && JSON.stringify(r.damaged) === '["y.txt"]' && fs.existsSync(path.join(c.dest, 'x.txt')), e2?.message || JSON.stringify(r)); }
  for (const fmt of ['tar', 'zip']) { let k = 1; let good = true; const theirs = Buffer.alloc(dataOf(ENTRIES[7]).length, 84); E.BATCH.count = 3;
    for (; k < 200; k++) { const c = setup(build(fmt, ENTRIES), fmt); fs.mkdirSync(c.dest, { recursive: true }); fs.writeFileSync(path.join(c.dest, 'last.txt'), theirs);
      const { e } = await attempt(() => E.extract(c.file, c.dest, { registry: c.registry, answers: { default: 'both' } }, pr(), fakeIo({ crashAt: k, registry: c.registry }))); if (!e) break;
      const sh = await E.shelf(c.registry); if (!sh[0]) continue; await E.finish(sh[0].journal, pr(), fakeIo());
      if (!fs.readFileSync(path.join(c.dest, 'last.txt')).equals(theirs) || !fs.readFileSync(path.join(c.dest, 'last (2).txt')).equals(dataOf(ENTRIES[7])) || fs.existsSync(path.join(c.dest, 'last (3).txt'))) { good = false; console.log('  leftovers', fmt, k); } }
    E.BATCH.count = 64; ok(`${fmt}: killed at each of ${k - 1} steps, Finish removes only the job's own leftovers (their same-size file stays; no third copy)`, good && k > 5, String(k)); }
  /* ---- 17b. round 3 (kt-core extractjob.rs's tests too): no name forges a unit-log record; a job's own names refused through a linked destination;
     a planted journal never replayed; power lost after the archive was removed ---- */
  { const c = setup(Buffer.alloc(0), 'zip'); const victim = path.join(c.d, 'victim.txt'); const vb = Buffer.from('user data!!\n'); fs.writeFileSync(victim, vb);
    fs.writeFileSync(c.file, mkZip([{ name: 'pad.bin', data: Buffer.alloc(vb.length, 122), method: 0, badCrc: true }, { name: `x\n0\t${victim}\t${S.crc32(vb)}`, data: 'hi', method: 0 }]));
    await attempt(() => E.extract(c.file, c.dest, { inPlace: true, platform: 'linux', registry: c.registry }, pr(), fakeIo()));
    const jp = c.file + '.kurokawa-unzip'; if (fs.existsSync(jp)) { fs.writeFileSync(jp + '.log', JSON.stringify({ i: 0, out: victim, crc: S.crc32(vb) }) + '\n'); await attempt(() => E.finish(jp, pr(), fakeIo())); }
    ok('a name with a newline and a tab cannot forge a unit-log record; a forged record never deletes outside the destination', fs.readFileSync(victim).equals(vb)); }
  if (process.platform !== 'win32') for (const name of ['a.zip.kurokawa-unzip.tmp', 'a.zip.kurokawa-unzip.log', 'sub/x.KUROKAWA-TAIL', 'b.kurokawa-lock.tmp']) {
    const c = setup(mkZip([{ name, data: 'PRECIOUS ENTRY DATA' }, { name: 'y.txt' }]), 'zip'); const link = path.join(c.d, 'dl'); fs.symlinkSync(path.dirname(c.file), link); const orig = fs.readFileSync(c.file);
    const { e } = await attempt(() => E.extract(c.file, link, { inPlace: true, registry: c.registry }, pr(), fakeIo())); ok(`«${name}» through a linked destination: refused as a name, nothing changed`, /^refused names/.test(e?.message) && fs.readFileSync(c.file).equals(orig), e?.message); }
  { const c = setup(mkZip([]), 'zip'); const victim = path.join(c.d, 'Documents'); fs.mkdirSync(victim); fs.writeFileSync(path.join(victim, 'thesis.txt'), 'years of work');
    const plan = { format: 'zip', size: 22, tailStart: 0, idCrc: 0, dest: 'x', units: [] }; const j0 = Buffer.from(JSON.stringify(plan)); const tb = Buffer.concat([Buffer.from(`KTTAIL2\n${j0.length}\n`), j0]); const tp = c.file + '.kurokawa-tail'; fs.writeFileSync(tp, tb);
    let good = true;
    for (const [mode, aside, from] of [['normal', 'x', victim], ['inplace', 'x', '../Documents'], ['inplace', '.kurokawa-replaced-e', '../Documents'], ['inplace', '.kurokawa-replaced-f', 'a.txt']]) {
      fs.writeFileSync(c.file + '.kurokawa-unzip', S.journalText({ registry: null, id: 'e', mode, format: 'zip', archive: c.file, dest: path.dirname(c.file), tail: tp, tailLen: tb.length, tailCrc: S.crc32(tb), committed: 22, prevCommitted: 22, next: 0, outs: {}, raws: {}, aside: { dir: aside, moves: [{ from, to: `${aside}/replaced/${from}` }], moved: 0 }, state: 'paused', platform: 'linux', created: 0, password: false }));
      const { e } = await attempt(() => E.finish(c.file + '.kurokawa-unzip', pr(), fakeIo())); const { e: e2 } = await attempt(() => E.finishBeside(c.file, pr(), fakeIo())); const { e: e3 } = await attempt(() => E.dismiss(c.file + '.kurokawa-unzip'));
      if (e?.message !== 'journalCorrupt' || e2?.message !== 'journalCorrupt' || !e3 || !fs.existsSync(path.join(victim, 'thesis.txt'))) { good = false; console.log('  planted', mode, aside, from, e?.message, e2?.message); }
    }
    ok('a planted journal (outside paths, a foreign aside folder, a normal job beside an archive) is never replayed: the folder untouched', good); }
  { let k = 1; let good = true; let hit = 0; E.BATCH.count = 3;
    for (; k < 100; k++) { const c = setup(mkZip(ENTRIES), 'zip'); const orig = fs.readFileSync(c.file); const { e } = await attempt(() => E.extract(c.file, c.dest, { inPlace: true, registry: c.registry }, pr(), fakeIo({ crashAt: k }))); if (!e) break;
      // (the archive cut to nothing, or already removed — round four removes it before saying «done»: what a power loss there leaves)
      const jp = c.file + '.kurokawa-unzip'; const size = fs.existsSync(c.file) ? fs.statSync(c.file).size : 0; if (!fs.existsSync(jp) || size !== 0) continue; hit++; fs.rmSync(c.file, { force: true });
      const { e: ef } = await attempt(() => E.finish(jp, pr(), fakeIo())); const ok1 = !ef && same(tree(c.dest), expected(ENTRIES)); const { r: u, e: eu } = await attempt(() => E.undo(jp, fakeIo()));
      if (!ok1 || eu || !u.identical || !fs.readFileSync(c.file).equals(orig)) { good = false; console.log('  power loss', k, ef?.message, eu?.message); } }
    E.BATCH.count = 64; ok(`power lost after the archive was removed, before «done» (${hit} points): Finish, then Undo gives the archive back`, good && hit > 0, String(hit)); }
  /* ---- 18. across the two engines (the same journal, tail, unit log and part names): a job the JavaScript engine was killed in at every cut point is
     finished — or restored — by the Rust engine (core/kt-core/stdroots/extractjob_cli.rs, std only), and the reverse ---- */
  if (!QUICK) {
    const cli = path.join(TMP, 'extractjob_cli'); let built = true;
    try { execFileSync('rustc', ['--edition', '2021', '-O', path.join(ROOT, 'core/kt-core/stdroots/extractjob_cli.rs'), '-o', cli], { stdio: 'pipe' }); } catch (e) { built = false; ok('cross-shell: the Rust engine program built', false, String(e.stderr || e.message).slice(-400)); }
    const rs = (...args) => execFileSync(cli, args, { encoding: 'utf8' }).trim();
    const STORED = ENTRIES.map((e) => (e.dir ? e : { ...e, method: 0 }));   // (std has no inflate: stored entries)
    // (Each with a file already there answered «keep both» — the conflict, the unit log and «name (2)» crossing too.)
    const seed = (c) => { fs.mkdirSync(c.dest, { recursive: true }); fs.writeFileSync(path.join(c.dest, 'last.txt'), 'theirs'); };
    const want = () => ({ ...expected(STORED), 'last.txt': sha(Buffer.from('theirs')), 'last (2).txt': sha(dataOf(ENTRIES[7])) });
    const both = { default: 'both' };
    if (built) for (const fmt of ['zip', 'tar']) for (const inPlace of [true, false]) for (const dir of ['js→rust', 'rust→js']) {
      let k = 1; let good = true; let handed = 0; E.BATCH.count = 3;
      for (; k < 200; k++) {
        let crashed = false;
        for (const after of ['finish', 'restore']) {
          const c = setup(build(fmt, STORED), fmt); const orig = fs.readFileSync(c.file); seed(c);
          if (dir === 'js→rust') { const { e } = await attempt(() => E.extract(c.file, c.dest, { inPlace, registry: c.registry, answers: both }, pr(), fakeIo({ crashAt: k, registry: c.registry }))); if (!e) continue; }
          else { const o = rs('extract', c.file, c.dest, c.registry, inPlace ? '1' : '0', String(k), JSON.stringify(both)); if (!o.startsWith('CRASH')) continue; }
          crashed = true; const sh = await E.shelf(c.registry); const jp = sh[0]?.journal; if (!jp) continue; handed++;
          let res;
          if (dir === 'js→rust') res = rs(after, jp); else { const { r, e } = await attempt(() => (after === 'finish' ? E.finish(jp, pr(), fakeIo()) : E.restore(jp, fakeIo()))); res = e ? 'ERR ' + e.message : JSON.stringify(r); }
          const fine = !res.startsWith('ERR') && (after === 'finish' ? same(tree(c.dest), want()) && (inPlace ? !fs.existsSync(c.file) : fs.readFileSync(c.file).equals(orig)) : fs.readFileSync(c.file).equals(orig) && JSON.stringify(Object.keys(tree(c.dest)).filter((x) => !x.endsWith('/'))) === '["last.txt"]' && noTraces(c));
          if (!fine) { good = false; console.log('  cross', dir, fmt, inPlace, 'crash', k, after, res.slice(0, 160)); }
        }
        if (!crashed) break;
      }
      E.BATCH.count = 64; ok(`cross-shell ${dir} ${fmt} ${inPlace ? 'in place' : 'normal'}: killed at each of ${k - 1} steps (a «keep both» answer too), the other engine finishes and restores (${handed} hand-overs)`, good && handed > 5, String(handed));
      // a finished job undone by the other engine
      { const c = setup(build(fmt, STORED), fmt); const orig = fs.readFileSync(c.file); seed(c); let job;
        if (dir === 'js→rust') job = (await E.extract(c.file, c.dest, { inPlace, registry: c.registry, answers: both }, pr(), fakeIo())).job; else job = JSON.parse(rs('extract', c.file, c.dest, c.registry, inPlace ? '1' : '0', '0', JSON.stringify(both))).job;
        const res = dir === 'js→rust' ? rs('undo', job) : JSON.stringify(await E.undo(job, fakeIo()));
        ok(`cross-shell ${dir} ${fmt} ${inPlace ? 'in place' : 'normal'}: a finished job undone by the other engine`, !res.startsWith('ERR') && fs.readFileSync(c.file).equals(orig) && JSON.stringify(Object.keys(tree(c.dest)).filter((x) => !x.endsWith('/'))) === '["last.txt"]', res.slice(0, 200)); }
    }
  }
  /* ---- 19. round four (kt-core extractjob.rs's tests too): «keep both» of a name at the limit; a job beside an archive finished without asking only
   *  when this app started it; restore and listing only for that very archive; a finished job's journal beside a new archive; journal rules ---- */
  const L = 'n'.repeat(243) + '.txt'; const CUT = S.bothForm(L, 2, 247); const WHOLE = 'n'.repeat(243) + ' (2).txt';
  ok('round 4: «keep both» of a 247-byte name stays within the limit; the whole form (older builds) and the cut one are the unit\'s own', CUT === 'n'.repeat(239) + ' (2).txt' && S.keepBothName(L, (c) => c === CUT, false, 'linux') === S.bothForm(L, 3, 247) && E.ownOutput(L, CUT) && E.ownOutput(L, WHOLE) && !E.ownOutput(L, 'n'.repeat(238) + ' (2).txt') && S.bothForm('ب'.repeat(243) + '.txt', 2, 247, 'utf16').length === 247 && S.bothForm('a.' + 'e'.repeat(244), 2, 247) === 'a.' + 'e'.repeat(241) + ' (2)');
  { const es = [{ name: 'b.txt', rep: 4 }, { name: L, rep: 5 }, { name: 'c.txt', rep: 6 }]; const zip = mkZip(es); let k = 1; let good = true; let oldDone = false; E.BATCH.count = 1;
    const theirsOnly = (c) => fs.readFileSync(path.join(c.dest, L), 'utf8') === 'THEIRS' && Object.keys(tree(c.dest)).filter((x) => !x.endsWith('/')).length === 1;
    for (; k < 200; k++) {
      const c = setup(zip, 'zip'); fs.mkdirSync(c.dest, { recursive: true }); fs.writeFileSync(path.join(c.dest, L), 'THEIRS'); const jp = c.file + '.kurokawa-unzip';
      const { e } = await attempt(() => E.extract(c.file, c.dest, { inPlace: true, registry: c.registry, answers: { default: 'both' }, platform: 'linux' }, pr(), fakeIo({ crashAt: k })));
      if (!e) { good = good && fs.readFileSync(path.join(c.dest, CUT)).equals(dataOf(es[1])); break; }
      if (!fs.existsSync(jp)) continue;
      const { r: job, e: eo } = await attempt(() => E.openJob(jp)); if (eo) { good = false; console.log('  long name: journal refused at', k, eo.message); continue; }
      const placed = job.plan.units.some((u) => u.out === CUT && u.i < job.j.next) && fs.existsSync(path.join(c.dest, CUT));
      if (placed && !oldDone) {
        // as a build before round four left it: the plan and the journal name the whole «name (2)», and that file is there
        oldDone = true; const t = fs.readFileSync(job.j.tail); const a = t.indexOf(10); const b = t.indexOf(10, a + 1); const n = Number(t.subarray(a + 1, b).toString()); const pj = t.subarray(b + 1, b + 1 + n).toString().split(JSON.stringify(CUT)).join(JSON.stringify(WHOLE)); const pjb = Buffer.from(pj);
        const tb = Buffer.concat([Buffer.from(`KTTAIL2\n${pjb.length}\n`), pjb, t.subarray(b + 1 + n)]); fs.writeFileSync(job.j.tail, tb);
        const j = { ...job.j, tailLen: tb.length, tailCrc: S.crc32(tb), outs: Object.fromEntries(Object.entries(job.j.outs || {}).map(([x, v]) => [x, v === CUT ? WHOLE : v])) }; fs.writeFileSync(jp, S.journalText(j));
        fs.renameSync(path.join(c.dest, CUT), path.join(c.dest, WHOLE)); fs.rmSync(jp + '.log', { force: true });
        const { e: ef } = await attempt(() => E.finish(jp, pr(), fakeIo())); const { r: u, e: eu } = await attempt(() => E.undo(jp, fakeIo()));
        if (ef || eu || !u.identical || !theirsOnly(c) || !fs.readFileSync(c.file).equals(zip)) { good = false; console.log('  old journal', k, ef?.message, eu?.message); }
      } else if (k % 2 === 0) {
        const { e: ef } = await attempt(() => E.finish(jp, pr(), fakeIo())); const okf = !ef && fs.readFileSync(path.join(c.dest, CUT)).equals(dataOf(es[1]));
        const { r: u, e: eu } = await attempt(() => E.undo(jp, fakeIo())); if (!okf || eu || !u.identical || !theirsOnly(c) || !fs.readFileSync(c.file).equals(zip)) { good = false; console.log('  long name finish/undo', k, ef?.message, eu?.message); }
      } else {
        const { r: u, e: eu } = await attempt(() => E.restore(jp, fakeIo())); if (eu || !u.identical || !theirsOnly(c) || !fs.readFileSync(c.file).equals(zip)) { good = false; console.log('  long name restore', k, eu?.message); }
      }
    }
    E.BATCH.count = 64; ok(`round 4: «keep both» of a 247-byte name — every one of ${k - 1} stopping points finishes and undoes, or restores; a journal an older build wrote with the whole name still opens`, good && oldDone); }
  const stoppedInPlace = async () => { const c = setup(mkZip(ENTRIES), 'zip'); E.BATCH.count = 3; const f = fakeIo(); const c0 = setup(mkZip(ENTRIES), 'zip'); await E.extract(c0.file, c0.dest, { inPlace: true, registry: c0.registry }, pr(), f); const at = f.points.indexOf('cut') + 1;
    const { e } = await attempt(() => E.extract(c.file, c.dest, { inPlace: true, registry: c.registry }, pr(), fakeIo({ crashAt: at }))); E.BATCH.count = 64; if (!e) throw new Error('not stopped'); return c; };
  { const c = await stoppedInPlace(); const jp = c.file + '.kurokawa-unzip'; const arc = fs.readFileSync(c.file); const jt = fs.readFileSync(jp); let good = true;
    for (const reg of [null, path.join(c.d, 'elsewhere')]) { const { e } = await attempt(() => E.finishBeside(c.file, pr(), fakeIo(), { registry: reg })); if (e?.message !== `askBeside ${path.resolve(c.dest)}` || e.info?.dest !== path.resolve(c.dest) || !(e.info.total > e.info.done) || !fs.readFileSync(c.file).equals(arc) || !fs.readFileSync(jp).equals(jt)) { good = false; console.log('  ask', reg, e?.message); } }
    const id = S.journalRead(jt.toString()).body.id; const ref = path.join(c.registry, `${id}.ref`); const mine = fs.readFileSync(ref); fs.writeFileSync(ref, path.join(c.d, 'other.zip.kurokawa-unzip'));
    { const { e } = await attempt(() => E.finishBeside(c.file, pr(), fakeIo(), { registry: c.registry })); if (!/^askBeside /.test(e?.message || '')) { good = false; console.log('  another journal\'s pointer', e?.message); } }
    fs.writeFileSync(ref, mine); const r = await E.finishBeside(c.file, pr(), fakeIo(), { registry: c.registry }); good = good && r.files > 0 && same(tree(c.dest), expected(ENTRIES)) && !fs.existsSync(c.file);
    const c2 = await stoppedInPlace(); const r2 = await E.finishBeside(c2.file, pr(), fakeIo(), { confirmed: true }); good = good && r2.files > 0 && same(tree(c2.dest), expected(ENTRIES));
    ok('round 4: a job beside an archive is finished without asking only when this registry points at that very journal; any other — «askBeside <dest>», nothing touched — until confirmed', good); }
  { const c = await stoppedInPlace(); const other = path.join(c.d, 'src', 'b.zip'); const theirs = mkZip([{ name: 'x.txt' }]); fs.writeFileSync(other, theirs); fs.copyFileSync(c.file + '.kurokawa-unzip', other + '.kurokawa-unzip'); fs.copyFileSync(c.file + '.kurokawa-tail', other + '.kurokawa-tail');
    const { e: e1 } = await attempt(() => E.restoreBeside(other, fakeIo())); const { e: e2 } = await attempt(() => E.leftOf(other)); const { e: e3 } = await attempt(() => E.finishBeside(other, pr(), fakeIo(), { confirmed: true }));
    const left = await E.leftOf(c.file); const rr = await E.restoreBeside(c.file, fakeIo()); const gone = path.join(c.d, 'no', 'such', 'a.zip');
    ok('round 4: restore and listing from an archive\'s page reach only the in-place job of that very archive (a journal copied beside another archive refused)', e1?.message === 'journalCorrupt' && e2?.message === 'journalCorrupt' && e3?.message === 'journalCorrupt' && fs.readFileSync(other).equals(theirs) && left.entries.length > 0 && rr.identical && fs.readFileSync(c.file).equals(mkZip(ENTRIES)) && E.samePath(c.file, path.join(c.d, 'src', '..', 'src', 'a.zip')) && !E.samePath(c.file, other) && E.samePath(gone, path.join(c.d, 'no', 'such', '.', 'a.zip')) && !E.samePath(gone, c.file) && !E.samePath(c.file, gone)); }
  { const c = setup(mkZip(ENTRIES), 'zip'); const orig = fs.readFileSync(c.file); const jp = c.file + '.kurokawa-unzip'; await E.extract(c.file, c.dest, { inPlace: true, registry: c.registry }, pr(), fakeIo());
    const fresh = mkZip([{ name: 'new.txt' }, { name: 'two.txt' }]); fs.writeFileSync(c.file, fresh); const o2 = path.join(c.d, 'o2');
    const b = await E.beside(c.file, c.registry); const fb = await E.finishBeside(c.file, pr(), fakeIo(), { registry: c.registry }); const lo = await E.leftOf(c.file); const { e: er } = await attempt(() => E.restoreBeside(c.file, fakeIo()));
    const pf = await E.preflightOf(c.file, o2, {}); const { e: ei } = await attempt(() => E.extract(c.file, o2, { inPlace: true, registry: c.registry }, pr(), fakeIo())); const rn = await E.extract(c.file, o2, { registry: c.registry }, pr(), fakeIo());
    await E.finish(jp, pr(), fakeIo()); const stillNew = fs.readFileSync(c.file).equals(fresh); const u = await E.undo(jp, fakeIo());
    const c3 = setup(mkZip(ENTRIES), 'zip'); await E.extract(c3.file, c3.dest, { inPlace: true, registry: c3.registry }, pr(), fakeIo()); fs.writeFileSync(c3.file, ''); await E.finish(c3.file + '.kurokawa-unzip', pr(), fakeIo()); const kept = fs.existsSync(c3.file); const u3 = await E.restore(c3.file + '.kurokawa-unzip', fakeIo());
    ok('round 4: a finished job\'s journal beside a new archive of that name — not «0 files», listed and restored as itself, a normal extraction goes ahead (in place waits: oldJob), the old Undo makes its archive beside the new one, nothing at the path removed',
      b.kind === 'old' && fb === null && lo === null && er?.message === 'nothingToRestore' && pf.facts.oldJob && !pf.facts.busy && !pf.report.inPlace.ok && pf.report.normal.ok && ei?.message === 'journalExists' && rn.files === 2 && stillNew && u.identical && fs.readFileSync(u.restoredTo).equals(orig) && fs.readFileSync(c.file).equals(fresh) && kept && fs.existsSync(c3.file) && fs.statSync(c3.file).size === 0 && fs.readFileSync(u3.restoredTo).equals(mkZip(ENTRIES)),
      JSON.stringify({ b, fb, lo, er: er?.message, ei: ei?.message, u })); }
  { const c = await stoppedInPlace(); const jp = c.file + '.kurokawa-unzip'; const text = fs.readFileSync(jp, 'utf8'); const body = text.split('\n')[0]; let good = body.includes('"outs":{}');
    const put = (b) => fs.writeFileSync(jp, `${b}\n${S.crc32(Buffer.from(b)).toString(16).padStart(8, '0')}\n`); const outs = (v) => body.replace('"outs":{}', `"outs":${v}`);
    for (const bad of [body.replace('{', '{"state":"done",'), outs('{"x":"a.txt"}'), outs('{"01":"a.txt"}'), outs('{"0":"a.txt","0":"b.txt"}'), outs('"a"'), outs('["a"]')]) { put(bad); const { e } = await attempt(() => E.openJob(jp)); if (e?.message !== 'journalCorrupt') { good = false; console.log('  journal kept', bad.slice(0, 80), e?.message); } }
    fs.writeFileSync(jp, text); good = good && !(await attempt(() => E.openJob(jp))).e && E.dupKeys('{"a":1,"a":2}') && !E.dupKeys('{"a":{"b":1},"b":[{"c":1},{"c":2}]}') && E.dupKeys('{"a":"\\"a","b":{"c":1,"c":1}}');
    // the older log: a stopped job's placed-but-uncommitted files cleaned by Finish (no second copy)
    let seen = false; E.BATCH.count = 3;
    for (let k = 1; k < 200; k++) { const c2 = setup(mkZip(ENTRIES), 'zip'); const { e } = await attempt(() => E.extract(c2.file, c2.dest, { registry: c2.registry }, pr(), fakeIo({ crashAt: k }))); if (!e) break;
      const sh = await E.shelf(c2.registry); const j2 = sh[0]?.journal; if (!j2 || !fs.existsSync(j2 + '.log')) continue; const recs = E.parseLog(fs.readFileSync(j2 + '.log', 'utf8')); if (!recs.length) continue; seen = true;
      fs.writeFileSync(j2 + '.log', recs.map((x) => `${x.i}\t${x.out}\t${x.crc}\n`).join('')); const back = E.parseLog(fs.readFileSync(j2 + '.log', 'utf8'));
      const { e: ef } = await attempt(() => E.finish(j2, pr(), fakeIo())); if (JSON.stringify(back) !== JSON.stringify(recs) || ef || !same(tree(c2.dest), expected(ENTRIES))) { good = false; console.log('  tab log', k, ef?.message); } }
    E.BATCH.count = 64; ok('round 4: duplicate keys and odd unit numbers refuse a journal; an older build\'s tab-separated unit log still cleans a stopped job up', good && seen); }
  ok('zip64 end records when the fallback closes a big archive', E.zipEnd(3, 10, 100).length === 22 && E.zipEnd(70000, 10, 100).length === 98 && E.zipEnd(1, 10, 5e9).readBigUInt64LE(48) === 5000000000n);
  console.log(`${passes} passed, ${fails} failed (${((Date.now() - t0) / 1000).toFixed(1)} s)`); console.log(fails ? 'errors' : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
