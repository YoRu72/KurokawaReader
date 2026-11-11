// node tests/backupsafe.cjs: backups (src/backup.ts) — no credential in any of them (notes, full, automatic, the
// automatic ones kept from before), everything the reader made carried and brought back field by field on a fresh
// device, the device's own keys kept on restore, and a restore's rules (notes merged; the later reading position).
// (The app's own modules bundled into a blank page; the books are small files made here.)
const { chromium } = require('playwright'); const http = require('http'); const path = require('path'); const fs = require('fs'); const os = require('os');
const esbuild = require('esbuild'); const JSZip = require('jszip');
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 900))); if (!c) fails++; };
const SRC = path.resolve(__dirname, '../src');
const entry = path.join(os.tmpdir(), 'kr-backupsafe-entry.ts');
fs.writeFileSync(entry, ['db', 'backup', 'settings', 'glossary', 'textrules'].map((m, i) => `import * as m${i} from ${JSON.stringify(path.join(SRC, m))};`).join('\n') + `\n(window as any).T = { db: m0, B: m1, settings: m2, gloss: m3, rules: m4 };\n`);
const code = esbuild.buildSync({ entryPoints: [entry], bundle: true, format: 'iife', write: false, platform: 'browser', logLevel: 'error', define: { 'import.meta.url': '"http://127.0.0.1/"' } /* (pdf.js's worker address; no PDF read here) */ }).outputFiles[0].text;
const server = http.createServer((req, res) => { if (req.url.startsWith('/t.js')) { res.setHeader('Content-Type', 'text/javascript'); res.end(code); return; } res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta charset="utf-8"><body>'); });

// Names that look like a credential and are not one (the test's own list: a new one must be added here on purpose).
const SAFE = new Set(['volumeKeys', 'key' /* a book record's file key, a custom service's emptied key (checked empty) */]);
const RX = /key|token|secret|pass|auth|cookie|refresh/i;
/** Every place in a backup that holds a credential: a value with SECRET in it anywhere, or a credential-like name with a value. */
function leaks(v, at = '$', out = []) {
  if (typeof v === 'string') { if (/SECRET/.test(v)) out.push(at); return out; }
  if (Array.isArray(v)) { v.forEach((x, i) => leaks(x, `${at}[${i}]`, out)); return out; }
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
    if (RX.test(k) && !SAFE.has(k) && x !== '' && x !== undefined && x !== null && !(at.includes('.books[') && /^(key)$/.test(k))) out.push(`${at}.${k}`);
    if (k === 'key' && at.includes('customApis') && x) out.push(`${at}.${k}`);
    leaks(x, `${at}.${k}`, out);
  }
  return out;
}
const SETTINGS = { fontSize: 23, aiProvider: 'custom', aiCustomId: 'c1', aiKey: 'SECRET-aikey', aiBaseUrl: 'https://api.example/v1', localServer: 'http://127.0.0.1:8080/v1?api_key=SECRET-local',
  aiCustomApis: [{ id: 'c1', name: 'Mine', style: 'openai', base: 'https://api.example/v1', key: 'SECRET-custom', model: 'm1', headers: 'Authorization: Bearer SECRET-header' }, { id: 'c2', name: 'Other', style: 'anthropic', base: 'https://u:SECRET-pw@other.example', key: 'SECRET-c2', model: 'm2' }],
  syncProvider: 'webdav', syncDropboxKey: 'SECRET-appkey', syncDropboxRefresh: 'SECRET-refresh', syncWebdavUrl: 'https://bob:SECRET-pw@dav.example/kr', syncWebdavUser: 'bob-SECRET', syncWebdavPass: 'SECRET-davpass', futureApiToken: 'SECRET-future' };
const LOCAL_SECRETS = { 'kr.anilist.token': 'SECRET-al', 'kr.opds': JSON.stringify([{ id: 'o', name: 'Cat', url: 'https://opds.example', user: 'me', pass: 'SECRET-opds' }]), 'kr.shamelalink.tokens': 'SECRET-sl', 'kr.ext.store.x': JSON.stringify({ cookie: 'SECRET-cookie' }), 'kr.dbx.access': JSON.stringify({ token: 'SECRET-dbx' }) };

(async () => {
  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const b = await chromium.launch(); const errors = [];
  const fresh = async (local = {}) => {
    const ctx = await b.newContext(); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`http://127.0.0.1:${port}/`); await p.evaluate((l) => { for (const [k, v] of Object.entries(l)) localStorage.setItem(k, v); }, local);
    await p.addScriptTag({ content: code }); await p.waitForFunction(() => !!window.T);
    // (What the app shares is caught here: the page's share sheet stubbed.)
    await p.evaluate(() => { navigator.canShare = () => true; navigator.share = async ({ files }) => { window.__shared = files[0]; }; });
    return p;
  };
  const shared = (p) => p.evaluate(async () => { const f = window.__shared; return f ? { name: f.name, b64: btoa(String.fromCharCode(...new Uint8Array(await f.arrayBuffer()))) } : null; });

  // ---------- device A: everything made, then backed up
  const A = await fresh({ ...LOCAL_SECRETS, 'kr.visual': JSON.stringify(SETTINGS), 'kr.lang': 'en' });
  const NOW = 1_700_000_000_000;
  const seed = await A.evaluate(async (NOW) => {
    const { db } = T.db; const id = 'bookA';
    const book = { id, title: 'Seed', format: 'txt', fileName: 'seed.txt', size: 11, addedAt: NOW - 9e6, lastOpenedAt: NOW - 100, folderId: 'fA',
      progress: { bookId: id, block: 7, offset: 0.25, pct: 0.42, toc: 3 }, progressAt: NOW - 200,
      bookmarks: [{ id: 'bm1', label: 'Here', locator: { bookId: id, block: 3, pct: 0.2 }, createdAt: NOW - 500 }],
      highlights: [{ id: 'h1', text: 'a line', color: 'rose', note: 'my note', noteAt: NOW - 400, createdAt: NOW - 450 }],
      pins: [{ id: 'p1', page: 2, x: 0.1, y: 0.2, note: 'pin', color: 'mint', createdAt: NOW - 300 }],
      pdfHighlights: [{ id: 'ph1', page: 1, rects: [[0.1, 0.1, 0.2, 0.02]], text: 'pdf', color: 'sky', createdAt: NOW - 300 }],
      ink: [{ id: 'i1', page: 1, color: '#f00', w: 0.01, pts: [0.1, 0.1, 0.2, 0.2], createdAt: NOW - 250 }],
      rating: 4, ratingAt: NOW - 240, review: 'Good book', reviewAt: NOW - 230, readToc: 2, readTocAt: NOW - 220, chapterMarks: { 5: 1, 6: 0 }, chapterMarksAt: NOW - 210, chapterStars: { 4: 1 }, chapters: 12, chaptersAt: NOW - 205,
      track: { service: 'anilist', media: { id: 77, title: 'X' }, entry: { status: 'CURRENT', progress: 3 }, updatedAt: NOW - 150 }, series: { name: 'Saga', index: 2 }, remote: { source: 'ext:site', id: '/novel/1', online: false, link: 'https://site.example/novel/1' },
      description: 'A blurb', language: 'ar', tags: ['fav', '★'], tagsAt: NOW - 140, done: false, doneAt: NOW - 130, stats: { ms: 5000, words: 300, sessionAt: NOW - 120, days: { '2023-11-14': { ms: 5000, pct: 0.4, words: 300 } } }, prefs: { fontSize: 18 } };
    await db.putBook(book); await db.putFile(id, new File(['hello world'], 'seed.txt'));
    await db.setMeta('folders', [{ id: 'fA', name: 'Shelf', createdAt: 1 }]); await db.setMeta('tags', [{ name: 'fav', createdAt: 1 }]);
    await db.setMeta(`anki:${id}`, { cards: { c: { due: 5 } }, day: 1, newToday: 0, reviewsToday: 0, newPerDay: 20, autoplay: true });
    await db.setMeta(`audio:${id}`, { track: 1, time: 33, rate: 1.2 });
    await db.setMeta(`tr:${id}`, { 'k1': 'ترجمة' }); await db.setMeta(`trs:${id}`, { 's1': 'src' }); await db.setMeta(`crop:${id}`, { any: 1 });
    T.gloss.saveTerms([{ id: 'g1', from: 'Lin Feng', to: 'لين فنغ', book: id }, { id: 'g2', from: 'Qi', to: 'تشي' }, { id: 'g3', from: 'Azure', to: 'اللازوردي', folder: 'gf1' }]);
    localStorage.setItem('kr.glossaryFolders', JSON.stringify([{ id: 'gf1', name: 'World' }])); T.gloss.setLinked(id, ['gf1']); T.gloss.setDest(id, { to: 'gf1', addNew: true });
    T.rules.saveTextRules([{ id: 'r1', find: 'Read at site', replace: '', book: id }, { id: 'r2', find: 'colour', replace: 'color' }]);
    localStorage.setItem('kr.vocab', JSON.stringify([{ w: 'word', ctx: 'a word', book: id, title: 'Seed', at: NOW - 50 }]));
    localStorage.setItem('kr.bookVisual', JSON.stringify({ [id]: { fontSize: 19, aiKey: 'SECRET-bookkey' } }));
    return book;
  }, NOW);
  // (Tests reach the db module as T.db.db.)
  const auto = await A.evaluate(async () => { const e = await T.B.makeAutoBackup(); return JSON.parse(await T.db.db.getMeta(e.key)); });
  await A.evaluate(() => T.B.backupNotes()); const notesF = await shared(A); const notes = JSON.parse(Buffer.from(notesF.b64, 'base64').toString());
  await A.evaluate(() => { window.__shared = null; return T.B.backupFull(); }); const fullF = await shared(A);
  const zip = await JSZip.loadAsync(Buffer.from(fullF.b64, 'base64'));
  const full = JSON.parse(await zip.file('kurokawa-backup.json').async('string'));
  let zipText = ''; for (const f of Object.values(zip.files)) if (!f.dir && /json$/.test(f.name)) zipText += await f.async('string');

  // ---- 1: no credential anywhere
  ok('1: the automatic backup carries no credential', leaks(auto).length === 0, leaks(auto));
  ok('1: the notes backup carries no credential', leaks(notes).length === 0, leaks(notes));
  ok('1: the full backup carries no credential (its manifest and every JSON in it)', leaks(full).length === 0 && !/SECRET/.test(zipText), leaks(full));
  ok('1: a setting named like a credential and unknown to the app (futureApiToken) is left out', !('futureApiToken' in (full.settings ?? {})), Object.keys(full.settings ?? {}).filter((k) => RX.test(k)));
  ok('1: the custom services are kept (without keys and headers), and plain settings too', (full.customApis ?? full.settings?.aiCustomApis ?? []).length === 2 && full.settings.fontSize === 23 && full.settings.aiBaseUrl === 'https://api.example/v1', [full.customApis, full.settings?.fontSize]);
  ok('1: none of the other stores of credentials (AniList, OPDS, Shamela link, extensions, Dropbox) is in it', !Object.keys(full.local ?? {}).some((k) => k in LOCAL_SECRETS), full.local);
  // Automatic backups kept from before (keys in them): rewritten without, and handed over without.
  const old = await A.evaluate(async (S) => {
    const { db } = T.db; const text = JSON.stringify({ app: 'KurokawaReader', version: 1, createdAt: 5, full: false, settings: S, local: {}, folders: [], fonts: [], books: [{ key: 'x:1', title: 'x', fileName: 'x', size: 1, format: 'txt', addedAt: 1, bookmarks: [], highlights: [], prefs: { aiKey: 'SECRET-prefs' } }] });
    await db.setMeta('autobackup:5', text); await db.setMeta('autobackup:index', [...(await db.getMeta('autobackup:index')), { key: 'autobackup:5', at: 5, size: text.length, books: 1 }]);
    const file = await T.B.autoBackupFile({ key: 'autobackup:5', at: 5, size: text.length, books: 1 });
    const handed = file ? await file.text() : '';
    const n = T.B.scrubAutoBackups ? await T.B.scrubAutoBackups() : -1;
    return { handed, n, stored: await db.getMeta('autobackup:5'), again: T.B.scrubAutoBackups ? await T.B.scrubAutoBackups() : -1 };
  }, SETTINGS);
  ok('1: an automatic backup made before the update is handed over (as a file) without its keys', !/SECRET/.test(old.handed), leaks(JSON.parse(old.handed)));
  ok('1: on the first run after the update the kept ones are rewritten without their keys (once)', old.n >= 1 && !/SECRET/.test(old.stored) && old.again === 0, { n: old.n, again: old.again, leaks: leaks(JSON.parse(old.stored)) });

  // ---- 3: everything made, on a fresh device, field by field
  const B = await fresh({ 'kr.lang': 'en', 'kr.visual': JSON.stringify({ aiKey: 'DEVICE-key', syncWebdavPass: 'DEVICE-pass', syncWebdavUrl: 'https://me:DEVICE@dav.mine/x', aiCustomApis: [{ id: 'c1', name: 'Mine here', style: 'openai', base: 'https://api.example/v1', key: 'DEVICE-c1', model: 'm1', headers: 'X-Org: mine' }] }) });
  const after = await B.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const n = await T.B.restoreBackup(new File([bytes], 'KurokawaReader-full-backup.zip', { type: 'application/zip' }));
    const { db } = T.db; const book = (await db.allBooks())[0]; const id = book?.id;
    const s = T.settings.globalSettings ? T.settings.globalSettings() : T.settings.getSettings();
    return { n, book, id, folders: await db.getMeta('folders'), anki: await db.getMeta(`anki:${id}`), audio: await db.getMeta(`audio:${id}`), tr: await db.getMeta(`tr:${id}`), trs: await db.getMeta(`trs:${id}`),
      terms: JSON.parse(localStorage.getItem('kr.glossary') ?? '[]'), gfolders: JSON.parse(localStorage.getItem('kr.glossaryFolders') ?? '[]'), links: JSON.parse(localStorage.getItem('kr.glossaryLinks') ?? '{}'), dest: JSON.parse(localStorage.getItem('kr.glossaryDest') ?? '{}'),
      rules: JSON.parse(localStorage.getItem('kr.textRules') ?? '[]'), vocab: JSON.parse(localStorage.getItem('kr.vocab') ?? '[]'), visual: JSON.parse(localStorage.getItem('kr.bookVisual') ?? '{}'),
      s: { fontSize: s.fontSize, aiKey: s.aiKey, pass: s.syncWebdavPass, url: s.syncWebdavUrl, apis: s.aiCustomApis, refresh: s.syncDropboxRefresh } };
  }, fullF.b64);
  const nb = after.book ?? {}; const id = after.id;
  ok('3: the book restored from the full backup', after.n === 1 && !!id, after.n);
  const FIELDS = ['highlights', 'pins', 'pdfHighlights', 'ink', 'rating', 'ratingAt', 'review', 'reviewAt', 'readToc', 'readTocAt', 'chapterMarks', 'chapterMarksAt', 'chapterStars', 'chapters', 'chaptersAt', 'track', 'series', 'remote', 'description', 'language', 'progressAt', 'done', 'doneAt', 'stats', 'prefs'];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const differ = FIELDS.filter((f) => !same(nb[f], seed[f]));
  ok('3: every field of the book back as it was (' + FIELDS.length + ' fields)', differ.length === 0, differ.map((f) => [f, nb[f], seed[f]]));
  ok('3: the position back, and the bookmark pointing at this device\'s book', same({ ...nb.progress, bookId: 'x' }, { ...seed.progress, bookId: 'x' }) && nb.bookmarks?.length === 1 && nb.bookmarks[0].locator.bookId === id, [nb.progress, nb.bookmarks]);
  ok('3: its tags and folder back', same([...(nb.tags ?? [])].sort(), [...seed.tags].sort()) && after.folders?.find((f) => f.id === nb.folderId)?.name === 'Shelf', [nb.tags, nb.folderId, after.folders]);
  ok('3: its Anki progress and audiobook place back', after.anki?.cards?.c?.due === 5 && after.audio?.time === 33, [after.anki, after.audio]);
  ok('3: its translations back (full backup)', after.tr?.k1 === 'ترجمة' && after.trs?.s1 === 'src', [after.tr, after.trs]);
  ok('3: the glossary back — the book\'s terms on this device\'s book, every book\'s and the folder\'s, the folder, its link and destination', after.terms.find((x) => x.id === 'g1')?.book === id && after.terms.some((x) => x.id === 'g2') && after.terms.find((x) => x.id === 'g3')?.folder === 'gf1' && after.gfolders.some((f) => f.id === 'gf1') && same(after.links[id], ['gf1']) && after.dest[id]?.to === 'gf1', [after.terms, after.links, after.dest]);
  ok('3: the text rules back (the book\'s on this device\'s book), and the kept words', after.rules.find((r) => r.id === 'r1')?.book === id && after.rules.some((r) => r.id === 'r2') && after.vocab[0]?.w === 'word', [after.rules, after.vocab]);
  ok('3: the book\'s own settings back, without the key that was in them', after.visual[id]?.fontSize === 19 && !('aiKey' in (after.visual[id] ?? {})), after.visual);
  ok('1: restoring keeps this device\'s own keys, password and address; the plain settings come back', after.s.fontSize === 23 && after.s.aiKey === 'DEVICE-key' && after.s.pass === 'DEVICE-pass' && after.s.url === 'https://me:DEVICE@dav.mine/x' && !after.s.refresh, after.s);
  ok('1: the custom services: this device\'s kept with its key and headers, the backup\'s other one added without a key', after.s.apis?.length === 2 && after.s.apis.find((a) => a.id === 'c1')?.key === 'DEVICE-c1' && after.s.apis.find((a) => a.id === 'c1')?.headers === 'X-Org: mine' && after.s.apis.find((a) => a.id === 'c2')?.key === '', after.s.apis);

  // ---- 18: the restore's rules — the later position, notes merged
  const C = await fresh({ 'kr.lang': 'en' });
  const r18 = await C.evaluate(async ([notesText, NOW]) => {
    const { db } = T.db; const m = JSON.parse(notesText); const rec = m.books[0];
    const run = async (local) => { await db.clearAll(); await db.putBook({ id: 'L', title: 'Seed', format: 'txt', fileName: rec.fileName, size: rec.size, addedAt: 1, bookmarks: [], highlights: [], ...local }); await T.B.restoreBackup(new File([notesText], 'b.json', { type: 'application/json' }), undefined, { settings: false }); return db.getBook('L'); };
    // Opened once on this device (later than the backup), still at the start: the backup's place taken.
    const a = await run({ lastOpenedAt: NOW + 1000, progress: { bookId: 'L', pct: 0 }, progressAt: NOW + 1000 });
    // Read further here, later: this device's kept.
    const b = await run({ lastOpenedAt: NOW + 1000, progress: { bookId: 'L', block: 30, pct: 0.8 }, progressAt: NOW + 1000 });
    // Read here earlier than the backup's: the backup's taken.
    const c = await run({ lastOpenedAt: NOW + 1000, progress: { bookId: 'L', block: 2, pct: 0.1 }, progressAt: NOW - 9000 });
    // A newer note here, an older different one in the backup: both.
    const d = await run({ highlights: [{ id: 'hLocal', text: 'mine', color: 'amber', note: 'newer note', createdAt: NOW + 10 }], bookmarks: [{ id: 'bLocal', label: 'mine', locator: { bookId: 'L', pct: 0.9 }, createdAt: NOW + 10 }] });
    return { a: [a.progress?.pct, a.progressAt], b: [b.progress?.pct, b.progressAt], c: [c.progress?.pct, c.progressAt], dh: d.highlights.map((x) => x.id).sort(), db: d.bookmarks.map((x) => x.id).sort() };
  }, [Buffer.from(notesF.b64, 'base64').toString(), NOW]);
  ok('18: a book opened once here (still at its start) takes the backup\'s place, with its time', r18.a[0] === 0.42 && r18.a[1] === NOW - 200, r18.a);
  ok('18: a place read further here, later, is kept', r18.b[0] === 0.8, r18.b);
  ok('18: a place here older than the backup\'s gives way to it', r18.c[0] === 0.42, r18.c);
  ok('18: a newer note here and an older different one in the backup — both there after restoring', r18.dh.join() === 'h1,hLocal' && r18.db.join() === 'bLocal,bm1', r18);

  ok('no page errors', errors.length === 0, errors);
  console.log(fails ? `${fails} failed` : 'all passed');
  await b.close(); server.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
