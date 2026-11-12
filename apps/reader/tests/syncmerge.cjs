// node tests/syncmerge.cjs: sync between devices (src/sync.ts) — two devices, each its own browser storage, syncing
// through a sync file kept in memory here (the desktop "folder" transport, its file calls stubbed), in both orders
// and again and again (a merge done twice changes nothing more):
//  1. a book moved out of a folder, or a folder deleted, on one device stays so on both (no folder brought back);
//     sync's changes to the folder, tag and deletion lists made in one transaction with the app's own;
//  2. reading time on both devices on the same day: both counted, once;
//  3. a web novel whose file grew on one device (chapters arrived) still matches across devices, an old sync file's
//     and a backup's entries still match, no stale entries pile up; two copies of one file keep their own notes;
//  4. a device whose clock runs ahead does not override a position read later on another.
// (The app's own modules bundled into a blank page; the books are records made here.)
const { chromium } = require('playwright'); const http = require('http'); const path = require('path'); const fs = require('fs'); const os = require('os');
const esbuild = require('esbuild');
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 900))); if (!c) fails++; };
const SRC = path.resolve(__dirname, '../src');
const entry = path.join(os.tmpdir(), 'kr-syncmerge-entry.ts');
fs.writeFileSync(entry, ['db', 'sync', 'stats', 'library', 'backup', 'settings'].map((m, i) => `import * as m${i} from ${JSON.stringify(path.join(SRC, m))};`).join('\n') + `\n(window as any).T = { db: m0, sync: m1, stats: m2, lib: m3, B: m4, settings: m5 };\n`);
const code = esbuild.buildSync({ entryPoints: [entry], bundle: true, format: 'iife', write: false, platform: 'browser', logLevel: 'error', define: { 'import.meta.url': '"http://127.0.0.1/"' } }).outputFiles[0].text;
const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta charset="utf-8"><body>'); });

