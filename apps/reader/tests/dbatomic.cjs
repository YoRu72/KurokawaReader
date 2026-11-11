// node tests/dbatomic.cjs: the library's storage under changes made at once and books taken away — a book changed
// twice at once keeps both changes (src/db.ts updateBook, updateMeta); a deleted book leaves none of its data behind
// and takes no other book's (src/library.ts removeBooks, cleanOrphans); a web novel's file written twice at once keeps
// both (src/sources/ext/source.ts saveNovelFile); moving books out never overwrites a file and never lets go of the
// copy inside the app before the one outside is whole (src/storage.ts moveBooksOut).
// (The app's own modules bundled into a blank page: no book files needed.)
const { chromium } = require('playwright'); const http = require('http'); const path = require('path'); const fs = require('fs'); const os = require('os');
const esbuild = require('esbuild');
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const SRC = path.resolve(__dirname, '../src');
const entry = path.join(os.tmpdir(), 'kr-dbatomic-entry.ts');
fs.writeFileSync(entry, ['db', 'library', 'storage', 'glossary', 'textrules', 'settings', 'sources/ext/source', 'sync'].map((m, i) => `import * as m${i} from ${JSON.stringify(path.join(SRC, m))};`).join('\n') + `\n(window as any).T = { db: m0, lib: m1, storage: m2, gloss: m3, rules: m4, settings: m5, source: m6, sync: m7 };\n`);
const code = esbuild.buildSync({ entryPoints: [entry], bundle: true, format: 'iife', write: false, platform: 'browser', logLevel: 'error' }).outputFiles[0].text;
const server = http.createServer((req, res) => { if (req.url.startsWith('/t.js')) { res.setHeader('Content-Type', 'text/javascript'); res.end(code); return; } res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta charset="utf-8"><body><script src="/t.js"></script>'); });
(async () => {
  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const b = await chromium.launch(); const p = await (await b.newContext()).newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`http://127.0.0.1:${port}/`); await p.waitForFunction(() => !!window.T);
  const book = (id, extra = {}) => ({ id, title: id, format: 'txt', fileName: `${id}.txt`, size: 5, addedAt: 1, bookmarks: [], highlights: [], ...extra });

  // ---- 5: updateBook / updateMeta in one transaction
  const r5 = await p.evaluate(async (bk) => {
    const { db } = T.db; await db.putBook(bk);
    await Promise.all(Array.from({ length: 8 }, (_, i) => db.updateBook(bk.id, (b) => { b['f' + i] = i; })));
    const a = await db.getBook(bk.id);
    // (A position saved while a bookmark is added.)
    await Promise.all([db.updateBook(bk.id, (b) => { b.progress = { bookId: b.id, pct: 0.5 }; b.progressAt = 5; }), db.updateBook(bk.id, (b) => { b.bookmarks.push({ id: 'bm', label: 'x', locator: { bookId: b.id, pct: 0.2 }, createdAt: 1 }); })]);
    const c = await db.getBook(bk.id); const cached = (await db.allBooks()).find((x) => x.id === bk.id);
    let meta = null;
    if (db.updateMeta) { await Promise.all(Array.from({ length: 6 }, (_, i) => db.updateMeta('list', (cur) => [...(cur ?? []), i]))); meta = await db.getMeta('list'); }
    return { fields: Array.from({ length: 8 }, (_, i) => a['f' + i]), pct: c.progress?.pct, marks: c.bookmarks.length, cachedMarks: cached.bookmarks.length, cachedPct: cached.progress?.pct, meta };
  }, book('u1'));
  ok('5: eight changes made at once to one book — all eight kept', r5.fields.every((v, i) => v === i), r5.fields);
  ok('5: a position saved while a bookmark is added — both kept (and in the cached list)', r5.pct === 0.5 && r5.marks === 1 && r5.cachedMarks === 1 && r5.cachedPct === 0.5, r5);
  ok('5: six additions at once to a meta list — all six kept', Array.isArray(r5.meta) && r5.meta.length === 6, r5.meta);

  const r5b = await p.evaluate(async () => {
    // (Ink strokes erased together: each marked deleted for sync at once.)
    await Promise.all(['s1', 's2', 's3', 's4', 's5'].map((id) => T.sync.markDeleted(id)));
    return Object.keys((await T.db.db.getMeta('sync.deleted')) ?? {}).filter((k) => /^s\d$/.test(k)).sort();
  });
  ok('5: five deletions marked for sync at once — all five kept', r5b.join() === 's1,s2,s3,s4,s5', r5b);

  // ---- 10: deleting a book takes all its data, and no other book's
  const r10 = await p.evaluate(async ([A, B]) => {
    const { db } = T.db; await db.putBook(A); await db.putBook(B); await db.putFile(A.id, new Blob(['a'])); await db.putFile(B.id, new Blob(['b']));
    const kinds = ['tr', 'trs', 'trWhole', 'trKeep', 'glossScan', 'crop', 'anki', 'audio', 'audioch'];
    for (const id of [A.id, B.id]) for (const k of kinds) await db.setMeta(`${k}:${id}`, { x: 1 });
    await db.putText(A.id, { key: 'k', units: [] });
    const G = T.gloss; G.saveTerms([{ id: 't1', from: 'Lin', to: 'لين', book: A.id }, { id: 't2', from: 'Lan', to: 'لان', book: B.id }, { id: 't3', from: 'Qi', to: 'تشي' }, { id: 't4', from: 'Sect', to: 'طائفة', folder: 'fo' }]);
    G.setLinked(A.id, ['fo']); G.setLinked(B.id, ['fo']); G.setDest(A.id, { to: 'book', addNew: false }); G.setDest(B.id, { to: 'book', addNew: false }); G.setDest('*', { to: 'all', addNew: true });
    T.rules.saveTextRules([{ id: 'r1', find: 'x', replace: '', book: A.id }, { id: 'r2', find: 'y', replace: '', book: B.id }, { id: 'r3', find: 'z', replace: '' }]);
    localStorage.setItem('kr.bookVisual', JSON.stringify({ [A.id]: { fontSize: 20 }, [B.id]: { fontSize: 22 } }));
    localStorage.setItem('kr.queue', JSON.stringify([A.id, B.id]));
    await T.lib.removeBooks([A.id]);
    const left = async (id) => { const out = []; for (const k of kinds) if (await db.getMeta(`${k}:${id}`)) out.push(k); return out; };
    const terms = JSON.parse(localStorage.getItem('kr.glossary') ?? '[]').map((x) => x.id);
    return { aLeft: await left(A.id), bLeft: await left(B.id), aBook: !!(await db.getBook(A.id)), aFile: !!(await db.getFile(A.id)), bFile: !!(await db.getFile(B.id)), aText: !!(await db.getText(A.id)), terms,
      links: JSON.parse(localStorage.getItem('kr.glossaryLinks') ?? '{}'), dest: Object.keys(JSON.parse(localStorage.getItem('kr.glossaryDest') ?? '{}')), rules: JSON.parse(localStorage.getItem('kr.textRules') ?? '[]').map((x) => x.id), visual: Object.keys(JSON.parse(localStorage.getItem('kr.bookVisual') ?? '{}')), queue: JSON.parse(localStorage.getItem('kr.queue') ?? '[]') };
  }, [book('b12'), book('b123')]);
  ok('10: the deleted book\'s record, file and text gone', !r10.aBook && !r10.aFile && !r10.aText && r10.bFile, r10);
  ok('10: its translations, crop, Anki, audio and glossary-scan data gone', r10.aLeft.length === 0, r10.aLeft);
  ok('10: the book whose id begins the same ("b123") keeps all of its', r10.bLeft.length === 9, r10.bLeft);
  ok('10: its own glossary terms gone; every book\'s, a folder\'s and the other book\'s kept', r10.terms.join() === 't2,t3,t4', r10.terms);
  ok('10: its glossary links and destination gone, the others and the default kept', !('b12' in r10.links) && 'b123' in r10.links && r10.dest.sort().join() === '*,b123', [r10.links, r10.dest]);
  ok('10: its text rules, own settings and place in the queue gone; the others kept', r10.rules.join() === 'r2,r3' && r10.visual.join() === 'b123' && r10.queue.join() === 'b123', r10);
  const r10b = await p.evaluate(async () => {
    const { db } = T.db; if (!T.lib.cleanOrphans) return null;
    for (const k of ['tr', 'crop', 'anki', 'audio']) await db.setMeta(`${k}:ghost`, 1);
    await db.setMeta('tr:b123', { x: 1 }); await db.setMeta('autobackup:index', []); await db.setMeta('folders', []);
    localStorage.setItem('kr.bookVisual', JSON.stringify({ ghost: { fontSize: 9 }, b123: { fontSize: 22 } }));
    const n = await T.lib.cleanOrphans();
    return { n, ghost: !!(await db.getMeta('tr:ghost')) || !!(await db.getMeta('crop:ghost')), kept: !!(await db.getMeta('tr:b123')) && !!(await db.getMeta('folders')) && !!(await db.getMeta('autobackup:index')), visual: Object.keys(JSON.parse(localStorage.getItem('kr.bookVisual'))) };
  });
  ok('10: the one-time clean-up takes what earlier deletions left, and nothing of a book still here or of the app', !!r10b && r10b.n >= 5 && !r10b.ghost && r10b.kept && r10b.visual.join() === 'b123', r10b);

  // ---- 9: a web novel's file written twice at once
  const r9 = await p.evaluate(async (bk) => {
    const { db } = T.db; const S = T.source;
    const nv = { src: 'ext:x', path: '/n', title: 'N', chapters: [{ path: 'c1', name: '1' }, { path: 'c2', name: '2' }, { path: 'c3', name: '3' }], content: { c3: { html: 'three', at: 1 } }, genres: [] };
    await db.putBook(bk); await db.putFile(bk.id, new File([JSON.stringify(nv)], 'n.webnovel.json'));
    await Promise.all([S.saveNovelFile(bk, (cur) => ({ ...cur, content: { ...cur.content, c1: { html: 'one', at: 2 } } })), S.saveNovelFile(bk, (cur) => ({ ...cur, content: { ...cur.content, c2: { html: 'two', at: 2 } } }))]);
    const a = Object.keys((await S.readNovelFile(bk.id)).content).sort();
    // (Chapters let go while others arrive.)
    await Promise.all([S.forgetChapters(bk, new Set(['c3'])), S.saveNovelFile(bk, (cur) => ({ ...cur, chapters: [...cur.chapters, { path: 'c4', name: '4' }], content: { ...cur.content, c4: { html: 'four', at: 3 } } }))]);
    const nv2 = await S.readNovelFile(bk.id);
    return { a, b: Object.keys(nv2.content).sort(), chapters: nv2.chapters.length };
  }, book('nv1', { format: 'webnovel', fileName: 'n.webnovel.json', remote: { source: 'ext:x', id: '/n' } }));
  ok('9: two chapters saved at once into a novel\'s file — both kept', r9.a.join() === 'c1,c2,c3', r9.a);
  ok('9: chapters let go while a new one is saved — the new one kept, the others gone', r9.b.join() === 'c1,c2,c4' && r9.chapters === 4, r9);

  // ---- 8: moving books out (desktop: a folder of files mocked in memory)
  const r8 = await p.evaluate(async () => {
    const { db } = T.db; const fsm = new Map(); let failOn = ''; let shortOn = '';
    const dec = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    window.kurokawaDesktop = {
      pickFolder: async () => '/out',
      writeBinary: async (p, b64, append) => { if (failOn && p.includes(failOn)) throw new Error('disk full'); let bytes = dec(b64); if (shortOn && p.includes(shortOn)) bytes = bytes.slice(0, 1); const was = append ? fsm.get(p) ?? new Uint8Array() : new Uint8Array(); const n = new Uint8Array(was.length + bytes.length); n.set(was); n.set(bytes, was.length); fsm.set(p, n); return true; },
      readFile: async (p) => { const v = fsm.get(p); if (!v) throw new Error('ENOENT'); return v.buffer.slice(0); },
      fileSize: async (p) => (fsm.has(p) ? fsm.get(p).length : -1),
    };
    fsm.set('/out/same.txt', new TextEncoder().encode('the reader\'s own file'));
    const mk = async (id, name, text) => { const bk = { id, title: id, format: 'txt', fileName: name, size: text.length, addedAt: 1, bookmarks: [], highlights: [] }; await db.putBook(bk); await db.putFile(id, new Blob([text])); return bk; };
    const books = [await mk('m1', 'same.txt', 'first book'), await mk('m2', 'same.txt', 'second book'), await mk('m3', 'fail.txt', 'third book'), await mk('m4', 'short.txt', 'fourth book')];
    failOn = 'fail'; shortOn = 'short';
    const n = await T.storage.moveBooksOut(books, () => undefined);
    const out = {}; for (const [k, v] of fsm) out[k] = new TextDecoder().decode(v);
    const st = {}; for (const id of ['m1', 'm2', 'm3', 'm4']) { const b = await db.getBook(id); st[id] = { path: b.source?.path ?? null, inside: !!(await (async () => { const f = await db.getFile(id); return f && !b.source ? f : f; })()) }; }
    // (Whether each book's file is still kept inside the app: read straight from the store, not through its link.)
    const inside = await new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('files').objectStore('files').getAllKeys(); q.onsuccess = () => res(q.result); }; });
    return { n, out, st, inside };
  });
  ok('8: a file already in the folder with the same name is left as it was', r8.out['/out/same.txt'] === 'the reader\'s own file', r8.out);
  const p1 = r8.st.m1.path, p2 = r8.st.m2.path;
  ok('8: two books of the same name moved to two files, each its own', !!p1 && !!p2 && p1 !== p2 && r8.out[p1] === 'first book' && r8.out[p2] === 'second book', r8);
  ok('8: a book whose writing failed, or came out short, keeps its copy inside and no link', !r8.st.m3.path && !r8.st.m4.path && r8.inside.includes('m3') && r8.inside.includes('m4'), r8);
  ok('8: the moved books\' copies inside let go; the count says two', !r8.inside.includes('m1') && !r8.inside.includes('m2') && r8.n === 2, r8);

  ok('no page errors', errors.length === 0, errors);
  console.log(fails ? `${fails} failed` : 'all passed');
  await b.close(); server.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
