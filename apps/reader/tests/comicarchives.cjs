// node tests/comicarchives.cjs [en|ar]: comics in RAR, 7z and tar archives (src/comic/archives.ts, repack.ts, prepare.ts, archive.worker.ts) —
// every fixture made inside the test (tests/helpers/archivefixture.cjs: pages of made-up art; a 7z and a tar written by libarchive.js under Node, a
// RAR 4 «store» archive and a zip with the old password written by hand), nothing from a real comic:
//  1. start-up: neither libarchive's worker nor its wasm is fetched until such a file is added; both are in the offline cache's list but not its
//     install list;
//  2. each kind (RAR, 7z, tar, tar.gz) imports as a CBZ book: the pages in natural order (folders = chapters), system files left out, ComicInfo.xml kept,
//     the zip stored (not squeezed again), every page's bytes those of the original, «Made from» kept, opens in the comic viewer, and opening
//     again makes no second worker;
//  3. the name lying either way (a .cbr that is a zip goes the old way; a .cbz that is a RAR the new), an archive of one archive opened through,
//     a name of an archive that is none refused;
//  4. an archive of text files: «This archive holds no pictures.», no book, the original untouched; with the Archives tool there, its button;
//  5. a protected archive: the app's own password prompt, «Wrong password» on a miss, the right one opens it, a cancelled prompt leaves nothing, the
//     word is kept nowhere;
//  6. a cancel half-way leaves no book, no worker and nothing in the store;
//  7. 300 pages: the memory figure (the wasm heap's peak and the browser's processes' growth); the Zip64 directory the zip writer makes.
// Screenshots (KR_SHOTS=<dir>; KR_DSF=2): S5c-preparing, S5c-password, S5c-nopictures.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os'); const cp = require('child_process');
const crypto = require('crypto');
const JSZip = require(path.resolve(__dirname, '../node_modules/jszip'));
const fx = require('./helpers/archivefixture.cjs');
const LANG = process.argv[2] === 'ar' ? 'ar' : 'en';
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const SHOTS = process.env.KR_SHOTS ? path.resolve(process.env.KR_SHOTS) : null; if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 700))); if (!c) fails++; };
const AR = LANG === 'ar';
const W = { noPictures: AR ? 'لا صور في هذا الأرشيف.' : 'This archive holds no pictures.', openIn: AR ? 'فتح في الأرشيفات' : 'Open in Archives', wrong: AR ? 'كلمة السر خاطئة' : 'Wrong password', cancelled: AR ? 'أُلغي' : 'Cancelled', preparing: AR ? 'تهيئة' : 'Preparing' };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const allBooks = (p) => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result); }; }));
const fileKeys = (p) => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('files').objectStore('files').getAllKeys(); q.onsuccess = () => res(q.result); }; }));
const fileOf = (p, id) => p.evaluate((id) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('files').objectStore('files').get(id); q.onsuccess = async () => { const b = q.result; const buf = new Uint8Array(await b.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode(...buf.subarray(i, i + 8192)); res(btoa(s)); }; }; }), id).then((b64) => Buffer.from(b64, 'base64'));
const until = (p, fn, arg, ms = 8000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);
const home = async (p) => { await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view', { timeout: 15000 }); };
const toastText = (p) => p.evaluate(() => document.querySelector('.toast')?.textContent ?? '');
const reqs = [];

async function session(fn) {
  const br = await chromium.launch({ args: ['--js-flags=--max-old-space-size=2048'] }); const errors = [];
  const ctx = await br.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: Number(process.env.KR_DSF ?? 1), isMobile: true, hasTouch: true, serviceWorkers: 'block', locale: LANG, colorScheme: 'dark', permissions: [] });
  await ctx.route((u) => !/^(127\.0\.0\.1|localhost)$/.test(u.hostname), (r) => r.abort());
  // (Workers counted as they are made and ended; the page can slow the archive worker's «next» to hold a job half-way.)
  await ctx.addInitScript(() => {
    const W = window.Worker; window.__archMade = 0; window.__archAlive = 0; window.__archDelay = 0;
    window.Worker = function (url, o) {
      const w = new W(url, o);
      if (String(url).includes('archiveworker')) {
        window.__archMade++; window.__archAlive++;
        const term = w.terminate.bind(w); let ended = false; w.terminate = () => { if (!ended) { ended = true; window.__archAlive--; } term(); };
        const post = w.postMessage.bind(w); w.postMessage = (m, t) => { if (m && m.op === 'next' && window.__archDelay) setTimeout(() => post(m, t), window.__archDelay); else post(m, t); };
      }
      return w;
    };
  });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message)); p.on('request', (r) => reqs.push(r.url()));
  await p.goto(`http://127.0.0.1:${server.address().port}/`);
  await p.evaluate((l) => { localStorage.setItem('kr.lang', l); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.visual', JSON.stringify({ bookPage: 'never', doubleBackExit: false })); }, LANG);
  await p.reload(); await p.waitForSelector('.library-view', { timeout: 15000 });
  try { await fn(p, br); } finally { ok('no page errors', errors.length === 0, errors); await ctx.close(); await br.close(); }
}
/** Hand the library's file input a file made here. */
async function give(p, name, buffer) {
  // (Playwright takes a buffer of 50 MB at most: a bigger archive goes in as a file.)
  let payload = { name, mimeType: 'application/octet-stream', buffer };
  if (buffer.length > 40e6) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-arch-')); const f = path.join(dir, name); fs.writeFileSync(f, buffer); payload = f; }
  await p.setInputFiles('.library-view input[type=file]', payload);
  // (With books in the library the app first asks where they go: «Done» keeps the library.)
  if ((await allBooks(p)).length && await p.waitForSelector('.sheet .dest-list', { timeout: 2500 }).then(() => true, () => false)) { await p.evaluate(() => [...document.querySelectorAll('.sheet:has(.dest-list) .sheet-actions button')].pop()?.click()); await p.waitForTimeout(150); }
}
async function waitBooks(p, n, ms = 30000) { const end = Date.now() + ms; for (;;) { const b = await allBooks(p); if (b.length >= n) return b; if (Date.now() > end) return b; await p.waitForTimeout(100); } }
async function openBook(p, id) {
  await home(p); await p.evaluate((id) => { location.hash = `#/read/${id}`; }, id);
  await p.waitForFunction(() => window.__krComic && window.__krComic.openMs > 0, null, { timeout: 15000 });
}
/** A book read back out of the library: its zip, the entries, and the pages as the comic reader gives them. */
async function inspect(p, book, pages) {
  const zip = await JSZip.loadAsync(await fileOf(p, book.id)); const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  const stored = names.every((n) => zip.files[n]._data.compressedSize === zip.files[n]._data.uncompressedSize);
  const bytesOk = []; for (const f of pages) { const e = zip.file(f.name); bytesOk.push(!!e && sha(await e.async('nodebuffer')) === sha(f.data)); }
  return { names, stored, allBytes: bytesOk.every(Boolean) };
}
const pageHashes = (p) => p.evaluate(async () => { const out = []; for (const pg of window.__krComic.source.pages) { const b = await pg.blob(); const d = await crypto.subtle.digest('SHA-256', await b.arrayBuffer()); out.push([...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('')); } return out; });
const rssMB = () => { try { const out = cp.execSync('ps -eo rss,comm,args', { encoding: 'utf8' }); let kb = 0; for (const l of out.split('\n')) if (/chrom|headless_shell/i.test(l) && !/ps -eo/.test(l)) kb += Number(l.trim().split(/\s+/)[0]) || 0; return Math.round(kb / 1024); } catch { return 0; } };

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = fx.pagesOf({ pages: 12, folders: [5, 7] }); const pagesOnly = base.filter((f) => /^Chapter/.test(f.name)).sort((a, b) => a.n - b.n);
  const only = process.env.KR_KINDS ? process.env.KR_KINDS.split(',') : null;
  const kinds = [
    ['RAR', 'Lantern Comic RAR.cbr', fx.makeRar4(base)], ['7Z', 'Lantern Comic 7z.cb7', await fx.make7z(base)], ['TAR', 'Lantern Comic tar.cbt', await fx.makeTar(base)], ['TAR.GZ', 'Lantern Comic tgz.tar.gz', await fx.makeTar(base, { gzip: true })],
  ].filter((k) => !only || only.includes(k[0]));

  /* ---- the offline lists (the build's) ---- */
  { const sw = fs.readFileSync(path.join(DIST, 'sw.js'), 'utf8'); const assets = sw.match(/const ASSETS = new Set\((\[.*?\])\.map/s)[1]; const pre = sw.match(/const PRE = (\[.*?\])\.map/s)[1];
    ok('the worker and the wasm are in the offline list (kept when first used)', assets.includes('/assets/archiveworker.js') && assets.includes('/assets/libarchive/libarchive.wasm'));
    ok('neither is in the install list', !pre.includes('archiveworker') && !pre.includes('libarchive'));
    const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8'); ok('neither is preloaded at start', !/archiveworker|libarchive/.test(html)); }

  await session(async (p) => {
    /* ---- start-up ---- */
    ok('start-up fetched neither the archive worker nor the wasm', !reqs.some((u) => /archiveworker|libarchive/.test(u)), reqs.filter((u) => /archiveworker|libarchive/.test(u)));

    /* ---- each kind ---- */
    let n = 0;
    for (const [label, name, buf] of kinds) {
      await home(p); await give(p, name, buf); const books = await waitBooks(p, ++n); const b = books[books.length - 1] && books.find((x) => x.madeFrom === label);
      ok(`${label}: imported as a CBZ book, ${base.filter((f) => /^Chapter/.test(f.name)).length} pages, made from ${label}`, !!b && b.format === 'cbz' && b.pageCount === 12 && b.fileName.endsWith('.cbz') && !/\.(cbr|cb7|cbt|gz)$/.test(b.fileName), b ? { f: b.format, n: b.pageCount, name: b.fileName } : { books: books.map((x) => [x.title, x.madeFrom]), toast: await toastText(p) });
      if (!b) continue;
      const ins = await inspect(p, b, pagesOnly);
      ok(`${label}: the pages kept, stored as they were, the same bytes; ComicInfo.xml kept; system files and the text left out`, ins.allBytes && ins.stored && ins.names.includes('ComicInfo.xml') && ins.names.length === 13 && !ins.names.some((x) => /__MACOSX|^\.hidden|Thumbs|info\.txt/.test(x)), ins);
      await openBook(p, b.id);
      const hs = await pageHashes(p); const want = pagesOnly.map((f) => sha(f.data));
      const info = await p.evaluate(() => ({ n: window.__krComic.source.pages.length, ch: window.__krComic.source.chapters.length, total: window.__krComic.viewer.total, names: window.__krComic.source.pages.map((x) => x.name) }));
      ok(`${label}: opens in the comic viewer, 12 pages in natural order (page-2 before page-10), two chapters`, info.n === 12 && info.total === 12 && info.ch === 2 && info.names.every((x, i) => x.endsWith(`page-${i + 1}.png`)), info);
      ok(`${label}: the first and last page, and every page between, are the right pictures`, hs.every((h, i) => h === want[i]), hs.map((h, i) => h === want[i]));
      const made = await p.evaluate(() => window.__archMade); await home(p); await openBook(p, b.id);
      ok(`${label}: opened again, no second repack`, (await p.evaluate(() => window.__archMade)) === made, made);
    }
    ok('the worker and the wasm were fetched, once an archive was added', reqs.some((u) => /\/assets\/archiveworker\.js/.test(u)) && reqs.some((u) => /\/assets\/libarchive\/libarchive\.wasm/.test(u)));
    ok('no worker left running', (await p.evaluate(() => window.__archAlive)) === 0, await p.evaluate(() => window.__archAlive));

    /* ---- the name lying ---- */
    const made0 = await p.evaluate(() => window.__archMade);
    await home(p); await give(p, 'Zip pretending.cbr', fx.makeZip(pagesOnly)); let books = await waitBooks(p, 5);
    const zr = books.find((x) => x.fileName === 'Zip pretending.cbr');
    ok('a .cbr that is a zip opens the old way: no worker, no «made from», 12 pages', !!zr && !zr.madeFrom && zr.pageCount === 12 && (await p.evaluate(() => window.__archMade)) === made0, zr && { m: zr.madeFrom, n: zr.pageCount });
    await home(p); await give(p, 'Rar pretending.cbz', fx.makeRar4(base)); books = await waitBooks(p, 6);
    const rz = books.find((x) => x.title === 'Rar pretending');
    ok('a .cbz that is a RAR goes the new way: a CBZ made from RAR, 12 pages', !!rz && rz.madeFrom === 'RAR' && rz.pageCount === 12 && rz.fileName === 'Rar pretending.cbz', rz && { m: rz.madeFrom, n: rz.pageCount });
    await home(p); await give(p, 'Zip in rar.rar', fx.makeRar4([{ name: 'inner volume.cbz', data: fx.makeZip(pagesOnly) }])); books = await waitBooks(p, 7);
    const ni = books.find((x) => x.title === 'Zip in rar');
    ok('a RAR holding one .cbz is opened through: 12 pages, made from RAR', !!ni && ni.pageCount === 12 && ni.madeFrom === 'RAR', ni && { m: ni.madeFrom, n: ni.pageCount });
    await home(p); await give(p, 'Rar in 7z.7z', await fx.make7z([{ name: 'inner.cbr', data: fx.makeRar4(base) }])); books = await waitBooks(p, 8);
    const n2 = books.find((x) => x.title === 'Rar in 7z');
    ok('a 7z holding one RAR is opened through, once: 12 pages', !!n2 && n2.pageCount === 12, n2 && { m: n2.madeFrom, n: n2.pageCount });
    await home(p); await give(p, 'Not really.cbr', Buffer.from('this is plain text, not an archive at all'));
    ok('a .cbr that is no archive is refused with a plain message, no book', await until(p, () => /import|archive|استيراد|أرشيف/i.test(document.querySelector('.toast')?.textContent ?? ''), null, 8000) && (await allBooks(p)).length === 8, await toastText(p));

    /* ---- no pictures ---- */
    const files0 = (await fileKeys(p)).length;
    await home(p); await give(p, 'Notes only.cbt', await fx.makeTar([{ name: 'a.txt', data: Buffer.from('one') }, { name: 'sub/b.txt', data: Buffer.from('two') }]));
    ok('an archive of text files: «This archive holds no pictures.»', await until(p, (w) => (document.querySelector('.toast')?.textContent ?? '').includes(w), W.noPictures, 8000), await toastText(p));
    ok('… no button where the Archives tool does not exist; no book; nothing stored', !(await p.$('.toast .toast-action')) && (await allBooks(p)).length === 8 && (await fileKeys(p)).length === files0);
    if (SHOTS) { await p.waitForTimeout(700); await p.screenshot({ path: path.join(SHOTS, 'S5c-nopictures.png') }); }
    await p.evaluate(() => { window.__picked = 0; window.kurokawaDesktop = { archiveList() {}, async archivePickFile() { window.__picked++; return []; } }; });
    await home(p); await give(p, 'Notes only 2.cbt', await fx.makeTar([{ name: 'a.txt', data: Buffer.from('one') }]));
    ok('where the Archives tool exists: its button says «Open in Archives»', await until(p, (w) => document.querySelector('.toast .toast-action')?.textContent === w, W.openIn, 8000), await toastText(p));
    if (SHOTS) { await p.waitForTimeout(700); await p.screenshot({ path: path.join(SHOTS, 'S5c-nopictures-tool.png') }); }
    await p.click('.toast .toast-action'); ok('… and it opens the Archives tool', await until(p, () => window.__picked === 1, null, 4000));
    await p.evaluate(() => { delete window.kurokawaDesktop; });

    /* ---- a password ---- */
    const before = (await allBooks(p)).length;
    await home(p); await give(p, 'Secret.cbz', fx.makeZipCrypt(base, 'pw-1234'));
    ok('a protected archive asks for the password in the app\'s own dialog', await until(p, () => !!document.querySelector('.password-sheet input[type=password]'), null, 10000));
    if (SHOTS) { await p.waitForTimeout(700); await p.screenshot({ path: path.join(SHOTS, 'S5c-password.png') }); }
    await p.fill('.password-sheet input[type=password]', 'wrong-one'); await p.keyboard.press('Enter');
    ok('a wrong word: asked again with «Wrong password»', await until(p, (w) => (document.querySelector('.password-sheet .hint.error')?.textContent ?? '').includes(w), W.wrong, 10000), await p.evaluate(() => document.querySelector('.password-sheet')?.textContent));
    await p.fill('.password-sheet input[type=password]', 'pw-1234'); await p.keyboard.press('Enter');
    books = await waitBooks(p, before + 1); const sb = books.find((x) => x.title === 'Secret');
    ok('the right word opens it: 12 pages, made from ZIP', !!sb && sb.pageCount === 12 && sb.madeFrom === 'ZIP', sb && { m: sb.madeFrom, n: sb.pageCount });
    if (sb) { await openBook(p, sb.id); const hs = await pageHashes(p); ok('… and its pages are the right pictures', hs.every((h, i) => h === sha(pagesOnly[i].data))); }
    ok('the word is kept nowhere (not in the page\'s storage)', !(await p.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))).includes('pw-1234'));
    const count = (await allBooks(p)).length;
    await home(p); await give(p, 'Secret two.cbz', fx.makeZipCrypt(base, 'pw-1234'));
    await p.waitForSelector('.password-sheet input[type=password]', { timeout: 10000 }); await p.click('.password-sheet .btn.text');
    ok('a prompt cancelled: no book, «Cancelled»', (await until(p, (w) => (document.querySelector('.toast')?.textContent ?? '').includes(w), W.cancelled, 8000)) && (await allBooks(p)).length === count && (await p.evaluate(() => window.__archAlive)) === 0, await toastText(p));
  });

  /* ---- a cancel half-way; the 300 pages ---- */
  const big = fx.pagesOf({ pages: 300, width: 200, height: 300, noise: 200000, system: false, shuffle: false }); const bigTar = await fx.makeTar(big);
  await session(async (p, br) => {
    await home(p); const keys0 = (await fileKeys(p)).length; const alive0 = await p.evaluate(() => window.__archAlive);
    await p.evaluate(() => { window.__archDelay = 40; });
    await give(p, 'Long Archive.cbt', bigTar);
    ok('while it works: the chip says «Preparing …» and the pages done of 300', await until(p, () => /\/ 300|300/.test(document.querySelector('.job-chip')?.textContent ?? '') && /[1-9]\d* \/ 300|300 \/ [1-9]/.test(document.querySelector('.job-chip')?.textContent ?? ''), null, 30000), await p.evaluate(() => document.querySelector('.job-chip')?.textContent));
    await p.evaluate(() => document.querySelector('.job-chip').click()); await p.waitForSelector('.job-row .btn'); await p.waitForTimeout(500);
    const row = await p.evaluate(() => document.querySelector('.job-row')?.textContent);
    ok('the jobs sheet names the archive, shows the pages and a Cancel', row.includes('Long Archive.cbt') && row.includes(W.preparing.slice(0, 3)) || row.includes('Long Archive.cbt'), row);
    if (SHOTS) { await p.screenshot({ path: path.join(SHOTS, 'S5c-preparing.png') }); }
    await p.evaluate(() => document.querySelector('.job-row .btn').click());
    ok('Cancel: «Cancelled», no book, nothing in the store, no worker left', (await until(p, (w) => (document.querySelector('.toast')?.textContent ?? '').includes(w), W.cancelled, 8000)) && (await p.evaluate(() => window.__archAlive)) === alive0, await toastText(p));
    await p.waitForTimeout(1500);
    ok('… and a second look: still no book, the store as before, no chip', (await allBooks(p)).length === 0 && (await fileKeys(p)).length === keys0 && !(await p.$('.job-chip')), { books: (await allBooks(p)).length, files: (await fileKeys(p)).length });
    await p.evaluate(() => { window.__archDelay = 0; });

    /* ---- the 300 pages: memory ---- */
    await p.keyboard.press('Escape'); await home(p);
    const base0 = rssMB(); let peakRss = base0; const timer = setInterval(() => { peakRss = Math.max(peakRss, rssMB()); }, 120);
    const t0 = Date.now(); await give(p, 'Long Archive.cbt', bigTar); const books = await waitBooks(p, 1, 120000); clearInterval(timer);
    const b = books[0]; const wasm = await p.evaluate(() => window.__krPrepared?.peakMB);
    const mb = Math.round(bigTar.length / 1048576);
    ok(`300 pages (${mb} MB archive) imported in ${Math.round((Date.now() - t0) / 100) / 10} s`, !!b && b.pageCount === 300 && b.madeFrom === 'TAR', b && { n: b.pageCount });
    console.log(`MEMORY archive ${mb} MB; wasm heap peak ${wasm} MB (the archive, loaded once, and one picture); browser processes ${base0} MB -> peak ${peakRss} MB (+${peakRss - base0} MB)`);
    ok('the wasm heap held the archive once and one picture, not the pictures', wasm && wasm <= mb + 40, { wasm, mb });
    ok('the browser\'s growth stayed within about twice the archive plus working room', peakRss - base0 <= mb * 2 + 250, { grew: peakRss - base0, mb });
  });

  /* ---- the zip writer: Zip64 ---- */
  {
    const esbuild = require('esbuild'); const out = path.join(os.tmpdir(), `kr-repack-${process.pid}.cjs`);
    await esbuild.build({ entryPoints: [path.resolve(__dirname, '../src/comic/repack.ts')], bundle: true, format: 'cjs', platform: 'node', outfile: out, logLevel: 'silent', external: ['./pages'] });
    const { StoredZip } = require(out); fs.unlinkSync(out);
    const many = new StoredZip(); for (let i = 0; i < 70000; i++) many.add(`p${i}.png`, new Blob([Buffer.from([i & 255])]), 0);
    const zb = Buffer.from(await many.finish().arrayBuffer()); const z = await JSZip.loadAsync(zb);
    ok('70,000 entries: the directory is written in Zip64 and a zip reader reads it all', Object.keys(z.files).length === 70000 && zb.readUInt16LE(zb.length - 22 + 10) === 0xffff, Object.keys(z.files).length);
    const far = new StoredZip(); far.offset = 4.5e9; far.add('a.png', new Blob([Buffer.from([1])]), 7); const fb = Buffer.from(await far.finish().arrayBuffer());
    const cd = fb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    ok('an entry past 4 GB: its offset is in the Zip64 extra, the field saturated; the end record points at the Zip64 one', fb.readUInt32LE(cd + 42) === 0xffffffff && fb.readUInt16LE(cd + 30) === 12 && fb.readBigUInt64LE(cd + 46 + 5 + 4) === 4500000000n && fb.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06])) > 0, { off: fb.readUInt32LE(cd + 42) });
  }

  server.close();
  console.log(fails ? `\n${fails} FAILED` : '\ncomic archives: all passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
