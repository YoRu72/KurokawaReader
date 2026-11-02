// A torrent's files on its page (Android faked), as a file manager shows them: the folders walked into and out
// of, each file's progress and box; a file cleared and a folder ticked sent to the engine as one choice (once,
// after the taps settle); a search and the Finished / Not finished and kind filters listing matches from every
// folder; All / None / Invert on what is shown; a search typed survives the page's redraws.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port; const lang = process.argv[2] || 'en';
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 412, height: 900 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  const check = (what, ok) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) errors.push(what); };
  await p.addInitScript((lang) => {
    localStorage.setItem('kr.lang', lang); const listeners = {}; window.__calls = [];
    const F = (index, p, size, done, priority = 1) => ({ index, path: `Kaifuku LNs/${p}`, size, done, priority });
    const task = { id: 'b', kind: 'torrent', name: 'Kaifuku LNs', source: { magnet: 'magnet:?xt=urn:btih:' + 'c'.repeat(40) }, dir: '/sdcard/Download', state: 'downloading', done: 3e7, total: 1e8, downSpeed: 2.5e6, upSpeed: 0, peers: 3, seeds: 3, addedAt: Date.now() - 90e3, engine: 'native',
      files: [F(0, 'Vol 1.epub', 14e6, 14e6), F(1, 'Vol 2.epub', 12e6, 6e6), F(2, 'Vol 3.epub', 11e6, 0), F(3, 'Extras/Art 01.jpg', 2e6, 2e6), F(4, 'Extras/Art 02.jpg', 2e6, 0), F(5, 'Extras/OVA/Ova.mkv', 6e7, 0, 0), F(6, 'readme.txt', 1e3, 1e3)] };
    window.__task = task; window.__emit = () => (listeners.tasksChanged || []).forEach((f) => f({ tasks: [task] }));
    const api = {
      addListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); return Promise.resolve({ remove() {} }); },
      list: async () => ({ tasks: [task] }),
      setFiles: async (o) => { window.__calls.push(['setFiles', o.priorities.join('')]); o.priorities.forEach((v, i) => { task.files[i].priority = v; }); window.__emit(); },
      torrentDetail: async () => ({ seeds: 1, peersConnected: 1, seedsInSwarm: 1, peersInSwarm: 1, ratio: 0, limitDown: 0, limitUp: 0, peers: [], trackers: [] }),
    };
    const plugin = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
  }, lang);
  await p.goto(`http://127.0.0.1:${port}/#/task/b`); await p.waitForSelector('.kt-files .kt-file');
  const names = async () => p.$$eval('.kt-files-list .kt-file-name', (e) => e.map((x) => x.textContent));
  console.log('root:', (await names()).join(' | '));
  check('the top folder: its folder first, then its files', (await names()).join() === 'Extras,readme.txt,Vol 1.epub,Vol 2.epub,Vol 3.epub');
  check('the folder half chosen (one file of three left out)', await p.$eval('.kt-folder .kt-file-box', (b) => b.indeterminate));
  console.log('row:', await p.$eval('.kt-files-list .kt-file >> nth=3', (e) => e.innerText.replace(/\s+/g, ' '))); check('progress of each file', /5\.7 MB.*\/.*11 MB.* · 50%/.test(await p.$eval('.kt-files-list .kt-file >> nth=3', (e) => e.innerText.replace(/\s+/g, ' ')).catch(() => '')) || lang !== 'en');
  // Into the folder and back out.
  await p.click('.kt-folder:not(.up)'); await p.waitForTimeout(100);
  console.log('Extras:', (await names()).join(' | ')); check('into a folder: «..», its folder, its files', (await names()).join() === '..,OVA,Art 01.jpg,Art 02.jpg');
  check('the path shown above', (await p.$$('.kt-files-crumbs .chip')).length === 2);
  // Tick the OVA folder and clear Vol 3: one call after the taps settle.
  await p.click('.kt-folder:has-text("OVA") .kt-file-box'); await p.click('.kt-folder.up'); await p.waitForTimeout(80);
  await p.click('.kt-file:has-text("Vol 3.epub") .kt-file-box'); await p.waitForTimeout(900);
  const calls = await p.evaluate(() => window.__calls); console.log('calls:', JSON.stringify(calls));
  check('one choice sent: the OVA now fetched, Vol 3 left out', calls.length === 1 && calls[0][1] === '1101111');
  // Search, filters.
  await p.fill('.kt-files-search', 'art'); await p.waitForTimeout(100);
  check('a search lists matches from every folder', (await names()).join() === 'Art 01.jpg,Art 02.jpg');
  await p.evaluate(() => window.__emit()); await p.waitForTimeout(200);
  check('the search kept across a redraw', (await p.inputValue('.kt-files-search')) === 'art' && (await names()).length === 2);
  await p.fill('.kt-files-search', ''); await p.locator('.kt-files-states .chip >> nth=1').click(); await p.waitForTimeout(100);
  console.log('finished:', (await names()).join(' | ')); check('Finished: the files complete', (await names()).join() === 'Vol 1.epub,Art 01.jpg,readme.txt');
  await p.locator('.kt-files-states .chip >> nth=0').click(); await p.locator('.kt-files-kinds .chip:has(svg) >> nth=0').waitFor();
  const kinds = await p.$$eval('.kt-files-kinds .chip', (e) => e.map((x) => x.textContent)); console.log('kinds:', kinds.join(' | '));
  check('the kinds the torrent holds', kinds.length === 4);
  await p.locator('.kt-files-kinds .chip >> nth=0').click(); await p.waitForTimeout(100);
  console.log('kind:', (await names()).join(' | ')); check('one kind: its files only', (await names()).join() === 'Vol 1.epub,Vol 2.epub,Vol 3.epub');
  await p.locator('.kt-files-bulk .chip >> nth=1').click(); await p.waitForTimeout(900);
  const last = await p.evaluate(() => window.__calls.pop()); console.log('none of the ebooks:', JSON.stringify(last));
  check('None on what is shown: those three left out', last && last[1] === '0001111');
  await p.screenshot({ path: path.join(__dirname, `shot-taskfiles-${lang}.png`), fullPage: true });
  check('no page errors', !errors.length);
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