(async () => {
  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const b = await chromium.launch(); const errors = [];
  /** The sync file, as the cloud folder would keep it. */
  let remote = null;
  const device = async (name, skewMs = 0) => {
    const ctx = await b.newContext(); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    await p.exposeFunction('__remoteRead', () => remote);
    await p.exposeFunction('__remoteWrite', (t) => { remote = t; return true; });
    if (skewMs) await p.addInitScript((s) => { const real = Date.now; Date.now = () => real() + s; }, skewMs);
    await p.goto(`http://127.0.0.1:${port}/`);
    await p.evaluate((n) => {
      localStorage.setItem('kr.device', n); localStorage.setItem('kr.lang', 'en');
      localStorage.setItem('kr.visual', JSON.stringify({ syncProvider: 'folder', syncFolder: '/cloud', syncAuto: false }));
      window.kurokawaDesktop = { readTextFile: () => window.__remoteRead(), writeTextFile: (_p, t) => window.__remoteWrite(t) };
    }, name);
    await p.addScriptTag({ content: code }); await p.waitForFunction(() => !!window.T);
    return p;
  };
  const sync = async (p) => { const r = await p.evaluate(() => T.sync.syncNow()); if (!r.ok) errors.push(`sync: ${r.error}`); return r; };
  /** Both orders, several times. */
  const rounds = async (A, B, n = 3) => { for (let i = 0; i < n; i++) { await sync(A); await sync(B); await sync(B); await sync(A); } };
  const book = (id, extra = {}) => ({ id, title: id, format: 'txt', fileName: `${id}.txt`, size: 50, addedAt: 1, bookmarks: [], highlights: [], ...extra });
  const put = (p, bk) => p.evaluate((x) => T.db.db.putBook(x), bk);
  const get = (p, id) => p.evaluate((i) => T.db.db.getBook(i), id);
  const folderNameOf = (p, id) => p.evaluate(async (i) => { const bk = await T.db.db.getBook(i); const fs = (await T.db.db.getMeta('folders')) ?? []; return fs.find((f) => f.id === bk?.folderId)?.name ?? null; }, id);
  const folderNames = (p) => p.evaluate(async () => ((await T.db.db.getMeta('folders')) ?? []).map((f) => f.name).sort());

  // ---------- 1: folders
  {
    remote = null;
    const A = await device('devA'), B = await device('devB');
    for (const p of [A, B]) { await put(p, book('x1')); await put(p, book('x2')); await put(p, book('x3')); }
    // A: a folder "Shelf" with x1 in it, a folder "Old" with x2 in it.
    await A.evaluate(async () => {
      const { db } = T.db; await db.setMeta('folders', [{ id: 'fS', name: 'Shelf', createdAt: Date.now() - 5000 }, { id: 'fO', name: 'Old', createdAt: Date.now() - 5000 }]);
      if (T.lib.moveToFolder) { await T.lib.moveToFolder(['x1'], 'fS'); await T.lib.moveToFolder(['x2'], 'fO'); }
      else { await db.updateBook('x1', (b) => { b.folderId = 'fS'; }); await db.updateBook('x2', (b) => { b.folderId = 'fO'; }); }
    });
    await rounds(A, B, 1);
    ok('1: a folder and the books in it reach the other device', (await folderNameOf(B, 'x1')) === 'Shelf' && (await folderNameOf(B, 'x2')) === 'Old', [await folderNameOf(B, 'x1'), await folderNameOf(B, 'x2')]);
    await new Promise((r) => setTimeout(r, 20));
    // B takes x1 out of its folder; A deletes the folder "Old" (x2 in it).
    await B.evaluate(async () => { if (T.lib.moveToFolder) await T.lib.moveToFolder(['x1'], null); else await T.db.db.updateBook('x1', (b) => { delete b.folderId; }); });
    await A.evaluate(async () => {
      if (T.lib.deleteFolder) { await T.lib.deleteFolder('fO'); return; }
      const { db } = T.db; await db.setMeta('folders', ((await db.getMeta('folders')) ?? []).filter((f) => f.id !== 'fO')); await db.updateBook('x2', (b) => { delete b.folderId; });
    });
    await rounds(A, B);
    ok('1: a book taken out of its folder on one device stays out on both, sync after sync', (await folderNameOf(A, 'x1')) === null && (await folderNameOf(B, 'x1')) === null, [await folderNameOf(A, 'x1'), await folderNameOf(B, 'x1')]);
    ok('1: a folder deleted on one device is gone on both, and its book in none', !(await folderNames(A)).includes('Old') && !(await folderNames(B)).includes('Old') && (await folderNameOf(A, 'x2')) === null && (await folderNameOf(B, 'x2')) === null, [await folderNames(A), await folderNames(B), await folderNameOf(A, 'x2'), await folderNameOf(B, 'x2')]);
    // Later, A puts x1 back into Shelf, and x3 into a new folder named "Old" again: both reach B.
    await new Promise((r) => setTimeout(r, 20));
    await A.evaluate(async () => {
      const { db } = T.db; const fs = (await db.getMeta('folders')) ?? []; await db.setMeta('folders', [...fs, { id: 'fO2', name: 'Old', createdAt: Date.now() }]);
      if (T.lib.moveToFolder) { await T.lib.moveToFolder(['x1'], 'fS'); await T.lib.moveToFolder(['x3'], 'fO2'); } else { await db.updateBook('x1', (b) => { b.folderId = 'fS'; }); await db.updateBook('x3', (b) => { b.folderId = 'fO2'; }); }
    });
    await rounds(A, B);
    ok('1: a later move back into a folder, and a new folder of a deleted one\'s name, reach the other device', (await folderNameOf(B, 'x1')) === 'Shelf' && (await folderNameOf(B, 'x3')) === 'Old' && (await folderNameOf(A, 'x1')) === 'Shelf', [await folderNameOf(B, 'x1'), await folderNameOf(B, 'x3')]);
    // Sync's own writes of the folder, tag and deletion lists, while the app changes them: nothing of the app's lost.
    const race = await B.evaluate(async () => {
      const { db } = T.db; const marks = [];
      const run = T.sync.syncNow();
      for (let i = 0; i < 30; i++) { marks.push(T.sync.markDeleted(`race${i}`)); marks.push(db.updateMeta ? db.updateMeta('tags', (cur) => [...(cur ?? []), { name: `t${i}`, createdAt: Date.now() }]) : db.getMeta('tags').then((cur) => db.setMeta('tags', [...(cur ?? []), { name: `t${i}`, createdAt: Date.now() }]))); await new Promise((r) => setTimeout(r, 0)); }
      await Promise.all(marks); await run;
      const del = (await db.getMeta('sync.deleted')) ?? {}; const tags = (await db.getMeta('tags')) ?? [];
      return { del: Array.from({ length: 30 }, (_, i) => `race${i}`).filter((k) => !(k in del)), tags: Array.from({ length: 30 }, (_, i) => `t${i}`).filter((n) => !tags.some((x) => x.name === n)) };
    });
    ok('1: deletions marked and tags made while a sync runs — all kept', race.del.length === 0 && race.tags.length === 0, race);
    await A.context().close(); await B.context().close();
  }

  // ---------- 2: reading statistics
  {
    remote = null;
    const A = await device('devA'), B = await device('devB');
    for (const p of [A, B]) await put(p, book('s1'));
    await rounds(A, B, 1);
    /** Reading for `min` minutes through the app's own tracker (its clock ticks moved on by hand). */
    const read = (p, min) => p.evaluate(async (min) => {
      const bk = await T.db.db.getBook('s1'); const tr = new T.stats.ReadingTracker(bk, () => true); tr.start();
      for (let i = 0; i < min * 2; i++) { tr.lastTick = performance.now() - 30000; tr.tick(); }
      await tr.stop();
    }, min);
    const ms = (p) => p.evaluate(async () => { const s = (await T.db.db.getBook('s1')).stats; return { ms: Math.round((s?.ms ?? 0) / 60000), day: Math.round((s?.days?.[T.stats.todayKey()]?.ms ?? 0) / 60000) }; });
    await read(A, 20); await read(B, 10);
    await rounds(A, B);
    const a = await ms(A), bb = await ms(B);
    ok('2: 20 minutes on one device and 10 on the other, the same day: 30 on both (total and the day)', a.ms === 30 && a.day === 30 && bb.ms === 30 && bb.day === 30, [a, bb]);
    await rounds(A, B, 2);
    const a2 = await ms(A), b2 = await ms(B);
    ok('2: synced again and again — still 30, nothing counted twice', a2.ms === 30 && b2.ms === 30 && a2.day === 30 && b2.day === 30, [a2, b2]);
    await read(A, 5); await sync(A); await read(B, 2); await rounds(A, B);
    const a3 = await ms(A), b3 = await ms(B);
    ok('2: more read on both after that: 37 on both', a3.ms === 37 && b3.ms === 37 && a3.day === 37, [a3, b3]);
    await A.context().close(); await B.context().close();
  }

  // ---------- 3: keys
  {
    remote = null;
    const A = await device('devA'), B = await device('devB');
    const nv = (id, size, extra = {}) => book(id, { title: 'Novel', format: 'webnovel', fileName: 'Novel.webnovel.json', size, remote: { source: 'ext:site', id: '/novel/9' }, ...extra });
    await put(A, nv('nA', 1000)); await put(B, nv('nB', 1700));
    const mark = (id, bid, at) => ({ id, label: id, locator: { bookId: bid, pct: 0.3 }, createdAt: at });
    await A.evaluate((m) => T.db.db.updateBook('nA', (b) => { b.bookmarks.push(m); }), mark('bmA', 'nA', 5));
    await rounds(A, B);
    const nb = await get(B, 'nB');
    ok('3: a web novel with more chapters on one device (another file size) gets the other\'s bookmark', nb.bookmarks.some((x) => x.id === 'bmA'), nb.bookmarks);
    // Chapters keep arriving on both, each sync after: the sync file does not pile up entries for it.
    for (let i = 1; i <= 4; i++) { await A.evaluate((s) => T.db.db.updateBook('nA', (b) => { b.size = s; }), 1000 + i * 111); await sync(A); await B.evaluate((s) => T.db.db.updateBook('nB', (b) => { b.size = s; }), 1700 + i * 97); await sync(B); }
    const entries = Object.entries(JSON.parse(remote).books).filter(([, v]) => v.title === 'Novel').length;
    ok('3: chapters arriving on both devices, synced in between: at most two entries for the novel in the sync file', entries <= 2, Object.keys(JSON.parse(remote).books));
    // A sync file an earlier version wrote (keyed by file name and size): its notes still reach the novel.
    const st = JSON.parse(remote);
    st.version = 1; st.books['Novel.webnovel.json:2088'] = { title: 'Novel', progressAt: 1, bookmarks: [mark('bmOld', 'zz', 7)], highlights: [], pins: [] };
    remote = JSON.stringify(st);
    await B.evaluate(() => T.db.db.updateBook('nB', (b) => { b.size = 2088; }));
    await rounds(A, B);
    const na = await get(A, 'nA'), nb2 = await get(B, 'nB');
    ok('3: an entry from a sync file of the earlier version still matches (and reaches the other device too)', nb2.bookmarks.some((x) => x.id === 'bmOld') && na.bookmarks.some((x) => x.id === 'bmOld'), [na.bookmarks.map((x) => x.id), nb2.bookmarks.map((x) => x.id)]);
    // Two copies of one file on A, each with its own note; B has one copy.
    await put(A, book('d1', { fileName: 'dup.txt', addedAt: 10 })); await put(A, book('d2', { fileName: 'dup.txt', addedAt: 20 })); await put(B, book('dB', { fileName: 'dup.txt', addedAt: 30 }));
    await A.evaluate((m) => T.db.db.updateBook('d1', (b) => { b.bookmarks.push(m); }), mark('first', 'd1', 5));
    await A.evaluate((m) => T.db.db.updateBook('d2', (b) => { b.bookmarks.push(m); }), mark('second', 'd2', 6));
    await rounds(A, B);
    const d1 = await get(A, 'd1'), d2 = await get(A, 'd2'), dB = await get(B, 'dB');
    ok('3: two copies of one file: neither takes the other\'s notes', d1.bookmarks.map((x) => x.id).join() === 'first' && d2.bookmarks.map((x) => x.id).join() === 'second', [d1.bookmarks.map((x) => x.id), d2.bookmarks.map((x) => x.id)]);
    ok('3: two copies of one file: the first copy\'s notes reach the other device\'s copy', dB.bookmarks.some((x) => x.id === 'first'), dB.bookmarks.map((x) => x.id));
    // A backup made when the novel was smaller, restored after more chapters arrived: its notes come back.
    const notes = await A.evaluate(async () => {
      navigator.canShare = () => true; navigator.share = async ({ files }) => { window.__shared = files[0]; };
      await T.db.db.updateBook('nA', (b) => { b.highlights.push({ id: 'hlBackup', text: 'x', color: 'amber', createdAt: 9 }); });
      await T.B.backupNotes(); return window.__shared.text();
    });
    const C = await device('devC');
    await put(C, nv('nC', 9999));
    const nc = await C.evaluate(async (t) => { await T.B.restoreBackup(new File([t], 'b.json', { type: 'application/json' }), undefined, { settings: false }); return T.db.db.getBook('nC'); }, notes);
    ok('3: a backup made before chapters arrived, restored after: the novel\'s notes come back', nc.highlights.some((x) => x.id === 'hlBackup'), nc.highlights);
    await A.context().close(); await B.context().close(); await C.context().close();
  }

  // ---------- 4: a clock running ahead
  {
    remote = null;
    const A = await device('devA', 3600_000), B = await device('devB');
    for (const p of [A, B]) await put(p, book('c1'));
    await rounds(A, B, 1);
    const readTo = (p, pct) => p.evaluate((pct) => T.db.db.updateBook('c1', (b) => { b.progress = { bookId: 'c1', pct }; b.lastOpenedAt = Date.now(); b.progressAt = T.db.stampAfter ? T.db.stampAfter(b.progressAt) : Date.now(); }), pct);
    const pos = async (p) => (await get(p, 'c1')).progress?.pct;
    await readTo(A, 0.2); await sync(A); await sync(B);
    ok('4: the position read on the device whose clock runs ahead reaches the other', (await pos(B)) === 0.2, await pos(B));
    await new Promise((r) => setTimeout(r, 20));
    await readTo(B, 0.5); await rounds(B, A);
    ok('4: read further afterwards on the other device: kept there, sync after sync', (await pos(B)) === 0.5, await pos(B));
    ok('4: … and taken by the device whose clock runs ahead', (await pos(A)) === 0.5, await pos(A));
    await readTo(A, 0.7); await rounds(A, B);
    ok('4: read further again on the device ahead: both there', (await pos(A)) === 0.7 && (await pos(B)) === 0.7, [await pos(A), await pos(B)]);
    const future = await B.evaluate(async () => { const bk = await T.db.db.getBook('c1'); return (bk.lastOpenedAt ?? 0) > Date.now() + 60000; });
    ok('4: no "last opened" time in the future kept on the other device', !future);
    await A.context().close(); await B.context().close();
  }

  ok('no page errors, every sync ok', errors.length === 0, errors);
  console.log(fails ? `${fails} failed` : 'all passed');
  await b.close(); server.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
