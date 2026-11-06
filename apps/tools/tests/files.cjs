// The Files add-on against a pretend phone: the plugin's files methods answered from an in-memory tree — the
// storages and breadcrumbs drawn, sorting, the kind filter, the search, the selection and its bar, copy then
// paste as a job with its progress and a name taken (the question answered), rename, new folder, properties,
// and «Save to device». Run: NODE_PATH=$(npm root -g) node tests/files.cjs
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.join(__dirname, '..', 'dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (what, cond, x) => { console.log((cond ? 'ok   ' : 'FAIL ') + what + (cond || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!cond) fails++; };
(async () => {
  await new Promise((r) => server.listen(5481, r));
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 412, height: 900 }, deviceScaleFactor: 1 });
  const errors = []; p.on('pageerror', (e) => errors.push(String(e))); p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await p.addInitScript(() => {
    // the pretend phone
    const tree = { '/storage/emulated/0/Download/Kurokawa': { 'Movie.mkv': 734003200, 'Song.mp3': 5000000, 'notes.txt': 1200, 'photo.jpg': 2500000, 'pack.zip': 90000, 'app.apk': 30000000, Sub: {} }, '/storage/emulated/0': { DCIM: {}, Music: {}, 'readme.md': 300 } };
    const listOf = (dir) => { const d = tree[dir]; if (!d) return null; return Object.entries(d).map(([name, v]) => ({ name, path: `${dir}/${name}`, dir: typeof v === 'object', size: typeof v === 'object' ? 0 : v, mtime: 1760000000000 + name.length * 86400000, ext: typeof v === 'object' ? undefined : name.split('.').pop(), count: typeof v === 'object' ? 0 : undefined })); };
    const ls = {}; window.__calls = [];
    const Kurokawa = new Proxy({
      addListener: async (ev, fn) => { (ls[ev] = ls[ev] || []).push(fn); return { remove() { ls[ev] = ls[ev].filter((f) => f !== fn); } }; },
      // a network storage: one SFTP connection whose host key is new (asked once), two folders, a download job
      remoteConnections: async () => ({ list: [{ id: 'nas', kind: 'sftp', name: 'NAS', host: '192.168.1.5', port: 22, path: '/', user: 'kuro', hasPass: true }] }),
      remoteTrust: async ({ fingerprint }) => { window.__trusted = fingerprint; },
      remoteList: async ({ id, path }) => { if (!window.__trusted) throw new Error('hostkey:AB:CD:EF:01:23:45:67:89:ssh-ed25519'); if (path === '/') return { entries: [{ name: 'backup', dir: true, size: 0, mtime: 1760000000000 }, { name: 'iso.img', dir: false, size: 4e9, mtime: 1760000000000 }] }; return { entries: [{ name: 'old.tar', dir: false, size: 1e6, mtime: 1760000000000 }] }; },
      remoteJob: async ({ id, op, conn, paths, dest }) => { window.__calls.push(op + ':' + conn + ':' + paths.join('|') + '>' + dest); setTimeout(() => { (ls.files || []).forEach((f) => f({ id, status: 'done', done: 4e9, total: 4e9, files: 1, failed: [] })); }, 50); return { id }; },
      remoteCancel: async () => {}, remoteSave: async () => ({ id: 'nas' }), remoteRemove: async () => {}, remoteScanStop: async () => {},
      // an archive: listed as a tree the browser walks; a picture inside streamed; a file taken out to the cache
      archiveList: async ({ path }) => { window.__calls.push('arcList:' + path); return { format: 'zip', total: 3, encrypted: false, inPlaceOk: true, entries: [{ path: 'docs/readme.txt', size: 100, dir: false }, { path: 'pics/a.jpg', size: 2000, dir: false }, { path: 'pics/b.png', size: 3000, dir: false }, { path: 'clip.mp4', size: 50000, dir: false }] }; },
      // installed apps: two user apps, one with splits; the app's folder lists its APKs and data folder
      appsList: async ({ system }) => ({ apps: [{ pkg: 'org.example.notes', name: 'Notes', version: '2.1', versionCode: 21, size: 5e6, system: false, installedAt: 1750000000000, updatedAt: 1760000000000, splits: 0, enabled: true }, { pkg: 'org.example.game', name: 'Game', version: '1.0', versionCode: 1, size: 9e7, system: false, installedAt: 1750000000000, updatedAt: 1760000000000, splits: 2, enabled: true }, ...(system ? [{ pkg: 'com.android.settings', name: 'Settings', version: '14', versionCode: 34, size: 1e7, system: true, installedAt: 0, updatedAt: 0, splits: 0, enabled: true }] : [])] }),
      appsIcon: async () => ({ url: null }), appsAct: async () => {},
      appsDetail: async ({ pkg }) => ({ pkg, name: pkg === 'org.example.game' ? 'Game' : 'Notes', version: '1.0', apks: [{ name: 'base.apk', path: `/data/app/${pkg}/base.apk`, size: 4e7, mtime: 1760000000000 }, ...(pkg === 'org.example.game' ? [{ name: 'split_config.arm64_v8a.apk', path: `/data/app/${pkg}/split_config.arm64_v8a.apk`, size: 2e7, mtime: 1760000000000 }] : [])], data: `/storage/emulated/0/Android/data/${pkg}`, dataExists: true, dataReadable: false, obb: `/storage/emulated/0/Android/obb/${pkg}`, obbExists: pkg === 'org.example.game', obbReadable: true, media: '', mediaExists: false, nativeLibs: '', system: false, installedAt: 0, updatedAt: 1760000000000, installer: 'com.android.vending' }),
      archiveEntryUrl: async ({ entry }) => ({ url: 'http://127.0.0.1:1/arc/x/' + entry }), archiveThumb: async () => ({ url: null }),
      archiveExtract: async ({ id, only }) => { window.__calls.push('arcExtract:' + (only || []).join('|')); return { files: 1, dest: '/cache/arc' }; },
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
      filesHead: async () => ({ text: 'hello notes', size: 11 }), filesWrite: async ({ path }) => { window.__calls.push('write:' + path.split('/').pop()); return { size: 1 }; },
      filesSearch: async ({ path, q }) => { window.__calls.push('search:' + q + '@' + path); return { entries: [{ name: 'Movie.mkv', path: '/storage/emulated/0/Download/Kurokawa/Movie.mkv', dir: false, size: 734003200, mtime: Date.now() - 3600000, ext: 'mkv' }, { name: 'notes.txt', path: '/storage/emulated/0/Download/Kurokawa/notes.txt', dir: false, size: 1200, mtime: Date.now() - 86400000 * 40, ext: 'txt' }] }; },
      filesTrash: async ({ paths }) => { window.__calls.push('trash:' + paths.length); return { moved: paths, failed: [] }; }, filesTrashList: async () => ({ items: [{ slot: '/s/1', name: 'gone.txt', from: '/storage/emulated/0/gone.txt', at: Date.now(), dir: false, size: 5, path: '/s/1/gone.txt', exists: true }] }), filesTrashRestore: async () => { window.__calls.push('restore'); return { path: '/x' }; }, filesTrashEmpty: async () => ({ n: 1 }),
      filesMeta: async () => ({ exif: { make: 'Canon', model: 'EOS', aperture: '2.8', exposure: '0.004', iso: '100', width: 4000, height: 3000, lat: 24.7, lon: 46.7 } }), hashFile: async () => ({ md5: 'a'.repeat(32), sha1: 'b'.repeat(40), sha256: 'c'.repeat(64), size: 1 }),
      filesAnalyze: async () => ({ total: 1e9, files: 3, largest: [{ name: 'big.mkv', path: '/storage/emulated/0/Movies/big.mkv', size: 9e8, mtime: 1, dir: false, ext: 'mkv' }], old: [], screenshots: [], screenshotsSize: 0, screenshotsCount: 0, temp: [{ name: 'x.part', path: '/storage/emulated/0/x.part', size: 100, mtime: 1, dir: false, ext: 'part' }], tempSize: 100, tempCount: 1, apks: [], duplicates: [{ size: 500, files: [{ name: 'a.jpg', path: '/a.jpg', size: 500, mtime: 1, dir: false, ext: 'jpg' }, { name: 'b.jpg', path: '/b.jpg', size: 500, mtime: 1, dir: false, ext: 'jpg' }] }], duplicatesSize: 500, kinds: [{ kind: 'video', size: 9e8, count: 1 }, { kind: 'other', size: 1e8, count: 2 }], folders: [{ path: '/storage/emulated/0/Movies', size: 9e8, count: 1 }] }), filesAnalyzeStop: async () => {},
      archiveCreate: async (o) => { window.__calls.push('make:' + o.out.split('/').pop() + ':' + (o.format || 'zip') + ':' + o.level + (o.password ? ':pw' : '')); return { files: 1, path: o.out, size: 10 }; }, localUrl: async ({ path }) => ({ url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' }), filesWallpaper: async () => { window.__calls.push('wallpaper'); },
      filesCollection: async ({ kind }) => ({ entries: kind === 'recent' ? [{ name: 'new.png', path: '/storage/emulated/0/DCIM/new.png', dir: false, size: 100, mtime: Date.now() - 1000, ext: 'png' }, { name: 'old.mp4', path: '/storage/emulated/0/Movies/old.mp4', dir: false, size: 900, mtime: Date.now() - 86400000 * 3, ext: 'mp4' }] : [] }),
    }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: Kurokawa, Filesystem: {} }, PluginHeaders: [] };
    localStorage.setItem('kt.settings', JSON.stringify({ addons: ['files', 'archives'] }));
  });
  await p.goto('http://localhost:5481/#/files'); await p.waitForSelector('.files-view'); await p.waitForTimeout(700);
  ok('the storages are drawn', (await p.$$('.files-roots .chip')).length === 2);
  ok('the app folder is listed, folders first', (await p.$$eval('.files-row .files-name', (e) => e.map((x) => x.textContent))).join(',') === 'Sub,app.apk,Movie.mkv,notes.txt,pack.zip,photo.jpg,Song.mp3', (await p.$$eval('.files-row .files-name', (e) => e.map((x) => x.textContent))).join(','));
  await p.screenshot({ path: '/tmp/claude-0/-home-claude/31db5f1c-a6c2-54e2-a5c4-2730cae2d727/scratchpad/files-list.png' });
  // sort by size, turned round
  await p.click('.topbar-actions button[aria-label="Sort by"]'); await p.waitForSelector('.sheet'); await p.click('.sheet .dest-row:nth-child(3)'); await p.waitForTimeout(200); await p.click('.topbar-actions button[aria-label="Sort by"]'); await p.click('.sheet .dest-row:nth-child(3)'); await p.waitForTimeout(200);
  ok('sorted by size, biggest first', (await p.$$eval('.files-row .files-name', (e) => e.map((x) => x.textContent))).slice(0, 2).join(',') === 'Sub,Movie.mkv');
  // kind filter
  await p.click('.files-kinds .chip:nth-child(3)'); await p.waitForTimeout(150);
  ok('the Music chip keeps the song (and folders)', (await p.$$eval('.files-row .files-name', (e) => e.map((x) => x.textContent))).join(',') === 'Sub,Song.mp3');
  await p.click('.files-kinds .chip:nth-child(1)'); await p.waitForTimeout(150);
  // search within
  await p.click('.topbar-actions button[aria-label="Filter this folder"]'); await p.fill('.files-search', 'mo'); await p.waitForTimeout(150);
  ok('the search narrows', (await p.$$eval('.files-row .files-name', (e) => e.map((x) => x.textContent))).join(',') === 'Movie.mkv');
  await p.fill('.files-search', ''); await p.waitForTimeout(150);
  // open a text file: the quick look
  await p.click('.files-row:has-text("notes.txt")'); await p.waitForSelector('.files-editor'); ok('a text file opens in the editor', (await p.inputValue('.files-ta')).includes('hello notes'));
  await p.fill('.files-ta', 'hello notes edited'); await p.click('.files-editor .btn:has-text("Save")'); await p.waitForTimeout(200); ok('the editor saves', (await p.evaluate(() => window.__calls.join(','))).includes('write:notes.txt'));
  await p.click('.sheet .sheet-head button[aria-label="Close"]'); await p.waitForTimeout(300);
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
  // the drawer and a collection with its day sections
  await p.click('.topbar button[aria-label="Storages, bookmarks and collections"]'); await p.waitForSelector('.files-drawer'); ok('the drawer lists storages, collections', (await p.$$('.files-drawer .files-drawer-row')).length >= 9 && (await p.textContent('.files-drawer')).includes('free of'));
  await p.click('.files-drawer .files-drawer-row:has-text("Recent files")'); await p.waitForTimeout(400);
  ok('recent files in day sections', (await p.$$eval('.files-section', (e) => e.map((x) => x.textContent)))[0] === 'Today' && (await p.$$('.files-section')).length === 2 && (await p.textContent('.files-sub')).includes('2 files'));
  await p.screenshot({ path: '/tmp/claude-0/-home-claude/31db5f1c-a6c2-54e2-a5c4-2730cae2d727/scratchpad/files-recent.png' });
  // the analyzer
  await p.click('.topbar button[aria-label="Storages, bookmarks and collections"]'); await p.click('.files-drawer .files-drawer-row:has-text("Storage analyzer")'); await p.click('.sheet:not(.files-drawer) .dest-row:has-text("Phone")'); await p.waitForSelector('.files-an-tabs'); await p.waitForTimeout(300);
  ok('the analyzer reports by kind', (await p.textContent('.files-kinds-bars')).includes('Video'));
  await p.click('.files-an-tabs .chip:has-text("Doubles")'); await p.waitForTimeout(200); ok('doubles: all but the first ticked', (await p.$$eval('.files-dup-group input', (e) => e.map((x) => x.checked))).join() === 'false,true');
  await p.click('.files-an-tabs .chip:has-text("Biggest folders")'); await p.click('.files-analyzer .dest-row:has-text("Movies")'); await p.waitForTimeout(600); ok('a folder from the report is opened', (await p.textContent('.files-crumbs')).toLowerCase().includes('movies'), await p.textContent('.files-crumbs'));
  // the network: the connection in the drawer; its new host key asked about once; a remote file copied into the phone as a download job
  await p.click('.sheet-head button[aria-label="Close"]').catch(() => {});
  await p.click('.topbar button[aria-label="Storages, bookmarks and collections"]'); await p.waitForSelector('.files-drawer'); ok('the network connection is in the drawer', !!(await p.$('.files-drawer .files-drawer-row:has-text("NAS")')));
  await p.click('.files-drawer .files-drawer-row:has-text("NAS")'); await p.waitForSelector('.remote-fp'); ok('a new host key is put to the reader', (await p.textContent('.remote-fp')).includes('AB:CD:EF'));
  await p.click('.sheet .btn.primary'); await p.waitForSelector('.files-row:has-text("iso.img")'); ok('the server is listed after the trust', (await p.$$eval('.files-row .files-name', (e) => e.map((x) => x.textContent))).join(',') === 'backup,iso.img');
  await p.click('.files-row:has-text("iso.img") button[aria-label="More"]'); await p.click('.sheet .dest-row:nth-child(2)'); await p.waitForTimeout(200);
  await p.click('.topbar button[aria-label="Storages, bookmarks and collections"]'); await p.click('.files-drawer .files-drawer-row:has-text("Kurokawa")'); await p.waitForSelector('.files-row:has-text("Movie.mkv")');
  await p.click('.topbar button[aria-label="Paste here"]'); await p.waitForTimeout(400);
  ok('pasting a remote file here is a download job', (await p.evaluate(() => window.__calls)).includes('down:nas:/iso.img>/storage/emulated/0/Download/Kurokawa'), await p.evaluate(() => window.__calls.slice(-2)));
  // two panes on a wide screen: turned on from the menu, each with its own place; a selection sent across as a copy job
  await p.click('.sheet-head button[aria-label="Close"]').catch(() => {});
  await p.setViewportSize({ width: 1100, height: 800 }); await p.goto('http://127.0.0.1:5481/#/files?p=%2Fstorage%2Femulated%2F0'); await p.waitForSelector('.files-row');
  await p.click('.topbar button[aria-label="More"]'); await p.click('.sheet .dest-row:has-text("Two panes")'); await p.waitForSelector('.files-dual'); await p.waitForTimeout(400);
  ok('two panes drawn', (await p.$$('.files-dual .files-pane')).length === 2);
  await p.click('.files-pane[data-side="b"] .files-row:has-text("DCIM")'); await p.waitForTimeout(400);
  ok('the second pane went its own way', (await p.textContent('.files-pane[data-side="b"] .files-crumbs')).toLowerCase().includes('dcim') && !(await p.textContent('.files-pane[data-side="a"] .files-crumbs')).toLowerCase().includes('dcim'));
  await p.click('.files-pane[data-side="a"] .files-row:has-text("readme.md") button[aria-label="More"]'); await p.click('.sheet .dest-row:has-text("Select")'); await p.waitForTimeout(200);
  await p.click('.files-pane[data-side="a"] .files-selbar button[aria-label="To the other pane"]'); await p.click('.sheet .dest-row:has-text("Copy")'); await p.waitForTimeout(600);
  ok('sent to the other pane: a copy job into DCIM', (await p.evaluate(() => window.__calls)).includes('copy:1>/storage/emulated/0/DCIM'), await p.evaluate(() => window.__calls.slice(-3)));
  await p.screenshot({ path: '/tmp/claude-0/-home-claude/31db5f1c-a6c2-54e2-a5c4-2730cae2d727/scratchpad/files-dual.png' });
  // an archive entered as a folder: crumbs name it, its folders open, a picture inside opens the viewer, a sub-folder's crumb leads back
  await p.setViewportSize({ width: 412, height: 900 }); await p.goto('http://127.0.0.1:5481/#/files?p=%2Fstorage%2Femulated%2F0%2FDownload%2FKurokawa'); await p.waitForSelector('.files-row:has-text("pack.zip")'); await p.waitForTimeout(300);
  await p.click('.files-row:has-text("pack.zip") .files-main'); await p.waitForSelector('.files-row:has-text("docs")', { timeout: 5000 });
  ok('the zip opened as a folder (its root listed)', (await p.$$eval('.files-row .files-name', (e) => e.map((x) => x.textContent))).join(',') === 'docs,pics,clip.mp4' && (await p.textContent('.files-crumbs')).includes('pack.zip'));
  await p.click('.files-row:has-text("pics") .files-main'); await p.waitForSelector('.files-row:has-text("a.jpg")');
  ok('a folder inside the zip entered, the crumbs follow', (await p.textContent('.files-crumbs')).includes('pics'));
  await p.click('.files-row:has-text("a.jpg") .files-main'); await p.waitForSelector('.files-viewer', { timeout: 5000 });
  ok('a picture inside the zip opens in the viewer, counted among its neighbours', (await p.textContent('.files-viewer')).includes('/ 2'));
  await p.keyboard.press('Escape'); await p.waitForTimeout(200);
  await p.click('.files-crumbs .crumb:has-text("pack.zip")'); await p.waitForSelector('.files-row:has-text("docs")'); ok('the crumb returns to the zip root', (await p.$$('.files-row')).length === 3);
  // the installed apps as a place: listed from the drawer, an app entered shows its APKs and folders, its sheet offers the backup
  await p.click('.topbar button[aria-label="Storages, bookmarks and collections"]'); await p.waitForSelector('.files-drawer'); await p.click('.files-drawer .files-drawer-row:has-text("Installed apps")'); await p.waitForSelector('.files-row:has-text("Game")', { timeout: 8000 });
  ok('the apps are listed with their packages', (await p.textContent('.files-row:has-text("Game")')).includes('org.example.game'));
  await p.click('.files-row:has-text("Game") .files-main'); await p.waitForSelector('.files-row:has-text("base.apk")');
  ok("an app's folder: its APKs, data and obb", (await p.$$eval('.files-row .files-name', (e) => e.map((x) => x.textContent))).join(',').includes('base.apk,split_config.arm64_v8a.apk') && (await p.textContent('.files-crumbs')).includes('Apps'));
  await p.click('.files-crumbs .crumb:has-text("Apps")'); await p.waitForSelector('.files-row:has-text("Notes")');
  await p.click('.files-row:has-text("Notes") button[aria-label="More"]'); await p.waitForSelector('.sheet .dest-row:has-text("Back up")', { timeout: 5000 });
  ok("an app's sheet offers backup, launch, info, uninstall", (await p.$$('.sheet .dest-row')).length >= 6); await p.keyboard.press('Escape'); await p.waitForTimeout(200);
  // a place an older version saved as «apps:» opens as the installed apps; Back from an app's folder goes up to «apps://»
  await p.evaluate(() => { const k = 'kt.files.prefs'; const v = JSON.parse(localStorage.getItem(k) || '{}'); v.last = 'apps:'; v.rememberLast = true; localStorage.setItem(k, JSON.stringify(v)); });
  await p.goto('http://127.0.0.1:5481/#/videos'); await p.goto('http://127.0.0.1:5481/#/files'); await p.waitForSelector('.files-row:has-text("Game")', { timeout: 8000 }).catch(() => undefined);
  ok('a saved «apps:» is mended to the installed apps', !!(await p.$('.files-row:has-text("Game")')));
  await p.evaluate(() => { const k = 'kt.files.prefs'; const v = JSON.parse(localStorage.getItem(k) || '{}'); v.last = 'apps://org.example.game'; v.backUp = true; localStorage.setItem(k, JSON.stringify(v)); });
  await p.goto('http://127.0.0.1:5481/#/videos'); await p.goto('http://127.0.0.1:5481/#/files'); await p.waitForSelector('.files-row:has-text("base.apk")', { timeout: 8000 }).catch(() => undefined);
  await p.keyboard.press('Escape'); await p.waitForSelector('.files-row:has-text("Notes")', { timeout: 5000 }).catch(() => undefined);
  ok("Back from an app's folder lists the apps again", !!(await p.$('.files-row:has-text("Notes")')) && !(await p.textContent('.files-view')).includes('Nothing here'));
  // recent files in the drawer
  await p.click('.topbar button[aria-label="Storages, bookmarks and collections"]'); await p.waitForSelector('.files-drawer'); await p.waitForTimeout(300);
  ok("recent files sit in the drawer", !!(await p.$(".files-drawer .files-drawer-row:has-text(\"new.png\")")));
  await p.keyboard.press('Escape');
  // the drawer from the side: a finger swiped from the start side opens it; swiped back, it closes
  await p.goto('http://127.0.0.1:5481/#/files?p=%2Fstorage%2Femulated%2F0%2FDownload%2FKurokawa'); await p.waitForSelector('.files-row:has-text("photo.jpg")');
  // (A real finger, through Chromium's touch handling — scrolling and all —, not made-up events: a little up and down
  // on the way, as a thumb does.)
  const cdp = await p.context().newCDPSession(p); await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 }); await cdp.send('Emulation.setEmitTouchEventsForMouse', { enabled: false });
  const swipe = async (_sel, x0, x1, y = 400) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] });
    for (let k = 1; k <= 10; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + ((x1 - x0) * k) / 10, y: y + (k % 3) * 6 }] }); await p.waitForTimeout(16); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  await swipe('.files-view', 20, 260); await p.waitForTimeout(900);
  const side = await p.evaluate(() => { const d = document.querySelector('.sheet.files-drawer'); if (!d) return null; const r = d.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), h: Math.round(r.height), side: d.classList.contains('side-drawer') }; });
  ok('a swipe from the side opens the drawer, full height at the side', !!side && side.side && side.left === 0 && side.top === 0 && side.h === 900, side);
  await swipe('.sheet.files-drawer', 300, 40); await p.waitForTimeout(400);
  ok('swiped back, the drawer closes', !(await p.$('.sheet.files-drawer')));
  // the gallery: a picture opens with the folder's videos among its neighbours; a swipe goes to the next; a video shows a Play button
  await p.goto('http://127.0.0.1:5481/#/files?p=%2Fstorage%2Femulated%2F0%2FDownload%2FKurokawa'); await p.waitForSelector('.files-row:has-text("photo.jpg")');
  await p.click('.files-row:has-text("photo.jpg") .files-main'); await p.waitForSelector('.files-viewer', { timeout: 5000 });
  ok('a picture opens in the gallery with the folder\'s video counted', (await p.textContent('.files-viewer')).includes('/ 2'));
  const st = await p.$eval('.files-viewer-stage', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await p.mouse.move(st.x + 120, st.y); await p.mouse.down(); for (let k = 1; k <= 6; k++) await p.mouse.move(st.x + 120 - k * 40, st.y); await p.mouse.up(); await p.waitForTimeout(300);
  const g = await p.evaluate(() => ({ title: document.querySelector('.files-viewer .sheet-head h3')?.textContent, play: !document.querySelector('.files-viewer-play').hidden, wall: [...document.querySelectorAll('.files-viewer .sheet-actions button')].some((b) => !b.hidden && /wallpaper/i.test(b.textContent)) }));
  ok('a swipe goes to the next item; a video there has a Play button and no picture-only actions', g.title === 'Movie.mkv' && g.play && !g.wall, g);
  await p.keyboard.press('Escape');
  ok('no page errors', !errors.length); if (errors.length) console.log(errors);
  await b.close(); server.close(); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
