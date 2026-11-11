// The Files page's side of the jobs, against a pretend phone whose listings and jobs the test steers: a late listing
// never drawn over a newer folder's (and a paste goes where the reader is); a copy stays on the clipboard, a cut is
// kept until its move has gone through (what was left stays cut); a folder never pasted into itself (Paste hidden there,
// refused across panes); in two panes, one job's question asked once, by the pane that started it; the batch rename's
// preview keeps extensions and shows clashes; a delete the recycle bin could not take offered for good.
// Run: NODE_PATH=$(npm root -g) node tests/filesjobs.cjs
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.join(__dirname, '..', 'dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (what, cond, x) => { console.log((cond ? 'ok   ' : 'FAIL ') + what + (cond || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!cond) fails++; };
const K = '/storage/emulated/0/Download/Kurokawa', P = '/storage/emulated/0';
(async () => {
  await new Promise((r) => server.listen(5483, r));
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 412, height: 900 }, deviceScaleFactor: 1 });
  const errors = []; p.on('pageerror', (e) => errors.push(String(e))); p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|blocked by CORS policy/.test(m.text())) errors.push(m.text()); }); await p.route(/api\.github\.com/, (r) => r.fulfill({ json: [], headers: { 'access-control-allow-origin': '*' } }));
  await p.addInitScript(() => {
    const tree = { '/storage/emulated/0/Download/Kurokawa': { 'Song.mp3': 5000000, Sub: {}, Subway: {}, 'Show.S01E01.720p.mkv': 900, '.gitignore': 10, 'archive.tar.gz': 50, README: 20 }, '/storage/emulated/0/Download/Kurokawa/Sub': { 'in.txt': 1 }, '/storage/emulated/0/Download/Kurokawa/Subway': {}, '/storage/emulated/0': { DCIM: {}, Music: {}, 'readme.md': 300 }, '/storage/emulated/0/DCIM': { 'pic.jpg': 9 }, '/storage/emulated/0/Music': { 'tune.mp3': 5 } };
    const listOf = (dir) => { const d = tree[dir]; if (!d) return null; return Object.entries(d).map(([name, v]) => ({ name, path: `${dir}/${name}`, dir: typeof v === 'object', size: typeof v === 'object' ? 0 : v, mtime: 1760000000000, ext: typeof v === 'object' ? undefined : (name.lastIndexOf('.') > 0 ? name.split('.').pop() : ''), count: typeof v === 'object' ? 0 : undefined })); };
    const ls = {}; window.__calls = []; window.__lists = []; window.__delay = {}; window.__plan = []; window.__trashFail = false;
    const emit = (ev) => (ls.files || []).forEach((f) => f(ev));
    const end = (id, e) => emit({ id, status: 'done', done: 1, total: 1, files: 1, failed: [], ...e });
    const Kurokawa = new Proxy({
      addListener: async (ev, fn) => { (ls[ev] = ls[ev] || []).push(fn); return { remove() { ls[ev] = ls[ev].filter((f) => f !== fn); } }; },
      filesRoots: async () => ({ allFiles: true, roots: [{ kind: 'app', path: '/storage/emulated/0/Download/Kurokawa', name: 'Kurokawa', readable: true, free: 12e9, total: 64e9 }, { kind: 'phone', path: '/storage/emulated/0', name: 'Phone', readable: true, free: 12e9, total: 64e9 }] }),
      filesList: async ({ path }) => { window.__lists.push(path); const ms = window.__delay[path] || 0; if (ms) await new Promise((r) => setTimeout(r, ms)); const e = listOf(path); return { exists: !!e, entries: e || [] }; },
      filesThumb: async () => ({ url: null }), filesCancel: async ({ id }) => { window.__calls.push('cancel:' + id); }, filesAccess: async () => ({ all: true }),
      filesRename: async ({ path, name }) => { window.__calls.push('rename:' + path.split('/').pop() + '>' + name); return { ok: true, path }; },
      filesJob: async ({ id, op, paths, dest }) => { window.__calls.push(op + ':' + paths.map((x) => x.split('/').pop()).join('|') + '>' + dest); const plan = window.__plan.shift() || {}; window.__lastJob = { id, paths }; setTimeout(() => { if (plan.conflict) emit({ id, status: 'conflict', from: paths[0], to: dest + '/' + paths[0].split('/').pop(), size: 1, existingSize: 1, mtime: 1, existingMtime: 2 }); else end(id, typeof plan.end === 'function' ? plan.end(paths) : plan.end); }, 60); return { id }; },
      filesAnswer: async ({ id, answer }) => { window.__calls.push('answer:' + answer); setTimeout(() => end(id, {}), 30); },
      filesTrash: async ({ paths }) => { window.__calls.push('trash:' + paths.length); return window.__trashFail ? { moved: [], failed: paths.map((x) => x.split('/').pop() + ': cannot make the bin'), failedPaths: paths } : { moved: paths, failed: [] }; },
      filesTrashList: async () => ({ items: [] }), filesTrashEmpty: async () => ({ n: 0 }),
      filesCollection: async () => ({ entries: [] }), filesStat: async ({ path }) => ({ name: path.split('/').pop(), path, exists: true, dir: true, size: 1, files: 1, folders: 0, mtime: 1, readable: true, writable: true }),
    }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: Kurokawa, Filesystem: {} }, PluginHeaders: [] };
    localStorage.setItem('kt.settings', JSON.stringify({ addons: ['files', 'archives'] }));
    if (!localStorage.getItem('kt.files.prefs')) localStorage.setItem('kt.files.prefs', JSON.stringify({ view: 'list', rememberLast: false }));
  });
  const names = () => p.$$eval('.files-pane-solo .files-row .files-name, .files-view:not(.files-pane) .files-row .files-name', (e) => e.map((x) => x.textContent));
  const calls = () => p.evaluate(() => window.__calls.slice());
  const pasteShown = () => p.$eval('.topbar-actions button[aria-label="Paste here"]', (e) => !e.hidden);
  const pasteClick = (pre = '') => p.click(pre + '.topbar-actions button[aria-label="Paste here"]', { timeout: 2000 }).catch(() => console.log('(Paste not there to click)'));
  const itemAct = async (name, act) => { await p.click(`.files-row:has-text("${name}") button[aria-label="More"]`); await p.click(`.sheet .dest-row:has-text("${act}")`); await p.waitForTimeout(150); };
  const goTo = async (dir) => { await p.goto('http://127.0.0.1:5483/#/files?p=' + encodeURIComponent(dir) + '&t=' + Date.now()); await p.waitForSelector('.files-row, .files-list .empty'); await p.waitForTimeout(200); };
  await goTo(K);
  // ---- 8. a copy stays on the clipboard: pasted again elsewhere
  await itemAct('Song.mp3', 'Copy'); await goTo(P); await pasteClick(); await p.waitForTimeout(400);
  ok('a copy pasted as a job', (await calls()).includes(`copy:Song.mp3>${P}`), await calls());
  ok('after a copy is pasted, Paste is still offered', await pasteShown());
  await p.click('.files-row:has-text("DCIM") .files-main'); await p.waitForSelector('.files-row:has-text("pic.jpg")'); await pasteClick(); await p.waitForTimeout(400);
  ok('… and a second paste copies it again', (await calls()).includes(`copy:Song.mp3>${P}/DCIM`), await calls());
  // a cut whose move was cancelled with the file still in place: still cut; a move that went through: the clipboard emptied
  await goTo(K); await itemAct('Song.mp3', 'Cut'); await goTo(P);
  await p.evaluate(() => { window.__plan.push({ end: (paths) => ({ status: 'cancelled', left: 1, remaining: paths }) }); });
  await pasteClick(); await p.waitForTimeout(500);
  ok('a cut whose move was cancelled stays on the clipboard', (await calls()).includes(`move:Song.mp3>${P}`) && await pasteShown());
  await p.click('.files-row:has-text("Music") .files-main'); await p.waitForTimeout(300);
  await p.evaluate(() => { window.__plan.push({ end: { status: 'done', left: 0, remaining: [] } }); });
  await pasteClick(); await p.waitForTimeout(500);
  ok('… pasted again, it moves; once moved, Paste is gone', (await calls()).includes(`move:Song.mp3>${P}/Music`) && !(await pasteShown()));
  // ---- 2. a folder cut, then its own inside: no Paste there (nor in the + sheet); a sibling sharing its prefix keeps it
  await goTo(K); await itemAct('Sub', 'Cut'); await p.click('.files-row:has-text("Sub") >> nth=0'); await p.waitForTimeout(300);
  ok('inside the cut folder Paste is not offered', !(await pasteShown()));
  await p.click('.files-fab'); await p.waitForSelector('.sheet'); ok('… nor in the + sheet', !(await p.$('.sheet .dest-row:has-text("Paste here")'))); await p.keyboard.press('Escape'); await p.waitForTimeout(250);
  await goTo(K + '/Subway'); ok('a sibling sharing the name\'s start (Sub → Subway) is offered Paste', await pasteShown());
  // ---- 3. the batch rename: extensions kept, clashes shown
  await goTo(K); await itemAct('README', 'Select'); await p.click('.files-selbar button[aria-label="Select all"]'); await p.waitForTimeout(100);
  await p.click('.files-selbar button[aria-label="More"]'); await p.click('.sheet .dest-row:has-text("Rename all")'); await p.waitForSelector('.files-preview-row');
  const preview = () => p.$$eval('.files-preview-row', (e) => Object.fromEntries(e.map((x) => [x.querySelector('small').textContent, x.querySelector('span').textContent])));
  let pv = await preview(); ok('the pattern {name} leaves every name as it was', Object.entries(pv).every(([a, b]) => a === b), pv);
  await p.fill('.sheet input[type=text] >> nth=0', '{name}_x'); await p.waitForTimeout(100); pv = await preview();
  ok('{name}_x keeps the last extension', pv['Show.S01E01.720p.mkv'] === 'Show.S01E01.720p_x.mkv' && pv['archive.tar.gz'] === 'archive.tar_x.gz' && pv['.gitignore'] === '.gitignore_x' && pv.README === 'README_x' && pv.Sub === 'Sub_x', pv);
  await p.fill('.sheet input[type=text] >> nth=0', 'X'); await p.waitForTimeout(100);
  ok('names that clash: Rename disabled, the clash told', await p.$eval('.sheet .btn.primary', (e) => e.disabled) && (await p.textContent('.sheet')).includes('Some new names are the same'));
  await p.fill('.sheet input[type=text] >> nth=0', 'x{n}'); await p.waitForTimeout(100); pv = await preview();
  ok('numbered: all different, the extensions kept', new Set(Object.values(pv).map((x) => x.toLowerCase())).size === Object.keys(pv).length && /^x\d\.mkv$/.test(pv['Show.S01E01.720p.mkv']) && !(await p.$eval('.sheet .btn.primary', (e) => e.disabled)), pv);
  await p.keyboard.press('Escape'); await p.waitForTimeout(250);
  // ---- a delete the bin cannot take: offered for good
  await goTo(K); await p.evaluate(() => { window.__trashFail = true; }); await itemAct('README', 'Delete'); await p.click('.sheet .btn.primary.danger'); await p.waitForTimeout(400);
  ok('the recycle bin refused: asked whether to delete for good', !!(await p.$('.sheet:has-text("could not go to the recycle bin")')), await p.$$eval('.sheet', (e) => e.map((x) => x.textContent)));
  await p.click('.sheet .btn.danger:has-text("Delete for good")').catch(() => {}); await p.waitForTimeout(300);
  ok('… and deleted for good when asked', (await calls()).includes('delete:README>undefined'), await calls());
  // ---- 7. two panes: one job's question asked once, by the pane that started it; the other pane read again at the end
  await p.setViewportSize({ width: 1100, height: 800 });
  await p.evaluate((k) => { const v = JSON.parse(localStorage.getItem('kt.files.prefs') || '{}'); v.dual = true; v.lastB = k; localStorage.setItem('kt.files.prefs', JSON.stringify(v)); }, P + '/DCIM');
  await p.goto('http://127.0.0.1:5483/#/files?p=' + encodeURIComponent(P) + '&t=' + Date.now()); await p.reload(); await p.waitForSelector('.files-pane[data-side="b"] .files-row:has-text("pic.jpg")'); await p.waitForTimeout(300);
  await p.evaluate(() => { window.__plan.push({ conflict: true }); });
  await p.click('.files-pane[data-side="a"] .files-row:has-text("readme.md") button[aria-label="More"]'); await p.click('.sheet .dest-row:has-text("Select")'); await p.waitForTimeout(150);
  await p.click('.files-pane[data-side="a"] .files-selbar button[aria-label="To the other pane"]'); await p.click('.sheet .dest-row:has-text("Copy")'); await p.waitForSelector('.files-compare'); await p.waitForTimeout(200);
  ok('two panes: the name-taken question asked once', (await p.$$('.files-compare')).length === 1, (await p.$$('.files-compare')).length);
  const before = await p.evaluate((x) => window.__lists.filter((l) => l === x).length, P);
  await p.click('.sheet .btn:has-text("Replace")'); await p.waitForTimeout(500);
  ok('… answered once; the job ran on', (await calls()).filter((c) => c.startsWith('answer:')).length === 1 && (await calls()).includes('answer:replace') && !(await calls()).some((c) => c.startsWith('cancel:')), await calls());
  ok('… and the other pane read its folder again at the end', (await p.evaluate((x) => window.__lists.filter((l) => l === x).length, P)) > before);
  // the question closed without an answer: the job is cancelled, not left waiting
  await p.evaluate(() => { window.__plan.push({ conflict: true }); });
  await p.click('.files-pane[data-side="a"] .files-row:has-text("readme.md") button[aria-label="More"]'); await p.click('.sheet .dest-row:has-text("Select")'); await p.waitForTimeout(150);
  await p.click('.files-pane[data-side="a"] .files-selbar button[aria-label="To the other pane"]'); await p.click('.sheet .dest-row:has-text("Copy")'); await p.waitForSelector('.files-compare'); await p.waitForTimeout(200);
  await p.click('.sheet:has(.files-compare) .sheet-head button'); await p.waitForTimeout(400);
  ok('the name-taken question closed unanswered cancels its job', (await calls()).includes('cancel:' + (await p.evaluate(() => window.__lastJob.id))), await calls());
  // a folder sent into the other pane that shows its inside: refused before any job
  await p.click('.files-pane[data-side="a"] .files-row:has-text("DCIM") button[aria-label="More"]'); await p.click('.sheet .dest-row:has-text("Select")'); await p.waitForTimeout(150);
  await p.click('.files-pane[data-side="a"] .files-selbar button[aria-label="To the other pane"]'); await p.click('.sheet .dest-row:has-text("Move")'); await p.waitForTimeout(400);
  ok('a folder into the pane showing its inside: refused with a word, no job', !(await calls()).some((c) => c.startsWith('move:DCIM')) && /cannot be pasted into itself/.test(await p.textContent('.toast').catch(() => '')), await calls());
  // ---- 4. a late listing (two panes, where a pane goes its own way without a new page): Music asked first (slow),
  // Kurokawa after (fast) — Kurokawa stays drawn, and a paste there goes to Kurokawa
  await p.click('.files-pane[data-side="a"] .files-selbar button[aria-label="Close"]').catch(() => {}); await p.waitForTimeout(150);
  await p.click('.files-pane[data-side="a"] .files-row:has-text("readme.md") button[aria-label="More"]'); await p.click('.sheet .dest-row:has-text("Copy")'); await p.waitForTimeout(150);
  await p.evaluate((x) => { window.__delay[x] = 700; }, P + '/Music');
  await p.click('.files-pane[data-side="a"] .files-row:has-text("Music") .files-main'); await p.waitForTimeout(30); await p.click('.files-pane[data-side="a"] .files-roots .chip:nth-child(1)'); await p.waitForTimeout(1200);
  const rowsA = await p.$$eval('.files-pane[data-side="a"] .files-row .files-name', (e) => e.map((x) => x.textContent));
  ok('a late listing does not cover the newer folder', rowsA.includes('Song.mp3') && !rowsA.includes('tune.mp3'), rowsA);
  await pasteClick('.files-pane[data-side="a"] '); await p.waitForTimeout(400);
  ok('… and the paste goes to the folder shown', (await calls()).includes(`copy:readme.md>${K}`), await calls());
  ok('no page errors', !errors.length); if (errors.length) console.log(errors);
  await b.close(); server.close(); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
