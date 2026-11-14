// The Files page on a computer with the Tauri shell (stage P3): its own copy / move / delete jobs (bridge.js's
// filesJob, filesCancel, filesAnswer, onFilesJob — the phone's shapes) make Copy, Cut, Paste and the clipboard bar
// appear there, through the real desktop-tauri/bridge.js over a pretend Tauri IPC whose disk is a tree in the page:
// copy → Paste into a folder where the name is taken → the question → «Keep both» → «a (2).txt»; cut → Ctrl+V → moved
// and the clipboard emptied; a folder over itself → Paste greyed with its reason; Delete → the system's recycle bin
// (deletePath); Cancel on a job's row stops it; in Arabic too. On Electron's bridge (no jobs) none of it shows.
// Run: NODE_PATH=$(npm root -g) node tests/filestauri.cjs
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const BRIDGE = fs.readFileSync(path.join(__dirname, '..', 'desktop-tauri', 'bridge.js'), 'utf8');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = () => http.createServer((req, r) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); r.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(r); });
let fails = 0; const ok = (what, cond, x) => { console.log((cond ? 'ok   ' : 'FAIL ') + what + (cond || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!cond) fails++; };

/** In the page, before the bridge: a pretend Tauri IPC over a tree of files (path → { dir, size }). */
function fakeTauri({ lang, slow }) {
  localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.pc.starter', '1');
  localStorage.setItem('kt.settings', JSON.stringify({ addons: ['files'] }));
  localStorage.setItem('kt.files.prefs', JSON.stringify({ view: 'list', sort: 'name', desc: false, hidden: false, kind: 'all' }));
  const tree = new Map(); window.__tree = tree; window.__calls = [];
  const put = (p, dir, size = 1) => tree.set(p, { dir, size });
  for (const d of ['/home/u', '/home/u/src', '/home/u/src/D', '/home/u/src/D/sub', '/home/u/dst']) put(d, true);
  put('/home/u/src/pack.zip', false, 300); put('/home/u/src/a.txt', false, 1); put('/home/u/src/b.txt', false, 2); put('/home/u/src/big.bin', false, 9e6); put('/home/u/src/D/x.txt', false, 1); put('/home/u/dst/a.txt', false, 5);
  const parent = (p) => p.replace(/\/[^/]*$/, '') || '/'; const base = (p) => p.split('/').pop();
  const sub = (p) => [...tree.keys()].filter((k) => k === p || k.startsWith(p + '/'));
  const keepBoth = (to) => { const m = /^(.*?)(\.[^./]{1,7})?$/.exec(base(to)); for (let i = 2; ; i++) { const c = `${parent(to)}/${m[1]} (${i})${m[2] || ''}`; if (!tree.has(c)) return c; } };
  const ls = {}; const emit = (o) => setTimeout(() => (ls['kt:files'] || []).forEach((f) => f({ event: 'kt:files', payload: JSON.parse(JSON.stringify(o)) })), 0);
  const jobs = {}; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const run = async (o) => {
    const j = (jobs[o.id] = { cancel: false, standing: o.conflict || 'ask', wake: null }); let files = 0, skipped = 0, left = 0; const failed = [], remaining = [];
    const ask = (from, to) => new Promise((res) => { if (j.standing !== 'ask') return res(j.standing); j.wake = res; emit({ id: o.id, status: 'conflict', from, to, size: tree.get(from).size, existingSize: tree.get(to).size, mtime: 1, existingMtime: 1, dir: tree.get(from).dir }); });
    for (const p of o.paths) {
      if (j.cancel) { if (o.op === 'move') { left++; remaining.push(p); } continue; }
      if (o.op === 'delete') { for (const k of sub(p)) tree.delete(k); files++; continue; }
      if (tree.get(p)?.dir && (o.dest + '/').startsWith(p + '/')) { failed.push(base(p) + ': into itself'); continue; }
      let to = o.dest + '/' + base(p);
      if (tree.get(p)?.size > 1e6) { for (let i = 0; i < 40 && !j.cancel; i++) { emit({ id: o.id, status: 'progress', done: i * 1e5, total: 9e6, files: 0, ofFiles: 1, name: base(p) }); await sleep(slow); } if (j.cancel) { if (o.op === 'move') { left++; remaining.push(p); } continue; } }
      if (to === p) { if (o.op === 'move') continue; to = keepBoth(to); }
      else if (tree.has(to)) { const a = await ask(p, to); if (a === 'skip') { skipped++; if (o.op === 'move') { left++; remaining.push(p); } continue; } if (a === 'keep') to = keepBoth(to); }
      for (const k of sub(p)) tree.set(to + k.slice(p.length), { ...tree.get(k) }); files++;
      if (o.op === 'move') for (const k of sub(p)) tree.delete(k);
      emit({ id: o.id, status: 'progress', done: files, total: o.paths.length, files, ofFiles: o.paths.length, name: base(p) });
    }
    delete jobs[o.id]; emit({ id: o.id, status: j.cancel ? 'cancelled' : 'done', done: files, total: files, files, failed, skipped, ...(o.op === 'move' ? { left, remaining } : {}) });
  };
  const replies = {
    kt_state: () => ({ available: false, reason: '', os: 'linux', arch: 'x64' }), kt_list: () => [], kt_default_dir: () => '/home/u/Downloads/Kurokawa', kt_roots: () => ({ roots: ['/home/u'] }),
    kt_list_dir: (a) => { const p = a.p.replace(/\/+$/, ''); if (!tree.get(p)?.dir) return { entries: [], exists: false }; return { exists: true, entries: [...tree.keys()].filter((k) => parent(k) === p && k !== p).map((k) => ({ name: base(k), path: k, dir: tree.get(k).dir, size: tree.get(k).size, mtime: 1760000000000 })) }; },
    kt_files_job: (a) => { void run(a.o); return { id: a.o.id }; },
    kt_files_cancel: (a) => { const j = jobs[a.o.id]; if (j) { j.cancel = true; if (j.wake) j.wake('skip'); } return null; },
    kt_files_answer: (a) => { const j = jobs[a.o.id]; if (!j) return null; const w = a.o.answer; if (/All$/.test(w)) j.standing = w.replace(/All$/, ''); const f = j.wake; j.wake = null; if (f) f(w.replace('All', '')); return null; },
    kt_delete_path: (a) => { for (const k of sub(a.p)) tree.delete(k); return { ok: true, trashed: true }; },
    // (The storages, new folder, rename, stat: the phone plugin's shapes.)
    // (Archives, stage P7: pack.zip holds In/one.txt and two.txt; extracting writes what was chosen into the tree.)
    kt_archive_list: (a) => (a.o.path === '/home/u/src/pack.zip' ? { format: 'zip', entries: [{ path: 'In/', size: 0, dir: true, mtime: 1760000000000 }, { path: 'In/one.txt', size: 3, dir: false, mtime: 1760000000000 }, { path: 'two.txt', size: 2, dir: false, mtime: 1760000000000 }], total: 5, encrypted: false, inPlaceOk: true, resumable: false, largest: 3, free: 5e9 } : Promise.reject('notArchive')),
    kt_archive_extract: (a) => { window.__extracts = (window.__extracts || []).concat([a.o]); const all = [['In/one.txt', 3], ['two.txt', 2]]; const want = (n) => !a.o.only || a.o.only.some((w) => n === w || (w.endsWith('/') && n.startsWith(w))); const dest = a.o.dest; put(dest, true); let n = 0; for (const [p, size] of all) if (want(p)) { const parts = p.split('/'); for (let i = 1; i < parts.length; i++) put(dest + '/' + parts.slice(0, i).join('/'), true); put(dest + '/' + p, false, size); n++; } (ls['kt:archiveProgress'] || []).forEach((f) => f({ payload: { id: a.o.id, done: 5, total: 5, file: '' } })); return { files: n, dest }; },
    kt_archive_create: (a) => { window.__zips = (window.__zips || []).concat([a.o]); put(a.o.out, false, 10); return { files: a.o.inputs.length, path: a.o.out, size: 10 }; },
    kt_archive_cancel: () => null,
    kt_home_dir: () => '/home/u',
    kt_files_roots: () => ({ allFiles: true, roots: [{ kind: 'home', path: '/home/u', name: 'u', readable: true }, { kind: 'downloads', path: '/home/u/dst', name: 'dst', readable: true }, { kind: 'drive', path: '/', name: '/', readable: true, free: 5 * 2 ** 30, total: 9 * 2 ** 30 }, { kind: 'drive', path: '/media/u/USB', name: 'USB', readable: true, free: 2 ** 30, total: 2 ** 32 }] }),
    kt_files_stat: (a) => { const p = a.o.path.replace(/\/+$/, ''); const e = tree.get(p); return e ? { exists: true, name: base(p), path: p, dir: e.dir, size: e.dir ? 0 : e.size, mtime: 1760000000000, readable: true, writable: !p.startsWith('/home/u/ro'), hidden: false } : { exists: false, name: base(p), path: p, dir: false, size: 0, mtime: 0, readable: false, writable: false, hidden: false }; },
    kt_files_mkdir: (a) => { const p = a.o.path; if (tree.has(p) && !tree.get(p).dir) throw 'exists'; put(p, true); return { ok: true, path: p }; },
    kt_files_rename: (a) => { const to = parent(a.o.path) + '/' + a.o.name; if (tree.has(to)) return Promise.reject('exists'); for (const k of sub(a.o.path)) { tree.set(to + k.slice(a.o.path.length), tree.get(k)); tree.delete(k); } return { ok: true, path: to }; },
  };
  window.__TAURI__ = {
    core: { invoke: (c, a) => { window.__calls.push(c); return Promise.resolve(replies[c] ? replies[c](a || {}) : null); } },
    event: { listen: (n, f) => { (ls[n] = ls[n] || []).push(f); return Promise.resolve(() => undefined); } },
  };
  window.__KT_BOOT__ = { os: 'linux', arch: 'x64' };
}

(async () => {
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch(); const S = (lang) => { const esb = require('esbuild'); const out = esb.buildSync({ entryPoints: [path.join(__dirname, '..', 'src/i18n', `${lang}.ts`)], bundle: true, write: false, format: 'cjs', platform: 'node' }); const m = { exports: {} }; new Function('module', 'exports', out.outputFiles[0].text)(m, m.exports); return { ...m.exports.en, ...m.exports[lang] }; };
  for (const lang of ['en', 'ar']) {
    const T = S(lang); const L = (s) => `[${lang}] ${s}`;
    const page = await br.newPage({ viewport: { width: 1280, height: 800 } }); const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.route(/api\.github\.com|raw\.githubusercontent\.com/, (r) => r.fulfill({ status: 404, body: '' }));
    await page.addInitScript(fakeTauri, { lang, slow: 60 }); await page.addInitScript({ content: BRIDGE });
    const goTo = async (p) => { await page.goto(`${base}#/files?p=${encodeURIComponent(p)}`); await page.waitForSelector('.files-row', { timeout: 15000 }); await page.waitForTimeout(400); };
    const row = (name) => page.locator(`.files-row:has(.files-name[title="${name}"])`).first();
    const hold = async (name) => { const b = await row(name).boundingBox(); await page.mouse.move(b.x + 80, b.y + b.height / 2); await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.up(); await page.waitForTimeout(200); };
    const tree = () => page.evaluate(() => [...window.__tree.keys()].sort());
    const bar = () => page.evaluate(() => { const b = document.querySelector('.files-clipbar'); if (!b || b.hidden || !b.getClientRects().length) return null; const pb = b.querySelector('.files-clip-paste'); return { name: b.querySelector('.files-clip-name')?.textContent ?? '', why: b.querySelector('.files-clip-why')?.textContent ?? '', disabled: pb.disabled }; });

    await goTo('/home/u/src');
    // the storages: home, Downloads in the page's language, the disks with their free space
    const chips = await page.evaluate(() => [...document.querySelectorAll('.files-roots .chip')].map((c) => c.textContent.trim()));
    ok(L('the storages: Home, Downloads (named in the page\'s language), the disks with their free space'), chips.length === 4 && chips[0] === T.filesHome && chips[1] === T.filesPlaceDownloads && chips[2].startsWith('/') && /\d/.test(chips[2]) && chips[3].startsWith('USB'), chips);
    ok(L('the chip of the storage this folder is in is the one lit'), await page.evaluate(() => document.querySelector('.files-roots .chip.on')?.textContent.trim()) === T.filesHome);
    // a new folder (the ⋮ menu → New folder), then renamed with F2, then a name taken refused
    await page.click('.files-head button[data-icon="more"], .app-bar button[data-icon="more"]').catch(async () => { await page.locator('button[data-icon="more"]').first().click(); });
    await page.waitForSelector('.sheet', { timeout: 3000 }); await page.click(`.sheet button:has-text("${T.newFolder}")`); await page.waitForTimeout(250);
    await page.fill('.sheet input', 'Fresh'); await page.click(`.sheet button:has-text("${T.create}")`); await page.waitForTimeout(500);
    ok(L('New folder: made through filesMkdir, listed'), (await tree()).includes('/home/u/src/Fresh') && await row('Fresh').count() === 1, await tree());
    await hold('Fresh'); await page.keyboard.press('F2'); await page.waitForSelector('.sheet input', { timeout: 3000 });
    await page.fill('.sheet input', 'Renamed'); await page.click(`.sheet button.primary:has-text("${T.rename}")`); await page.waitForTimeout(500);
    ok(L('F2 → Rename: through filesRename, listed under its new name'), (await tree()).includes('/home/u/src/Renamed') && !(await tree()).includes('/home/u/src/Fresh') && await row('Renamed').count() === 1, await tree());
    await hold('Renamed'); await page.keyboard.press('F2'); await page.waitForSelector('.sheet input', { timeout: 3000 });
    await page.fill('.sheet input', 'a.txt'); await page.click(`.sheet button.primary:has-text("${T.rename}")`); await page.waitForTimeout(400);
    const taken = await page.evaluate(() => [...document.querySelectorAll('.toast')].map((x) => x.textContent).join(' '));
    ok(L('a name taken: said so, nothing renamed'), taken.includes(T.filesNameTaken) && (await tree()).includes('/home/u/src/Renamed'), taken);
    await page.keyboard.press('Escape'); await page.waitForTimeout(150); await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    // properties of a file: through filesStat (shallow), its access said
    await page.locator('.files-row:has(.files-name[title="a.txt"]) button[data-icon="more"]').first().click(); await page.waitForSelector('.sheet', { timeout: 3000 });
    await page.click(`.sheet button:has-text("${T.properties}")`); await page.waitForTimeout(500);
    const props = await page.evaluate(() => document.querySelector('.files-props')?.textContent ?? '');
    ok(L('Properties: from filesStat — its access (writable)'), props.includes(T.filesWritable) && (await page.evaluate(() => window.__calls.includes('kt_files_stat'))), props.slice(0, 200));
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    await goTo('/home/u/src');
    await hold('a.txt');
    ok(L('the selection offers Copy and Cut (the Tauri shell has jobs)'), await page.locator('.files-selbar button[data-icon="copy"]').count() === 1 && await page.locator('.files-selbar button[data-icon="scissors"]').count() === 1);
    await page.keyboard.press('Control+c'); await page.waitForTimeout(200);
    let b = await bar(); ok(L('Ctrl+C: the clipboard bar shows the file'), !!b && b.name === 'a.txt' && b.why === T.filesClipCopy, b);
    await goTo('/home/u/dst');
    b = await bar(); ok(L('the clipboard bar lives across folders, Paste open'), !!b && !b.disabled, b);
    await page.click('.files-clip-paste'); await page.waitForSelector('.sheet', { timeout: 5000 });
    const ask = await page.evaluate(() => document.querySelector('.sheet')?.textContent ?? '');
    ok(L('a name taken: the question, its name in it'), ask.includes('a.txt') && ask.includes(T.keepBoth), ask.slice(0, 160));
    await page.click(`.sheet button:has-text("${T.keepBoth}")`); await page.waitForTimeout(600);
    let t = await tree(); ok(L('«Keep both» → «a (2).txt» beside the old one, the original kept'), t.includes('/home/u/dst/a (2).txt') && t.includes('/home/u/dst/a.txt') && t.includes('/home/u/src/a.txt'), t);
    ok(L('the folder read again: the new file listed'), await row('a (2).txt').count() === 1);
    b = await bar(); ok(L('a copy stays on the clipboard'), !!b, b);
    // cut + Ctrl+V
    await goTo('/home/u/src'); await hold('b.txt'); await page.keyboard.press('Control+x'); await page.waitForTimeout(200);
    b = await bar(); ok(L('Ctrl+X: the bar shows it, Paste greyed in its own folder'), !!b && b.name === 'b.txt' && b.disabled && b.why === T.filesPasteSameFolder, b);
    await goTo('/home/u/dst'); b = await bar(); ok(L('… elsewhere, it says it will be moved'), !!b && !b.disabled && b.why === T.filesClipMove, b);
    await page.keyboard.press('Control+v'); await page.waitForTimeout(700);
    t = await tree(); ok(L('Ctrl+V: moved — there, gone from where it was'), t.includes('/home/u/dst/b.txt') && !t.includes('/home/u/src/b.txt'), t);
    ok(L('a cut that went through empties the clipboard'), (await bar()) === null);
    // a folder over itself
    await goTo('/home/u/src'); await hold('D'); await page.keyboard.press('Control+c'); await goTo('/home/u/src/D');
    b = await bar(); ok(L('a folder into itself: Paste greyed, the reason said'), !!b && b.disabled && b.why === T.filesIntoItself, b);
    await page.keyboard.press('Escape'); await page.waitForTimeout(150); ok(L('Esc clears the clipboard'), (await bar()) === null);
    // Cancel on a job's row
    await goTo('/home/u/src'); await hold('big.bin'); await page.keyboard.press('Control+c'); await goTo('/home/u/dst');
    await page.click('.files-clip-paste'); await page.waitForSelector('.files-job', { timeout: 3000 }); await page.waitForTimeout(250);
    await page.click('.files-job button'); await page.waitForTimeout(500);
    t = await tree(); ok(L('Cancel on the job\'s row stops it: nothing arrives'), !t.includes('/home/u/dst/big.bin') && (await page.locator('.files-job').count()) === 0, t);
    // delete to the system's recycle bin
    await page.keyboard.press('Escape'); await hold('a (2).txt'); await page.keyboard.press('Delete'); await page.waitForSelector('.sheet', { timeout: 3000 });
    const sheet = await page.evaluate(() => document.querySelector('.sheet')?.textContent ?? '');
    ok(L('Delete asks: to the system\'s recycle bin, or for good'), sheet.includes(T.filesTrashSystemHint) && sheet.includes(T.filesTrashSystem) && sheet.includes(T.filesDeleteForever), sheet.slice(0, 200));
    await page.click(`.sheet button:has-text("${T.filesTrashSystem}")`); await page.waitForTimeout(500);
    t = await tree(); ok(L('… to the recycle bin: deletePath asked, the file gone from the list'), !t.includes('/home/u/dst/a (2).txt') && (await page.evaluate(() => window.__calls.includes('kt_delete_path'))) && (await row('a (2).txt').count()) === 0, t);
    // archives (stage P7): an archive's own sheet offers Extract here / to and Compress; walked into as a folder; an
    // entry copied out the phone's way — into a hidden folder at the destination, moved in by a job, the folder gone
    await goTo('/home/u/src');
    await page.locator('.files-row:has(.files-name[title="pack.zip"]) button[data-icon="more"]').first().click(); await page.waitForSelector('.sheet', { timeout: 3000 });
    const arcSheet = await page.evaluate(() => document.querySelector('.sheet')?.textContent ?? '');
    ok(L('an archive\'s sheet: Extract here, Extract to…, Compress (the Tauri shell has the archives)'), arcSheet.includes(T.extractHere) && arcSheet.includes(T.extractTo) && arcSheet.includes(T.filesCompress), arcSheet.slice(0, 200));
    await page.click(`.sheet button:has-text("${T.extractHere}")`); await page.waitForTimeout(600);
    t = await tree(); ok(L('Extract here: the whole archive out beside it'), t.includes('/home/u/src/In/one.txt') && t.includes('/home/u/src/two.txt') && (await page.evaluate(() => !window.__extracts[0].only)), t);
    await goTo(`arc://${encodeURIComponent('/home/u/src/pack.zip')}`);
    ok(L('walked into the archive: its folder and file listed'), await row('In').count() === 1 && await row('two.txt').count() === 1);
    await hold('two.txt'); await page.keyboard.press('Control+c'); await page.waitForTimeout(150); await goTo('/home/u/dst');
    await page.click('.files-clip-paste'); await page.waitForTimeout(1200);
    t = await tree(); const ex = await page.evaluate(() => window.__extracts[window.__extracts.length - 1]);
    ok(L('Paste of an archive\'s entry: taken out (only it) into a hidden «.kurokawa-extract-*» folder there, moved in, the folder removed'), t.includes('/home/u/dst/two.txt') && /^\/home\/u\/dst\/\.kurokawa-extract-/.test(ex.dest) && JSON.stringify(ex.only) === '["two.txt"]' && !t.some((k) => k.includes('.kurokawa-extract-')), { t, ex });
    // compress: a zip made of the chosen
    await goTo('/home/u/src'); await page.locator('.files-row:has(.files-name[title="a.txt"]) button[data-icon="more"]').first().click(); await page.waitForSelector('.sheet', { timeout: 3000 });
    await page.click(`.sheet button:has-text("${T.filesCompress}")`); await page.waitForTimeout(300);
    const fmts = await page.evaluate(() => document.querySelector('.sheet')?.textContent ?? '');
    await page.click(`.sheet button.primary:has-text("${T.filesCompress}")`); await page.waitForTimeout(600);
    const zips = await page.evaluate(() => window.__zips || []);
    ok(L('Compress: a zip of it made through archiveCreate (zip only on a computer)'), zips.length === 1 && zips[0].out === '/home/u/src/a.zip' && JSON.stringify(zips[0].inputs) === '["/home/u/src/a.txt"]' && fmts.includes('ZIP') && !fmts.includes('7Z'), { zips, fmts: fmts.slice(0, 120) });
    ok(L('no page errors'), !errors.length, errors);
    await page.close();
  }
  // Electron's bridge: no jobs — no Copy, Cut, Paste or clipboard bar.
  const page = await br.newPage({ viewport: { width: 1280, height: 800 } }); const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  await page.route(/api\.github\.com|raw\.githubusercontent\.com/, (r) => r.fulfill({ status: 404, body: '' }));
  await page.addInitScript(() => {
    localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.pc.starter', '1'); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['files'] }));
    localStorage.setItem('kt.files.prefs', JSON.stringify({ view: 'list', sort: 'name', desc: false, hidden: false, kind: 'all' }));
    const list = { '/home/u/src': [{ name: 'a.txt', path: '/home/u/src/a.txt', dir: false, size: 1, mtime: 1760000000000 }] };
    window.kurokawaTools = new Proxy({ platform: 'desktop', available: true, os: 'linux', list: async () => [], onTasks: () => () => {}, listDir: async (p) => ({ entries: list[p] || [], exists: true }), deletePath: async () => ({ ok: true }) }, { get: (t, k) => (k in t ? t[k] : k === 'then' || ['filesJob', 'onFilesJob', 'titleBar', 'homeDir', 'filesRoots', 'filesStat', 'filesMkdir', 'filesRename'].includes(k) ? undefined : async () => undefined) });
  });
  await page.goto(`${base}#/files?p=${encodeURIComponent('/home/u/src')}`); await page.waitForSelector('.files-row', { timeout: 15000 }); await page.waitForTimeout(400);
  const r = page.locator('.files-row').first(); const bx = await r.boundingBox(); await page.mouse.move(bx.x + 80, bx.y + bx.height / 2); await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.up(); await page.waitForTimeout(200);
  await page.keyboard.press('Control+c'); await page.waitForTimeout(200);
  ok('[electron] no Copy / Cut in the selection, no clipboard bar after Ctrl+C', await page.locator('.files-selbar button[data-icon="copy"]').count() === 0 && await page.locator('.files-selbar button[data-icon="scissors"]').count() === 0 && await page.evaluate(() => { const b = document.querySelector('.files-clipbar'); return !b || b.hidden; }));
  ok('[electron] no storages listed and no New folder there (its shell has neither)', await page.locator('.files-roots .chip').count() === 0);
  await page.keyboard.press('Escape'); await page.waitForTimeout(150);
  await page.locator('.files-row button[data-icon="more"]').first().click(); await page.waitForSelector('.sheet', { timeout: 3000 });
  const eSheet = await page.evaluate(() => document.querySelector('.sheet')?.textContent ?? '');
  ok('[electron] the Files page as it was: no Extract here / Compress offered there', !eSheet.includes('Beside the archive') && !eSheet.includes('Compress') && eSheet.includes('Properties'), eSheet.slice(0, 160));
  ok('[electron] no page errors', !errors.length, errors);
  await br.close(); web.close();
  if (fails) { console.log(`${fails} failed`); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
