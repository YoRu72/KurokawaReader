// The PC's watching while it downloads (desktop/torrentstream.cjs), with aria2 stood in for: a file of a torrent served
// as its pieces come — a range of pieces not yet in waited for, then sent; seeking by ranges; the right file's bytes.
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const http = require('node:http');
const TS = require('../desktop/torrentstream.cjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kts-')); const PL = 65536, N = 32; const A = Buffer.alloc(PL * 3, 7), B = Buffer.alloc(PL * N - A.length); for (let i = 0; i < B.length; i++) B[i] = i % 251;
fs.writeFileSync(path.join(dir, 'a.nfo'), A); fs.writeFileSync(path.join(dir, 'b.mkv'), Buffer.alloc(B.length));   // (preallocated: zeros until written)
const got = new Array(N).fill(false); const bits = () => { let s = ''; for (let i = 0; i < N; i += 4) { let n = 0; for (let k = 0; k < 4; k++) if (got[i + k]) n |= 8 >> k; s += n.toString(16); } return s; };
const put = (p) => { got[p] = true; const off = p * PL - A.length; if (off >= 0) { const fd = fs.openSync(path.join(dir, 'b.mkv'), 'r+'); fs.writeSync(fd, B, off, PL, off); fs.closeSync(fd); } };
for (let p = 0; p < 3; p++) got[p] = true; for (let p = 3; p < 8; p++) put(p);
const changed = [];
const engine = { rpc: { call: async (m, gid, o) => { if (m === 'changeOption') { changed.push(o); return 'OK'; } return { status: 'active', pieceLength: String(PL), numPieces: String(N), bitfield: bits(), totalLength: String(PL * N), completedLength: '0', files: [{ index: '1', path: path.join(dir, 'a.nfo'), length: String(A.length) }, { index: '2', path: path.join(dir, 'b.mkv'), length: String(B.length) }] }; } } };
const get = (u, range) => new Promise((ok, no) => http.get(u, { headers: range ? { range } : {} }, (r) => { const parts = []; r.on('data', (d) => parts.push(d)); r.on('end', () => ok({ status: r.statusCode, h: r.headers, body: Buffer.concat(parts) })); }).on('error', no));
(async () => {
  const errors = []; const check = (w, ok) => { console.log(ok ? 'ok  ' : 'FAIL', w); if (!ok) errors.push(w); };
  const u = await TS.url(engine, 'g1', 1);
  check('asked to fetch in order', changed.some((o) => o['stream-piece-selector'] === 'inorder'));
  let r = await get(u, 'bytes=0-1023'); check('the start, at once', r.status === 206 && r.body.equals(B.subarray(0, 1024)) && r.h['content-range'] === `bytes 0-1023/${B.length}` && r.h['content-type'] === 'video/webm');
  // A seek past what is in: answered once those pieces come.
  const from = PL * 20 - A.length + 100; const t0 = Date.now(); const pending = get(u, `bytes=${from}-${from + 999}`);
  setTimeout(() => { put(20); }, 900);
  r = await pending; check('a part not in yet: waited for, then sent', Date.now() - t0 >= 800 && r.body.equals(B.subarray(from, from + 1000)));
  const u0 = await TS.url(engine, 'g1', 0); r = await get(u0, 'bytes=0-9'); check('another file of it by its index', r.body.equals(A.subarray(0, 10)));
  r = await get(u, `bytes=${B.length + 5}-`); check('out of range: 416', r.status === 416);
  TS.stop(); if (errors.length) process.exit(1); console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
