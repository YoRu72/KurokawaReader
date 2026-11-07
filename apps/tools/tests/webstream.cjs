// node tests/webstream.cjs (with the desktop's dependencies installed: cd desktop && npm install): watching a
// torrent on a computer through WebTorrent (desktop/webstream.cjs). A local seeder uploads at 3 MB/s; the player's
// read at 80 % of a 64 MB file comes in a few seconds — far sooner than the ~17 s fetching in order would take —
// with the right bytes; the torrent let go keeps its files; aria2, given them with --check-integrity, counts what
// WebTorrent fetched as there (so nothing is fetched twice).
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const crypto = require('node:crypto');
let fails = 0; const ok = (n, c, extra) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (extra ? `  (${extra})` : '')); if (!c) fails++; };
setTimeout(() => { console.log('FAIL timed out (3 min)'); process.exit(1); }, 180000).unref();
(async () => {
  const W = require('../desktop/webstream.cjs');
  if (!(await W.available())) { console.log(process.env.CI ? 'FAIL WebTorrent did not load' : 'skipped: WebTorrent not installed (cd desktop && npm install)'); process.exit(process.env.CI ? 1 : 0); }
  const WebTorrent = (await import(require('node:url').pathToFileURL(require.resolve('webtorrent', { paths: [path.join(__dirname, '..', 'desktop')] })).href)).default;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-ws-')); const src = path.join(root, 'seed', 'Show'); fs.mkdirSync(src, { recursive: true });
  const SIZE = 64 << 20; const data = crypto.randomBytes(SIZE); fs.writeFileSync(path.join(src, 'Show - 01.mkv'), data); fs.writeFileSync(path.join(src, 'notes.txt'), 'hello');
  const quiet = { dht: false, tracker: false, lsd: false, utPex: false, natUpnp: false, natPmp: false };
  const seeder = new WebTorrent({ ...quiet, uploadLimit: 3 << 20 });
  const seeded = await new Promise((res) => seeder.seed(src, { announce: [], pieceLength: 256 * 1024 }, res));
  await new Promise((r) => (seeder.torrentPort ? r() : seeder.once('listening', r)));
  const peer = `127.0.0.1:${seeder.torrentPort}`; const torrentFile = Buffer.from(seeded.torrentFile);
  const idx = seeded.files.findIndex((f) => f.name.endsWith('.mkv'));
  const dir = path.join(root, 'dl');
  const t0 = Date.now();
  const url = await W.url({ key: seeded.infoHash, source: torrentFile, dir, fileIndex: idx, gid: 'g1', peers: [peer], clientOpts: quiet });
  ok('a local address for the player', /^http:\/\/127\.0\.0\.1:\d+\/w\//.test(url), url);
  // A read at 80 %: a seek, before anything near there is in.
  const at = Math.floor(SIZE * 0.8); const want = 1 << 20;
  const r = await fetch(url, { headers: { range: `bytes=${at}-${at + want - 1}` } });
  const got = Buffer.from(await r.arrayBuffer()); const secs = (Date.now() - t0) / 1000;
  ok('the range answered (206) with the right bytes', r.status === 206 && got.equals(data.subarray(at, at + want)));
  ok('…in a few seconds — the place asked for came first', secs < 9, `${secs.toFixed(1)} s; in order would be ~${(at / (3 << 20)).toFixed(0)} s`);
  // A HEAD and the file's start.
  const h = await fetch(url, { method: 'HEAD' }); ok('its length and type', h.headers.get('content-length') === String(SIZE) && /webm/.test(h.headers.get('content-type') || ''));
  const s0 = Buffer.from(await (await fetch(url, { headers: { range: 'bytes=0-65535' } })).arrayBuffer()); ok('the start too', s0.equals(data.subarray(0, 65536)));
  const st = W.stats(seeded.infoHash); ok('its speed and peers for the player', !!st && st.peers >= 1, JSON.stringify(st));
  // Let go: its files stay.
  ok('let go', (await W.release(seeded.infoHash)) === 'g1' && !W.watching(seeded.infoHash));
  const out = path.join(dir, 'Show', 'Show - 01.mkv');
  ok('its file kept, where aria2 keeps it (folder/name/file)', fs.existsSync(out));
  // aria2, as the app hands it back: the same folder, checked — what WebTorrent fetched counted at once.
  const exe = path.join(__dirname, '..', 'desktop', 'aria2', `${process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'}-${process.arch}`, process.platform === 'win32' ? 'aria2c.exe' : 'aria2c');
  if (fs.existsSync(exe)) {
    const { spawn } = require('node:child_process'); const rpcPort = 16800 + Math.floor(Math.random() * 1000);
    const a2 = spawn(exe, ['--enable-rpc', `--rpc-listen-port=${rpcPort}`, '--rpc-listen-all=false', '--enable-dht=false', '--bt-enable-lpd=false', '--quiet=true', '--file-allocation=none'], { stdio: 'ignore' });
    const rpc = async (method, params) => { const r = await fetch(`http://127.0.0.1:${rpcPort}/jsonrpc`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: '1', method, params }), signal: AbortSignal.timeout(5000) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; };
    let up = false; for (let i = 0; i < 40 && !up; i++) { await new Promise((r2) => setTimeout(r2, 250)); up = await rpc('aria2.getVersion', []).then(() => true, () => false); }
    if (up) {
      const gid = await rpc('aria2.addTorrent', [torrentFile.toString('base64'), [], { dir, 'check-integrity': 'true', 'select-file': String(idx + 1), 'seed-time': '0' }]);
      let done = 0; for (let i = 0; i < 60; i++) { await new Promise((r2) => setTimeout(r2, 250)); const s2 = await rpc('aria2.tellStatus', [gid, ['completedLength', 'verifiedLength', 'verifyIntegrityPending']]).catch(() => null); if (!s2) continue; done = Number(s2.completedLength); if (done > 0 && !s2.verifiedLength && !s2.verifyIntegrityPending) break; }
      ok("aria2 checked the folder: WebTorrent's pieces counted as there", done >= want, `${(done / 1048576).toFixed(1)} MB`);
    } else ok('aria2 answered', false);
    a2.kill();
  } else console.log('skipped the aria2 part: no aria2c here (node fetch-aria2.mjs)');
  await W.stopAll(); await Promise.race([new Promise((r2) => seeder.destroy(r2)), new Promise((r2) => setTimeout(r2, 3000))]);
  fs.rmSync(root, { recursive: true, force: true });
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
