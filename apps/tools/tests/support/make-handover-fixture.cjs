// Makes tests/data/handover-bridge/: a made-up hand-over folder exactly as the last Electron («bridge») build left it —
// written by that build's own Writer (./bridge-handover.cjs, frozen), small, with every kind of file the bridge writes: the
// page's stores, a book file and its cover, a font, the backup manifest, the Electron shell's own files, and the download engine's (aria2's session, notes on each download, settings, DHT, the ids that were moving), the marker (written last: every file with its
// size and SHA-256) and the pointer the bridge leaves in the Rust build's data folder. Run once and the result committed;
// tests/handover-fixture.cjs reads the COMMITTED folder (it never runs the Writer), so a change to anything that reads a
// hand-over is held to what a bridge build really left. The pointer's folder is the word @FIXTURE@, put right by the test.
//   node tests/support/make-handover-fixture.cjs [out folder]
const fs = require('node:fs'); const path = require('node:path');
const H = require('./bridge-handover.cjs');
const OUT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'data', 'handover-bridge'));
const ELECTRON_NAME = 'Kurokawa Tools';
(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const root = path.join(OUT, 'appdata', ELECTRON_NAME); const tauri = path.join(OUT, 'tauri-data');
  fs.mkdirSync(root, { recursive: true });
  const w = new H.Writer(root, { free: 1e12, pointers: [{ dir: tauri, name: H.POINTER }], from: { version: '0.23.0', platform: 'win32', portable: false } });
  const b = await w.begin(1); if (!b.ok) throw new Error('begin: ' + JSON.stringify(b));
  const put = {};
  const text = (rel, t) => { put[rel] = Buffer.from(t); };
  text('handover/meta.jsonl', JSON.stringify({ key: 'addons', value: [{ id: 'made-up-addon', version: '1.0.0' }] }) + '\n');
  text('handover/files.json', JSON.stringify([{ key: 'addon:made-up-addon', rel: 'files/0', size: 9, type: 'application/octet-stream' }]));
  text('handover/local.json', JSON.stringify({ 'kt.lang': 'en', 'kt.theme': 'dark' }));
  text('files/0', 'ADDONFILE');
  text('shell/custom-icon.png', 'PNGMADEUP');
  text('shell/window-state.json', JSON.stringify({ width: 1180, height: 820, maximized: false }));
  text('engine/aria2.session', 'http://127.0.0.1/made-up.bin\n gid=0123456789abcdef\n');
  text('engine/tasks.json', JSON.stringify({ '0123456789abcdef': { name: 'made-up.bin', dir: 'C:\\Downloads' } }));
  text('engine/aria2-config.json', JSON.stringify({ 'max-connection-per-server': 4 }));
  text('engine/dht.dat', 'DHTMADEUP');
  text('engine/video-jobs.json', '[]');
  text('engine/moving.json', JSON.stringify(['0123456789abcdef']));
  for (const [rel, buf] of Object.entries(put)) await w.write(rel, buf, false);
  const v = await w.verify(Object.entries(put).map(([rel, buf]) => ({ rel, size: buf.length }))); if (!v.ok) throw new Error('verify: ' + JSON.stringify(v));
  const r = await w.finish({ counts: { local: 2, records: 1, files: 1, history: 0, addons: 1 } }); if (!r.ok) throw new Error('finish');
  // (The pointer names this folder by the path it was made at: the word @FIXTURE@ instead, put right by the test.)
  const pf = path.join(tauri, H.POINTER); const ptr = JSON.parse(fs.readFileSync(pf, 'utf8')); ptr.dir = '@FIXTURE@/appdata/' + ELECTRON_NAME + '/handover';
  fs.writeFileSync(pf, JSON.stringify(ptr));
  console.log('written', OUT, r.files, 'files', r.bytes, 'bytes');
})().catch((e) => { console.error(e); process.exit(1); });
