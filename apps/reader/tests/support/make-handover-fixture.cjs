// Makes tests/data/handover-bridge/: a made-up hand-over folder exactly as the last Electron («bridge») build left it —
// written by that build's own Writer (./bridge-handover.cjs, frozen), small, with every kind of file the bridge writes: the
// page's stores, a book file and its cover, a font, the backup manifest, the Electron shell's own files (the custom icon, the window's state), the marker (written last: every file with its
// size and SHA-256) and the pointer the bridge leaves in the Rust build's data folder. Run once and the result committed;
// tests/handover-fixture.cjs reads the COMMITTED folder (it never runs the Writer), so a change to anything that reads a
// hand-over is held to what a bridge build really left. The pointer's folder is the word @FIXTURE@, put right by the test.
//   node tests/support/make-handover-fixture.cjs [out folder]
const fs = require('node:fs'); const path = require('node:path');
const H = require('./bridge-handover.cjs');
const OUT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'data', 'handover-bridge'));
const ELECTRON_NAME = 'KurokawaReader';
(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const root = path.join(OUT, 'appdata', ELECTRON_NAME); const tauri = path.join(OUT, 'tauri-data');
  fs.mkdirSync(root, { recursive: true });
  const w = new H.Writer(root, { free: 1e12, pointers: [{ dir: tauri, name: H.POINTER }], from: { version: '0.67.0', platform: 'win32', portable: false } });
  const b = await w.begin(1); if (!b.ok) throw new Error('begin: ' + JSON.stringify(b));
  const put = {};
  const text = (rel, t) => { put[rel] = Buffer.from(t); };
  text('kurokawa-backup.json', JSON.stringify({ app: 'KurokawaReader', version: 1, books: [{ id: 'b1', title: 'A Made-up Book', fileName: 'made-up.txt' }], handover: { format: 1 } }, null, 1));
  text('paths.json', JSON.stringify({ 'books/b1/made-up.txt': 'books/0/file', 'books/b1/cover': 'books/0/cover' }));
  text('books/0/file', 'A made-up book, a few words long.\n');
  put['books/0/cover'] = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  text('books/0/translations.json', JSON.stringify({ tr: { k1: 'ترجمة' }, trs: {} }));
  text('fonts/0', 'FONTDATA');
  text('files/0', 'OTHERFILE');
  text('handover/books.jsonl', JSON.stringify({ n: 0, record: { id: 'b1', title: 'A Made-up Book', format: 'txt', fileName: 'made-up.txt', size: 34, progress: { bookId: 'b1', block: 0, pct: 0.5 } } }) + '\n');
  text('handover/meta.jsonl', JSON.stringify({ key: 'folders', value: [{ id: 'fA', name: 'Shelf', createdAt: 1 }] }) + '\n');
  text('handover/files.json', JSON.stringify([{ key: 'font:myfont', rel: 'fonts/0', size: 8, type: 'font/ttf', name: 'my.ttf' }, { key: 'big:other', rel: 'files/0', size: 9, type: 'application/octet-stream' }, { key: 'book:b1', rel: 'books/0/file', size: 34, type: 'text/plain', book: 'b1' }]));
  text('handover/local.json', JSON.stringify({ 'kr.lang': 'en', 'kr.visual': '{"theme":"sepia"}' }));
  text('handover/opfs.json', '[]');
  text('shell/custom-icon.png', 'PNGMADEUP');
  text('shell/window-state.json', JSON.stringify({ width: 1180, height: 820, maximized: false }));
  for (const [rel, buf] of Object.entries(put)) await w.write(rel, buf, false);
  const v = await w.verify(Object.entries(put).map(([rel, buf]) => ({ rel, size: buf.length }))); if (!v.ok) throw new Error('verify: ' + JSON.stringify(v));
  const r = await w.finish({ counts: { books: 1, files: 3, records: 1, local: 2 } }); if (!r.ok) throw new Error('finish');
  // (The pointer names this folder by the path it was made at: the word @FIXTURE@ instead, put right by the test.)
  const pf = path.join(tauri, H.POINTER); const ptr = JSON.parse(fs.readFileSync(pf, 'utf8')); ptr.dir = '@FIXTURE@/appdata/' + ELECTRON_NAME + '/handover';
  fs.writeFileSync(pf, JSON.stringify(ptr));
  console.log('written', OUT, r.files, 'files', r.bytes, 'bytes');
})().catch((e) => { console.error(e); process.exit(1); });
