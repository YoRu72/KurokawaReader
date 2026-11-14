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
  put('/home/u/src/a.txt', false, 1); put('/home/u/src/b.txt', false, 2); put('/home/u/src/big.bin', false, 9e6); put('/home/u/src/D/x.txt', false, 1); put('/home/u/dst/a.txt', false, 5);
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
    window.kurokawaTools = new Proxy({ platform: 'desktop', available: true, os: 'linux', list: async () => [], onTasks: () => () => {}, listDir: async (p) => ({ entries: list[p] || [], exists: true }), deletePath: async () => ({ ok: true }) }, { get: (t, k) => (k in t ? t[k] : k === 'then' || k === 'filesJob' || k === 'onFilesJob' || k === 'titleBar' ? undefined : async () => undefined) });
  });
  await page.goto(`${base}#/files?p=${encodeURIComponent('/home/u/src')}`); await page.waitForSelector('.files-row', { timeout: 15000 }); await page.waitForTimeout(400);
  const r = page.locator('.files-row').first(); const bx = await r.boundingBox(); await page.mouse.move(bx.x + 80, bx.y + bx.height / 2); await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.up(); await page.waitForTimeout(200);
  await page.keyboard.press('Control+c'); await page.waitForTimeout(200);
  ok('[electron] no Copy / Cut in the selection, no clipboard bar after Ctrl+C', await page.locator('.files-selbar button[data-icon="copy"]').count() === 0 && await page.locator('.files-selbar button[data-icon="scissors"]').count() === 0 && await page.evaluate(() => { const b = document.querySelector('.files-clipbar'); return !b || b.hidden; }));
  ok('[electron] no page errors', !errors.length, errors);
  await br.close(); web.close();
  if (fails) { console.log(`${fails} failed`); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
