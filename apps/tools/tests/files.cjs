// The Files add-on against a pretend phone: the plugin's files methods answered from an in-memory tree — the
// storages and breadcrumbs drawn, sorting, the kind filter, the search, the selection and its bar, copy then
// paste as a job with its progress and a name taken (the question answered), rename, new folder, properties,
// and «Save to device». Run: NODE_PATH=$(npm root -g) node tests/files.cjs
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.join(__dirname, '..', 'dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (what, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + what); if (!cond) fails++; };
(async () => {
  await new Promise((r) => server.listen(5481, r));
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 412, height: 900 }, deviceScaleFactor: 1 });
  const errors = []; p.on('pageerror', (e) => errors.push(String(e))); p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await p.addInitScript(() => {
    // the pretend phone
    const tree = { '/storage/emulated/0/Download/Kurokawa': { 'Movie.mkv': 734003200, 'Song.mp3': 5000000, 'notes.txt': 1200, 'photo.jpg': 2500000, 'pack.zip': 90000, 'app.apk': 30000000, Sub: {} }, '/storage/emulated/0': { DCIM: {}, Music: {}, 'readme.md': 300 } };
    const listOf = (dir) => { const d = tree[dir]; if (!d) return null; return Object.entries(d).map(([name, v]) => ({ name, path: `${dir}/${name}`, dir: typeof v === 'object', size: typeof v === 'object' ? 0 : v, mtime: 1760000000000 + name.length * 86400000, ext: typeof v === 'object' ? undefined : name.split('.').pop(), count: typeof v === 'object' ? 0 : undefined })); };
    const ls = {}; window.__calls = [];
    const Kurokawa = new Proxy({
      addListener: async (ev, fn) => { (ls[ev] = ls[ev] || []).push(fn); return { remove() { ls[ev] = ls[ev].filter((f) => f !== fn); } }; },
      filesRoots: async () => ({ allFiles: true, roots: [{ kind: 'app', path: '/storage/emulated/0/Download/Kurokawa', name: 'Kurokawa', readable: true, free: 12e9, total: 64e9 }, { kind: 'phone', path: '/storage/emulated/0', name: 'Phone', readable: true, free: 12e9, total: 64e9 }] }),
      filesList: async ({ path }) => { const e = listOf(path); return { exists: !!e, entries: e || [] }; },
      filesThumb: async () => ({ url: null }),
      filesStat: async ({ path }) => ({ name: path.split('/').pop(), path, exists: true, dir: true, size: 123456789, files: 6, folders: 1, mtime: 1760000000000, readable: true, writable: true }),
      filesRename: async ({ path, name }) => { window.__calls.push('rename:' + name); const dir = path.replace(/\/[^/]*$/, ''); const base = path.split('/').pop(); tree[dir][name] = tree[dir][base]; delete tree[dir][base]; return { ok: true, path: dir + '/' + name }; },
      filesMkdir: async ({ path }) => { window.__calls.push('mkdir'); const dir = path.replace(/\/[^/]*$/, ''); tree[dir][path.split('/').pop()] = {}; tree[path] = {}; return { ok: true, path }; },
      filesJob: async ({ id, op, paths, dest }) => { window.__calls.push(op + ':' + paths.length + '>' + dest); setTimeout(() => { (ls.files || []).forEach((f) => f({ id, status: 'progress', done: 50, total: 100, files: 0, ofFiles: 1, name: 'Song.mp3' })); (ls.files || []).forEach((f) => f({ id, status: 'conflict', from: paths[0], to: dest + '/' + paths[0].split('/').pop(), size: 5000000, existingSize: 5000000, mtime: 1, existingMtime: 2 })); }, 50); return { id }; },
      filesAnswer: async ({ id, answer }) => { window.__calls.push('answer:' + answer); setTimeout(() => (ls.files || []).forEach((f) => f({ id, status: 'done', done: 100, total: 100, files: 1, failed: [] })), 30); },
      filesCancel: async () => {}, filesAccess: async () => ({ all: true }),
      sharedPending: async () => ({ items: [{ uri: 'content://x/1', name: 'shared.pdf', size: 42000, mime: 'application/pdf' }] }), sharedSave: async ({ dir }) => { window.__calls.push('sharedSave:' + dir); return { saved: ['x'], failed: [], dir }; }, sharedClear: async () => {},
      openChooser: async ({ path }) => { window.__calls.push('open:' + path.split('/').pop()); }, openWith: async ({ mime }) => { window.__calls.push('openWith:' + mime); }, shareFile: async () => { window.__calls.push('share'); },
      filesHead: async () => ({ text: 'hello notes', size: 11 }),
    }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: Kurokawa, Filesystem: {} }, PluginHeaders: [] };
    localStorage.setItem('kt.settings', JSON.stringify({ addons: ['files', 'archives'] }));
  });
  await p.goto('http://localhost:5481/#/files'); await p.waitForSelector('.files-view'); await p.waitForTimeout(700);
  ok('the storages are drawn', (await p.$$('.files-roots .chip')).length === 2);
  ok('the app folder is listed, folders first', (await p.$$eval('.files-row .files-name', (e) => e.map((x) => x.textContent))).join(',') === 'Sub,app.apk,Movie.mkv,notes.txt,pack.zip,photo.jpg,Song.mp3');
  await p.screenshot({ path: '/tmp/claude-0/-home-claude/31db5f1c-a6c2-54e2-a5c4-2730cae2d727/scratchpad/files-list.png' });
  // sort by size, turned round
  await p.click('.topbar-actions button[aria-label]:nth-of-type(4)'); await p.waitForSelector('.sheet'); await p.click('.sheet .dest-row:nth-child(3)'); await p.waitForTimeout(200); await p.click('.topbar-actions button[aria-label]:nth-of-type(4)'); await p.click('.sheet .dest-row:nth-child(3)'); await p.waitForTimeout(200);
  ok('sorted by size, biggest first', (await p.$$eval('.files-row .files-name', (e) => e.map((x) => x.textContent))).slice(0, 2).join(',') === 'Sub,Movie.mkv');
  // kind filter
  await p.click('.files-kinds .chip:nth-child(3)'); await p.waitForTimeout(150);
  ok('the Music chip keeps the song (and folders)', (await p.$$eval('.files-row .files-name', (e) => e.map((x) => x.textContent))).join(',') === 'Sub,Song.mp3');
  await p.click('.files-kinds .chip:nth-child(1)'); await p.waitForTimeout(150);
  // search within
  await p.click('.topbar-actions button[aria-label]:nth-of-type(1)'); await p.fill('.files-search', 'mo'); await p.waitForTimeout(150);
  ok('the search narrows', (await p.$$eval('.files-row .files-name', (e) => e.map((x) => x.textContent))).join(',') === 'Movie.mkv');
  await p.fill('.files-search', ''); await p.waitForTimeout(150);
  // open a text file: the quick look
  await p.click('.files-row:has-text("notes.txt")'); await p.waitForSelector('.files-look'); ok('a text file is looked at in the app', (await p.textContent('.files-text')).includes('hello notes')); await p.click('.sheet .sheet-head button[aria-label="Close"]'); await p.waitForTimeout(300);
  // a folder opened: breadcrumbs
  await p.click('.files-row:has-text("Sub")'); await p.waitForTimeout(300);
  ok('breadcrumbs follow', (await p.$$eval('.files-crumbs .crumb', (e) => e.map((x) => x.textContent))).join('/') === 'Kurokawa/Sub');
  await p.click('.files-crumbs .crumb:first-child'); await p.waitForTimeout(300);
  // selection by a long press: the bar
  const row = await p.$('.files-row:has-text("Song.mp3")'); const bb = await row.boundingBox(); await p.mouse.move(bb.x + 40, bb.y + 20); await p.mouse.down(); await p.waitForTimeout(650); await p.mouse.up(); await p.waitForTimeout(200);
  ok('held: the selection bar shows one', !(await p.$eval('.files-selbar', (e) => e.hidden)) && /1/.test(await p.textContent('.files-selcount')));
  await p.screenshot({ path: '/tmp/claude-0/-home-claude/31db5f1c-a6c2-54e2-a5c4-2730cae2d727/scratchpad/files-select.png' });
  // copy, go to Phone, paste: the job, the conflict, replace
  await p.click('.files-selbar button[aria-label="Copy"]'); await p.waitForTimeout(200); await p.click('.files-roots .chip:nth-child(2)'); await p.waitForTimeout(300); await p.click('.topbar-actions button[aria-label="Paste here"]'); await p.waitForSelector('.files-compare', { timeout: 3000 });
  await p.screenshot({ path: '/tmp/claude-0/-home-claude/31db5f1c-a6c2-54e2-a5c4-2730cae2d727/scratchpad/files-conflict.png' });
  await p.click('.sheet .btn:has-text("Replace")'); await p.waitForTimeout(300);
  ok('copied then pasted as a job, the name taken answered', (await p.evaluate(() => window.__calls.join(','))).includes('copy:1>/storage/emulated/0') && (await p.evaluate(() => window.__calls.join(','))).includes('answer:replace'));
  // new folder, rename
  await p.click('.topbar-actions button[aria-label="More"]'); await p.click('.sheet .dest-row:has-text("New folder")'); await p.fill('.sheet input[type=text]', 'Stuff'); await p.click('.sheet .btn:has-text("Create")'); await p.waitForTimeout(300);
  ok('a folder made', (await p.evaluate(() => window.__calls.join(','))).includes('mkdir') && (await p.$$eval('.files-row .files-name', (e) => e.map((x) => x.textContent))).includes('Stuff'));
  await p.click('.files-row:has-text("readme.md") button[aria-label="More"]'); await p.click('.sheet .dest-row:has-text("Rename")'); await p.fill('.sheet input[type=text]', 'README.md'); await p.click('.sheet .btn:has-text("Rename")'); await p.waitForTimeout(300);
  ok('renamed', (await p.evaluate(() => window.__calls.join(','))).includes('rename:README.md'));
  // properties, open as
  await p.click('.files-row:has-text("README.md") button[aria-label="More"]'); await p.click('.sheet .dest-row:has-text("Properties")'); await p.waitForTimeout(300); ok('properties count the folder', (await p.textContent('.files-props')).includes('6 files')); await p.click('.sheet .sheet-head button[aria-label="Close"]'); await p.waitForTimeout(300);
  await p.click('.files-row:has-text("README.md") button[aria-label="More"]'); await p.click('.sheet .dest-row:has-text("Open as")'); await p.click('.sheet .dest-row:has-text("Video")'); await p.waitForTimeout(200);
  ok('open as a kind', (await p.evaluate(() => window.__calls.join(','))).includes('openWith:video/*'));
  // Save to device
  await p.goto('http://localhost:5481/#/files?save=1'); await p.waitForSelector('.sheet:has-text("shared.pdf")'); await p.click('.sheet .btn:has-text("Save here")'); await p.waitForTimeout(300);
  ok('shared files saved here', (await p.evaluate(() => window.__calls.join(','))).includes('sharedSave:'));
  ok('no page errors', !errors.length); if (errors.length) console.log(errors);
  await b.close(); server.close(); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
